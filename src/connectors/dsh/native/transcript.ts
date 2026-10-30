// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshTranscript.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// 上游在 macOS 上借 dsh 的 node 跑内嵌脚本逐帧解 zstd；Node 自己就有
// `zlib.zstdDecompressSync`，这里在进程内按同样的帧格式切开再逐帧解（`// PORT:`）。
// 只读，不落盘、不进日志。

import { open, readFile, readdir } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { ConnectorError, latestWindow, transcriptEntry, type TranscriptEntry } from "../../ported/contract.js";
import {
  eventSourceKind,
  eventText,
  eventTurnEndReason,
  isReplacement,
  sessionEventFromJson,
  sessionHeaderFromJson,
  type DshSessionEvent,
  type DshSessionHeader,
  type DshTurnEndReason,
} from "./web-messages.js";

/** 一份 dsh 会话日志读出来的样子。 */
export type DshSessionLog = {
  header?: DshSessionHeader;
  events: DshSessionEvent[];
  /** 只读了尾部（更早的事件没读）。 */
  truncated: boolean;
};

/** 会话目录里的日志文件：版本号最高的那份是当前代；同一代两种都在时要压缩的。 */
export const DshSessionFiles = {
  async logFile(inDirectory: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(inDirectory);
    } catch {
      return undefined;
    }
    let best: { version: number; compressed: boolean; name: string } | undefined;
    for (const name of names) {
      const compressed = name.endsWith(".jsonl.zstd");
      const base = compressed ? name.slice(0, -".zstd".length) : name;
      if (!base.startsWith("session.") || !base.endsWith(".jsonl")) continue;
      let version = 0;
      if (base !== "session.jsonl") {
        const middle = base.slice("session.".length, -".jsonl".length);
        if (!middle.startsWith("v")) continue;
        const parsed = Number(middle.slice(1));
        if (!Number.isInteger(parsed) || parsed <= 0) continue;
        version = parsed;
      }
      if (
        !best ||
        version > best.version ||
        (version === best.version && compressed && !best.compressed)
      ) {
        best = { version, compressed, name };
      }
    }
    if (!best) return undefined;
    return joinPath(inDirectory, best.name);
  },

  /** `.zstd` 结尾的要解压。 */
  isCompressed(file: string): boolean {
    return file.toLowerCase().endsWith(".zstd");
  },
};

export type DshTranscriptDecoderOptions = {
  /**
   * 上游这里放"够新的 node"；TS 在进程内解压，节点只用于诊断/兼容调用方。
   * 为 `null` 且运行时没有 zstd 时压缩日志读不了。
   */
  node?: string | null;
  /** 测试注入的 zstd 解压（默认 `zlib.zstdDecompressSync`）。 */
  zstd?: (frame: Buffer) => Buffer;
};

export class DshTranscriptDecoder {
  static readonly timeout = 10_000;
  static readonly defaultTailBytes = 4 * 1024 * 1024;

  readonly node: string | null;
  private readonly zstd: ((frame: Buffer) => Buffer) | undefined;

  constructor(options: DshTranscriptDecoderOptions = {}) {
    this.node = options.node ?? process.execPath;
    this.zstd = options.zstd ?? (typeof zstdDecompressSync === "function" ? zstdDecompressSync : undefined);
  }

  /** 读一份日志的头与尾部事件。 */
  async read(file: string, tailBytes: number = DshTranscriptDecoder.defaultTailBytes): Promise<DshSessionLog> {
    if (!DshSessionFiles.isCompressed(file)) return readPlain(file, tailBytes);
    if (!this.zstd) {
      throw new ConnectorError("没找到能解 DeepSeek Harness 会话记录的 node（需要 22.15 以上）");
    }
    const buffer = await readFile(file);
    return this.decodeCompressed(buffer, Math.max(0, tailBytes));
  }

  /** 只读若干份日志的头行（判断 subagent、补 cwd 用）。解不开的文件不在结果里。 */
  async headers(files: readonly string[]): Promise<Map<string, DshSessionHeader>> {
    const result = new Map<string, DshSessionHeader>();
    for (const file of files) {
      try {
        if (!DshSessionFiles.isCompressed(file)) {
          const header = (await readPlain(file, 0)).header;
          if (header) result.set(file, header);
          continue;
        }
        if (!this.zstd) continue;
        const buffer = await readFile(file);
        const frames = zstdFrames(buffer);
        if (frames.length === 0) continue;
        const first = this.zstd(buffer.subarray(frames[0][0], frames[0][1]));
        const header = sessionHeaderFromJson(parseJson(firstLine(first)));
        if (header) result.set(file, header);
      } catch {
        // 解不开的文件不在结果里。
      }
    }
    return result;
  }

  /** 内嵌脚本的输出形状：第一行 `{"truncated":bool}`，第二行头行，之后是事件行。 */
  decodeCompressed(buffer: Buffer, tailBytes: number): DshSessionLog {
    const zstd = this.zstd;
    if (!zstd) throw new ConnectorError("解不开 DeepSeek Harness 的会话记录");
    const frames = zstdFrames(buffer);
    if (frames.length === 0) return { header: undefined, events: [], truncated: false };
    const decode = (index: number) => zstd(buffer.subarray(frames[index][0], frames[index][1]));
    const first = decode(0);
    const header = sessionHeaderFromJson(parseJson(firstLine(first)));
    const parts: Buffer[] = [];
    let size = 0;
    let index = frames.length;
    while (index > 0 && (tailBytes === 0 || size < tailBytes)) {
      index -= 1;
      const part = index === 0 ? first : decode(index);
      parts.unshift(part);
      size += part.length;
    }
    let body = Buffer.concat(parts);
    if (index > 0) {
      // 从第 index 帧开始：前一帧不是以换行结尾的话，第 index 帧开头是半行，丢到第一个换行为止。
      const previous = decode(index - 1);
      if (previous.length > 0 && previous[previous.length - 1] !== 10) {
        const newline = body.indexOf(10);
        body = newline < 0 ? Buffer.alloc(0) : body.subarray(newline + 1);
      }
    }
    return {
      header,
      events: parseEvents(splitLines(body)),
      truncated: index > 0,
    };
  }

  /** 与上游 `parseDecoderOutput` 等价：注入的 runner 输出可以直接走这里。 */
  static parseDecoderOutput(data: Buffer): DshSessionLog {
    const lines = splitLinesKeepEmpty(data);
    const meta = parseJson((lines.shift() ?? Buffer.alloc(0)).toString("utf8"));
    const truncated = typeof (meta as Record<string, unknown> | undefined)?.truncated === "boolean"
      ? ((meta as Record<string, unknown>).truncated as boolean)
      : undefined;
    if (truncated === undefined) throw new ConnectorError("解不开 DeepSeek Harness 的会话记录");
    const headerLine = lines.shift() ?? Buffer.alloc(0);
    const header = sessionHeaderFromJson(parseJson(headerLine.toString("utf8")));
    return { header, events: parseEvents(lines.filter((line) => line.length > 0)), truncated };
  }
}

/** 不压缩的日志：头 64 KB 找头行，尾部 `tailBytes`（从某行中间开始时丢掉那半行）。 */
export async function readPlain(file: string, tailBytes: number): Promise<DshSessionLog> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    throw new ConnectorError("读不到会话记录文件");
  }
  try {
    const info = await handle.stat();
    const size = info.size;
    const headLength = Math.min(size, 64 * 1024);
    const head = Buffer.alloc(headLength);
    if (headLength > 0) await handle.read(head, 0, headLength, 0);
    const headerLine = firstLine(head);
    const header = sessionHeaderFromJson(parseJson(headerLine));
    if (tailBytes <= 0) return { header, events: [], truncated: size > 0 };
    const start = Math.max(0, size - tailBytes);
    const tail = Buffer.alloc(size - start);
    if (tail.length > 0) await handle.read(tail, 0, tail.length, start);
    let body = tail;
    if (start > 0) {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, start - 1);
      if (previous[0] !== 10) {
        const newline = body.indexOf(10);
        body = newline < 0 ? Buffer.alloc(0) : body.subarray(newline + 1);
      }
    }
    return { header, events: parseEvents(splitLinesKeepEmpty(body)), truncated: start > 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 按 RFC 8878 切出完整的 zstd 帧（跳过可跳过帧；写到一半的最后一帧丢掉）。 */
export function zstdFrames(buffer: Buffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let p = 0;
  while (p + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(p);
    if (((magic & 0xfffffff0) >>> 0) === 0x184d2a50) {
      if (p + 8 > buffer.length) break;
      p += 8 + buffer.readUInt32LE(p + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error("bad zstd magic");
    const start = p;
    if (p + 5 > buffer.length) break;
    const fhd = buffer[p + 4];
    p += 5;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p += 1;
    p += [0, 1, 2, 4][dictFlag];
    p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    let complete = false;
    while (p + 3 <= buffer.length) {
      const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
      p += 3;
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      p += type === 1 ? 1 : size;
      if (last) {
        complete = true;
        break;
      }
    }
    if (checksum) p += 4;
    if (!complete || p > buffer.length) break;
    out.push([start, p]);
  }
  return out;
}

/** dsh 会话事件 → BotBus 对话记录。JSONL 与 web 的 follow / page 记录走同一套规则。 */
export const DshTranscriptParser = {
  /** 全部条目，升序，**不带路径候选**（窗口里的回复另补）。 */
  entries(events: readonly DshSessionEvent[]): TranscriptEntry[] {
    return events.flatMap((event) => {
      if (isReplacement(event)) return [];
      const createdAt = protocolTimestamp(event.time ?? new Date(0));
      switch (event.type) {
        case "user/message": {
          if (eventSourceKind(event) !== "user") return [];
          const entry = transcriptEntry({
            id: messageId(event),
            role: "user",
            text: eventText(event),
            createdAt,
          });
          return entry ? [entry] : [];
        }
        case "assistant/message": {
          const entry = transcriptEntry({
            id: messageId(event),
            role: "agent",
            text: eventText(event),
            createdAt,
          });
          return entry ? [entry] : [];
        }
        case "tool/call": {
          const callId = callIdOf(event);
          if (!callId) return [];
          const entry = transcriptEntry({
            id: `tool-${callId}`,
            role: "tool",
            text: toolSummary(event.data),
            createdAt,
          });
          return entry ? [entry] : [];
        }
        default:
          return [];
      }
    });
  },

  /** 最近 `limit` 条对话的窗口；窗口里的 Agent 回复补路径候选。 */
  window(
    events: readonly DshSessionEvent[],
    limit: number,
    truncated = false,
  ): { entries: TranscriptEntry[]; hasMore: boolean } {
    const window = latestWindow(DshTranscriptParser.entries(events), limit);
    const wanted = new Set(
      window.entries.filter((entry) => entry.message.role === "agent").map((entry) => entry.message.id),
    );
    const raw = new Map<string, string>();
    for (const event of events) {
      if (event.type !== "assistant/message" || isReplacement(event)) continue;
      const id = messageId(event);
      if (!wanted.has(id)) continue;
      const text = eventText(event);
      if (text !== undefined) raw.set(id, text);
    }
    const entries = window.entries.map((entry) => {
      const text = raw.get(entry.message.id);
      if (entry.message.role !== "agent" || text === undefined) return entry;
      return { ...entry, pathCandidates: pathCandidates(text) };
    });
    return { entries, hasMore: window.hasMore || truncated };
  },

  /** 最后一条 Agent 回复（有字的 `assistant/message`），原文不截断。 */
  lastAgentMessage(events: readonly DshSessionEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type !== "assistant/message" || isReplacement(event)) continue;
      const text = eventText(event)?.trim();
      if (text) return text;
    }
    return undefined;
  },

  /** 最后一次 `turn/end`（原因、时间）。之后又有 `turn/start` 的（这一轮还在跑）返回 undefined。 */
  lastTurnEnd(
    events: readonly DshSessionEvent[],
  ): { reason: DshTurnEndReason; at?: Date } | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "turn/start") return undefined;
      const reason = eventTurnEndReason(event);
      if (reason) return { reason, at: event.time };
    }
    return undefined;
  },

  /** 最后一个 `turn/start` 之后还没有 `turn/end`。 */
  hasOpenTurn(events: readonly DshSessionEvent[]): boolean {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "turn/end") return false;
      if (event.type === "turn/start") return true;
    }
    return false;
  },

  messageId,
  toolSummary,
};

export function messageId(event: DshSessionEvent): string {
  const id = event.type === "assistant/message"
    ? stringAt(event.data, "message", "id")
    : stringAt(event.data, "id");
  return id && id.length > 0 ? id : `seq-${event.seq}`;
}

function callIdOf(event: DshSessionEvent): string | undefined {
  const id = stringAt(event.data, "callId");
  return id && id.length > 0 ? id : undefined;
}

/** 工具名，加上参数里最能说明它在干什么的一个字符串。 */
export function toolSummary(data: unknown): string {
  const name = stringAt(data, "name") ?? "tool";
  const text = stringAt(data, "arguments");
  if (text === undefined) return name;
  let arguments_: unknown;
  try {
    arguments_ = JSON.parse(text);
  } catch {
    return name;
  }
  const command = stringAt(arguments_, "command");
  if (command) return `$ ${singleLine(command)}`;
  for (const key of ["path", "file_path", "url", "query", "pattern", "description"]) {
    const value = stringAt(arguments_, key);
    if (value) return `${name} ${singleLine(value)}`;
  }
  return name;
}

// MARK: - 路径候选（Kit 的 TranscriptFileRefs，只保留"只看文字"的那一半）

const MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "m4v", "pdf"]);
const MAX_CANDIDATE_LENGTH = 1024;
const MAX_CANDIDATES = 32;

const LINK_PATTERN = /\]\(\s*(?:<([^<>\n]+)>|([^\s()<>]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const CODE_PATTERN = /`([^`\n]+)`/g;
const BARE_PATTERN =
  /[^\s"'`<>()[\]{}|,;*“”‘’…　-〿＀-￯\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.\-]*:/;

/** 回复里看起来像媒体文件路径的文本，按出现顺序、去重，最多 32 个。不查磁盘。 */
export function pathCandidates(text: string): string[] {
  if (!text) return [];
  const found: Array<{ at: number; value: string }> = [];
  const claimed: Array<[number, number]> = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    claimed.push([start, start + match[0].length]);
    const value = acceptCandidate(match[1] ?? match[2] ?? "");
    if (value) found.push({ at: start, value });
  }
  for (const match of text.matchAll(CODE_PATTERN)) {
    const start = match.index ?? 0;
    if (overlaps(start, start + match[0].length, claimed)) continue;
    const value = acceptCandidate(match[1] ?? "");
    if (!value) continue;
    found.push({ at: start, value });
    if (!/\s/.test(value)) claimed.push([start, start + match[0].length]);
  }
  for (const match of text.matchAll(BARE_PATTERN)) {
    const start = match.index ?? 0;
    if (overlaps(start, start + match[0].length, claimed)) continue;
    const value = acceptCandidate(trimTrailingPunctuation(match[0]));
    if (value) found.push({ at: start, value });
  }
  found.sort((left, right) => left.at - right.at);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of found) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    result.push(item.value);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

function acceptCandidate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || value.length > MAX_CANDIDATE_LENGTH) return undefined;
  if (/[\r\n]/.test(value)) return undefined;
  if (value.includes("://") || SCHEME_PATTERN.test(value)) return undefined;
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const name = value.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) return undefined;
  return value;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.:!?]+$/, "");
}

function overlaps(start: number, end: number, ranges: ReadonlyArray<[number, number]>): boolean {
  return ranges.some(([from, to]) => Math.max(start, from) < Math.min(end, to));
}

// MARK: - 小工具

export function protocolTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function singleLine(text: string): string {
  return text.split(/\r?\n/).join(" ").trim();
}

function firstLine(buffer: Buffer): string {
  const index = buffer.indexOf(10);
  return (index < 0 ? buffer : buffer.subarray(0, index)).toString("utf8");
}

function splitLines(buffer: Buffer): Buffer[] {
  return splitLinesKeepEmpty(buffer).filter((line) => line.length > 0);
}

function splitLinesKeepEmpty(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue;
    lines.push(buffer.subarray(start, index));
    start = index + 1;
  }
  lines.push(buffer.subarray(start));
  return lines;
}

function parseEvents(lines: readonly Buffer[]): DshSessionEvent[] {
  return lines.flatMap((line) => {
    if (line.length === 0) return [];
    const event = sessionEventFromJson(parseJson(line.toString("utf8")));
    return event ? [event] : [];
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringAt(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function joinPath(directory: string, name: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return directory.endsWith("/") || directory.endsWith("\\") ? directory + name : directory + separator + name;
}
