/**
 * 读 OpenClaw 会话的对话记录：经 Gateway 的 `chat.history {sessionKey, limit}`。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/OpenClaw/OpenClawMessageReader.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * OpenClaw 的 transcript 在 Gateway 自己的 SQLite 里（部分行 zstd 压缩），没有能直接读的
 * 文件，所以「独立于连接器」在这里的含义是：**不要求连接器在跑**。默认实现每次拉取
 * 自己开一条 Gateway 连接、握手、取完就关；也可以用 `preferring(connector)` 先借
 * 连接器那条已连上的连接，借不到再自己连。
 *
 * 消息形状与 Pi 相同：`role` 为 `user` / `assistant` / `toolResult`，assistant 的
 * `content` 是 `text` / `thinking` / `toolCall` 块。映射：user 的文字与图片 → user；
 * assistant 的文本 → agent（thinking 不进对话）；toolCall → 一行 tool 摘要；toolResult 跳过。
 */
import type {
  ConnectorKind,
  ImageSource,
  MessageReader,
  TranscriptEntry,
} from "../ported/contract.js";
import { MAX_USER_MESSAGES, imageFromBase64, latestWindow, nativeTaskId, transcriptEntry } from "../ported/contract.js";
import type { OpenClawConnector } from "./connector.js";
import { OpenClawConfig } from "./config.js";
import {
  OpenClawGateway,
  OpenClawWebSocketTransport,
  defaultClientVersion,
  openClawGatewayConfiguration,
  type WebSocketTransport,
} from "./gateway.js";
import {
  arrayValue,
  dateValue,
  integerValue,
  isRecord,
  protocolTimestamp,
  stringValue,
} from "./values.js";

export type OpenClawFetch = (sessionKey: string, limit: number) => Promise<unknown>;

export type OpenClawMessageReaderOptions = {
  /** 直接注入取一页 `chat.history` 的函数（测试用）。 */
  fetch?: OpenClawFetch;
  config?: () => OpenClawConfig;
  transport?: WebSocketTransport;
  clientVersion?: string;
  /** 先用连接器那条连接；它没连上再自己连。 */
  connector?: OpenClawConnector;
};

export class OpenClawMessageReader implements MessageReader {
  readonly kind: ConnectorKind = "openclaw";

  constructor(private readonly fetch: OpenClawFetch) {}

  static create(options: OpenClawMessageReaderOptions = {}): OpenClawMessageReader {
    if (options.fetch) return new OpenClawMessageReader(options.fetch);
    const config = options.config ?? (() => OpenClawConfig.load());
    const transport = options.transport ?? new OpenClawWebSocketTransport();
    const clientVersion = options.clientVersion ?? defaultClientVersion();
    const connector = options.connector;
    return new OpenClawMessageReader(async (sessionKey, limit) => {
      if (connector?.isConnected) {
        return connector.chatHistory(sessionKey, limit);
      }
      return OpenClawMessageReader.fetchOnce(
        sessionKey,
        limit,
        config(),
        transport,
        clientVersion,
      );
    });
  }

  /** 先用连接器那条连接；它没连上（或已停）再自己连一次。 */
  static preferring(
    connector: OpenClawConnector,
    options: Omit<OpenClawMessageReaderOptions, "connector"> = {},
  ): OpenClawMessageReader {
    return OpenClawMessageReader.create({ ...options, connector });
  }

  /** 每次拉取单独连一次 Gateway，取完就关。 */
  static async fetchOnce(
    sessionKey: string,
    limit: number,
    config: OpenClawConfig,
    transport: WebSocketTransport,
    clientVersion: string,
  ): Promise<unknown> {
    const gateway = new OpenClawGateway(
      transport,
      openClawGatewayConfiguration(config, clientVersion),
    );
    try {
      await gateway.connect();
      const payload = await gateway.request("chat.history", { sessionKey, limit });
      gateway.close();
      return payload;
    } catch (error) {
      gateway.close();
      throw error;
    }
  }

  async entries(
    taskId: string,
    limit: number,
  ): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const sessionKey = nativeTaskId(taskId, "openclaw");
    const payload = await this.fetch(sessionKey, openClawRecordLimit(limit));
    const all = openClawEntriesFromPayload(payload);
    // 一条 transcript 记录可能展开成好几条（文本 + 工具调用），也可能整条被跳过。
    const { entries, hasMore } = latestWindow(all, limit);
    const payloadHasMore = isRecord(payload) && payload["hasMore"] === true;
    return { entries, hasMore: hasMore || payloadHasMore };
  }
}

/**
 * `chat.history` 的 `limit` 数的是存储记录，工具调用与工具结果各占一条，而窗口只数对话：
 * 按每条对话平均夹几次工具调用往多了要，凑不够就少几条，不为此多拉一次。
 */
export function openClawRecordLimit(forConversation: number): number {
  return (Math.min(Math.max(forConversation, 1), MAX_USER_MESSAGES) + 1) * 8;
}

/** 整页映射，按 Gateway 给的顺序（旧 → 新）。id 在同一页里去重。 */
export function openClawEntriesFromPayload(payload: unknown): TranscriptEntry[] {
  const records = Array.isArray(payload)
    ? payload
    : (arrayValue(isRecord(payload) ? payload["messages"] : undefined) ?? []);
  const used = new Map<string, number>();
  const result: TranscriptEntry[] = [];
  for (const record of records) {
    for (const entry of openClawEntriesFromRecord(record)) {
      const count = used.get(entry.message.id) ?? 0;
      used.set(entry.message.id, count + 1);
      if (count > 0) entry.message.id += `~${count}`;
      result.push(entry);
    }
  }
  return result;
}

/** 一条 transcript 记录 → 0…n 条。 */
export function openClawEntriesFromRecord(record: unknown): TranscriptEntry[] {
  if (!isRecord(record)) return [];
  const meta = isRecord(record["__openclaw"]) ? record["__openclaw"] : undefined;
  // 压缩边界、重置边界这类合成行没有对话内容。
  if (stringValue(meta?.["kind"]) !== undefined) return [];
  const role = stringValue(record["role"]);
  const timestamp = dateValue(record["timestamp"]);
  const createdAt = protocolTimestamp(timestamp ?? new Date(0));
  // 稳定 id：transcript 条目 id 优先，其次序号；都没有就用角色 + 时间戳（重复拉取时不会变）。
  const sequence = integerValue(meta?.["seq"]);
  const sequenceID = sequence !== undefined ? `seq-${sequence}` : undefined;
  const fallbackMillis = timestamp ? Math.round(timestamp.getTime()) : 0;
  const fallbackID = `${role ?? "entry"}-${fallbackMillis}`;
  const base =
    stringValue(meta?.["id"]) ??
    sequenceID ??
    stringValue(record["id"]) ??
    fallbackID;

  switch (role) {
    case "user": {
      // 运行期上下文的载体（系统塞进来的环境信息）不是用户说的话。
      if (record["runtimeContextCarrier"] === true) return [];
      const content = record["content"];
      const entry = makeEntry(
        base,
        "user",
        openClawTranscriptText(content),
        createdAt,
        openClawTranscriptImages(content),
      );
      return entry ? [entry] : [];
    }
    case "assistant":
      return assistantEntries(record["content"], base, createdAt);
    default:
      // toolResult 的正文往往是整个文件或一屏日志，摘要都嫌长；其余角色不是对话。
      return [];
  }
}

/** assistant 的内容块按顺序切：连续的文本并成一条 agent，每个工具调用单独一行 tool。 */
function assistantEntries(
  content: unknown,
  base: string,
  createdAt: string,
): TranscriptEntry[] {
  if (typeof content === "string") {
    const entry = makeEntry(base, "agent", content, createdAt);
    return entry ? [entry] : [];
  }
  const entries: TranscriptEntry[] = [];
  let buffer: string[] = [];
  const append = (role: "agent" | "tool", text: string) => {
    const id = entries.length === 0 ? base : `${base}#${entries.length}`;
    const entry = makeEntry(id, role, text, createdAt);
    if (entry) entries.push(entry);
  };
  const flush = () => {
    const text = buffer.join("\n");
    buffer = [];
    append("agent", text);
  };
  for (const block of arrayValue(content) ?? []) {
    if (!isRecord(block)) continue;
    switch (stringValue(block["type"])) {
      case "text": {
        const text = stringValue(block["text"]);
        if (text !== undefined) buffer.push(text);
        break;
      }
      case "toolCall":
      case "tool_use":
        flush();
        append("tool", openClawToolSummary(block));
        break;
      default:
        // thinking 不进对话；assistant 里的图多是工具截图，本期也不收。
        break;
    }
  }
  flush();
  return entries;
}

function makeEntry(
  id: string,
  role: "user" | "agent" | "tool",
  text: string | null | undefined,
  createdAt: string,
  images: ImageSource[] = [],
): TranscriptEntry | undefined {
  // Gateway 这一步已经只取了窗口；Agent 回复直接用未截断原文认路径候选。
  return transcriptEntry({ id, role, text, images, createdAt, rawText: text }) ?? undefined;
}

/** 消息正文：字符串原样；块数组只取 text 块拼起来；`{content: …}` 往里取一层。 */
export function openClawTranscriptText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  const blocks = arrayValue(value);
  if (blocks) {
    const texts: string[] = [];
    for (const block of blocks) {
      if (typeof block === "string") texts.push(block);
      else if (isRecord(block) && stringValue(block["type"]) === "text") {
        const text = stringValue(block["text"]);
        if (text !== undefined) texts.push(text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  if (isRecord(value)) {
    if ("content" in value) return openClawTranscriptText(value["content"]);
    return stringValue(value["text"]);
  }
  return undefined;
}

/** user 消息里的图片块 `{type:"image", data:<base64>, mimeType}`；解不出或不是 image/* 的跳过。 */
export function openClawTranscriptImages(value: unknown): ImageSource[] {
  const images: ImageSource[] = [];
  for (const block of arrayValue(value) ?? []) {
    if (!isRecord(block) || stringValue(block["type"]) !== "image") continue;
    const data = stringValue(block["data"]);
    const mimeType = stringValue(block["mimeType"]);
    if (data === undefined || mimeType === undefined) continue;
    const image = imageFromBase64(data, mimeType);
    if (image) images.push(image);
  }
  return images;
}

/** 工具调用的一行摘要。shell 类工具把命令本身亮出来，其余只报工具名。 */
export function openClawToolSummary(block: Record<string, unknown>): string {
  const name = stringValue(block["name"]) ?? "工具";
  let args: unknown = block["arguments"] ?? block["input"];
  // 有的提供方把参数存成 JSON 字符串。
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // 保持原样。
    }
  }
  const argsRecord = isRecord(args) ? args : undefined;
  const command =
    stringValue(argsRecord?.["command"]) ?? stringValue(argsRecord?.["cmd"]);
  if (command !== undefined && command.trim().length > 0) return `$ ${command.trim()}`;
  const path = firstNonEmpty(
    stringValue(argsRecord?.["path"]),
    stringValue(argsRecord?.["file_path"]),
    stringValue(argsRecord?.["filePath"]),
  );
  if (path !== undefined) return `调用 ${name}：${lastComponent(path)}`;
  return `调用 ${name}`;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function lastComponent(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** 兼容旧导出：路径识别已统一到 `ported/transcript-file-refs`（上游同一条规则）。 */
export { candidatesIn as pathCandidates } from "../ported/transcript-file-refs.js";

