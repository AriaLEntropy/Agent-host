// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeConnector.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { spawnSync, type ChildProcess } from "node:child_process";
import { spawnExecutable } from "../ported/spawn.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ConnectorError,
  nativeTaskId,
  taskIdFor,
  type ConnectorHost,
  type ConnectorOutcome,
  type ImageSource,
  type MessageReader,
  type ModelSelection,
  type TaskConnector,
} from "../ported/contract.js";
import type { BusPendingRequest, BusProject, BusTask } from "../../bus/store.js";
import {
  AgentToolsInjection,
  TaskContextRegistry,
  type AgentToolsConfiguration,
} from "./agent-tools.js";
import { ClaudeControlChannel, ClaudeControlOutput, parseClaudeControlRequest, type ClaudePermissionDecision } from "./claude-control.js";
import { ClaudeFailure } from "./claude-failure.js";
import {
  ClaudeAskedQuestions,
  ClaudeHookOutput,
  claudePaths,
  detectClaudeBinary,
  hasClaudeHome,
  parseClaudeHookEvent,
  syntheticHookEvent,
  summarizeToolInput,
  type ClaudeHookEvent,
  type ClaudePaths,
} from "./claude-hooks.js";
import { ClaudeLateRequest } from "./claude-late-answer.js";
import { ClaudeModels } from "./claude-models.js";
import {
  ClaudeMessageReader,
  deleteTranscript,
  narrationText,
  stripInjectedBlocks as stripInjected,
  transcriptURL,
} from "./claude-message-reader.js";
import {
  ClaudeSessionHistory,
  type ClaudeSessionEntry,
} from "./claude-session-history.js";
import {
  ClaudeDesktopSessionIndex,
  ClaudeSessionPresence,
  type ClaudeDesktopRecord,
} from "./claude-session-presence.js";
import {
  LAST_MESSAGE_LIMIT,
  TITLE_LIMIT,
  TitleSource,
  assistantText,
  protocolTimestamp,
  sortedJson,
  titleSourceReplaces,
  trimmed,
  type ClaudeFailureDiagnosis,
  type ClaudePendingRequest,
  type ModelOption,
  type TaskOrigin,
  type TaskStatus,
} from "./claude-shared.js";
import {
  LocalHookServer,
  LocalHookServerHold,
  NO_CONTENT,
  defaultSharedSecretOptions,
  nowReply,
  type LocalHookReply,
  type LocalHookRequest,
} from "./local-hook-server.js";
import { OneShot } from "./claude-one-shot.js";
import { StreamJSONReader, type StreamJSONResult } from "./stream-json-reader.js";

const EXITED_WITHOUT_SESSION_ID = "claude 退出了，没有拿到 session id";

/** `ClaudeConnector.runsUnderBotBus` 恒为 true。 */
export type ClaudeConnectorHost = ConnectorHost;

/** `ClaudeHookInstaller` 里宿主启动用到的两项；测试可注入假实现。 */
export type ClaudeHookInstallerLike = {
  isInstalled(paths: ClaudePaths, supportDirectory: string): boolean;
  upgradeIfNeeded(paths: ClaudePaths, supportDirectory: string): boolean;
};

export type ClaudeHostServicesState = "idle" | "starting" | "running" | "failed" | "stopped";

export type ClaudeHostServicesOptions = {
  /** hook 脚本、端口文件与密钥文件共用的目录。 */
  supportDirectory: string;
  /** 默认 `ClaudeHookInstaller`；测试注入假实现。 */
  installer: ClaudeHookInstallerLike;
  /** hook server 固定端口；null/不传 = 系统分配的高位端口。 */
  requestedPort?: number | null;
  /** 端口冲突时的重试次数（含第一次）；默认 3。 */
  portRetries?: number;
  /** 启动/升级失败的可观测日志；默认 console.warn。 */
  logger?: (message: string, error?: unknown) => void;
};

export type ClaudeConnectorOptions = {
  paths?: ClaudePaths;
  /** 每次现取 `claude` 可执行文件；null = 没装。 */
  binary?: () => string | null;
  now?: () => Date;
  tools?: () => AgentToolsConfiguration | null;
  registry?: TaskContextRegistry;
  /** 起进程前检查项目目录（macOS 文件夹授权 / 目录不存在）。 */
  diagnoseDirectory?: (path: string) => ClaudeFailureDiagnosis | null | undefined;
  /** 手机那一轮等审批的上限；默认 1800 秒。 */
  approvalTimeout?: number;
  /** 测试用短间隔。 */
  titleRetryDelays?: number[];
  turnEndCheckInterval?: number;
  presenceSweepInterval?: number;
  /** 探测进程可执行文件的重试（会话 id 超时）。 */
  sessionIDTimeout?: number;
  /** 项目开着自动批准（协议 3.3）时立刻放行。 */
  autoApproves?: (taskId: string, cwd: string) => boolean | Promise<boolean>;
  /** 模型列表变化（支持度来自本机 CLI）。返回是否变化。 */
  setModels?: (models: ModelOption[] | null) => boolean;
  broadcastSnapshot?: () => void;
  /** 默认写 host.upsert；`notify: false` 用于启动补历史的静默基线。 */
  upsert?: (task: BusTask, notify: boolean) => void;
  /**
   * 起 `claude -p` 前合并进子进程的环境。默认读 `~/.claude/settings.json`
   * 的 `env`（Claude Code 交互模式自己会读，子进程不会）。
   * 优先级：process.env < settings.env < 连接器注入的环境。
   */
  settingsEnv?: () => Record<string, string>;

  // -------------------------------------------------------------------------
  // 宿主服务（由 `createClaudeConnector` 消费；构造器本身不读这些字段）
  // -------------------------------------------------------------------------

  /** 构造后自动启动 hook server / 补历史 / presence / 收尾检测；默认 true。 */
  autoStart?: boolean;
  /** hook 脚本、端口与密钥的目录；默认 `defaultSupportDirectory()`。 */
  supportDirectory?: string;
  /** 默认 `ClaudeHookInstaller`；测试注入假实现（不会碰真实 settings）。 */
  hookInstaller?: ClaudeHookInstallerLike;
  /** hook server 固定端口；测试可传 0 或占用中的端口，null = 系统分配。 */
  hookServerRequestedPort?: number | null;
  /** 端口冲突的重试次数（含第一次）；默认 `ClaudeConnector.hostServerPortRetries`。 */
  hookServerPortRetries?: number;
  /** 启动/升级失败的日志出口；默认 console.warn。 */
  logger?: (message: string, error?: unknown) => void;
};

type Session = {
  sessionID: string;
  projectPath: string;
  title: string;
  titleSource: TitleSource;
  status: TaskStatus;
  origin: TaskOrigin;
  lastMessage?: string;
  pendingRequest?: ClaudePendingRequest;
  startedAt: string;
  updatedAt: string;
  transcriptPath?: string;
  turnStartedAt?: number;
  model?: string;
  chosenModel?: string;
  chosenEffort?: string;
  failureDiagnosis?: ClaudeFailureDiagnosis;
};

type HoldChannel =
  | { kind: "hook"; hold: LocalHookServerHold }
  | { kind: "control"; stdin: ClaudeControlChannel; requestID: string; input: string };

/** 一条挂着等手机回答的审批。token 分辨同一个 requestId 先后挂的两次。 */
class PendingHold {
  readonly token = randomUUID();
  private readonly channel: HoldChannel;

  constructor(channel: HoldChannel) {
    this.channel = channel;
  }

  get isControl(): boolean {
    return this.channel.kind === "control";
  }

  isOn(stdin: ClaudeControlChannel): boolean {
    return this.channel.kind === "control" && this.channel.stdin === stdin;
  }

  /** 是不是这条 stdin 上、这个 request_id 的控制协议审批。 */
  matchesControl(stdin: ClaudeControlChannel, requestID: string): boolean {
    return (
      this.channel.kind === "control" &&
      this.channel.stdin === stdin &&
      this.channel.requestID === requestID
    );
  }

  /** 送出回答；送不到（hook 已超时、这一轮已结束）返回 false。 */
  answer(decision: ClaudePermissionDecision): boolean {
    if (this.channel.kind === "hook") {
      return this.channel.hold.answer({
        status: 200,
        contentType: "application/json",
        body: ClaudeHookOutput.permissionDecision(decision),
      });
    }
    return this.channel.stdin.send(
      ClaudeControlOutput.response(this.channel.requestID, decision, this.channel.input),
    );
  }

  /**
   * 没人会回答了：hook 回空，由 Claude Code 自己处理；控制协议只能拒绝——
   * 绝不能变成允许。
   */
  release(message: string): void {
    if (this.channel.kind === "hook") {
      this.channel.hold.answer(NO_CONTENT);
    } else {
      this.answer({ kind: "deny", message });
    }
  }
}

type QuestionHold = { sessionID: string; asked: ClaudeAskedQuestions };
type QueuedTurn = {
  prompt: string;
  input: Buffer;
  hasImages: boolean;
  model?: string;
  effort?: string;
};
type Launch = { sessionID: string; registered: () => void };

/**
 * Claude Code 连接器：hooks 负责"看见"，`claude -p` 负责"动手"。
 *
 * **所有权一拿就不放**：Claude 这一侧没有只读观察者，本连接器是唯一权威，
 * 所以每个会话建出来就 `claimLive`，不再交还。
 */
export class ClaudeConnector implements TaskConnector {
  readonly kind = "claude" as const;
  readonly runsUnderBotBus = true;

  // 与上游相同的常量。
  static readonly maxSessions = 200;
  static readonly drainTimeout = 2;
  static readonly titleLimit = TITLE_LIMIT;
  static readonly imageOnlyTitle = "图片";
  static readonly lastMessageLimit = LAST_MESSAGE_LIMIT;
  static readonly detailLimit = 2000;
  static readonly titleRetryDelays = [0, 3, 10, 30, 60];
  static readonly turnEndCheckInterval = 30;
  static readonly turnEndSlack = 2;
  static readonly presenceSweepInterval = 15;
  static readonly lateRequestLimit = 64;
  /** 端口冲突（EADDRINUSE）时最多试几次。 */
  static readonly hostServerPortRetries = 3;

  private readonly host: ConnectorHost;
  private readonly options: ClaudeConnectorOptions;
  private readonly paths: ClaudePaths;
  private readonly binary: () => string | null;
  private readonly now: () => Date;
  private readonly tools: () => AgentToolsConfiguration | null;
  private readonly settingsEnv: () => Record<string, string>;
  private readonly registry: TaskContextRegistry;
  private readonly titleRetryDelays: number[];
  private readonly turnEndCheckInterval: number;
  private readonly presenceSweepInterval: number;
  private readonly approvalTimeout: number;
  private readonly sessionIDTimeout: number;

  private supportedEfforts: string[] | null;
  private effortsBinary: string | null;
  private readonly sessions = new Map<string, Session>();
  private readonly holds = new Map<string, PendingHold>();
  private readonly controls = new Map<string, ClaudeControlChannel>();
  private readonly questionHolds = new Map<string, QuestionHold>();
  private readonly lateRequests = new Map<string, ClaudeLateRequest>();
  private readonly ownProcesses = new Map<string, ChildProcess>();
  private readonly queued = new Map<string, QueuedTurn[]>();
  private readonly launching = new Set<string>();
  private readonly superseded = new Set<string>();
  private lastPublish: Promise<void> = Promise.resolve();
  private readonly titleRefreshes = new Map<string, Promise<void>>();
  private binaryWithoutName: string | null = null;
  private turnEndCheckActive = false;
  private presenceSweep: NodeJS.Timeout | null = null;
  private readonly transcriptSeen = new Set<string>();
  private transcriptMissing = new Set<string>();
  private readonly desktopRecorded = new Map<string, string>();
  private desktopMissing = new Set<string>();
  private desktopArchived = new Set<string>();
  private desktopRecordCache = new Map<string, ClaudeDesktopRecord>();
  private readonly modelVersions: Record<string, number[]> = {};
  private modelsChanged = false;
  private stopped = false;
  private hookServer: LocalHookServer | null = null;
  private hostState: ClaudeHostServicesState = "idle";
  private hostError: string | null = null;
  private readonly hostWarnings: string[] = [];
  private hostStarting: Promise<boolean> | null = null;
  private hostReady: Promise<void> = Promise.resolve();
  private hostPort: number | null = null;
  private readonly sleepers = new Set<{ handle: NodeJS.Timeout; resolve: (ok: boolean) => void }>();

  constructor(host: ConnectorHost, options: ClaudeConnectorOptions = {}) {
    this.host = host;
    this.options = options;
    this.paths = options.paths ?? claudePaths();
    this.binary = options.binary ?? detectClaudeBinary;
    this.now = options.now ?? (() => new Date());
    this.tools = options.tools ?? (() => null);
    this.settingsEnv = options.settingsEnv ?? (() => claudeSettingsEnvironment());
    this.registry = options.registry ?? new TaskContextRegistry();
    this.titleRetryDelays = options.titleRetryDelays ?? ClaudeConnector.titleRetryDelays;
    this.turnEndCheckInterval = options.turnEndCheckInterval ?? ClaudeConnector.turnEndCheckInterval;
    this.presenceSweepInterval = options.presenceSweepInterval ?? ClaudeConnector.presenceSweepInterval;
    this.approvalTimeout = options.approvalTimeout ?? LocalHookServer.defaultHoldTimeout;
    this.sessionIDTimeout = options.sessionIDTimeout ?? (process.platform === "win32" ? 60 : 20);
    const executable = this.binary();
    this.supportedEfforts = ClaudeModels.effortsForBinary(executable);
    this.effortsBinary = resolveExecutable(executable);
    this.options.setModels?.(this.modelOptions ?? null);
  }

  // -------------------------------------------------------------------------
  // 模型
  // -------------------------------------------------------------------------

  private get modelOptions() {
    return this.supportedEfforts
      ? ClaudeModels.options({ versions: this.modelVersions, efforts: this.supportedEfforts })
      : undefined;
  }

  /** 停连接器：放掉所有挂起的审批，终止自己起的子进程，停两个轮询。 */
  stop(): void {
    this.stopped = true;
    this.hostState = "stopped";
    this.hostPort = null;
    for (const hold of this.holds.values()) hold.release("BotBus 已停止，这次没有执行");
    this.holds.clear();
    for (const stdin of this.controls.values()) stdin.close();
    this.controls.clear();
    this.questionHolds.clear();
    this.queued.clear();
    for (const process of this.ownProcesses.values()) {
      if (process.exitCode === null) process.kill();
    }
    this.ownProcesses.clear();
    this.superseded.clear();
    this.titleRefreshes.clear();
    this.turnEndCheckActive = false;
    if (this.presenceSweep) clearInterval(this.presenceSweep);
    this.presenceSweep = null;
    this.transcriptMissing.clear();
    this.desktopMissing.clear();
    for (const sleeper of this.sleepers) {
      clearTimeout(sleeper.handle);
      sleeper.resolve(false);
    }
    this.sleepers.clear();
    this.hookServer?.stop();
    this.hookServer = null;
  }

  /** `stop()` 的别名：宿主销毁连接器时用哪个都行，重复调用安全。 */
  dispose(): void {
    this.stop();
  }

  /** 手机发起新一轮之前看一眼挑中的 claude 换没换。 */
  private refreshSupportedEfforts(): void {
    const executable = this.binary();
    const resolved = resolveExecutable(executable);
    if (resolved === this.effortsBinary) return;
    this.effortsBinary = resolved;
    const efforts = ClaudeModels.effortsForBinary(executable);
    if (sameStrings(efforts, this.supportedEfforts)) return;
    this.supportedEfforts = efforts;
    if (this.options.setModels?.(this.modelOptions ?? null)) this.modelsChanged = true;
  }

  /** 见到一个完整模型名：版本比记着的新就更新手机上的模型列表。 */
  private noteModel(name: string): void {
    if (!ClaudeModels.note(name, this.modelVersions)) return;
    const models = this.modelOptions;
    if (models && this.options.setModels?.(models)) this.modelsChanged = true;
  }

  // -------------------------------------------------------------------------
  // Hook 入口
  // -------------------------------------------------------------------------

  /** `LocalHookServer` 把 `/hooks/claude` 的请求交到这里。 */
  async handleHook(request: LocalHookRequest): Promise<LocalHookReply> {
    const event = parseClaudeHookEvent(request.body);
    if (!event) return nowReply(NO_CONTENT);
    if (event.sessionID.length === 0) return nowReply(NO_CONTENT);
    if (this.superseded.has(event.sessionID)) return nowReply(NO_CONTENT);
    if (this.desktopArchived.has(event.sessionID)) return nowReply(NO_CONTENT);

    switch (event.kind) {
      case "SessionStart": {
        // 打开、恢复、`/clear`、压缩上下文都会发；状态不动、updatedAt 不顶。
        const session = this.sessions.get(event.sessionID);
        if (!session) return nowReply(NO_CONTENT);
        if (event.transcriptPath && event.transcriptPath.length > 0) {
          session.transcriptPath = event.transcriptPath;
        }
        this.sessions.set(event.sessionID, session);
        if (event.cwd.length === 0 || event.cwd === session.projectPath) return nowReply(NO_CONTENT);
        this.apply(event, (target) => {
          target.projectPath = event.cwd;
        });
        break;
      }
      case "UserPromptSubmit": {
        this.apply(event, (session) => {
          session.status = "running";
          session.failureDiagnosis = undefined;
          session.pendingRequest = undefined;
          session.turnStartedAt = this.now().getTime();
          if (session.titleSource === TitleSource.placeholder && event.prompt !== undefined) {
            const prompt = trimmed(stripInjected(event.prompt));
            if (prompt.length > 0) {
              session.title = prompt.slice(0, ClaudeConnector.titleLimit);
              session.titleSource = TitleSource.prompt;
            }
          }
        });
        break;
      }
      case "Notification": {
        if (event.notificationType === "idle_prompt" || event.notificationType === "agent_needs_input") {
          this.apply(event, (session) => {
            session.status = "waitingInput";
            session.failureDiagnosis = undefined;
          });
        } else {
          return nowReply(NO_CONTENT);
        }
        break;
      }
      case "Stop": {
        const name = event.transcriptPath
          ? ClaudeModels.lastModel(event.transcriptPath)
          : null;
        if (name) this.noteModel(name);
        const model = name ? ClaudeModels.optionId(name) : null;
        this.apply(event, (session) => {
          session.status = "completed";
          session.failureDiagnosis = undefined;
          session.pendingRequest = undefined;
          const text = this.finalMessage(event);
          if (text !== null) session.lastMessage = text;
          if (model) session.model = model;
        });
        break;
      }
      case "StopFailure": {
        this.apply(event, (session) => {
          const wasFailed = session.status === "failed";
          session.status = "failed";
          session.pendingRequest = undefined;
          const text = trimmed(event.lastAssistantMessage ?? event.errorDetails ?? event.error);
          if (text.length > 0) session.lastMessage = text.slice(0, ClaudeConnector.lastMessageLimit);
          session.failureDiagnosis =
            ClaudeFailure.diagnosisFromCategory(event.error, event.errorDetails) ??
            (wasFailed ? session.failureDiagnosis : undefined);
        });
        break;
      }
      case "SessionEnd":
        return this.endSession(event);
      case "PermissionRequest":
        return this.holdForApproval(event);
      default:
        break;
    }
    await this.publish();
    return nowReply(NO_CONTENT);
  }

  /** `SessionEnd`：一轮跑到一半被关掉记 interrupted；空闲等输入的记 completed。 */
  private async endSession(event: ClaudeHookEvent): Promise<LocalHookReply> {
    const session = this.sessions.get(event.sessionID);
    if (!session || this.isOwnTurn(event.sessionID)) return nowReply(NO_CONTENT);
    const cutOff = isMidTurn(session) || (session.status === "waitingInput" && session.pendingRequest !== undefined);
    if (!cutOff && session.status !== "waitingInput") return nowReply(NO_CONTENT);
    this.releaseHold(session);
    this.apply(event, (target) => {
      target.status = cutOff ? "interrupted" : "completed";
      target.failureDiagnosis = undefined;
      target.pendingRequest = undefined;
    });
    // 关掉一个空闲会话不是"任务完成"，不推通知。
    await this.publish(false);
    return nowReply(NO_CONTENT);
  }

  /** 本连接器自己起的那一轮还没收尾（含起进程到拿到 session id 的几秒）。 */
  private isOwnTurn(sessionID: string): boolean {
    return this.launching.has(sessionID) || this.ownProcesses.has(sessionID);
  }

  /** 会话已经收尾了，还挂着的审批 / 提问没人会再收。 */
  private releaseHold(session: Session): void {
    const requestID = session.pendingRequest?.id;
    if (!requestID) return;
    this.questionHolds.delete(requestID);
    this.holds.get(requestID)?.release("这一轮已经结束");
    this.holds.delete(requestID);
  }

  /** `PermissionRequest`：建 pendingRequest，然后把 HTTP 响应挂住。 */
  private async holdForApproval(event: ClaudeHookEvent): Promise<LocalHookReply> {
    if (this.isOwnTurn(event.sessionID)) return nowReply(NO_CONTENT);
    const requestID = event.toolUseID ?? randomUUID();
    const hold = new LocalHookServerHold(LocalHookServer.defaultHoldTimeout);
    const pending = new PendingHold({ kind: "hook", hold });
    // 先登记再发布：手机若在这之间就回答了，得找得到这条 hold。
    this.holds.set(requestID, pending);
    this.pend(event, requestID, event.toolName, event.toolInput, event.askedQuestions);
    await this.publish();

    // hold 超时后只收掉 holds 里的条目，但保留 questionHolds 和 pendingRequest。
    void this.sleep((LocalHookServer.defaultHoldTimeout + 1) * 1000).then(() => {
      if (this.holds.get(requestID)?.token === pending.token) this.holds.delete(requestID);
    });
    return { kind: "hold", hold };
  }

  /** 给会话挂上一条待处理的审批或提问（hook 与控制协议共用）。 */
  private pend(
    event: ClaudeHookEvent,
    requestID: string,
    toolName: string | undefined,
    detail: string | undefined,
    asked: ClaudeAskedQuestions | undefined,
  ): void {
    if (asked) this.questionHolds.set(requestID, { sessionID: event.sessionID, asked });
    this.apply(event, (session) => {
      if (asked) {
        session.status = "waitingInput";
        session.failureDiagnosis = undefined;
        session.pendingRequest = {
          id: requestID,
          kind: "input",
          summary: asked.summary,
          question: asked.plainText,
          questions: asked.questions,
        };
      } else {
        session.status = "waitingApproval";
        session.failureDiagnosis = undefined;
        session.pendingRequest = {
          id: requestID,
          kind: "permission",
          summary: toolName ?? "请求权限",
          detail: detail === undefined ? undefined : detail.slice(0, ClaudeConnector.detailLimit),
        };
      }
    });
  }

  // -------------------------------------------------------------------------
  // 控制协议（手机那一轮的审批）
  // -------------------------------------------------------------------------

  private async handleControl(
    line: Buffer,
    sessionID: string | null,
    stdin: ClaudeControlChannel,
    workingDirectory: string,
  ): Promise<void> {
    const request = parseClaudeControlRequest(line);
    if (!request) return;
    switch (request.kind) {
      case "unsupported": {
        stdin.send(ClaudeControlOutput.error(request.requestID, `BotBus 不处理 ${request.subtype}`));
        return;
      }
      case "cancel": {
        let key: string | undefined;
        for (const [candidate, hold] of this.holds) {
          if (hold.matchesControl(stdin, request.requestID)) {
            key = candidate;
            break;
          }
        }
        if (key === undefined) return;
        this.holds.delete(key);
        this.questionHolds.delete(key);
        if (this.settle(key)) await this.publish();
        return;
      }
      case "canUseTool": {
        if (sessionID === null) {
          stdin.send(
            ClaudeControlOutput.response(
              request.requestID,
              { kind: "deny", message: "BotBus 还没认出这个会话" },
              request.input,
            ),
          );
          return;
        }
        const asked = ClaudeAskedQuestions.from(request.toolName, request.inputObject);
        const cwd = this.sessions.get(sessionID)?.projectPath ?? workingDirectory;
        if (
          !asked &&
          (await this.options.autoApproves?.(taskIdFor(sessionID, "claude"), cwd)) === true
        ) {
          stdin.send(
            ClaudeControlOutput.response(request.requestID, { kind: "allow" }, request.input),
          );
          return;
        }
        const key = request.toolUseID ?? request.requestID;
        const pending = new PendingHold({
          kind: "control",
          stdin,
          requestID: request.requestID,
          input: request.input,
        });
        this.holds.set(key, pending);
        const event = syntheticHookEvent("PermissionRequest", sessionID, cwd);
        event.toolName = request.toolName;
        this.pend(event, key, request.toolName, summarizeToolInput(request.inputObject), asked ?? undefined);
        await this.publish();
        const timeout = this.approvalTimeout;
        void this.sleep(timeout * 1000).then(() => this.expire(key, pending.token));
        return;
      }
      default:
        return;
    }
  }

  /** 控制协议里等太久的审批：按拒绝回，卡片收掉，这一轮接着跑。 */
  private async expire(requestID: string, token: string): Promise<void> {
    const hold = this.holds.get(requestID);
    if (!hold || hold.token !== token) return;
    this.holds.delete(requestID);
    this.questionHolds.delete(requestID);
    hold.release("手机上一直没有回应，这次没有执行");
    for (const session of this.sessions.values()) {
      if (session.pendingRequest?.id === requestID) {
        this.rememberLate(
          new ClaudeLateRequest(session.sessionID, session.pendingRequest, null, this.now()),
          requestID,
        );
        break;
      }
    }
    if (this.settle(requestID)) await this.publish();
  }

  private rememberLate(late: ClaudeLateRequest, requestID: string): void {
    this.lateRequests.set(requestID, late);
    while (this.lateRequests.size > ClaudeConnector.lateRequestLimit) {
      let oldestKey: string | null = null;
      let oldest: Date | null = null;
      for (const [key, value] of this.lateRequests) {
        if (oldest === null || value.since.getTime() < oldest.getTime()) {
          oldest = value.since;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      this.lateRequests.delete(oldestKey);
    }
  }

  /** 挂着 `requestID` 的会话收掉卡片、回到运行中。没有这样的会话返回 false。 */
  private settle(requestID: string): boolean {
    let target: Session | undefined;
    for (const session of this.sessions.values()) {
      if (session.pendingRequest?.id === requestID) {
        target = session;
        break;
      }
    }
    if (!target) return false;
    this.apply(syntheticHookEvent("UserPromptSubmit", target.sessionID, target.projectPath), (session) => {
      session.pendingRequest = undefined;
      session.status = "running";
      session.failureDiagnosis = undefined;
    });
    return true;
  }

  /** 取 Stop 时的最后一条 assistant 文本。 */
  private finalMessage(event: ClaudeHookEvent): string | null {
    const direct = trimmed(event.lastAssistantMessage);
    if (direct.length > 0) return direct.slice(0, ClaudeConnector.lastMessageLimit);
    if (!event.transcriptPath) return null;
    const text = lastAssistantText(event.transcriptPath);
    return text === null ? null : text.slice(0, ClaudeConnector.lastMessageLimit);
  }

  // -------------------------------------------------------------------------
  // 启动补历史
  // -------------------------------------------------------------------------

  /** 把 `~/.claude/projects` 里回溯窗口内的会话补进来。连接器每次启动调一次。 */
  async restoreRecentSessions(): Promise<void> {
    const current = this.now();
    // PORT: Swift 用 Task.detached 把扫描挪到后台线程；Node 主线程无法把同步 fs
    // 扫描移出事件循环，这里先让出一拍再扫描（功能一致，大目录时会短暂阻塞）。
    await new Promise<void>((resolve) => setImmediate(resolve));
    const entries = ClaudeSessionHistory.recentSessions(
      this.paths.projectsDirectory,
      current.getTime(),
      ClaudeConnector.maxSessions,
    );
    const index = ClaudeDesktopSessionIndex.read(this.paths.desktopSessionsDirectories, this.desktopRecordCache);
    if (index) {
      this.desktopArchived = index.archived;
    }
    try {
      const adopted = entries.filter(
        (entry) => !this.desktopArchived.has(entry.sessionID) && !this.superseded.has(entry.sessionID),
      );
      if (adopted.length === 0) return;
      for (const entry of adopted) {
        this.adopt(entry, current);
        this.transcriptSeen.add(entry.sessionID);
        const account = index?.recorded.get(entry.sessionID);
        if (account) this.desktopRecorded.set(entry.sessionID, account);
      }
      this.pruneIfNeeded();
      // 补历史是静默基线，不逐条推 taskUpdated；补完给手机一份全量快照，
      // 已经连着的手机不用等重连才看见这些会话
      await this.publish(false);
      this.options.broadcastSnapshot?.();
    } finally {
      this.startPresenceSweep();
    }
  }

  private adopt(entry: ClaudeSessionEntry, current: Date): void {
    const startedAt = protocolTimestamp(new Date(entry.startedAt));
    if (entry.model) this.noteModel(entry.model);
    const model = entry.model ? ClaudeModels.optionId(entry.model) : null;
    const existing = this.sessions.get(entry.sessionID);
    if (existing) {
      if (entry.title !== null && titleSourceReplaces(entry.titleSource, existing.titleSource)) {
        existing.title = entry.title;
        existing.titleSource = entry.titleSource;
      }
      if (existing.lastMessage === undefined) existing.lastMessage = entry.lastMessage ?? undefined;
      if (existing.model === undefined && model) existing.model = model;
      if (startedAt < existing.startedAt) existing.startedAt = startedAt;
      this.sessions.set(entry.sessionID, existing);
      return;
    }
    const session = this.makeSession(entry.sessionID, entry.projectPath, "desktop");
    if (entry.title !== null) {
      session.title = entry.title;
      session.titleSource = entry.titleSource;
    }
    // transcript 里看不出最后一轮是否正常结束；超过 24 小时记 idle。
    session.status =
      current.getTime() - entry.updatedAt > ClaudeSessionHistory.idleAfterMs ? "idle" : "completed";
    session.lastMessage = entry.lastMessage ?? undefined;
    session.model = model ?? undefined;
    session.startedAt = startedAt;
    session.updatedAt = protocolTimestamp(new Date(entry.updatedAt));
    this.sessions.set(entry.sessionID, session);
  }

  // -------------------------------------------------------------------------
  // 跟电脑上的删除
  // -------------------------------------------------------------------------

  private startPresenceSweep(): void {
    if (this.presenceSweep || this.stopped) return;
    this.presenceSweep = setInterval(() => {
      void this.sweepPresence();
    }, this.presenceSweepInterval * 1000);
    this.presenceSweep.unref?.();
  }

  get isSweepingPresence(): boolean {
    return this.presenceSweep !== null;
  }

  /** 核对一遍电脑上删掉、归档的会话。本连接器自己正跑着的那一轮不动。 */
  async sweepPresence(): Promise<void> {
    const projects = this.paths.projectsDirectory;
    const roots = this.paths.desktopSessionsDirectories;
    const knownPaths: Array<[string, string]> = [];
    for (const session of this.sessions.values()) {
      if (session.transcriptPath) knownPaths.push([session.sessionID, session.transcriptPath]);
    }
    const withPath = new Set(knownPaths.map(([id]) => id));
    const listed = ClaudeSessionPresence.transcriptIDs(projects);
    const onDisk = new Set(
      knownPaths.filter(([, path]) => fileExists(path)).map(([id]) => id),
    );
    const index = ClaudeDesktopSessionIndex.read(roots, this.desktopRecordCache);
    if (index) this.desktopArchived = index.archived;

    const gone: string[] = [];
    const deleted: string[] = [];
    const stillMissing = new Set<string>();
    const stillUnrecorded = new Set<string>();
    for (const session of this.sessions.values()) {
      const id = session.sessionID;
      const account = index?.recorded.get(id);
      if (account) this.desktopRecorded.set(id, account);
      const present = listed?.has(id) === true || onDisk.has(id);
      if (present) this.transcriptSeen.add(id);
      if (this.isOwnTurn(id)) continue;
      if (this.desktopArchived.has(id)) {
        gone.push(id);
        continue;
      }
      const known = listed !== null || withPath.has(id);
      if (known && !present && this.transcriptSeen.has(id)) {
        if (this.transcriptMissing.has(id)) gone.push(id);
        else stillMissing.add(id);
        continue;
      }
      const recordedAccount = this.desktopRecorded.get(id);
      if (index && recordedAccount && index.recorded.get(id) === undefined && index.accounts.has(recordedAccount)) {
        if (this.desktopMissing.has(id)) deleted.push(id);
        else stillUnrecorded.add(id);
      }
    }
    if (listed !== null || withPath.size > 0) this.transcriptMissing = stillMissing;
    if (index) this.desktopMissing = stillUnrecorded;

    for (const id of gone) {
      this.forget(id);
      this.host.remove(taskIdFor(id, "claude"));
    }
    for (const id of deleted) {
      await this.discard(taskIdFor(id, "claude"));
      this.host.remove(taskIdFor(id, "claude"));
    }
    const ids = new Set(this.sessions.keys());
    for (const id of [...this.transcriptSeen]) if (!ids.has(id)) this.transcriptSeen.delete(id);
    for (const id of [...this.desktopRecorded.keys()]) if (!ids.has(id)) this.desktopRecorded.delete(id);
    if (gone.length > 0) await this.publish();
  }

  private forget(sessionID: string): void {
    this.queued.delete(sessionID);
    const session = this.sessions.get(sessionID);
    if (session) {
      this.sessions.delete(sessionID);
      this.releaseHold(session);
    }
    this.transcriptSeen.delete(sessionID);
    this.desktopRecorded.delete(sessionID);
  }

  // -------------------------------------------------------------------------
  // 会话状态
  // -------------------------------------------------------------------------

  /** 取出（或新建）一个会话，改完它，记下时间。Task 的产出统一在 publish。 */
  private apply(event: ClaudeHookEvent, mutate: (session: Session, event: ClaudeHookEvent) => void): void {
    if (this.superseded.has(event.sessionID)) return;
    const existing = this.sessions.get(event.sessionID);
    const session = existing ?? this.makeSession(event.sessionID, event.cwd, "desktop");
    if (event.transcriptPath && event.transcriptPath.length > 0) session.transcriptPath = event.transcriptPath;
    mutate(session, event);
    const current = this.now().getTime();
    if (isMidTurn(session) && !isMidTurn(existing)) session.turnStartedAt = current;
    session.updatedAt = protocolTimestamp(new Date(current));
    this.sessions.set(event.sessionID, session);
    this.pruneIfNeeded();
    this.refreshAppTitle(event);
    this.scheduleTurnEndCheck();
  }

  // -------------------------------------------------------------------------
  // 盯收尾标记
  // -------------------------------------------------------------------------

  private scheduleTurnEndCheck(): void {
    if (this.turnEndCheckActive || this.turnEndCandidates().length === 0) return;
    this.turnEndCheckActive = true;
    void (async () => {
      while (true) {
        if (!(await this.sleep(this.turnEndCheckInterval * 1000))) break;
        if (!(await this.checkTurnEndings())) break;
      }
      this.turnEndCheckActive = false;
    })();
  }

  private turnEndCandidates(): Array<{ sessionID: string; path: string; since: number | undefined }> {
    const candidates: Array<{ sessionID: string; path: string; since: number | undefined }> = [];
    for (const session of this.sessions.values()) {
      if (!isMidTurn(session) || !session.transcriptPath || this.isOwnTurn(session.sessionID)) continue;
      candidates.push({ sessionID: session.sessionID, path: session.transcriptPath, since: session.turnStartedAt });
    }
    return candidates;
  }

  /** 看一遍所有要盯的会话。返回 false = 没有要盯的了。 */
  private async checkTurnEndings(): Promise<boolean> {
    const candidates = this.turnEndCandidates();
    if (candidates.length === 0) return false;
    const endings = candidates.map((candidate) => ClaudeSessionHistory.turnEnding(candidate.path));
    let changed = false;
    candidates.forEach((candidate, index) => {
      const ending = endings[index];
      const session = this.sessions.get(candidate.sessionID);
      if (!ending || !session || !isMidTurn(session)) return;
      if (session.turnStartedAt !== candidate.since || this.isOwnTurn(candidate.sessionID)) return;
      const endedAt = ending.at;
      if (candidate.since !== undefined && endedAt < candidate.since - ClaudeConnector.turnEndSlack * 1000) return;
      this.releaseHold(session);
      session.status = ending.kind === "interrupted" ? "interrupted" : "completed";
      session.failureDiagnosis = undefined;
      session.pendingRequest = undefined;
      session.updatedAt = protocolTimestamp(this.now());
      this.sessions.set(candidate.sessionID, session);
      changed = true;
    });
    if (changed) await this.publish();
    return true;
  }

  async checkTurnEndingsNow(): Promise<void> {
    await this.checkTurnEndings();
  }

  get isCheckingTurnEndings(): boolean {
    return this.turnEndCheckActive;
  }

  /**
   * 显式确保收尾检测循环在跑。上游语义不变：没有要盯的会话时
   * `scheduleTurnEndCheck` 自己不动，循环该退出时退出。
   */
  startTurnEndCheck(): void {
    this.scheduleTurnEndCheck();
  }

  failureDiagnosisFor(sessionID: string): ClaudeFailureDiagnosis | undefined {
    return this.sessions.get(sessionID)?.failureDiagnosis;
  }

  // -------------------------------------------------------------------------
  // 跟 app 起的标题
  // -------------------------------------------------------------------------

  private refreshAppTitle(event: ClaudeHookEvent): void {
    const path = event.transcriptPath;
    if (!path || path.length === 0) return;
    const session = this.sessions.get(event.sessionID);
    if (!session || this.titleRefreshes.has(event.sessionID)) return;
    let delays: number[];
    if (session.titleSource < TitleSource.generated) {
      delays = this.titleRetryDelays;
    } else if (event.kind === "Stop") {
      delays = [0];
    } else {
      return;
    }
    const sessionID = event.sessionID;
    const task = (async () => {
      for (const delay of delays) {
        if (delay > 0 && !(await this.sleep(delay * 1000))) break;
        const found = ClaudeSessionHistory.appTitle(path);
        if (found) {
          await this.applyAppTitle(found.title, found.source, sessionID);
          break;
        }
      }
    })();
    this.titleRefreshes.set(sessionID, task);
    void task
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.titleRefreshes.get(sessionID) === task) this.titleRefreshes.delete(sessionID);
      });
  }

  private async applyAppTitle(title: string, source: TitleSource, sessionID: string): Promise<void> {
    const session = this.sessions.get(sessionID);
    if (!session || !titleSourceReplaces(source, session.titleSource)) return;
    if (session.title === title && session.titleSource === source) return;
    session.title = title;
    session.titleSource = source;
    this.sessions.set(sessionID, session);
    await this.publish();
  }

  async waitForTitleRefreshes(): Promise<void> {
    while (this.titleRefreshes.size > 0) {
      await Promise.all([...this.titleRefreshes.values()]);
    }
  }

  private makeSession(id: string, projectPath: string, origin: TaskOrigin): Session {
    const timestamp = protocolTimestamp(this.now());
    const name = projectNameOf(projectPath);
    return {
      sessionID: id,
      projectPath,
      title: name.length === 0 ? "Claude 会话" : name,
      titleSource: TitleSource.placeholder,
      status: "running",
      origin,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /**
   * 手机新建会话时给 `claude --name` 的名字：首条 prompt 截断，控制字符与连续空白
   * 压成一个空格。
   */
  static sessionName(prompt: string): string | null {
    const visible = prompt.trim().slice(0, TITLE_LIMIT).replace(/\p{Cc}/gu, " ");
    const name = visible.split(/\s+/).filter((part) => part.length > 0).join(" ");
    return name.length === 0 ? null : name;
  }

  /** 手机新建（或分支出）的会话用 prompt 起标题。 */
  static applyPromptTitle(session: Session, prompt: string, hasImages: boolean): void {
    const title = prompt.trim().slice(0, TITLE_LIMIT);
    if (title.length > 0) {
      session.title = title;
      session.titleSource = TitleSource.prompt;
    } else if (hasImages) {
      session.title = ClaudeConnector.imageOnlyTitle;
      session.titleSource = TitleSource.placeholder;
    }
  }

  private pruneIfNeeded(): void {
    if (this.sessions.size <= ClaudeConnector.maxSessions) return;
    const doomed = [...this.sessions.values()]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, this.sessions.size - ClaudeConnector.maxSessions);
    for (const session of doomed) {
      this.sessions.delete(session.sessionID);
      this.host.remove(taskIdFor(session.sessionID, "claude"));
    }
  }

  // -------------------------------------------------------------------------
  // 发布
  // -------------------------------------------------------------------------

  /** 一趟接一趟地推，不并发。 */
  private async publish(notify = true): Promise<void> {
    const previous = this.lastPublish;
    const pass = previous.then(
      () => this.publishNow(notify),
      () => this.publishNow(notify),
    );
    this.lastPublish = pass.catch(() => undefined);
    await pass;
  }

  private async publishNow(notify: boolean): Promise<void> {
    for (const session of this.sessions.values()) {
      this.host.claimLive(taskIdFor(session.sessionID, "claude"));
      const task = this.record(session);
      if (this.options.upsert) this.options.upsert(task, notify);
      else this.host.upsert(task);
    }
    for (const project of this.projects()) this.host.rememberProject(project);
    // PORT: 上游用 `reconcile(tasks: [])` 触发一次全量项目快照；ConnectorHost 没有
    // reconciles，`rememberProject` 已表达同一份项目列表。
    if (this.modelsChanged) {
      this.modelsChanged = false;
      this.options.broadcastSnapshot?.();
    }
  }

  private record(session: Session): BusTask & { diagnosis?: ClaudeFailureDiagnosis } {
    const task: BusTask & { diagnosis?: ClaudeFailureDiagnosis } = {
      id: taskIdFor(session.sessionID, "claude"),
      agentId: this.host.agentId,
      source: "claude",
      title: session.title,
      projectPath: session.projectPath,
      projectName: projectNameOf(session.projectPath),
      status: session.status,
      lastMessage: session.lastMessage,
      pendingRequest: session.pendingRequest as unknown as BusPendingRequest,
      origin: session.origin,
      controllable: true,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      model: session.chosenModel ?? session.model,
      effort: session.chosenEffort,
    };
    if (session.status === "failed" && session.failureDiagnosis) {
      task.diagnosis = session.failureDiagnosis;
    }
    return task;
  }

  private projects(): BusProject[] {
    const latest = new Map<string, string>();
    for (const session of this.sessions.values()) {
      if (session.projectPath.length === 0) continue;
      const existing = latest.get(session.projectPath);
      if (existing !== undefined && existing >= session.updatedAt) continue;
      latest.set(session.projectPath, session.updatedAt);
    }
    return [...latest.entries()]
      .sort((left, right) => right[1].localeCompare(left[1]))
      .map(([path, updatedAt]) => ({
        agentId: this.host.agentId,
        path,
        name: projectNameOf(path),
        lastUsedAt: updatedAt,
        pinned: false,
      }));
  }

  // -------------------------------------------------------------------------
  // TaskConnector
  // -------------------------------------------------------------------------

  async start(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    // 先查模型、再读图：不对就别起进程，也别签 token。
    this.refreshSupportedEfforts();
    const chosen = resolveModelSelection(selection ?? {}, undefined, this.modelOptions ?? []);
    const input = stdinMessage(prompt, images);
    const injection = await AgentToolsInjection.make(this.tools(), this.registry);
    const executable = resolveExecutable(this.binary());
    const name =
      executable !== null && executable === this.binaryWithoutName
        ? null
        : ClaudeConnector.sessionName(prompt);
    const launch = (candidate: string | null) =>
      this.run(
        claudeArguments({
          resuming: null,
          injection,
          model: chosen.model,
          effort: chosen.effort,
          name: candidate,
        }),
        projectPath,
        injection?.environment ?? {},
        input,
      );

    let launched: Launch;
    try {
      launched = await launch(name);
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        name !== null &&
        error.message === EXITED_WITHOUT_SESSION_ID
      ) {
        // 老版本 claude 不认 `--name`，不带名字再起一次。
        launched = await launch(null);
        this.binaryWithoutName = executable;
      } else {
        throw error;
      }
    }
    const sessionID = launched.sessionID;
    // 先记下会话再 await：这一轮的审批随时可能从 stdout 到。
    const session = this.makeSession(sessionID, projectPath, "watch");
    session.chosenModel = chosen.model;
    session.chosenEffort = chosen.effort;
    ClaudeConnector.applyPromptTitle(session, prompt, images.length > 0);
    const existing = this.sessions.get(sessionID);
    if (existing?.pendingRequest) {
      session.status = existing.status;
      session.pendingRequest = existing.pendingRequest;
    }
    this.sessions.set(sessionID, session);
    launched.registered();
    if (injection) await this.registry.bind(injection.token, taskIdFor(sessionID, "claude"));
    await this.publish();
    return { taskId: sessionID, retainsLiveOwnership: true, runsUnderBotBus: true };
  }

  async followUp(
    taskId: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    const sessionID = this.nativeID(taskId);
    this.refreshSupportedEfforts();
    let chosen: { model?: string; effort?: string } = {
      model: this.sessions.get(sessionID)?.chosenModel,
      effort: this.sessions.get(sessionID)?.chosenEffort,
    };
    const requested = selection ?? {};
    if (requested.model !== undefined || requested.effort !== undefined) {
      chosen = resolveModelSelection(
        requested,
        this.sessions.get(sessionID),
        this.modelOptions ?? [],
      );
      const session = this.sessions.get(sessionID);
      if (session) {
        session.chosenModel = chosen.model;
        session.chosenEffort = chosen.effort;
      }
    }
    // 会话正挂着 AskUserQuestion：这句话就是回答，不另起一轮。
    let questionRequestID: string | undefined;
    for (const [requestID, hold] of this.questionHolds) {
      if (hold.sessionID === sessionID) {
        questionRequestID = requestID;
        break;
      }
    }
    if (questionRequestID !== undefined) {
      if (images.length > 0) throw new ConnectorError("Claude 正在等你回答问题，先回答再发图");
      const text = prompt.trim();
      const asked = this.questionHolds.get(questionRequestID)?.asked;
      if (text.length > 0 && asked) {
        const answered = await this.answerQuestion(questionRequestID, sessionID, {
          kind: "allow",
          updatedInput: asked.answeredInput(asked.claudeAnswersFromText(text)),
        });
        if (answered) {
          return {
            taskId: sessionID,
            retainsLiveOwnership: true,
            runsUnderBotBus: this.isOwnTurn(sessionID),
          };
        }
      }
    }
    const input = stdinMessage(prompt, images);
    const turn: QueuedTurn = {
      prompt,
      input,
      hasImages: images.length > 0,
      model: chosen.model,
      effort: chosen.effort,
    };
    // 我们自己起的那一轮还没收尾：排队，等它结束再 `--resume`。
    if (this.isOwnTurn(sessionID)) {
      const list = this.queued.get(sessionID) ?? [];
      list.push(turn);
      this.queued.set(sessionID, list);
      return { taskId: sessionID, retainsLiveOwnership: true, runsUnderBotBus: true };
    }
    const newID = await this.resume(sessionID, turn);
    await this.publish();
    return { taskId: newID, retainsLiveOwnership: true, runsUnderBotBus: true };
  }

  /** 在已有会话上跑一轮 `claude -p --resume`，返回实际的 session id。 */
  private async resume(sessionID: string, turn: QueuedTurn): Promise<string> {
    const existing = this.sessions.get(sessionID);
    const workingDirectory = existing?.projectPath ?? process.cwd();
    this.launching.add(sessionID);
    try {
      const injection = await AgentToolsInjection.make(
        this.tools(),
        this.registry,
        taskIdFor(sessionID, "claude"),
      );
      const launched = await this.run(
        claudeArguments({
          resuming: sessionID,
          injection,
          model: turn.model,
          effort: turn.effort,
        }),
        workingDirectory,
        injection?.environment ?? {},
        turn.input,
      );
      const newID = launched.sessionID;
      if (newID !== sessionID) {
        const branched = this.makeSession(newID, workingDirectory, "watch");
        const early = this.sessions.get(newID);
        if (early?.pendingRequest) {
          branched.status = early.status;
          branched.pendingRequest = early.pendingRequest;
        }
        ClaudeConnector.applyPromptTitle(branched, turn.prompt, turn.hasImages);
        // 分支是同一段对话的延续：手机选的模型跟过去。
        branched.model = existing?.model;
        branched.chosenModel = existing?.chosenModel;
        branched.chosenEffort = existing?.chosenEffort;
        this.sessions.set(newID, branched);
        const old = this.sessions.get(sessionID);
        if (old) {
          this.sessions.delete(sessionID);
          this.releaseHold(old);
        }
        this.superseded.add(sessionID);
      } else {
        const pendingID = this.sessions.get(sessionID)?.pendingRequest?.id;
        const earlyHold = pendingID ? this.holds.get(pendingID) : undefined;
        const control = this.controls.get(sessionID);
        const earlyCard = earlyHold !== undefined && control !== undefined && earlyHold.isOn(control);
        this.apply(syntheticHookEvent("UserPromptSubmit", sessionID, workingDirectory), (session) => {
          if (!earlyCard) session.status = "running";
          session.failureDiagnosis = undefined;
        });
      }
      launched.registered();
      await this.publish();
      if (injection) await this.registry.bind(injection.token, taskIdFor(newID, "claude"));
      return newID;
    } finally {
      this.launching.delete(sessionID);
    }
  }

  async approve(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome> {
    const sessionID = this.nativeID(taskId);
    const asked = this.questionHolds.get(requestId)?.asked;
    if (asked) {
      let reply: ClaudePermissionDecision;
      if (decision === "deny") {
        // 不回答不等于中断：任务仍在跑。
        reply = { kind: "deny", message: "用户在手机上跳过了这个问题" };
      } else {
        const mapped = asked.claudeAnswers(answers ?? {});
        if (Object.keys(mapped).length === 0) throw new ConnectorError("没有收到选项，请先选好再提交");
        reply = { kind: "allow", updatedInput: asked.answeredInput(mapped) };
      }
      if (!(await this.answerQuestion(requestId, sessionID, reply))) {
        // hook 已超时，Claude Code 回落到了电脑上的提问框。
        return this.answerLate(taskId, requestId, decision, answers);
      }
      return { taskId: sessionID, retainsLiveOwnership: true, runsUnderBotBus: true };
    }
    const allow = decision === "allow";
    const hold = this.holds.get(requestId);
    this.holds.delete(requestId);
    if (
      !hold ||
      !hold.answer(
        allow ? { kind: "allow" } : { kind: "deny", message: "用户在手机上拒绝了" },
      )
    ) {
      return this.answerLate(taskId, requestId, decision, answers);
    }
    this.apply(
      syntheticHookEvent("UserPromptSubmit", sessionID, this.sessions.get(sessionID)?.projectPath ?? ""),
      (session) => {
        session.pendingRequest = undefined;
        // 电脑上的权限框里拒绝会中断这一轮；`-p` 里拒绝只是这个工具没执行。
        session.status = allow || hold.isControl ? "running" : "interrupted";
        session.failureDiagnosis = undefined;
      },
    );
    await this.publish();
    return { taskId: sessionID, retainsLiveOwnership: true, runsUnderBotBus: true };
  }

  /** 回答已经送不到了的审批 / 提问：批准与选好的答案改成一条续聊发过去。 */
  private async answerLate(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers: Record<string, string[]> | undefined,
  ): Promise<ConnectorOutcome> {
    const sessionID = this.nativeID(taskId);
    let late = this.lateRequests.get(requestId);
    const session = this.sessions.get(sessionID);
    if (session?.pendingRequest?.id === requestId) {
      late = new ClaudeLateRequest(
        sessionID,
        session.pendingRequest,
        this.isOwnTurn(sessionID) ? null : session.transcriptPath ?? null,
        this.now(),
      );
    }
    if (!late) throw new ConnectorError("这条审批已经处理过了");
    // 先算好再动状态：提问一个都没选时报错，卡片留着让人重选。
    const prompt = late.followUp(decision, answers);
    this.lateRequests.delete(requestId);
    this.questionHolds.delete(requestId);
    const target = this.sessions.get(late.sessionID);
    if (target?.pendingRequest?.id === requestId) {
      target.pendingRequest = undefined;
      this.sessions.set(late.sessionID, target);
    }
    await this.publish();
    if (late.transcriptPath && ClaudeSessionHistory.hasToolResult(requestId, late.transcriptPath)) {
      throw new ConnectorError("这条请求已经在电脑上处理过了");
    }
    if (prompt === null) {
      return { taskId: late.sessionID, retainsLiveOwnership: true, runsUnderBotBus: true };
    }
    return this.followUp(taskId, prompt, []);
  }

  /** 把回答交给挂着的 AskUserQuestion。已经超时返回 false。 */
  private async answerQuestion(
    requestID: string,
    sessionID: string,
    reply: ClaudePermissionDecision,
  ): Promise<boolean> {
    this.questionHolds.delete(requestID);
    const hold = this.holds.get(requestID);
    this.holds.delete(requestID);
    if (!hold || !hold.answer(reply)) return false;
    this.apply(
      syntheticHookEvent("UserPromptSubmit", sessionID, this.sessions.get(sessionID)?.projectPath ?? ""),
      (session) => {
        if (session.pendingRequest?.id === requestID) session.pendingRequest = undefined;
        session.status = "running";
        session.failureDiagnosis = undefined;
      },
    );
    await this.publish();
    return true;
  }

  async interrupt(taskId: string): Promise<ConnectorOutcome> {
    const sessionID = this.nativeID(taskId);
    const process = this.ownProcesses.get(sessionID);
    if (!process || process.exitCode !== null) {
      throw new ConnectorError("这个会话是在电脑上启动的，只能在电脑上中断");
    }
    interruptProcess(process);
    // 中断就是不要了：排在后面的续聊一并作废。
    this.queued.delete(sessionID);
    const session = this.sessions.get(sessionID);
    if (session) this.releaseHold(session);
    this.apply(
      syntheticHookEvent("Stop", sessionID, this.sessions.get(sessionID)?.projectPath ?? ""),
      (target) => {
        target.status = "interrupted";
        target.failureDiagnosis = undefined;
        target.pendingRequest = undefined;
      },
    );
    await this.publish();
    return { taskId: sessionID, retainsLiveOwnership: true, runsUnderBotBus: true };
  }

  /** 协议 3.8：删除原生 transcript 后交还内存状态，不触碰项目文件。 */
  async deleteTask(taskId: string): Promise<void> {
    const id = nativeTaskId(taskId, "claude");
    if (!UUID_PATTERN.test(id)) throw new ConnectorError("会话 id 不合法");
    if (this.isOwnTurn(id) || isMidTurn(this.sessions.get(id))) {
      throw new ConnectorError("会话还在进行中，等它停下来再删除");
    }
    deleteTranscript(id, this.paths.projectsDirectory);
    await this.discard(taskId);
  }

  /** 协议 3.4：合并并结束后只忘掉会话，transcript 留在磁盘上。 */
  async discard(taskId: string): Promise<void> {
    const sessionID = this.nativeIDOrNull(taskId);
    if (sessionID === null) return;
    this.queued.delete(sessionID);
    const session = this.sessions.get(sessionID);
    if (session) {
      this.sessions.delete(sessionID);
      this.releaseHold(session);
    }
    const process = this.ownProcesses.get(sessionID);
    if (process && process.exitCode === null) {
      // 还在退出的由 finish 摘。
    } else {
      this.ownProcesses.delete(sessionID);
    }
    this.superseded.add(sessionID);
    await this.publish();
  }

  private nativeID(taskId: string): string {
    const native = this.nativeIDOrNull(taskId);
    if (native === null) throw new ConnectorError(`任务 id 不合法：${taskId}`);
    return native;
  }

  private nativeIDOrNull(taskId: string): string | null {
    const colon = taskId.indexOf(":");
    const native = colon < 0 ? taskId : taskId.slice(colon + 1);
    return native.length === 0 ? null : native;
  }

  // -------------------------------------------------------------------------
  // 子进程
  // -------------------------------------------------------------------------

  private async run(
    arguments_: string[],
    workingDirectory: string,
    extraEnvironment: Record<string, string>,
    stdin: Buffer,
  ): Promise<Launch> {
    const executable = this.binary();
    if (!executable) {
      throw new ConnectorError("本机没找到 claude 可执行文件", {
        diagnosis: { kind: "agentNotInstalled" },
      });
    }
    const diagnosis = this.options.diagnoseDirectory?.(workingDirectory);
    if (diagnosis) throw directoryError(diagnosis, workingDirectory);

    const child = spawnExecutable(executable, arguments_, {
      cwd: workingDirectory,
      env: buildEnvironment(extraEnvironment, { ...process.env, ...this.settingsEnv() }),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout) {
      throw new ConnectorError("起不了 claude：标准输入输出不可用");
    }
    const channel = new ClaudeControlChannel(child.stdin);
    const sessionID = new OneShot<string>();
    const reader = new StreamJSONReader(child.stdout);
    reader.onSessionID = (id) => sessionID.resolve(id);
    reader.onControl = (line, id) => {
      void this.handleControl(line, id, channel, workingDirectory);
    };
    // 一轮结束：关 stdin（EOF），claude 才会退出。
    reader.onResult = () => channel.close();
    const launched = new OneShot<void>();
    reader.onFinished = (result: StreamJSONResult) => {
      // 一行 init 都没读到就结束了：别让调用方一直等到超时。
      sessionID.reject(new ConnectorError(EXITED_WITHOUT_SESSION_ID));
      void (async () => {
        try {
          await launched.value();
        } catch {
          // 没起来。
        }
        await this.finish(result);
      })();
    };
    child.on("exit", () => {
      channel.close();
      // 收尾等读到 EOF：进程退出时 init / result 可能还在管道里没读。
      const timer = setTimeout(() => reader.finish(), ClaudeConnector.drainTimeout * 1000);
      timer.unref?.();
    });
    child.on("error", (error) => {
      channel.close();
      sessionID.reject(new ConnectorError(`起不了 claude：${error.message}`));
    });
    reader.start();
    channel.send(stdin);

    let id: string;
    try {
      id = await this.awaitSessionID(sessionID);
    } catch (error) {
      channel.close();
      launched.resolve();
      throw error;
    }
    this.ownProcesses.set(id, child);
    this.controls.set(id, channel);
    return { sessionID: id, registered: () => launched.resolve() };
  }

  /** 等 session id，带硬超时。 */
  private async awaitSessionID(box: OneShot<string>): Promise<string> {
    const timer = setTimeout(() => {
      box.reject(new ConnectorError("等 claude 回应超时"));
    }, this.sessionIDTimeout * 1000);
    timer.unref?.();
    try {
      return await box.value();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 后台读完一轮之后的收尾：写最终状态。 */
  private async finish(result: StreamJSONResult): Promise<void> {
    const sessionID = result.sessionID;
    if (!sessionID) return;
    this.ownProcesses.delete(sessionID);
    const stdin = this.controls.get(sessionID);
    if (stdin) {
      this.controls.delete(sessionID);
      stdin.close();
      // 进程没了，挂在它 stdin 上的审批送不到了。
      for (const [key, hold] of [...this.holds]) {
        if (hold.isOn(stdin)) {
          this.holds.delete(key);
          this.questionHolds.delete(key);
        }
      }
    }
    if (!this.sessions.has(sessionID)) return;
    const list = this.queued.get(sessionID);
    const next = list && list.length > 0 ? list.shift() : undefined;
    if (list && list.length === 0) this.queued.delete(sessionID);
    this.apply(syntheticHookEvent("Stop", sessionID, this.sessions.get(sessionID)?.projectPath ?? ""), (session) => {
      // 已经被 interrupt 标过的不要被"进程退出"改回 completed。
      // 后面还排着续聊：保持 running。
      if (session.status !== "interrupted" && next === undefined) {
        session.status = result.failed ? "failed" : "completed";
        if (session.status !== "failed") session.failureDiagnosis = undefined;
        if (result.failed) {
          const diagnosis = ClaudeFailure.diagnosis(result.errorText);
          if (diagnosis) session.failureDiagnosis = diagnosis;
        }
      }
      session.pendingRequest = undefined;
      const text = trimmed(result.lastText);
      if (text.length > 0) session.lastMessage = text.slice(0, ClaudeConnector.lastMessageLimit);
    });
    if (next) {
      try {
        const newID = await this.resume(sessionID, next);
        if (newID !== sessionID) {
          const rest = this.queued.get(sessionID);
          if (rest) {
            this.queued.delete(sessionID);
            this.queued.set(newID, rest);
          }
        }
      } catch (error) {
        this.queued.delete(sessionID);
        this.apply(
          syntheticHookEvent("Stop", sessionID, this.sessions.get(sessionID)?.projectPath ?? ""),
          (session) => {
            session.status = "failed";
            session.lastMessage = `${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              ClaudeConnector.lastMessageLimit,
            );
            session.failureDiagnosis =
              error instanceof ConnectorError ? error.diagnosis : undefined;
          },
        );
      }
    }
    await this.publish();
  }

  // -------------------------------------------------------------------------
  // Hook 服务器（app 装配用；测试也用它起假 HTTP）
  // -------------------------------------------------------------------------

  createHookServer(options: {
    supportDirectory: string;
    portFileName?: string | null;
    requestedPort?: number | null;
    maxBodyBytes?: number;
    sharedSecret?: { fileName: string; enforcement: "required" | "whenPresent" } | null;
  }): LocalHookServer {
    return new LocalHookServer({
      ...options,
      // 未显式给 null 时用平台默认：Claude hook 服务器总是开共享密钥。
      sharedSecret:
        options.sharedSecret === undefined ? defaultSharedSecretOptions() : options.sharedSecret,
      handler: (request) => this.handleHook(request),
    });
  }

  async startHookServer(options: Parameters<ClaudeConnector["createHookServer"]>[0]): Promise<number> {
    if (!this.hookServer) this.hookServer = this.createHookServer(options);
    return this.hookServer.start();
  }

  stopHookServer(): void {
    this.hookServer?.stop();
    this.hookServer = null;
  }

  // -------------------------------------------------------------------------
  // 宿主服务（createClaudeConnector 在 autoStart 时拉起）
  // -------------------------------------------------------------------------

  get hostServicesState(): ClaudeHostServicesState {
    return this.hostState;
  }

  /** 致命错误（hook server 起不来 / 密钥文件写不出）；null 表示没失败。 */
  get hostServicesError(): string | null {
    return this.hostError;
  }

  /** 非致命问题（补历史、升级 hooks 失败）：服务仍在跑，但不假装全好了。 */
  get hostServicesWarnings(): readonly string[] {
    return [...this.hostWarnings];
  }

  /** hook server 实际监听的端口；没起来时为 null。 */
  get hookServerPort(): number | null {
    return this.hostPort;
  }

  /** 等自动启动那一轮结束（成功失败都算结束）；`autoStart:false` 时立刻完成。 */
  whenHostServicesReady(): Promise<void> {
    return this.hostReady;
  }

  /**
   * 启动 Claude 的宿主服务：已装 hooks 时补齐 → 起 hook server → 补历史 →
   * presence sweep → 收尾检测。幂等；失败只记录在状态里，不 reject。
   */
  async startHostServices(options: ClaudeHostServicesOptions): Promise<boolean> {
    if (this.hostState === "running") return true;
    if (this.hostStarting) return this.hostStarting;
    if (this.stopped) {
      this.hostState = "stopped";
      return false;
    }
    this.hostState = "starting";
    this.hostError = null;
    this.hostWarnings.length = 0;
    const run = this.runHostServices(options);
    this.hostStarting = run;
    this.hostReady = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.hostStarting = null;
    }
  }

  private async runHostServices(options: ClaudeHostServicesOptions): Promise<boolean> {
    const log =
      options.logger ??
      ((message: string, error?: unknown) => {
        if (error === undefined) console.warn(`[claude] ${message}`);
        else console.warn(`[claude] ${message}`, error);
      });

    try {
      // 只给装过 hooks 的用户补齐新事件；没装过的不主动写 ~/.claude。
      let installed = false;
      try {
        installed = options.installer.isInstalled(this.paths, options.supportDirectory);
      } catch (error) {
        this.warnHost(log, "检查 Claude hooks 是否已安装失败", error);
      }
      if (installed) {
        try {
          options.installer.upgradeIfNeeded(this.paths, options.supportDirectory);
        } catch (error) {
          this.warnHost(log, "升级 Claude hooks 失败", error);
        }
      }
      if (this.stopped) {
        this.hostState = "stopped";
        return false;
      }

      const port = await this.startHostServer(options, log);
      if (this.stopped) {
        this.stopHookServer();
        this.hostPort = null;
        this.hostState = "stopped";
        return false;
      }
      this.hostPort = port;

      // 补历史是异步的：失败只记日志，不上抛（hook server 已经能接活了）。
      try {
        await this.restoreRecentSessions();
      } catch (error) {
        this.warnHost(log, "补回最近会话失败", error);
      }
      // restore 的 finally 会起 presence；这里兜住它提前抛出的情况。
      this.startPresenceSweep();
      this.startTurnEndCheck();

      if (this.stopped) {
        this.stopHookServer();
        this.hostPort = null;
        this.hostState = "stopped";
        return false;
      }
      this.hostState = "running";
      return true;
    } catch (error) {
      this.hostPort = null;
      this.hostError = describeError(error);
      this.hostState = this.stopped ? "stopped" : "failed";
      log("Claude 宿主服务启动失败", error);
      return false;
    }
  }

  /** 端口冲突时按 EADDRINUSE 重试；其他错误立刻上报。 */
  private async startHostServer(
    options: ClaudeHostServicesOptions,
    log: (message: string, error?: unknown) => void,
  ): Promise<number> {
    const retries = Math.max(1, options.portRetries ?? ClaudeConnector.hostServerPortRetries);
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const port = await this.startHookServer({
          supportDirectory: options.supportDirectory,
          requestedPort: options.requestedPort ?? null,
          sharedSecret: defaultSharedSecretOptions(),
        });
        this.verifyHookServerFiles();
        return port;
      } catch (error) {
        lastError = error;
        this.stopHookServer();
        if (!isAddressInUse(error) || attempt === retries) throw error;
        log(`hook server 端口冲突，重试第 ${attempt + 1} 次`);
        await new Promise<void>((resolve) => setTimeout(resolve, 100 * attempt));
        if (this.stopped) throw error;
      }
    }
    throw lastError ?? new Error("hook server 没有启动");
  }

  /**
   * 端口文件 / 共享密钥文件写不出来时服务看着"起来了"，hook 脚本却连不上
   * （密钥不对还会全被 403）。当成启动失败，不假装能用。
   */
  private verifyHookServerFiles(): void {
    const server = this.hookServer;
    if (!server) throw new Error("hook server 没有实例");
    const portFile = server.portFileURL;
    if (portFile) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(portFile, "utf8"));
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          typeof (parsed as { port?: unknown }).port !== "number"
        ) {
          throw new Error("port 字段不对");
        }
      } catch (error) {
        throw new Error(`hook 端口文件不可读：${portFile}（${describeError(error)}）`);
      }
    }
    const secretFile = server.secretFileURL;
    if (secretFile) {
      try {
        const line = readFileSync(secretFile, "utf8");
        if (!line.includes(LocalHookServer.sharedSecret.headerName)) {
          throw new Error("密钥文件内容不对");
        }
      } catch (error) {
        throw new Error(`hook 共享密钥文件不可读：${secretFile}（${describeError(error)}）`);
      }
    }
  }

  private warnHost(
    log: (message: string, error?: unknown) => void,
    message: string,
    error: unknown,
  ): void {
    const detail = `${message}：${describeError(error)}`;
    this.hostWarnings.push(detail);
    log(detail, error);
  }

  /** 测试用：本机装没装 Claude（`~/.claude` 存在）。 */
  hasClaudeHome(): boolean {
    return hasClaudeHome(this.paths);
  }

  get messageReader(): MessageReader {
    return new ClaudeMessageReader(this.paths);
  }

  /** `~/.claude/projects` 下找会话文件（测试与诊断用）。 */
  transcriptFor(sessionID: string): string | null {
    return transcriptURL(sessionID, this.paths.projectsDirectory);
  }

  private sleep(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const entry = {
        handle: setTimeout(() => {
          this.sleepers.delete(entry);
          resolve(true);
        }, ms),
        resolve,
      };
      entry.handle.unref?.();
      this.sleepers.add(entry);
    });
  }
}

// ---------------------------------------------------------------------------
// 纯函数（上游 ClaudeConnector 的 static / private static）
// ---------------------------------------------------------------------------

/** 手机这次选的与会话上已经记着的合起来，得出之后每轮的 `--model` / `--effort`。 */
export function resolveModelSelection(
  selection: ModelSelection,
  session: Session | undefined,
  options: import("./claude-shared.js").ModelOption[] = ClaudeModels.defaultOptions(),
): { model?: string; effort?: string } {
  if (selection.model !== undefined && ClaudeModels.option(selection.model, options) === undefined) {
    throw new ConnectorError(`Claude Code 没有「${selection.model}」这个模型`);
  }
  const model = selection.model ?? session?.chosenModel;
  const effective = ClaudeModels.option(model ?? session?.model, options);
  const allowed = effective ? (effective.efforts ?? []) : (options[0]?.efforts ?? []);
  if (selection.effort !== undefined && !allowed.includes(selection.effort)) {
    throw new ConnectorError(
      allowed.length === 0
        ? "这个模型不能调思考强度"
        : `Claude Code 没有「${selection.effort}」这档思考强度`,
    );
  }
  const requestedEffort = selection.effort ?? session?.chosenEffort;
  const effort =
    requestedEffort !== undefined && allowed.includes(requestedEffort) ? requestedEffort : undefined;
  return { model, effort };
}

/** `claude` 的完整参数。 */
export function claudeArguments(input: {
  resuming: string | null;
  injection: AgentToolsInjection | null;
  model?: string;
  effort?: string;
  name?: string | null;
}): string[] {
  const arguments_: string[] = ["-p"];
  if (input.resuming !== null) arguments_.push("--resume", input.resuming);
  if (input.model) arguments_.push("--model", input.model);
  if (input.effort) arguments_.push("--effort", input.effort);
  if (input.name !== undefined && input.name !== null) arguments_.push(`--name=${input.name}`);
  if (input.injection) arguments_.push(...input.injection.claudeArguments());
  arguments_.push(
    "--input-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio",
    "--output-format",
    "stream-json",
    "--verbose",
  );
  return arguments_;
}

/** 这一轮写进 stdin 的 user 消息；图在起进程之前一次读进内存。 */
export function stdinMessage(prompt: string, images: ImageSource[]): Buffer {
  const loaded = images.map((image) => {
    if (image.type === "file") {
      let data: Buffer;
      try {
        data = readFileSync(image.path);
      } catch {
        throw new ConnectorError("读不到要发送的图片");
      }
      return { data, contentType: mediaType(image.path) };
    }
    return { data: Buffer.from(image.data), contentType: image.contentType };
  });
  return stdinPayload(prompt, loaded);
}

/** `--input-format stream-json` 的一条用户消息：一行 JSON 加 `\n`。 */
export function stdinPayload(
  prompt: string,
  images: Array<{ data: Buffer; contentType: string }>,
): Buffer {
  const content: Array<Record<string, unknown>> = images.map((image) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: image.contentType,
      data: image.data.toString("base64"),
    },
  }));
  if (prompt.trim().length > 0 || content.length === 0) {
    content.push({ type: "text", text: prompt });
  }
  const line = {
    type: "user",
    message: { role: "user", content },
  };
  return Buffer.from(`${sortedJson(line)}\n`, "utf8");
}

/** 由扩展名推 `media_type`；认不出的按 JPEG 报。 */
export function mediaType(path: string): string {
  const name = lastComponent(path);
  const dot = name.lastIndexOf(".");
  switch (dot < 0 ? "" : name.slice(dot + 1).toLowerCase()) {
    case "png":
      return "image/png";
    case "heic":
      return "image/heic";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

/** 子进程环境：继承本进程，再叠上注入的变量（同名以注入为准）。 */
export function buildEnvironment(
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) result[key] = value;
  return result;
}

/**
 * 读 Claude Code 的 `settings.json` 里的 `env` 块。
 *
 * 交互式 `claude` 自己会读它；`claude -p` 子进程不会，所以连接器显式合并，
 * 否则用第三方 Anthropic 兼容端点（token 写在 settings.json）的用户会看到
 * "Not logged in"。文件缺失/损坏时返回空对象，不报错。
 */
export function claudeSettingsEnvironment(
  settingsPath = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "settings.json",
  ),
): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: unknown };
    const env = parsed?.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** `ClaudeConnector.assistantText` 的只读入口（供测试与历史读取器使用）。 */
export function assistantTextInTranscript(object: Record<string, unknown>): string | null {
  return assistantText(object, narrationText);
}

/** 最后一条 assistant 文本；整段容错。 */
export function lastAssistantText(path: string): string | null {
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = data.split("\n").filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const text = assistantText(parsed as Record<string, unknown>, narrationText);
      if (text !== null) return text;
    } catch {
      continue;
    }
  }
  return null;
}

function directoryError(diagnosis: ClaudeFailureDiagnosis, path: string): ConnectorError {
  const message =
    diagnosis.kind === "folderAccessDenied"
      ? `BotBus 没有权限读取项目目录：${path}`
      : `项目目录不存在：${path}`;
  return new ConnectorError(message, { diagnosis });
}

function isMidTurn(session: Session | undefined): boolean {
  if (!session) return false;
  return session.status === "running" || session.status === "waitingApproval";
}

function resolveExecutable(executable: string | null): string | null {
  if (!executable) return null;
  try {
    return realpathSync(executable);
  } catch {
    return executable;
  }
}

function sameStrings(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function projectNameOf(path: string): string {
  const value = path.endsWith("/") ? path.slice(0, -1) : path;
  return lastComponent(value);
}

function lastComponent(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PORT: Windows 没有 SIGINT 的概念；中断整棵进程树（对齐 Win32.terminateProcessTree）。 */
function interruptProcess(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGINT");
}

/** 供 index 重新导出。 */
export type { ClaudePendingRequest, MessageReader };
