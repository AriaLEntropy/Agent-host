import { basename } from "node:path";
import { platformPath } from "../platform/path.js";
import { PLUGIN_VERSION } from "../tunnel/version.js";
import { notifyForTaskChange } from "./notify.js";
import { saveBusState, type PersistedBusState, type PersistedSession } from "./persistence.js";
import { ProjectDismissals } from "./project-dismissals.js";
import { normalizeProjectPath } from "./project-path.js";
import {
  WorktreeResolver,
  defaultWorktreeArchivePath,
  resolveByShape,
  worktreesComponentIndex,
} from "./worktree.js";

export const MAX_TASKS = 400;
export const MAX_PROJECTS = 60;
export const MAX_RECENT_RESULTS = 20;

export type HostPlatform = "windows" | "macos" | "linux";

/** 协议 2.14：带选项的提问（与 protocol.ts 的 PendingQuestion 同形）。 */
export type BusPendingQuestion = {
  id: string;
  question: string;
  header?: string;
  /**
   * 单选时整个键省略。协议线格式是字面量 true。这里用 `any` 是两处既有
   * 声明夹出来的：Codex 移植模块声明成 `boolean`（只会产出 true），Dsh 的
   * `DshPendingQuestion` 声明成 `true`，两者都从本类型读写；改成 true 或
   * boolean 都会让其中一边不再可赋值。线格式不变，手机侧仍按协议校验。
   */
  multiSelect?: any;
  options: Array<{ label: string; description?: string }>;
};

export type BusPendingRequest = {
  id: string;
  kind: "command" | "fileChange" | "permission" | "input";
  summary: string;
  detail?: string;
  questions?: BusPendingQuestion[];
};

export type BusTask = {
  id: string;
  agentId: string;
  source: string;
  title: string;
  projectPath: string;
  projectName: string;
  /** 协议 2.7：会话实际在 git worktree 里时的工作目录；此时 `projectPath` 是主仓库。 */
  worktreePath?: string;
  outsideProject?: boolean;
  status: string;
  lastMessage?: string;
  pendingRequest?: BusPendingRequest;
  origin: string;
  controllable: boolean;
  startedAt: string;
  updatedAt: string;
  connectorId?: string;
  model?: string;
  effort?: string;
};

/**
 * 协议 2.9 的 `MessageFileRef`：Agent 回复里提到、可按需取回的本机媒体文件。
 * 只出现在 `role = agent`；`artifactId` 只在手机点过（`fetchFile`）之后才有。
 */
export type BusMessageFileRef = {
  /** Mac / Windows 上的绝对真实路径，`fetchFile` 原样带回。 */
  path: string;
  name: string;
  contentType: string;
  /** 原文件字节数。 */
  size: number;
  artifactId?: string;
};

/**
 * 协议 2.9 的 `MessageAttachment`：对话里的一张图。字节在本机产物目录，这里只是引用；
 * `artifactId` 由本机随机密钥对（会话、消息、来源）做 HMAC 得出，重复拉取时不变。
 */
export type BusMessageAttachment = {
  artifactId: string;
  contentType: string;
  /** 产物里的字节数。 */
  size: number;
  width?: number;
  height?: number;
};

export type BusMessage = {
  id: string;
  role: "user" | "agent" | "tool";
  text: string;
  createdAt: string;
  /** 协议 2.9：消息里的图（用户发的或 Agent 生成的），最多 4 张。 */
  attachments?: BusMessageAttachment[];
  /** 协议 2.9：Agent 回复里提到本机文件，最多 4 个。 */
  files?: BusMessageFileRef[];
};

export type BusTaskMessages = {
  taskId: string;
  agentId: string;
  messages: BusMessage[];
  hasMore: boolean;
  fetchedAt: string;
};

/** ConnectorInfo.models：Agent 自己上报的可选模型（最多 24 个）。 */
export type BusModelOption = {
  id: string;
  displayName: string;
  efforts?: string[];
  defaultEffort?: string;
};

/** 协议 3.10：技能目录里的一项；ACP 的命令没有正文，hasBody 为 false */
export type BusSkill = {
  id: string;
  name: string;
  description: string;
  hint?: string;
  kind: "skill" | "command";
  source: "session" | "project" | "user" | "agent";
  hasBody: boolean;
};

/** 一次 fetchSkills 的结果；不进快照，只作为事件下发 */
export type BusSkillList = {
  commandId: string;
  agentId: string;
  connector: string;
  connectorId?: string;
  projectPath: string;
  taskId?: string;
  revision: string;
  skills: BusSkill[];
  truncated: boolean;
  fetchedAt: string;
};

/** 一次 readSkill 的结果 */
export type BusSkillContent = {
  commandId: string;
  agentId: string;
  skillId: string;
  name: string;
  contentType: "text/markdown";
  body: string;
  truncated: boolean;
  fetchedAt: string;
};

/** 协议 `ConnectorKind` 的全集；ACP 用 connectorId 区分具体 agent。 */
export type ListedAgentKind =
  | "codex"
  | "claude"
  | "hermes"
  | "pi"
  | "openclaw"
  | "acp"
  | "dsh";

export type ListedAgent = {
  id: string;
  kind: ListedAgentKind;
  name: string;
  available: boolean;
  enabled: boolean;
  lastError?: string;
  /** 一档探测明确给出的健康度；缺省时按 available / lastError 推导。 */
  status?: "ok" | "degraded" | "error";
  models?: BusModelOption[];
  /** 协议 3.3：能不能给项目开自动批准；只写 true。 */
  canAutoApprove?: boolean;
  /** 协议 3.8：能不能永久删除电脑端会话；只写 true。 */
  canDeleteTasks?: boolean;
  /** 协议 3.10：能不能从手机查技能目录；只写 true */
  canListSkills?: boolean;
};

export type BusProject = {
  agentId: string;
  path: string;
  name: string;
  lastUsedAt: string;
  pinned: boolean;
};

export type BusCommandResult = {
  commandId: string;
  ok: boolean;
  error?: string;
  taskId?: string;
  finishedAt: string;
};

/**
 * 协议「七、通知」的 Notify。
 *
 * `requestId` 只在 `TASK_APPROVAL` 必填（Relay 会核对信封外那一份），
 * `agentName` 是 3.0 起发通知的电脑名——Relay 读不到密文里的内容，只有这一份
 * 由电脑在密封前填上。
 */
export type BusNotify = {
  taskId: string;
  category: "TASK_APPROVAL" | "TASK_INPUT" | "TASK_DONE" | "TASK_FAILED";
  title: string;
  body: string;
  requestId?: string;
  agentName?: string;
};

export type BusEvent = {
  kind:
    | "snapshot"
    | "taskUpdated"
    | "taskRemoved"
    | "commandResult"
    | "taskMessages"
    | "notify"
    | "skillList"
    | "skillContent";
  snapshot?: Record<string, unknown>;
  task?: BusTask;
  taskId?: string;
  commandResult?: BusCommandResult;
  taskMessages?: BusTaskMessages;
  notify?: BusNotify;
  skillList?: BusSkillList;
  skillContent?: BusSkillContent;
};

export type HostIdentity = {
  agentId: string;
  hostName: string;
  hostVersion?: string;
  platform: HostPlatform;
};

type Listener = (event: BusEvent) => void;

/**
 * worktree 解析的注入点（协议 2.7）。生产环境用 `WorktreeResolver`；测试可以传
 * 一个只认固定路径的假实现，避免读真实 `worktrees.json` / 用户目录。
 */
export type TaskWorktreeResolver = {
  projectRoot(path: string): string | null;
};

/**
 * store 的唯一写入口上的观察者。会话存档用它记住/忘掉 ACP 元数据，bus 层
 * 不需要反向依赖 connectors。回调抛错会被忽略，写入本身永远成功。
 */
export type TaskStoreHooks = {
  taskUpserted?: (task: BusTask) => void;
  taskRemoved?: (taskId: string, task: BusTask | undefined) => void;
};

export function hostPlatform(): HostPlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "windows";
}

export class TaskStore {
  private seq = 0;
  private tasks: BusTask[] = [];
  private projects: BusProject[] = [];
  private recentResults: BusCommandResult[] = [];
  private identity: HostIdentity = {
    agentId: "",
    hostName: "Agent Host",
    platform: hostPlatform(),
  };
  private agents: ListedAgent[] = [];
  private projectsRootPath: string | undefined;
  private messages = new Map<string, BusTaskMessages>();
  private sessions = new Map<string, PersistedSession>();
  private persistPath: string | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private persistChain: Promise<void> = Promise.resolve();
  /** rememberProject 的合并快照定时器；避免只读观察者逐项目刷全量。 */
  private projectSnapshotTimer?: NodeJS.Timeout;
  /** 协议 3.8：被手机移出列表的项目。惰性创建，避免 import 时读真实用户目录。 */
  private projectDismissals: ProjectDismissals | undefined;
  /** `undefined` = 还没用到（首次遇到 worktree 形状时惰性建默认解析器）；`null` = 停用。 */
  private worktreeResolver: TaskWorktreeResolver | null | undefined;
  private taskHooks: TaskStoreHooks = {};
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<Listener>();

  identify(identity: HostIdentity) {
    this.identity = identity;
  }

  agentId() {
    return this.identity.agentId;
  }

  setAgents(agents: ListedAgent[], announce = false) {
    this.agents = agents;
    if (announce) this.publish({ kind: "snapshot" });
  }

  /** FR-14.6.3：只在允许手机新建项目时上报 projectsRoot */
  setProjectsRoot(path: string | undefined, announce = true) {
    this.projectsRootPath = path?.trim() || undefined;
    if (announce) this.publish({ kind: "snapshot" });
  }

  currentSeq() {
    return this.seq;
  }

  /** 启动时接上本机持久化；未配置时所有保存都是 no-op。 */
  configurePersistence(path: string) {
    this.persistPath = path;
  }

  /**
   * 接上 store 的写入观察者。runtime 用它把 ACP 会话元数据记进会话存档；
   * 回调永远不会让一次 upsert / remove 失败。
   */
  setTaskHooks(hooks: TaskStoreHooks) {
    this.taskHooks = hooks;
  }

  /**
   * 换 worktree 解析器。`null` 完全停用；省略 / `undefined` 时首次遇到
   * worktree 形状的路径才创建带默认归档位置的 `WorktreeResolver`。
   */
  configureWorktreeResolver(resolver: TaskWorktreeResolver | null) {
    this.worktreeResolver = resolver;
  }

  /**
   * upsert 边界上的路径盖章（协议 2.7）：会话开在 git worktree 里时，
   * `projectPath` 换成主仓库、真实工作目录挪进 `worktreePath`。同步执行；
   * 解析器内部有缓存，重复盖章结果不变。其它路径原样返回。
   */
  stampTask(task: BusTask): BusTask {
    return this.stampWorktree(task);
  }

  private stampWorktree(task: BusTask): BusTask {
    if (task.outsideProject) return task;
    const working = task.worktreePath?.trim() || task.projectPath?.trim() || "";
    // 只有路径里带 worktrees 段（含 Claude / Codex 的固定形状）才值得看盘。
    if (!working || (resolveByShape(working) === null && worktreesComponentIndex(working) === null)) {
      return task;
    }
    let resolver = this.worktreeResolver;
    if (resolver === undefined) {
      resolver = new WorktreeResolver({ archivePath: defaultWorktreeArchivePath() });
      this.worktreeResolver = resolver;
    }
    if (resolver === null) return task;
    let root: string | null;
    try {
      root = resolver.projectRoot(working);
    } catch {
      // 解析失败就保留原样；不能因为一次盖章失败丢掉任务。
      return task;
    }
    if (!root) return task;
    const projectPath = platformPath.canonical(root);
    const worktreePath = platformPath.canonical(working);
    const projectName = basename(projectPath) || task.projectName;
    if (
      task.projectPath === projectPath &&
      task.worktreePath === worktreePath &&
      task.projectName === projectName
    ) {
      return task;
    }
    return { ...task, projectPath, projectName, worktreePath };
  }

  private dismissals(): ProjectDismissals {
    if (!this.projectDismissals) this.projectDismissals = new ProjectDismissals();
    return this.projectDismissals;
  }

  /**
   * 换 `removed-projects.json` 的位置并重读；`path` 省略时看
   * `AGENT_HOST_REMOVED_PROJECTS` / 默认目录（测试用）。
   */
  configureProjectDismissals(path?: string) {
    this.dismissals().configurePath(path);
  }

  /**
   * 恢复上次运行的任务/项目/消息。
   * 没有活会话的旧任务一律降为只读，避免 UI 发出注定失败的 followUp。
   */
  hydrate(state: PersistedBusState, agentId = "") {
    this.tasks = state.tasks
      .map((task) => {
        const interrupted = task.status === "running" || task.status === "waitingApproval" || task.status === "waitingInput";
        return {
          ...task,
          ...(agentId ? { agentId } : {}),
          controllable: false,
          ...(interrupted ? { status: "interrupted", lastMessage: "电脑端重启，任务已中断" } : {}),
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_TASKS);
    this.projects = state.projects.map((project) => (agentId ? { ...project, agentId } : project)).slice(0, MAX_PROJECTS);
    this.messages = new Map(state.messages.map((item) => [item.taskId, item]));
    this.sessions = new Map(state.sessions.map((item) => [item.taskId, item]));
  }

  messagesFor(taskId: string) {
    return this.messages.get(taskId);
  }

  rememberSession(taskId: string, nativeSessionId: string, catalog: PersistedSession["catalog"]) {
    this.sessions.set(taskId, {
      taskId,
      nativeSessionId,
      catalog,
      owner: "agent-host",
      revision: 1,
    });
    this.schedulePersist();
  }

  bumpSessionRevision(taskId: string) {
    const current = this.sessions.get(taskId);
    if (!current) return;
    this.sessions.set(taskId, { ...current, revision: current.revision + 1 });
    this.schedulePersist();
  }

  persistedState(): PersistedBusState {
    const taskIds = new Set(this.tasks.map((task) => task.id));
    return {
      version: 1,
      tasks: this.tasks,
      projects: this.projects,
      messages: [...this.messages.values()].filter((item) => taskIds.has(item.taskId)),
      sessions: [...this.sessions.values()].filter((item) => taskIds.has(item.taskId)),
    };
  }

  async flushPersistence() {
    if (!this.persistPath) return;
    const path = this.persistPath;
    const state = this.persistedState();
    this.persistChain = this.persistChain
      .then(() => saveBusState(path, state))
      .catch(() => undefined);
    await this.persistChain;
  }

  private schedulePersist() {
    if (!this.persistPath) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flushPersistence();
    }, 150);
    this.persistTimer.unref?.();
  }

  /** 托盘角标：待审批 / 待回复任务数，口径与手机快照的可见面一致 */
  pendingRequestCount(): number {
    const dismissals = this.dismissals();
    return this.tasks.filter(
      (task) => !dismissals.hides(task) && Boolean(task.pendingRequest),
    ).length;
  }

  snapshot(): Record<string, unknown> {
    const now = new Date().toISOString();
    // 协议 3.8：被移出的项目及其全部来源会话只从手机可见面消失，
    // 任务本身仍留在 store 里（所有权、历史与产物都不变）。
    const dismissals = this.dismissals();
    const visibleTasks = this.tasks.filter((task) => !dismissals.hides(task));
    const visibleProjects = this.projects.filter(
      (project) => !dismissals.hidesProject(project.agentId, project.path),
    );
    return {
      agents: [
        {
          agentId: this.identity.agentId,
          name: this.identity.hostName,
          platform: this.identity.platform,
          online: true,
          lastSeenAt: now,
          appVersion: this.identity.hostVersion ?? PLUGIN_VERSION,
          connectors: this.agents.map((agent) => ({
            kind: agent.kind,
            displayName: agent.name,
            available: agent.available,
            enabled: agent.enabled,
            status:
              agent.status ??
              (agent.lastError && agent.available ? "error" : agent.available ? "ok" : "degraded"),
            taskCount: visibleTasks.filter((task) =>
              agent.kind === "acp"
                ? task.source === "acp" && task.connectorId === agent.id
                : task.source === agent.kind,
            ).length,
            ...(agent.lastError ? { lastError: agent.lastError } : {}),
            ...(agent.kind === "acp" ? { connectorId: agent.id } : {}),
            ...(agent.models?.length ? { models: agent.models } : {}),
            ...(agent.canAutoApprove ? { canAutoApprove: true } : {}),
            ...(agent.canDeleteTasks ? { canDeleteTasks: true } : {}),
            ...(agent.canListSkills ? { canListSkills: true } : {}),
          })),
          capabilities: {
            remoteControl: false,
            previews: false,
            fetchChanges: false,
          },
          // 协议 3.8 的移出项目能力；只写 true。
          canRemoveProjects: true,
          // 运行时实现了 restartConnector；协议 3.9 只写 true。
          canRestartConnectors: true,
          ...(this.projectsRootPath ? { projectsRoot: this.projectsRootPath } : {}),
        },
      ],
      tasks: visibleTasks,
      projects: visibleProjects.slice(0, MAX_PROJECTS),
      recentResults: this.recentResults,
      recentMessages: [],
      seq: this.seq,
      generatedAt: now,
    };
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForChange(since: number, timeoutMs: number): Promise<boolean> {
    if (since !== this.seq) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (changed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(changed);
      };
      const wake = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(wake);
    });
  }

  taskById(taskId: string) {
    return this.tasks.find((task) => task.id === taskId);
  }

  projectByPath(path: string) {
    return this.projects.find((project) => project.path === path);
  }

  rememberProject(project: BusProject) {
    const before = JSON.stringify(this.projects);
    this.projects = [project, ...this.projects.filter((item) => item.path !== project.path)].slice(
      0,
      MAX_PROJECTS,
    );
    if (JSON.stringify(this.projects) !== before) {
      this.schedulePersist();
      this.scheduleProjectSnapshot();
    }
  }

  /**
   * 只读观察者每轮会 rememberProject 多个项目；逐个 publish 全量快照会把手机
   * 打到几十帧每秒。项目顺序/时间不需要毫秒级实时，合并成 1 秒一帧。
   */
  private scheduleProjectSnapshot() {
    if (this.projectSnapshotTimer) return;
    this.projectSnapshotTimer = setTimeout(() => {
      this.projectSnapshotTimer = undefined;
      this.publish({ kind: "snapshot" });
    }, 1_000);
    this.projectSnapshotTimer.unref?.();
  }

  /**
   * `publish = false` 只写入（并落盘），不发 `taskUpdated`。ACP 对账的第一次
   * 列表是通知基线，不是变化；逐条推送会把几十条历史会话当成新任务发到手机上。
   */
  upsertTask(task: BusTask, publish = true) {
    const stamped = this.stampWorktree(task);
    const previous = this.tasks.find((item) => item.id === stamped.id);
    const rest = this.tasks.filter((item) => item.id !== stamped.id);
    this.tasks = [stamped, ...rest]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_TASKS);
    // 协议 3.8：新会话 / 新活动可以让被移出的项目重新可见。上游在保存失败时
    // 只忽略（`try?`），内存状态仍然生效。
    const dismissals = this.dismissals();
    const restored = dismissals.reconcile([stamped]);
    if (restored) dismissals.save();
    this.schedulePersist();
    if (publish && !dismissals.hides(stamped)) {
      this.publish({ kind: "taskUpdated", task: stamped });
      this.notifyForChange(previous, stamped);
    }
    // 恢复是可见性变化：即使这次 upsert 处于静默基线（publish=false），也要
    // 补一份全量快照，让被移出的项目与任务重新出现（对齐上游事件）。
    if (restored) this.publish({ kind: "snapshot" });
    try {
      this.taskHooks.taskUpserted?.(stamped);
    } catch {
      // 观察者（会话存档）失败不能影响任务写入。
    }
  }

  /**
   * 判定并下发这一条任务变化对应的 `notify`。
   *
   * 只在真的发了 `taskUpdated` 的路径上判定：静默基线（ACP 对账的第一次列表、
   * watch 扫到的历史会话）不该被当成变化，一次冒出几十条通知就是轰炸
   */
  private notifyForChange(previous: BusTask | undefined, next: BusTask) {
    const notify = notifyForTaskChange(previous, next, this.identity.hostName);
    if (notify) this.publish({ kind: "notify", notify });
  }

  /**
   * 协议 3.8：从手机列表移出项目及其全部来源会话。
   *
   * 对齐上游 `TaskStore.removeProject(path:)`：路径先归一化；已经隐藏则直接
   * 成功；项目（或只由任务派生出的项目）不存在、或只在不属于项目的位置时
   * 抛 "本机没有这个项目"；持久化失败回滚内存并抛错；成功后发一次全量快照。
   * 不删任务、目录、源码、worktree、会话记录或产物。
   */
  removeProject(rawPath: string) {
    const agentId = this.identity.agentId;
    const path = normalizeProjectPath(rawPath);
    if (!path) throw new Error("本机没有这个项目");
    const dismissals = this.dismissals();
    if (dismissals.hidesProject(agentId, path)) return;
    const related = this.tasks.filter(
      (task) =>
        task.agentId === agentId &&
        task.outsideProject !== true &&
        normalizeProjectPath(task.projectPath) === path,
    );
    const project = this.projects.find(
      (item) => normalizeProjectPath(item.path) === path,
    );
    if (!project && related.length === 0) throw new Error("本机没有这个项目");
    const lastUsedAt =
      project?.lastUsedAt ??
      related.reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), "");
    const previous = dismissals.snapshot();
    dismissals.dismissProject(agentId, path, related, lastUsedAt);
    if (!dismissals.save()) {
      dismissals.restore(previous);
      throw new Error("无法保存已移出的项目记录");
    }
    this.publish({ kind: "snapshot" });
  }

  removeTask(taskId: string) {
    const removed = this.tasks.find((item) => item.id === taskId);
    this.tasks = this.tasks.filter((item) => item.id !== taskId);
    this.messages.delete(taskId);
    this.sessions.delete(taskId);
    this.schedulePersist();
    this.publish({ kind: "taskRemoved", taskId });
    try {
      this.taskHooks.taskRemoved?.(taskId, removed);
    } catch {
      // 会话存档忘记失败不能影响删除结果。
    }
  }

  emitTaskMessages(taskMessages: BusTaskMessages) {
    this.messages.set(taskMessages.taskId, taskMessages);
    this.schedulePersist();
    this.publish({ kind: "taskMessages", taskMessages });
  }

  emitSkillList(skillList: BusSkillList) {
    this.publish({ kind: "skillList", skillList });
  }

  emitSkillContent(skillContent: BusSkillContent) {
    this.publish({ kind: "skillContent", skillContent });
  }

  recordResult(result: BusCommandResult) {
    this.recentResults = [result, ...this.recentResults].slice(0, MAX_RECENT_RESULTS);
    this.publish({ kind: "commandResult", commandResult: result });
  }

  replaceForMeasurement(tasks: BusTask[], projects: BusProject[]) {
    this.tasks = tasks
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_TASKS);
    this.projects = projects;
  }

  reset() {
    if (this.projectSnapshotTimer) {
      clearTimeout(this.projectSnapshotTimer);
      this.projectSnapshotTimer = undefined;
    }
    this.seq = 0;
    this.tasks = [];
    this.projects = [];
    this.recentResults = [];
    this.agents = [];
    this.messages.clear();
    this.sessions.clear();
    // 解析器缓存跟着这次运行走；观察者（会话存档）仍然保留。
    this.worktreeResolver = undefined;
    // 只清内存；removed-projects.json 与已配置的路径都保留。
    this.projectDismissals?.reset();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persistPath = undefined;
    this.persistChain = Promise.resolve();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    this.listeners.clear();
  }

  private publish(event: BusEvent) {
    // 协议「Event 一览」：`notify` 不改 Snapshot、也不递增 seq，其余各种都推进快照版本。
    // 跟着涨 seq 会让重连的客户端以为自己漏了快照，为一条通知去重拉全量。
    if (event.kind !== "notify") this.seq += 1;
    if (event.kind === "snapshot") event.snapshot = this.snapshot();
    for (const listener of this.listeners) listener(event);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
}

export const busStore = new TaskStore();
