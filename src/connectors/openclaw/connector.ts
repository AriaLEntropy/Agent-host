/**
 * OpenClaw 连接器：一条 Gateway WebSocket 既负责「看见」也负责「动手」。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/OpenClaw/OpenClawConnector.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * - **看见**：连上后 `sessions.subscribe`（顺带取回首屏会话列表）+
 *   `exec.approval.list` 补齐已挂起的审批，之后靠 `sessions.changed`、`chat`、
 *   `exec.approval.requested/resolved` 事件实时更新。
 * - **动手**：`sessions.create` + `chat.send` 新建，`chat.send` 续聊，
 *   `exec.approval.resolve` 审批，`chat.abort` 中断。
 *
 * **所有权一拿就不放**（同 ClaudeConnector）：OpenClaw 没有只读观察者——会话在
 * Gateway 的 SQLite 里，部分 transcript 行还是 zstd 压缩的，不读文件——本连接器是
 * 唯一权威，所有会话都 `claimLive` + `upsert`，列表里消失的显式 `remove`，
 * 项目按最近活动时间聚合后 `rememberProject`。
 *
 * **断线不清任务**：保留最后状态，`controllable` 置 false，经 `onHealth` 报 degraded；
 * 退避（1、2、4……60 秒）重连，每次重读配置（用户可能刚改了 token 或端口）。
 *
 * PORT: 宿主契约（`ConnectorHost`）没有 `setAgentWorkspace`、`notify: false` 与
 * `reconcile(projects:)` 的整套语义，这里按可用能力降级：
 * - 每次发布后把项目逐个 `rememberProject`，但不会删除已经消失的项目；
 * - 首屏/断线时无法抑制通知，只能跳过内容完全没变的记录，避免无意义的刷新；
 * - `outsideProject`（协议 2.6）由上游 store 计算，这里不写。
 */
import { randomUUID } from "node:crypto";
import type { BusPendingRequest, BusProject, BusTask } from "../../bus/store.js";
import { SESSION_HISTORY_WINDOW_MS } from "../session-window.js";
import {
  ConnectorError,
  rejectSelection,
  type ConnectorHost,
  type ConnectorKind,
  type ConnectorOutcome,
  type ImageSource,
  type ModelSelection,
  type TaskConnector,
} from "../ported/contract.js";
import { OpenClawConfig } from "./config.js";
import {
  OpenClawGateway,
  OpenClawGatewayError,
  OpenClawWebSocketTransport,
  defaultClientVersion,
  type WebSocketTransport,
} from "./gateway.js";
import { openClawTranscriptText } from "./message-reader.js";
import {
  boolValue,
  dateValue,
  firstString,
  isRecord,
  projectName,
  protocolTimestamp,
  stringValue,
  trimmedNonEmpty,
  truncateText,
} from "./values.js";

export type OpenClawHealthStatus = "ok" | "degraded";
export type OpenClawRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle";

export type OpenClawTiming = {
  initialBackoff: number;
  maxBackoff: number;
  /** `sessions.changed` 没带行时，攒多久再重新拉一次列表。 */
  refreshDelay: number;
  /** 重新拉列表失败后隔多久再拉。 */
  refreshRetryDelay: number;
  requestTimeout: number;
  challengeTimeout: number;
  pingInterval: number;
};

export const DEFAULT_OPENCLAW_TIMING: OpenClawTiming = {
  initialBackoff: 1,
  maxBackoff: 60,
  refreshDelay: 0.5,
  refreshRetryDelay: 10,
  requestTimeout: 15,
  challengeTimeout: 2,
  pingInterval: 30,
};

export type OpenClawConnectorOptions = {
  /** 每次重连都重新读一次配置（用户可能刚改了 token 或端口）。 */
  config?: () => OpenClawConfig;
  transport?: WebSocketTransport;
  clientVersion?: string;
  onHealth?: (
    status: OpenClawHealthStatus,
    error: string | null,
  ) => void | Promise<void>;
  now?: () => Date;
  sleep?: (seconds: number) => Promise<void>;
  timing?: Partial<OpenClawTiming>;
  /** 工厂是否立刻开始连接；默认 true（桌面 app 注册连接器时就会 start）。 */
  autoStart?: boolean;
};

export type OpenClawSession = {
  key: string;
  title: string;
  projectPath: string;
  /** 运行状态，不含审批——审批单独记在 approvals，合成 Task 时再叠上去。 */
  runStatus: OpenClawRunStatus;
  lastMessage?: string;
  startedAt: Date;
  updatedAt: Date;
};

export type OpenClawApproval = {
  id: string;
  sessionKey: string;
  command: string;
  cwd?: string;
  createdAt: Date;
  expiresAt?: Date;
};

export type OpenClawPendingOption = {
  label: string;
  description?: string;
};

export type OpenClawPendingQuestion = {
  id: string;
  question: string;
  options: OpenClawPendingOption[];
};

/** 审批上的「允许范围」（协议 2.14）。第一个是一次性允许。 */
export const OPENCLAW_SCOPE_QUESTION_ID = "scope";
export const OPENCLAW_ALLOW_ONCE_LABEL = "只这一次";
export const OPENCLAW_ALLOW_ALWAYS_LABEL = "以后都允许";
export const openClawScopeQuestion: OpenClawPendingQuestion = {
  id: OPENCLAW_SCOPE_QUESTION_ID,
  question: "允许范围",
  options: [
    { label: OPENCLAW_ALLOW_ONCE_LABEL },
    {
      label: OPENCLAW_ALLOW_ALWAYS_LABEL,
      description: "记进白名单，同样的命令以后不再问",
    },
  ],
};

const MAX_SESSIONS = 200;
const PENDING_SUMMARY_LIMIT = 300;
const TITLE_LIMIT = 80;
const LAST_MESSAGE_LIMIT = 500;
const DETAIL_LIMIT = 2000;
const RECENT_WINDOW_MS = SESSION_HISTORY_WINDOW_MS;
const IDLE_AFTER_MS = 24 * 3600 * 1000;

const LIST_PARAMS = {
  limit: MAX_SESSIONS,
  includeLastMessage: true,
  includeDerivedTitles: true,
} as const;

/** `openclaw:<sessionKey>`。sessionKey 自己带冒号（`agent:main:main`），只切第一个。 */
export function openClawTaskId(sessionKey: string): string {
  return `openclaw:${sessionKey}`;
}

/** `openclaw:<sessionKey>` → sessionKey；没有前缀时原样返回（与上游一致）。 */
export function openClawSessionKey(taskId: string): string {
  const prefix = "openclaw:";
  const key = taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
  if (key.trim().length === 0) throw new ConnectorError(`任务 id 不合法：${taskId}`);
  return key;
}

/**
 * `hasActiveRun` 是「这个会话此刻有没有在跑」的总开关；`status` 是最近一轮的生命周期
 * 投影（`queued|running|done|failed|killed|timeout`）。
 */
export function openClawRunStatus(
  status?: string,
  hasActiveRun?: boolean,
): OpenClawRunStatus {
  if (hasActiveRun === true) return "running";
  switch (status) {
    case "queued":
    case "running":
      // 说在跑、却明确没有活跃的 run：多半是 Gateway 重启丢了那一轮。
      return hasActiveRun === false ? "interrupted" : "running";
    case "done":
      return "completed";
    case "failed":
    case "timeout":
      return "failed";
    case "killed":
      return "interrupted";
    default:
      return "idle";
  }
}

/**
 * 一行 `SessionRow`（开放对象）。缺 `key` 或已归档的不要。
 * 行里没带最后一条消息时留给调用方沿用旧值。
 */
export function openClawSessionFromRow(
  row: unknown,
  workspace: string,
  current: Date,
): OpenClawSession | undefined {
  if (!isRecord(row)) return undefined;
  const key = stringValue(row["key"]);
  if (key === undefined || key.length === 0) return undefined;
  if (row["archived"] === true) return undefined;
  const updatedAt =
    dateValue(row["updatedAt"]) ??
    dateValue(row["lastActivityAt"]) ??
    dateValue(row["lastInteractionAt"]) ??
    current;
  const startedAt = dateValue(row["createdAt"]) ?? updatedAt;
  const title =
    firstTrimmed(
      row["label"],
      row["displayName"],
      row["derivedTitle"],
      row["autoLabel"],
    ) ?? key;
  // 会话的工作目录：任务 cwd 优先，其次 spawn 时的目录；都没有就是 agent 的默认工作区。
  const projectPath =
    firstTrimmed(
      row["workspaceDir"],
      row["spawnedCwd"],
      row["execCwd"],
      row["spawnedWorkspaceDir"],
    ) ?? workspace;
  const runStatus = openClawRunStatus(
    stringValue(row["status"]),
    boolValue(row["hasActiveRun"]),
  );
  let lastMessage = stringValue(row["lastMessagePreview"]);
  if (runStatus === "failed") {
    const error = stringValue(row["lastRunError"]);
    if (error !== undefined && error.trim().length > 0) lastMessage = error;
  }
  const truncated =
    lastMessage === undefined
      ? undefined
      : truncateText(lastMessage, LAST_MESSAGE_LIMIT);
  return {
    key,
    title: truncateText(title, TITLE_LIMIT),
    projectPath,
    runStatus,
    lastMessage: truncated && truncated.length > 0 ? truncated : undefined,
    startedAt,
    updatedAt,
  };
}

/**
 * `exec.approval.requested` 的 payload，或 `exec.approval.list` 的一项：
 * `{id, request:{command,cwd,sessionKey,…}, createdAtMs, expiresAtMs}`。
 * 挂不到会话上的（没有 sessionKey）与已过期的不要。
 */
export function openClawApprovalFrom(
  payload: Record<string, unknown>,
  current: Date,
): OpenClawApproval | undefined {
  const id = stringValue(payload["id"]);
  if (id === undefined || id.length === 0) return undefined;
  const nested = isRecord(payload["request"]) ? payload["request"] : undefined;
  const request = nested ?? payload;
  const plan = isRecord(request["systemRunPlan"]) ? request["systemRunPlan"] : undefined;
  const sessionKey = firstString(
    request["sessionKey"],
    plan?.["sessionKey"],
    payload["sessionKey"],
  );
  if (sessionKey === undefined) return undefined;
  const argvBlocks = Array.isArray(request["commandArgv"]) ? request["commandArgv"] : [];
  const argv = argvBlocks
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const command =
    firstTrimmed(request["command"], plan?.["commandText"], argv) ?? "执行命令";
  const cwd = firstString(request["cwd"], plan?.["cwd"]);
  const expiresAt = dateValue(payload["expiresAtMs"]);
  if (expiresAt !== undefined && expiresAt.getTime() <= current.getTime()) {
    return undefined;
  }
  return {
    id,
    sessionKey,
    command,
    cwd: cwd !== undefined && cwd.length > 0 ? cwd : undefined,
    createdAt: dateValue(payload["createdAtMs"]) ?? current,
    expiresAt,
  };
}

/**
 * 协议的 allow / deny + 手机选的范围 → `exec.approval.resolve` 的 `decision`。
 * 「以后都允许」要用户明确选中才给：OpenClaw 会把它写成绑定 argv 与工作目录的白名单条目。
 */
export function openClawGatewayDecision(
  decision: "allow" | "deny",
  answers?: Record<string, string[]>,
): "allow-once" | "allow-always" | "deny" {
  if (decision !== "allow") return "deny";
  const selected = answers?.[OPENCLAW_SCOPE_QUESTION_ID];
  return selected?.length === 1 && selected[0] === OPENCLAW_ALLOW_ALWAYS_LABEL
    ? "allow-always"
    : "allow-once";
}

export class OpenClawConnector implements TaskConnector {
  readonly kind: ConnectorKind = "openclaw";
  /** 会话跑在 OpenClaw 的 gateway 里，不是 BotBus 起的进程。 */
  readonly runsUnderBotBus = false;

  private readonly configProvider: () => OpenClawConfig;
  private readonly transport: WebSocketTransport;
  private readonly clientVersion: string;
  private readonly onHealth: (
    status: OpenClawHealthStatus,
    error: string | null,
  ) => void | Promise<void>;
  private readonly now: () => Date;
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly timing: OpenClawTiming;
  private readonly sleepers = new Set<() => void>();

  private sessions = new Map<string, OpenClawSession>();
  private approvals = new Map<string, OpenClawApproval>();
  /** 我们经 start 新建的会话：origin 记 watch。只在内存里，重启后按桌面会话显示。 */
  private readonly ownKeys = new Set<string>();
  /** 上一次推进 store 的任务 id，用来找出「这次没了」的。 */
  private published = new Set<string>();
  private gateway: OpenClawGateway | undefined;
  /** 正在握手、还没交给 this.gateway 的那条连接；stop() 时也要关掉。 */
  private connectingGateway: OpenClawGateway | undefined;
  private loop: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private lastHealth: { status: OpenClawHealthStatus; error: string | null } | undefined;
  private address: string;
  private workspace: string;

  constructor(
    private readonly host: ConnectorHost,
    options: OpenClawConnectorOptions = {},
  ) {
    const defaults = new OpenClawConfig();
    this.address = defaults.displayAddress;
    this.workspace = defaults.workspaceDirectory;
    this.configProvider = options.config ?? (() => OpenClawConfig.load());
    this.transport = options.transport ?? new OpenClawWebSocketTransport();
    this.clientVersion = options.clientVersion ?? defaultClientVersion();
    this.onHealth = options.onHealth ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.timing = { ...DEFAULT_OPENCLAW_TIMING, ...options.timing };
    this.sleep = options.sleep ?? ((seconds) => this.defaultSleep(seconds));
  }

  // MARK: - 生命周期

  /** 开始连 Gateway 并保持连接。幂等。 */
  start(): void;
  start(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome>;
  start(
    projectPath?: string,
    prompt?: string,
    images?: ImageSource[],
    selection?: ModelSelection,
  ): void | Promise<ConnectorOutcome> {
    if (projectPath === undefined) {
      this.begin();
      return;
    }
    if (prompt === undefined || images === undefined) {
      throw new ConnectorError("缺少新建任务需要的参数");
    }
    return this.startTask(projectPath, prompt, images, selection);
  }

  private begin(): void {
    if (this.loop !== undefined) return;
    this.stopped = false;
    const loop = this.runLoop().catch((error) => {
      console.error("[openclaw] 连接循环异常退出：", error);
    });
    this.loop = loop;
    void loop.finally(() => {
      if (this.loop === loop) this.loop = undefined;
    });
  }

  /** 断开并停止重连。任务留在 store 里但标成不可控。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.loop = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const wake of [...this.sleepers]) wake();
    const closing = this.gateway;
    const connecting = this.connectingGateway;
    this.gateway = undefined;
    this.connectingGateway = undefined;
    closing?.close();
    connecting?.close();
    this.publish();
  }

  get isConnected(): boolean {
    return this.gateway !== undefined;
  }

  /** 给 `OpenClawMessageReader` 用：复用这条已连上的连接读对话记录。 */
  async chatHistory(sessionKey: string, limit: number): Promise<unknown> {
    return this.connectedGateway().request("chat.history", { sessionKey, limit });
  }

  /** 把最近一次健康状态再报一遍（`ConnectorRegistry.refresh()` 会重置运行期状态）。 */
  async reannounceHealth(): Promise<void> {
    if (!this.lastHealth) return;
    await this.onHealth(this.lastHealth.status, this.lastHealth.error);
  }

  private defaultSleep(seconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, Math.max(0, seconds) * 1000);
      this.sleepers.add(wake);
    });
  }

  private async runLoop(): Promise<void> {
    let backoff = this.timing.initialBackoff;
    while (!this.stopped) {
      const config = this.configProvider();
      this.address = config.displayAddress;
      this.workspace = config.workspaceDirectory;
      const gateway = new OpenClawGateway(this.transport, {
        url: config.gatewayURL,
        token: config.token,
        password: config.password,
        clientVersion: this.clientVersion,
        requestTimeout: this.timing.requestTimeout,
        connectTimeout: 10,
        challengeTimeout: this.timing.challengeTimeout,
        pingInterval: this.timing.pingInterval,
      });

      let failure = `连不上 OpenClaw Gateway（${this.address}）`;
      this.connectingGateway = gateway;
      try {
        await gateway.connect();
        if (this.connectingGateway === gateway) this.connectingGateway = undefined;
        if (this.stopped) {
          gateway.close();
          return;
        }
        this.gateway = gateway;
        await this.bootstrap(gateway);
        await this.report("ok", null);
        backoff = this.timing.initialBackoff;
        // 首屏是基线：窗口内的完成 / 失败会话都在里面，逐条推送等于把一串私聊预览
        // 一次性发到手机上。
        this.publish(true);
        // 握手与首屏期间到达的事件都攒在流里，这里按序补上，再接着实时消费。
        for await (const event of gateway.events) {
          if (this.stopped) break;
          if (event.type !== "event") break;
          this.handle(event.name, event.payload);
        }
      } catch (error) {
        if (error instanceof OpenClawGatewayError) {
          switch (error.kind) {
            case "rejected":
            case "protocolMismatch":
              failure = error.message;
              break;
            case "requestFailed":
              failure = `OpenClaw Gateway 拒绝了请求：${error.message}`;
              break;
            default:
              break;
          }
          console.error(`[openclaw] OpenClaw Gateway 连接失败：${error.message}`);
        } else {
          console.error("[openclaw] OpenClaw Gateway 连接失败：", error);
        }
      }
      gateway.close();
      if (this.connectingGateway === gateway) this.connectingGateway = undefined;
      if (this.gateway === gateway) this.gateway = undefined;
      if (this.stopped) return;
      await this.report("degraded", failure);
      this.publish(true);
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, this.timing.maxBackoff);
    }
  }

  /** 首屏：订阅会话变化并取回列表，再补齐挂起的审批。 */
  private async bootstrap(gateway: OpenClawGateway): Promise<void> {
    let list: unknown;
    try {
      // 新版 Gateway 支持「订阅 + 首屏」一次完成，应答是 `{subscribed:true, list}`。
      const payload = await gateway.request("sessions.subscribe", LIST_PARAMS);
      list = isRecord(payload) ? payload["list"] : undefined;
    } catch (error) {
      if (!(error instanceof OpenClawGatewayError) || error.kind !== "requestFailed") {
        throw error;
      }
      // 老一点的只认空参数的订阅（闭合对象，多给键就拒）。
      await gateway.request("sessions.subscribe", {});
    }
    if (list === undefined || list === null) {
      list = await gateway.request("sessions.list", LIST_PARAMS);
    }
    this.applyList(list ?? null);

    try {
      const pending = await gateway.request("exec.approval.list", {});
      this.approvals = new Map();
      for (const entry of openClawArray(pending, "approvals")) {
        const approval = isRecord(entry)
          ? openClawApprovalFrom(entry, this.now())
          : undefined;
        if (approval) this.approvals.set(approval.id, approval);
      }
    } catch (error) {
      if (!(error instanceof OpenClawGatewayError) || error.kind !== "requestFailed") {
        throw error;
      }
      // 没拿到 `operator.approvals` 之类：只是看不到审批，会话照样能看能发。
      console.error(`[openclaw] exec.approval.list 失败：${error.message}`);
    }
  }

  private async report(
    status: OpenClawHealthStatus,
    error: string | null,
  ): Promise<void> {
    if (
      this.lastHealth &&
      this.lastHealth.status === status &&
      this.lastHealth.error === error
    ) {
      return;
    }
    this.lastHealth = { status, error };
    await this.onHealth(status, error);
  }

  // MARK: - 事件

  private handle(name: string, payload: unknown): void {
    switch (name) {
      case "sessions.changed": {
        const row = isRecord(payload) ? payload["session"] : undefined;
        const key = isRecord(row) ? stringValue(row["key"]) : undefined;
        if (!isRecord(row) || key === undefined) {
          // 整表失效、删除通知（只带 key 与旧 sessionId）：都靠重新拉列表收敛。
          this.scheduleRefresh();
          return;
        }
        const session = this.parse(row);
        if (session) this.merge(session);
        else this.sessions.delete(key);
        this.publish();
        return;
      }
      case "chat": {
        if (!isRecord(payload)) return;
        const key = stringValue(payload["sessionKey"]);
        if (key === undefined) return;
        const session = this.sessions.get(key);
        if (!session) {
          // 列表里还没有（新会话、或超出窗口的老会话又动了）：让列表去收敛。
          this.scheduleRefresh();
          return;
        }
        const before = { ...session };
        switch (stringValue(payload["state"])) {
          case "status":
          case "delta":
            session.runStatus = "running";
            break;
          case "final": {
            session.runStatus = "completed";
            const text = openClawTranscriptText(payload["message"]);
            if (text !== undefined) {
              session.lastMessage = truncateText(text, LAST_MESSAGE_LIMIT);
            }
            break;
          }
          case "aborted":
            session.runStatus = "interrupted";
            break;
          case "error": {
            session.runStatus = "failed";
            const text = stringValue(payload["errorMessage"]);
            if (text !== undefined && text.trim().length > 0) {
              session.lastMessage = truncateText(text, LAST_MESSAGE_LIMIT);
            }
            break;
          }
          default:
            return;
        }
        // delta 一秒几十条：状态没变就不碰 updatedAt，store 看到的记录不变。
        if (
          session.runStatus === before.runStatus &&
          session.lastMessage === before.lastMessage
        ) {
          return;
        }
        session.updatedAt = this.now();
        this.sessions.set(key, session);
        this.publish();
        return;
      }
      case "exec.approval.requested": {
        if (!isRecord(payload)) return;
        const approval = openClawApprovalFrom(payload, this.now());
        if (!approval) return;
        this.approvals.set(approval.id, approval);
        if (!this.sessions.has(approval.sessionKey)) this.scheduleRefresh();
        this.publish();
        return;
      }
      case "exec.approval.resolved": {
        const id = isRecord(payload) ? stringValue(payload["id"]) : undefined;
        if (id === undefined || !this.approvals.delete(id)) return;
        this.publish();
        return;
      }
      default:
        return;
    }
  }

  private scheduleRefresh(after?: number): void {
    if (this.refreshTimer !== undefined) return;
    const delay = after ?? this.timing.refreshDelay;
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = undefined;
        void this.refresh();
      },
      Math.max(0, delay) * 1000,
    );
  }

  /**
   * 重新拉一次列表。先清掉 refreshTimer 再发请求：请求期间来的事件会再排一次，
   * 不会被这次（可能已经过时的）应答吞掉——文档要求的 trailing refresh。
   */
  private async refresh(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) return;
    try {
      const list = await gateway.request("sessions.list", LIST_PARAMS);
      this.applyList(list);
      this.publish();
    } catch (error) {
      console.error("[openclaw] sessions.list 刷新失败：", error);
      // 还连着就过一会儿再拉（断开了由重连的 bootstrap 整表替换）。
      if (this.gateway !== undefined) {
        this.scheduleRefresh(this.timing.refreshRetryDelay);
      }
    }
  }

  // MARK: - 会话映射

  /** 用一份完整列表替换会话集合：窗口内、最多 200 条。行里没带最后一条消息时沿用旧值。 */
  private applyList(payload: unknown): void {
    const current = this.now();
    const cutoff = current.getTime() - RECENT_WINDOW_MS;
    const parsed = openClawArray(payload, "sessions")
      .map((row) => openClawSessionFromRow(row, this.workspace, current))
      .filter((session): session is OpenClawSession => session !== undefined)
      .filter((session) => session.updatedAt.getTime() >= cutoff)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, MAX_SESSIONS);
    const next = new Map<string, OpenClawSession>();
    for (const session of parsed) {
      if (session.lastMessage === undefined) {
        const previous = this.sessions.get(session.key);
        if (previous?.lastMessage !== undefined) session.lastMessage = previous.lastMessage;
      }
      next.set(session.key, session);
    }
    this.sessions = next;
  }

  private merge(incoming: OpenClawSession): void {
    if (incoming.lastMessage === undefined) {
      const previous = this.sessions.get(incoming.key);
      if (previous?.lastMessage !== undefined) incoming.lastMessage = previous.lastMessage;
    }
    this.sessions.set(incoming.key, incoming);
  }

  private parse(row: unknown): OpenClawSession | undefined {
    return openClawSessionFromRow(row, this.workspace, this.now());
  }

  // MARK: - 推进 store

  private record(
    session: OpenClawSession,
    connected: boolean,
    current: Date,
  ): BusTask {
    // 同一会话同时挂多条审批时先给最早的，手机上按到达顺序一条条批。
    const approval = [...this.approvals.values()]
      .filter(
        (item) =>
          item.sessionKey === session.key &&
          (item.expiresAt === undefined || item.expiresAt.getTime() > current.getTime()),
      )
      .sort(compareApprovals)[0];
    let status: string = session.runStatus;
    if (approval) {
      status = "waitingApproval";
    } else if (
      status === "completed" &&
      current.getTime() - session.updatedAt.getTime() > IDLE_AFTER_MS
    ) {
      status = "idle";
    }
    const pending: (BusPendingRequest & { questions: OpenClawPendingQuestion[] }) | undefined =
      approval
        ? {
            id: approval.id,
            kind: "command",
            summary: truncateText(approval.command, PENDING_SUMMARY_LIMIT),
            ...(approval.cwd !== undefined
              ? { detail: truncateText(`目录：${approval.cwd}`, DETAIL_LIMIT) }
              : {}),
            questions: [openClawScopeQuestion],
          }
        : undefined;
    return {
      id: openClawTaskId(session.key),
      agentId: this.host.agentId,
      source: "openclaw",
      title: session.title,
      projectPath: session.projectPath,
      projectName: projectName(session.projectPath),
      status,
      ...(session.lastMessage !== undefined ? { lastMessage: session.lastMessage } : {}),
      ...(pending !== undefined ? { pendingRequest: pending } : {}),
      origin: this.ownKeys.has(session.key) ? "watch" : "desktop",
      // 能不能发命令只取决于 Gateway 连着没有：chat.send 对在跑的会话是排队 / 插话。
      controllable: connected,
      startedAt: protocolTimestamp(session.startedAt),
      updatedAt: protocolTimestamp(session.updatedAt),
    };
  }

  /**
   * 把当前会话集合整体推进 store。
   *
   * 每次发布都先 `claimLive` 再 `upsert`；发布过的 id 里这次没了的显式 `remove`。
   * `silently` 保留上游签名；宿主没有 `notify:` 开关，只能跳过内容没变的记录。
   */
  publish(silently = false): void {
    void silently;
    const current = this.now();
    const connected = this.gateway !== undefined;
    const records = [...this.sessions.values()].map((session) =>
      this.record(session, connected, current),
    );
    const ids = new Set(records.map((record) => record.id));
    // 先把「这次推的是哪些」记下来：之后算删除集合时不会跟并发的 publish 打架。
    const removed = [...this.published].filter((id) => !ids.has(id));
    this.published = ids;
    for (const record of records) {
      this.host.claimLive(record.id);
      const existing = this.host.task(record.id);
      if (existing === undefined || !sameTask(existing, record)) {
        this.host.upsert(record);
      }
    }
    for (const id of removed) this.host.remove(id);

    // 对应上游 reconcile(source: .openclaw, tasks: [], …)：空任务列表只会删掉
    // observer 拥有的 id；我们是唯一权威，兜底清掉不再属于当前快照的任务。
    for (const task of this.host.tasks()) {
      if (task.source !== "openclaw" || ids.has(task.id)) continue;
      if (this.host.isLive(task.id)) continue;
      this.host.remove(task.id);
    }
    for (const project of projectsFrom(records, this.host.agentId)) {
      this.host.rememberProject(project);
    }
  }

  // MARK: - TaskConnector

  private async startTask(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    // 协议 2.9 的手机发图本期只接了 Codex 与 Claude；明说不支持。
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    rejectSelection(selection, "选模型");
    return this.explained(() => this.performStart(projectPath, prompt));
  }

  async followUp(
    taskId: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    rejectSelection(selection, "换模型");
    return this.explained(() => this.performFollowUp(taskId, prompt));
  }

  async approve(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome> {
    return this.explained(() =>
      this.performApprove(
        taskId,
        requestId,
        openClawGatewayDecision(decision, answers),
      ),
    );
  }

  async interrupt(taskId: string): Promise<ConnectorOutcome> {
    return this.explained(() => this.performInterrupt(taskId));
  }

  /** 上游默认实现：OpenClaw 不支持删除电脑端会话。 */
  async deleteTask(): Promise<void> {
    throw new ConnectorError("这个 Agent 不支持删除电脑端会话");
  }

  /** 上游默认实现：什么都不做。 */
  async discard(): Promise<void> {
    // no-op
  }

  /**
   * Gateway 的 `ok:false` 原文多是英文短句，手机上单看不知道是谁说的，补上来源。
   * 本机这一侧的错误（没连上、超时、断线）本来就是整句中文，原样放过。
   */
  private async explained(body: () => Promise<ConnectorOutcome>): Promise<ConnectorOutcome> {
    try {
      return await body();
    } catch (error) {
      if (error instanceof OpenClawGatewayError && error.kind === "requestFailed") {
        throw new ConnectorError(`OpenClaw 拒绝了这个操作：${error.message}`);
      }
      throw error;
    }
  }

  private async performStart(
    projectPath: string,
    prompt: string,
  ): Promise<ConnectorOutcome> {
    const gateway = this.connectedGateway();
    const path = projectPath.trim();
    let created: unknown;
    let usedPath = path;
    if (path.length === 0) {
      created = await gateway.request("sessions.create", {});
      usedPath = this.workspace;
    } else {
      try {
        created = await gateway.request("sessions.create", { cwd: path });
      } catch (error) {
        if (!(error instanceof OpenClawGatewayError) || error.kind !== "requestFailed") {
          throw error;
        }
        // 工作区之外的目录要 operator.admin，我们只申请了 read/write/approvals。
        // 退回默认工作区照样能跑，只是不在用户选的目录里。
        console.error(
          `[openclaw] sessions.create 带 cwd 失败，改用默认工作区：${error.message}`,
        );
        created = await gateway.request("sessions.create", {});
        usedPath = this.workspace;
      }
    }
    const createdRecord = isRecord(created) ? created : {};
    const key = stringValue(createdRecord["key"]);
    if (key === undefined || key.length === 0) {
      throw new ConnectorError("OpenClaw 没有返回新会话的 key");
    }
    const entry = isRecord(createdRecord["entry"]) ? createdRecord["entry"] : undefined;
    const reported = trimmedNonEmpty(entry?.["workspaceDir"]);
    if (reported !== undefined) usedPath = reported;
    this.ownKeys.add(key);
    const timestamp = this.now();
    const title = truncateText(prompt, TITLE_LIMIT);
    this.sessions.set(key, {
      key,
      title: title.length === 0 ? projectName(usedPath) : title,
      projectPath: usedPath,
      runStatus: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
    });
    try {
      await this.send(prompt, key, gateway);
    } catch (error) {
      const session = this.sessions.get(key);
      if (session) session.runStatus = "idle";
      this.publish();
      throw error;
    }
    this.publish();
    return { taskId: openClawTaskId(key), retainsLiveOwnership: true };
  }

  private async performFollowUp(
    taskId: string,
    prompt: string,
  ): Promise<ConnectorOutcome> {
    const key = openClawSessionKey(taskId);
    const gateway = this.connectedGateway();
    await this.send(prompt, key, gateway);
    const session = this.sessions.get(key);
    if (session) {
      session.runStatus = "running";
      session.updatedAt = this.now();
      this.publish();
    } else {
      this.scheduleRefresh();
    }
    return { taskId: openClawTaskId(key), retainsLiveOwnership: true };
  }

  private async performApprove(
    taskId: string,
    requestId: string,
    decision: string,
  ): Promise<ConnectorOutcome> {
    const key = openClawSessionKey(taskId);
    const gateway = this.connectedGateway();
    await gateway.request("exec.approval.resolve", { id: requestId, decision });
    this.approvals.delete(requestId);
    this.publish();
    return { taskId: openClawTaskId(key), retainsLiveOwnership: true };
  }

  private async performInterrupt(taskId: string): Promise<ConnectorOutcome> {
    const key = openClawSessionKey(taskId);
    const gateway = this.connectedGateway();
    await gateway.request("chat.abort", { sessionKey: key });
    const session = this.sessions.get(key);
    if (session) {
      session.runStatus = "interrupted";
      session.updatedAt = this.now();
      this.publish();
    }
    return { taskId: openClawTaskId(key), retainsLiveOwnership: true };
  }

  private async send(
    prompt: string,
    key: string,
    gateway: OpenClawGateway,
  ): Promise<void> {
    // idempotencyKey 每条新消息一个：Gateway 据此去重传输层重试，同一条命令的
    // 重试由分发器按 command.id 去重。
    await gateway.request("chat.send", {
      sessionKey: key,
      message: prompt,
      idempotencyKey: randomUUID(),
    });
  }

  private connectedGateway(): OpenClawGateway {
    if (!this.gateway) throw new ConnectorError("OpenClaw Gateway 没有连上");
    return this.gateway;
  }
}

function firstTrimmed(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = trimmedNonEmpty(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

function compareApprovals(left: OpenClawApproval, right: OpenClawApproval): number {
  const difference = left.createdAt.getTime() - right.createdAt.getTime();
  if (difference !== 0) return difference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** 列表形状宽松：可能是 `{sessions:[…]}` 这种信封，也可能直接是数组。 */
function openClawArray(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  const wrapped = isRecord(payload) ? payload[key] : undefined;
  return Array.isArray(wrapped) ? wrapped : [];
}

/** store 对不变的记录不发事件；宿主没有这个判断，这里自己比一次。 */
function sameTask(left: BusTask, right: BusTask): boolean {
  return (
    left.agentId === right.agentId &&
    left.title === right.title &&
    left.projectPath === right.projectPath &&
    left.projectName === right.projectName &&
    left.status === right.status &&
    left.lastMessage === right.lastMessage &&
    JSON.stringify(left.pendingRequest ?? null) ===
      JSON.stringify(right.pendingRequest ?? null) &&
    left.origin === right.origin &&
    left.controllable === right.controllable &&
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt
  );
}

/** 按每条会话的最近活动时间聚合出项目列表，最近的在前。 */
function projectsFrom(records: BusTask[], agentId: string): BusProject[] {
  const latest = new Map<string, string>();
  for (const record of records) {
    if (!record.projectPath) continue;
    const existing = latest.get(record.projectPath);
    if (existing !== undefined && existing >= record.updatedAt) continue;
    latest.set(record.projectPath, record.updatedAt);
  }
  return [...latest.entries()]
    .sort((left, right) =>
      left[1] < right[1] ? 1 : left[1] > right[1] ? -1 : 0,
    )
    .map(([path, lastUsedAt]) => ({
      agentId,
      path,
      name: projectName(path),
      lastUsedAt,
      pinned: false,
    }));
}
