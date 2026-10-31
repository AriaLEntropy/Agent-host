/**
 * BotBus 自己拉起的 ACP 会话记在本机（spec「电脑上已有的会话」）：很多 agent 没有
 * `session/list`，不记的话 app 一重启，手机上发起的任务就全不见了。**不存对话内容**：
 * 只留会话 id、目录、标题、时间与状态；`lastMessage`、挂起的审批、系统授权提示、产物
 * 一律去掉——重启后这些任务没有「最后一条消息」。标题（首条提示词的前 80 字，
 * 由 `AcpSession` 截好）是文件里唯一来自对话的内容。
 *
 * 和 `session/list` 一样只留最近窗口（7 天）里更新过的：读进来时、每次存盘前都剪一遍。
 * 写盘走「同目录临时文件 + rename」，中途崩掉不会留下半截 JSON。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/Acp/AcpSessionArchive.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostDataDir } from "../../config.js";
import { createLogger } from "../../platform/log.js";

/** 归档文件名；落在数据目录下。 */
export const ACP_SESSION_ARCHIVE_FILE = "acp-sessions.json";
/** 每个连接器最多留的会话数（上游 `maxPerConnector`）。 */
export const ACP_SESSION_MAX_PER_CONNECTOR = 200;
/** 最近窗口：与 `SessionFormatting.recentWindow` 一致，7 天。 */
export const ACP_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 落盘的会话元数据；**没有任何对话字段**。 */
export type AcpSessionArchiveEntry = {
  id: string;
  title: string;
  projectPath: string;
  projectName: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  /** 所属电脑；`(agentId, id)` 才是全局唯一键，重建任务时需要。 */
  agentId?: string;
  source?: string;
  origin?: string;
  controllable?: boolean;
  connectorId?: string;
  model?: string;
  effort?: string;
  /** 会话实际工作目录（协议 2.7）；续聊必须回到这里。 */
  worktreePath?: string;
  /** 会话不在任何项目里；只有 true 或省略两种写法。 */
  outsideProject?: true;
};

/**
 * `remember` 接受的形状：比落盘的多几个对话字段，写进去之前统一剥掉。
 * `BusTask` 结构上满足这个类型，runtime 可以直接把任务传进来。
 */
export type AcpSessionArchiveInput = AcpSessionArchiveEntry & {
  /** 以下字段不会落盘：读进来就丢掉（上游 `AcpSessionArchive.stripped`）。 */
  lastMessage?: string;
  pendingRequest?: unknown;
  systemPermission?: unknown;
  artifacts?: unknown;
};

export type AcpSessionArchiveOptions = {
  /** `null` = 只在内存里；不传 = 数据目录下的 `acp-sessions.json`。 */
  path?: string | null;
  /** 时钟，测试用。 */
  now?: () => Date;
  /** 最近窗口（毫秒）；默认 7 天。 */
  retentionMs?: number;
  /** 每连接器上限；默认 200。 */
  maxPerConnector?: number;
};

type ArchiveMap = Record<string, AcpSessionArchiveEntry[]>;

const REQUIRED_FIELDS = [
  "id",
  "title",
  "projectPath",
  "projectName",
  "status",
  "startedAt",
  "updatedAt",
] as const;

const logger = createLogger("agent-host", "acp");

export function defaultAcpSessionArchivePath(): string {
  return join(hostDataDir(), ACP_SESSION_ARCHIVE_FILE);
}

/**
 * BotBus 自己拉起的 ACP 会话的本机归档。所有方法串行执行（对应上游 actor），
 * 首次用到时才读盘。
 */
export class AcpSessionArchive {
  private readonly path: string | null;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly maxPerConnector: number;
  private byConnector: ArchiveMap = {};
  private loaded: Promise<void> | undefined;
  /** 让 remember / forget / records 按调用顺序落地，模拟 actor 的串行语义。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: AcpSessionArchiveOptions = {}) {
    this.path = options.path === undefined ? defaultAcpSessionArchivePath() : options.path;
    this.now = options.now ?? (() => new Date());
    this.retentionMs = options.retentionMs ?? ACP_SESSION_RETENTION_MS;
    this.maxPerConnector = options.maxPerConnector ?? ACP_SESSION_MAX_PER_CONNECTOR;
    if (!Number.isFinite(this.retentionMs) || this.retentionMs < 0) {
      throw new RangeError("retentionMs must be a non-negative number");
    }
    if (!Number.isInteger(this.maxPerConnector) || this.maxPerConnector <= 0) {
      throw new RangeError("maxPerConnector must be a positive integer");
    }
  }

  get archivePath(): string | null {
    return this.path;
  }

  /** 某个连接器记着的会话，新的在前。 */
  async records(connectorId: string): Promise<AcpSessionArchiveEntry[]> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      return [...(this.byConnector[connectorId] ?? [])];
    });
  }

  /** 记一条会话：同 id 覆盖，按 `updatedAt` 新的在前，每连接器最多 200 条。 */
  async remember(connectorId: string, record: AcpSessionArchiveInput): Promise<void> {
    let entry: AcpSessionArchiveEntry;
    try {
      entry = stripSessionMetadata(record);
    } catch (error) {
      // 上游不会因为一条畸形记录中断整轮保存；记一条脱敏日志就够了。
      logger.warning("acp session metadata skipped", { error });
      return;
    }
    await this.serialize(async () => {
      await this.ensureLoaded();
      const list = (this.byConnector[connectorId] ?? []).filter((item) => item.id !== entry.id);
      list.push(entry);
      list.sort(compareNewestFirst);
      this.byConnector[connectorId] = list.slice(0, this.maxPerConnector);
      this.byConnector = pruneSessionMetadata(this.byConnector, this.now(), this.retentionMs);
      await this.save();
    });
  }

  /** 电脑上删掉的会话：记录拿掉，重启后不再补回来。 */
  async forget(connectorId: string, taskIds: Iterable<string>): Promise<void> {
    const ids = new Set(taskIds);
    await this.serialize(async () => {
      await this.ensureLoaded();
      const list = this.byConnector[connectorId];
      if (!list) return;
      const kept = list.filter((entry) => !ids.has(entry.id));
      if (kept.length === list.length) return;
      if (kept.length === 0) delete this.byConnector[connectorId];
      else this.byConnector[connectorId] = kept;
      await this.save();
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 首次用到才读盘；读进来也剥一遍、剪一遍——这是本机明文文件，不假定里面只有元数据。 */
  private ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      let loaded: ArchiveMap = {};
      if (this.path !== null) {
        try {
          loaded = parseArchive(await readFile(this.path, "utf8"));
        } catch {
          // 没有、读不了或不是合法 JSON：从空归档开始。
          loaded = {};
        }
      }
      this.byConnector = pruneSessionMetadata(loaded, this.now(), this.retentionMs);
    })();
    return this.loaded;
  }

  /** 同目录临时文件 + rename：崩在写一半也不会把旧归档弄坏。 */
  private async save(): Promise<void> {
    const path = this.path;
    if (path === null) return;
    const directory = dirname(path);
    const temp = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temp, `${JSON.stringify(this.byConnector, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      // Error 默认打码，不会把路径写进日志。
      logger.error("acp session archive save failed", { error });
    }
  }
}

/** 只留元数据，去掉一切对话内容。字段缺失或类型不对时抛错（不静默写坏文件）。 */
export function stripSessionMetadata(record: AcpSessionArchiveInput): AcpSessionArchiveEntry {
  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== "string") {
      throw new TypeError(`session metadata "${field}" must be a string`);
    }
  }
  const entry: AcpSessionArchiveEntry = {
    id: record.id,
    title: record.title,
    projectPath: record.projectPath,
    projectName: record.projectName,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
  // 上游只剥对话字段；重建任务需要的身份与工作位置都保留。
  copyString(entry, "agentId", record.agentId);
  copyString(entry, "source", record.source);
  copyString(entry, "origin", record.origin);
  copyString(entry, "connectorId", record.connectorId);
  copyString(entry, "model", record.model);
  copyString(entry, "effort", record.effort);
  copyString(entry, "worktreePath", record.worktreePath);
  if (typeof record.controllable === "boolean") entry.controllable = record.controllable;
  if (record.outsideProject === true) entry.outsideProject = true;
  return entry;
}

function copyString<K extends keyof AcpSessionArchiveEntry>(
  target: AcpSessionArchiveEntry,
  key: K,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    target[key] = value as AcpSessionArchiveEntry[K];
  }
}

/**
 * 去掉最近窗口之外的记录；`updatedAt` 解析不了的留着（交给显示那一侧），剪空的 agent 整个拿掉。
 */
export function pruneSessionMetadata(
  byConnector: Readonly<ArchiveMap>,
  now: Date,
  retentionMs: number = ACP_SESSION_RETENTION_MS,
): ArchiveMap {
  const result: ArchiveMap = {};
  for (const [connectorId, list] of Object.entries(byConnector)) {
    const kept = list.filter((entry) => {
      const updated = Date.parse(entry.updatedAt);
      if (Number.isNaN(updated)) return true;
      return now.getTime() - updated <= retentionMs;
    });
    if (kept.length > 0) result[connectorId] = kept;
  }
  return result;
}

function parseArchive(raw: string): ArchiveMap {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
  const result: ArchiveMap = {};
  for (const [connectorId, value] of Object.entries(decoded)) {
    if (!Array.isArray(value)) continue;
    const entries: AcpSessionArchiveEntry[] = [];
    for (const item of value) {
      const entry = sanitizeEntry(item);
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) result[connectorId] = entries;
  }
  return result;
}

function sanitizeEntry(value: unknown): AcpSessionArchiveEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== "string") return undefined;
  }
  const entry: AcpSessionArchiveEntry = {
    id: record.id as string,
    title: record.title as string,
    projectPath: record.projectPath as string,
    projectName: record.projectName as string,
    status: record.status as string,
    startedAt: record.startedAt as string,
    updatedAt: record.updatedAt as string,
  };
  copyString(entry, "agentId", record.agentId);
  copyString(entry, "source", record.source);
  copyString(entry, "origin", record.origin);
  copyString(entry, "connectorId", record.connectorId);
  copyString(entry, "model", record.model);
  copyString(entry, "effort", record.effort);
  copyString(entry, "worktreePath", record.worktreePath);
  if (typeof record.controllable === "boolean") entry.controllable = record.controllable;
  if (record.outsideProject === true) entry.outsideProject = true;
  return entry;
}

function compareNewestFirst(left: AcpSessionArchiveEntry, right: AcpSessionArchiveEntry): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}
