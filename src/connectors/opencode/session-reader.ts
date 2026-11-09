// Ported from botbus-protocol/Sources/BotBusConnectors/OpenCode/OpenCodeSessionReader.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// OpenCode 是 **ACP 驱动**的 agent（`kind = acp` + `connectorId = opencode`），
// 这里只做只读的那一半：
// - `entries` / `readEntries`：从 `~/.local/share/opencode/opencode.db` 读对话记录；
// - `scan` / `tasks`：给 ACP 对账用的会话快照。
// 启动、续聊、审批、中断等控制命令一律走 ACP 主干，本文件不实现。
//
// 与上游的差别（都已按移植规则尽量缩小）：
// - `MessageReader` 接口没有 host，`agentId` 改由 `options.agentId` 注入，缺省是空串；
//   调用方（ACP 对账）需要自行把它换成真实 agent id。
// - 上游 `ImageSource(dataURL:)` 除 base64 data URL 外还认文件 URL；这里只认
//   `contract.ts` 的 `imageFromDataUrl`（image/* + base64），其余当作没有图。
// - 上游 `AgentBinary.detect` 在非 Windows 上只查固定目录；这里与 Hermes 移植保持一致，
//   最后再查一遍 PATH，Windows 上还带 `.exe` / `.cmd` / `.bat` / `.ps1` 后缀。
//
// 数据库路径：默认 `homedir()/.local/share/opencode/opencode.db`（照上游），
// `XDG_DATA_HOME` 存在时用 `$XDG_DATA_HOME/opencode/opencode.db`；
// `options.databasePath` 或环境变量 `AGENT_HOST_OPENCODE_DB` 可覆盖（测试用）。

import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { BusTask } from "../../bus/store.js";
import { SESSION_HISTORY_WINDOW_MS } from "../session-window.js";
import {
  ConnectorError,
  MAX_USER_MESSAGES,
  imageFromDataUrl,
  latestWindow,
  transcriptEntry,
  type ConnectorKind,
  type ImageSource,
  type MessageReader,
  type TranscriptEntry,
} from "../ported/contract.js";

/** 会话回溯窗口；一年，最多仍只读 `MAX_SESSIONS` 条 */
export const RECENT_WINDOW_MS = SESSION_HISTORY_WINDOW_MS;
/** 与 Kit `SessionObserver` 一致：超过 24 小时没动静算 `idle`。 */
export const IDLE_AFTER_MS = 24 * 3600 * 1000;
/** 与 Kit `SessionFormatting.lastMessageLimit` 一致。 */
export const LAST_MESSAGE_LIMIT = 500;
/** 与 Kit `SessionFormatting.titleLimit` 一致。 */
export const TITLE_LIMIT = 80;
/** 未收尾的 assistant 消息在这么久内更新过，才算"正在跑"。 */
export const RUNNING_WINDOW_MS = 300 * 1000;
/** 一次快照最多列多少条会话。 */
export const MAX_SESSIONS = 200;
/** 倒序翻页时每次从 `message` 取多少行。 */
const PAGE_SIZE = 100;
/** ACP connectorId 的形状（上游 `ConnectorRef.isValidAcpId`）。 */
const ACP_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
export const OPENCODE_CONNECTOR_ID = "opencode";

type SqliteRow = Record<string, unknown>;

export type OpenCodeScan = {
  tasks: BusTask[];
  /** 读满 `MAX_SESSIONS` 条时是最旧那条的时间；没读满是 undefined。 */
  coverageStart?: string;
};

export type OpenCodeSessionReaderOptions = {
  /** 覆盖数据库路径；缺省按 `AGENT_HOST_OPENCODE_DB` → `XDG_DATA_HOME` → 主目录。 */
  databasePath?: string;
  /**
   * 写进 `BusTask.agentId`。`MessageReader` 接口没有 host，只能由调用方注入；
   * 缺省空串（对账侧应在合并前替换）。
   */
  agentId?: string;
  /** 查默认路径与可执行文件时用的环境；测试注入。 */
  env?: NodeJS.ProcessEnv;
};

// MARK: - 路径与可执行文件

/** 上游 `OpenCodeSessionReader.defaultDatabaseURL`，另认 `XDG_DATA_HOME` 与显式覆盖。 */
export function defaultOpenCodeDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_HOST_OPENCODE_DB?.trim();
  if (override) return override;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

/** 上游 `AcpTaskID.make`（协议 id 是 `acp:<connectorId>:<sessionId>`）。 */
export function openCodeTaskId(sessionId: string): string {
  return `acp:${OPENCODE_CONNECTOR_ID}:${sessionId}`;
}

/**
 * 上游 `AcpTaskID.parse`：`acp:<connectorId>:<sessionId>`，只切前两个冒号，
 * 所以 session id 里可以再带冒号。
 */
export function parseAcpTaskId(
  taskId: string,
): { connectorId: string; sessionId: string } | undefined {
  const first = taskId.indexOf(":");
  if (first < 0) return undefined;
  const second = taskId.indexOf(":", first + 1);
  if (second < 0) return undefined;
  const kind = taskId.slice(0, first);
  const connectorId = taskId.slice(first + 1, second);
  const sessionId = taskId.slice(second + 1);
  if (kind !== "acp" || !ACP_ID_PATTERN.test(connectorId) || sessionId.length === 0) return undefined;
  return { connectorId, sessionId };
}

/**
 * 上游 `OpenCodeSessionReader.detectBinary`：`AgentBinary.detect("opencode", extra: ["~/.opencode/bin"])`。
 * 找不到返回 undefined；不认就报错，不编造路径。
 */
export function detectOpenCodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  extraDirectories: readonly string[] = ["~/.opencode/bin"],
): string | undefined {
  const directories = [
    ...extraDirectories,
    ...commonDirectories(env),
    ...nvmBinDirectories(env),
    ...splitSearchPath(searchPath(env)),
  ];
  const seen = new Set<string>();
  for (const directory of directories) {
    const expanded = expandTilde(directory);
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    for (const name of executableNames("opencode")) {
      const candidate = join(expanded, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// MARK: - 只读库句柄

/** 只读打开；调用方负责 `close()`。每次读都新开、读完即关，不跨轮持有读锁。 */
// PORT: 上游 Kit 的 `SQLiteDatabase` 在只读打不开、且 `-wal` 不在时会用
// `file:…?immutable=1` 再开一次；node:sqlite 不暴露 URI 文件名，这里只做只读打开。
// OpenCode 正在写库时 `-wal` 一定在，正常路径不受影响；库被干净关闭后只剩主文件
// 且只读打不开的情况会如实报错。
export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true, timeout: 200 });
}

// MARK: - 读取器

/**
 * 只读的 OpenCode 会话读取器。上游 `OpenCodeSessionReader` 的 `MessageReader`
 * 部分，外加 ACP 对账用的 `tasks` / `scan`。
 */
export class OpenCodeSessionReader implements MessageReader {
  readonly kind: ConnectorKind = "acp";
  readonly connectorId = OPENCODE_CONNECTOR_ID;
  /** 见 options 上的说明：`MessageReader` 不提供 host，默认空串。 */
  readonly agentId: string;

  private readonly options: OpenCodeSessionReaderOptions;

  constructor(options: OpenCodeSessionReaderOptions = {}) {
    this.options = options;
    this.agentId = options.agentId ?? "";
  }

  /** 每次调用时现算，环境变量改了立刻生效。 */
  get databasePath(): string {
    const override = this.options.databasePath?.trim();
    if (override) return override;
    return defaultOpenCodeDatabasePath(this.options.env ?? process.env);
  }

  async entries(
    taskId: string,
    limit: number,
  ): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const parsed = parseAcpTaskId(taskId);
    if (parsed === undefined || parsed.connectorId !== OPENCODE_CONNECTOR_ID) {
      throw new ConnectorError("无法识别的 OpenCode 任务");
    }
    const database = this.openDatabase();
    try {
      return this.readEntries(database, parsed.sessionId, limit);
    } finally {
      database.close();
    }
  }

  /** 同 `scan`，只要任务。 */
  tasks(now: Date = new Date()): BusTask[] {
    return this.scan(now).tasks;
  }

  /**
   * 窗口内更新过、没归档、不是子会话的会话，按更新时间降序最多 200 条。
   *
   * 状态规则照抄上游：先按 24 小时判 idle / completed；最后一条消息是 assistant
   * 时再看 `error`（MessageAbortedError → interrupted，其余 → failed）和
   * `time.completed`（缺省且 5 分钟内更新过 → running）；最后一条不是 assistant
   * 或者没有消息 → idle。
   */
  scan(now: Date = new Date()): OpenCodeScan {
    const database = this.openDatabase();
    try {
      const since = now.getTime() - RECENT_WINDOW_MS;
      const rows = database
        .prepare(
          `SELECT id, directory, title, time_created, time_updated FROM session
           WHERE parent_id IS NULL AND time_archived IS NULL AND time_updated >= ?
           ORDER BY time_updated DESC, id DESC LIMIT ?`,
        )
        .all(since, MAX_SESSIONS) as SqliteRow[];

      const oldest = rows[rows.length - 1];
      const coverageStart =
        rows.length >= MAX_SESSIONS && oldest !== undefined
          ? timestampFromMilliseconds(numberValue(oldest.time_updated) ?? 0)
          : undefined;

      const lastMessageStatement = database.prepare(
        `SELECT data FROM message WHERE session_id = ?
         ORDER BY time_created DESC, id DESC LIMIT 1`,
      );

      const tasks: BusTask[] = [];
      for (const row of rows) {
        const sessionId = stringValue(row.id);
        const cwd = stringValue(row.directory);
        if (sessionId === undefined || cwd === undefined) continue;

        const updated = new Date(numberValue(row.time_updated) ?? 0);
        const created = new Date(numberValue(row.time_created) ?? 0);
        const project = projectName(cwd);
        const rawTitle = truncate(singleLine(stringValue(row.title) ?? ""), TITLE_LIMIT);

        let status: BusTask["status"] = now.getTime() - updated.getTime() > IDLE_AFTER_MS
          ? "idle"
          : "completed";
        const lastRow = lastMessageStatement.get(sessionId) as SqliteRow | undefined;
        const lastData = jsonRecord(stringValue(lastRow?.data));
        if (lastData !== undefined && lastData.role === "assistant") {
          if ("error" in lastData && lastData.error !== undefined) {
            status = recordValue(lastData.error).name === "MessageAbortedError"
              ? "interrupted"
              : "failed";
          } else if (
            !turnCompleted(lastData) &&
            now.getTime() - updated.getTime() < RUNNING_WINDOW_MS
          ) {
            status = "running";
          }
        } else {
          status = "idle";
        }

        const recent = this.readEntries(database, sessionId, 1);
        // 工具行不占对话名额：取窗口里最后一条非工具消息。
        const lastConversation = findLast(recent.entries, (entry) => entry.message.role !== "tool");
        const lastMessage = lastConversation === undefined
          ? undefined
          : truncate(lastConversation.message.text, LAST_MESSAGE_LIMIT);

        tasks.push({
          id: openCodeTaskId(sessionId),
          agentId: this.agentId,
          source: "acp",
          title: rawTitle || project || sessionId,
          projectPath: cwd,
          projectName: project,
          status,
          ...(lastMessage === undefined ? {} : { lastMessage }),
          // 上游 `origin: .desktop`：会话本来就开在电脑上，不是 BotBus 起的。
          origin: "desktop",
          controllable: true,
          startedAt: timestampFromMilliseconds(created.getTime()),
          updatedAt: timestampFromMilliseconds(updated.getTime()),
          connectorId: OPENCODE_CONNECTOR_ID,
        });
      }
      return coverageStart === undefined ? { tasks } : { tasks, coverageStart };
    } finally {
      database.close();
    }
  }

  private openDatabase(): DatabaseSync {
    const path = this.databasePath;
    if (!existsSync(path)) {
      throw new ConnectorError(`未找到 OpenCode 数据库：${path}`);
    }
    return openReadOnly(path);
  }

  /**
   * 上游 `readEntries`：从最新往回翻页（每页 100 条），攒到"对话条数 > limit"
   * 为止，再交给 `latestWindow` 收窗口。
   *
   * 一条 `message` 展开成：正文 entry（`text` 部分用换行拼接；synthetic 跳过，
   * 只有图也算一条）+ assistant 的工具行（`<messageId>#<partId>`，排在正文之后）。
   * reasoning / 工具结果 / 步骤 / 快照都不进正文。
   */
  private readEntries(
    database: DatabaseSync,
    sessionId: string,
    limit: number,
  ): { entries: TranscriptEntry[]; hasMore: boolean } {
    const messageStatement = database.prepare(
      `SELECT id, time_created, data FROM message WHERE session_id = ?
       ORDER BY time_created DESC, id DESC LIMIT ${PAGE_SIZE} OFFSET ?`,
    );
    const partStatement = database.prepare(
      "SELECT id, data FROM part WHERE message_id = ? ORDER BY id",
    );

    const newestFirst: TranscriptEntry[] = [];
    let offset = 0;
    while (!isEnough(newestFirst, limit)) {
      const messages = messageStatement.all(sessionId, offset) as SqliteRow[];
      for (const message of messages) {
        const entries = entriesFromMessage(message, partStatement);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          newestFirst.push(entries[index]);
        }
      }
      if (messages.length < PAGE_SIZE) break;
      offset += messages.length;
    }
    return latestWindow([...newestFirst].reverse(), limit);
  }
}

/** 一行 `message` → 零到多条 entry，按时间正序（正文在前，工具行在后）。 */
export function entriesFromMessage(
  message: SqliteRow,
  partStatement: StatementSync,
): TranscriptEntry[] {
  const messageId = stringValue(message.id);
  const data = jsonRecord(stringValue(message.data));
  if (messageId === undefined || data === undefined) return [];
  const role = data.role;
  if (role !== "user" && role !== "assistant") return [];

  const createdAt = timestampFromMilliseconds(numberValue(message.time_created) ?? 0);
  const parts = partStatement.all(messageId) as SqliteRow[];
  const text: string[] = [];
  const tools: TranscriptEntry[] = [];
  const images: ImageSource[] = [];

  for (const part of parts) {
    const body = jsonRecord(stringValue(part.data));
    if (body === undefined) continue;
    switch (body.type) {
      case "text": {
        if (body.synthetic === true) break; // synthetic 是 agent 自己补的上下文，不是对话。
        const value = stringValue(body.text);
        if (value !== undefined) text.push(value);
        break;
      }
      case "tool": {
        if (role !== "assistant") break;
        const state = recordValue(body.state);
        const label = stringValue(state.title) ?? stringValue(body.tool) ?? "tool";
        const partId = stringValue(part.id);
        if (partId === undefined) break;
        const entry = transcriptEntry({
          id: `${messageId}#${partId}`,
          role: "tool",
          text: label,
          createdAt,
        });
        if (entry !== null) tools.push(entry);
        break;
      }
      case "file": {
        if (role !== "user") break;
        const url = stringValue(body.url);
        const image = url === undefined ? null : imageFromDataUrl(url);
        if (image !== null) images.push(image);
        break;
      }
      default:
        // reasoning、步骤、快照、工具结果都不作对话正文。
        break;
    }
  }

  const entries: TranscriptEntry[] = [];
  const messageText = text.join("\n");
  const body = transcriptEntry({
    id: messageId,
    role: role === "user" ? "user" : "agent",
    text: messageText,
    images,
    createdAt,
    // 窗口在 SQL 阶段已经取好；Agent 回复直接用未截断原文认路径候选。
    rawText: messageText,
  });
  if (body !== null) entries.push(body);
  entries.push(...tools);
  return entries;
}

/** 上游 `TranscriptWindow.isEnough`：对话条数超过上限才算够。 */
export function isEnough(newestFirst: readonly TranscriptEntry[], limit: number): boolean {
  const capped = Math.min(Math.max(limit, 1), MAX_USER_MESSAGES);
  return newestFirst.filter((entry) => entry.message.role !== "tool").length > capped;
}

// MARK: - 小工具

/** 协议时间：秒精度 UTC（`YYYY-MM-DDTHH:MM:SSZ`）。 */
export function timestampFromMilliseconds(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d+Z$/, "Z");
}

/** 上游 `SessionFormatting.projectName`：取路径最后一段；两种分隔符都认。 */
export function projectName(path: string): string {
  let trimmed = path;
  while (trimmed.length > 1 && /[\\/]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

/** 上游 `SessionFormatting.truncate`：先 trim，超长直接截断（不加省略号）。 */
export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

/** 标题必须单行：换行与连续空白压成一个空格。 */
export function singleLine(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

function turnCompleted(data: Record<string, unknown>): boolean {
  const completed = recordValue(data.time).completed;
  return completed !== undefined && completed !== null;
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** SQLite 的整数列：node:sqlite 可能给 number、bigint 或数字字符串。 */
function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// MARK: - 可执行文件探测（上游 AgentBinary.detect）

function commonDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      join(home, ".local", "bin"),
      join(appData, "npm"),
      join(localAppData, "Microsoft", "WinGet", "Links"),
      join(home, "scoop", "shims"),
      join(home, ".bun", "bin"),
      join(localAppData, "Volta", "bin"),
      join(localAppData, "pnpm"),
      join(programFiles, "nodejs"),
    ];
  }
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
    "/usr/bin",
  ];
}

function nvmBinDirectories(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === "win32") {
    const symlink = env.NVM_SYMLINK;
    return symlink ? [symlink] : [];
  }
  const root = join(homedir(), ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => join(root, version, "bin"));
  } catch {
    return [];
  }
}

function executableNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function searchPath(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key ? env[key] : undefined;
}

function splitSearchPath(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(delimiter).filter(Boolean);
}

// MARK: - 入口

/** 新建一个只读对话读取器；不依赖连接器进程是否在跑。 */
export function createOpenCodeSessionReader(
  options: OpenCodeSessionReaderOptions = {},
): MessageReader {
  return new OpenCodeSessionReader(options);
}

/** 一次性的会话快照（给 ACP 对账用）；内部新开只读连接、读完即关。 */
export function scanOpenCodeSessions(
  options: OpenCodeSessionReaderOptions = {},
  now: Date = new Date(),
): OpenCodeScan {
  return new OpenCodeSessionReader(options).scan(now);
}
