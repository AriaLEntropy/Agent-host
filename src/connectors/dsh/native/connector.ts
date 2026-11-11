// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshConnector.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// DeepSeek Harness（协议 3.1，一档来源 `dsh`）的连接器：BotBus 自己的活走 `dsh --profile acp` 子进程，
// 电脑上的会话经桌面版或 `dsh web` 的内部接口看见、也经它控制；web 不在时扫 `~/.dsh/sessions`。
//
// | 操作 | 走哪条 |
// |---|---|
// | 新建 | 一律 ACP |
// | 续聊 | 会话在我们的 ACP 进程里 → ACP；否则 web 连着 → web `session/prompt`；都不是 → ACP `session/resume` |
// | 审批 / 提问 | 我们的 ACP 这一轮挂着的 → ACP；web 的 waterfall 挂着的 → `$events/result` |
// | 中断 | ACP `session/cancel` 或 web `session/cancel` |
//
// **所有权**：web 正在跑、挂着 waterfall 的会话由本连接器 `claimLive` 并实时 upsert，
// 这一轮收尾（follow 流里的 `turn/end`，或 `api-session/status false` 之后的宽限）再交还。

import { randomUUID } from "node:crypto";
import { spawnSync, type ChildProcess } from "node:child_process";
import { spawnExecutable } from "../../ported/spawn.js";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { BusProject, BusTask } from "../../../bus/store.js";
import {
  ConnectorError,
  latestWindow,
  rejectSelection,
  truncateMessage,
  type ConnectorHost,
  type ConnectorOutcome,
  type ImageSource,
  type MessageReader,
  type ModelSelection,
  type TaskConnector,
  type TranscriptEntry,
} from "../../ported/contract.js";
import { acpSpec, DshPaths, environmentFor, type DshAcpSpec, type DshInstallation } from "./paths.js";
import { DshSessionScanner, decodeSegment, type DshSessionSummary } from "./session-scanner.js";
import {
  DshTaskMapping,
  DshLiveState,
  SessionFormatting,
  applyEvents,
  approvalWaterfallFromEvent,
  factsFromScanned,
  factsFromWeb,
  liveStateEqual,
  protocolTimestamp,
  type DshPendingRequest,
  type DshTaskRecord,
} from "./task-mapping.js";
import { AgentToolsInjection, DshToolsContext, isUsable, TaskContextRegistry, type AgentToolsConfiguration } from "./tools-context.js";
import {
  DshTranscriptDecoder,
  DshTranscriptParser,
  DshSessionFiles,
  type DshTranscriptDecoderOptions,
} from "./transcript.js";
import { DshWebCredentials } from "./web-auth.js";
import {
  DshWebClient,
  DshWebEndpoint,
  DshWebError,
  DshWebMux,
  FetchDshHTTPTransport,
  isEmptyAnswer,
  NodeWebSocketTransport,
  type DshHTTPTransport,
  type DshQuestionAnswer,
  type DshWebSocketTransport,
} from "./web-client.js";
import {
  DshWebLocator,
  SystemDshProcessListing,
  type DshProcessListing,
  type DshWebInstance,
} from "./web-locator.js";
import {
  arrayValue,
  eventsFrameFromJson,
  followFrameFromJson,
  isRecord,
  jsonPath,
  record,
  stringValue,
  type DshEventsFrame,
  type DshFollowFrame,
} from "./web-messages.js";

export type DshHealthStatus = "ok" | "degraded" | "error";
export type DshSleeper = (ms: number) => Promise<void>;
export type DshHealthHandler = (status: DshHealthStatus, message?: string) => void | Promise<void>;

export type DshTiming = {
  /** 循环的节拍：web 不在时每拍找一次 web 并扫一次盘；连着时看要不要 ping、重新拉列表。 */
  tick: number;
  authRetry: number;
  listRefresh: number;
  ping: number;
  /** 连上 mux 之后等 `$events` 的 `ready` 多久。 */
  readyTimeout: number;
  /** `api-session/status false` 比 follow 流里的 `turn/end` 先到：等这么久还没见到收尾就按已结束算。 */
  settleGrace: number;
  /** 经 web 续聊之后等它开跑多久；过了还没开跑就不再当它在跑。 */
  promptStartTimeout: number;
};

export const DEFAULT_DSH_TIMING: DshTiming = {
  tick: 5_000,
  authRetry: 30_000,
  listRefresh: 60_000,
  ping: 30_000,
  readyTimeout: 5_000,
  settleGrace: 3_000,
  promptStartTimeout: 20_000,
};

type WebLink = {
  generation: number;
  pid: number;
  client: DshWebClient;
  mux: DshWebMux;
  clientId: string;
  isDesktopHost: boolean;
};

type ReadyBox = { resolve: (clientId: string) => void; reject: (error: Error) => void };

type FollowHandle = {
  id: string;
  cancelled: boolean;
  cancel: () => void;
};

/** 内置 ACP 后端。测试注入假实现；生产默认 `NativeAcpBackend`。 */
export interface AcpBackend {
  update(spec: DshAcpSpec): Promise<void>;
  start(projectPath: string, prompt: string): Promise<ConnectorOutcome>;
  followUp(taskId: string, prompt: string): Promise<ConnectorOutcome>;
  approve(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome>;
  interrupt(taskId: string): Promise<ConnectorOutcome>;
  isInProcess(taskId: string): boolean;
  isRunningTurn(taskId: string): boolean;
  completeTranscript(taskId: string, limit: number): { entries: TranscriptEntry[]; hasMore: boolean } | undefined;
  staticTasks(): readonly BusTask[];
  noteSeen(ids: ReadonlySet<string>): void;
  forgetDeleted(options: { notIn: ReadonlySet<string>; updatedAfter: number; updatedBefore: number }): boolean;
  stop(): Promise<void>;
  stopSubprocess(): Promise<void>;
  shutdown(): Promise<void>;
}

export type DshConnectorOptions = {
  paths?: DshPaths;
  installation?: () => DshInstallation | null;
  acp?: AcpBackend;
  http?: DshHTTPTransport;
  webSocket?: DshWebSocketTransport;
  listing?: DshProcessListing;
  locateWeb?: (paths: DshPaths, listing: DshProcessListing) => DshWebInstance[];
  loadSecret?: (paths: DshPaths) => Buffer | null;
  transcriptDecoder?: DshTranscriptDecoder;
  scanner?: DshSessionScanner;
  tools?: () => AgentToolsConfiguration | null;
  registry?: TaskContextRegistry;
  now?: () => Date;
  sleep?: DshSleeper;
  timing?: Partial<DshTiming>;
  onHealth?: DshHealthHandler;
  /** 默认写 host.upsert；`notify: false` 用于启动补历史的静默基线。 */
  upsert?: (task: BusTask, notify: boolean) => void;
  log?: (level: "debug" | "info" | "error", message: string) => void;
  /** 测试关掉自动节拍，手动调 `tick()`。 */
  autoTick?: boolean;
  clientVersion?: string;
};

const realSleep: DshSleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * DeepSeek Harness 连接器。
 *
 * `// PORT:` Swift 里 `start()` 是"开始观察"、`start(projectPath:…)` 是命令；TS 不能重载，
 * 观察入口叫 `startObserving()`，命令仍是 `TaskConnector.start()`。
 */
export class DshConnector implements TaskConnector, MessageReader {
  readonly kind = "dsh" as const;
  /** 网页端开着时会话跑在 DeepSeek Harness 自己的进程里，BotBus 的文件夹授权说明不了它。 */
  readonly runsUnderBotBus = false;

  readonly paths: DshPaths;
  readonly acp: AcpBackend;
  private readonly host: ConnectorHost;
  private readonly installation: () => DshInstallation | null;
  private readonly http: DshHTTPTransport;
  private readonly webSocket: DshWebSocketTransport;
  private readonly listing: DshProcessListing;
  private readonly locateWeb: (paths: DshPaths, listing: DshProcessListing) => DshWebInstance[];
  private readonly loadSecret: (paths: DshPaths) => Buffer | null;
  private readonly scanner: DshSessionScanner;
  private readonly explicitDecoder?: DshTranscriptDecoder;
  private readonly tools: () => AgentToolsConfiguration | null;
  private readonly registry: TaskContextRegistry;
  private readonly now: () => Date;
  private readonly sleep: DshSleeper;
  private readonly timing: DshTiming;
  private readonly onHealth: DshHealthHandler;
  private readonly upsertTask: (task: BusTask, notify: boolean) => void;
  private readonly log: (level: "debug" | "info" | "error", message: string) => void;
  private readonly autoTick: boolean;

  private observing = false;
  private isShutDown = false;

  // web
  private web: WebLink | undefined;
  /** 正在进行的一次找 web + 连接：节拍与续聊撞锁时的"立刻找一次"不能各连各的。 */
  private connecting: Promise<void> | undefined;
  private webGeneration = 0;
  private readonly webSessions = new Map<string, import("./web-messages.js").DshWebSessionSummary>();
  private readonly webRunning = new Set<string>();
  private lastListRefresh = 0;
  private lastPing = 0;
  private nextConnectAttempt = 0;
  private webAuthProblem: string | undefined;
  private readonly desktopHandoffs = new Map<string, { cwd: string; nextAttempt: number }>();
  private readonly handingOff = new Set<string>();

  // 扫盘
  private scanned: Map<string, DshSessionSummary> | undefined;
  private readonly logFiles = new Map<string, string>();

  // 实时
  private readonly live = new Map<string, DshLiveState>();
  private readonly follows = new Map<string, FollowHandle>();
  private readonly pending = new Map<string, import("./web-messages.js").DshWaterfall>();
  private readonly expecting = new Map<string, number>();
  private readonly settleTimers = new Map<string, () => void>();
  private readonly expectationTimers = new Map<string, () => void>();
  private readonly claimed = new Set<string>();
  private readonly toolsContexts = new Map<string, DshToolsContext>();
  private toolsContextGeneration = 0;

  // 对账与健康
  private hasBaseline = false;
  private reconcileGeneration = 0;
  private acpHealth: { status: DshHealthStatus; message?: string } | undefined;
  private lastHealth: { status: DshHealthStatus; message?: string } | undefined;

  constructor(host: ConnectorHost, options: DshConnectorOptions = {}) {
    this.host = host;
    this.paths = options.paths ?? new DshPaths();
    this.installation = options.installation ?? (() => null);
    this.http = options.http ?? new FetchDshHTTPTransport();
    this.webSocket = options.webSocket ?? new NodeWebSocketTransport();
    this.listing = options.listing ?? new SystemDshProcessListing();
    this.locateWeb = options.locateWeb ?? ((paths, listing) => DshWebLocator.locate(paths, listing));
    this.loadSecret =
      options.loadSecret ?? ((paths) => DshWebCredentials.loadBrowserSessionSecret(paths));
    this.tools = options.tools ?? (() => null);
    this.registry = options.registry ?? new TaskContextRegistry();
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? realSleep;
    this.timing = { ...DEFAULT_DSH_TIMING, ...options.timing };
    this.onHealth = options.onHealth ?? (() => undefined);
    this.upsertTask = options.upsert ?? ((task) => this.host.upsert(task));
    this.log = options.log ?? (() => undefined);
    this.autoTick = options.autoTick ?? true;
    this.explicitDecoder = options.transcriptDecoder;
    this.scanner =
      options.scanner ??
      new DshSessionScanner({
        paths: {
          sessionsDirectory: this.paths.sessionsDirectory,
          projectionCacheFile: (sessionId) => this.paths.projectionCacheFile(sessionId),
        },
        now: this.now,
        headers: async (files) => {
          try {
            return await this.decoder().headers(files);
          } catch {
            return new Map();
          }
        },
      });
    this.acp =
      options.acp ??
      new NativeAcpBackend({
        now: this.now,
        clientVersion: options.clientVersion,
        sessionInfo: (taskId) => {
          const task = this.host.task(taskId);
          return task ? { cwd: task.projectPath } : undefined;
        },
        tools: this.tools,
        registry: this.registry,
        onTask: (task) => {
          task.agentId = this.host.agentId;
          this.host.upsert(task);
        },
        claim: (taskId) => this.host.claimLive(taskId),
        release: (taskId) => this.host.releaseLive(taskId),
        onTasksChanged: () => void this.reconcile(),
        onHealth: (status, message) => void this.acpHealthChanged(status, message),
        log: this.log,
      });
  }

  // MARK: - 生命周期

  /** 开始观察（找 web、扫盘、对账）。幂等。 */
  startObserving(): void {
    if (this.observing || this.isShutDown) return;
    this.observing = true;
    if (this.autoTick) void this.runLoop();
  }

  /** 停用：断开 web、交还认领、关 ACP 子进程。 */
  async stop(): Promise<void> {
    this.observing = false;
    await this.closeToolsContexts();
    this.desktopHandoffs.clear();
    await this.dropWeb();
    this.hasBaseline = false;
    this.scanned = undefined;
    this.live.clear();
    await this.acp.stop();
  }

  /** 解除配对或被接管：只关 BotBus 拉起的 ACP 子进程，观察照旧。 */
  async stopSubprocesses(): Promise<void> {
    await this.closeToolsContexts();
    await this.acp.stopSubprocess();
  }

  /** App 退出：不可逆。 */
  async shutdown(): Promise<void> {
    this.isShutDown = true;
    this.desktopHandoffs.clear();
    this.observing = false;
    await this.closeToolsContexts();
    await this.dropWeb();
    await this.acp.shutdown();
  }

  get isWebConnected(): boolean {
    return this.web !== undefined;
  }

  get webPort(): number | undefined {
    return this.web?.client.endpoint.port;
  }

  /** `ConnectorRegistry.refresh()` 会把运行期状态重置回探测结果：再报一次。 */
  async reannounceHealth(): Promise<void> {
    const last = this.lastHealth;
    if (!last) return;
    await this.onHealth(last.status, last.message);
  }

  private async runLoop(): Promise<void> {
    await this.tick();
    while (this.observing) {
      await this.sleep(this.timing.tick);
      if (!this.observing) return;
      await this.tick();
    }
  }

  /** 一拍：web 不在就找 web，还不在就扫盘；连着就按需 ping、重新拉列表。 */
  async tick(): Promise<void> {
    if (!this.observing || this.isShutDown) return;
    const installed = await this.syncAcpSpec();
    void installed;
    if (!this.web && this.now().getTime() >= this.nextConnectAttempt) await this.connectWeb();
    const link = this.web;
    if (link) {
      if (this.now().getTime() - this.lastPing >= this.timing.ping) {
        this.lastPing = this.now().getTime();
        try {
          await link.mux.ping();
        } catch {
          await this.webLost(link.generation);
        }
      }
      if (this.web && this.now().getTime() - this.lastListRefresh >= this.timing.listRefresh) {
        await this.refreshWebList();
      }
    }
    await this.handOffNewSessionsToDesktop();
    if (!this.web) {
      await this.scanDisk();
      await this.reconcile();
    }
    await this.updateHealth();
  }

  /** 安装位置变了就换 ACP 的启动方式。返回有没有可执行文件。 */
  private async syncAcpSpec(): Promise<boolean> {
    const found = this.installation();
    await this.acp.update(acpSpec(found, this.paths));
    return found !== null;
  }

  // MARK: - 命令

  async start(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    rejectSelection(selection, "新建任务");
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    if (!(await this.syncAcpSpec())) {
      throw new ConnectorError("本机没找到 DeepSeek Harness 的可执行文件（dsh），没法从手机新建任务", {
        diagnosis: { kind: "agentNotInstalled" },
      });
    }
    // 桌面工作区以 realpath 存目录；两端必须使用同一写法。
    const cwd = realpathOr(projectPath);
    const outcome = await this.acp.start(cwd, prompt);
    if (this.observing && !this.isShutDown) {
      const sessionId = DshTaskMapping.identity.sessionId(outcome.taskId);
      if (sessionId) this.desktopHandoffs.set(sessionId, { cwd, nextAttempt: 0 });
    }
    return outcome;
  }

  private async handOffNewSessionsToDesktop(): Promise<void> {
    const link = this.web;
    if (!link || !link.isDesktopHost || !this.observing || this.isShutDown) return;
    for (const [sessionId, handoff] of [...this.desktopHandoffs]) {
      if (this.handingOff.has(sessionId)) continue;
      if (this.now().getTime() < handoff.nextAttempt) continue;
      const taskId = DshTaskMapping.identity.taskId(sessionId);
      if (this.acp.isInProcess(taskId)) continue;
      if (!this.host.task(taskId)) {
        this.desktopHandoffs.delete(sessionId);
        continue;
      }
      if (this.web?.generation !== link.generation || !this.observing || this.isShutDown) return;
      if (this.handingOff.has(sessionId)) continue;
      this.handingOff.add(sessionId);
      this.desktopHandoffs.set(sessionId, {
        cwd: handoff.cwd,
        nextAttempt: this.now().getTime() + this.timing.authRetry,
      });
      try {
        await link.client.adoptSession(sessionId, handoff.cwd);
        this.desktopHandoffs.delete(sessionId);
        if (this.web?.generation === link.generation) await this.refreshWebList();
      } catch (error) {
        this.log("debug", `desktop handoff failed: ${webCategory(error)}`);
      }
      this.handingOff.delete(sessionId);
    }
  }

  async followUp(
    taskId: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    rejectSelection(selection, "续聊");
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    const sessionId = sessionIdOf(taskId);
    // 挂着提问时手机发的一句话就是回答。
    const waterfall = this.pending.get(sessionId);
    const link = this.web;
    if (waterfall && waterfall.request.type === "questions" && link) {
      await this.answerWaterfall(waterfall, link, undefined, DshTaskMapping.answersText(waterfall.request.questions, prompt));
      return { taskId, retainsLiveOwnership: this.isLive(sessionId) };
    }
    if (this.acp.isInProcess(taskId)) {
      return this.acp.followUp(taskId, prompt);
    }
    if (link) return this.followUpOverWeb(sessionId, taskId, prompt, link);
    if (!(await this.syncAcpSpec())) {
      throw new ConnectorError("DeepSeek Harness 网页端没有运行，本机也没找到 dsh 可执行文件，没法续聊");
    }
    try {
      return await this.acp.followUp(taskId, prompt);
    } catch (error) {
      if (!(error instanceof AcpSessionBusyError)) throw error;
      // 别的 dsh 进程拿着这个会话的锁：多半是刚开的 web，还没被找到。立刻找一次。
      if (!this.web) await this.connectWeb();
      const fallback = this.web;
      if (!fallback) throw error;
      return this.followUpOverWeb(sessionId, taskId, prompt, fallback);
    }
  }

  async approve(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome> {
    const sessionId = sessionIdOf(taskId);
    if (this.acp.isRunningTurn(taskId)) {
      return this.acp.approve(taskId, requestId, decision, answers);
    }
    const waterfall = this.pending.get(sessionId);
    if (!waterfall || waterfall.eventId !== requestId) {
      throw new ConnectorError("没有待审批的请求（可能已经处理过了）");
    }
    const link = this.web;
    if (!link) {
      throw new ConnectorError("和 DeepSeek Harness 网页端的连接断开了，请在电脑上处理这个请求");
    }
    switch (waterfall.request.type) {
      case "approval":
        await this.answerWaterfall(waterfall, link, decision === "allow");
        break;
      case "questions": {
        let items: DshQuestionAnswer[];
        if (decision === "deny") {
          items = DshTaskMapping.skipped(waterfall.request.questions);
        } else {
          items = DshTaskMapping.answers(waterfall.request.questions, answers ?? {});
          if (!items.some((item) => !isEmptyAnswer(item))) {
            throw new ConnectorError("请先选一个选项或写下回答");
          }
        }
        await this.answerWaterfall(waterfall, link, undefined, items);
        break;
      }
      default:
        throw new ConnectorError("认不出这个请求，请在电脑上处理");
    }
    return { taskId, retainsLiveOwnership: this.isLive(sessionId) };
  }

  async interrupt(taskId: string): Promise<ConnectorOutcome> {
    const sessionId = sessionIdOf(taskId);
    if (this.acp.isRunningTurn(taskId)) return this.acp.interrupt(taskId);
    const link = this.web;
    const running = this.isLive(sessionId) || this.webSessions.get(sessionId)?.running === true;
    if (!link || !running) throw new ConnectorError("这个会话现在没有在运行");
    try {
      await link.client.cancel(sessionId);
    } catch (error) {
      throw webFailure(error);
    }
    // 这一轮由 follow 流里的 `turn/end`（aborted）收尾并交还所有权。
    return { taskId, retainsLiveOwnership: this.isLive(sessionId) };
  }

  private async followUpOverWeb(
    sessionId: string,
    taskId: string,
    prompt: string,
    link: WebLink,
  ): Promise<ConnectorOutcome> {
    let accepted: boolean;
    try {
      const generation = this.toolsContextGeneration;
      const context = await this.toolsContext(taskId);
      if (generation !== this.toolsContextGeneration || this.web?.generation !== link.generation) {
        throw DshWebError.disconnected();
      }
      accepted = await link.client.prompt(
        sessionId,
        context ? context.prompt(prompt) : prompt,
        (context ? DshToolsContext.requestPrefix : "botbus-") + randomUUID(),
      );
    } catch (error) {
      throw webFailure(error);
    }
    if (!accepted) throw new ConnectorError("DeepSeek Harness 网页端没有接受这条消息");
    // 发出去之后 web 断了：不再记"在跑"，那份状态没人收尾。
    if (this.web?.generation !== link.generation) {
      return { taskId, retainsLiveOwnership: false };
    }
    if (!this.webRunning.has(sessionId)) {
      this.expecting.set(sessionId, this.now().getTime());
      const state = this.live.get(sessionId) ?? new DshLiveState();
      state.running = true;
      state.turnEnd = undefined;
      this.live.set(sessionId, state);
      this.scheduleExpectationTimeout(sessionId);
    }
    await this.publishLive(sessionId);
    return { taskId, retainsLiveOwnership: this.isLive(sessionId) };
  }

  private async toolsContext(taskId: string): Promise<DshToolsContext | undefined> {
    if (process.platform === "win32") return undefined;
    const generation = this.toolsContextGeneration;
    const configuration = this.tools();
    if (!configuration || !isUsable(configuration)) return undefined;
    const token = this.registry.issue(taskId);
    const injection = new AgentToolsInjection(configuration, token);
    const isClosed = () => this.isShutDown || !this.observing;
    if (isClosed() || generation !== this.toolsContextGeneration) throw DshWebError.disconnected();
    const existing = this.toolsContexts.get(taskId);
    if (
      existing &&
      existing.configuration.cliPath === injection.configuration.cliPath &&
      existing.configuration.toolsURL === injection.configuration.toolsURL &&
      existing.token === injection.token
    ) {
      return existing;
    }
    if (existing) {
      this.toolsContexts.delete(taskId);
      await existing.shutdown();
    }
    if (isClosed() || generation !== this.toolsContextGeneration) throw DshWebError.disconnected();
    if (this.toolsContexts.size >= TaskContextRegistry.maxTokens) {
      const oldest = this.toolsContexts.keys().next().value;
      if (oldest !== undefined) {
        const context = this.toolsContexts.get(oldest);
        this.toolsContexts.delete(oldest);
        await context?.shutdown();
      }
    }
    if (isClosed() || generation !== this.toolsContextGeneration) throw DshWebError.disconnected();
    const raced = this.toolsContexts.get(taskId);
    if (raced && raced.token === injection.token) return raced;
    const context = new DshToolsContext(injection);
    this.toolsContexts.set(taskId, context);
    return context;
  }

  private async closeToolsContexts(): Promise<void> {
    this.toolsContextGeneration += 1;
    const contexts = [...this.toolsContexts.values()];
    this.toolsContexts.clear();
    for (const context of contexts) await context.shutdown();
  }

  private async answerWaterfall(
    waterfall: import("./web-messages.js").DshWaterfall,
    link: WebLink,
    allow?: boolean,
    answers?: readonly DshQuestionAnswer[],
  ): Promise<void> {
    try {
      if (answers) {
        await link.client.answerQuestions(link.clientId, waterfall.eventId, answers);
      } else {
        await link.client.answerApproval(link.clientId, waterfall.eventId, allow ?? false);
      }
    } catch (error) {
      throw webFailure(error);
    }
    const current = this.pending.get(waterfall.sessionId);
    if (current?.eventId === waterfall.eventId) {
      this.pending.delete(waterfall.sessionId);
      await this.publishLive(waterfall.sessionId);
    }
  }

  // MARK: - 对话记录

  async entries(taskId: string, limit: number): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    return this.transcript(taskId, limit);
  }

  async transcript(taskId: string, limit: number): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const sessionId = sessionIdOf(taskId);
    // 交还写锁后桌面可能已经续聊，内存里的"完整"记录不再代表最新历史。
    if (this.acp.isInProcess(taskId)) {
      const complete = this.acp.completeTranscript(taskId, limit);
      if (complete) return complete;
    }
    let failure: unknown;
    const file = await this.logFile(sessionId);
    if (file) {
      try {
        const log = await this.decoder().read(file);
        return DshTranscriptParser.window(log.events, limit, log.truncated);
      } catch (error) {
        failure = error;
      }
    }
    const link = this.web;
    if (link) {
      try {
        const page = await link.client.latestPage(sessionId, Math.min(Math.max(limit * 3, 30), 200));
        return DshTranscriptParser.window(page.events, limit, page.hasMore);
      } catch (error) {
        failure = webFailure(error);
      }
    }
    throw failure instanceof Error ? failure : new ConnectorError("没找到这个 DeepSeek Harness 会话的记录");
  }

  /** 会话日志文件：扫盘见过就用它的；否则在 `sessions/<项目>/<会话>/` 里找。 */
  private async logFile(sessionId: string): Promise<string | undefined> {
    const known = this.scanned?.get(sessionId)?.logFile ?? this.logFiles.get(sessionId);
    if (known && existsSync(known)) return known;
    let projects: string[];
    try {
      projects = readdirSync(this.paths.sessionsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.paths.sessionsDirectory, entry.name));
    } catch {
      return undefined;
    }
    for (const project of projects) {
      const file = await DshSessionFiles.logFile(join(project, sessionId));
      if (file) {
        this.logFiles.set(sessionId, file);
        return file;
      }
    }
    for (const project of projects) {
      let names: string[];
      try {
        names = readdirSync(project);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.includes("~") || decodeSegment(name) !== sessionId) continue;
        const file = await DshSessionFiles.logFile(join(project, name));
        if (file) {
          this.logFiles.set(sessionId, file);
          return file;
        }
      }
    }
    return undefined;
  }

  private decoder(): DshTranscriptDecoder {
    if (this.explicitDecoder) return this.explicitDecoder;
    return new DshTranscriptDecoder({ node: this.installation()?.node ?? null } satisfies DshTranscriptDecoderOptions);
  }

  // MARK: - web

  private async connectWeb(): Promise<void> {
    while (this.connecting) await this.connecting;
    if (this.web || !this.observing || this.isShutDown) return;
    const attempt = this.attemptWebConnection();
    this.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = undefined;
    }
  }

  private async attemptWebConnection(): Promise<void> {
    if (this.web || !this.observing || this.isShutDown) return;
    const instances = this.locateWeb(this.paths, this.listing);
    if (instances.length === 0) {
      this.webAuthProblem = undefined;
      return;
    }
    const secret = this.loadSecret(this.paths);
    if (!secret) {
      this.webAuthProblem = "读不到 DeepSeek Harness 网页端的登录密钥，连不上网页端";
      this.nextConnectAttempt = this.now().getTime() + this.timing.authRetry;
      return;
    }
    let unauthorized = false;
    for (const instance of instances) {
      for (const port of instance.ports) {
        const result = await this.attach(port, instance.pid, instance.isDesktopHost, secret);
        if (result === "connected") {
          this.webAuthProblem = undefined;
          return;
        }
        if (result === "unauthorized") unauthorized = true;
        if (this.web) return;
      }
    }
    if (unauthorized) {
      this.webAuthProblem = "DeepSeek Harness 网页端拒绝了 BotBus 的登录，只能读电脑上的会话记录";
      this.nextConnectAttempt = this.now().getTime() + this.timing.authRetry;
    }
  }

  /** 握手、订 `$events`、等 `ready`、拉一次列表。失败就关掉这条 mux。 */
  private async attach(
    port: number,
    pid: number,
    isDesktopHost: boolean,
    secret: Buffer,
  ): Promise<"connected" | "unauthorized" | "failed"> {
    const client = new DshWebClient({
      endpoint: new DshWebEndpoint(port),
      secret,
      http: this.http,
      now: this.now,
    });
    const mux = DshWebMux.fromClient(client, this.webSocket);
    try {
      await mux.connect();
    } catch (error) {
      return error instanceof DshWebError && error.kind === "unauthorized" ? "unauthorized" : "failed";
    }
    let events;
    try {
      events = await mux.openEvents();
    } catch {
      mux.close();
      return "failed";
    }
    this.webGeneration += 1;
    const generation = this.webGeneration;
    let settled = false;
    const ready: ReadyBox = {
      resolve: () => undefined,
      reject: () => undefined,
    };
    const readyPromise = new Promise<string>((resolve, reject) => {
      ready.resolve = (clientId) => {
        if (settled) return;
        settled = true;
        resolve(clientId);
      };
      ready.reject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });
    void this.consumeEvents(events, generation, ready);
    const timeout = this.delay(this.timing.readyTimeout);
    let clientId: string | undefined;
    try {
      clientId = await Promise.race([readyPromise, timeout.promise.then(() => undefined)]);
    } catch {
      clientId = undefined;
    }
    timeout.cancel();
    if (!clientId || generation !== this.webGeneration || this.web || !this.observing) {
      await mux.close();
      return "failed";
    }
    // 先记下连接再拉列表：期间到的 status / waterfall 照常处理，列表随后按最新的覆盖。
    this.web = { generation, pid, client, mux, clientId, isDesktopHost };
    mux.setOnClose(() => this.webLost(generation));
    let list;
    try {
      list = await client.listSessions();
    } catch (error) {
      await this.webLost(generation);
      return error instanceof DshWebError && error.kind === "unauthorized" ? "unauthorized" : "failed";
    }
    if (this.web?.generation !== generation || !this.observing) return "failed";
    this.lastPing = this.now().getTime();
    this.log("info", `connected to dsh web on port ${port}`);
    this.applyList(list);
    this.hasBaseline = true;
    // 连着 web 期间盘上的结果只会越来越旧：断开之后要重新扫过才拿来对账。
    this.scanned = undefined;
    for (const sessionId of this.webRunning) this.startFollow(sessionId);
    await this.reconcile();
    await this.updateHealth();
    return "connected";
  }

  /** `$events` 的读循环：第一条 `ready` 交给 `attach`，之后逐条处理。 */
  private async consumeEvents(
    stream: { items: AsyncIterable<unknown> },
    generation: number,
    ready: ReadyBox,
  ): Promise<void> {
    try {
      for await (const item of stream.items) {
        const frame = eventsFrameFromJson(item);
        if (frame.type === "ready") {
          ready.resolve(frame.clientId);
          continue;
        }
        await this.handle(frame, generation);
      }
    } catch {
      // 流结束（web 关了、连接断了）就当断开。
    }
    ready.reject(DshWebError.disconnected());
    await this.webLost(generation);
  }

  private async handle(frame: DshEventsFrame, generation: number): Promise<void> {
    const link = this.web;
    if (!link || link.generation !== generation) return;
    switch (frame.type) {
      case "emit":
        await this.handleEmit(frame.emit);
        break;
      case "waterfall": {
        const waterfall = frame.waterfall;
        if (waterfall.request.type === "other") return;
        this.pending.set(waterfall.sessionId, waterfall);
        this.startFollow(waterfall.sessionId);
        await this.publishLive(waterfall.sessionId);
        break;
      }
      case "cancel": {
        const sessionId = [...this.pending.entries()].find(([, value]) => value.eventId === frame.eventId)?.[0];
        if (!sessionId) return;
        this.pending.delete(sessionId);
        await this.publishLive(sessionId);
        await this.settleIfIdle(sessionId);
        break;
      }
      default:
        break;
    }
  }

  private async handleEmit(emit: import("./web-messages.js").DshSessionEmit): Promise<void> {
    switch (emit.type) {
      case "added":
        this.webSessions.set(emit.summary.sessionId, emit.summary);
        if (emit.summary.running) {
          this.webRunning.add(emit.summary.sessionId);
          this.startFollow(emit.summary.sessionId);
        }
        await this.reconcile();
        break;
      case "removed": {
        const sessionId = emit.sessionId;
        this.webSessions.delete(sessionId);
        this.webRunning.delete(sessionId);
        this.pending.delete(sessionId);
        this.expecting.delete(sessionId);
        if (this.claimed.has(DshTaskMapping.identity.taskId(sessionId))) {
          await this.settleIfIdle(sessionId, true);
        } else {
          await this.reconcile();
        }
        break;
      }
      case "status": {
        const sessionId = emit.sessionId;
        if (emit.running) {
          this.webRunning.add(sessionId);
          this.expecting.delete(sessionId);
          this.cancelSettle(sessionId);
          this.markWebRunning(sessionId);
          this.startFollow(sessionId);
          await this.publishLive(sessionId);
        } else {
          this.webRunning.delete(sessionId);
          this.expecting.delete(sessionId);
          const state = this.live.get(sessionId);
          if (state?.running && state.turnEnd === undefined) {
            this.scheduleSettle(sessionId, this.timing.settleGrace);
          } else {
            await this.settleIfIdle(sessionId, true);
          }
        }
        break;
      }
      case "activity":
        if (!this.webSessions.has(emit.sessionId)) await this.refreshWebList();
        break;
      default:
        break;
    }
  }

  private async refreshWebList(): Promise<void> {
    const link = this.web;
    if (!link) return;
    this.lastListRefresh = this.now().getTime();
    try {
      const list = await link.client.listSessions();
      if (this.web?.generation !== link.generation) return;
      this.applyList(list);
      for (const sessionId of this.webRunning) this.startFollow(sessionId);
      await this.reconcile();
    } catch (error) {
      if (error instanceof DshWebError && error.kind === "unauthorized") {
        this.webAuthProblem = "DeepSeek Harness 网页端拒绝了 BotBus 的登录，只能读电脑上的会话记录";
        await this.webLost(link.generation);
      } else {
        this.log("error", `dsh session/list failed: ${webCategory(error)}`);
      }
    }
  }

  private applyList(list: readonly import("./web-messages.js").DshWebSessionSummary[]): void {
    this.lastListRefresh = this.now().getTime();
    this.webSessions.clear();
    for (const summary of list) if (!this.webSessions.has(summary.sessionId)) this.webSessions.set(summary.sessionId, summary);
    this.webRunning.clear();
    for (const summary of list) if (summary.running) this.webRunning.add(summary.sessionId);
  }

  /** web 断了：任务留着，实时认领一律交还，退回扫盘。 */
  private async webLost(generation: number): Promise<void> {
    const link = this.web;
    if (!link || link.generation !== generation) return;
    this.web = undefined;
    // 实时状态在第一个 await 之前一次清干净。
    const released = this.detachLive();
    await link.mux.close();
    this.log("info", "dsh web connection closed");
    await this.release(released);
    if (!this.observing || this.isShutDown) return;
    await this.scanDisk();
    await this.reconcile();
    await this.updateHealth();
  }

  private async dropWeb(): Promise<void> {
    this.webGeneration += 1;
    const link = this.web;
    this.web = undefined;
    const released = this.detachLive();
    await link?.mux.close();
    await this.release(released);
  }

  /** web 没了：实时状态一次清干净，返回要交还的任务 id。 */
  private detachLive(): Set<string> {
    for (const follow of this.follows.values()) follow.cancel();
    this.follows.clear();
    for (const cancel of this.settleTimers.values()) cancel();
    this.settleTimers.clear();
    for (const cancel of this.expectationTimers.values()) cancel();
    this.expectationTimers.clear();
    this.webRunning.clear();
    this.webSessions.clear();
    this.pending.clear();
    this.expecting.clear();
    for (const state of this.live.values()) state.running = false;
    const ids = new Set(this.claimed);
    this.claimed.clear();
    return ids;
  }

  private async release(ids: ReadonlySet<string>): Promise<void> {
    for (const id of ids) {
      if (this.claimed.has(id)) continue;
      this.host.releaseLive(id);
    }
  }

  // MARK: - follow

  /** 只给 web 已经在跑（或挂着请求）的会话开 follow。 */
  private startFollow(sessionId: string): void {
    if (this.follows.has(sessionId)) return;
    const link = this.web;
    if (!link) return;
    if (this.webRunning.has(sessionId)) this.markWebRunning(sessionId);
    const handle: FollowHandle = { id: randomUUID(), cancelled: false, cancel: () => undefined };
    this.follows.set(sessionId, handle);
    const generation = link.generation;
    void (async () => {
      try {
        const stream = await link.mux.follow(sessionId, 20);
        handle.cancel = () => {
          void link.mux.cancel(stream.id);
        };
        if (handle.cancelled) {
          handle.cancel();
        }
        for await (const item of stream.items) {
          if (handle.cancelled || !this.follows.has(sessionId)) break;
          await this.handleFollow(sessionId, followFrameFromJson(item), generation, handle.id);
        }
      } catch {
        // 流自己断了（会话被删、web 出错）：下面按 followEnded 处理。
      }
      await this.followEnded(sessionId, handle.id);
    })();
  }

  /** web 说这个会话开跑了：记成在跑、这一轮的收尾未知。 */
  private markWebRunning(sessionId: string): void {
    const state = this.live.get(sessionId) ?? new DshLiveState();
    state.running = true;
    state.turnEnd = undefined;
    this.live.set(sessionId, state);
  }

  private async followEnded(sessionId: string, id: string): Promise<void> {
    if (this.follows.get(sessionId)?.id !== id) return;
    this.follows.delete(sessionId);
    if (!this.webRunning.has(sessionId)) await this.settleIfIdle(sessionId, true);
  }

  private async handleFollow(
    sessionId: string,
    frame: DshFollowFrame,
    generation: number,
    followId: string,
  ): Promise<void> {
    // 已经收尾之后才轮到的帧不算数。
    if (this.web?.generation !== generation || this.follows.get(sessionId)?.id !== followId) return;
    const state = this.live.get(sessionId) ?? new DshLiveState();
    const before = state.clone();
    let decided: string[] = [];
    switch (frame.type) {
      case "snapshot":
        decided = applyEvents(state, frame.events);
        // snapshot 里最后一轮还开着才算在跑；web 说在跑的以 web 为准。
        state.running = DshTranscriptParser.hasOpenTurn(frame.events) || this.webRunning.has(sessionId);
        {
          // 0.2.x 的审批在事件里；快照里还没 decided 的那条要变成待审批。
          const approval = [...frame.events]
            .reverse()
            .map((event) => approvalWaterfallFromEvent(sessionId, event))
            .find((item) => item !== undefined && state.approvals.has(item.eventId));
          if (approval) this.pending.set(sessionId, approval);
        }
        break;
      case "event": {
        const call = state.apply(frame.event);
        if (call !== undefined) decided = [call];
        const approval = approvalWaterfallFromEvent(sessionId, frame.event);
        if (approval && state.approvals.has(approval.eventId)) this.pending.set(sessionId, approval);
        break;
      }
      default:
        return;
    }
    this.live.set(sessionId, state);
    let changed = !liveStateEqual(state, before);
    const waterfall = this.pending.get(sessionId);
    if (waterfall) {
      const callId = waterfall.request.type === "approval" ? waterfall.request.callId : undefined;
      if (callId !== undefined && decided.includes(callId)) {
        this.pending.delete(sessionId);
        changed = true;
      } else if (!state.running && before.running) {
        // 这一轮都结束了，挂着的请求不会再有人等。
        this.pending.delete(sessionId);
        changed = true;
      }
    }
    if (!changed) return;
    await this.publishLive(sessionId);
    if (!state.running) await this.settleIfIdle(sessionId);
  }

  /** `api-session/status false` 之后等 `turn/end`。 */
  private scheduleSettle(sessionId: string, delayMs: number): void {
    this.cancelSettle(sessionId);
    this.settleTimers.set(
      sessionId,
      this.schedule(delayMs, () => this.abandonTurn(sessionId)),
    );
  }

  private cancelSettle(sessionId: string): void {
    const cancel = this.settleTimers.get(sessionId);
    if (!cancel) return;
    cancel();
    this.settleTimers.delete(sessionId);
  }

  private async abandonTurn(sessionId: string): Promise<void> {
    this.settleTimers.delete(sessionId);
    const state = this.live.get(sessionId);
    if (this.webRunning.has(sessionId) || !state || !state.running) {
      await this.settleIfIdle(sessionId, true);
      return;
    }
    state.running = false;
    state.turnEnd = { kind: "interrupted" };
    state.updatedAt = this.now();
    this.live.set(sessionId, state);
    await this.settleIfIdle(sessionId, true);
  }

  private scheduleExpectationTimeout(sessionId: string): void {
    const sentAt = this.expecting.get(sessionId);
    this.expectationTimers.get(sessionId)?.();
    this.expectationTimers.set(
      sessionId,
      this.schedule(this.timing.promptStartTimeout, async () => {
        this.expectationTimers.delete(sessionId);
        await this.expectationTimedOut(sessionId, sentAt);
      }),
    );
  }

  private async expectationTimedOut(sessionId: string, sentAt: number | undefined): Promise<void> {
    if (sentAt === undefined || this.expecting.get(sessionId) !== sentAt) return;
    this.expecting.delete(sessionId);
    await this.settleIfIdle(sessionId, true);
  }

  /** 这一轮收尾了（或宽限到了）：停 follow、写最终状态、交还所有权。 */
  private async settleIfIdle(sessionId: string, force = false): Promise<void> {
    if (this.webRunning.has(sessionId) || this.pending.has(sessionId) || this.expecting.has(sessionId)) return;
    if (force) {
      const state = this.live.get(sessionId);
      if (state) state.running = false;
    }
    if (this.live.get(sessionId)?.running === true) return;
    this.cancelSettle(sessionId);
    const follow = this.follows.get(sessionId);
    if (follow) {
      follow.cancelled = true;
      follow.cancel();
      this.follows.delete(sessionId);
    }
    const taskId = DshTaskMapping.identity.taskId(sessionId);
    if (!this.claimed.has(taskId)) {
      // 没认领过（列表里一直没有它）：对一次账，列表拉到的就进来了。
      await this.reconcile();
      return;
    }
    await this.publishLive(sessionId);
    this.claimed.delete(taskId);
    this.host.releaseLive(taskId);
    await this.reconcile();
  }

  private isLive(sessionId: string): boolean {
    return (
      this.webRunning.has(sessionId) ||
      this.pending.has(sessionId) ||
      this.expecting.has(sessionId) ||
      this.live.get(sessionId)?.running === true
    );
  }

  /** 认领并写一条实时记录。列表里还没有这个会话时借 store 里已有的记录补 cwd 与标题。 */
  private async publishLive(sessionId: string): Promise<void> {
    const generation = this.web?.generation;
    if (generation === undefined) return;
    const taskId = DshTaskMapping.identity.taskId(sessionId);
    let facts = this.webSessions.get(sessionId) ? factsFromWeb(this.webSessions.get(sessionId)!) : undefined;
    if (!facts && this.web && (this.webSessions.get(sessionId)?.blank ?? true)) {
      // 刚建的会话在列表里还是空白（或还没进列表）：开跑之后重新拉一次就有了。
      await this.refreshWebList();
      const summary = this.webSessions.get(sessionId);
      facts = summary ? factsFromWeb(summary) : undefined;
    }
    if (!facts) {
      const existing = this.host.task(taskId);
      if (existing) {
        facts = {
          sessionId,
          cwd: existing.projectPath,
          title: existing.title,
          createdAt: DshTaskMapping.date(existing.startedAt),
          updatedAt: DshTaskMapping.date(existing.updatedAt) ?? this.now(),
          webRunning: false,
          openTurnRecent: false,
        };
      }
    }
    if (!facts) return;
    const acpRecord = this.acp.staticTasks().find((task) => task.id === taskId);
    if (this.web?.generation !== generation) return;
    if (!this.claimed.has(taskId)) {
      this.claimed.add(taskId);
      this.host.claimLive(taskId);
    }
    if (this.web?.generation !== generation || !this.claimed.has(taskId)) return;
    facts.webRunning = this.webRunning.has(sessionId);
    const task: DshTaskRecord = DshTaskMapping.record({
      facts,
      live: this.live.get(sessionId),
      pending: this.pending.get(sessionId),
      acp: acpRecord,
      controllable: true,
      now: this.now(),
    });
    task.agentId = this.host.agentId;
    this.upsertTask(task, this.hasBaseline);
  }

  // MARK: - 扫盘与对账

  private async scanDisk(): Promise<void> {
    const found = await this.scanner.scan();
    this.scanned = new Map();
    for (const summary of found) if (!this.scanned.has(summary.sessionId)) this.scanned.set(summary.sessionId, summary);
    this.hasBaseline = true;
  }

  /** `.dsh` 的全量对账。拿到完整列表（web 或扫盘）之前不对账。 */
  async reconcile(): Promise<void> {
    if (!this.hasBaseline || !this.observing || this.isShutDown) return;
    this.reconcileGeneration += 1;
    const generation = this.reconcileGeneration;
    const current = this.now();
    let base: ReturnType<typeof factsFromScanned>[];
    if (this.web) {
      base = [...this.webSessions.values()].flatMap((summary) => {
        const facts = factsFromWeb(summary);
        if (!facts) return [];
        facts.webRunning = this.webRunning.has(summary.sessionId);
        return [facts];
      });
    } else {
      // web 刚断、还没重新扫盘：拿空底子对账会把会话都当成消失了。
      if (!this.scanned) return;
      base = [...this.scanned.values()].map((summary) => factsFromScanned(summary, current));
    }
    const controllable = this.web !== undefined || this.installation() !== null;
    let acpTasks = [...this.acp.staticTasks()];
    if (await this.forgetDeletedAcpSessions(acpTasks, base)) acpTasks = [...this.acp.staticTasks()];
    const records = DshTaskMapping.merged({
      base,
      acp: acpTasks,
      live: this.live,
      controllable,
      now: current,
    });
    if (generation !== this.reconcileGeneration || !this.hasBaseline || !this.observing) return;
    const ids = new Set(records.map((task) => task.id));
    for (const task of records) {
      task.agentId = this.host.agentId;
      if (this.claimed.has(task.id) || this.host.isLive(task.id)) continue;
      this.upsertTask(task, true);
    }
    // `// PORT:` 上游由 TaskStore.reconcile 摘掉消失的任务；这里在 host 接口上自己做，跳过实时认领的。
    for (const task of this.host.tasks()) {
      if (task.source !== "dsh" || ids.has(task.id) || this.claimed.has(task.id)) continue;
      if (this.host.isLive(task.id)) continue;
      const sessionId = DshTaskMapping.identity.sessionId(task.id);
      if (sessionId && this.live.get(sessionId)?.running) continue;
      this.host.remove(task.id);
    }
    for (const project of SessionFormatting.projects(records, this.host.agentId)) {
      this.host.rememberProject(project as BusProject);
    }
  }

  /** 只有 ACP 记着、底子里没有的会话：会话目录在磁盘上也没了，就是在电脑上删了。 */
  private async forgetDeletedAcpSessions(
    acpTasks: readonly BusTask[],
    base: readonly ReturnType<typeof factsFromScanned>[],
  ): Promise<boolean> {
    const inBase = new Set(base.map((facts) => facts.sessionId));
    const candidates = acpTasks.flatMap((task) => {
      if (task.source !== "dsh") return [];
      const sessionId = DshTaskMapping.identity.sessionId(task.id);
      return sessionId && !inBase.has(sessionId) ? [sessionId] : [];
    });
    if (candidates.length === 0) {
      this.acp.noteSeen(inBase);
      return false;
    }
    const started = this.now().getTime();
    const onDisk = await DshSessionScanner.sessionIdsOnDisk(this.paths.sessionsDirectory);
    if (!onDisk) return false;
    const keep = new Set([...onDisk, ...inBase]);
    return this.acp.forgetDeleted({ notIn: keep, updatedAfter: 0, updatedBefore: started });
  }

  // MARK: - 健康

  private async acpHealthChanged(status: DshHealthStatus, message?: string): Promise<void> {
    this.acpHealth = status === "ok" ? undefined : { status, message };
    await this.updateHealth();
  }

  private async updateHealth(): Promise<void> {
    let health: { status: DshHealthStatus; message?: string };
    if (this.webAuthProblem) {
      health = { status: "degraded", message: this.webAuthProblem };
    } else if (this.acpHealth) {
      health = this.acpHealth;
    } else if (this.installation() === null) {
      health = {
        status: "degraded",
        message: this.web
          ? "没找到 dsh 可执行文件：电脑上的会话能看能续聊，但不能从手机新建任务"
          : "没找到 dsh 可执行文件，只能看电脑上的会话",
      };
    } else {
      health = { status: "ok" };
    }
    if (this.lastHealth?.status === health.status && this.lastHealth.message === health.message) return;
    this.lastHealth = health;
    await this.onHealth(health.status, health.message);
  }

  // MARK: - 小工具

  private delay(ms: number): { promise: Promise<void>; cancel: () => void } {
    let cancelled = false;
    const promise = this.sleep(ms).then(() => {
      if (cancelled) return undefined;
      return undefined;
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  private schedule(ms: number, action: () => void | Promise<void>): () => void {
    let cancelled = false;
    void (async () => {
      await this.sleep(ms);
      if (cancelled) return;
      try {
        await action();
      } catch (error) {
        this.log("debug", `dsh timer failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }
}

/** web 的错误 → 给手机的错误。dsh 回的文本可能带会话内容，只给界面。 */
export function webFailure(error: unknown): Error {
  if (!(error instanceof DshWebError)) return error instanceof Error ? error : new Error(String(error));
  return new ConnectorError(error.errorDescription, { containsPrivateDetail: error.containsPrivateDetail });
}

function webCategory(error: unknown): string {
  return error instanceof DshWebError ? error.logCategory : "other";
}

function sessionIdOf(taskId: string): string {
  const sessionId = DshTaskMapping.identity.sessionId(taskId);
  if (!sessionId) throw new ConnectorError(`任务 id 不属于 DeepSeek Harness：${taskId}`);
  return sessionId;
}

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

// MARK: - 内置 ACP 后端（最小 JSON-RPC peer）

export class AcpSessionBusyError extends ConnectorError {
  constructor(message = "这个会话正开在电脑上的 DeepSeek Harness 里") {
    super(message);
  }
}

export class AcpTranscriptUnavailableError extends ConnectorError {
  constructor(message = "本机没有这个会话的对话记录") {
    super(message);
  }
}

type AcpCapabilities = {
  loadSession: boolean;
  resume: boolean;
  images: boolean;
};

type AcpPermissionOption = { optionId: string; name: string; kind: string };

type AcpToolCall = {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: string;
  contentText?: string;
};

type PendingPermission = {
  rpcId: number | string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
  requestId: string;
  kind: "command" | "fileChange" | "permission";
  questions?: { id: string; question: string; header?: string; multiSelect?: true; options: { label: string }[] }[];
  resolve: (outcome: { selected?: string; cancelled?: boolean }) => void;
};

type AcpSession = {
  sessionId: string;
  cwd: string;
  record: DshTaskRecord;
  transcript: AcpTranscriptState;
  running: boolean;
  turnText: string;
  pending?: PendingPermission;
  tools: Map<string, AcpToolCall>;
  titleLocked: boolean;
  statusBeforePending: "idle" | "running" | "completed" | "failed" | "interrupted" | "waitingApproval" | "waitingInput";
  promptRecordedThisTurn: boolean;
  loaded: boolean;
  turnToken?: number;
};

/** ACP 的对话记录：`session/update` 一条条拼出来。 */
class AcpTranscriptState {
  static readonly maxEntries = 500;
  private readonly items: Array<{ id: string; role: "user" | "agent" | "tool"; text: string; createdAt: string }> = [];
  private turn = 0;
  private segment = 0;
  private pendingNewTurn = false;
  isComplete = false;

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  startTurn(): void {
    this.pendingNewTurn = true;
  }

  appendText(role: "user" | "agent", text: string, createdAt: string): void {
    if (!text) return;
    const last = this.items.at(-1);
    if (last && last.role === role && !this.pendingNewTurn) {
      last.text += text;
      return;
    }
    if (role === "user" || this.pendingNewTurn) {
      this.turn += 1;
      this.segment = 0;
    }
    this.segment += 1;
    this.pendingNewTurn = false;
    this.items.push({ id: `${this.turn}-${this.segment}`, role, text, createdAt });
    this.trim();
  }

  tool(call: AcpToolCall, createdAt: string): void {
    const id = `tool-${call.toolCallId}`;
    const text = call.title ?? call.kind ?? "tool";
    const index = this.items.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.items[index].text = text;
      return;
    }
    this.items.push({ id, role: "tool", text, createdAt });
    this.trim();
  }

  entries(): TranscriptEntry[] {
    return this.items.map((item) => ({
      message: {
        id: item.id,
        role: item.role,
        text: item.role === "tool" ? truncateMessage(item.text, 200) : item.text.trim(),
        createdAt: item.createdAt,
      },
      images: [],
      pathCandidates: [],
    }));
  }

  private trim(): void {
    if (this.items.length > AcpTranscriptState.maxEntries) {
      this.items.splice(0, this.items.length - AcpTranscriptState.maxEntries);
    }
  }
}

type NativeAcpOptions = {
  now?: () => Date;
  clientVersion?: string;
  sessionInfo?: (taskId: string) => { cwd?: string } | undefined;
  /** Agent 工具注入：新建会话时把 `botbus` MCP server 挂给 dsh。 */
  tools?: () => AgentToolsConfiguration | null;
  registry?: TaskContextRegistry;
  /** 一条 ACP 会话记录变了（写 store 用）。 */
  onTask?: (task: DshTaskRecord) => void;
  /** ACP 一轮的所有权：与 `TaskStore.claimLive` / `releaseLive` 对应。 */
  claim?: (taskId: string) => void;
  release?: (taskId: string) => void;
  onTasksChanged?: () => void;
  onHealth?: (status: DshHealthStatus, message?: string) => void;
  log?: (level: "debug" | "info" | "error", message: string) => void;
};

/**
 * 最小 ACP 后端。
 *
 * 没有复用 `src/connectors/runtime.ts` 的 `AcpProcess`：它面向"一个进程一个 connector"的
 * 全局单例，permission 请求与 session/update 只能经一个黑盒回调转出来，且自带 10 分钟空闲杀进程，
 * 与 dsh 需要的 "idleTimeout: 0（一轮结束立刻释放写锁）" 和按会话状态对账对不上。
 * 这里按 `JSONRPCPeer.swift` 的按行 JSON-RPC 与 `AcpSession.swift` 的状态规则实现足够 dsh 用的部分。
 */
export class NativeAcpBackend implements AcpBackend {
  private spec: DshAcpSpec | undefined;
  private peer: AcpLinePeer | undefined;
  private capabilities: AcpCapabilities = { loadSession: false, resume: false, images: false };
  private readonly sessions = new Map<string, AcpSession>();
  private readonly seen = new Set<string>();
  private turnCounter = 0;
  private stopped = false;
  private shuttingDown = false;
  private readonly now: () => Date;
  private readonly clientVersion: string;
  private readonly sessionInfo?: (taskId: string) => { cwd?: string } | undefined;
  private readonly tools?: () => AgentToolsConfiguration | null;
  private readonly registry?: TaskContextRegistry;
  private readonly onTask: (task: DshTaskRecord) => void;
  private readonly claimLive: (taskId: string) => void;
  private readonly releaseLive: (taskId: string) => void;
  private readonly claimedIds = new Set<string>();
  private readonly onTasksChanged: () => void;
  private readonly onHealth: (status: DshHealthStatus, message?: string) => void;
  private readonly log: (level: "debug" | "info" | "error", message: string) => void;

  constructor(options: NativeAcpOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.clientVersion = options.clientVersion ?? "1.0.0";
    this.sessionInfo = options.sessionInfo;
    this.tools = options.tools;
    this.registry = options.registry;
    this.onTask = options.onTask ?? (() => undefined);
    this.claimLive = options.claim ?? (() => undefined);
    this.releaseLive = options.release ?? (() => undefined);
    this.onTasksChanged = options.onTasksChanged ?? (() => undefined);
    this.onHealth = options.onHealth ?? (() => undefined);
    this.log = options.log ?? (() => undefined);
  }

  async update(spec: DshAcpSpec): Promise<void> {
    const changed = JSON.stringify(spec) !== JSON.stringify(this.spec);
    this.spec = spec;
    if (!changed) return;
    // 安装位置变了：空闲时换下一代进程；这一轮还在跑就等它结束。
    if (this.peer && !this.hasRunningTurn()) await this.killPeer();
  }

  async start(projectPath: string, _prompt: string): Promise<ConnectorOutcome> {
    const peer = await this.ensureRunning("DeepSeek Harness 没有配置启动命令，没法从手机新建任务");
    const injection = this.toolsInjection();
    const result = await this.call(peer, "session/new", {
      cwd: projectPath,
      mcpServers: injection ? [mcpServerJson(injection)] : [],
    });
    const sessionId = stringValue(record(result).sessionId);
    if (!sessionId) throw new ConnectorError("DeepSeek Harness 没有返回会话 id");
    const state = this.newSession(sessionId, projectPath);
    state.transcript.isComplete = true;
    state.loaded = true;
    if (injection) this.registry?.bind(injection.token, state.record.id);
    return this.beginTurn(state, _prompt);
  }

  async followUp(taskId: string, prompt: string): Promise<ConnectorOutcome> {
    const sessionId = sessionIdOf(taskId);
    const existing = this.sessions.get(sessionId);
    if (existing?.turnToken !== undefined) {
      throw new ConnectorError("这个会话正在运行，等它这一轮结束再续聊");
    }
    const peer = await this.ensureRunning("DeepSeek Harness 没有配置启动命令，只能在电脑上继续这个会话");
    let state = existing;
    if (!state || !state.loaded) {
      const cwd = state?.cwd ?? this.sessionInfo?.(taskId)?.cwd;
      if (!cwd) throw new ConnectorError(`本机没有这个任务：${taskId}`);
      state = state ?? this.newSession(sessionId, cwd);
      await this.loadIfNeeded(peer, state);
    }
    return this.beginTurn(state, prompt);
  }

  async approve(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome> {
    const sessionId = sessionIdOf(taskId);
    const state = this.sessions.get(sessionId);
    const pending = state?.pending;
    if (!state || !pending || pending.requestId !== requestId) {
      throw new ConnectorError("没有待审批的请求（可能已经处理过了）");
    }
    const optionId = optionIdFor(pending, decision, answers);
    if (!optionId) {
      throw new ConnectorError(
        `DeepSeek Harness 没有提供「${decision === "allow" ? "允许" : "拒绝"}」选项`,
      );
    }
    state.pending = undefined;
    state.record.pendingRequest = undefined;
    state.record.status = state.running ? "running" : state.statusBeforePending;
    state.record.updatedAt = protocolTimestamp(this.now());
    this.peer?.respond(pending.rpcId, { outcome: { outcome: "selected", optionId } });
    this.emit(state);
    return { taskId, retainsLiveOwnership: state.running };
  }

  async interrupt(taskId: string): Promise<ConnectorOutcome> {
    const sessionId = sessionIdOf(taskId);
    const state = this.sessions.get(sessionId);
    if (!state || state.turnToken === undefined) {
      throw new ConnectorError("这个会话现在没有在 BotBus 里运行，只能在电脑上中断");
    }
    if (state.pending) {
      const pending = state.pending;
      state.pending = undefined;
      state.record.pendingRequest = undefined;
      state.record.status = "running";
      state.record.updatedAt = protocolTimestamp(this.now());
      this.peer?.respond(pending.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit(state);
    }
    state.turnToken = -1; // 标记：被我们取消的一轮，收尾记 interrupted。
    this.peer?.notify("session/cancel", { sessionId });
    return { taskId, retainsLiveOwnership: true };
  }

  isInProcess(taskId: string): boolean {
    const sessionId = DshTaskMapping.identity.sessionId(taskId);
    if (!sessionId) return false;
    const state = this.sessions.get(sessionId);
    return state !== undefined && (state.turnToken !== undefined || state.loaded);
  }

  isRunningTurn(taskId: string): boolean {
    const sessionId = DshTaskMapping.identity.sessionId(taskId);
    if (!sessionId) return false;
    const state = this.sessions.get(sessionId);
    return state?.turnToken !== undefined || state?.pending !== undefined;
  }

  completeTranscript(taskId: string, limit: number): { entries: TranscriptEntry[]; hasMore: boolean } | undefined {
    const sessionId = DshTaskMapping.identity.sessionId(taskId);
    if (!sessionId) return undefined;
    const state = this.sessions.get(sessionId);
    if (!state || !state.transcript.isComplete || state.transcript.isEmpty) return undefined;
    return latestWindow(state.transcript.entries(), limit);
  }

  staticTasks(): BusTask[] {
    const current = this.now().getTime();
    return [...this.sessions.values()]
      .filter((state) => current - (DshTaskMapping.date(state.record.updatedAt)?.getTime() ?? 0) <= SessionFormatting.recentWindow)
      .map((state) => ({ ...state.record }));
  }

  noteSeen(ids: ReadonlySet<string>): void {
    for (const id of ids) this.seen.add(id);
  }

  forgetDeleted(options: { notIn: ReadonlySet<string>; updatedAfter: number; updatedBefore: number }): boolean {
    let removed = false;
    for (const [sessionId, state] of [...this.sessions]) {
      if (options.notIn.has(sessionId)) continue;
      const updated = DshTaskMapping.date(state.record.updatedAt)?.getTime() ?? 0;
      if (updated < options.updatedAfter || updated > options.updatedBefore) continue;
      this.sessions.delete(sessionId);
      removed = true;
    }
    return removed;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.killPeer();
    for (const taskId of [...this.claimedIds]) this.releaseTask(taskId);
    this.sessions.clear();
  }

  async stopSubprocess(): Promise<void> {
    await this.killPeer();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.stop();
  }

  // MARK: - 内部

  /** `session/new` 的 `mcpServers`：配置可用且 CLI 可执行时才注入。 */
  private toolsInjection(): AgentToolsInjection | undefined {
    const configuration = this.tools?.();
    if (!configuration || !isUsable(configuration) || !this.registry) return undefined;
    return new AgentToolsInjection(configuration, this.registry.issue());
  }

  private newSession(sessionId: string, cwd: string): AcpSession {
    const timestamp = protocolTimestamp(this.now());
    const projectName = SessionFormatting.projectName(cwd);
    const recordTask: DshTaskRecord = {
      id: DshTaskMapping.identity.taskId(sessionId),
      agentId: "",
      source: "dsh",
      title: projectName || sessionId,
      projectPath: cwd,
      projectName,
      status: "idle",
      origin: "watch",
      controllable: true,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    const state: AcpSession = {
      sessionId,
      cwd,
      record: recordTask,
      transcript: new AcpTranscriptState(),
      running: false,
      turnText: "",
      tools: new Map(),
      titleLocked: false,
      statusBeforePending: "idle",
      promptRecordedThisTurn: false,
      loaded: false,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private async loadIfNeeded(peer: AcpLinePeer, state: AcpSession): Promise<void> {
    try {
      if (this.capabilities.resume) {
        await this.call(peer, "session/resume", { sessionId: state.sessionId, cwd: state.cwd });
      } else if (this.capabilities.loadSession) {
        state.transcript.isComplete = true;
        await this.call(peer, "session/load", { sessionId: state.sessionId, cwd: state.cwd });
      } else {
        throw new AcpTranscriptUnavailableError();
      }
      state.loaded = true;
    } catch (error) {
      if (error instanceof AcpSessionBusyError) throw error;
      if (error instanceof AcpTranscriptUnavailableError) throw error;
      throw error;
    }
  }

  private beginTurn(state: AcpSession, prompt: string): ConnectorOutcome {
    const timestamp = protocolTimestamp(this.now());
    state.transcript.startTurn();
    state.transcript.appendText("user", prompt, timestamp);
    const line = SessionFormatting.singleLine(prompt);
    if (!state.titleLocked && line) {
      state.record.title = SessionFormatting.truncate(line, SessionFormatting.titleLimit);
      state.titleLocked = true;
    }
    state.running = true;
    state.turnText = "";
    state.pending = undefined;
    state.promptRecordedThisTurn = prompt.length > 0;
    state.record.pendingRequest = undefined;
    state.record.status = "running";
    state.record.updatedAt = timestamp;
    this.claimTask(state.record.id);
    this.emit(state);
    const peer = this.peer;
    if (!peer) throw new ConnectorError("DeepSeek Harness 进程不可用");
    const token = (this.turnCounter += 1);
    state.turnToken = token;
    void (async () => {
      try {
        const result = await this.call(peer, "session/prompt", {
          sessionId: state.sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
        this.finishTurn(state.sessionId, token, stringValue(record(result).stopReason), undefined);
      } catch (error) {
        this.finishTurn(state.sessionId, token, undefined, describeAcpError(error));
      }
    })();
    return {
      taskId: state.record.id,
      retainsLiveOwnership: true,
      runsUnderBotBus: true,
    };
  }

  private finishTurn(sessionId: string, token: number, stopReason: string | undefined, error: string | undefined): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    // interrupt 把 token 置 -1：那一轮据此记 interrupted。
    const cancelledByUs = state.turnToken === -1;
    if (!cancelledByUs && state.turnToken !== token) return;
    state.turnToken = undefined;
    state.running = false;
    state.promptRecordedThisTurn = false;
    if (state.pending) {
      this.peer?.respond(state.pending.rpcId, { outcome: { outcome: "cancelled" } });
      state.pending = undefined;
    }
    state.record.pendingRequest = undefined;
    const reply = state.turnText.trim();
    if (cancelledByUs) {
      state.record.status = "interrupted";
    } else if (error !== undefined) {
      state.record.status = "failed";
      state.record.lastMessage = SessionFormatting.truncate(
        reply.length > 0 ? reply : error,
        SessionFormatting.lastMessageLimit,
      );
    } else {
      switch (stopReason ?? "end_turn") {
        case "cancelled":
          state.record.status = "interrupted";
          break;
        case "refusal":
        case "max_tokens":
        case "max_turn_requests":
          state.record.status = "failed";
          break;
        default:
          state.record.status = "completed";
          break;
      }
      if (reply.length > 0) {
        state.record.lastMessage = SessionFormatting.truncate(reply, SessionFormatting.lastMessageLimit);
      } else if (stopReason === "refusal") {
        state.record.lastMessage = "agent 拒绝继续这次请求";
      } else if (stopReason === "max_tokens") {
        state.record.lastMessage = "回复达到了 token 上限";
      } else if (stopReason === "max_turn_requests") {
        state.record.lastMessage = "这一轮的模型请求次数超过了上限";
      }
    }
    state.turnText = "";
    state.record.updatedAt = protocolTimestamp(this.now());
    this.emit(state);
    this.releaseTask(state.record.id);
    // dsh 的 ACP `idleTimeout: 0`：一轮结束立刻释放写锁，供桌面接聊。
    void this.killPeer();
  }

  private claimTask(taskId: string): void {
    if (this.claimedIds.has(taskId)) return;
    this.claimedIds.add(taskId);
    this.claimLive(taskId);
  }

  private releaseTask(taskId: string): void {
    if (!this.claimedIds.delete(taskId)) return;
    this.releaseLive(taskId);
  }

  private emit(state: AcpSession): void {
    this.onTask(state.record);
    this.onTasksChanged();
  }

  private hasRunningTurn(): boolean {
    return [...this.sessions.values()].some((state) => state.turnToken !== undefined);
  }

  private async ensureRunning(missingCommand: string): Promise<AcpLinePeer> {
    if (this.shuttingDown) throw new ConnectorError("DeepSeek Harness 连接器已退出");
    if (this.peer?.alive) return this.peer;
    const spec = this.spec;
    if (!spec?.executable) throw new ConnectorError(missingCommand);
    const environment = environmentFor(spec.executable, spec.environment);
    const peer = new AcpLinePeer({
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (id, method, params) => this.handleRequest(id, method, params),
      onExit: () => {
        if (this.peer === peer) this.peer = undefined;
      },
      log: this.log,
    });
    try {
      await peer.spawn(spec.executable, spec.arguments, environment);
      const init = await peer.call(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "agent-host", version: this.clientVersion },
        },
        60_000,
      );
      if (record(init).protocolVersion !== 1) {
        peer.kill();
        throw new ConnectorError("DeepSeek Harness 的 ACP 版本不受支持");
      }
      const agent = record(record(init).agentCapabilities);
      const prompt = record(agent.promptCapabilities);
      const sessionCaps = record(agent.sessionCapabilities);
      this.capabilities = {
        loadSession: agent.loadSession === true,
        resume: sessionCaps.resume !== undefined && sessionCaps.resume !== null && sessionCaps.resume !== false,
        images: prompt.image === true,
      };
      this.peer = peer;
      this.onHealth("ok");
      return peer;
    } catch (error) {
      peer.kill();
      this.onHealth("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async call(peer: AcpLinePeer, method: string, params: unknown): Promise<unknown> {
    try {
      return await peer.call(method, params, 10 * 60_000);
    } catch (error) {
      if (error instanceof AcpSessionBusyError) throw error;
      if (error instanceof AcpRpcError) {
        throw new ConnectorError(error.message, { containsPrivateDetail: true });
      }
      throw error;
    }
  }

  private async killPeer(): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    this.peer = undefined;
    peer.kill();
    for (const state of this.sessions.values()) {
      state.loaded = false;
      if (state.turnToken !== undefined) {
        state.turnToken = undefined;
        state.running = false;
        state.record.status = "interrupted";
        state.record.updatedAt = protocolTimestamp(this.now());
        this.emit(state);
        this.releaseTask(state.record.id);
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const sessionId = stringValue(record(params).sessionId);
    if (!sessionId) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const update = record(record(params).update);
    const kind = stringValue(update.sessionUpdate) ?? "";
    const timestamp = protocolTimestamp(this.now());
    switch (kind) {
      case "user_message_chunk": {
        // 这一轮的 prompt 是 BotBus 自己发的，agent 常把它原样回显：直接丢掉。
        if (state.running && state.promptRecordedThisTurn) return;
        state.transcript.appendText("user", contentText(update.content), timestamp);
        break;
      }
      case "agent_message_chunk": {
        const text = contentText(update.content);
        state.transcript.appendText("agent", text, timestamp);
        if (state.running) state.turnText += text;
        break;
      }
      case "tool_call": {
        const call = acpToolCall(update);
        if (!call) return;
        state.tools.set(call.toolCallId, call);
        state.transcript.tool(call, timestamp);
        break;
      }
      case "tool_call_update": {
        const call = acpToolCall(update);
        if (!call) return;
        const merged = mergeToolCall(state.tools.get(call.toolCallId), call);
        state.tools.set(call.toolCallId, merged);
        state.transcript.tool(merged, timestamp);
        break;
      }
      case "session_info_update": {
        const title = SessionFormatting.singleLine(stringValue(update.title) ?? "");
        if (!title) return;
        state.record.title = SessionFormatting.truncate(title, SessionFormatting.titleLimit);
        state.titleLocked = true;
        break;
      }
      default:
        break;
    }
  }

  private handleRequest(id: number | string, method: string, params: unknown): void {
    if (method !== "session/request_permission") {
      this.peer?.respondError(id, -32601, "method not found");
      return;
    }
    const sessionId = stringValue(record(params).sessionId);
    const state = sessionId ? this.sessions.get(sessionId) : undefined;
    const toolCall = acpToolCall(record(record(params).toolCall));
    if (!sessionId || !state || !toolCall) {
      this.peer?.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const options = (arrayValue(record(params).options) ?? []).flatMap((item) => {
      const json = record(item);
      const optionId = stringValue(json.optionId);
      const kind = stringValue(json.kind);
      if (optionId === undefined || kind === undefined) return [];
      return [{ optionId, name: stringValue(json.name) ?? optionId, kind }];
    });
    const previous = state.pending;
    if (previous) this.peer?.respond(previous.rpcId, { outcome: { outcome: "cancelled" } });
    const placeholder: PendingPermission = {
      rpcId: id,
      toolCall,
      options,
      requestId: toolCall.toolCallId,
      kind: pendingKind(toolCall),
      resolve: () => undefined,
    };
    const request: DshPendingRequest = {
      id: toolCall.toolCallId,
      kind: pendingKind(toolCall),
      summary: SessionFormatting.truncate(
        SessionFormatting.singleLine(toolCall.title ?? toolCall.kind ?? "工具调用"),
        200,
      ),
      detail: detailOf(toolCall)
        ? SessionFormatting.truncate(detailOf(toolCall) ?? "", SessionFormatting.detailLimit)
        : undefined,
      questions: scopeQuestions(options),
    };
    state.statusBeforePending = state.record.status as AcpSession["statusBeforePending"];
    state.pending = placeholder;
    state.record.status = "waitingApproval";
    state.record.pendingRequest = request;
    state.record.updatedAt = protocolTimestamp(this.now());
    this.emit(state);
  }
}

/** `session/request_permission` 的「允许范围」（同 ACP 的 scopeQuestion）。 */
function scopeQuestions(options: readonly AcpPermissionOption[]) {
  const allow = allowOptions(options);
  if (allow.length === 0) return undefined;
  return [
    {
      id: "scope",
      question: "允许范围",
      options: allow.map((option) => ({ label: option.name })),
    },
  ];
}

function allowOptions(options: readonly AcpPermissionOption[]): AcpPermissionOption[] {
  const seen = new Set<string>();
  const result: AcpPermissionOption[] = [];
  for (const kind of ["allow_once", "allow_always"]) {
    for (const option of options) {
      if (option.kind !== kind || seen.has(option.name)) continue;
      seen.add(option.name);
      result.push(option);
    }
  }
  return result;
}

function optionIdFor(
  pending: PendingPermission,
  decision: "allow" | "deny",
  answers?: Record<string, string[]>,
): string | undefined {
  if (decision === "allow" && answers) {
    const picked = answers.scope;
    if (picked?.length === 1) {
      const hit = allowOptions(pending.options).find((option) => option.name === picked[0]);
      if (hit) return hit.optionId;
    }
  }
  const order = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const hit = pending.options.find((option) => option.kind === kind);
    if (hit) return hit.optionId;
  }
  return undefined;
}

function pendingKind(call: AcpToolCall): "command" | "fileChange" | "permission" {
  switch (call.kind) {
    case "execute":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "fileChange";
    default:
      return "permission";
  }
}

function detailOf(call: AcpToolCall): string | undefined {
  return call.rawInput ?? call.contentText;
}

/** `AcpMcpServer.botbus`：ACP 的 `env` 是 `[{name,value}]` 数组。 */
function mcpServerJson(injection: AgentToolsInjection): Record<string, unknown> {
  return {
    name: AgentToolsInjection.mcpServerName,
    command: injection.configuration.cliPath,
    args: ["mcp"],
    env: Object.keys(injection.environment)
      .sort()
      .map((name) => ({ name, value: injection.environment[name] })),
  };
}

function acpToolCall(value: unknown): AcpToolCall | undefined {
  const json = record(value);
  const toolCallId = stringValue(json.toolCallId);
  if (!toolCallId) return undefined;
  return {
    toolCallId,
    title: stringValue(json.title),
    kind: stringValue(json.kind),
    status: stringValue(json.status),
    rawInput: rawInputText(json.rawInput),
    contentText: contentTextOf(json.content),
  };
}

function mergeToolCall(previous: AcpToolCall | undefined, update: AcpToolCall): AcpToolCall {
  if (!previous) return update;
  return {
    toolCallId: previous.toolCallId,
    title: update.title ?? previous.title,
    kind: update.kind ?? previous.kind,
    status: update.status ?? previous.status,
    rawInput: update.rawInput ?? previous.rawInput,
    contentText: update.contentText ?? previous.contentText,
  };
}

function rawInputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function contentText(value: unknown): string {
  const block = record(value);
  return block.type === "text" ? stringValue(block.text) ?? "" : "";
}

function contentTextOf(value: unknown): string | undefined {
  const blocks = arrayValue(value);
  if (!blocks) return undefined;
  const texts = blocks.flatMap((item) => {
    const json = record(item);
    const text = stringValue(jsonPath(json, "content", "text")) ?? stringValue(json.text);
    return text !== undefined ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function describeAcpError(error: unknown): string {
  if (error instanceof ConnectorError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// MARK: - 按行 JSON-RPC peer

class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

type AcpPeerOptions = {
  onNotification: (method: string, params: unknown) => void;
  onRequest: (id: number | string, method: string, params: unknown) => void;
  onExit: () => void;
  log?: (level: "debug" | "info" | "error", message: string) => void;
};

class AcpLinePeer {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private stderrTail = "";
  alive = false;

  constructor(private readonly options: AcpPeerOptions) {}

  async spawn(executable: string, arguments_: readonly string[], environment: Record<string, string>): Promise<void> {
    const child = spawnExecutable(executable, [...arguments_], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.alive = true;
    child.stdin?.on("error", () => undefined);
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    }
    child.stderr?.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
    });
    child.on("exit", () => {
      this.alive = false;
      const detail = this.stderrTail.trim();
      this.failAll(new Error(detail ? `agent exited: ${detail}` : "agent exited"));
      this.options.onExit();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });
  }

  call(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  kill(): void {
    this.alive = false;
    const child = this.child;
    this.child = undefined;
    this.failAll(new Error("agent stopped"));
    if (!child || child.killed) return;
    // Windows 的 .cmd shim 起的是真子进程，child.kill() 只收掉 shim。
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    child.kill("SIGKILL");
  }

  private send(message: unknown): void {
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // child exited between writable check and write.
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof message.method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        this.options.onRequest(id, message.method, message.params);
      } else {
        this.options.onNotification(message.method, message.params);
      }
      return;
    }
    if (typeof id !== "number") return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    const error = message.error;
    if (isRecord(error)) {
      const code = typeof error.code === "number" ? error.code : -32603;
      const text = stringValue(error.message) ?? "ACP error";
      if (code === -32603 && isSessionLockError(text, error.data)) {
        waiter.reject(new AcpSessionBusyError(text));
      } else {
        waiter.reject(new AcpRpcError(code, text, error.data));
      }
      return;
    }
    waiter.resolve(message.result);
  }
}

function isSessionLockError(message: string, data: unknown): boolean {
  const marker = "already owned by an active write handle";
  const details = stringValue(record(data).details) ?? stringValue(data) ?? "";
  return details.includes(marker) || message.includes(marker);
}

// MARK: - 对话读取器

export type DshMessageReaderOptions = {
  /** 有连接器时优先用它（内存 → 读盘 → web）。 */
  connector?: DshConnector;
  paths?: DshPaths;
  installation?: () => DshInstallation | null;
  decoder?: DshTranscriptDecoder;
  /** 独立读取 web `session/page` 的客户端；不连 web 时不用。 */
  webClient?: () => DshWebClient | null;
};

/** `.dsh` 的对话记录：内存里齐全的 → 读盘 → web 的 `session/page`。只读，不认领、不 follow、不 resume。 */
export class DshMessageReader implements MessageReader {
  readonly kind = "dsh" as const;
  private readonly options: DshMessageReaderOptions;

  constructor(options: DshMessageReaderOptions = {}) {
    this.options = options;
  }

  async entries(taskId: string, limit: number): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const sessionId = sessionIdOf(taskId);
    if (this.options.connector) return this.options.connector.transcript(taskId, limit);
    const paths = this.options.paths ?? new DshPaths();
    const decoder = this.options.decoder ?? new DshTranscriptDecoder({ node: this.options.installation?.()?.node ?? null });
    let failure: unknown;
    const file = await findLogFile(paths.sessionsDirectory, sessionId);
    if (file) {
      try {
        const log = await decoder.read(file);
        return DshTranscriptParser.window(log.events, limit, log.truncated);
      } catch (error) {
        failure = error;
      }
    }
    const client = this.options.webClient?.();
    if (client) {
      try {
        const page = await client.latestPage(sessionId, Math.min(Math.max(limit * 3, 30), 200));
        return DshTranscriptParser.window(page.events, limit, page.hasMore);
      } catch (error) {
        failure = webFailure(error);
      }
    }
    throw failure instanceof Error ? failure : new ConnectorError("没找到这个 DeepSeek Harness 会话的记录");
  }
}

async function findLogFile(sessionsDirectory: string, sessionId: string): Promise<string | undefined> {
  let projects: string[];
  try {
    projects = readdirSync(sessionsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsDirectory, entry.name));
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const direct = await DshSessionFiles.logFile(join(project, sessionId));
    if (direct) return direct;
  }
  for (const project of projects) {
    let names: string[];
    try {
      names = readdirSync(project);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.includes("~") || decodeSegment(name) !== sessionId) continue;
      const file = await DshSessionFiles.logFile(join(project, name));
      if (file) return file;
    }
  }
  return undefined;
}

