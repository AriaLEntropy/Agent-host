import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { DshPaths } from "./paths.js";
import { projectionCacheFile } from "./paths.js";
import type { DshSessionEvent, DshWebSessionSummary } from "./web.js";
import { eventFromJson, eventSourceKind, eventText, eventTitle } from "./web.js";

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN_TURN_WINDOW_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export type DshScannedSession = {
  summary: DshWebSessionSummary;
  events: DshSessionEvent[];
};

/**
 * 扫 `~/.dsh/sessions/<project>/<session>/`，只读。
 * web 不在时用它列会话和读历史；直接解第一帧判断 subagent。
 */
export async function scanDshSessions(paths: DshPaths, now = Date.now()): Promise<DshScannedSession[]> {
  const found: Array<{ sessionId: string; directory: string; logFile: string; modified: number }> = [];
  for (const project of await directories(paths.sessionsDirectory)) {
    for (const session of await directories(project)) {
      const logFile = await sessionLogFile(session);
      if (!logFile) continue;
      const info = await stat(logFile).catch(() => undefined);
      if (!info || now - info.mtimeMs > RECENT_WINDOW_MS) continue;
      const sessionId = decodeSegment(basename(session));
      if (!sessionId) continue;
      found.push({ sessionId, directory: session, logFile, modified: info.mtimeMs });
    }
  }
  found.sort((left, right) => right.modified - left.modified);

  const result: DshScannedSession[] = [];
  for (const entry of found.slice(0, MAX_SESSIONS)) {
    const decoded = await decodeLog(entry.logFile).catch(() => undefined);
    if (!decoded) continue;
    const header = decoded.header;
    if (header.origin === "subagent" || (header.delegationDepth ?? 0) > 0) continue;
    const cache = await readProjectionCache(projectionCacheFile(paths, entry.sessionId));
    const cwd = cache?.cwd || header.cwd;
    if (!cwd) continue;
    const events = decoded.events;
    const title = cache?.title || firstTitle(events);
    const hasUser = events.some((event) => event.type === "user/message" && eventSourceKind(event) === "user");
    const blank = cache?.blank ?? (!title && !hasUser && !events.some((event) => event.type === "turn/start"));
    if (blank) continue;
    const summary: DshWebSessionSummary = {
      sessionId: entry.sessionId,
      updatedAt: new Date(entry.modified),
      running: lastTurnOpen(events) && now - entry.modified <= OPEN_TURN_WINDOW_MS,
      blank: false,
      cwd,
      origin: header.origin,
      title,
      asOfSeq: events.at(-1)?.seq,
    };
    result.push({ summary, events });
  }
  return result;
}

export async function readScannedSession(paths: DshPaths, sessionId: string): Promise<DshScannedSession | null> {
  for (const project of await directories(paths.sessionsDirectory)) {
    for (const session of await directories(project)) {
      if (decodeSegment(basename(session)) !== sessionId) continue;
      const logFile = await sessionLogFile(session);
      if (!logFile) continue;
      const decoded = await decodeLog(logFile).catch(() => undefined);
      if (!decoded) return null;
      const cache = await readProjectionCache(projectionCacheFile(paths, sessionId));
      const info = await stat(logFile).catch(() => undefined);
      return {
        summary: {
          sessionId,
          updatedAt: info ? new Date(info.mtimeMs) : undefined,
          running: lastTurnOpen(decoded.events),
          blank: false,
          cwd: cache?.cwd || decoded.header.cwd,
          origin: decoded.header.origin,
          title: cache?.title || firstTitle(decoded.events),
          asOfSeq: decoded.events.at(-1)?.seq,
        },
        events: decoded.events,
      };
    }
  }
  return null;
}

type DecodedLog = {
  header: {
    id: string;
    cwd?: string;
    origin?: string;
    delegationDepth?: number;
    createdAt?: number;
  };
  events: DshSessionEvent[];
};

export async function decodeLog(file: string): Promise<DecodedLog | null> {
  const raw = await readFile(file);
  const text = file.endsWith(".zstd") ? decodeZstdFrames(raw).toString("utf8") : raw.toString("utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  const headerJson = parse(lines[0]);
  if (record(headerJson).type !== "session" || typeof record(headerJson).id !== "string") return null;
  const events = lines
    .slice(1)
    .flatMap((line) => {
      const event = eventFromJson(parse(line));
      return event ? [event] : [];
    })
    .sort((left, right) => left.seq - right.seq);
  return {
    header: {
      id: String(record(headerJson).id),
      cwd: string(record(headerJson).cwd),
      origin: string(record(headerJson).origin),
      delegationDepth: number(record(headerJson).delegationDepth),
      createdAt: number(record(headerJson).createdAt),
    },
    events,
  };
}

/**
 * dsh 的会话文件是多个 zstd 帧首尾拼接；Node 的 zstdDecompressSync 只解第一帧。
 * 按 RFC 8878 的帧头/块头切出每帧，再逐帧解。照 DshTranscriptDecoder 的脚本。
 */
export function decodeZstdFrames(buf: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (const [start, end] of zstdFrames(buf)) {
    parts.push(zstdDecompressSync(buf.subarray(start, end)));
  }
  const all = Buffer.concat(parts);
  return all.length > MAX_TAIL_BYTES ? all.subarray(all.length - MAX_TAIL_BYTES) : all;
}

export function zstdFrames(buf: Buffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const magic = buf.readUInt32LE(p);
    if (((magic & 0xfffffff0) >>> 0) === 0x184d2a50) {
      if (p + 8 > buf.length) break;
      p += 8 + buf.readUInt32LE(p + 4);
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error("bad zstd magic");
    const start = p;
    if (p + 5 > buf.length) break;
    const fhd = buf[p + 4];
    p += 5;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p += 1;
    p += [0, 1, 2, 4][dictFlag];
    p += [single ? 1 : 0, 2, 4, 8][fcsFlag];
    let complete = false;
    while (p + 3 <= buf.length) {
      const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
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
    if (!complete || p > buf.length) break;
    out.push([start, p]);
  }
  return out;
}

async function sessionLogFile(directory: string): Promise<string | null> {
  const names = await readdir(directory).catch(() => [] as string[]);
  let best: { version: number; compressed: boolean; name: string } | undefined;
  for (const name of names) {
    const compressed = name.endsWith(".jsonl.zstd");
    const base = compressed ? name.slice(0, -".zstd".length) : name;
    if (!base.startsWith("session.") || !base.endsWith(".jsonl")) continue;
    let version = 0;
    if (base !== "session.jsonl") {
      const middle = base.slice("session.".length, -".jsonl".length);
      if (!middle.startsWith("v") || !/^\d+$/.test(middle.slice(1))) continue;
      version = Number(middle.slice(1));
    }
    if (!best || version > best.version || (version === best.version && compressed && !best.compressed)) {
      best = { version, compressed, name };
    }
  }
  return best ? join(directory, best.name) : null;
}

async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
}

async function readProjectionCache(file: string) {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const json = parse(raw);
  const rows = record(record(json).rows);
  return {
    cwd: string(record(record(json).record.identity).cwd),
    title: string(record(rows.title).val),
    blank: boolean(record(record(rows.sessionListMetadata).val).blank),
    openTurnStartSeq: number(record(record(rows.turnBoundary).val).openTurnStartSeq),
    lastTurn: number(record(record(rows.turnBoundary).val).lastTurn),
  };
}

function firstTitle(events: DshSessionEvent[]): string | undefined {
  for (const event of events) {
    const title = eventTitle(event)?.trim();
    if (title) return title;
  }
  for (const event of events) {
    if (event.type !== "user/message" || eventSourceKind(event) !== "user") continue;
    const text = eventText(event)?.trim();
    if (text) return text.slice(0, 80);
  }
  return undefined;
}

function lastTurnOpen(events: DshSessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn/end") return false;
    if (events[index]?.type === "turn/start") return true;
  }
  return false;
}

/** dsh 的 `encodeSegment` 反过来：`~XXXX`（4 位十六进制 UTF-16 码元）还原。 */
export function decodeSegment(segment: string): string {
  if (!segment.includes("~")) return segment;
  let out = "";
  for (let index = 0; index < segment.length; ) {
    if (segment[index] === "~" && index + 4 < segment.length) {
      const code = Number.parseInt(segment.slice(index + 1, index + 5), 16);
      if (Number.isFinite(code)) {
        out += String.fromCharCode(code);
        index += 5;
        continue;
      }
    }
    out += segment[index];
    index += 1;
  }
  return out;
}

function basename(path: string) {
  return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
