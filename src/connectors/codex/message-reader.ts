// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexMessageReader.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  MAX_USER_MESSAGES,
  imageFromBase64,
  imageFromDataUrl,
  latestWindow,
  nativeTaskId,
  transcriptEntry,
  type ImageSource,
  type MessageReader,
  type TranscriptEntry,
} from "../ported/contract.js";
import { expandTilde, type CodexPaths } from "./paths.js";
import { CodexPaths as DefaultCodexPaths } from "./paths.js";
import { SQLiteDatabase, protocolTimestamp, type SQLiteRow } from "./thread-reader.js";
import { ConnectorError } from "../ported/contract.js";

function rowString(row: SQLiteRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function rowInt(row: SQLiteRow, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(object: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function arrayField(object: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = object?.[key];
  return Array.isArray(value) ? value : [];
}

/** 倒着翻页时“攒够了没有”：对话条数超过 limit（多一条只为判断“还有更早的”）。 */
function transcriptWindowIsEnough(newestFirst: TranscriptEntry[], limit: number): boolean {
  const capped = Math.min(Math.max(limit, 1), MAX_USER_MESSAGES);
  return newestFirst.filter((entry) => entry.message.role !== "tool").length > capped;
}

/**
 * 从 `~/.codex/thread_history_*.sqlite` 的 `thread_items` 读。
 *
 * **`reasoning` 不进对话记录**：它是模型的内部思考，在这台机器上就有 7000 多条，
 * 是所有类型里最多的；混进来会把用户真正想看的一问一答挤没。
 */
export class CodexMessageReader implements MessageReader {
  readonly kind = "codex" as const;

  /** 进对话记录的 item 类型。顺序无关，SQL 里按 rollout 排。 */
  static readonly includedTypes = [
    "userMessage",
    "agentMessage",
    "imageGeneration",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "webSearch",
  ];

  /** 翻页时每次从库里取多少行（倒序）。 */
  static readonly pageSize = 200;

  private readonly paths: () => CodexPaths;

  constructor(options: { paths?: CodexPaths | (() => CodexPaths) } = {}) {
    const configured = options.paths;
    this.paths =
      typeof configured === "function"
        ? configured
        : configured
          ? () => configured
          : () => new DefaultCodexPaths();
  }

  async entries(taskId: string, limit: number): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const threadId = nativeTaskId(taskId, "codex");
    const history = this.paths().historyDatabase;
    if (!history) throw new ConnectorError("没找到 Codex 历史库");
    const database = new SQLiteDatabase(history);
    try {
      const placeholders = CodexMessageReader.includedTypes.map(() => "?").join(",");
      // 倒着翻页：工具行不占对话名额，事先不知道要取多少行；攒到对话条数超过 limit
      // （多一条只为判断“还有更早的”）就停，窗口交给 `latestWindow`。
      const newestFirst: TranscriptEntry[] = [];
      let offset = 0;
      while (!transcriptWindowIsEnough(newestFirst, limit)) {
        const rows = database.query(
          `
            SELECT item_id, item_type, item_json, created_at_ms FROM thread_items
            WHERE thread_id = ? AND item_type IN (${placeholders})
            ORDER BY rollout_ordinal DESC, updated_at_ordinal DESC LIMIT ? OFFSET ?
          `,
          [threadId, ...CodexMessageReader.includedTypes, CodexMessageReader.pageSize, offset],
        );
        for (const row of rows) {
          const entry = CodexMessageReader.entry(row);
          if (entry) newestFirst.push(entry);
        }
        if (rows.length < CodexMessageReader.pageSize) break;
        offset += rows.length;
      }
      // SQL 取的是“最近 N 条”（倒序），界面要的是从旧到新，所以这里翻回来。
      return latestWindow(newestFirst.reverse(), limit);
    } finally {
      database.close();
    }
  }

  static entry(row: SQLiteRow): TranscriptEntry | undefined {
    const id = rowString(row, "item_id");
    const type = rowString(row, "item_type");
    if (id === undefined || type === undefined) return undefined;
    const content = CodexMessageReader.content(type, rowString(row, "item_json"));
    const createdMs = rowInt(row, "created_at_ms") ?? 0;
    const role: "user" | "agent" | "tool" =
      type === "userMessage" ? "user" : type === "agentMessage" || type === "imageGeneration" ? "agent" : "tool";
    return (
      transcriptEntry({
        id,
        role,
        text: content.text,
        images: content.images,
        createdAt: protocolTimestamp(createdMs),
        // SQL 这一步已经只取了窗口；Agent 回复直接用未截断原文认路径候选。
        rawText: content.text,
      }) ?? undefined
    );
  }

  /** 各类型的正文与图片所在，一次解析同时取出。工具类只留一行摘要——手机上没人要看 diff 全文。 */
  static content(type: string, json: string | undefined): { text?: string; images: ImageSource[] } {
    if (json === undefined) return { text: undefined, images: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { text: undefined, images: [] };
    }
    const object = record(parsed);
    if (!object) return { text: undefined, images: [] };
    switch (type) {
      case "userMessage": {
        // content 是 [{type, text, …}]，文本块拼起来；`localImage {path}` 与 `image {url: data:…}` 收成图片。
        if (typeof object["content"] === "string") return { text: object["content"], images: [] };
        const blocks = arrayField(object, "content");
        const texts: string[] = [];
        const images: ImageSource[] = [];
        for (const raw of blocks) {
          const block = record(raw);
          if (!block) continue;
          switch (stringField(block, "type")) {
            case "localImage": {
              const image = CodexMessageReader.localFile(stringField(block, "path"));
              if (image) images.push(image);
              break;
            }
            case "image": {
              const url = stringField(block, "url");
              const image = url === undefined ? null : imageFromDataUrl(url);
              if (image) images.push(image);
              break;
            }
            default: {
              const text = stringField(block, "text");
              if (text !== undefined) texts.push(text);
              break;
            }
          }
        }
        return { text: texts.join("\n"), images };
      }
      case "imageGeneration": {
        // 落盘的文件优先：`result` 是整张 PNG 的 base64，能不搬就不搬；没落盘才用它。
        // 文件被用户删了（`savedPath` 还在库里）也退回 `result`，不然这张图就再也看不到了。
        // 改写后的提示词当正文，让手机上看得出这张图是按什么画的。
        const prompt = stringField(object, "revisedPrompt");
        const saved = CodexMessageReader.localFile(stringField(object, "savedPath"));
        if (saved && saved.type === "file" && existsSync(saved.path)) {
          return { text: prompt, images: [saved] };
        }
        const result = stringField(object, "result");
        const inline = result === undefined ? null : imageFromBase64(result, "image/png");
        if (inline) return { text: prompt, images: [inline] };
        // 两样都不可用时仍报文件：读不到由上传器跳过，读取器不替它判断。
        return { text: prompt, images: saved ? [saved] : [] };
      }
      default:
        return { text: CodexMessageReader.text(type, object), images: [] };
    }
  }

  /**
   * 本机图片路径。`~` 开头的展开成 home（Codex 的 `savedPath` 两种写法都有）；
   * 相对路径不收——拼到 Agent 自己的工作目录上只会指错文件。
   */
  static localFile(path: string | undefined): ImageSource | undefined {
    if (path === undefined) return undefined;
    const expanded = expandTilde(path.trim());
    if (!isAbsolute(expanded)) return undefined;
    return { type: "file", path: expanded };
  }

  static text(type: string, object: Record<string, unknown>): string | undefined {
    switch (type) {
      case "agentMessage": {
        return stringField(object, "text");
      }
      case "commandExecution": {
        const command = stringField(object, "command");
        if (command === undefined) return undefined;
        const exit = typeof object["exitCode"] === "number" ? (object["exitCode"] as number) : undefined;
        return exit === undefined || exit === 0 ? `$ ${command}` : `$ ${command}（退出码 ${exit}）`;
      }
      case "fileChange": {
        const paths = arrayField(object, "changes")
          .map((change) => stringField(record(change), "path"))
          .filter((path): path is string => path !== undefined)
          .map((path) => basename(path));
        if (paths.length === 0) return undefined;
        return `改动 ${paths.slice(0, 5).join("、")}${paths.length > 5 ? ` 等 ${paths.length} 个文件` : ""}`;
      }
      case "mcpToolCall": {
        const server = stringField(object, "server") ?? "mcp";
        const tool = stringField(object, "tool");
        if (tool === undefined) return undefined;
        return `调用 ${server}/${tool}`;
      }
      case "webSearch": {
        const query = stringField(object, "query");
        if (query === undefined) return undefined;
        return `搜索「${query}」`;
      }
      default:
        return undefined;
    }
  }
}

export function createCodexMessageReader(options: { paths?: CodexPaths | (() => CodexPaths) } = {}): MessageReader {
  return new CodexMessageReader(options);
}
