/**
 * Local metadata archives for task lists (protocol 3.4 / FR-8.3 / FR-3.4).
 *
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/HiddenTaskArchive.swift
 * and PhoneTaskArchive.swift (Apache-2.0).
 *
 * Both files are local-only and never enter the protocol:
 * - `hidden-tasks.json`: task id -> time it was hidden after "merge and finish".
 *   Read-only observers still see the underlying transcript, so this set keeps
 *   merged sessions out of snapshots and upserts.
 * - `phone-tasks.json`: task id -> first time the phone started it. The
 *   connector's in-memory `origin` resets to desktop after a restart, and the
 *   connector relies on origin to tell "already open on the desktop" apart, so
 *   this is tracked separately rather than by rewriting origin.
 *
 * Parsing is deliberately forgiving: a missing, corrupt or unexpected file
 * loads as empty, so old sessions can reappear but the Agent still starts.
 * Writes are atomic (`atomic-json.ts`), owner-only, and deterministic
 * (task ids sorted). Errors are reported as booleans, never as paths.
 *
 * Retention follows upstream: at most 2000 hidden tasks and 500 phone-started
 * tasks, evicting the earliest timestamp first (ties broken by task id). An
 * optional age cutoff is available via `retentionMs`; pass
 * `TASK_ARCHIVE_RETENTION_MS` for the 7-day policy used by other local
 * metadata. Age pruning is off by default because upstream keeps hidden ids
 * until the cap — old observer sessions have usually fallen off the list.
 */
import { join } from "node:path";
import { hostDataDir } from "../config.js";
import { createLogger } from "../platform/log.js";
import { readJsonFile, writeJsonFileAtomic } from "./atomic-json.js";

export const HIDDEN_TASK_LIMIT = 2_000;
export const PHONE_TASK_LIMIT = 500;
export const TASK_ARCHIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const ARCHIVE_VERSION = 1;

export type TaskTimestamps = Record<string, string>;

export type TaskArchiveLoadOptions = {
  limit?: number;
  now?: Date;
  /** Drop entries older than this many milliseconds; 0/undefined disables age pruning. */
  retentionMs?: number;
};

export type TaskArchiveOptions = {
  /**
   * Explicit file path. `null` keeps the archive in memory only; omitted uses
   * the environment override or the default app data file.
   */
  path?: string | null;
  now?: () => Date;
  limit?: number;
  retentionMs?: number;
};

type ArchiveField = "hiddenAt" | "firstSeenAt";

type ArchiveShape = {
  field: ArchiveField;
  defaultLimit: number;
  defaultPath: () => string;
  category: string;
};

/**
 * Upstream `trimmed(_:limit:)` plus optional age pruning.
 *
 * When over the cap, entries with the earliest timestamp are dropped first;
 * equal timestamps are ordered by task id so the result is deterministic.
 * Invalid timestamps are kept unless the cap forces them out.
 */
export function trimTaskArchive(tasks: TaskTimestamps, options: {
  limit: number;
  now?: Date;
  retentionMs?: number;
}): TaskTimestamps {
  const limit = Math.max(0, Math.floor(options.limit));
  const retention = Math.max(0, options.retentionMs ?? 0);
  const now = (options.now ?? new Date()).getTime();
  let entries = Object.entries(tasks).filter(([taskId, timestamp]) => {
    if (!taskId) return false;
    if (retention > 0) {
      const at = Date.parse(timestamp);
      if (Number.isFinite(at) && now - at > retention) return false;
    }
    return true;
  });
  if (entries.length <= limit) return Object.fromEntries(entries);
  entries = entries.sort(([leftId, leftAt], [rightId, rightAt]) => {
    if (leftAt < rightAt) return -1;
    if (leftAt > rightAt) return 1;
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  });
  return Object.fromEntries(entries.slice(entries.length - limit));
}

/** Default path for hidden task metadata (`…/agent-host/hidden-tasks.json`). */
export function hiddenTasksPath(path?: string): string {
  const explicit = path?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.AGENT_HOST_HIDDEN_TASKS?.trim();
  if (fromEnv) return fromEnv;
  return join(hostDataDir(), "hidden-tasks.json");
}

/** Default path for phone-started task metadata (`…/agent-host/phone-tasks.json`). */
export function phoneTasksPath(path?: string): string {
  const explicit = path?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.AGENT_HOST_PHONE_TASKS?.trim();
  if (fromEnv) return fromEnv;
  return join(hostDataDir(), "phone-tasks.json");
}

/** Upstream-compatible hidden-task loader (file → map, trimmed by limit). */
export function loadHiddenTasks(
  path: string | null,
  options: TaskArchiveLoadOptions = {},
): TaskTimestamps {
  return trimTaskArchive(readArchive(path, "hiddenAt"), {
    limit: options.limit ?? HIDDEN_TASK_LIMIT,
    now: options.now,
    retentionMs: options.retentionMs,
  });
}

/** Upstream-compatible hidden-task writer. Returns false without touching the old file. */
export function saveHiddenTasks(tasks: TaskTimestamps, path: string | null): boolean {
  return writeArchive(path, tasks, "hiddenAt", "hidden-tasks");
}

/** Upstream-compatible hidden-task trimmer. */
export function trimHiddenTasks(
  tasks: TaskTimestamps,
  options: TaskArchiveLoadOptions = {},
): TaskTimestamps {
  return trimTaskArchive(tasks, {
    limit: options.limit ?? HIDDEN_TASK_LIMIT,
    now: options.now,
    retentionMs: options.retentionMs,
  });
}

/** Upstream-compatible phone-task loader. */
export function loadPhoneTasks(
  path: string | null,
  options: TaskArchiveLoadOptions = {},
): TaskTimestamps {
  return trimTaskArchive(readArchive(path, "firstSeenAt"), {
    limit: options.limit ?? PHONE_TASK_LIMIT,
    now: options.now,
    retentionMs: options.retentionMs,
  });
}

/** Upstream-compatible phone-task writer. */
export function savePhoneTasks(tasks: TaskTimestamps, path: string | null): boolean {
  return writeArchive(path, tasks, "firstSeenAt", "phone-tasks");
}

/** Upstream-compatible phone-task trimmer. */
export function trimPhoneTasks(
  tasks: TaskTimestamps,
  options: TaskArchiveLoadOptions = {},
): TaskTimestamps {
  return trimTaskArchive(tasks, {
    limit: options.limit ?? PHONE_TASK_LIMIT,
    now: options.now,
    retentionMs: options.retentionMs,
  });
}

/**
 * Shared in-memory map + atomic persistence. Subclasses add the semantic
 * operation (`hide` / `remember`).
 */
class TimestampArchive {
  protected tasks: TaskTimestamps = {};
  private readonly config: ArchiveShape;
  private readonly now: () => Date;
  private readonly maxEntries: number;
  private readonly retention: number;
  private path: string | null;

  constructor(config: ArchiveShape, options: TaskArchiveOptions) {
    this.config = config;
    this.now = options.now ?? (() => new Date());
    this.maxEntries = Math.max(0, Math.floor(options.limit ?? config.defaultLimit));
    this.retention = Math.max(0, options.retentionMs ?? 0);
    this.path = resolveArchivePath(options.path, config.defaultPath);
    this.reload();
  }

  get archivePath(): string | null {
    return this.path;
  }

  get size(): number {
    return Object.keys(this.tasks).length;
  }

  get limit(): number {
    return this.maxEntries;
  }

  get retentionMs(): number {
    return this.retention;
  }

  /** Switch files and reload; `null` disables persistence, `undefined` uses the default. */
  configurePath(path?: string | null): void {
    this.path = resolveArchivePath(path, this.config.defaultPath);
    this.reload();
  }

  /** Re-read from disk and apply retention. */
  reload(): void {
    this.tasks = this.trim(readArchive(this.path, this.config.field));
  }

  has(taskId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.tasks, taskId);
  }

  timestamp(taskId: string): string | undefined {
    return this.tasks[taskId];
  }

  snapshot(): TaskTimestamps {
    return { ...this.tasks };
  }

  /** Memory-only update; callers that want durability call `save()`. */
  set(taskId: string, timestamp: string): boolean {
    if (!taskId || typeof timestamp !== "string") return false;
    this.tasks = this.trim({ ...this.tasks, [taskId]: timestamp });
    return true;
  }

  /** Memory-only removal. */
  delete(taskId: string): boolean {
    if (!this.has(taskId)) return false;
    const next = { ...this.tasks };
    delete next[taskId];
    this.tasks = next;
    return true;
  }

  clear(): void {
    this.tasks = {};
  }

  /** Atomic write; false when the previous file could not be replaced. */
  save(): boolean {
    if (!this.path) return true;
    const saved = writeArchive(this.path, this.tasks, this.config.field, this.config.category);
    return saved;
  }

  protected trim(tasks: TaskTimestamps): TaskTimestamps {
    return trimTaskArchive(tasks, {
      limit: this.maxEntries,
      now: this.now(),
      retentionMs: this.retention,
    });
  }

  /** Current time as the ISO string stored in the archive (injectable clock). */
  protected nowStamp(): string {
    return this.now().toISOString();
  }
}

/**
 * `hidden-tasks.json`: task ids hidden after "merge and finish".
 *
 * `hide()` overwrites the timestamp, trims, and persists immediately (upstream
 * `TaskStore.hide` semantics). The return value is the save result; memory
 * remains updated even when the disk write fails.
 */
export class HiddenTaskArchive extends TimestampArchive {
  constructor(options: TaskArchiveOptions = {}) {
    super(
      {
        field: "hiddenAt",
        defaultLimit: HIDDEN_TASK_LIMIT,
        defaultPath: hiddenTasksPath,
        category: "hidden-tasks",
      },
      options,
    );
  }

  hide(taskId: string, at: string = this.nowStamp()): boolean {
    if (!this.set(taskId, at)) return false;
    return this.save();
  }

  /** Hidden ids still recorded (insertion order is not meaningful; use `snapshot`). */
  ids(): string[] {
    return Object.keys(this.tasks);
  }
}

/**
 * `phone-tasks.json`: task ids first seen from the phone.
 *
 * `remember()` keeps the first timestamp and only writes when the id is new.
 * Returns true when nothing needed persisting or the write succeeded.
 */
export class PhoneTaskArchive extends TimestampArchive {
  constructor(options: TaskArchiveOptions = {}) {
    super(
      {
        field: "firstSeenAt",
        defaultLimit: PHONE_TASK_LIMIT,
        defaultPath: phoneTasksPath,
        category: "phone-tasks",
      },
      options,
    );
  }

  remember(taskId: string, at: string = this.nowStamp()): boolean {
    if (!taskId || this.has(taskId)) return true;
    if (!this.set(taskId, at)) return false;
    return this.save();
  }

  ids(): string[] {
    return Object.keys(this.tasks);
  }
}

function resolveArchivePath(
  explicit: string | null | undefined,
  fallback: () => string,
): string | null {
  if (explicit === null) return null;
  const trimmed = explicit?.trim();
  return trimmed ? trimmed : fallback();
}

function readArchive(path: string | null, field: ArchiveField): TaskTimestamps {
  const parsed = readJsonFile(path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.version !== "number" || !Array.isArray(raw.tasks)) return {};
  const tasks: TaskTimestamps = {};
  for (const item of raw.tasks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const taskId = entry.taskId;
    const timestamp = entry[field];
    if (typeof taskId !== "string" || !taskId || typeof timestamp !== "string") continue;
    tasks[taskId] = timestamp;
  }
  return tasks;
}

function writeArchive(
  path: string | null,
  tasks: TaskTimestamps,
  field: ArchiveField,
  category: string,
): boolean {
  if (!path) return true;
  const entries = Object.keys(tasks)
    .filter((taskId) => taskId.length > 0 && typeof tasks[taskId] === "string")
    .sort()
    .map((taskId) => ({ taskId, [field]: tasks[taskId] }));
  const saved = writeJsonFileAtomic(path, { version: ARCHIVE_VERSION, tasks: entries });
  if (!saved) createLogger("agent-host", category).warning("task archive write failed");
  return saved;
}
