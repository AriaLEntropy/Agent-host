// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshSessionScanner.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// 扫 `~/.dsh/sessions/<项目>/<会话>/` 与投影缓存 `storages/session_projcache/sessions/<id>.json`（只读）。

import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_HISTORY_WINDOW_MS } from "../../session-window.js";
import { DshSessionFiles } from "./transcript.js";
import {
  boolValue,
  dshDate,
  integerValue,
  isRecord,
  jsonPath,
  nonEmptyString,
  stringValue,
  type DshSessionHeader,
} from "./web-messages.js";

/** 扫盘得到的一个 dsh 会话（web 不在时用）。只有元数据，不含对话内容（标题除外）。 */
export type DshSessionSummary = {
  sessionId: string;
  cwd: string;
  /** 投影缓存里的标题。 */
  title?: string;
  createdAt?: Date;
  /** 会话日志文件的修改时间：最后一次有事件落盘。 */
  updatedAt: Date;
  /** 最后一次人发提示词的时间（web 写的缓存才有）。 */
  lastPromptAt?: Date;
  /** 缓存说有一轮开了还没收尾。 */
  hasOpenTurn: boolean;
  /** 投影缓存比日志旧（或没有缓存）：标题、`hasOpenTurn` 可能过时。 */
  cacheIsStale: boolean;
  directory: string;
  logFile: string;
};

export type DshScannerOptions = {
  paths: { sessionsDirectory: string; projectionCacheFile(sessionId: string): string };
  now?: () => Date;
  /** 读会话头（判断 subagent、补 cwd）；没有时认不出 subagent，照常列出。 */
  headers?: (files: string[]) => Promise<Map<string, DshSessionHeader>>;
};

/** 扫盘器。缓存按会话与文件修改时间记住，web 不在时每几秒扫一次也不重读。 */
export class DshSessionScanner {
  static readonly maxSessions = 200;

  private readonly paths: DshScannerOptions["paths"];
  private readonly now: () => Date;
  private readonly headers?: DshScannerOptions["headers"];
  /** 会话 id → 头（读不出来的记 undefined，也不再读）。 */
  private readonly headerCache = new Map<string, DshSessionHeader | undefined>();
  /** 会话 id → 投影缓存（及读它时文件的修改时间）。 */
  private readonly cacheMemo = new Map<string, { modified: number | undefined; cache: DshProjectionCache | undefined }>();

  constructor(options: DshScannerOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.headers = options.headers;
  }

  async scan(): Promise<DshSessionSummary[]> {
    const current = this.now();
    const found: Array<{ sessionId: string; directory: string; logFile: string; modified: number }> = [];
    for (const project of await directories(this.paths.sessionsDirectory)) {
      for (const directory of await directories(project)) {
        const logFile = await DshSessionFiles.logFile(directory);
        if (!logFile) continue;
        const info = await safeStat(logFile);
        if (!info) continue;
        if (current.getTime() - info.mtimeMs > SESSION_HISTORY_WINDOW_MS) continue;
        const sessionId = decodeSegment(basename(directory));
        if (!sessionId) continue;
        found.push({ sessionId, directory, logFile, modified: info.mtimeMs });
      }
    }
    found.sort((left, right) => right.modified - left.modified);
    const recent = found.slice(0, DshSessionScanner.maxSessions);
    const keep = new Set(recent.map((entry) => entry.sessionId));
    for (const key of [...this.cacheMemo.keys()]) if (!keep.has(key)) this.cacheMemo.delete(key);

    if (this.headers) {
      const missing = recent.filter((entry) => !this.headerCache.has(entry.sessionId));
      if (missing.length > 0) {
        let read = new Map<string, DshSessionHeader>();
        try {
          read = await this.headers(missing.map((entry) => entry.logFile));
        } catch {
          read = new Map();
        }
        for (const entry of missing) this.headerCache.set(entry.sessionId, read.get(entry.logFile));
      }
    }

    const result: DshSessionSummary[] = [];
    for (const entry of recent) {
      const header = this.headerCache.get(entry.sessionId);
      if (header && isSubagentHeader(header)) continue;
      const cacheFile = this.paths.projectionCacheFile(entry.sessionId);
      const cacheInfo = await safeStat(cacheFile);
      const cacheModified = cacheInfo?.mtimeMs;
      const cache = this.projectionCache(entry.sessionId, cacheFile, cacheModified);
      const stale = cache === undefined || (cacheModified === undefined ? true : cacheModified < entry.modified);
      const blank = cache
        ? cache.listBlank !== undefined
          ? cache.listBlank
          : !stale && cache.looksBlank
        : false;
      if (cache && blank) continue;
      const cwd = cache?.cwd ?? header?.cwd;
      if (!cwd) continue;
      result.push({
        sessionId: entry.sessionId,
        cwd,
        title: cache?.title,
        createdAt: cache?.createdAt ?? header?.createdAt,
        updatedAt: new Date(entry.modified),
        lastPromptAt: cache?.lastPromptAt,
        hasOpenTurn: cache?.openTurnStartSeq !== undefined,
        cacheIsStale: stale,
        directory: entry.directory,
        logFile: entry.logFile,
      });
    }
    return result;
  }

  private projectionCache(
    sessionId: string,
    file: string,
    modified: number | undefined,
  ): DshProjectionCache | undefined {
    const memo = this.cacheMemo.get(sessionId);
    if (memo && memo.modified === modified) return memo.cache;
    const cache = modified === undefined ? undefined : DshProjectionCache.readSync(file);
    this.cacheMemo.set(sessionId, { modified, cache });
    return cache;
  }

  /** 已缓存的会话头（测试与 DshConnector 读 subagent 判定用）。 */
  cachedHeader(sessionId: string): DshSessionHeader | undefined {
    return this.headerCache.get(sessionId);
  }

  /**
   * 磁盘上还在的会话 id（有日志文件的会话目录，不看时间窗口）。
   * 会话根目录或某个项目目录读不了返回 undefined：不知道不等于删了。
   */
  static async sessionIdsOnDisk(sessionsDirectory: string): Promise<Set<string> | undefined> {
    let projects: string[];
    try {
      projects = await directoriesOrThrow(sessionsDirectory);
    } catch {
      return undefined;
    }
    const ids = new Set<string>();
    for (const project of projects) {
      let sessions: string[];
      try {
        sessions = await directoriesOrThrow(project);
      } catch {
        return undefined;
      }
      for (const directory of sessions) {
        if (!(await DshSessionFiles.logFile(directory))) continue;
        const sessionId = decodeSegment(basename(directory));
        if (sessionId) ids.add(sessionId);
      }
    }
    return ids;
  }
}

export function isSubagentHeader(header: DshSessionHeader): boolean {
  return header.origin === "subagent" || header.delegationDepth > 0;
}

/** dsh 的 `encodeSegment` 反过来：`~XXXX`（4 位十六进制的 UTF-16 码元）还原。认不出的 `~` 原样留。 */
export function decodeSegment(segment: string): string {
  if (!segment.includes("~")) return segment;
  const units: number[] = [];
  let index = 0;
  // 按 UTF-16 码元走（与 Swift 的 `Array(segment.utf16)` 一致）。
  while (index < segment.length) {
    if (segment[index] === "~" && index + 4 < segment.length) {
      const hex = segment.slice(index + 1, index + 5);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        units.push(Number.parseInt(hex, 16));
        index += 5;
        continue;
      }
    }
    units.push(segment.charCodeAt(index));
    index += 1;
  }
  return String.fromCharCode(...units);
}

/**
 * 投影缓存 `storages/session_projcache/sessions/<id>.json` 里 BotBus 用到的几行。
 * 形状：`{version, record:{identity:{createdAt, cwd, …}, rows:{<key>:{ver, seq, val}}}}`。
 */
export class DshProjectionCache {
  cwd?: string;
  createdAt?: Date;
  title?: string;
  openTurnStartSeq?: number;
  lastTurn?: number;
  /** `sessionListMetadata`：web 进程写的缓存才有。 */
  listBlank?: boolean;
  lastPromptAt?: Date;

  static readSync(file: string): DshProjectionCache | undefined {
    let text: string;
    try {
      // 与上游 Data(contentsOf:) 等价；同步读取以保持 scan() 里 cacheMemo 的简单语义。
      text = readFileSyncCompat(file);
    } catch {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return undefined;
    }
    return DshProjectionCache.fromJson(json);
  }

  static fromJson(json: unknown): DshProjectionCache | undefined {
    const root = isRecord(json) ? json : undefined;
    const recordValue = root?.record;
    if (!isRecord(recordValue)) return undefined;
    const rows = recordValue.rows;
    const cache = new DshProjectionCache();
    const cwd = stringValue(jsonPath(recordValue, "identity", "cwd"));
    cache.cwd = nonEmptyString(cwd);
    cache.createdAt = dshDate(jsonPath(recordValue, "identity", "createdAt"));
    const title = stringValue(jsonPath(rows, "title", "val"));
    cache.title = nonEmptyString(title);
    cache.openTurnStartSeq = integerValue(jsonPath(rows, "turnBoundary", "val", "openTurnStartSeq"));
    cache.lastTurn = integerValue(jsonPath(rows, "turnBoundary", "val", "lastTurn"));
    cache.listBlank = boolValue(jsonPath(rows, "sessionListMetadata", "val", "blank"));
    cache.lastPromptAt = dshDate(jsonPath(rows, "sessionListMetadata", "val", "lastPromptAt"));
    return cache;
  }

  /** 没有 `sessionListMetadata` 时的判断：没标题、没开过一轮。只在缓存不比日志旧时可信。 */
  get looksBlank(): boolean {
    return this.title === undefined && (this.lastTurn ?? 0) === 0 && this.openTurnStartSeq === undefined;
  }
}

function readFileSyncCompat(file: string): string {
  // 用同步读避免扫描器被上千个小文件拖成极长的 await 链；上游也是同步读。
  return readFileSync(file, "utf8");
}

async function directories(path: string): Promise<string[]> {
  try {
    return await directoriesOrThrow(path);
  } catch {
    return [];
  }
}

async function directoriesOrThrow(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
}

async function safeStat(path: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? path : path.slice(index + 1);
}
