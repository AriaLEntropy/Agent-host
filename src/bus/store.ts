import { PLUGIN_VERSION } from "../tunnel/version.js";

export const MAX_TASKS = 400;
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
  status: string;
  lastMessage?: string;
  pendingRequest?: BusPendingRequest;
  origin: string;
  controllable: boolean;
  startedAt: string;
  updatedAt: string;
  connectorId?: string;
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

export type ListedAgent = {
  id: string;
  kind: "acp" | "dsh";
  name: string;
  available: boolean;
  enabled: boolean;
  lastError?: string;
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
          })),
          capabilities: {
            remoteControl: false,
            previews: false,
            fetchChanges: false,
          },
        },
      ],
      tasks: this.tasks,
      projects: this.projects,
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
    this.projects = [project, ...this.projects.filter((item) => item.path !== project.path)];
    if (JSON.stringify(this.projects) !== before) this.publish({ kind: "snapshot" });
  }

  upsertTask(task: BusTask) {
    const rest = this.tasks.filter((item) => item.id !== task.id);
    this.tasks = [task, ...rest]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_TASKS);
    this.publish({ kind: "taskUpdated", task });
  }

  removeTask(taskId: string) {
    this.tasks = this.tasks.filter((item) => item.id !== taskId);
    this.publish({ kind: "taskRemoved", taskId });
  }

  emitTaskMessages(taskMessages: BusTaskMessages) {
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
