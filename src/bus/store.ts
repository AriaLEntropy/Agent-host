import { PLUGIN_VERSION } from "../tunnel/version.js";
import { saveBusState, type PersistedBusState, type PersistedSession } from "./persistence.js";

export const MAX_TASKS = 400;
export const MAX_PROJECTS = 60;
export const MAX_RECENT_RESULTS = 20;

export type HostPlatform = "windows" | "macos" | "linux";

export type BusPendingRequest = {
  id: string;
  kind: "command" | "fileChange" | "permission" | "input";
  summary: string;
  detail?: string;
};

export type BusTask = {
  id: string;
  agentId: string;
  source: string;
  title: string;
  projectPath: string;
  projectName: string;
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

export type BusMessage = {
  id: string;
  role: "user" | "agent" | "tool";
  text: string;
  createdAt: string;
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

export type ListedAgent = {
  id: string;
  kind: "acp" | "dsh";
  name: string;
  available: boolean;
  enabled: boolean;
  lastError?: string;
  models?: BusModelOption[];
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

export type BusEvent = {
  kind: "snapshot" | "taskUpdated" | "taskRemoved" | "commandResult" | "taskMessages";
  snapshot?: Record<string, unknown>;
  task?: BusTask;
  taskId?: string;
  commandResult?: BusCommandResult;
  taskMessages?: BusTaskMessages;
};

export type HostIdentity = {
  agentId: string;
  hostName: string;
  hostVersion?: string;
  platform: HostPlatform;
};

type Listener = (event: BusEvent) => void;

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
  private messages = new Map<string, BusTaskMessages>();
  private sessions = new Map<string, PersistedSession>();
  private persistPath: string | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private persistChain: Promise<void> = Promise.resolve();
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

  currentSeq() {
    return this.seq;
  }

  /** 启动时接上本机持久化；未配置时所有保存都是 no-op。 */
  configurePersistence(path: string) {
    this.persistPath = path;
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

  snapshot(): Record<string, unknown> {
    const now = new Date().toISOString();
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
            status: agent.lastError && agent.available ? "error" : agent.available ? "ok" : "degraded",
            taskCount: this.tasks.filter((task) =>
              agent.kind === "dsh"
                ? task.source === "dsh"
                : task.source === "acp" && task.connectorId === agent.id,
            ).length,
            ...(agent.lastError ? { lastError: agent.lastError } : {}),
            ...(agent.kind === "acp" ? { connectorId: agent.id } : {}),
            ...(agent.models?.length ? { models: agent.models } : {}),
          })),
          capabilities: {
            remoteControl: false,
            previews: false,
            fetchChanges: false,
          },
        },
      ],
      tasks: this.tasks,
      projects: this.projects.slice(0, MAX_PROJECTS),
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

  rememberProject(project: BusProject) {
    const before = JSON.stringify(this.projects);
    this.projects = [project, ...this.projects.filter((item) => item.path !== project.path)].slice(
      0,
      MAX_PROJECTS,
    );
    if (JSON.stringify(this.projects) !== before) {
      this.schedulePersist();
      this.publish({ kind: "snapshot" });
    }
  }

  upsertTask(task: BusTask) {
    const rest = this.tasks.filter((item) => item.id !== task.id);
    this.tasks = [task, ...rest]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_TASKS);
    this.schedulePersist();
    this.publish({ kind: "taskUpdated", task });
  }

  removeTask(taskId: string) {
    this.tasks = this.tasks.filter((item) => item.id !== taskId);
    this.messages.delete(taskId);
    this.sessions.delete(taskId);
    this.schedulePersist();
    this.publish({ kind: "taskRemoved", taskId });
  }

  emitTaskMessages(taskMessages: BusTaskMessages) {
    this.messages.set(taskMessages.taskId, taskMessages);
    this.schedulePersist();
    this.publish({ kind: "taskMessages", taskMessages });
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
    this.seq = 0;
    this.tasks = [];
    this.projects = [];
    this.recentResults = [];
    this.agents = [];
    this.messages.clear();
    this.sessions.clear();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.persistPath = undefined;
    this.persistChain = Promise.resolve();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    this.listeners.clear();
  }

  private publish(event: BusEvent) {
    this.seq += 1;
    if (event.kind === "snapshot") event.snapshot = this.snapshot();
    for (const listener of this.listeners) listener(event);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
}

export const busStore = new TaskStore();
