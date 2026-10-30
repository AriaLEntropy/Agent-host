// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexObserver.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import type { BusProject, BusTask } from "../../bus/store.js";
import type { ConnectorHost } from "../ported/contract.js";
import type { CodexThreadReader } from "./thread-reader.js";
import { CodexPaths } from "./paths.js";

/** 只读观察的数据来源。生产实现是 `CodexThreadReaderSource`，测试用假实现，不碰 SQLite。 */
export interface CodexThreadSource {
  readSnapshot(agentId: string): { tasks: BusTask[]; projects: BusProject[] };
}

/** 把只读 reader 包成观察源。 */
export class CodexThreadReaderSource implements CodexThreadSource {
  constructor(private readonly reader: CodexThreadReader) {}

  readSnapshot(agentId: string): { tasks: BusTask[]; projects: BusProject[] } {
    return { tasks: this.reader.readTasks(agentId), projects: this.reader.readProjects(agentId) };
  }
}

/**
 * 观察者需要的宿主能力。`ConnectorHost` 没有上游 `TaskStore.reconcile` 与 `pendingCount`，
 * 这里用 `tasks()/upsert/remove/isLive` 复刻“只改造 observer 拥有的任务”的那一半语义；
 * 需要精确对账时由调用方注入 `reconcile`。
 */
export type CodexObserverHost = Pick<
  ConnectorHost,
  "agentId" | "task" | "tasks" | "upsert" | "remove" | "rememberProject" | "isLive"
>;

export type CodexObserverStatus = {
  /** 菜单栏那行 Codex 状态。 */
  text: string;
  /** 待审批 / 待输入的任务数，来自宿主（不是本轮轮询结果）。 */
  pendingCount: number;
  /** 连续读库失败次数，成功即清零。 */
  consecutiveFailures: number;
};

/**
 * Codex 的只读观察者：持有轮询循环、数据源、间隔与连续失败计数，把结果喂给宿主。
 *
 * 观察者只负责 `codex` 来源的**对账**，实时数据由连接器经 `claimLive` 接管，
 * 它拥有的 id 对账时会被整体跳过。
 */
export class CodexObserver {
  /**
   * 连续失败多少次才把菜单栏文案改成报错。WAL 侧文件（-wal/-shm）缺失或损坏时只读打开会偶发失败，
   * 单次不报警，免得侧文件抖一下就吓用户一跳。
   */
  static readonly failureThreshold = 3;
  static readonly defaultInterval = 2;
  static readonly initialStatusText = "尚未读取 Codex";

  /** 这一轮能不能读：读不了时 `unavailable` 的文案直接进菜单栏。 */

  private readonly host: CodexObserverHost;
  private readonly availability: () => CodexObserverAvailability;
  private readonly interval: () => number | Promise<number>;
  private readonly statusObserver: (status: CodexObserverStatus) => void;
  private readonly pendingCount: () => number;
  private readonly reconcile: (tasks: BusTask[], projects: BusProject[]) => void;

  status: CodexObserverStatus = { text: CodexObserver.initialStatusText, pendingCount: 0, consecutiveFailures: 0 };
  private consecutiveFailures = 0;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    host: CodexObserverHost,
    options: {
      availability: () => CodexObserverAvailability;
      interval?: () => number | Promise<number>;
      statusObserver?: (status: CodexObserverStatus) => void;
      pendingCount?: () => number;
      reconcile?: (tasks: BusTask[], projects: BusProject[]) => void;
    },
  ) {
    this.host = host;
    this.availability = options.availability;
    this.interval = options.interval ?? (() => CodexObserver.defaultInterval);
    this.statusObserver = options.statusObserver ?? (() => undefined);
    this.pendingCount = options.pendingCount ?? (() => 0);
    this.reconcile = options.reconcile ?? ((tasks, projects) => reconcileWithHost(this.host, tasks, projects));
  }

  /** 幂等：已经在跑就什么都不做。 */
  start(): void {
    if (this.running) return;
    this.stopped = false;
    const task = (async () => {
      while (!this.stopped) {
        await this.pollOnce();
        const seconds = await this.interval();
        if (this.stopped) return;
        await sleepSeconds(seconds, () => this.stopped);
      }
    })();
    this.running = task;
    const clear = () => {
      if (this.running === task) this.running = undefined;
    };
    void task.then(clear, (error) => {
      clear();
      console.error(`[codexobserver] poll loop stopped: ${String(error)}`);
    });
  }

  stop(): void {
    this.stopped = true;
  }

  /** 跑一轮。循环在用，设置页改完路径也可以直接催一轮，不必等下一个节拍。 */
  async pollOnce(): Promise<void> {
    const availability = this.availability();
    if (availability.kind === "unavailable") {
      // 读不到库不是“这个来源报告了空列表”：一条都不能摘。
      this.consecutiveFailures = 0;
      this.report(availability.message);
      return;
    }
    await this.poll(availability.source);
  }

  private async poll(source: CodexThreadSource): Promise<void> {
    // 归属最终由宿主盖章，这里传当前 agentId 只是少一次重写；未配对时是空串。
    const agentId = this.host.agentId;
    try {
      // SQLite 读取放到下一拍事件循环，避免把当前微任务链拖长（Node 没有 actor；
      // PORT：上游是 Task.detached 后台线程，这里是同步读 + setImmediate 让出）。
      await new Promise<void>((resolve) => setImmediate(resolve));
      const result = source.readSnapshot(agentId);
      this.reconcile(result.tasks, result.projects);
      this.consecutiveFailures = 0;
      this.report(`Codex：${result.tasks.length} 个任务（7 天内）`);
    } catch (error) {
      this.consecutiveFailures += 1;
      console.error(`[codexobserver] codex poll failed (${this.consecutiveFailures}): ${String(error)}`);
      // 只有连续多次失败才改菜单栏文案，避免侧文件抖动造成误报。
      const text =
        this.consecutiveFailures >= CodexObserver.failureThreshold
          ? `读取 Codex 失败：${error instanceof Error ? error.message : String(error)}`
          : this.status.text;
      this.report(text);
    }
  }

  private report(text: string): void {
    this.status = {
      text,
      pendingCount: this.pendingCount(),
      consecutiveFailures: this.consecutiveFailures,
    };
    this.statusObserver(this.status);
  }
}

export type CodexObserverAvailability =
  | { kind: "ready"; source: CodexThreadSource }
  /** 例如“未找到 Codex 数据库：<路径>”。此时**不做对账**——读不到不等于任务没了。 */
  | { kind: "unavailable"; message: string };

/** 用宿主能力复刻 `reconcile(source: .codex, …)` 里跟本来源有关的那部分。 */
export function reconcileWithHost(
  host: CodexObserverHost,
  tasks: BusTask[],
  projects: BusProject[],
): void {
  for (const project of projects) host.rememberProject(project);
  const incoming = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    // 实时数据拥有的 id 轮不到只读观察改写。
    if (host.isLive(task.id)) continue;
    const existing = host.task(task.id);
    if (existing && sameTask(existing, task)) continue;
    host.upsert(task);
  }
  for (const existing of host.tasks()) {
    if (existing.source !== "codex") continue;
    if (host.isLive(existing.id)) continue;
    if (incoming.has(existing.id)) continue;
    host.remove(existing.id);
  }
}

function sameTask(left: BusTask, right: BusTask): boolean {
  return (
    left.title === right.title &&
    left.projectPath === right.projectPath &&
    left.projectName === right.projectName &&
    left.status === right.status &&
    left.lastMessage === right.lastMessage &&
    left.origin === right.origin &&
    left.controllable === right.controllable &&
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt &&
    left.model === right.model &&
    left.effort === right.effort &&
    JSON.stringify(left.pendingRequest) === JSON.stringify(right.pendingRequest)
  );
}

function sleepSeconds(seconds: number, cancelled: () => boolean): Promise<void> {
  if (!(seconds > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    // 取消时直接返回，循环下一拍看到 stopped 就退出。
    const check = setInterval(() => {
      if (cancelled()) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
  });
}

/** 生产装配用：按路径现取数据库，两个库都在才算 ready。 */
export function codexAvailability(reader: () => CodexThreadReader | undefined): CodexObserverAvailability {
  const current = reader();
  if (current) return { kind: "ready", source: new CodexThreadReaderSource(current) };
  const paths = new CodexPaths();
  return {
    kind: "unavailable",
    message: `未找到 Codex 数据库：${paths.codexHome}`,
  };
}
