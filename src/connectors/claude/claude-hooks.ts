// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeHooks.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { spawnExecutableSync } from "../ported/spawn.js";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { locateBinary } from "../locate.js";
import type { ClaudePermissionDecision } from "./claude-control.js";
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type ClaudePendingRequest,
  type PendingOption,
  type PendingQuestion,
  recordValue,
  sortedJson,
  trimmed,
} from "./claude-shared.js";

/** 定位 `~/.claude` 下的东西与 `claude` 可执行文件。 */
export type ClaudePaths = {
  claudeHome: string;
  /** Claude 桌面 App 的会话记录目录（`claude-code-sessions`），只读。 */
  desktopSessionsDirectories: string[];
  settingsFile: string;
  backupFile: string;
  projectsDirectory: string;
};

export type ClaudePathsOptions = {
  claudeHome?: string;
  desktopSessionsDirectories?: string[];
};

export function defaultClaudeHome(): string {
  // PORT: Swift 只在非 Darwin 上认 CLAUDE_CONFIG_DIR；Windows 上照做。
  const custom = process.env.CLAUDE_CONFIG_DIR;
  if (process.platform !== "darwin" && custom && isAbsolute(custom)) return custom;
  return join(homedir(), ".claude");
}

export function claudePaths(options: ClaudePathsOptions = {}): ClaudePaths {
  const home = options.claudeHome ?? defaultClaudeHome();
  const desktop =
    options.desktopSessionsDirectories ??
    (home === defaultClaudeHome() ? defaultDesktopSessionsDirectories() : []);
  return {
    claudeHome: home,
    desktopSessionsDirectories: desktop,
    settingsFile: join(home, "settings.json"),
    backupFile: join(home, "settings.json.botbus.bak"),
    projectsDirectory: join(home, "projects"),
  };
}

/** 桌面 App 存会话记录的地方。 */
export function defaultDesktopSessionsDirectories(): string[] {
  if (process.platform === "darwin") {
    return [join(homedir(), "Library/Application Support/Claude/claude-code-sessions")];
  }
  if (process.platform === "win32") {
    return desktopDataRoots().map((root) => join(root, "claude-code-sessions"));
  }
  return [];
}

/** 本机装没装 Claude Code。`~/.claude` 存在就算"用过"，可执行文件另判。 */
export function hasClaudeHome(paths: ClaudePaths): boolean {
  try {
    return statSync(paths.claudeHome).isDirectory();
  } catch {
    return false;
  }
}

/** 装法有好几种（官方安装器、npm 全局、Homebrew），挨个看一遍。 */
export const knownBinaries = [
  "~/.local/bin/claude",
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  "/usr/bin/claude",
];

/**
 * 手机那一轮、终端接续与「在终端中打开」用的 `claude`：本机找得到的几份里
 * 版本最高的那份。版本一样时命令行装的优先。
 */
export function detectClaudeBinary(): string | null {
  return newest(installedBinaries(), (binary) => versionOfBinary(binary));
}

/** 本机找得到的 `claude`，命令行装的在前、Claude 桌面 app 自带的在后。 */
export function installedBinaries(): string[] {
  const found: string[] = [];
  if (process.platform === "win32") {
    // 原生安装器的 claude.exe 优先；其次 PATH / npm 全局的 shim。
    const native = join(homedir(), ".local", "bin", "claude.exe");
    if (isExecutableFile(native)) found.push(native);
    const detected = locateBinary("claude");
    if (detected) found.push(detected);
    for (const root of desktopClaudeCodeRoots()) {
      const binary = newestVersionedBinary(root, "claude.exe");
      if (binary) found.push(binary);
    }
    return found;
  }
  const known = knownBinaries
    .map((value) => (value.startsWith("~/") ? join(homedir(), value.slice(2)) : value))
    .find((value) => isExecutableFile(value));
  if (known) found.push(known);
  else {
    const detected = locateBinary("claude");
    if (detected) found.push(detected);
  }
  if (process.platform === "darwin") {
    const desktop = newestVersionedBinary(
      join(homedir(), "Library/Application Support/Claude/claude-code"),
      "claude.app/Contents/MacOS/claude",
    );
    if (desktop) found.push(desktop);
  }
  return found;
}

/**
 * 几份里挑版本最高的；一样高时取排在前面的。读不出版本的排在读得出的后面。
 * 只有一份时不读版本。
 */
export function newest(candidates: string[], version: (binary: string) => number[] | null): string | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  let best: { path: string; version: number[] | null } | null = null;
  for (const candidate of candidates) {
    const found = version(candidate);
    if (best === null) {
      best = { path: candidate, version: found };
      continue;
    }
    if (found === null) continue;
    if (best.version === null || lexicographicallyPrecedes(best.version, found)) {
      best = { path: candidate, version: found };
    }
  }
  return best?.path ?? null;
}

const versionCache = new Map<string, number[] | null>();

/**
 * `claude` 的版本号。先从路径认（软链接解析到底）；认不出再跑一次 `--version`，
 * 按路径、大小与修改时间记住。
 */
export function versionOfBinary(path: string): number[] | null {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // 原路径照样试。
  }
  const inPath = versionInPath(resolved);
  if (inPath) return inPath;
  let stamp = resolved;
  try {
    const stat = statSync(resolved);
    stamp = `${resolved}|${stat.size}|${stat.mtimeMs / 1000}`;
  } catch {
    // 没有属性就用路径当键。
  }
  if (versionCache.has(stamp)) return versionCache.get(stamp) ?? null;
  // PORT: Windows 上解析出来的路径形如 `/C:/…`，跑原路径。
  const version = runVersion(path);
  versionCache.set(stamp, version);
  return version;
}

/** 路径末尾几段里离文件最近的一段 `X.Y.Z`。 */
export function versionInPath(path: string): number[] | null {
  const components = path.split(/[\\/]/).filter((part) => part.length > 0);
  for (const component of components.slice(Math.max(0, components.length - 6)).reverse()) {
    const version = parseVersion(component);
    if (version) return version;
  }
  return null;
}

/** `2.1.286`、`2.1.286 (Claude Code)` → [2, 1, 286]；不是三段数字的不算。 */
export function parseVersion(text: string): number[] | null {
  const token = text.split(" ")[0] ?? "";
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) return null;
  return parts.map((part) => Number(part));
}

function runVersion(binary: string): number[] | null {
  const result = spawnExecutableSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return parseVersion((result.stdout ?? "").trim());
}

/** Windows 桌面 app 把 Claude Code 解到 `%APPDATA%\Claude\claude-code\<版本>\claude.exe`。 */
export function desktopClaudeCodeRoots(): string[] {
  if (process.platform !== "win32") return [];
  return desktopDataRoots().map((root) => join(root, "claude-code"));
}

/** 桌面 app 的数据目录（普通安装在前，Microsoft Store 版在虚拟化目录里）。 */
export function desktopDataRoots(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const packages = join(localAppData, "Packages");
  let entries: string[] = [];
  try {
    entries = readdirSync(packages);
  } catch {
    entries = [];
  }
  const storeRoots = entries
    .filter((name) => name.startsWith("Claude_"))
    .sort()
    .map((name) => join(packages, name, "LocalCache", "Roaming", "Claude"));
  return [join(appData, "Claude"), ...storeRoots];
}

/**
 * `root` 下按版本号命名的子目录里，挑版本最高、带 `executable` 的那个。
 * 版本目录里可以直接是 `executable`，也可以再隔一层哈希目录。
 */
export function newestVersionedBinary(
  root: string,
  executable: string,
  fileManager: { isExecutableFile?: (path: string) => boolean } = {},
): string | null {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const check = fileManager.isExecutableFile ?? isExecutableFile;
  const versions = names
    .map((name) => {
      const parts = name.split(".");
      if (parts.length === 0 || !parts.every((part) => /^\d+$/.test(part))) return null;
      return { name, parts: parts.map((part) => Number(part)) };
    })
    .filter((value): value is { name: string; parts: number[] } => value !== null)
    .sort((left, right) => compareVersionsDescending(left.parts, right.parts));
  for (const version of versions) {
    const directory = join(root, version.name);
    const direct = join(directory, executable);
    if (check(direct)) return direct;
    let children: string[] = [];
    try {
      children = readdirSync(directory);
    } catch {
      children = [];
    }
    const hashed = children
      .map((child) => join(directory, child, executable))
      .filter((candidate) => check(candidate));
    if (hashed.length > 0) {
      hashed.sort((left, right) => modificationTime(left) - modificationTime(right));
      return hashed[hashed.length - 1];
    }
  }
  return null;
}

function modificationTime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/** 可执行判定：存在、是普通文件、X_OK。 */
export function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lexicographicallyPrecedes(lhs: number[], rhs: number[]): boolean {
  const length = Math.min(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    if (lhs[index] !== rhs[index]) return lhs[index] < rhs[index];
  }
  return lhs.length < rhs.length;
}

function compareVersionsDescending(lhs: number[], rhs: number[]): number {
  if (lexicographicallyPrecedes(lhs, rhs)) return 1;
  if (lexicographicallyPrecedes(rhs, lhs)) return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Hook 负载
// ---------------------------------------------------------------------------

export type ClaudeHookKind =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "Notification"
  | "Stop"
  | "StopFailure"
  | "SessionEnd";

export const claudeHookKinds: ClaudeHookKind[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

/**
 * hook 脚本 POST 过来的一条负载。字段名随 Claude Code 版本变过，所以每个字段
 * 都给一串候选键，全都取不到就留空。
 */
export type ClaudeHookEvent = {
  kind: ClaudeHookKind;
  sessionID: string;
  cwd: string;
  transcriptPath?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: string;
  toolUseID?: string;
  notificationType?: string;
  message?: string;
  lastAssistantMessage?: string;
  error?: string;
  errorDetails?: string;
  askedQuestions?: ClaudeAskedQuestions;
};

/** 解析 hook 负载；不是本连接器认识的事件返回 null。 */
export function parseClaudeHookEvent(
  json: Buffer | string | Record<string, unknown>,
): ClaudeHookEvent | null {
  if (json !== null && typeof json === "object" && !Buffer.isBuffer(json)) {
    return claudeHookEventFromObject(json);
  }
  let object: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(typeof json === "string" ? json : json.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    object = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return claudeHookEventFromObject(object);
}

export function claudeHookEventFromObject(object: Record<string, unknown>): ClaudeHookEvent | null {
  const raw = stringField(object, "hook_event_name", "hookEventName");
  if (!raw || !(claudeHookKinds as string[]).includes(raw)) return null;
  const kind = raw as ClaudeHookKind;
  const toolName = stringField(object, "tool_name", "toolName");
  const toolInputValue = object.tool_input ?? object.toolInput;
  const event: ClaudeHookEvent = {
    kind,
    sessionID: stringField(object, "session_id", "sessionId") ?? "",
    cwd: stringField(object, "cwd", "workspace_dir") ?? "",
    transcriptPath: stringField(object, "transcript_path", "transcriptPath"),
    prompt: stringField(object, "prompt", "user_prompt", "userPrompt"),
    toolName,
    toolUseID: stringField(object, "tool_use_id", "toolUseId"),
    notificationType: stringField(object, "notification_type", "notificationType"),
    message: stringField(object, "message"),
    lastAssistantMessage: stringField(object, "last_assistant_message", "lastAssistantMessage"),
    error: stringField(object, "error"),
    errorDetails: stringField(object, "error_details", "errorDetails"),
    toolInput: summarizeToolInput(toolInputValue),
  };
  if (kind === "PermissionRequest") {
    event.askedQuestions = ClaudeAskedQuestions.from(toolName, toolInputValue) ?? undefined;
  }
  return event;
}

/** 命令路径上用来复用 `apply` 的假事件：只带 id 与目录，其余字段留空。 */
export function syntheticHookEvent(kind: ClaudeHookKind, sessionID: string, cwd: string): ClaudeHookEvent {
  return {
    kind,
    sessionID,
    cwd,
  };
}

/** 第一个取到非空字符串的键胜出。 */
function stringField(object: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** `tool_input` 是任意结构，只用来给人看。 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input === "string") return input.length > 0 ? input : undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const dictionary = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url"]) {
    const value = dictionary[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  try {
    return sortedJson(dictionary);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

/**
 * `AskUserQuestion` 的提问：Claude 要用户在几个选项里挑，而不是批准一个工具。
 *
 * 回答 = `allow` + `updatedInput`（原入参整份带回再加 `answers`）。
 */
export class ClaudeAskedQuestions {
  static readonly toolName = "AskUserQuestion";
  static readonly textLimit = 2000;

  /** 原样的 `tool_input`（排序后的 JSON 文本）。 */
  readonly rawInput: string;
  /** 给手机的版本，`id` 是问题的下标。 */
  readonly questions: PendingQuestion[];
  /** 与 `questions` 同序的问题原文——`answers` 的键。 */
  readonly texts: string[];

  private constructor(rawInput: string, questions: PendingQuestion[], texts: string[]) {
    this.rawInput = rawInput;
    this.questions = questions;
    this.texts = texts;
  }

  static from(toolName: string | null | undefined, input: unknown): ClaudeAskedQuestions | null {
    if (toolName !== ClaudeAskedQuestions.toolName) return null;
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const dictionary = input as Record<string, unknown>;
    const items = dictionary.questions;
    if (!Array.isArray(items)) return null;
    const questions: PendingQuestion[] = [];
    const texts: string[] = [];
    for (const item of items.slice(0, MAX_QUESTIONS)) {
      const entry = recordValue(item);
      const text = typeof entry.question === "string" ? entry.question : "";
      if (trimmed(text).length === 0) continue;
      const rawOptions = Array.isArray(entry.options) ? entry.options : [];
      const options: PendingOption[] = [];
      for (const rawOption of rawOptions.slice(0, MAX_OPTIONS)) {
        const option = recordValue(rawOption);
        const label = typeof option.label === "string" ? option.label : "";
        if (label.length === 0) continue;
        const description = typeof option.description === "string" ? trimmed(option.description) : "";
        options.push(description.length > 0 ? { label, description } : { label });
      }
      const header = typeof entry.header === "string" ? trimmed(entry.header) : "";
      const question: PendingQuestion = {
        id: String(questions.length),
        question: text.slice(0, ClaudeAskedQuestions.textLimit),
        options,
      };
      if (header.length > 0) question.header = header;
      if (entry.multiSelect === true) question.multiSelect = true;
      questions.push(question);
      texts.push(text);
    }
    if (questions.length === 0) return null;
    return new ClaudeAskedQuestions(safeJson(dictionary), questions, texts);
  }

  /** 一行摘要：第一个问题的短标签，没有就用问题本身。 */
  get summary(): string {
    const first = this.questions[0];
    const source = first.header ?? first.question;
    const line = source.split(/\r?\n/)[0] ?? "";
    if (line.length === 0) return "Claude 在提问";
    return line.slice(0, 120);
  }

  /** 写好选项的纯文字，给不认 `questions` 的旧手机和手表看。 */
  get plainText(): string {
    const blocks = this.questions.map((question) => {
      const lines = [question.question + (question.multiSelect === true ? "（可多选）" : "")];
      question.options.forEach((option, index) => {
        lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
      });
      return lines.join("\n");
    });
    return blocks.join("\n\n").slice(0, ClaudeAskedQuestions.textLimit);
  }

  /** 手机的回答 → Claude 的 `answers`（问题原文 → 答案）。认不出的 id 和空答案丢掉。 */
  claudeAnswers(answers: Record<string, string[]>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [id, values] of Object.entries(answers)) {
      if (!/^-?\d+$/.test(id)) continue;
      const index = Number.parseInt(id, 10);
      if (!Number.isInteger(index) || index < 0 || index >= this.texts.length) continue;
      const picked = values.map((value) => value.trim()).filter((value) => value.length > 0);
      if (picked.length === 0) continue;
      result[this.texts[index]] = picked.join(", ");
    }
    return result;
  }

  /** 回答后的整份入参：原入参加 `answers`（`updatedInput` 整份替换入参）。 */
  answeredInput(answers: Record<string, string>): string {
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(this.rawInput);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      return this.rawInput;
    }
    input.answers = answers;
    return safeJson(input);
  }

  /** 同一句话回答所有问题：用户没点选项、直接打了字。 */
  claudeAnswersFromText(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const question of this.texts) {
      if (!(question in result)) result[question] = text;
    }
    return result;
  }
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return sortedJson(value);
  } catch {
    return "{}";
  }
}

// ---------------------------------------------------------------------------
// Hook 输出
// ---------------------------------------------------------------------------

/**
 * 回给 hook 脚本的 JSON。`PermissionRequest` 的 `decision` 是带 `behavior`
 * 判别式的对象，不是字符串。
 */
export const ClaudeHookOutput = {
  permission(allow: boolean, reason: string): Buffer {
    return ClaudeHookOutput.permissionDecision(allow ? { kind: "allow" } : { kind: "deny", message: reason });
  },

  permissionDecision(decision: ClaudePermissionDecision): Buffer {
    let body: Record<string, unknown>;
    if (decision.kind === "allow") {
      body =
        decision.updatedInput === undefined
          ? { behavior: "allow" }
          : { behavior: "allow", updatedInput: parseObjectOrEmpty(decision.updatedInput) };
    } else {
      body = { behavior: "deny", message: decision.message };
    }
    return Buffer.from(
      `${sortedJson({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: body,
        },
      })}\n`,
      "utf8",
    );
  },

  /** 替用户回答 `AskUserQuestion`：`allow`，`updatedInput` = 原入参 + `answers`。 */
  answer(asked: ClaudeAskedQuestions, answers: Record<string, string>): Buffer {
    return ClaudeHookOutput.permissionDecision({ kind: "allow", updatedInput: asked.answeredInput(answers) });
  },
};

function parseObjectOrEmpty(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 供连接器 `record()` 使用（`BusPendingRequest` 不含 questions，运行时保留完整形状）。 */
export type { ClaudePendingRequest };
