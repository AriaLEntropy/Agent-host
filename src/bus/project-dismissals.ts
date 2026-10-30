import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hostDataDir } from "../config.js";
import { normalizeProjectPath } from "./project-path.js";

/**
 * 项目维度的本地列表可见性（协议 3.8 的 `removeProject`）。
 *
 * 语义对齐上游 Apache-2.0 的
 * `botbus-protocol/Sources/BotBusProtocol/ListDismissals.swift`：
 * 保存的是活动基线（`updatedAt` + `lastMessage` 的 FNV-1a 64 位指纹），不是
 * 删除任务；项目与全部来源会话只在快照/事件里不可见，任务记录、所有权、
 * 原生会话、源码、worktree 与产物都不动。新会话或新活动满足 `reconcile`
 * 的规则时，这个项目重新可见。
 *
 * 持久化文件默认是 `hostDataDir()/removed-projects.json`，可用
 * `AGENT_HOST_REMOVED_PROJECTS` 或构造参数 `path` 覆盖（测试用）。文件损坏、
 * 版本不认识或读失败一律当空，绝不让 Agent 起不来。
 *
 * 与上游的差异：上游 `ListDismissals` 直接 Codable 成 `{sessions, projects}`；
 * 这里只需要项目维度，状态是 `{version: 1, projects}`。`message` 在上游是
 * `UInt64`，JS 里用 Number 承载（写入/读回都走同一套舍入，比较仍然稳定）。
 */

const STATE_VERSION = 1;

const FNV_OFFSET_BASIS = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const UINT64_MASK = (1n << 64n) - 1n;

/** 上游 `Activity.init(_:)` 的 FNV-1a 64 位指纹，逐 UTF-8 字节。 */
export function fingerprint64(message: string | undefined): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(message ?? "", "utf8")) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & UINT64_MASK;
  }
  return hash;
}

/** 写进 JSON 的指纹（Number；见文件头关于 UInt64 精度差异的说明）。 */
export function messageFingerprint(message: string | undefined): number {
  return Number(fingerprint64(message));
}

export type DismissalActivity = {
  updatedAt: string;
  message: number;
};

export type ProjectDismissalEntry = {
  agentId: string;
  path: string;
  activities: Record<string, DismissalActivity>;
  cutoff: string;
};

export type ProjectDismissalsState = {
  version: 1;
  projects: ProjectDismissalEntry[];
};

/** 本模块只依赖任务里与可见性相关的字段，避免 bus/store 与 bus/ 之间循环引用。 */
export type DismissibleTask = {
  id: string;
  agentId: string;
  projectPath: string;
  outsideProject?: boolean;
  lastMessage?: string;
  startedAt: string;
  updatedAt: string;
};

export type ProjectDismissalsOptions = {
  /** 显式文件路径；省略时看 `AGENT_HOST_REMOVED_PROJECTS` / 默认目录。 */
  path?: string;
};

export function removedProjectsPath(path?: string): string {
  const explicit = path?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.AGENT_HOST_REMOVED_PROJECTS?.trim();
  if (fromEnv) return fromEnv;
  return join(hostDataDir(), "removed-projects.json");
}

function emptyState(): ProjectDismissalsState {
  return { version: STATE_VERSION, projects: [] };
}

function activityOf(task: DismissibleTask): DismissalActivity {
  return {
    updatedAt: task.updatedAt,
    message: messageFingerprint(task.lastMessage),
  };
}

/** 上游 `Activity.isNewer(_:)`：时间更大，或同一时间但消息指纹不同。 */
function isNewer(activity: DismissalActivity, task: DismissibleTask): boolean {
  const current = activityOf(task);
  return (
    current.updatedAt > activity.updatedAt ||
    (current.updatedAt === activity.updatedAt && current.message !== activity.message)
  );
}

function cloneEntry(entry: ProjectDismissalEntry): ProjectDismissalEntry {
  const activities: Record<string, DismissalActivity> = {};
  for (const [taskId, activity] of Object.entries(entry.activities)) {
    activities[taskId] = { updatedAt: activity.updatedAt, message: activity.message };
  }
  return { agentId: entry.agentId, path: entry.path, activities, cutoff: entry.cutoff };
}

function cloneState(state: ProjectDismissalsState): ProjectDismissalsState {
  return { version: STATE_VERSION, projects: state.projects.map(cloneEntry) };
}

function readMessage(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // 兼容上游 UInt64 以字符串写出的情况（以及旧版本测试夹具）。
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sanitizeEntry(raw: unknown): ProjectDismissalEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.agentId !== "string") return undefined;
  if (typeof entry.path !== "string") return undefined;
  const path = normalizeProjectPath(entry.path);
  if (!path) return undefined;
  if (typeof entry.cutoff !== "string") return undefined;
  const activities: Record<string, DismissalActivity> = {};
  const rawActivities = entry.activities;
  if (rawActivities && typeof rawActivities === "object" && !Array.isArray(rawActivities)) {
    for (const [taskId, value] of Object.entries(rawActivities as Record<string, unknown>)) {
      if (!taskId || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const activity = value as Record<string, unknown>;
      if (typeof activity.updatedAt !== "string") continue;
      const message = readMessage(activity.message);
      if (message === undefined) continue;
      activities[taskId] = { updatedAt: activity.updatedAt, message };
    }
  }
  return { agentId: entry.agentId, path, activities, cutoff: entry.cutoff };
}

/** 读取失败 / JSON 坏了 / 版本不认识 / 结构不对都返回空状态。 */
function readState(path: string | null): ProjectDismissalsState {
  if (!path) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyState();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
  const raw = parsed as Record<string, unknown>;
  // 上游文件没有 version 字段；也接受它，按 v1 解析。
  if (raw.version !== undefined && raw.version !== STATE_VERSION) return emptyState();
  const projects: ProjectDismissalEntry[] = [];
  for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
    const entry = sanitizeEntry(item);
    if (entry) projects.push(entry);
  }
  return { version: STATE_VERSION, projects };
}

/**
 * 内存中的项目 dismissal 视图 + 同步原子落盘。
 *
 * `dismissProject` / `reconcile` 只改内存；调用方（`TaskStore.removeProject`
 * 与 `TaskStore.upsertTask`）负责在合适的时机 `save()`，失败时用
 * `snapshot()` / `restore()` 回滚。
 */
export class ProjectDismissals {
  private state: ProjectDismissalsState = emptyState();
  private path: string | null = null;

  constructor(options: ProjectDismissalsOptions = {}) {
    this.configurePath(options.path);
  }

  /** 换文件并立即重读；`path` 省略时重新看环境变量 / 默认目录。 */
  configurePath(path?: string) {
    this.path = removedProjectsPath(path);
    this.state = readState(this.path);
  }

  /** 只清内存，不删磁盘文件（测试与 `TaskStore.reset()` 用）。 */
  reset() {
    this.state = emptyState();
  }

  /** 从当前文件重读；文件不在 / 坏了就是空。 */
  reload() {
    this.state = readState(this.path);
  }

  get projects(): ProjectDismissalEntry[] {
    return this.snapshot().projects;
  }

  snapshot(): ProjectDismissalsState {
    return cloneState(this.state);
  }

  restore(state: ProjectDismissalsState) {
    this.state = cloneState(state);
  }

  /** 上游 `dismissProject(agentId:path:tasks:lastUsedAt:)`。 */
  dismissProject(
    agentId: string,
    rawPath: string,
    tasks: readonly DismissibleTask[],
    lastUsedAt: string,
  ) {
    const path = normalizeProjectPath(rawPath);
    const related = tasks.filter(
      (task) =>
        task.agentId === agentId &&
        task.outsideProject !== true &&
        normalizeProjectPath(task.projectPath) === path,
    );
    const activities: Record<string, DismissalActivity> = {};
    for (const task of related) activities[task.id] = activityOf(task);
    let cutoff = lastUsedAt;
    for (const task of related) {
      if (task.updatedAt > cutoff) cutoff = task.updatedAt;
    }
    const entry: ProjectDismissalEntry = { agentId, path, activities, cutoff };
    this.state.projects = [
      ...this.state.projects.filter(
        (item) => !(item.agentId === agentId && item.path === path),
      ),
      entry,
    ];
  }

  /** 上游 `reconcile(_:)`：命中恢复规则就移除 dismissal，返回是否有变化。 */
  reconcile(tasks: readonly DismissibleTask[]): boolean {
    if (this.state.projects.length === 0 || tasks.length === 0) return false;
    const kept = this.state.projects.filter(
      (entry) => !tasks.some((task) => this.entryRestoredBy(entry, task)),
    );
    if (kept.length === this.state.projects.length) return false;
    this.state.projects = kept;
    return true;
  }

  /** 上游 `hides(task)`（单任务 dismissal 不在本次范围，只看项目）。 */
  hides(task: DismissibleTask): boolean {
    if (task.outsideProject === true) return false;
    return this.hidesProject(task.agentId, task.projectPath);
  }

  /** 上游 `hidesProject(agentId:path:)`。 */
  hidesProject(agentId: string, rawPath: string): boolean {
    const path = normalizeProjectPath(rawPath);
    return this.state.projects.some(
      (entry) => entry.agentId === agentId && entry.path === path,
    );
  }

  /**
   * 同步原子写：mkdir 0700 → 临时文件 0600 → rename，尽力 chmod 0600。
   * 失败返回 false，旧文件保持不变。
   */
  save(): boolean {
    if (!this.path) return true;
    const target = this.path;
    const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        chmodSync(temp, 0o600);
      } catch {
        // Windows 上 chmod 基本无效；尽力而为。
      }
      renameSync(temp, target);
      return true;
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // 临时文件可能根本没建出来。
      }
      return false;
    }
  }

  private entryRestoredBy(entry: ProjectDismissalEntry, task: DismissibleTask): boolean {
    if (task.agentId !== entry.agentId) return false;
    if (task.outsideProject === true) return false;
    if (normalizeProjectPath(task.projectPath) !== entry.path) return false;
    const activity = entry.activities[task.id];
    if (activity) return isNewer(activity, task);
    // 不在基线里的新任务：开始与更新都不早于 cutoff 才算“新活动”。
    return task.startedAt >= entry.cutoff && task.updatedAt >= entry.cutoff;
  }
}
