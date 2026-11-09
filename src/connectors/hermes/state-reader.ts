// Ported from botbus-protocol/Sources/BotBusConnectors/Hermes/HermesStateReader.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// 只读地把 Hermes Agent 的 `state.db` 映射成协议模型。每次调用新开库、读完即关，
// 不跨轮持有读锁。schema 一律先 `PRAGMA table_info` 探测再拼 SQL：用户机器上的库
// 可能是老版本，写死列名会让每一轮都报 "no such column"。
//
// PORT: 上游 SQLiteDatabase 在只读打开失败、且 `-wal` 不存在时会用
// `file:…?immutable=1` 再开一次；node:sqlite 不暴露 URI 文件名，这里只做只读打开。
// Hermes 正在写库时 `-wal` 一定在，正常路径不受影响；库被干净关闭后只剩主文件且
// 只读打不开的情况会如实报错。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BusProject, BusTask } from "../../bus/store.js";
import { SESSION_HISTORY_WINDOW_MS } from "../session-window.js";
import { imageFromDataUrl, type ImageSource } from "../ported/contract.js";
import { HermesToolCalls } from "./message-reader.js";
import type { HermesPaths } from "./paths.js";

export const RECENT_WINDOW_SECONDS = SESSION_HISTORY_WINDOW_MS / 1000;
export const IDLE_AFTER_SECONDS = 24 * 3600;
export const TITLE_LIMIT = 80;
export const LAST_MESSAGE_LIMIT = 500;

export type SqliteRow = Record<string, unknown>;

/** 用只读连接开库；调用方负责 `close()`。 */
export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true, timeout: 200 });
}

/** 协议规定的时间格式：秒精度 UTC（`YYYY-MM-DDTHH:MM:SSZ`）。 */
export function protocolTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

/** 上游 `SessionFormatting.projectName`：取路径最后一段。Windows 与 POSIX 分隔符都认。 */
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

/** 数据库不存在（不是"没有会话"）。观察者据此不对账，一条都不摘。 */
export class HermesSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesSourceUnavailable";
  }
}

/** state.db 的结构不是我们认得的样子（缺表、缺关键列）。 */
export class HermesSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesSchemaError";
  }
}

// MARK: - 共用的 SQL 小工具

/**
 * 多模态内容的存法：`"\u0000json:" + JSON`。前缀带 NUL，所以读 `content` 时一律
 * `CAST(… AS BLOB)`：Node 的 TEXT 读取不会在 NUL 处截断，但保持与上游同样的取法，
 * 也兼容 BLOB 存储的库。
 */
export const HermesSQL = {
  jsonPrefix: "\u0000json:",

  /** `PRAGMA table_info` 的列名集合；表不存在时是空集。 */
  columns(database: DatabaseSync, table: string): Set<string> {
    const quoted = table.replace(/"/g, '""');
    const rows = database.prepare(`PRAGMA table_info("${quoted}")`).all();
    const names = new Set<string>();
    for (const row of rows) {
      const name = HermesSQL.text(row.name);
      if (name !== undefined) names.add(name);
    }
    return names;
  },

  /** TEXT、BLOB（`CAST AS BLOB` 读出来的）与数字都当文本。 */
  text(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
    return undefined;
  },

  /** `sessions.cwd`：去掉首尾空白，空的当没有。 */
  directory(value: unknown): string | undefined {
    const text = HermesSQL.text(value)?.trim();
    return text ? text : undefined;
  },

  /** Hermes 的时间是 REAL epoch 秒；老数据也可能是整数或数字字符串。 */
  seconds(value: unknown): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  },

  /** `messages.content` 解析一次：普通文本原样，`\0json:` 的解出 JSON，坏 JSON 返回 undefined。 */
  parseContent(raw: string | undefined | null): unknown {
    if (raw === undefined || raw === null) return undefined;
    if (!raw.startsWith(HermesSQL.jsonPrefix)) return raw;
    try {
      return JSON.parse(raw.slice(HermesSQL.jsonPrefix.length)) as unknown;
    } catch {
      return undefined;
    }
  },

  /** `messages.content` → 可读文本；解析不了的 JSON 返回 undefined。 */
  decodeContent(raw: string | undefined | null): string | undefined {
    return HermesSQL.textInContent(HermesSQL.parseContent(raw));
  },

  /** 内容块里的图片：只收 data URL（http 地址的图不在本机，拿不到字节）。 */
  imagesInContent(object: unknown): ImageSource[] {
    if (!Array.isArray(object)) return [];
    const images: ImageSource[] = [];
    for (const part of object) {
      if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
      const block = part as Record<string, unknown>;
      const type = block.type;
      if (type !== "image_url" && type !== "input_image") continue;
      const raw = block.image_url;
      const url = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).url : raw;
      if (typeof url !== "string") continue;
      const image = imageFromDataUrl(url);
      if (image) images.push(image);
    }
    return images;
  },

  /** 内容块 → 文本。字符串原样；数组只拼文本块；对象取 `text` 或递归 `content`。 */
  textInContent(object: unknown): string | undefined {
    if (typeof object === "string") return object;
    if (Array.isArray(object)) {
      const texts: string[] = [];
      for (const part of object) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (typeof part !== "object" || part === null) continue;
        const block = part as Record<string, unknown>;
        const type = block.type;
        if (type !== undefined && type !== "text" && type !== "input_text" && type !== "output_text") continue;
        if (typeof block.text === "string") texts.push(block.text);
      }
      return texts.length > 0 ? texts.join("\n") : undefined;
    }
    if (typeof object === "object" && object !== null) {
      const block = object as Record<string, unknown>;
      if (typeof block.text === "string") return block.text;
      if ("content" in block) return HermesSQL.textInContent(block.content);
    }
    return undefined;
  },
};

// MARK: - 快照

export type HermesStateReaderOptions = {
  databasePath: string;
  fallbackDirectory?: string;
  now?: () => Date;
};

/**
 * 只读地把 `state.db` 映射成协议模型。
 *
 * 回溯窗口内有活动、没归档/隐藏、不是被压缩掉的旧会话，活动时间降序，最多 200 条。
 * 没有 `cwd` 的会话归到 `fallbackDirectory`。库不存在抛 `HermesSourceUnavailable`；
 * 缺表、忙锁照常抛错。
 */
export class HermesStateReader {
  static readonly maxTasks = 200;
  /** `ended_at` 为空、且最近这么久内有过动静，才算"正在跑"。 */
  static readonly runningWindow = 120;
  /** 这些 `end_reason` 说明会话是出错结束的。 */
  static readonly failedEndReasons = new Set(["error", "agent_error", "content_filter"]);
  /** 一轮已经收尾的 assistant `finish_reason`；`tool_calls` 不在里面。 */
  static readonly finishedReasons = new Set(["stop", "length", "end_turn", "content_filter"]);

  readonly databasePath: string;
  readonly fallbackDirectory: string;
  private readonly clock: () => Date;

  constructor(options: HermesStateReaderOptions) {
    this.databasePath = options.databasePath;
    this.fallbackDirectory = options.fallbackDirectory ?? HermesStateReader.homeDirectory;
    this.clock = options.now ?? (() => new Date());
  }

  static get homeDirectory(): string {
    return homedir();
  }

  static fromPaths(
    paths: HermesPaths,
    fallbackDirectory: string = HermesStateReader.homeDirectory,
    now: () => Date = () => new Date(),
  ): HermesStateReader {
    return new HermesStateReader({ databasePath: join(paths.hermesHome, "state.db"), fallbackDirectory, now });
  }

  readSnapshot(agentId: string): { tasks: BusTask[]; projects: BusProject[] } {
    if (!existsSync(this.databasePath)) {
      throw new HermesSourceUnavailable(`未找到 Hermes 数据库：${this.databasePath}`);
    }
    const database = openReadOnly(this.databasePath);
    try {
      const tasks = this.readTasks(database, agentId);
      return { tasks, projects: projectsFrom(tasks, agentId) };
    } finally {
      database.close();
    }
  }

  readTasks(database: DatabaseSync, agentId: string): BusTask[] {
    const sessionColumns = HermesSQL.columns(database, "sessions");
    if (sessionColumns.size === 0) throw new HermesSchemaError("state.db 里没有 sessions 表");
    if (!sessionColumns.has("id")) throw new HermesSchemaError("sessions 表缺 id 列");
    const activityParts = ["last_activity_at", "ended_at", "started_at"].filter((column) =>
      sessionColumns.has(column),
    );
    if (activityParts.length === 0) throw new HermesSchemaError("sessions 表没有任何时间列");
    const activity =
      activityParts.length === 1
        ? activityParts[0]
        : `COALESCE(${activityParts.join(", ")})`;

    const filters = [`${activity} > ?`];
    if (sessionColumns.has("archived")) filters.push("COALESCE(archived, 0) = 0");
    if (sessionColumns.has("hidden")) filters.push("COALESCE(hidden, 0) = 0");
    // 压缩会以 end_reason='compression' 结束旧会话、新开一行接着聊：只显示链条末端。
    if (sessionColumns.has("end_reason")) {
      filters.push("(end_reason IS NULL OR end_reason != 'compression')");
    }

    const wanted = ["id", "cwd", "title", "started_at", "ended_at", "last_activity_at", "end_reason"];
    const selected = wanted.filter((column) => sessionColumns.has(column)).join(", ");
    const current = this.clock();
    const since = current.getTime() / 1000 - RECENT_WINDOW_SECONDS;
    const rows = database
      .prepare(
        `SELECT ${selected}, ${activity} AS activity_at FROM sessions
         WHERE ${filters.join(" AND ")}
         ORDER BY activity_at DESC
         LIMIT ?`,
      )
      .all(since, HermesStateReader.maxTasks);

    const messages = new HermesMessageQueries(database);
    const tasks: BusTask[] = [];
    for (const row of rows) {
      const id = HermesSQL.text(row.id)?.trim();
      if (!id) continue;
      const activitySeconds = HermesSQL.seconds(row.activity_at);
      if (activitySeconds === undefined) continue;
      const ownCwd = HermesSQL.directory(row.cwd);
      const cwd = ownCwd ?? this.fallbackDirectory;
      const activityAt = new Date(activitySeconds * 1000);
      const startedSeconds = HermesSQL.seconds(row.started_at);
      const startedAt = startedSeconds === undefined ? activityAt : new Date(startedSeconds * 1000);
      const endedAt = HermesSQL.seconds(row.ended_at);
      const endReason = HermesSQL.text(row.end_reason);
      const name = projectName(cwd);

      // 只有"看上去还在跑"的才去问最后一条消息：它决定 running 与 completed 的分界。
      const looksRunning =
        endedAt === undefined && current.getTime() / 1000 - activitySeconds <= HermesStateReader.runningWindow;
      const turnFinished = looksRunning ? messages.lastTurnFinished(id) : false;
      const status = HermesStateReader.status(
        endReason,
        endedAt !== undefined,
        activityAt,
        current,
        turnFinished,
      );

      let title = row.title === undefined || row.title === null ? "" : singleLine(HermesSQL.text(row.title) ?? "");
      if (!title) {
        const first = messages.firstUserText(id);
        if (first) title = singleLine(first);
      }
      if (!title) title = ownCwd === undefined || !name ? "Hermes 会话" : name;

      const last = messages.lastAssistantText(id);
      tasks.push({
        id: `hermes:${id}`,
        agentId,
        source: "hermes",
        title: truncate(title, TITLE_LIMIT),
        projectPath: cwd,
        projectName: name,
        status,
        ...(last === undefined ? {} : { lastMessage: truncate(last, LAST_MESSAGE_LIMIT) }),
        origin: "desktop",
        // 桌面上正在跑的会话我们没有它的进程：续聊会和它抢同一个会话，中断也发不了信号。
        controllable: status !== "running",
        startedAt: protocolTimestamp(startedAt),
        updatedAt: protocolTimestamp(activityAt),
      });
    }
    return tasks;
  }

  /**
   * 一个会话的工作目录。会话在、但没有 cwd 回 `fallbackDirectory`；
   * 库不在、会话不在返回 undefined，由连接器退回自己记得的目录。
   */
  cwd(forSession: string): string | undefined {
    if (!existsSync(this.databasePath)) return undefined;
    let database: DatabaseSync;
    try {
      database = openReadOnly(this.databasePath);
    } catch {
      return undefined;
    }
    try {
      let columns: Set<string>;
      try {
        columns = HermesSQL.columns(database, "sessions");
      } catch {
        return undefined;
      }
      if (!columns.has("id")) return undefined;
      const selected = columns.has("cwd") ? "cwd" : "id";
      const row = database
        .prepare(`SELECT ${selected} FROM sessions WHERE id = ? LIMIT 1`)
        .get(forSession);
      if (row === undefined) return undefined;
      return HermesSQL.directory(row.cwd) ?? this.fallbackDirectory;
    } catch {
      return undefined;
    } finally {
      database.close();
    }
  }

  /**
   * 状态映射。顺序有讲究：
   * 1. 超过 24 小时没动一律 idle；
   * 2. `end_reason` 是出错类 → failed；
   * 3. 没结束、2 分钟内有动静、且最后一条不是"已收尾的回答" → running；
   * 4. 其余 completed。
   */
  static status(
    endReason: string | undefined,
    ended: boolean,
    activityAt: Date,
    now: Date,
    turnFinished = false,
  ): "running" | "completed" | "failed" | "idle" {
    const age = (now.getTime() - activityAt.getTime()) / 1000;
    if (age > IDLE_AFTER_SECONDS) return "idle";
    if (endReason !== undefined && HermesStateReader.failedEndReasons.has(endReason)) return "failed";
    if (!ended && age <= HermesStateReader.runningWindow && !turnFinished) return "running";
    return "completed";
  }

  static singleLine(text: string): string {
    return singleLine(text);
  }
}

/** `SessionObserver` 的 Hermes 数据源：每轮现建一个 reader，路径设置改了下一轮就生效。 */
export class HermesStateSource {
  constructor(
    private readonly paths: HermesPaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  readSnapshot(agentId: string): { tasks: BusTask[]; projects: BusProject[] } {
    return HermesStateReader.fromPaths(this.paths, HermesStateReader.homeDirectory, this.now).readSnapshot(agentId);
  }
}

function projectsFrom(tasks: readonly BusTask[], agentId: string): BusProject[] {
  const latest = new Map<string, string>();
  for (const task of tasks) {
    if (!task.projectPath) continue;
    const existing = latest.get(task.projectPath);
    if (existing !== undefined && existing >= task.updatedAt) continue;
    latest.set(task.projectPath, task.updatedAt);
  }
  return [...latest.entries()]
    .sort((left, right) => (left[1] < right[1] ? 1 : left[1] > right[1] ? -1 : 0))
    .map(([path, lastUsedAt]) => ({
      agentId,
      path,
      name: projectName(path),
      lastUsedAt,
      pinned: false,
    }));
}

// MARK: - messages 表的三个小查询

/**
 * 观察者对 `messages` 表的查询。列同样先探测：老库没有 `active` / `timestamp` /
 * `finish_reason` 时照样能读。
 */
export class HermesMessageQueries {
  private readonly database: DatabaseSync;
  private readonly columns: Set<string>;

  constructor(database: DatabaseSync) {
    this.database = database;
    this.columns = HermesSQL.columns(database, "messages");
  }

  private get usable(): boolean {
    return ["session_id", "role", "content"].every((column) => this.columns.has(column));
  }

  /** 只看当前对话里的消息（`active=1`）；回退/改写掉的分支不算。 */
  private get activeFilter(): string {
    return this.columns.has("active") ? " AND COALESCE(active, 1) = 1" : "";
  }

  private get newestFirst(): string {
    return this.columns.has("timestamp") ? "timestamp DESC, id DESC" : "id DESC";
  }

  private get oldestFirst(): string {
    return this.columns.has("timestamp") ? "timestamp ASC, id ASC" : "id ASC";
  }

  /** 首条非空的 user 文本，做标题的兜底。多取几条是因为头几条可能是纯图片。 */
  firstUserText(sessionID: string): string | undefined {
    if (!this.usable) return undefined;
    const rows = this.database
      .prepare(
        `SELECT CAST(content AS BLOB) AS content FROM messages
         WHERE session_id = ? AND role = 'user'${this.activeFilter}
         ORDER BY ${this.oldestFirst} LIMIT 5`,
      )
      .all(sessionID);
    return this.firstNonEmpty(rows);
  }

  /** 最后一条非空的 assistant 文本；`reasoning*` 列是模型的内部思考，不外发。 */
  lastAssistantText(sessionID: string): string | undefined {
    if (!this.usable) return undefined;
    const rows = this.database
      .prepare(
        `SELECT CAST(content AS BLOB) AS content FROM messages
         WHERE session_id = ? AND role = 'assistant' AND content IS NOT NULL${this.activeFilter}
         ORDER BY ${this.newestFirst} LIMIT 5`,
      )
      .all(sessionID);
    return this.firstNonEmpty(rows);
  }

  /** 最后一条消息是不是"这一轮已经答完"：assistant、收尾类 `finish_reason`、没有挂着工具调用。 */
  lastTurnFinished(sessionID: string): boolean {
    if (!this.usable || !this.columns.has("finish_reason")) return false;
    const toolCalls = this.columns.has("tool_calls") ? ", tool_calls" : "";
    const row = this.database
      .prepare(
        `SELECT role, finish_reason${toolCalls} FROM messages
         WHERE session_id = ?${this.activeFilter}
         ORDER BY ${this.newestFirst} LIMIT 1`,
      )
      .get(sessionID);
    if (row === undefined) return false;
    if (HermesSQL.text(row.role) !== "assistant") return false;
    const reason = HermesSQL.text(row.finish_reason);
    if (reason === undefined || !HermesStateReader.finishedReasons.has(reason)) return false;
    const rawToolCalls = HermesSQL.text(row.tool_calls);
    const pendingTools = rawToolCalls !== undefined ? HermesToolCalls.parse(rawToolCalls).length > 0 : false;
    return !pendingTools;
  }

  private firstNonEmpty(rows: readonly SqliteRow[]): string | undefined {
    for (const row of rows) {
      const text = HermesSQL.decodeContent(HermesSQL.text(row.content))?.trim();
      if (text) return text;
    }
    return undefined;
  }
}
