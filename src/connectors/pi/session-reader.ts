/**
 * Ported from botbus-protocol/Sources/BotBusConnectors/Pi/PiSessionReader.swift
 * and botbus-protocol/Sources/BotBusConnectorKit/AgentPaths.swift (PiPaths).
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 只读地把 Pi 的会话 JSONL（`~/.pi/agent/sessions/*\/*.jsonl`）映射成协议模型。
 *
 * 文件格式（上游 spec 2026-09-24 的 Pi 一节）：
 * - 首行 header：`{"type":"session","version":3,"id":<uuid>,"timestamp":<ISO>,"cwd":"/abs"}`；
 * - 其余每行一条 entry，带 `id` / `parentId`，整份文件是一棵**树**（`/tree` 回到旧节点再说话就分叉）。
 *   当前分支 = 最后一条沿 `parentId` 往回走；被丢下的那条分支不算这个会话的现状。
 *
 * 解析**全程容错**：坏行、没见过的 entry 类型、字段缺失都只是跳过。首行不是 header
 * 的文件整份跳过：拿不到 cwd，这个任务挂不到任何项目下。
 */
import { accessSync, constants, realpathSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { BusProject, BusTask } from "../../bus/store.js";

export const PI_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PI_IDLE_AFTER_MS = 24 * 60 * 60 * 1000;
export const PI_RUNNING_WINDOW_MS = 120 * 1000;
export const PI_MAX_TASKS = 200;
export const PI_TITLE_LIMIT = 80;
export const PI_LAST_MESSAGE_LIMIT = 500;

/** Pi 的本机目录。默认 `~/.pi/agent`。 */
export type PiPaths = {
  agentDirectory: string;
};

/**
 * 默认 agent 目录。上游只认 `~/.pi/agent`；这里允许 `AGENT_HOST_PI_HOME` 覆盖，
 * 只给测试和隔离环境用，免得把真实的 ~/.pi 当成测试目录。
 */
export function defaultPiAgentDirectory(): string {
  return join(homedir(), ".pi", "agent");
}

export function piPaths(
  agentDirectory = process.env.AGENT_HOST_PI_HOME?.trim() || defaultPiAgentDirectory(),
): PiPaths {
  return { agentDirectory };
}

export function piSessionsDirectory(paths: PiPaths): string {
  return join(paths.agentDirectory, "sessions");
}

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ""];

/**
 * 找一个 `pi` 可执行文件。对应上游 `PiPaths.detectPiBinary` / `AgentBinary.detect`：
 * 先看常见全局安装目录，最后再看 PATH。GUI 进程拿不到用户 shell 的 PATH，所以
 * 常见目录必须显式列出来。
 */
export function detectPiBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const home = homedir();
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const commonDirectories =
    platform === "win32"
      ? [
          join(home, ".local", "bin"),
          join(appData, "npm"),
          join(localAppData, "Microsoft", "WinGet", "Links"),
          join(home, "scoop", "shims"),
          join(home, ".bun", "bin"),
          join(localAppData, "Volta", "bin"),
          join(localAppData, "pnpm"),
          join(programFiles, "nodejs"),
        ]
      : [
          join(home, ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          join(home, ".npm-global", "bin"),
          join(home, ".bun", "bin"),
          join(home, ".volta", "bin"),
          join(home, "Library", "pnpm"),
          "/usr/bin",
        ];

  const pathValue =
    platform === "win32"
      ? (Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "")
      : (env.PATH ?? "");
  const directories = [...commonDirectories, ...pathValue.split(delimiter).filter(Boolean)];
  const extensions = platform === "win32" ? WINDOWS_EXTENSIONS : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `pi${extension}`);
      try {
        accessSync(candidate, constants.F_OK);
        return candidate;
      } catch {
        // 继续找下一个候选。
      }
    }
  }
  return undefined;
}

/**
 * entry 的 `timestamp` 是 ISO 字符串，消息里的 `timestamp` 是毫秒数；两种都认。
 * 大于 1e11 的数按毫秒（秒级要到 5138 年才有这么大）。
 */
export function piTimestamp(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? value : value * 1000;
  }
  return undefined;
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** 标题与工具摘要必须单行：换行与连续空白压成一个空格。 */
export function singleLine(text: string): string {
  return text
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
}

/** 与上游 `SessionFormatting.truncate` 一致：先 trim，超长只截断、不补省略号。 */
export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

/** 与上游 `SessionFormatting.projectName` 一致，兼容 `/` 与 `\`。 */
export function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

export type PiMessageRole = "user" | "assistant" | "toolResult" | "bashExecution" | "other";

export type PiImageBlock = {
  data: string;
  mimeType: string;
};

/** `AgentMessage`：只留对话记录与状态推断用得上的部分。 */
export type PiMessage = {
  role: PiMessageRole;
  /** 文本块拼起来（thinking 不算）。 */
  text: string;
  /** assistant 的工具调用，已压成一行摘要（`bash: ls` / `edit src/a.ts`）。 */
  toolCalls: string[];
  stopReason?: string;
  /** 消息自带的时间（毫秒），比 entry 的 ISO 时间更贴近生成时刻；两者都可能缺。 */
  timestamp?: number;
  /** `bashExecution` 的命令。 */
  command?: string;
  /** user 消息里的图片块，base64 原样留着；只有读对话记录时才解。 */
  imageBlocks: PiImageBlock[];
};

/** 一次工具调用的一行摘要。认不出参数就只给工具名。 */
export function toolSummary(name: string, argumentsValue: unknown): string {
  let object: Record<string, unknown> | undefined = isRecord(argumentsValue)
    ? argumentsValue
    : undefined;
  // 有的 provider 把 arguments 存成 JSON 字符串。
  if (!object && typeof argumentsValue === "string") {
    const parsed = parseJson(argumentsValue);
    if (isRecord(parsed)) object = parsed;
  }
  if (!object) return name;
  const command = object.command;
  if (typeof command === "string" && command) {
    return `${name}: ${singleLine(command)}`;
  }
  for (const key of ["path", "file_path", "filePath", "pattern", "query", "url"]) {
    const value = object[key];
    if (typeof value === "string" && value) {
      return `${name} ${singleLine(value)}`;
    }
  }
  return name;
}

export function parsePiMessage(value: unknown): PiMessage | null {
  const object = isRecord(value) ? value : undefined;
  if (!object || typeof object.role !== "string") return null;
  const role = roleOf(object.role);
  const stopReason = typeof object.stopReason === "string" ? object.stopReason : undefined;
  const timestamp = piTimestamp(object.timestamp);
  const command = typeof object.command === "string" ? object.command : undefined;

  const texts: string[] = [];
  const tools: string[] = [];
  const images: PiImageBlock[] = [];
  if (typeof object.content === "string") {
    texts.push(object.content);
  } else if (Array.isArray(object.content)) {
    for (const rawBlock of object.content) {
      const block = isRecord(rawBlock) ? rawBlock : undefined;
      if (!block) continue;
      switch (block.type) {
        case "text":
          if (typeof block.text === "string") texts.push(block.text);
          break;
        case "toolCall":
          if (typeof block.name === "string" && block.name) {
            tools.push(toolSummary(block.name, block.arguments));
          }
          break;
        case "image":
          if (typeof block.data === "string" && typeof block.mimeType === "string") {
            images.push({ data: block.data, mimeType: block.mimeType });
          }
          break;
        default:
          // thinking 等一律不进正文。
          break;
      }
    }
  }

  return {
    role,
    text: texts.join("\n"),
    // toolResult 的正文往往是整个文件或一屏日志，工具调用也只有 assistant 会发。
    toolCalls: role === "assistant" ? tools : [],
    stopReason,
    timestamp,
    command,
    // 只收用户发的图：assistant 与 toolResult 里的图是工具截图，不进对话。
    imageBlocks: role === "user" ? images : [],
  };
}

function roleOf(raw: string): PiMessageRole {
  switch (raw) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "toolResult";
    case "bashExecution":
      return "bashExecution";
    default:
      return "other";
  }
}

export type PiSessionHeader = {
  id: string;
  cwd: string;
  timestamp?: number;
};

export type PiEntryKind =
  | { type: "message"; message: PiMessage }
  /** 会话标题（`/name` 命令写的）。 */
  | { type: "sessionInfo"; name?: string }
  /** `model_change`、`compaction`、`branch_summary`、`label` 等：只占树上的一个节点。 */
  | { type: "other" };

export type PiSessionEntry = {
  id?: string;
  parentId?: string;
  timestamp?: number;
  kind: PiEntryKind;
};

export type PiTail = "completed" | "failed" | "aborted" | "open" | "empty";

/** 观察者要的一份会话摘要：状态推断所需的全部，与"现在几点"无关，所以可以按文件缓存。 */
export type PiSessionSummary = {
  sessionID: string;
  cwd: string;
  /** `session_info.name` 或首条 user 文本；都没有时为 undefined，由调用方用项目名兜底。 */
  title?: string;
  lastAssistantText?: string;
  tail: PiTail;
  startedAt?: number;
  lastActivity?: number;
};

/** 解析后的一份会话文件：header + 全部 entry（文件顺序）。 */
export class PiSessionFile {
  constructor(
    readonly header: PiSessionHeader,
    readonly entries: PiSessionEntry[],
  ) {}

  /** 首行不是 `type:"session"` 的 header 返回 null；其余坏行跳过。 */
  static parse(data: string | Buffer): PiSessionFile | null {
    const lines = (typeof data === "string" ? data : data.toString("utf8")).split("\n");
    const first = lines.shift();
    const header = first === undefined ? null : parseHeader(first);
    if (!header) return null;
    const entries: PiSessionEntry[] = [];
    for (const line of lines) {
      if (!line) continue;
      const object = parseJsonObject(line);
      if (!object) continue;
      entries.push(parseEntry(object));
    }
    return new PiSessionFile(header, entries);
  }

  /** 只读首行拿 header（续聊要 cwd，不必把几 MB 的会话整份读进来）。 */
  static async headerAtPath(path: string): Promise<PiSessionHeader | null> {
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return null;
    }
    try {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let total = 0;
      // header 就一行几百字节；读到换行或 64 KB 为止。
      while (total < 1 << 16) {
        const chunk = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(chunk, 0, 4096, total);
        if (!bytesRead) break;
        buffer += decoder.write(chunk.subarray(0, bytesRead));
        total += bytesRead;
        const newline = buffer.indexOf("\n");
        if (newline >= 0) return parseHeader(buffer.slice(0, newline));
      }
      buffer += decoder.end();
      return parseHeader(buffer);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * 当前分支，从根到叶。叶 = 文件里最后一条带 id 的 entry，沿 `parentId` 往回走；
   * 断链（父节点不在文件里）就停在那儿，成环（坏文件）靠 visited 挡住。
   * 一条带 id 的都没有（更早的线性格式）时按文件顺序整份当成一条分支。
   */
  get branch(): PiSessionEntry[] {
    let leaf: PiSessionEntry | undefined;
    for (const entry of this.entries) {
      if (entry.id !== undefined) leaf = entry;
    }
    if (!leaf || leaf.id === undefined) return this.entries;
    const byID = new Map<string, PiSessionEntry>();
    for (const entry of this.entries) {
      if (entry.id !== undefined) byID.set(entry.id, entry);
    }
    const path: PiSessionEntry[] = [leaf];
    const visited = new Set<string>([leaf.id]);
    let cursor = leaf.parentId;
    while (cursor !== undefined && !visited.has(cursor)) {
      const parent = byID.get(cursor);
      if (!parent) break;
      visited.add(cursor);
      path.push(parent);
      cursor = parent.parentId;
    }
    return path.reverse();
  }

  summary(): PiSessionSummary {
    const branch = this.branch;
    const messages: PiMessage[] = [];
    for (const entry of branch) {
      if (entry.kind.type === "message") messages.push(entry.kind.message);
    }

    // 标题：会话名（整份文件里最后一次命名）> 分支上首条 user 文本 > undefined（调用方用项目名）。
    let named: string | undefined;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const kind = this.entries[index].kind;
      if (kind.type !== "sessionInfo" || kind.name === undefined) continue;
      const line = singleLine(kind.name);
      if (line) {
        named = line;
        break;
      }
    }
    let firstUser: string | undefined;
    for (const message of messages) {
      if (message.role !== "user") continue;
      const line = singleLine(message.text);
      if (line) {
        firstUser = line;
        break;
      }
    }
    const title = named ?? firstUser;

    let lastAssistant: string | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (message.text.trim()) {
        lastAssistant = message.text;
        break;
      }
    }

    // 状态只看"对话"那几种角色；bashExecution 是用户在 pi 里敲的 `!命令`，不代表 agent 在跑。
    let lastConversation: PiMessage | undefined;
    for (const message of messages) {
      if (message.role !== "bashExecution" && message.role !== "other") {
        lastConversation = message;
      }
    }
    let tail: PiTail;
    if (!lastConversation) {
      tail = "empty";
    } else if (lastConversation.role === "assistant") {
      switch (lastConversation.stopReason) {
        case "stop":
        case "length":
          tail = "completed";
          break;
        case "error":
          tail = "failed";
          break;
        case "aborted":
          tail = "aborted";
          break;
        default:
          tail = "open";
          break;
      }
    } else {
      tail = "open";
    }

    let lastActivity: number | undefined;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      const value =
        entry.timestamp ?? (entry.kind.type === "message" ? entry.kind.message.timestamp : undefined);
      if (value !== undefined) {
        lastActivity = value;
        break;
      }
    }

    let startedAt = this.header.timestamp;
    if (startedAt === undefined) {
      for (const entry of this.entries) {
        if (entry.timestamp !== undefined) {
          startedAt = entry.timestamp;
          break;
        }
      }
    }

    return {
      sessionID: this.header.id,
      cwd: this.header.cwd,
      title: title === undefined ? undefined : truncate(title, PI_TITLE_LIMIT),
      lastAssistantText:
        lastAssistant === undefined ? undefined : truncate(lastAssistant, PI_LAST_MESSAGE_LIMIT),
      tail,
      startedAt,
      lastActivity,
    };
  }
}

function parseHeader(line: string | Buffer): PiSessionHeader | null {
  const object = parseJsonObject(line);
  if (!object || object.type !== "session") return null;
  const id = object.id;
  const cwd = object.cwd;
  if (typeof id !== "string" || !id) return null;
  if (typeof cwd !== "string" || !cwd) return null;
  return { id, cwd, timestamp: piTimestamp(object.timestamp) };
}

function parseEntry(object: Record<string, unknown>): PiSessionEntry {
  let kind: PiEntryKind;
  switch (object.type) {
    case "message": {
      const message = parsePiMessage(object.message);
      kind = message ? { type: "message", message } : { type: "other" };
      break;
    }
    case "session_info":
      kind = {
        type: "sessionInfo",
        name: typeof object.name === "string" ? object.name : undefined,
      };
      break;
    default:
      kind = { type: "other" };
      break;
  }
  return {
    id: typeof object.id === "string" ? object.id : undefined,
    parentId: typeof object.parentId === "string" ? object.parentId : undefined,
    timestamp: piTimestamp(object.timestamp),
    kind,
  };
}

function parseJsonObject(value: string | Buffer): Record<string, unknown> | null {
  const parsed = parseJson(typeof value === "string" ? value : value.toString("utf8"));
  return isRecord(parsed) ? parsed : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 一个会话文件在磁盘上的样子。`size` 与 `modifiedAt` 一起当缓存键。 */
export type PiFileInfo = {
  url: string;
  modifiedAt: number;
  size: number;
};

/** 这一轮读不到数据（不是"数据为空"）。message 直接进菜单栏。 */
export class SessionSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSourceUnavailable";
  }
}

export type PiSessionReaderOptions = {
  paths?: PiPaths;
  now?: () => number;
};

export type PiSummarize = (file: PiFileInfo) => Promise<PiSessionSummary | null> | PiSessionSummary | null;

export class PiSessionReader {
  readonly paths: PiPaths;
  private readonly now: () => number;

  constructor(options: PiSessionReaderOptions = {}) {
    this.paths = options.paths ?? piPaths();
    this.now = options.now ?? Date.now;
  }

  /**
   * 7 天内被写过的会话文件，最新的在前，最多 `maxTasks` 个。
   * 会话目录不存在抛 `SessionSourceUnavailable`——那是"读不到"，不是"没有任务"。
   */
  async recentFiles(): Promise<PiFileInfo[]> {
    const root = piSessionsDirectory(this.paths);
    let rootInfo;
    try {
      rootInfo = await stat(root);
    } catch {
      throw new SessionSourceUnavailable(`未找到 Pi 会话目录：${root}`);
    }
    if (!rootInfo.isDirectory()) {
      throw new SessionSourceUnavailable(`未找到 Pi 会话目录：${root}`);
    }
    const since = this.now() - PI_RECENT_WINDOW_MS;
    // 目录名是 cwd 编码出来的（`--Users-me-proj--`），反解不回路径，这里只当成一层分组来扫。
    const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
    const files: PiFileInfo[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const directoryPath = join(root, directory.name);
      const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.name.endsWith(".jsonl")) continue;
        const url = join(directoryPath, entry.name);
        let info;
        try {
          info = await stat(url);
        } catch {
          continue;
        }
        if (!info.isFile() || info.mtimeMs < since) continue;
        files.push({ url, modifiedAt: info.mtimeMs, size: info.size });
      }
    }
    files.sort((left, right) => right.modifiedAt - left.modifiedAt);
    return files.slice(0, PI_MAX_TASKS);
  }

  /**
   * 某个 sessionId 的记录文件。文件名是 `<时间戳>_<sessionId>.jsonl`，按后缀在各项目目录里扫；
   * 连接器续聊（`--session <路径>`）与读对话记录都靠它，不依赖 7 天窗口。
   */
  async sessionFile(sessionID: string): Promise<string | null> {
    return PiSessionReader.sessionFileIn(sessionID, piSessionsDirectory(this.paths));
  }

  static async sessionFileIn(sessionID: string, sessionsDirectory: string): Promise<string | null> {
    // 挡住拼路径的花样：sessionId 是 uuid，不该带分隔符（Windows 上 `\` 也是分隔符）。
    if (!sessionID || sessionID.includes("/") || sessionID.includes("\\")) return null;
    const directories = await readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
    const suffix = `_${sessionID}.jsonl`;
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const directoryPath = join(sessionsDirectory, directory.name);
      const names = await readdir(directoryPath).catch(() => []);
      const name = names.find((candidate) => candidate.endsWith(suffix));
      if (name) return join(directoryPath, name);
    }
    return null;
  }

  /** 7 天内的会话 → BusTask。`summarize` 可注入缓存；默认每次整份重读。 */
  async readTasks(
    agentId: string,
    summarize: PiSummarize = (file) => PiSessionReader.summarize(file.url),
  ): Promise<BusTask[]> {
    const files = await this.recentFiles();
    const tasks: BusTask[] = [];
    for (const file of files) {
      const summary = await summarize(file);
      if (summary) tasks.push(this.record(summary, file.modifiedAt, agentId));
    }
    return tasks;
  }

  static async summarize(contentsOf: string): Promise<PiSessionSummary | null> {
    let data: Buffer;
    try {
      data = await readFile(contentsOf);
    } catch {
      return null;
    }
    return PiSessionFile.parse(data)?.summary() ?? null;
  }

  record(summary: PiSessionSummary, modifiedAt: number, agentId: string): BusTask {
    const current = this.now();
    const updated = summary.lastActivity ?? modifiedAt;
    const status = PiSessionReader.status(summary.tail, updated, modifiedAt, current);
    const name = projectName(summary.cwd);
    const title = summary.title ?? (name || "Pi 会话");
    return {
      id: `pi:${summary.sessionID}`,
      agentId,
      source: "pi",
      title,
      projectPath: summary.cwd,
      projectName: name,
      status,
      ...(summary.lastAssistantText ? { lastMessage: summary.lastAssistantText } : {}),
      origin: "desktop",
      // 非 running 的都能 `--session` 续上；running 的桌面会话我们没有它的进程，续了会和它抢同一个文件。
      controllable: status !== "running",
      startedAt: isoFromMs(summary.startedAt ?? updated),
      updatedAt: isoFromMs(updated),
    };
  }

  /**
   * 状态推断：24 小时无活动 → idle；否则看当前分支最后一条消息，停在"还在等模型"
   * 的位置时靠文件的修改时间区分 running / interrupted。
   */
  static status(tail: PiTail, updatedAt: number, modifiedAt: number, now: number): string {
    if (now - updatedAt > PI_IDLE_AFTER_MS) return "idle";
    switch (tail) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "aborted":
        return "interrupted";
      case "empty":
        return "idle";
      case "open":
        return now - modifiedAt <= PI_RUNNING_WINDOW_MS ? "running" : "interrupted";
    }
  }
}

type CachedSummary = {
  modifiedAt: number;
  size: number;
  summary: PiSessionSummary | null;
};

export type PiSessionSourceOptions = {
  paths?: PiPaths;
  now?: () => number;
  reader?: PiSessionReader;
};

/**
 * 给 `SessionObserver` 的 Pi 数据源。按 (路径, 修改时间, 大小) 缓存每份文件的摘要：
 * 观察者每 3 秒一轮，200 份会话里通常只有一两份在变，没必要每轮把几十 MB 的 JSONL 全部重读。
 * 状态里与"现在几点"有关的那部分（running 窗口、idle）不进缓存，每轮现算。
 */
export class PiSessionSource {
  private readonly reader: PiSessionReader;
  private cache = new Map<string, CachedSummary>();
  /** 上游握着锁整轮跑；这里用串行链保证并发调用不会互相覆盖缓存。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PiSessionSourceOptions = {}) {
    this.reader = options.reader ?? new PiSessionReader(options);
  }

  readSnapshot(agentId: string): Promise<{ tasks: BusTask[]; projects: BusProject[] }> {
    const next = this.queue.then(() => this.perform(agentId));
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async perform(agentId: string): Promise<{ tasks: BusTask[]; projects: BusProject[] }> {
    const seen = new Map<string, CachedSummary>();
    const tasks = await this.reader.readTasks(agentId, async (file) => {
      const hit = this.cache.get(file.url);
      if (hit && hit.modifiedAt === file.modifiedAt && hit.size === file.size) {
        seen.set(file.url, hit);
        return hit.summary;
      }
      const summary = await PiSessionReader.summarize(file.url);
      seen.set(file.url, { modifiedAt: file.modifiedAt, size: file.size, summary });
      return summary;
    });
    // 只留这一轮还在窗口里的文件，缓存不会无限长。
    this.cache = seen;
    return { tasks, projects: projectsFromTasks(tasks, agentId) };
  }
}

/** 按每条会话的最近活动时间聚合出项目列表，最近的在前。 */
export function projectsFromTasks(tasks: BusTask[], agentId: string): BusProject[] {
  const latest = new Map<string, string>();
  for (const task of tasks) {
    if (!task.projectPath) continue;
    const existing = latest.get(task.projectPath);
    if (existing !== undefined && existing >= task.updatedAt) continue;
    latest.set(task.projectPath, task.updatedAt);
  }
  return [...latest.entries()]
    .sort((left, right) => right[1].localeCompare(left[1]))
    .map(([path, lastUsedAt]) => ({
      agentId,
      path,
      name: projectName(path),
      lastUsedAt,
      pinned: false,
    }));
}
