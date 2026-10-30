// Ported from botbus-protocol/Sources/BotBusConnectors/Hermes/HermesMessageReader.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// 从 `state.db` 的 `messages` 表读一个会话的对话记录：
// - `user` → 用户；`assistant` 的 `content` → agent；
// - assistant 的每个 `tool_calls` 条目各压成一行 `.tool` 摘要；
// - `role='tool'`（往往是整个文件或一屏日志）与 `system` 直接跳过；
// - `reasoning*` 列一律不读（模型的内部思考，与 Codex 那边不收 `reasoning` 同一条规矩）。
//
// 一行 assistant 可能展开成多条消息，id 用 `<行 id>`（正文）/ `<行 id>#<n>`（第 n 个
// 工具调用），重复拉取保持稳定。窗口规则走契约里的 `latestWindow`。

import { DatabaseSync } from "node:sqlite";
import {
  ConnectorError,
  MAX_USER_MESSAGES,
  latestWindow,
  nativeTaskId,
  transcriptEntry,
  type ConnectorKind,
  type MessageReader,
  type TranscriptEntry,
} from "../ported/contract.js";
import { HermesSQL, openReadOnly, protocolTimestamp, singleLine, type SqliteRow } from "./state-reader.js";
import { hermesPaths, stateDatabase, type HermesPaths } from "./paths.js";

/** 翻页时每次从库里取多少行（倒序）。一行最多展开出若干条。 */
const PAGE_SIZE = 100;
/** 工具摘要里参数部分的上限：手机上一行放不下更多。 */
const ARGUMENT_LIMIT = 80;

export type HermesMessageReaderOptions = {
  /** 每次读时现取；默认 `~/.hermes`。测试注入临时目录。 */
  paths?: () => HermesPaths;
};

export class HermesMessageReader implements MessageReader {
  readonly kind: ConnectorKind = "hermes";
  private readonly paths: () => HermesPaths;

  constructor(options: HermesMessageReaderOptions = {}) {
    this.paths = options.paths ?? (() => hermesPaths());
  }

  async entries(
    taskId: string,
    limit: number,
  ): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const sessionID = nativeTaskId(taskId, "hermes");
    const databasePath = stateDatabase(this.paths());
    if (!databasePath) throw new ConnectorError("没找到 Hermes 数据库");

    const database = openReadOnly(databasePath);
    try {
      const columns = HermesSQL.columns(database, "messages");
      for (const required of ["id", "session_id", "role", "content"]) {
        if (!columns.has(required)) throw new ConnectorError("Hermes 数据库的 messages 表结构不认识");
      }

      const optional = ["tool_calls", "timestamp"]
        .filter((column) => columns.has(column))
        .map((column) => `, ${column}`)
        .join("");
      const active = columns.has("active") ? " AND COALESCE(active, 1) = 1" : "";
      const order = columns.has("timestamp") ? "timestamp DESC, id DESC" : "id DESC";
      const statement = database.prepare(
        `SELECT id, role, CAST(content AS BLOB) AS content${optional} FROM messages
         WHERE session_id = ? AND role IN ('user', 'assistant')${active}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      );

      // 倒着翻页：最新的在前，攒够 limit + 1 条对话（多一条只为判断"还有更早的"）就停。
      const newestFirst: TranscriptEntry[] = [];
      let offset = 0;
      while (!isEnough(newestFirst, limit)) {
        const rows = statement.all(sessionID, PAGE_SIZE, offset) as SqliteRow[];
        for (const row of rows) {
          const rowEntries = entriesFromRow(row);
          for (let index = rowEntries.length - 1; index >= 0; index -= 1) {
            newestFirst.push(rowEntries[index]);
          }
        }
        if (rows.length < PAGE_SIZE) break;
        offset += rows.length;
      }

      return latestWindow([...newestFirst].reverse(), limit);
    } finally {
      database.close();
    }
  }
}

/** 上游 `TranscriptWindow.isEnough`：对话条数超过上限才算够。 */
function isEnough(newestFirst: readonly TranscriptEntry[], limit: number): boolean {
  const capped = Math.min(Math.max(limit, 1), MAX_USER_MESSAGES);
  return newestFirst.filter((entry) => entry.message.role !== "tool").length > capped;
}

/** 一行 → 零到多条消息，按时间正序（正文在前，工具调用在后）。 */
export function entriesFromRow(row: SqliteRow): TranscriptEntry[] {
  const rowID = HermesSQL.text(row.id);
  const role = HermesSQL.text(row.role);
  if (rowID === undefined || role === undefined) return [];
  const createdAt = protocolTimestamp(new Date((HermesSQL.seconds(row.timestamp) ?? 0) * 1000));
  const result: TranscriptEntry[] = [];
  const content = HermesSQL.parseContent(HermesSQL.text(row.content));
  if (content !== undefined) {
    const text = HermesSQL.textInContent(content);
    const entry = transcriptEntry({
      id: rowID,
      role: role === "user" ? "user" : "agent",
      text,
      images: role === "user" ? HermesSQL.imagesInContent(content) : [],
      createdAt,
      // 窗口在 SQL 阶段已经取好；Agent 回复直接用未截断原文认路径候选。
      rawText: text,
    });
    if (entry) result.push(entry);
  }
  const toolCalls = role === "assistant" ? HermesSQL.text(row.tool_calls) : undefined;
  if (toolCalls === undefined) return result;
  HermesToolCalls.parse(toolCalls).forEach((call, index) => {
    const entry = transcriptEntry({
      id: `${rowID}#${index + 1}`,
      role: "tool",
      text: call.summary(ARGUMENT_LIMIT),
      createdAt,
    });
    if (entry) result.push(entry);
  });
  return result;
}

// MARK: - tool_calls

/**
 * `messages.tool_calls`：OpenAI 形状的 JSON 串
 * `[{id, type:"function", function:{name, arguments}}]`，其中 `arguments` 通常又是
 * 一个 JSON **字符串**。整段容错：坏 JSON 就是没有工具调用。
 */
export class HermesToolCall {
  readonly name: string;
  readonly args: unknown;

  constructor(name: string, args: unknown) {
    this.name = name;
    this.args = args;
  }

  /** `terminal: <命令>`，其余 `<函数名>(<简短参数>)`。 */
  summary(argumentLimit: number): string {
    const object = isRecord(this.args) ? this.args : undefined;
    if (this.name === "terminal" && object !== undefined) {
      const command = stringValue(object.command)?.trim();
      if (command) return `terminal: ${command}`;
    }
    const short = HermesToolCall.shortArguments(this.args, argumentLimit);
    return short ? `${this.name}(${short})` : `${this.name}()`;
  }

  /** 最能说明"在干什么"的那个参数优先，否则把整个参数压成一行 JSON 截断。 */
  static shortArguments(args: unknown, limit: number): string {
    if (args === undefined || args === null) return "";
    if (isRecord(args)) {
      for (const key of ["path", "file_path", "query", "url", "pattern", "command", "name"]) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) {
          return clip(singleLine(value), limit);
        }
      }
      if (Object.keys(args).length === 0) return "";
    }
    if (typeof args === "string") return clip(singleLine(args), limit);
    if (Array.isArray(args) || isRecord(args)) {
      const json = stableJSON(args);
      return json === undefined ? "" : clip(json, limit);
    }
    return "";
  }
}

export const HermesToolCalls = {
  parse(json: string): HermesToolCall[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const calls: HermesToolCall[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const fn = isRecord(entry.function) ? entry.function : undefined;
      const rawName = fn?.name ?? entry.name;
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (!name) continue;
      const rawArgs = fn?.arguments ?? entry.arguments;
      let args: unknown = rawArgs;
      if (typeof rawArgs === "string") {
        // 字符串形状的参数先试着当 JSON 解开；解不开就保留原文。
        try {
          args = JSON.parse(rawArgs) as unknown;
        } catch {
          args = rawArgs.trim() ? rawArgs : undefined;
        }
      }
      calls.push(new HermesToolCall(name, args));
    }
    return calls;
  },
};

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 对应 Swift `JSONSerialization` 的 `[.sortedKeys, .withoutEscapingSlashes]`。 */
function stableJSON(value: unknown): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const encoded = stableJSON(item);
      if (encoded === undefined) return undefined;
      parts.push(encoded);
    }
    return `[${parts.join(",")}]`;
  }
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = stableJSON(value[key]);
      if (encoded === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 让 `DatabaseSync` 的类型在测试里可用；读取器只从传进来的库句柄取数。 */
export type HermesSqliteDatabase = DatabaseSync;
