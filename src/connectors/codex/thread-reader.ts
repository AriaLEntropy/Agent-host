// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexThreadReader.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// 同文件还内联了 Kit `SQLiteDatabase.swift` 的只读打开逻辑（上游 CodexThreadReader 的
// 直接依赖）：`node:sqlite` + `readOnly: true`，WAL 侧文件缺失时按上游规则用
// `immutable=1` 重开一次。绝不写 ~/.codex，也绝不提供写接口。
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BusProject, BusTask } from "../../bus/store.js";
import type { TaskStatus } from "./app-server-messages.js";
import type { CodexPaths } from "./paths.js";

export type SQLiteValue = string | number | bigint | null | Uint8Array;
export type SQLiteRow = Record<string, SQLiteValue>;

export class SQLiteError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`SQLite error ${code}: ${message}`);
    this.name = "SQLiteError";
    this.code = code;
  }
}

function errorCode(error: unknown): number | undefined {
  const value = (error as { errcode?: unknown; code?: unknown }).errcode;
  return typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 极简 SQLite 封装，只覆盖本项目需要的只读查询。
 * 不是线程安全的：每个使用方自己持有实例，不跨线程共享（每次读都新开、读完即关）。
 */
export class SQLiteDatabase {
  private readonly db: DatabaseSync;
  /** 这次是不是走了 `immutable=1` 兜底。诊断与测试用。 */
  readonly usedImmutableFallback: boolean;

  constructor(path: string, readOnly = true) {
    const opened = openDatabase(path, readOnly);
    this.db = opened.db;
    this.usedImmutableFallback = opened.immutable;
    if (opened.immutable) immutableFallbacks.add(path);
  }

  query(sql: string, bindings: SQLiteValue[] = []): SQLiteRow[] {
    const statement = this.db.prepare(sql);
    return statement.all(...(bindings as never[])) as SQLiteRow[];
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 打开并立刻探读一次。
 *
 * `sqlite3_open_v2` 是**惰性**的：它基本只记下文件名，并不去碰 WAL 侧文件，所以
 * “WAL 库缺 `-wal`”这个错不会在打开时冒出来，而是等到第一次 prepare/step 才抛
 * SQLITE_CANTOPEN(14)。探一条最便宜的语句把打开变“急”，兜底判断才有东西可依据。
 */
function openDatabase(path: string, readOnly: boolean): { db: DatabaseSync; immutable: boolean } {
  let first: unknown;
  try {
    const db = new DatabaseSync(path, { readOnly, timeout: 200 });
    db.exec("SELECT 1 FROM sqlite_master LIMIT 1");
    return { db, immutable: false };
  } catch (error) {
    first = error;
  }

  if (readOnly && errorCode(first) === 14 && canRetryImmutable(path)) {
    try {
      const db = new DatabaseSync(immutableURI(path), { readOnly: true, timeout: 200 });
      db.exec("SELECT 1 FROM sqlite_master LIMIT 1");
      return { db, immutable: true };
    } catch {
      // 兜底也失败：按原始错误报。
    }
  }
  throw new SQLiteError(errorCode(first) ?? 1, errorMessage(first));
}

const immutableFallbacks = new Set<string>();

/** 通过公开查询判断某个路径是否走了兜底（测试与诊断用）。 */
export function usedImmutableFallback(path: string): boolean {
  return immutableFallbacks.has(path);
}

/**
 * 只读打开失败时要不要加 `immutable=1` 再试一次。
 *
 * 前提缺一不可：
 * 1. **`-wal` 不存在**——没有 `-wal` 说明库已经 checkpoint 过并被干净关闭，此刻没有写者。
 * 2. **主文件存在**——`immutable=1` 打开一个不存在的文件**不报错**，而是当成一个空库。
 */
function canRetryImmutable(path: string): boolean {
  return existsSync(path) && !existsSync(`${path}-wal`);
}

/**
 * SQLite 的 URI 文件名里 `?` 和 `#` 会截断路径、`%` 是转义前缀，这三个字符得先转义。
 * Windows 的 `C:\x\y.db` 写成 `file:///C:/x/y.db`：URI 里只认正斜杠，盘符前要有 `/`。
 */
function immutableURI(path: string): string {
  let uriPath = path;
  if (process.platform === "win32") {
    uriPath = path.replace(/\\/g, "/");
    if (!uriPath.startsWith("/")) uriPath = `///${uriPath}`;
  }
  let escaped = "";
  for (const character of uriPath) {
    if (character === "%") escaped += "%25";
    else if (character === "?") escaped += "%3f";
    else if (character === "#") escaped += "%23";
    else escaped += character;
  }
  return `file:${escaped}?immutable=1`;
}

/** 协议的 `ProtocolJSON.timestamp`：秒精度 UTC、不带小数（`YYYY-MM-DDTHH:MM:SSZ`）。 */
export function protocolTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 模型 id：1–64 个 `[A-Za-z0-9._:/-]`，不以 `-` 开头。 */
export function isValidModelId(id: string): boolean {
  return id.length >= 1 && id.length <= 64 && !id.startsWith("-") && /^[A-Za-z0-9._:/-]+$/.test(id);
}

/** 思考强度：1–16 个 `[a-z0-9-]`，不以 `-` 开头。 */
export function isValidEffort(effort: string): boolean {
  return effort.length >= 1 && effort.length <= 16 && !effort.startsWith("-") && /^[a-z0-9-]+$/.test(effort);
}

/** 模型选项（协议 3.2）。只保留非 hidden 的条目，id 必须合法。 */
export type ModelOption = {
  id: string;
  displayName: string;
  efforts?: string[];
  defaultEffort?: string;
};

const MAX_TITLE = 80;
const MAX_MESSAGE = 500;
const ACTIVITY_WINDOW_MS = 7 * 24 * 3600 * 1000;
const IDLE_AFTER_MS = 24 * 3600 * 1000;
const MAX_TASKS = 200;

function rowString(row: SQLiteRow | undefined, key: string): string | undefined {
  const value = row?.[key];
  return typeof value === "string" ? value : undefined;
}

function rowInt(row: SQLiteRow | undefined, key: string): number | undefined {
  const value = row?.[key];
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * 只读地把 Codex 的两个 SQLite 映射成协议模型。每次调用重新打开库（轮询间隔 2 秒，
 * 开销可忽略，且避免长期持有 WAL 读锁）。
 */
export class CodexThreadReader {
  static readonly maxTasks = MAX_TASKS;
  static readonly activityWindow = ACTIVITY_WINDOW_MS / 1000;
  static readonly idleAfter = IDLE_AFTER_MS / 1000;
  static readonly titleLimit = MAX_TITLE;
  static readonly messageLimit = MAX_MESSAGE;

  readonly stateDatabasePath: string;
  readonly historyDatabasePath: string;
  private readonly now: () => number;

  private constructor(stateDatabasePath: string, historyDatabasePath: string, now: () => number) {
    this.stateDatabasePath = stateDatabasePath;
    this.historyDatabasePath = historyDatabasePath;
    this.now = now;
  }

  /** 两个库任一找不到返回 undefined，调用方据此显示“未找到 Codex 数据库”。 */
  static create(paths: CodexPaths, now: () => number = Date.now): CodexThreadReader | undefined {
    const state = paths.stateDatabase;
    const history = paths.historyDatabase;
    if (!state || !history) return undefined;
    return new CodexThreadReader(state, history, now);
  }

  /**
   * 最近 7 天、未归档、非 subagent 的线程，按 updated_at_ms 降序，最多 200 条。
   * 任一库缺表（schema 漂移）或忙锁都抛错让整次轮询失败，由调用方按连续失败次数报警。
   */
  readTasks(agentId: string): BusTask[] {
    const state = new SQLiteDatabase(this.stateDatabasePath);
    try {
      const history = new SQLiteDatabase(this.historyDatabasePath);
      try {
        const current = this.now();
        const sinceMs = Math.trunc(current - ACTIVITY_WINDOW_MS);
        const rows = state.query(
          `
            SELECT id, cwd, name, title, first_user_message, created_at_ms, updated_at_ms, model, reasoning_effort
            FROM threads
            WHERE archived = 0 AND source NOT LIKE '{%' AND updated_at_ms > ?
            ORDER BY updated_at_ms DESC
            LIMIT ?
          `,
          [sinceMs, MAX_TASKS],
        );

        const tasks: BusTask[] = [];
        for (const row of rows) {
          const id = rowString(row, "id");
          const cwd = rowString(row, "cwd");
          const updatedMs = rowInt(row, "updated_at_ms");
          if (id === undefined || cwd === undefined || updatedMs === undefined) continue;
          const createdMs = rowInt(row, "created_at_ms") ?? updatedMs;

          // 这两条用 try（异常直接冒泡）而不是吞掉：history 库缺表或忙锁时吞掉错误，
          // 会把所有任务静默显示成 idle、没有最后消息。
          const latestTurn = history.query(
            "SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1",
            [id],
          )[0];
          const lastItem = history.query(
            `
              SELECT item_json FROM thread_items
              WHERE thread_id = ? AND item_type = 'agentMessage'
              ORDER BY rollout_ordinal DESC, updated_at_ordinal DESC LIMIT 1
            `,
            [id],
          )[0];

          const status = CodexThreadReader.status(rowString(latestTurn, "status"), updatedMs, current);
          const rawTitle = [rowString(row, "name"), rowString(row, "title"), rowString(row, "first_user_message")]
            .filter((value): value is string => value !== undefined)
            .map((value) => CodexThreadReader.singleLine(value))
            .find((value) => value.length > 0);
          const projectName = basename(cwd);

          const lastMessage = CodexThreadReader.agentMessageText(rowString(lastItem, "item_json"));
          const model = rowString(row, "model");
          const effort = rowString(row, "reasoning_effort");
          tasks.push({
            id: `codex:${id}`,
            agentId,
            source: "codex",
            title: CodexThreadReader.truncate(rawTitle ?? projectName, MAX_TITLE),
            projectPath: cwd,
            projectName,
            status,
            lastMessage: lastMessage === undefined ? undefined : CodexThreadReader.truncate(lastMessage, MAX_MESSAGE),
            origin: "desktop",
            controllable: status !== "running",
            startedAt: protocolTimestamp(createdMs),
            updatedAt: protocolTimestamp(updatedMs),
            // 协议 3.2：线程上记着的模型与强度（桌面上最后一次选的），不合法的值不报。
            model: model !== undefined && isValidModelId(model) ? model : undefined,
            effort: effort !== undefined && isValidEffort(effort) ? effort : undefined,
          });
        }
        return tasks;
      } finally {
        history.close();
      }
    } finally {
      state.close();
    }
  }

  /**
   * 最近项目：projects 表按更新时间降序，取每个项目 position=0 的根目录，最多 30 个。
   */
  readProjects(agentId: string): BusProject[] {
    const state = new SQLiteDatabase(this.stateDatabasePath);
    try {
      const rows = state.query(`
        SELECT p.name AS name, r.path AS path, p.updated_at_ms AS updated_at_ms
        FROM projects p
        JOIN project_roots r ON r.project_id = p.id AND r.position = 0
        ORDER BY p.updated_at_ms DESC
        LIMIT 30
      `);
      const projects: BusProject[] = [];
      for (const row of rows) {
        const path = rowString(row, "path");
        const ms = rowInt(row, "updated_at_ms");
        if (path === undefined || ms === undefined) continue;
        const name = rowString(row, "name") ?? basename(path);
        projects.push({
          agentId,
          path,
          name,
          lastUsedAt: protocolTimestamp(ms),
          pinned: false,
        });
      }
      return projects;
    } finally {
      state.close();
    }
  }

  /**
   * thread_turns.status ∈ completed | interrupted | failed | inProgress。
   * 超过 24 小时没动的一律 idle；完全没有轮次记录的线程也是 idle。
   */
  static status(turnStatus: string | undefined, updatedAt: number, now: number): TaskStatus {
    if (now - updatedAt > IDLE_AFTER_MS) return "idle";
    switch (turnStatus) {
      case "inProgress":
        return "running";
      case "failed":
        return "failed";
      case "interrupted":
        return "interrupted";
      case "completed":
        return "completed";
      default:
        return "idle";
    }
  }

  /** 标题必须单行：把换行与连续空白压成一个空格。 */
  static singleLine(text: string): string {
    return text.split(/\s+/).filter((part) => part.length > 0).join(" ");
  }

  /** thread_items.item_json 是 camelCase 的 ThreadItem；坏 JSON 或空文本返回 undefined。 */
  static agentMessageText(json: string | undefined): string | undefined {
    if (json === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const text = (parsed as { text?: unknown }).text;
    if (typeof text !== "string") return undefined;
    return text.trim().length === 0 ? undefined : text;
  }

  static truncate(text: string, limit: number): string {
    return text.length <= limit ? text : text.slice(0, limit);
  }
}

export type { TaskStatus };

/** 测试与调用方用：库文件看起来可读时的大小（不产生任何写）。 */
export function databaseSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
