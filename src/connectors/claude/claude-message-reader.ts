// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeMessageReader.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  ConnectorError,
  imageFromBase64,
  latestWindow,
  nativeTaskId,
  transcriptEntry,
  type ConnectorKind,
  type ImageSource,
  type MessageReader,
  type TranscriptEntry,
} from "../ported/contract.js";
import { claudePaths, type ClaudePaths } from "./claude-hooks.js";
import {
  isFiller,
  lastPathComponent,
  parseISODate,
  protocolTimestamp,
  recordValue,
} from "./claude-shared.js";

/**
 * 从 `~/.claude/projects/<目录>/<sessionId>.jsonl` 读。
 *
 * **靠文件名找**：transcript 的文件名就是 session id，所以不必记住 hook 负载里的
 * `transcript_path`——Agent 重启之后那份内存状态就没了，但文件还在。
 */
export class ClaudeMessageReader implements MessageReader {
  readonly kind: ConnectorKind = "claude";
  private readonly paths: () => ClaudePaths;

  constructor(paths: ClaudePaths | (() => ClaudePaths) = () => claudePaths()) {
    this.paths = typeof paths === "function" ? paths : () => paths;
  }

  async entries(taskId: string, limit: number): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const sessionID = nativeTaskId(taskId, "claude");
    const url = transcriptURL(sessionID, this.paths().projectsDirectory);
    if (!url) throw new ConnectorError("没找到这个会话的记录文件");
    let data: string;
    try {
      data = readFileSync(url, "utf8");
    } catch {
      throw new ConnectorError("读不到会话记录文件");
    }
    const lines = data.split("\n").filter((line) => line.length > 0);
    // 整份解析再截尾：JSONL 没有索引。路径候选只给窗口里的回复认。
    const ordinals = new Map<string, number>();
    const all: TranscriptEntry[] = [];
    lines.forEach((line, ordinal) => {
      const parsed = entriesFromLine(line, ordinal, false);
      for (const entry of parsed) {
        if (entry.message.role === "agent") ordinals.set(entry.message.id, ordinal);
      }
      all.push(...parsed);
    });
    const window = latestWindow(all, limit);
    const entries = window.entries.map((entry) => {
      const ordinal = ordinals.get(entry.message.id);
      if (ordinal === undefined) return entry;
      return entriesFromLine(lines[ordinal], ordinal, true).find(
        (candidate) => candidate.message.id === entry.message.id,
      ) ?? entry;
    });
    return { entries, hasMore: window.hasMore };
  }
}

export type ClaudeMessageReaderOptions = {
  paths?: ClaudePaths | (() => ClaudePaths);
};

export function createClaudeMessageReader(
  options: ClaudeMessageReaderOptions = {},
): ClaudeMessageReader {
  return new ClaudeMessageReader(options.paths ?? (() => claudePaths()));
}

/**
 * 在 `~/.claude/projects` 下逐个目录找 `<sessionId>.jsonl`。目录名是把项目路径
 * 里的 `/` 换成 `-` 得到的，反解不回来，所以只能扫。
 */
export function transcriptURL(sessionID: string, projectsDirectory: string): string | null {
  let directories: string[];
  try {
    directories = readdirSync(projectsDirectory);
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = join(projectsDirectory, directory, `${sessionID}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 与 Agent SDK delete_session 相同：只移除该会话的顶层 transcript。
 * 拒绝目录/文件软链接越界与非 UUID 的路径注入。
 */
export function deleteTranscript(sessionID: string, projectsDirectory: string): void {
  if (!UUID_PATTERN.test(sessionID)) throw new ConnectorError("会话 id 不合法");
  if (existsSync(projectsDirectory) && !statSync(projectsDirectory).isDirectory()) {
    throw new ConnectorError("会话记录目录不可用，不能删除");
  }
  let directories: string[];
  try {
    directories = readdirSync(projectsDirectory);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const directory of directories) {
    const directoryURL = join(projectsDirectory, directory);
    let isDirectory = false;
    try {
      isDirectory = statSync(directoryURL).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    const candidate = join(directoryURL, `${sessionID}.jsonl`);
    try {
      lstatSync(candidate);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    removeTranscript(candidate, sessionID, projectsDirectory);
    return;
  }
}

function removeTranscript(url: string, sessionID: string, projectsDirectory: string): void {
  const values = lstatSync(url);
  if (!values.isFile() || values.isSymbolicLink()) {
    throw new ConnectorError("会话记录路径不安全，不能删除");
  }
  const root = realPath(projectsDirectory);
  const resolved = realPath(url);
  if (!root || !resolved) throw new ConnectorError("会话记录路径不安全，不能删除");
  const relativePath = relative(root, resolved);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new ConnectorError("会话记录路径不安全，不能删除");
  }
  const parts = relativePath.split(/[\\/]/).filter((part) => part.length > 0);
  if (parts.length !== 2 || !samePath(parts[1], `${sessionID}.jsonl`)) {
    throw new ConnectorError("会话记录路径不安全，不能删除");
  }
  unlinkSync(url);
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

/** Claude Code 自己注入、被记成 user 行的整块。用户没说过这些话。 */
export const injectedTags = ["system-reminder", "task-notification"];

/**
 * transcript 的一行 → 0…n 条：正文（文字、过程说明与用户的图）一条，
 * 每个 `tool_use` 各一行 `.tool` 摘要；思考、tool_result 与元数据行直接丢掉。
 */
export function entriesFromLine(line: string, ordinal: number, extractPaths = true): TranscriptEntry[] {
  let object: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    object = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = typeof object.type === "string" ? object.type : object.role;
  if (type !== "user" && type !== "assistant") return [];
  if (object.isSidechain === true || isFiller(object)) return [];
  const message = recordValue(object.message);
  const content = message.content ?? object.content;
  const parts = contentParts(content, type === "user");
  // uuid 优先：同一条消息重复拉取时 id 必须稳定。
  const id = typeof object.uuid === "string" ? object.uuid : `line-${ordinal}`;
  const timestamp = protocolTimestamp(parseISODate(object.timestamp) ?? new Date(0));
  const result: TranscriptEntry[] = [];
  const entry = transcriptEntry({
    id,
    role: type === "user" ? "user" : "agent",
    text: parts.text,
    images: parts.images,
    createdAt: timestamp,
    // 整份解析再截尾：先不认路径；窗口里的回复由调用方用 extractPaths = true 重新解析。
    rawText: extractPaths && type === "assistant" ? (parts.text ?? "") : undefined,
  });
  if (entry) result.push(entry);
  parts.tools.forEach((summary, index) => {
    const tool = transcriptEntry({
      id: `${id}#${index + 1}`,
      role: "tool",
      text: summary,
      createdAt: timestamp,
    });
    if (tool) result.push(tool);
  });
  return result;
}

/**
 * 一次遍历内容块，同时取文字、图片与工具调用摘要。图片只看顶层的内嵌 base64；
 * `tool_result` 里嵌的图跟着 tool_result 一起跳过。
 */
export function contentParts(
  content: unknown,
  includeImages: boolean,
): { text: string | null; images: ImageSource[]; tools: string[] } {
  if (typeof content === "string") return { text: stripInjectedBlocks(content), images: [], tools: [] };
  if (!Array.isArray(content)) return { text: null, images: [], tools: [] };
  const texts: string[] = [];
  const images: ImageSource[] = [];
  const tools: string[] = [];
  for (const rawBlock of content) {
    const block = recordValue(rawBlock);
    switch (block.type) {
      case "text": {
        if (typeof block.text === "string") {
          const stripped = stripInjectedBlocks(block.text).trim();
          if (stripped.length > 0) texts.push(stripped);
        }
        break;
      }
      case "thinking": {
        const text = narrationText(block);
        if (text !== null) texts.push(text);
        break;
      }
      case "tool_use": {
        if (typeof block.name === "string") {
          const input =
            block.input !== null && typeof block.input === "object" && !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : undefined;
          tools.push(toolSummary(block.name, input));
        }
        break;
      }
      case "image": {
        if (!includeImages) break;
        const source = recordValue(block.source);
        if (
          source.type === "base64" &&
          typeof source.data === "string" &&
          typeof source.media_type === "string"
        ) {
          const image = imageFromBase64(source.data, source.media_type);
          if (image) images.push(image);
        }
        break;
      }
      default:
        break;
    }
  }
  return { text: texts.join("\n"), images, tools };
}

/** 工具调用的一行摘要。 */
export function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const value = (key: string): string | null => {
    const raw = input?.[key];
    if (typeof raw !== "string") return null;
    const line = singleLine(raw);
    return line.length === 0 ? null : line;
  };
  const command = value("command");
  if (command) return `$ ${command}`;
  const path = value("file_path") ?? value("notebook_path") ?? value("path");
  if (path) return `调用 ${name}：${lastPathComponent(path)}`;
  for (const key of ["pattern", "query", "url", "description", "prompt"]) {
    const detail = value(key);
    if (detail) return `调用 ${name}：${detail}`;
  }
  return `调用 ${name}`;
}

function singleLine(text: string): string {
  return text.split(/\s+/).filter((part) => part.length > 0).join(" ");
}

/**
 * 过程说明块的正文；普通思考、没有文字的块是 null。
 *
 * 桌面 app 在工具调用之间给用户看的那几句话是带 `narration` 签名的 thinking 块。
 */
export function narrationText(block: Record<string, unknown>): string | null {
  if (block.type !== "thinking") return null;
  const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
  if (text.length === 0) return null;
  if (typeof block.signature !== "string") return null;
  return signatureBlockKind(block.signature) === "narration" ? text : null;
}

/**
 * thinking 签名里的块类型：base64 解出 protobuf，取字段 2 → 字段 1 → 字段 8
 * 的字符串。任一层解不开都是 null。
 */
export function signatureBlockKind(signature: string): string | null {
  const padding = (4 - (signature.length % 4)) % 4;
  const padded = signature + "=".repeat(padding);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) return null;
  let data: Buffer;
  try {
    data = Buffer.from(padded, "base64");
  } catch {
    return null;
  }
  const envelope = protobufBytes(2, data);
  if (!envelope) return null;
  const header = protobufBytes(1, envelope);
  if (!header) return null;
  const kind = protobufBytes(8, header);
  if (!kind) return null;
  return kind.toString("utf8");
}

/**
 * 只够读 thinking 签名的 protobuf：按字段号取长度前缀的字节
 * （同号多次出现取最后一次）。必须整段都能解开，否则 null。
 */
function protobufBytes(field: number, buffer: Buffer): Buffer | null {
  let index = 0;
  let found: Buffer | null = null;
  while (index < buffer.length) {
    const key = readVarint(buffer, () => index);
    if (key === null) return null;
    index = key.index;
    switch (Number(key.value) & 7) {
      case 0: {
        const skipped = readVarint(buffer, () => index);
        if (skipped === null) return null;
        index = skipped.index;
        break;
      }
      case 1:
        index += 8;
        break;
      case 5:
        index += 4;
        break;
      case 2: {
        const length = readVarint(buffer, () => index);
        if (length === null) return null;
        index = length.index;
        if (length.value > BigInt(buffer.length - index)) return null;
        const end = index + Number(length.value);
        if (Math.floor(Number(key.value) / 8) === field) found = buffer.subarray(index, end);
        index = end;
        break;
      }
      default:
        return null;
    }
  }
  return index === buffer.length ? found : null;
}

function readVarint(buffer: Buffer, indexOf: () => number): { value: bigint; index: number } | null {
  let index = indexOf();
  let value = 0n;
  let shift = 0n;
  while (index < buffer.length && shift < 64n) {
    const byte = buffer[index];
    index += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, index };
    shift += 7n;
  }
  return null;
}

/**
 * 去掉 `<system-reminder>…</system-reminder>` 这类注入块。
 * 开标签没有对应的闭标签时删到末尾——注入块总是贴在正文后面。
 */
export function stripInjectedBlocks(text: string): string {
  let result = text;
  for (const tag of injectedTags) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    while (true) {
      const start = result.indexOf(open);
      if (start < 0) break;
      const end = result.indexOf(close, start + open.length);
      result = result.slice(0, start) + (end < 0 ? "" : result.slice(end + close.length));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 路径候选（统一走 Kit TranscriptFileRefs 的只读移植）
// ---------------------------------------------------------------------------

/**
 * 兼容旧导出：识别逻辑已统一到 `ported/transcript-file-refs.ts`
 * （上游 `TranscriptFileRefs.candidates(in:)`）。
 */
export { candidatesIn as pathCandidates } from "../ported/transcript-file-refs.js";

/** 供 `sep` 的显式引用（Windows 路径比较在上面；保留导入避免平台分支被摇掉）。 */
export const pathSeparator = sep;
