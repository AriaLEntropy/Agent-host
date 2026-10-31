import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  busStore,
  type BusCommandResult,
  type BusMessage,
  type BusMessageFileRef,
  type BusModelOption,
  type BusTask,
  type ListedAgent,
} from "../bus/store.js";
import {
  MAX_ARTIFACT_BYTES,
  getArtifact,
  isValidArtifactId,
  putArtifact,
  resolveAttachment,
} from "../bus/artifacts.js";
import { imagesForMessage } from "../bus/conversation-images.js";
import { hostDataDir } from "../config.js";
import {
  optionIdFor,
  parsePermissionRequest,
  parseSessionUpdate,
} from "./acp/messages.js";
import { AcpSessionState } from "./acp/session.js";
import { createClaudeConnector, createClaudeMessageReader } from "./claude/index.js";
import { createCodexConnector, createCodexMessageReader } from "./codex/index.js";
import { isDedicatedKind, type DedicatedKind } from "./descriptors.js";
import { discoverAgents, type AgentSpec } from "./discover.js";
import {
  createDshConnector,
  createDshMessageReader,
  type DshConnector,
  type DshInstallation,
} from "./dsh/native/index.js";
import { createHermesConnector, createHermesMessageReader } from "./hermes/index.js";
import {
  createOpenClawConnector,
  createOpenClawMessageReader,
  defaultWorkspaceDirectory,
  openClawPaths,
} from "./openclaw/index.js";
import { readFileByHandle } from "../platform/file-readability.js";
import { OutsideProjectRule } from "../platform/outside-project.js";
import {
  IDLE_AFTER_MS as OPENCODE_IDLE_AFTER_MS,
  OPENCODE_CONNECTOR_ID,
  RECENT_WINDOW_MS as OPENCODE_RECENT_WINDOW_MS,
  TITLE_LIMIT as OPENCODE_TITLE_LIMIT,
  createOpenCodeSessionReader,
  parseAcpTaskId,
  projectName as openCodeProjectName,
  scanOpenCodeSessions,
  singleLine as openCodeSingleLine,
  truncate as openCodeTruncate,
} from "./opencode/index.js";
import { createPiConnector, createPiMessageReader } from "./pi/index.js";
import type {
  ConnectorOutcome,
  ImageSource,
  MessageReader,
  ModelSelection,
  TaskConnector,
  TranscriptEntry,
} from "./ported/contract.js";
import { busHost } from "./ported/host.js";
import {
  resolve as resolveFileRefs,
  validate as validateFileRef,
} from "./ported/transcript-file-refs.js";
import { ConnectorSettings, normalizeProjectPath } from "./settings-store.js";

// Real agents can take tens of seconds to cold start (Gemini CLI measured
// 35–42s on Windows), so a 10s ceiling rejects agents that are merely slow.
export const INITIALIZE_TIMEOUT_MS = 60_000;
export const IDLE_MS = 10 * 60 * 1000;
const MAX_USER_MESSAGES = 40;
const MAX_TOOL_MESSAGES = 160;

/** 协议 2.9：单条消息最多 4 张图；上传阶段已把单张限制在 2 MiB。 */
export const MAX_ATTACHMENT_IMAGES = 4;

type AttachmentRef = { artifactId?: unknown };

/** 解析后的一张图：路径加本机缓存的类型，ACP 需要 mimeType。 */
type ResolvedAttachment = { artifactId: string; path: string; contentType: string };

/**
 * 逐个把协议里的 `attachments` 解析成本机文件。
 *
 * 只要有一张解析不到（id 非法 / 文件不在 / 已过期）就整体失败，绝不静默删图；
 * 超过协议上限的也直接拒绝。`agentKind` 只用于诊断文案——某家连接器是否支持
 * 图片由连接器自己判断并报错，这里不做预判。
 */
async function resolveAttachmentFiles(
  attachments: readonly unknown[],
  agentKind: string,
): Promise<ResolvedAttachment[]> {
  if (attachments.length > MAX_ATTACHMENT_IMAGES) {
    throw new Error(`一次最多只能发 ${MAX_ATTACHMENT_IMAGES} 张图片`);
  }
  const resolved: ResolvedAttachment[] = [];
  for (const item of attachments) {
    const attachment = item && typeof item === "object" ? (item as AttachmentRef) : {};
    const artifactId = typeof attachment.artifactId === "string" ? attachment.artifactId : "";
    const found = await resolveAttachment(attachment);
    if (!found) {
      throw new Error(
        `图片已过期或不存在：${artifactId || `(缺少 artifactId，来自 ${agentKind})`}`,
      );
    }
    resolved.push({ artifactId, path: found.path, contentType: found.contentType });
  }
  return resolved;
}

/**
 * 把手机发来的 `MessageAttachment[]` 解析成连接器认的 `ImageSource[]`
 * 任何一张失败都会抛错（见 `resolveAttachmentFiles`），调用方原样报给手机
 * 没有附件时返回空数组，调用方行为与之前一致。
 */
export async function resolveImages(
  attachments: readonly unknown[] | undefined,
  agentKind: string,
): Promise<ImageSource[]> {
  const resolved = await resolveAttachmentFiles(attachments ?? [], agentKind);
  return resolved.map((item) => ({ type: "file" as const, path: item.path }));
}

type AcpImageBlock = { type: "image"; data: string; mimeType: string };

/** ACP `session/prompt` 的图片块：读本机文件、base64，带上缓存的 mimeType */
async function acpImageBlocks(attachments: readonly ResolvedAttachment[]): Promise<AcpImageBlock[]> {
  const blocks: AcpImageBlock[] = [];
  for (const item of attachments) {
    let bytes: Buffer;
    try {
      bytes = await readFileByHandle(item.path, { maxBytes: MAX_ARTIFACT_BYTES });
    } catch {
      // 解析与读取之间文件被清理掉了：按“过期或不存在”处理，不静默丢图
      throw new Error(`图片已过期或不存在：${item.artifactId}`);
    }
    blocks.push({ type: "image", data: bytes.toString("base64"), mimeType: item.contentType });
  }
  return blocks;
}

export class AcpTimeout extends Error {}
export class AcpAuthRequired extends Error {}
export class AcpRejected extends Error {}

type LiveSession = {
  taskId: string;
  sessionId: string;
  cwd: string;
  state: AcpSessionState;
  /** `session/load` 重放中的状态；载入成功才替换 `state`。 */
  replay?: AcpSessionState;
};

type RpcResult = { result?: unknown; error?: { code?: number; message?: string } };

export class AcpProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private idleTimer: NodeJS.Timeout | undefined;
  /** 正在跑（含等审批）的轮数：有轮次时绝不因空闲关进程。 */
  private activeTurns = 0;
  private stderrTail = "";
  readonly capabilities = { loadSession: false, resume: false, image: false, listSessions: false };
  alive = false;

  constructor(
    private readonly executable: string,
    private readonly args: string[],
    private readonly extraEnv: Record<string, string>,
    private readonly onLineEvent: (message: Record<string, unknown>) => void,
    private readonly onExit: () => void,
    private readonly idleMs: number,
  ) {}

  async start() {
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };
    env.PATH = `${dirname(this.executable)}${delimiter}${env.PATH ?? ""}`;
    const ext = this.executable.slice(this.executable.lastIndexOf(".")).toLowerCase();
    const child = spawn(this.executable, this.args, {
      env,
      shell: ext === ".cmd" || ext === ".bat",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.alive = true;
    child.stdin.on("error", () => undefined);
    this.armIdle();
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.armIdle();
      this.onLine(line);
    });
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
    });
    child.on("exit", () => {
      this.alive = false;
      const detail = this.stderrTail.trim();
      this.failAll(new AcpRejected(detail ? `agent exited: ${detail}` : "agent exited"));
      this.onExit();
    });
    const result = (await this.call(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "agent-host", version: "1.0" },
      },
      INITIALIZE_TIMEOUT_MS,
    )) as Record<string, unknown>;
    if (result.protocolVersion !== 1) {
      this.kill();
      throw new AcpRejected("unsupported ACP version");
    }
    const agentCaps = record(result.agentCapabilities);
    // ACP puts promptCapabilities under agentCapabilities. The top-level
    // fallback keeps older fixtures (fake-acp) working.
    const promptCaps = {
      ...record(result.promptCapabilities),
      ...record(agentCaps.promptCapabilities),
    };
    const sessionCaps = record(agentCaps.sessionCapabilities);
    this.capabilities.loadSession = agentCaps.loadSession === true;
    // sessionCapabilities.resume is an object marker, not a boolean.
    this.capabilities.resume =
      sessionCaps.resume !== undefined && sessionCaps.resume !== null && sessionCaps.resume !== false;
    // ACP v1 的 `sessionCapabilities.list` 通常是个空对象；在就算支持。
    this.capabilities.listSessions =
      sessionCaps.list !== undefined && sessionCaps.list !== null && sessionCaps.list !== false;
    this.capabilities.image = promptCaps.image === true;
  }

  call(method: string, params: unknown, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpTimeout(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: number, result: unknown) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  /**
   * 一轮开始 / 结束。轮次未收尾（包括挂着审批）时不排空闲关闭：
   * 上游 `AcpConnector.stopIfIdle` 也是这么做的——审批可能等上很久。
   */
  setTurnActive(active: boolean) {
    this.activeTurns = Math.max(0, this.activeTurns + (active ? 1 : -1));
    if (this.activeTurns > 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    } else {
      this.armIdle();
    }
  }

  kill() {
    clearTimeout(this.idleTimer);
    this.alive = false;
    const child = this.child;
    if (!child || child.killed) return;
    // Windows .cmd shims spawn a real child; child.kill() only reaps the shim
    // and leaves the agent running (and locking its cwd).
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    child.kill();
  }

  private send(message: unknown) {
    this.armIdle();
    if (!this.child?.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The child may have exited between the writable check and the write.
    }
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    // 轮次还在跑：收尾时会重新排。
    if (this.activeTurns > 0) return;
    this.idleTimer = setTimeout(() => this.kill(), this.idleMs);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.method === "string" && typeof message.id === "number") {
      this.onLineEvent(message);
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      const body = message as RpcResult;
      if (body.error) {
        const detail = body.error.message ?? "ACP error";
        // Some agents (Gemini CLI) report missing credentials with a generic
        // code instead of -32000; classify by message so callers can surface
        // "log in on the computer" instead of a raw ACP error.
        const authLike =
          body.error.code === -32000 ||
          /auth|api[- ]?key|login|sign in|credential/i.test(detail);
        waiter.reject(authLike ? new AcpAuthRequired(detail) : new AcpRejected(detail));
        return;
      }
      waiter.resolve(body.result);
      return;
    }
    if (typeof message.method === "string") this.onLineEvent(message);
  }

  private failAll(error: Error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

const specs: AgentSpec[] = [];
const hiddenRegistryIds = new Set<string>();
const processes = new Map<string, AcpProcess>();
const sessions = new Map<string, LiveSession>();
const connectorModels = new Map<string, BusModelOption[]>();
const connectorModelLookup = new Map<string, Map<string, ModelResolution>>();
const probedModelAgents = new Set<string>();
let idleMs = IDLE_MS;

// MARK: - ACP session/list 周期对账

/** 上游 `AcpHub.listInterval`：进程在跑（或这一轮要拉起）时每 60 秒刷一次列表。 */
export const ACP_RECONCILE_INTERVAL_MS = 60_000;
/** 上游 `AcpHub.idleListInterval`：没在跑的 agent 每 600 秒才为对账拉起一次。 */
export const ACP_IDLE_RECONCILE_INTERVAL_MS = 600_000;
/** `session/list` 最多翻几页；超过就默默截断，不当错误。上游 `AcpClient.maxPages`。 */
const ACP_LIST_MAX_PAGES = 5;
const ACP_LIST_TIMEOUT_MS = 60_000;

type AcpListedSession = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
};

type AcpReconcileState = {
  /** 某个 agent 的第一次成功列表只写不推，之后才推变化。 */
  baselined: boolean;
  /** 上一次为对账拉起 / 使用进程的时间；没在跑的 agent 按 `idleListInterval` 节流。 */
  lastRefreshAt?: number;
  /** 握手明确说不支持 `session/list`：不再为它拉起进程。 */
  listUnsupported: boolean;
  /** 失败只记一次日志，成功后重置。 */
  listFailureLogged: boolean;
  /** OpenCode 数据库不存在/读不了：静默跳过。 */
  openCodeFailureLogged: boolean;
  /** OpenCode 扫描读满上限时最旧那条的时间；数据库覆盖不到的列表项要保留。 */
  coverageStart?: string;
};

const acpReconcileStates = new Map<string, AcpReconcileState>();
/** agent 的启动配置/开关/可用性变了就重建基线。 */
const acpReconcileSignatures = new Map<string, string>();
/**
 * 正在 `initialize` 的进程。它们在 `processes` 里还查不到，停用/重置时必须
 * 单独杀掉；否则一次对账刚好卡在启动中间会漏掉一个跑着的 agent。
 */
const startingProcesses = new Map<string, AcpProcess>();
/** 每个 agent 启动尝试的代号；停用/重置时加一，迟到的启动结果据此作废。 */
const processEpochs = new Map<string, number>();
let acpReconcileTimer: NodeJS.Timeout | undefined;
let acpReconcileIntervalMs = ACP_RECONCILE_INTERVAL_MS;
let acpIdleReconcileIntervalMs = ACP_IDLE_RECONCILE_INTERVAL_MS;
let acpReconcileGeneration = 0;
let acpReconciling = false;
const defaultAcpReconcileLogger = (message: string) => console.error(message);
let acpReconcileLogger: (message: string) => void = defaultAcpReconcileLogger;

/**
 * 一档连接器上报的模型列表，按 kind 缓存（Codex `model/list`、Claude 从本机 CLI 推断）。
 * ACP 的模型仍按 agent.id 存在 `connectorModels`；两边互不覆盖。
 */
const dedicatedModels = new Map<DedicatedKind, BusModelOption[]>();
/**
 * 项目级自动批准（协议 3.3）。键是 `<busAgentId>:<规范化项目路径>`。
 * 连接器收到审批时通过 `autoApproves(taskId, cwd)` 回调来查。
 */
const autoApproveProjects = new Map<string, boolean>();
/** 手机新建的一档/dsh 任务落到哪个项目；followUp 不带完整任务信息时也能找回。 */
const taskProjects = new Map<string, string>();

// MARK: - 本机连接器设置（自动批准 / 启停）持久化

/**
 * 惰性单例。首次 `refreshAgents()` / 需要落盘时创建；`resetRuntime()` 只丢
 * 内存缓存（文件保留），下一次需要时重新读。读取失败只记一次 warning。
 */
let connectorSettings: ConnectorSettings | undefined;
let connectorSettingsPromise: Promise<ConnectorSettings> | undefined;
let connectorSettingsGeneration = 0;
const defaultConnectorSettingsLogger = (message: string) => console.error(message);
let connectorSettingsLogger: (message: string) => void = defaultConnectorSettingsLogger;

/** ACP 用 agent id 当 connectorId；一档 / dsh 的开关只按 kind 区分。 */
function settingsConnectorId(agent: AgentSpec): string | undefined {
  return agent.kind === "acp" ? agent.id : undefined;
}

/** 启动时把持久化的自动批准灌进内存，连接器的同步回调只需查 Map。 */
function hydrateAutoApprove(settings: ConnectorSettings) {
  for (const entry of settings.snapshot().autoApprove) {
    const normalized = normalizeProjectPath(entry.projectPath);
    if (!normalized) continue;
    autoApproveProjects.set(`${entry.agentId}:${normalized}`, entry.enabled);
  }
}

async function ensureConnectorSettings(): Promise<ConnectorSettings> {
  if (connectorSettings) return connectorSettings;
  if (!connectorSettingsPromise) {
    const generation = connectorSettingsGeneration;
    connectorSettingsPromise = ConnectorSettings.load({ logger: connectorSettingsLogger }).then(
      (loaded) => {
        if (generation === connectorSettingsGeneration && !connectorSettings) {
          connectorSettings = loaded;
          hydrateAutoApprove(loaded);
        }
        if (generation === connectorSettingsGeneration) connectorSettingsPromise = undefined;
        return connectorSettings ?? loaded;
      },
    );
  }
  return connectorSettingsPromise;
}

/** 持久化的开关优先于 descriptor 默认值；没有记录才用默认值。 */
function applyEnabledOverrides(agents: AgentSpec[]) {
  const settings = connectorSettings;
  if (!settings) return;
  for (const agent of agents) {
    const override = settings.enabledOverride(agent.kind, settingsConnectorId(agent));
    if (override !== undefined) agent.enabled = override;
  }
}

/**
 * 测试 / 退出前用：等待当前设置的最后一次写入完成。
 * 没有创建过设置实例时什么都不做（也不会因此读盘）。
 */
export async function flushConnectorSettings(): Promise<void> {
  const settings =
    connectorSettings ?? (connectorSettingsPromise ? await connectorSettingsPromise : undefined);
  if (settings) await settings.flush();
}


/** 一档连接器实例：每种 kind 一个，按需创建；agent 消失 / 不可用 / 换可执行文件时销毁。 */
type DedicatedInstance = { connector: TaskConnector; executable?: string };
const dedicatedConnectors = new Map<DedicatedKind, DedicatedInstance>();
const dedicatedReaders = new Map<DedicatedKind, MessageReader>();

export type DedicatedConnectorFactory = (spec: AgentSpec) => TaskConnector;
export type DedicatedReaderFactory = () => MessageReader;
export type DedicatedFactoryOverrides = {
  connectors?: Partial<Record<DedicatedKind, DedicatedConnectorFactory>>;
  readers?: Partial<Record<DedicatedKind, DedicatedReaderFactory>>;
};

/** 测试注入缝：不提供时用真实的 `create<Name>Connector` / `create<Name>MessageReader`。 */
let dedicatedFactories: DedicatedFactoryOverrides = {};

export function setDedicatedFactories(overrides: DedicatedFactoryOverrides = {}) {
  dedicatedFactories = overrides;
}

/**
 * DeepSeek Harness 是一档来源（`dsh`），但不走 `DedicatedKind` 那套按 kind
 * 建的注册表：整台机器上只有一个 dsh，任务 id 形如 `dsh:<sessionId>`。这里单独
 * 留一个可注入工厂，测试用假连接器/读取器，不必启动真实 dsh。
 */
export type DshConnectorInstance = TaskConnector & {
  /** 观察入口；真实实现是 `DshConnector.startObserving()`。 */
  startObserving?: () => void;
  /** 停用观察；真实实现是 `DshConnector.stop()`。 */
  stop?: () => unknown;
  shutdown?: () => unknown;
  /** 真实 `DshConnector` 同时是 `MessageReader`；假的可以不实现。 */
  entries?: MessageReader["entries"];
};
export type DshConnectorFactory = (spec: AgentSpec) => DshConnectorInstance;
export type DshReaderFactory = () => MessageReader;
export type DshFactoryOverrides = {
  connector?: DshConnectorFactory;
  reader?: DshReaderFactory;
};

let dshFactories: DshFactoryOverrides = {};
type DshInstance = { connector: DshConnectorInstance; executable?: string };
let dshInstance: DshInstance | undefined;
let dshReader: MessageReader | undefined;

export function setDshFactories(overrides: DshFactoryOverrides = {}) {
  dshFactories = overrides;
}

/**
 * 一档连接器要用的运行时回调。集中在这里，既方便 `builtinConnector` 装配，
 * 也让测试可以不经真实 agent 直接验证模型列表与自动批准的状态流转。
 */
export type DedicatedConnectorHooks = {
  autoApproves: (taskId: string, cwd?: string) => boolean;
  models: () => BusModelOption[] | undefined;
  setModels: (models: BusModelOption[] | null) => boolean;
  broadcastSnapshot: () => void;
};

export function dedicatedConnectorHooks(kind: DedicatedKind): DedicatedConnectorHooks {
  return {
    autoApproves: (taskId, cwd) => autoApprovesForTask(taskId, cwd),
    models: () => dedicatedModels.get(kind),
    setModels: (models) => rememberDedicatedModels(kind, models),
    broadcastSnapshot: () => busStore.setAgents(specs.map(listed), true),
  };
}

const AUTO_APPROVE_KINDS = new Set(["codex", "claude"]);

function supportsAutoApprove(kind: string): boolean {
  return AUTO_APPROVE_KINDS.has(kind);
}

/** 协议 3.8：真正能永久删除会话的一档来源。 */
const DELETE_TASK_KINDS = new Set(["codex", "claude"]);
function supportsDeleteTask(kind: string): boolean {
  return DELETE_TASK_KINDS.has(kind);
}

/** 删除会话前必须停下来：运行中、等审批、等回答都不行。 */
function isMidTurnStatus(status: string): boolean {
  return status === "running" || status === "waitingApproval" || status === "waitingInput";
}

function autoApproveKey(projectPath: string): string {
  return `${busStore.agentId()}:${normalizeProjectPath(projectPath)}`;
}

/**
 * 续聊时任务没带 outsideProject 标记：按上游 `OutsideProjectRule` 判定，
 * 空路径、主目录、桌面/下载/文档、系统目录与 Agent 默认工作区都算「不在项目中」。
 * `projectsRoot` 等 FR-14.6.3 落地后再接进来。
 */
let openClawWorkspace: string | undefined | null = null;
function isOutsideProjectPath(projectPath: string): boolean {
  if (openClawWorkspace === null) {
    // 只算默认工作区，不读 `~/.openclaw/openclaw.json`：测试不能碰真实用户目录。
    // 自定义 workspace 要等连接器把配置暴露出来后再接。
    try {
      openClawWorkspace = defaultWorkspaceDirectory(openClawPaths().stateDirectory);
    } catch {
      openClawWorkspace = undefined;
    }
  }
  return new OutsideProjectRule({
    agentWorkspaces: openClawWorkspace ? { openclaw: openClawWorkspace } : {},
  }).contains(projectPath);
}

function isAutoApproveEnabled(projectPath: string): boolean {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return false;
  return autoApproveProjects.get(autoApproveKey(projectPath)) === true;
}

function setAutoApprove(projectPath: string, enabled: boolean) {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return;
  autoApproveProjects.set(autoApproveKey(projectPath), enabled);
}

/**
 * `startTask` / `followUp` 带 `autoApprove` 时同时更新内存与持久化。
 * 内存先落地，连接器哪怕立刻问也看得到；设置加载/写入失败由 settings 自己记日志。
 */
async function persistAutoApprove(projectPath: string, enabled: boolean) {
  setAutoApprove(projectPath, enabled);
  const settings = await ensureConnectorSettings();
  settings.setAutoApprove(busStore.agentId(), projectPath, enabled);
}

/**
 * `startTask` / `followUp` 带 `autoApprove` 时更新项目开关。
 * 返回错误文案表示这条命令必须失败；返回 undefined 表示可以继续。
 */
async function applyAutoApprove(
  kind: string,
  value: unknown,
  projectPath: string,
  outsideProject: boolean,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (!supportsAutoApprove(kind)) return "this agent does not support auto approve";
  if (typeof value !== "boolean") return "autoApprove must be a boolean";
  if (outsideProject) {
    // 项目外的开启照旧拒绝，且绝不写进持久化。
    return value ? "auto approve is not available outside a project" : undefined;
  }
  await persistAutoApprove(projectPath, value);
  return undefined;
}

/** 连接器问「这个任务所在项目开没开自动批准」；新任务的第一轮还没有 task 就用 cwd。 */
function autoApprovesForTask(taskId: string, cwd?: string): boolean {
  const fromTask = busStore.taskById(taskId)?.projectPath;
  const projectPath = cwd?.trim() || fromTask?.trim() || taskProjects.get(taskId) || "";
  if (!projectPath) return false;
  return isAutoApproveEnabled(projectPath);
}

/** 写入一档模型缓存；变化时返回 true 并推快照。 */
function rememberDedicatedModels(kind: DedicatedKind, models: BusModelOption[] | null): boolean {
  const next = Array.isArray(models) ? models.slice(0, 24) : [];
  const before = JSON.stringify(dedicatedModels.get(kind) ?? []);
  const after = JSON.stringify(next);
  if (before === after) return false;
  if (next.length > 0) dedicatedModels.set(kind, next);
  else dedicatedModels.delete(kind);
  busStore.setAgents(specs.map(listed), true);
  return true;
}

// MARK: - ACP 对账（session/list + OpenCode 数据库）

/** 测试注入：把周期调小；0 = 只手动对账。 */
export function setAcpReconcileInterval(ms: number) {
  acpReconcileIntervalMs =
    Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : ACP_RECONCILE_INTERVAL_MS;
  restartAcpReconcileTimer();
}

/** 测试注入：没在跑的 agent 多久才重新拉起一次；0 = 跟运行中的周期一样。 */
export function setAcpIdleReconcileInterval(ms: number) {
  acpIdleReconcileIntervalMs =
    Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : ACP_IDLE_RECONCILE_INTERVAL_MS;
}

/** 测试注入：失败日志默认走 stderr；传空函数可静音。 */
export function setAcpReconcileLogger(logger: (message: string) => void = defaultAcpReconcileLogger) {
  acpReconcileLogger = logger;
}

/** 手动跑一轮（测试与发现后的立即对账用）。 */
export async function reconcileAcpSessionsNow(): Promise<void> {
  await reconcileAcpSessionsOnce();
}

function acpReconcileEligible(spec: AgentSpec): boolean {
  if (spec.kind !== "acp" || !spec.enabled) return false;
  // OpenCode 的会话在本地 SQLite 里，没有二进制也能读；其余 agent 要先有可执行文件。
  if (spec.id === OPENCODE_CONNECTOR_ID) return true;
  return spec.available && Boolean(spec.executable);
}

function acpReconcileSignature(spec: AgentSpec): string {
  return JSON.stringify([spec.executable ?? "", spec.args, spec.env, spec.available, spec.enabled]);
}

function acpReconcileState(id: string): AcpReconcileState {
  let state = acpReconcileStates.get(id);
  if (!state) {
    state = { baselined: false, listUnsupported: false, listFailureLogged: false, openCodeFailureLogged: false };
    acpReconcileStates.set(id, state);
  }
  return state;
}

/**
 * `useAgents` / 启停 / 重置后调用：清掉变化或消失 agent 的基线，按是否还有
 * 可对账的 agent 启停计时器。停用或移除的 agent 不会留下计时器。
 */
function syncAcpReconcile(agents: AgentSpec[]) {
  const acpAgents = agents.filter((agent) => agent.kind === "acp");
  const known = new Set(acpAgents.map((agent) => agent.id));
  for (const id of [...acpReconcileStates.keys()]) {
    if (!known.has(id)) acpReconcileStates.delete(id);
  }
  for (const id of [...acpReconcileSignatures.keys()]) {
    if (!known.has(id)) acpReconcileSignatures.delete(id);
  }
  for (const spec of acpAgents) {
    const signature = acpReconcileSignature(spec);
    if (acpReconcileSignatures.get(spec.id) !== signature) {
      acpReconcileSignatures.set(spec.id, signature);
      // 启动方式 / 可用性 / 开关变了：能力与列表基线都重新算，回来后再静默一轮。
      acpReconcileStates.delete(spec.id);
    }
  }
  acpReconcileGeneration += 1;
  restartAcpReconcileTimer();
}

function restartAcpReconcileTimer() {
  if (acpReconcileTimer) {
    clearInterval(acpReconcileTimer);
    acpReconcileTimer = undefined;
  }
  if (acpReconcileIntervalMs <= 0) return;
  if (!specs.some(acpReconcileEligible)) return;
  const timer = setInterval(() => {
    void reconcileAcpSessionsOnce();
  }, acpReconcileIntervalMs);
  // 不拖住进程退出；Node 还有别的工作时会照常触发。
  timer.unref?.();
  acpReconcileTimer = timer;
}

function resetAcpReconcile() {
  if (acpReconcileTimer) clearInterval(acpReconcileTimer);
  acpReconcileTimer = undefined;
  acpReconcileStates.clear();
  acpReconcileSignatures.clear();
  acpReconcileIntervalMs = ACP_RECONCILE_INTERVAL_MS;
  acpIdleReconcileIntervalMs = ACP_IDLE_RECONCILE_INTERVAL_MS;
  acpReconcileGeneration += 1;
  acpReconciling = false;
  acpReconcileLogger = defaultAcpReconcileLogger;
}

async function reconcileAcpSessionsOnce() {
  // 上一轮还没跑完（某个 agent 初始化慢）就先跳过这一拍。
  if (acpReconciling) return;
  acpReconciling = true;
  const generation = acpReconcileGeneration;
  try {
    const now = Date.now();
    for (const spec of specs.filter(acpReconcileEligible)) {
      if (generation !== acpReconcileGeneration) return;
      const state = acpReconcileState(spec.id);
      // 与上游 `AcpHub.refreshLists` 一致：进程在跑就按列表周期刷，闲着就很久才为对账拉起一次。
      // OpenCode 读的是本机数据库、没有常驻进程，按"在跑"处理以免新会话十分钟才出现。
      const running =
        spec.id === OPENCODE_CONNECTOR_ID || processes.get(processKey(spec))?.alive === true;
      const interval = running
        ? acpReconcileIntervalMs
        : Math.max(acpReconcileIntervalMs, acpIdleReconcileIntervalMs);
      if (state.lastRefreshAt !== undefined && now - state.lastRefreshAt < interval) continue;
      // 先记时间再跑：这一拍起不来也算试过，不会在下一个周期里反复拉起。
      state.lastRefreshAt = now;
      await reconcileAcpAgent(spec, generation);
    }
  } finally {
    acpReconciling = false;
  }
}

async function reconcileAcpAgent(spec: AgentSpec, generation: number) {
  const state = acpReconcileState(spec.id);
  const incoming = new Map<string, BusTask>();
  let sourceSucceeded = false;
  let openCodeComplete = false;
  let coverageStart: string | undefined;
  let listSucceeded = false;
  let listComplete = false;

  // 1. OpenCode 的数据库是权威来源：能读就先合并；读不了静默跳过。
  if (spec.id === OPENCODE_CONNECTOR_ID) {
    try {
      const scan = scanOpenCodeSessions({ agentId: busStore.agentId() });
      coverageStart = scan.coverageStart;
      state.openCodeFailureLogged = false;
      for (const task of scan.tasks) incoming.set(task.id, task);
      sourceSucceeded = true;
      openCodeComplete = true;
    } catch {
      // 数据库不存在 / 读失败：不向手机报错，保留上一轮任务，等下一拍再试。
      if (!state.openCodeFailureLogged) state.openCodeFailureLogged = true;
    }
  }

  // 2. 声明了 sessionCapabilities.list 的 agent 拉一次 session/list。
  if (!state.listUnsupported && spec.available && spec.executable) {
    const process = await acpProcessForReconcile(spec, state);
    if (process) {
      if (!process.capabilities.listSessions) {
        state.listUnsupported = true;
      } else {
        try {
          const listed = await listAcpSessions(process);
          if (generation !== acpReconcileGeneration) return;
          state.listFailureLogged = false;
          listSucceeded = true;
          listComplete = listed.complete;
          sourceSucceeded = true;
          const nowMs = Date.now();
          for (const info of listed.sessions) {
            if (!acpListItemInWindow(info, nowMs)) continue;
            const task = acpListedTask(spec, info, process);
            if (spec.id === OPENCODE_CONNECTOR_ID) {
              // 数据库里已有的以数据库为准；数据库读了却没读到、且没超出覆盖窗口的，同样不列。
              if (incoming.has(task.id)) continue;
              if (openCodeComplete && openCodeCovers(coverageStart, task.updatedAt)) continue;
            }
            incoming.set(task.id, task);
          }
        } catch {
          if (!state.listFailureLogged) {
            state.listFailureLogged = true;
            acpReconcileLogger(`acp session/list failed for ${spec.id}`);
          }
        }
      }
    }
  }

  if (!sourceSucceeded || generation !== acpReconcileGeneration) return;

  const baseline = !state.baselined;
  for (const task of incoming.values()) {
    // 实时数据（正在跑的会话 / 手机起的）拥有这条任务，只读观察不能改写。
    if (busHost.isLive(task.id) || sessions.has(task.id)) continue;
    const existing = busStore.taskById(task.id);
    const merged = mergeListedTask(task, existing);
    if (baseline) {
      busStore.upsertTask(merged, false);
    } else if (!existing || taskFingerprint(existing) !== taskFingerprint(merged)) {
      busStore.upsertTask(merged);
    }
  }
  state.baselined = true;
  state.coverageStart = coverageStart;

  if (baseline) return;
  // OpenCode 以数据库为准（读满上限时只摘 coverageStart 之后的）；其余看列表是否完整。
  const canRemove =
    spec.id === OPENCODE_CONNECTOR_ID ? openCodeComplete : listSucceeded && listComplete;
  if (canRemove) removeMissingListedTasks(spec, incoming, coverageStart);
}

async function acpProcessForReconcile(
  spec: AgentSpec,
  state: AcpReconcileState,
): Promise<AcpProcess | undefined> {
  try {
    return await ensureProcess(spec);
  } catch {
    if (!state.listFailureLogged) {
      state.listFailureLogged = true;
      // 只记类别，不把 stderr / agent 错误文本带进日志。
      acpReconcileLogger(`acp session/list could not start ${spec.id}`);
    }
    return undefined;
  }
}

/** `session/list`，按 `nextCursor` 翻页；翻满上限还没完就标记不完整。 */
async function listAcpSessions(
  process: AcpProcess,
): Promise<{ sessions: AcpListedSession[]; complete: boolean }> {
  const sessions: AcpListedSession[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  for (let page = 0; page < ACP_LIST_MAX_PAGES; page += 1) {
    const params: Record<string, unknown> = {};
    if (cursor) params.cursor = cursor;
    const result = record(await process.call("session/list", params, ACP_LIST_TIMEOUT_MS));
    const raw = Array.isArray(result.sessions) ? result.sessions : [];
    for (const item of raw) {
      const parsed = parseAcpListedSession(item);
      if (parsed) sessions.push(parsed);
    }
    const next = typeof result.nextCursor === "string" ? result.nextCursor : "";
    if (!next || seenCursors.has(next)) return { sessions, complete: true };
    seenCursors.add(next);
    cursor = next;
  }
  return { sessions, complete: false };
}

function parseAcpListedSession(value: unknown): AcpListedSession | undefined {
  const item = record(value);
  const sessionId = typeof item.sessionId === "string" ? item.sessionId : "";
  const cwd = typeof item.cwd === "string" ? item.cwd : "";
  if (!sessionId || !cwd) return undefined;
  const title = typeof item.title === "string" ? item.title : undefined;
  const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : undefined;
  return {
    sessionId,
    cwd,
    ...(title !== undefined ? { title } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/**
 * `session/list` 一条 → `BusTask`。规则照上游 `AcpConnector.listedRecord`：
 * 24 小时内动过是 completed，否则 idle；标题为空回落到项目名/会话 id；
 * 能不能从手机续聊看 loadSession / resume 能力。
 */
function acpListedTask(spec: AgentSpec, info: AcpListedSession, process: AcpProcess): BusTask {
  const now = Date.now();
  const updatedMs = info.updatedAt ? Date.parse(info.updatedAt) : Number.NaN;
  const hasUpdated = Number.isFinite(updatedMs);
  const updatedAt = hasUpdated ? new Date(updatedMs).toISOString() : new Date(now).toISOString();
  const project = openCodeProjectName(info.cwd);
  const title =
    openCodeTruncate(openCodeSingleLine(info.title ?? ""), OPENCODE_TITLE_LIMIT) ||
    project ||
    info.sessionId;
  return {
    id: `acp:${spec.id}:${info.sessionId}`,
    agentId: busStore.agentId(),
    source: "acp",
    connectorId: spec.id,
    title,
    projectPath: info.cwd,
    projectName: project,
    status: !hasUpdated || now - updatedMs > OPENCODE_IDLE_AFTER_MS ? "idle" : "completed",
    origin: "desktop",
    controllable: process.capabilities.loadSession || process.capabilities.resume,
    startedAt: updatedAt,
    updatedAt,
  };
}

/** 上游 `SessionFormatting.recentWindow`：列表里只留 7 天窗口内的会话。 */
function acpListItemInWindow(info: AcpListedSession, nowMs: number): boolean {
  if (!info.updatedAt) return true;
  const updated = Date.parse(info.updatedAt);
  return !Number.isFinite(updated) || nowMs - updated <= OPENCODE_RECENT_WINDOW_MS;
}

/** OpenCode 读满上限时，只有更新于 coverageStart 的记录算「数据库覆盖到了」。 */
function openCodeCovers(coverageStart: string | undefined, updatedAt: string): boolean {
  if (!coverageStart) return true;
  const start = Date.parse(coverageStart);
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(updated)) return true;
  return updated >= start;
}

/** 列表/数据库报上来的记录覆盖标题与状态，但保留用户选的模型和项目外标记。 */
function mergeListedTask(incoming: BusTask, existing: BusTask | undefined): BusTask {
  if (!existing) return incoming;
  return {
    ...incoming,
    ...(existing.model ? { model: existing.model } : {}),
    ...(existing.effort ? { effort: existing.effort } : {}),
    ...(existing.outsideProject ? { outsideProject: true } : {}),
  };
}

function taskFingerprint(task: BusTask): string {
  return JSON.stringify([
    task.id,
    task.agentId,
    task.source,
    task.connectorId ?? "",
    task.title,
    task.projectPath,
    task.projectName,
    task.status,
    task.lastMessage ?? "",
    task.origin,
    task.controllable,
    task.startedAt,
    task.updatedAt,
    task.model ?? "",
    task.effort ?? "",
    Boolean(task.outsideProject),
    task.pendingRequest ?? null,
  ]);
}

/**
 * 权威来源里没有的会话：从手机上摘掉。被实时认领的（正在跑、手机起的）不动；
 * OpenCode 读满上限时，早于 coverageStart 的任务本来就没被读到，也不动。
 */
function removeMissingListedTasks(
  spec: AgentSpec,
  incoming: Map<string, BusTask>,
  coverageStart: string | undefined,
) {
  const coverageMs = coverageStart ? Date.parse(coverageStart) : Number.NaN;
  const tasks = busStore.snapshot().tasks as BusTask[];
  for (const task of tasks) {
    if (task.source !== "acp" || task.connectorId !== spec.id) continue;
    if (incoming.has(task.id)) continue;
    if (busHost.isLive(task.id) || sessions.has(task.id)) continue;
    if (Number.isFinite(coverageMs)) {
      const updated = Date.parse(task.updatedAt);
      if (!Number.isFinite(updated) || updated < coverageMs) continue;
    }
    busStore.removeTask(task.id);
  }
}

export function useAgents(agents: AgentSpec[], announce = false) {
  // 持久化的启停覆盖优先于 descriptor 默认值（OpenClaw 默认关闭）。
  applyEnabledOverrides(agents);
  specs.splice(0, specs.length, ...agents);
  const known = new Set(agents.map((agent) => agent.id));
  for (const id of connectorModels.keys()) {
    if (!known.has(id)) {
      connectorModels.delete(id);
      connectorModelLookup.delete(id);
    }
  }
  const knownKinds = new Set(
    agents.filter((agent) => isDedicatedKind(agent.kind)).map((agent) => agent.kind as DedicatedKind),
  );
  for (const kind of [...dedicatedModels.keys()]) {
    if (!knownKinds.has(kind)) dedicatedModels.delete(kind);
  }
  reconcileDedicated(agents);
  reconcileDsh(agents);
  syncAcpReconcile(agents);
  busStore.setAgents(agents.map(listed), announce);
}

export function resetRuntime() {
  // 先把还在 initialize 的也作废并杀掉，否则它们会在 map 清空后才挂进来。
  for (const key of new Set([...processes.keys(), ...startingProcesses.keys()])) {
    processEpochs.set(key, (processEpochs.get(key) ?? 0) + 1);
  }
  for (const process of startingProcesses.values()) process.kill();
  startingProcesses.clear();
  for (const process of processes.values()) process.kill();
  processes.clear();
  sessions.clear();
  hiddenRegistryIds.clear();
  connectorModels.clear();
  connectorModelLookup.clear();
  probedModelAgents.clear();
  dedicatedModels.clear();
  autoApproveProjects.clear();
  taskProjects.clear();
  for (const kind of [...dedicatedConnectors.keys()]) destroyDedicated(kind);
  dedicatedReaders.clear();
  dedicatedFactories = {};
  destroyDsh();
  dshFactories = {};
  specs.splice(0, specs.length);
  idleMs = IDLE_MS;
  resetAcpReconcile();
  busStore.setAgents([]);
  // 只清内存缓存：设置文件保留，下次刷新 / 落盘时重新读取。
  // 已排队但未触发的写入先尽力刷出去，避免刚改完就重置时丢掉。
  const previousSettings = connectorSettings;
  connectorSettingsGeneration += 1;
  connectorSettings = undefined;
  connectorSettingsPromise = undefined;
  connectorSettingsLogger = defaultConnectorSettingsLogger;
  if (previousSettings) void previousSettings.flush();
}

export function setIdleMs(ms: number) {
  idleMs = ms;
}

/** 测试注入缝：不提供时用 `discoverAgents` 探测本机。 */
export type AgentDiscovery = (input: {
  hiddenRegistryIds: ReadonlySet<string>;
}) => Promise<{ agents: AgentSpec[]; problems?: unknown[] }>;

export async function refreshAgents(
  discover: AgentDiscovery = (input) => discoverAgents(input),
) {
  const found = await discover({ hiddenRegistryIds });
  // 先读本机设置，让 useAgents 在构建快照前套用启停覆盖。
  await ensureConnectorSettings();
  useAgents(found.agents, true);
  warmConnectorModels(found.agents);
  return found;
}

/**
 * 模型列表来自 ACP 的 session/new（availableModels），没有单独的查询接口。
 * 连接器第一次出现时用一个空的探测 session 取一次并缓存；探测失败不影响
 * 连接器本身。并发的冷启动可能很慢，所以两个一组。
 */
export function warmConnectorModels(agents: AgentSpec[] = specs) {
  const pending = agents.filter(
    (agent) =>
      // dsh 走 native 连接器，模型列表不在 ACP `session/new` 上；不要为它起旧 AcpProcess。
      agent.kind === "acp" &&
      agent.available &&
      agent.executable &&
      !probedModelAgents.has(agent.id),
  );
  for (const agent of pending) probedModelAgents.add(agent.id);
  if (pending.length === 0) return;
  void (async () => {
    for (let index = 0; index < pending.length; index += 2) {
      await Promise.all(pending.slice(index, index + 2).map((agent) => probeModels(agent)));
    }
  })();
}

async function probeModels(spec: AgentSpec) {
  try {
    const process = await ensureProcess(spec);
    const cwd = join(hostDataDir(), "model-probe");
    await mkdir(cwd, { recursive: true });
    const created = await process.call("session/new", { cwd, mcpServers: [] });
    rememberModels(spec, created);
  } catch {
    // 模型列表是可选能力：探测失败时保持连接器可用。
  }
}

type ModelResolution = {
  acpIds: Map<string, string>;
  defaultAcpId: string;
  defaultEffort: string;
};

type RawModel = {
  rawId: string;
  name: string;
  base: string;
  effort: string;
  grouped: boolean;
};

/**
 * ACP 的模型 id 可能是 `gpt-6.1-sol[high]` 这种“模型+强度”的组合，
 * 而且 `[` `]` 不在协议允许的 ModelOption.id 字符集里。名字以
 * `(high)` 结尾的条目按模型分组，强度放进 efforts；其余条目原样
 * 保留，只把非法字符换成 `-`，再用 lookup 映射回 ACP 的真实 id。
 */
function modelCatalogFromSession(created: unknown): {
  options: BusModelOption[];
  lookup: Map<string, ModelResolution>;
} {
  const models = record(record(created).models);
  const available = Array.isArray(models.availableModels) ? models.availableModels : [];
  const currentRaw = typeof models.currentModelId === "string" ? models.currentModelId : "";
  const raw: RawModel[] = [];
  const seenRaw = new Set<string>();
  for (const item of available) {
    const model = record(item);
    const rawId =
      typeof model.modelId === "string"
        ? model.modelId
        : typeof model.id === "string"
          ? model.id
          : "";
    if (!rawId || seenRaw.has(rawId)) continue;
    seenRaw.add(rawId);
    const name = typeof model.name === "string" ? model.name.trim() : "";
    const suffix = /^(.*)\[([a-z0-9-]{1,16})\]$/.exec(rawId);
    const base = suffix?.[1] || rawId;
    const effort = suffix?.[2] || "";
    raw.push({
      rawId,
      name: name || rawId,
      base,
      effort,
      grouped: effort !== "" && name.toLowerCase().endsWith(`(${effort})`.toLowerCase()),
    });
  }

  const groups = new Map<string, RawModel[]>();
  for (const entry of raw) {
    if (!entry.grouped) continue;
    const list = groups.get(entry.base) ?? [];
    list.push(entry);
    groups.set(entry.base, list);
  }

  const catalog: Array<{
    option: BusModelOption;
    resolution: ModelResolution;
    isCurrent: boolean;
  }> = [];
  const usedIds = new Set<string>();

  for (const entry of raw) {
    if (entry.grouped) {
      const group = groups.get(entry.base);
      if (!group || group[0] !== entry) continue;
      const efforts: string[] = [];
      const acpIds = new Map<string, string>();
      for (const member of group) {
        if (!efforts.includes(member.effort)) efforts.push(member.effort);
        if (!acpIds.has(member.effort)) acpIds.set(member.effort, member.rawId);
      }
      const current = group.find((member) => member.rawId === currentRaw);
      const fallback = efforts.includes("medium") ? "medium" : efforts[0];
      const defaultEffort = current?.effort || fallback || "";
      const displayName = group[0].name.replace(/\s*\([^)]*\)\s*$/, "").trim() || entry.base;
      const optionId = uniqueModelId(sanitizeModelId(entry.base), usedIds);
      catalog.push({
        option: {
          id: optionId,
          displayName: truncateModelName(displayName),
          efforts,
          ...(defaultEffort ? { defaultEffort } : {}),
        },
        resolution: {
          acpIds,
          defaultAcpId: acpIds.get(defaultEffort) ?? group[0].rawId,
          defaultEffort,
        },
        isCurrent: Boolean(current),
      });
      continue;
    }
    const optionId = uniqueModelId(sanitizeModelId(entry.rawId), usedIds);
    catalog.push({
      option: { id: optionId, displayName: truncateModelName(entry.name) },
      resolution: { acpIds: new Map(), defaultAcpId: entry.rawId, defaultEffort: "" },
      isCurrent: entry.rawId === currentRaw,
    });
  }

  // 默认的在前
  const currentIndex = catalog.findIndex((item) => item.isCurrent);
  if (currentIndex > 0) catalog.unshift(catalog.splice(currentIndex, 1)[0]);

  const lookup = new Map<string, ModelResolution>();
  const options = catalog.slice(0, 24).map((item) => {
    lookup.set(item.option.id, item.resolution);
    return item.option;
  });
  return { options, lookup };
}

function sanitizeModelId(value: string) {
  const cleaned = value
    .replace(/[^A-Za-z0-9._:/-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return cleaned || "model";
}

function uniqueModelId(base: string, used: Set<string>) {
  let id = base;
  let index = 2;
  while (used.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  used.add(id);
  return id;
}

function truncateModelName(name: string) {
  return name.length > 40 ? name.slice(0, 40) : name;
}

function rememberModels(spec: AgentSpec, created: unknown) {
  const catalog = modelCatalogFromSession(created);
  if (catalog.options.length === 0) return;
  const before = JSON.stringify(connectorModels.get(spec.id));
  const after = JSON.stringify(catalog.options);
  connectorModels.set(spec.id, catalog.options);
  connectorModelLookup.set(spec.id, catalog.lookup);
  if (before !== after) busStore.setAgents(specs.map(listed), true);
}

/** 把协议侧 id（可能带 efforts）还原成 ACP session/set_model 要的真实 id */
function resolveModel(spec: AgentSpec, modelId: string, effort: string) {
  const entry = connectorModelLookup.get(spec.id)?.get(modelId);
  if (!entry) return { acpId: modelId, effort };
  const chosenEffort = effort && entry.acpIds.has(effort) ? effort : entry.defaultEffort;
  return {
    acpId: entry.acpIds.get(chosenEffort) ?? entry.defaultAcpId,
    effort: chosenEffort,
  };
}

async function applyModel(
  process: AcpProcess,
  sessionId: string,
  currentModelId: string,
  modelId: string,
) {
  if (currentModelId === modelId) return;
  try {
    await process.call("session/set_model", { sessionId, modelId }, 30_000);
  } catch (error) {
    throw new AcpRejected(`model is not available: ${messageOf(error)}`);
  }
}

export function executeCommand(command: Record<string, unknown>): Promise<BusCommandResult> {
  const id = String(command.id);
  const kind = String(command.kind);
  const finishedAt = () => new Date().toISOString();
  const fail = (error: string): BusCommandResult => ({ commandId: id, ok: false, error, finishedAt: finishedAt() });
  if (kind === "remoteControl" || kind === "fetchChanges" || kind === "mergeWorktree") {
    return Promise.resolve(fail("not supported"));
  }
  if (kind === "startTask") return startTask(id, record(command.startTask)).catch((error) => fail(messageOf(error)));
  if (kind === "followUp") return followUp(id, record(command.followUp)).catch((error) => fail(messageOf(error)));
  if (kind === "approve") return approve(id, record(command.approve)).catch((error) => fail(messageOf(error)));
  if (kind === "interrupt") return interrupt(id, record(command.interrupt)).catch((error) => fail(messageOf(error)));
  if (kind === "fetchMessages") return fetchMessages(id, record(command.fetchMessages)).catch((error) => fail(messageOf(error)));
  if (kind === "fetchFile") return fetchFile(id, record(command.fetchFile)).catch((error) => fail(messageOf(error)));
  if (kind === "deleteTask") return deleteTask(id, record(command.deleteTask)).catch((error) => fail(messageOf(error)));
  if (kind === "removeProject") {
    return removeProject(id, record(command.removeProject)).catch((error) => fail(messageOf(error)));
  }
  if (kind === "setConnectorEnabled") {
    return setConnectorEnabled(id, record(command.setConnectorEnabled)).catch((error) => fail(messageOf(error)));
  }
  if (kind === "restartConnector") {
    return restartConnector(id, record(command.restartConnector)).catch((error) => fail(messageOf(error)));
  }
  return Promise.resolve(fail("no connector is available"));
}

async function startTask(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const source = payload.source;
  if (isDedicatedKind(source)) return startDedicatedTask(commandId, source, payload);
  if (source === "dsh") return startDshTask(commandId, payload);
  const spec =
    source === "acp"
      ? specs.find((agent) => agent.kind === "acp" && agent.id === payload.connectorId)
      : undefined;
  if (!spec) return done(commandId, false, "no connector is available");
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  if (!spec.executable) return done(commandId, false, spec.lastError ?? "no connector is available");
  if (payload.autoApprove !== undefined) {
    return done(commandId, false, "this agent does not support auto approve");
  }
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  // 先解析附件：缺图/过期/超过 4 张都在起进程之前失败。
  const resolvedAttachments = await resolveAttachmentFiles(attachments, "acp");
  const process = await ensureProcess(spec);
  if (resolvedAttachments.length > 0 && !process.capabilities.image) {
    return done(commandId, false, "image is not supported");
  }
  const imageBlocks = await acpImageBlocks(resolvedAttachments);
  const hasProject = typeof payload.projectPath === "string" && payload.projectPath.trim().length > 0;
  const cwd = hasProject ? String(payload.projectPath).trim() : homedir();
  const created = record(await process.call("session/new", { cwd, mcpServers: [] }));
  const sessionId = typeof created.sessionId === "string" ? created.sessionId : "";
  if (!sessionId) return done(commandId, false, "session/new did not return a session id");
  rememberModels(spec, created);
  const requestedModel = typeof payload.model === "string" ? payload.model.trim() : "";
  const requestedEffort = typeof payload.effort === "string" ? payload.effort.trim() : "";
  let appliedEffort = "";
  if (requestedModel) {
    const currentModel =
      typeof record(created.models).currentModelId === "string"
        ? String(record(created.models).currentModelId)
        : "";
    const resolved = resolveModel(spec, requestedModel, requestedEffort);
    await applyModel(process, sessionId, currentModel, resolved.acpId);
    appliedEffort = resolved.effort;
  }
  const taskId = `acp:${spec.id}:${sessionId}`;
  const now = new Date().toISOString();
  const task = baseTask(spec, taskId, cwd, prompt.slice(0, 80) || "新任务", now, !hasProject);
  if (requestedModel) task.model = requestedModel;
  if (appliedEffort) task.effort = appliedEffort;
  sessions.set(taskId, {
    taskId,
    sessionId,
    cwd,
    state: new AcpSessionState({
      title: task.title,
      projectName: task.projectName,
      status: task.status,
      updatedAt: now,
    }),
  });
  busStore.rememberSession(taskId, sessionId, "acp");
  if (hasProject) {
    busStore.rememberProject({
      agentId: task.agentId,
      path: cwd,
      name: task.projectName,
      lastUsedAt: now,
      pinned: false,
    });
  }
  busStore.upsertTask(task);
  void runPrompt(process, taskId, prompt, imageBlocks).catch((error) =>
    markFailed(taskId, messageOf(error)),
  );
  return { commandId, ok: true, taskId, finishedAt: now };
}

async function followUp(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const dedicatedKind = dedicatedKindOf(taskId);
  if (dedicatedKind) return dedicatedFollowUp(commandId, dedicatedKind, taskId, payload);
  if (isDshTaskId(taskId)) return dshFollowUp(commandId, taskId, payload);
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!task) return done(commandId, false, "task not found");
  if (!session) return done(commandId, false, "task not found");
  // 与上游一致：一个会话同时只跑一轮，手机上不能把两条续聊叠在一起。
  if (session.state.running) {
    return done(commandId, false, "这个会话正在运行，等它这一轮结束再续聊");
  }
  const spec = specForTask(task);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  if (!spec?.executable) return done(commandId, false, spec?.lastError ?? "no connector is available");
  if (payload.autoApprove !== undefined) {
    return done(commandId, false, "this agent does not support auto approve");
  }
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const resolvedAttachments = await resolveAttachmentFiles(attachments, "acp");
  let process = processes.get(processKey(spec));
  if (!process?.alive) {
    process = await ensureProcess(spec);
    if (process.capabilities.loadSession) await loadSessionTranscript(process, session);
    else if (process.capabilities.resume) await process.call("session/resume", { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] });
    else return done(commandId, false, "session cannot be restored");
  }
  if (resolvedAttachments.length > 0 && !process.capabilities.image) {
    return done(commandId, false, "image is not supported");
  }
  const imageBlocks = await acpImageBlocks(resolvedAttachments);
  const nextTask = { ...task };
  const requestedModel = typeof payload.model === "string" ? payload.model.trim() : "";
  const requestedEffort = typeof payload.effort === "string" ? payload.effort.trim() : "";
  if (requestedModel && (requestedModel !== task.model || requestedEffort !== (task.effort ?? ""))) {
    const resolved = resolveModel(spec, requestedModel, requestedEffort);
    await applyModel(process, session.sessionId, "", resolved.acpId);
    nextTask.model = requestedModel;
    nextTask.effort = resolved.effort;
  }
  if (nextTask.model !== task.model || nextTask.effort !== task.effort) {
    busStore.upsertTask({ ...nextTask, updatedAt: new Date().toISOString() });
  }
  busStore.bumpSessionRevision(taskId);
  void runPrompt(process, taskId, prompt, imageBlocks).catch((error) =>
    markFailed(taskId, messageOf(error)),
  );
  return done(commandId, true, undefined, taskId);
}

async function approve(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const dedicatedKind = dedicatedKindOf(taskId);
  if (dedicatedKind) return dedicatedApprove(commandId, dedicatedKind, taskId, payload);
  if (isDshTaskId(taskId)) return dshApprove(commandId, taskId, payload);
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!session || !task) return done(commandId, false, "task not found");
  const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  if (!requestId) return done(commandId, false, "requestId is missing");
  const pending = session.state.pending;
  // 手机可能连点两次，或电脑上已经答过了：只有当前挂着的这一条能批。
  if (!pending || pending.request.toolCall.toolCallId !== requestId) {
    return done(commandId, false, "没有待审批的请求（可能已经处理过了）");
  }
  const decision = payload.decision === "deny" ? "deny" : "allow";
  const optionId = optionIdFor(pending.request.options, decision, answersOf(payload.answers));
  if (!optionId) {
    return done(
      commandId,
      false,
      decision === "allow" ? "agent 没有提供「允许」选项" : "agent 没有提供「拒绝」选项",
    );
  }
  const spec = specForTask(task);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  const process = spec ? processes.get(processKey(spec)) : undefined;
  if (!process?.alive) return done(commandId, false, "agent is not running");
  // 先复原状态再放行 agent：反过来的话这一轮可能在写回之前就收尾，
  // 最终状态会被旧的 running 盖掉。
  session.state.clearPending(new Date().toISOString());
  writeSessionRecord(task, session.state);
  process.respond(pending.rpcId, { outcome: { outcome: "selected", optionId } });
  return done(commandId, true, undefined, taskId);
}

async function interrupt(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const dedicatedKind = dedicatedKindOf(taskId);
  if (dedicatedKind) return dedicatedInterrupt(commandId, dedicatedKind, taskId);
  if (isDshTaskId(taskId)) return dshInterrupt(commandId, taskId);
  const task = busStore.taskById(taskId);
  const session = sessions.get(taskId);
  if (!task) return done(commandId, false, "task not found");
  if (!session) return done(commandId, false, "task not found");
  if (!session.state.running) {
    return done(commandId, false, "这个会话现在没有在运行，只能在电脑上中断");
  }
  const spec = specForTask(task);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  const process = spec ? processes.get(processKey(spec)) : undefined;
  if (!process?.alive) return done(commandId, false, "agent is not running");
  // ACP 要求：发 `session/cancel` 时挂着的审批一律回 cancelled。先写状态再放行。
  if (session.state.pending) {
    const rpcId = session.state.pending.rpcId;
    session.state.clearPending(new Date().toISOString());
    writeSessionRecord(task, session.state);
    process.respond(rpcId, { outcome: { outcome: "cancelled" } });
  }
  process.notify("session/cancel", { sessionId: session.sessionId });
  // 这一轮由 agent 回的 `cancelled` 收尾（记 interrupted）。
  return done(commandId, true, undefined, taskId);
}

/** 一次取回填进对应文件的产物 id。 */
type FetchedFile = { messageId: string; path: string; artifactId: string };

/**
 * 一条 Agent 条目此刻的文件卡片：`pathCandidates` 逐个按项目目录解析、校验、去重，
 * 最多 4 个。不可读的跳过；已上传过的沿用上一条消息里的 `artifactId`（没有就省略）。
 */
async function filesForEntry(
  entry: TranscriptEntry,
  projectPath: string | undefined,
  previous: readonly BusMessage[] | undefined,
  fetched?: FetchedFile,
): Promise<BusMessageFileRef[]> {
  if (entry.message.role !== "agent" || !projectPath || entry.pathCandidates.length === 0) {
    return [];
  }
  const refs = await resolveFileRefs(entry.pathCandidates, projectPath);
  if (refs.length === 0) return [];
  const prior = previous?.find((message) => message.id === entry.message.id)?.files ?? [];
  return refs.map((ref) => {
    if (fetched && fetched.messageId === entry.message.id && fetched.path === ref.path) {
      return { ...ref, artifactId: fetched.artifactId };
    }
    const existing = prior.find(
      (file) => file.path === ref.path && isValidArtifactId(file.artifactId),
    );
    return existing?.artifactId ? { ...ref, artifactId: existing.artifactId } : { ...ref };
  });
}

/**
 * 读取器条目 → 协议消息。图片落进本机产物并填 `attachments`（FR-14.5.1），
 * 再给 Agent 回复补 `files`；用户消息与工具行原样。
 * `previous` 是上一次下发过的消息，用来复用已取回的 `artifactId`。
 *
 * 读取器可能保留「只有图」的消息：图这次读不到、又没有文字和文件时丢掉，
 * 免得手机收到一个空气泡；有文字的消息不受影响。
 */
async function messagesFromEntries(
  taskId: string,
  entries: readonly TranscriptEntry[],
  projectPath: string | undefined,
  previous?: readonly BusMessage[],
  fetched?: FetchedFile,
): Promise<BusMessage[]> {
  const messages: BusMessage[] = [];
  for (const entry of entries) {
    const files = await filesForEntry(entry, projectPath, previous, fetched);
    const attachments =
      entry.images.length > 0
        ? await imagesForMessage(taskId, entry.message.id, entry.images)
        : [];
    const message: BusMessage = { ...entry.message };
    if (attachments.length > 0) message.attachments = attachments;
    if (files.length > 0) message.files = files;
    const visible =
      message.role === "tool" ||
      message.text.trim().length > 0 ||
      (message.attachments?.length ?? 0) > 0 ||
      (message.files?.length ?? 0) > 0;
    if (visible) messages.push(message);
  }
  return messages;
}

/**
 * `fetchFile` 与 `fetchMessages` 共用的读取入口：按任务来源找读取器。
 * 与上游 `messageReader(for:)` 一样，来源要认得、读取器要在、且连接器没被停用。
 */
async function entriesForTask(
  taskId: string,
  task: BusTask,
  limit: number,
): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
  const dedicatedKind = dedicatedKindOf(taskId);
  if (dedicatedKind) {
    const unavailable = specReadyError(dedicatedSpecFor(dedicatedKind));
    if (unavailable) throw new Error(unavailable);
    return readerForKind(dedicatedKind).entries(taskId, limit);
  }
  if (isDshTaskId(taskId) || task.source === "dsh") {
    const unavailable = specReadyError(dshSpec());
    if (unavailable) throw new Error(unavailable);
    return readerForDsh().entries(taskId, limit);
  }
  if (isOpenCodeTaskId(taskId)) {
    return createOpenCodeSessionReader({ agentId: task.agentId }).entries(taskId, limit);
  }
  throw new Error("本机读不了这个会话的对话记录");
}

/**
 * 协议 2.9：手机点了一张还没上传的文件卡片，复核之后上传，再发一次带 artifactId
 * 的 `taskMessages`。
 *
 * **这是手机读本机文件的唯一入口，手机给的 `path` 一个字都不信**：
 * 1. 重读这个任务的对话，`messageId` 必须是一条 Agent 回复，`path` 必须在它
 *    **此刻**的识别结果里——手机不能借这条命令读任意文件；
 * 2. 上传前再按同一套规则 `validate` 一次，结果必须还是同一个真实路径；
 * 3. 只读：不认领所有权、不碰任务状态，上传的文件也不进 `Task.artifacts`。
 */
async function fetchFile(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId.trim() : "";
  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const requestedPath = typeof payload.path === "string" ? payload.path : "";
  if (!taskId) return done(commandId, false, "taskId is missing");
  if (!messageId) return done(commandId, false, "messageId is missing");
  if (!requestedPath || requestedPath.length > 1024 || requestedPath.includes("\0")) {
    return done(commandId, false, "文件路径不合法");
  }

  const task = busStore.taskById(taskId);
  if (!task) return done(commandId, false, `本机没有这个任务：${taskId}`);
  // 与上游 `task.workingDirectory` 对齐：没有项目目录的会话不能取文件。
  const projectPath = task.projectPath?.trim() ?? "";
  if (!projectPath) return done(commandId, false, `本机没有这个任务：${taskId}`);

  let entries: TranscriptEntry[];
  let hasMore: boolean;
  try {
    ({ entries, hasMore } = await entriesForTask(taskId, task, MAX_USER_MESSAGES));
  } catch (error) {
    return done(commandId, false, messageOf(error));
  }

  const entry = entries.find((item) => item.message.id === messageId);
  if (!entry || entry.message.role !== "agent") {
    return done(commandId, false, "这个文件不在对话里");
  }
  const candidates = await resolveFileRefs(entry.pathCandidates, projectPath);
  if (!candidates.some((ref) => ref.path === requestedPath)) {
    return done(commandId, false, "这个文件不在对话里");
  }

  // 上传前再校验一次：文件可能刚被删掉，或被换成了指向项目外的软链接。
  const validated = await validateFileRef(requestedPath, projectPath);
  if (!validated || validated.path !== requestedPath) {
    return done(commandId, false, "这个文件已经不在项目里了");
  }
  if (validated.size > MAX_ARTIFACT_BYTES) {
    return done(commandId, false, "文件太大，无法取回");
  }

  const previous = busStore.messagesFor(taskId)?.messages;
  let artifactId = previous
    ?.find((message) => message.id === messageId)
    ?.files?.find((file) => file.path === requestedPath)?.artifactId;
  // 已经取回过、产物还在就复用 id，避免重复上传；过期或丢失才重新生成。
  if (!artifactId || !isValidArtifactId(artifactId) || !(await getArtifact(artifactId))) {
    let bytes: Buffer;
    try {
      bytes = await readFileByHandle(validated.path, { maxBytes: MAX_ARTIFACT_BYTES });
    } catch {
      return done(commandId, false, "这个文件已经不在项目里了");
    }
    // 读取期间文件可能又被替换：大小或真实路径对不上就不上传。
    const again = await validateFileRef(requestedPath, projectPath);
    if (!again || again.path !== requestedPath || again.size !== bytes.length) {
      return done(commandId, false, "这个文件已经不在项目里了");
    }
    artifactId = randomBytes(16).toString("base64url");
    try {
      await putArtifact(artifactId, bytes, validated.contentType);
    } catch {
      return done(commandId, false, "本机无法取回文件");
    }
  }

  // 先发消息再回执：手机收到 ok 时卡片已经带上 id。
  const messages = await messagesFromEntries(taskId, entries, projectPath, previous, {
    messageId,
    path: requestedPath,
    artifactId,
  });
  busStore.emitTaskMessages({
    taskId,
    agentId: task.agentId || busStore.agentId(),
    messages,
    hasMore,
    fetchedAt: new Date().toISOString(),
  });
  return done(commandId, true, undefined, taskId);
}

async function fetchMessages(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const dedicatedKind = dedicatedKindOf(taskId);
  if (dedicatedKind) return dedicatedFetchMessages(commandId, dedicatedKind, taskId, payload);
  if (isDshTaskId(taskId)) return dshFetchMessages(commandId, taskId, payload);
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!task) return done(commandId, false, "task not found");
  const spec = specForTask(task);
  const process = spec ? processes.get(processKey(spec)) : undefined;
  const liveSession = session && process?.alive ? session : undefined;
  // 电脑上的 OpenCode 会话没有活进程也能看：直接读本地 SQLite，不拉起 agent。
  if (isOpenCodeTaskId(taskId) && !liveSession) {
    if (await readOpenCodeMessages(taskId, task.agentId, payload)) {
      return done(commandId, true, undefined, taskId);
    }
    const stored = busStore.messagesFor(taskId);
    if (stored) {
      busStore.emitTaskMessages({ ...stored, fetchedAt: new Date().toISOString() });
      return done(commandId, true, undefined, taskId);
    }
  }
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  if (!liveSession) {
    const stored = busStore.messagesFor(taskId);
    if (!stored) return done(commandId, false, "task not found");
    busStore.emitTaskMessages({ ...stored, fetchedAt: new Date().toISOString() });
    return done(commandId, true, undefined, taskId);
  }
  await emitSessionMessages(taskId, task.agentId, liveSession);
  return done(commandId, true, undefined, taskId);
}

function isOpenCodeTaskId(taskId: string): boolean {
  return parseAcpTaskId(taskId)?.connectorId === OPENCODE_CONNECTOR_ID;
}

/**
 * `acp:opencode:*` 的对话记录优先读 OpenCode 的只读库。失败（库不在、被锁）
 * 返回 false，由调用方回退到 `busStore.messagesFor`。
 */
async function readOpenCodeMessages(
  taskId: string,
  agentId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const requested =
    typeof payload.limit === "number" && Number.isFinite(payload.limit)
      ? Math.trunc(payload.limit)
      : MAX_USER_MESSAGES;
  const limit = Math.min(Math.max(requested, 1), MAX_USER_MESSAGES);
  try {
    const reader = createOpenCodeSessionReader({ agentId });
    const { entries, hasMore } = await reader.entries(taskId, limit);
    busStore.emitTaskMessages({
      taskId,
      agentId,
      messages: await messagesFromEntries(
        taskId,
        entries,
        busStore.taskById(taskId)?.projectPath,
        busStore.messagesFor(taskId)?.messages,
      ),
      hasMore,
      fetchedAt: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 协议 3.9：启停一个 Agent。停用时立刻销毁实例（dsh 也停），
 * 启用只改开关，下一次命令按需惰性重建。
 */
async function setConnectorEnabled(
  commandId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const spec = specForRef(payload.connector, payload.connectorId);
  if (!spec) return done(commandId, false, "no connector is available");
  if (typeof payload.enabled !== "boolean") return done(commandId, false, "enabled is missing");
  spec.enabled = payload.enabled;
  if (!payload.enabled) destroyForSpec(spec);
  // 开关存在本机：重启后仍按用户的选择启用/停用。
  const settings = await ensureConnectorSettings();
  settings.setEnabled(spec.kind, settingsConnectorId(spec), payload.enabled);
  // 停用后不再对账；重新启用时基线清空，回来第一轮仍静默。
  syncAcpReconcile(specs);
  // 上游 `AcpHub.applyEnabledState`：刚启用的 agent 立刻刷一次列表，不等下一拍
  // （没在跑的 agent 下一拍可能要等十分钟）。刷新放后台，不拖住这条命令。
  if (payload.enabled && spec.kind === "acp" && acpReconcileEligible(spec)) {
    void reconcileAcpSessionsNow().catch(() => undefined);
  }
  busStore.setAgents(specs.map(listed), true);
  return done(commandId, true);
}

/**
 * 协议 3.9：销毁并重建指定连接器。结束后该连接器处于启用状态；
 * 新实例按需创建（ACP 在下一条命令里起进程）。
 */
async function restartConnector(
  commandId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const spec = specForRef(payload.connector, payload.connectorId);
  if (!spec) return done(commandId, false, "no connector is available");
  destroyForSpec(spec);
  spec.enabled = true;
  // 重启后该连接器处于启用状态，并把这个选择写进本机设置。
  const settings = await ensureConnectorSettings();
  settings.setEnabled(spec.kind, settingsConnectorId(spec), true);
  if (isDedicatedKind(spec.kind)) {
    if (spec.available && (spec.kind === "openclaw" || spec.executable)) connectorForSpec(spec);
  } else if (spec.kind === "dsh") {
    reconcileDsh(specs);
  }
  syncAcpReconcile(specs);
  busStore.setAgents(specs.map(listed), true);
  return done(commandId, true);
}

// MARK: - 一档专属连接器（Codex / Claude / Hermes / Pi / OpenClaw）

/**
 * 按任务 id 前缀判断来源。一档的连接器自己的 id 形如 `<kind>:<原生 id>`；
 * Claude 的 `start` 会返回裸 session id，由 `normalizedTaskId` 补前缀。
 */
function dedicatedKindOf(taskId: string): DedicatedKind | undefined {
  const separator = taskId.indexOf(":");
  if (separator <= 0) return undefined;
  const prefix = taskId.slice(0, separator);
  return isDedicatedKind(prefix) ? prefix : undefined;
}

/** 与上游 `CommandDispatcher.normalized` 一致：没前缀就补，已有同 kind 前缀就原样。 */
function normalizedTaskId(id: string, kind: DedicatedKind): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error(`${kind} 连接器没有返回任务 id`);
  return trimmed.startsWith(`${kind}:`) ? trimmed : `${kind}:${trimmed}`;
}

function dedicatedSpecFor(kind: DedicatedKind): AgentSpec | undefined {
  return specs.find((agent) => agent.kind === kind);
}

async function startDedicatedTask(
  commandId: string,
  kind: DedicatedKind,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const spec = dedicatedSpecFor(kind);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  // OpenClaw 经本机 Gateway 工作，不需要本机可执行文件；其余四家离了二进制起不来。
  if (kind !== "openclaw" && !spec?.executable) {
    return done(commandId, false, spec?.lastError ?? "no connector is available");
  }
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const images = await resolveImages(attachments, kind);
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const hasProject = typeof payload.projectPath === "string" && payload.projectPath.trim().length > 0;
  // 与上游一致：空目录 = 不在项目中；OpenClaw 退回它的默认工作区，其余在用户主目录下跑。
  const projectPath = hasProject
    ? String(payload.projectPath).trim()
    : kind === "openclaw"
      ? ""
      : homedir();
  const autoApproveError = await applyAutoApprove(kind, payload.autoApprove, projectPath, !hasProject);
  if (autoApproveError) return done(commandId, false, autoApproveError);
  const connector = connectorForSpec(spec!);
  const outcome = await connector.start(projectPath, prompt, images, selectionOf(payload));
  const taskId = normalizedTaskId(outcome.taskId, kind);
  if (hasProject) taskProjects.set(taskId, normalizeProjectPath(projectPath));
  busHost.claimLive(taskId);
  if (!outcome.retainsLiveOwnership) busHost.releaseLive(taskId);
  return done(commandId, true, undefined, taskId);
}

async function dedicatedFollowUp(
  commandId: string,
  kind: DedicatedKind,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const spec = dedicatedSpecFor(kind);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  if (kind !== "openclaw" && !spec?.executable) {
    return done(commandId, false, spec?.lastError ?? "no connector is available");
  }
  const task = busStore.taskById(taskId);
  const projectPath = task?.projectPath?.trim() || taskProjects.get(taskId) || "";
  const outsideProject = task?.outsideProject === true || isOutsideProjectPath(projectPath);
  const autoApproveError = await applyAutoApprove(kind, payload.autoApprove, projectPath, outsideProject);
  if (autoApproveError) return done(commandId, false, autoApproveError);
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const images = await resolveImages(attachments, kind);
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const connector = connectorForSpec(spec!);
  return runDedicatedOutcome(commandId, taskId, kind, () =>
    connector.followUp(taskId, prompt, images, selectionOf(payload)),
  );
}

async function dedicatedApprove(
  commandId: string,
  kind: DedicatedKind,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const spec = dedicatedSpecFor(kind);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!requestId) return done(commandId, false, "requestId is missing");
  const decision = payload.decision === "deny" ? "deny" : "allow";
  const connector = connectorForSpec(spec!);
  return runDedicatedOutcome(commandId, taskId, kind, () =>
    connector.approve(taskId, requestId, decision, answersOf(payload.answers)),
  );
}

async function dedicatedInterrupt(
  commandId: string,
  kind: DedicatedKind,
  taskId: string,
): Promise<BusCommandResult> {
  const spec = dedicatedSpecFor(kind);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  const connector = connectorForSpec(spec!);
  return runDedicatedOutcome(commandId, taskId, kind, () => connector.interrupt(taskId));
}

async function dedicatedFetchMessages(
  commandId: string,
  kind: DedicatedKind,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const unavailable = specReadyError(dedicatedSpecFor(kind));
  if (unavailable) return done(commandId, false, unavailable);
  const requested =
    typeof payload.limit === "number" && Number.isFinite(payload.limit)
      ? Math.trunc(payload.limit)
      : MAX_USER_MESSAGES;
  const limit = Math.min(Math.max(requested, 1), MAX_USER_MESSAGES);
  const reader = readerForKind(kind);
  const { entries, hasMore } = await reader.entries(taskId, limit);
  const task = busStore.taskById(taskId);
  busStore.emitTaskMessages({
    taskId,
    agentId: task?.agentId ?? busStore.agentId(),
    // Agent 回复里提到的本机文件：未取回时不带 artifactId，取回后由 fetchFile 补。
    messages: await messagesFromEntries(
      taskId,
      entries,
      task?.projectPath,
      busStore.messagesFor(taskId)?.messages,
    ),
    hasMore,
    fetchedAt: new Date().toISOString(),
  });
  return done(commandId, true, undefined, taskId);
}

/**
 * 协议 3.8：删除电脑端会话。只有一档连接器可能支持；不支持的实现会抛
 * `ConnectorError`，这里原样报给手机。
 */
async function deleteTask(commandId: string, payload: Record<string, unknown>): Promise<BusCommandResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  if (!taskId) return done(commandId, false, "taskId is missing");
  const task = busStore.taskById(taskId);
  if (task && isMidTurnStatus(task.status)) {
    return done(commandId, false, "会话还在进行中，等它停下来再删除");
  }
  if (isDshTaskId(taskId) || task?.source === "dsh") return dshDeleteTask(commandId, taskId);
  const kind =
    dedicatedKindOf(taskId) ??
    (task && isDedicatedKind(task.source) ? task.source : undefined);
  if (!kind) return done(commandId, false, "not supported");
  const spec = dedicatedSpecFor(kind);
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  const connector = connectorForSpec(spec!);
  if (typeof connector.deleteTask !== "function") return done(commandId, false, "not supported");
  await connector.deleteTask(taskId);
  sessions.delete(taskId);
  taskProjects.delete(taskId);
  busStore.removeTask(taskId);
  return done(commandId, true, undefined, taskId);
}

/**
 * 协议 3.8：把项目及全部来源会话从手机列表移出（只改可见性，不动任务与文件）。
 * 校验与记录都交给 `TaskStore.removeProject`；失败原样回给手机。
 */
async function removeProject(
  commandId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const projectPath = typeof payload.projectPath === "string" ? payload.projectPath.trim() : "";
  if (!projectPath) return done(commandId, false, "projectPath is missing");
  busStore.removeProject(projectPath);
  return done(commandId, true);
}

/**
 * 一档命令的共同收尾：按上游的所有权语义 claim / release，再把连接器返回的
 * 裸 id 补成协议 id（Claude / Hermes 的新会话会这样）。
 */
async function runDedicatedOutcome(
  commandId: string,
  taskId: string,
  kind: DedicatedKind,
  body: () => Promise<ConnectorOutcome>,
): Promise<BusCommandResult> {
  busHost.claimLive(taskId);
  try {
    const outcome = await body();
    const resulting = normalizedTaskId(outcome.taskId, kind);
    if (resulting !== taskId) busHost.claimLive(resulting);
    if (!outcome.retainsLiveOwnership || resulting !== taskId) busHost.releaseLive(taskId);
    if (resulting !== taskId && !outcome.retainsLiveOwnership) busHost.releaseLive(resulting);
    return done(commandId, true, undefined, resulting);
  } catch (error) {
    busHost.releaseLive(taskId);
    throw error;
  }
}

function selectionOf(payload: Record<string, unknown>): ModelSelection | undefined {
  const model =
    typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined;
  const effort =
    typeof payload.effort === "string" && payload.effort.trim() ? payload.effort.trim() : undefined;
  if (model === undefined && effort === undefined) return undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function answersOf(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
      result[key] = item as string[];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** agent 消失 / 不可用 / 换了可执行文件时销毁实例；下次命令再惰性重建。 */
function reconcileDedicated(agents: AgentSpec[]) {
  const desired = new Map<DedicatedKind, AgentSpec>();
  for (const agent of agents) {
    if (isDedicatedKind(agent.kind)) desired.set(agent.kind, agent);
  }
  for (const kind of [...dedicatedConnectors.keys()]) {
    const spec = desired.get(kind);
    const instance = dedicatedConnectors.get(kind);
    const wantsBinary = kind !== "openclaw";
    if (!spec || !spec.enabled || !spec.available || (wantsBinary && !spec.executable)) {
      destroyDedicated(kind);
    } else if (instance && instance.executable !== spec.executable) {
      destroyDedicated(kind);
    }
  }
  for (const kind of [...dedicatedReaders.keys()]) {
    if (!desired.has(kind)) dedicatedReaders.delete(kind);
  }
}

function destroyDedicated(kind: DedicatedKind) {
  const instance = dedicatedConnectors.get(kind);
  dedicatedConnectors.delete(kind);
  if (!instance) return;
  const stoppable = instance.connector as TaskConnector & { stop?: () => unknown };
  try {
    const result = stoppable.stop?.();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // 收尾是尽力而为：销毁实例本身不能把发现流程弄挂。
  }
}

function connectorForSpec(spec: AgentSpec): TaskConnector {
  const kind = spec.kind as DedicatedKind;
  const existing = dedicatedConnectors.get(kind);
  if (existing && existing.executable === spec.executable) return existing.connector;
  if (existing) destroyDedicated(kind);
  const factory = dedicatedFactories.connectors?.[kind] ?? builtinConnector;
  const connector = factory(spec);
  dedicatedConnectors.set(kind, { connector, executable: spec.executable });
  return connector;
}

function readerForKind(kind: DedicatedKind): MessageReader {
  const existing = dedicatedReaders.get(kind);
  if (existing) return existing;
  const factory = dedicatedFactories.readers?.[kind] ?? (() => builtinReader(kind));
  const reader = factory();
  dedicatedReaders.set(kind, reader);
  return reader;
}

function builtinConnector(spec: AgentSpec): TaskConnector {
  switch (spec.kind as DedicatedKind) {
    case "codex": {
      const hooks = dedicatedConnectorHooks("codex");
      const connector = createCodexConnector(busHost, {
        ...(spec.executable ? { executablePath: spec.executable } : {}),
        autoApproves: hooks.autoApproves,
        models: hooks.models,
        setModels: hooks.setModels,
        broadcastSnapshot: hooks.broadcastSnapshot,
      });
      // Codex 的 app-server 与事件订阅要显式启动（上游 App 装配时调用 start()）。
      // 不启动的话 thread/start、转审批、删除都只会得到 notRunning。
      void (connector as unknown as { start(): Promise<void> }).start().catch(() => undefined);
      return connector;
    }
    case "claude": {
      const hooks = dedicatedConnectorHooks("claude");
      return createClaudeConnector(busHost, {
        binary: () => spec.executable ?? null,
        autoApproves: hooks.autoApproves,
        setModels: hooks.setModels,
        broadcastSnapshot: hooks.broadcastSnapshot,
      });
    }
    case "hermes":
      return createHermesConnector(busHost, { binary: () => spec.executable });
    case "pi":
      return createPiConnector(busHost, { binary: () => spec.executable });
    case "openclaw":
      return createOpenClawConnector(busHost, { autoStart: true });
  }
}

function builtinReader(kind: DedicatedKind): MessageReader {
  switch (kind) {
    case "codex":
      return createCodexMessageReader();
    case "claude":
      return createClaudeMessageReader();
    case "hermes":
      return createHermesMessageReader();
    case "pi":
      return createPiMessageReader();
    case "openclaw":
      return createOpenClawMessageReader();
  }
}

// MARK: - DeepSeek Harness（native 连接器）

/** 协议里 dsh 的任务 id 一律是 `dsh:<sessionId>`。 */
function isDshTaskId(taskId: string): boolean {
  return taskId.startsWith("dsh:");
}

function dshTaskId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("dsh 连接器没有返回任务 id");
  return trimmed.startsWith("dsh:") ? trimmed : `dsh:${trimmed}`;
}

function dshSpec(): AgentSpec | undefined {
  return specs.find((agent) => agent.kind === "dsh");
}

/**
 * 把发现的 `AgentSpec.executable` 适配成 native 连接器认的安装信息。
 * `--profile acp` 由 `acpArguments()` 自己补，所以 leadingArguments 留空。
 */
function installationFromSpec(spec: AgentSpec): DshInstallation | null {
  if (!spec.executable) return null;
  return {
    kind: "binary",
    executable: spec.executable,
    leadingArguments: [],
    version: null,
    node: null,
  };
}

/**
 * agent 出现 / 换了可执行文件时建新的观察实例；agent 消失时停掉。
 *
 * 没有可执行文件时**也**建实例：上游的 dsh 连接器靠 web / 扫盘照样能看见电脑上
 * 的会话，只是不能从手机新建任务（`start` 会自己报找不到 dsh）。
 */
function reconcileDsh(agents: AgentSpec[]) {
  const spec = agents.find((agent) => agent.kind === "dsh");
  if (!spec || !spec.enabled) {
    destroyDsh();
    return;
  }
  if (dshInstance && dshInstance.executable !== spec.executable) destroyDsh();
  if (dshInstance) return;
  const factory = dshFactories.connector ?? builtinDshConnector;
  const connector = factory(spec);
  dshInstance = { connector, executable: spec.executable };
  // 观察循环（找 web、扫盘、对账）建好就启动；`startObserving()` 自己幂等。
  connector.startObserving?.();
}

function destroyDsh() {
  const instance = dshInstance;
  dshInstance = undefined;
  dshReader = undefined;
  if (!instance) return;
  const stoppable = instance.connector;
  try {
    const result =
      typeof stoppable.stop === "function"
        ? stoppable.stop()
        : typeof stoppable.shutdown === "function"
          ? stoppable.shutdown()
          : undefined;
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // 收尾是尽力而为：销毁实例不能把发现流程弄挂。
  }
}

function builtinDshConnector(spec: AgentSpec): DshConnectorInstance {
  const connector = createDshConnector(busHost, {
    installation: () => installationFromSpec(spec),
  });
  return connector as DshConnector;
}

function connectorForDsh(): DshConnectorInstance | undefined {
  if (!dshInstance) reconcileDsh(specs);
  return dshInstance?.connector;
}

/** 读取器优先用连接器自己（它是 `MessageReader`），否则起一个只读的 native reader。 */
function builtinDshReader(): MessageReader {
  const connector = dshInstance?.connector;
  return connector?.entries ? (connector as unknown as MessageReader) : createDshMessageReader();
}

function readerForDsh(): MessageReader {
  if (dshReader) return dshReader;
  const factory = dshFactories.reader ?? builtinDshReader;
  dshReader = factory();
  return dshReader;
}

function dshUnavailableError(): string {
  return dshSpec()?.lastError ?? "no connector is available";
}

async function startDshTask(
  commandId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const spec = dshSpec();
  const unavailable = specReadyError(spec);
  if (unavailable) return done(commandId, false, unavailable);
  if (!spec?.executable) return done(commandId, false, spec?.lastError ?? "no connector is available");
  if (payload.autoApprove !== undefined) {
    return done(commandId, false, "this agent does not support auto approve");
  }
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const images = await resolveImages(attachments, "dsh");
  const connector = connectorForDsh();
  if (!connector) return done(commandId, false, dshUnavailableError());
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  const hasProject = typeof payload.projectPath === "string" && payload.projectPath.trim().length > 0;
  // 与旧 ACP 分支一致：没给项目目录就在用户主目录下开。
  const projectPath = hasProject ? String(payload.projectPath).trim() : homedir();
  const outcome = await connector.start(projectPath, prompt, images, selectionOf(payload));
  const taskId = dshTaskId(outcome.taskId);
  if (hasProject) taskProjects.set(taskId, normalizeProjectPath(projectPath));
  busHost.claimLive(taskId);
  if (!outcome.retainsLiveOwnership) busHost.releaseLive(taskId);
  return done(commandId, true, undefined, taskId);
}

async function dshFollowUp(
  commandId: string,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const specError = specReadyError(dshSpec());
  if (specError) return done(commandId, false, specError);
  if (payload.autoApprove !== undefined) {
    return done(commandId, false, "this agent does not support auto approve");
  }
  const connector = connectorForDsh();
  if (!connector) return done(commandId, false, dshUnavailableError());
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const images = await resolveImages(attachments, "dsh");
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  return runDshOutcome(commandId, taskId, () =>
    connector.followUp(taskId, prompt, images, selectionOf(payload)),
  );
}

async function dshApprove(
  commandId: string,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const specError = specReadyError(dshSpec());
  if (specError) return done(commandId, false, specError);
  const connector = connectorForDsh();
  if (!connector) return done(commandId, false, dshUnavailableError());
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!requestId) return done(commandId, false, "requestId is missing");
  const decision = payload.decision === "deny" ? "deny" : "allow";
  return runDshOutcome(commandId, taskId, () =>
    connector.approve(taskId, requestId, decision, answersOf(payload.answers)),
  );
}

async function dshInterrupt(commandId: string, taskId: string): Promise<BusCommandResult> {
  const specError = specReadyError(dshSpec());
  if (specError) return done(commandId, false, specError);
  const connector = connectorForDsh();
  if (!connector) return done(commandId, false, dshUnavailableError());
  return runDshOutcome(commandId, taskId, () => connector.interrupt(taskId));
}

async function dshFetchMessages(
  commandId: string,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<BusCommandResult> {
  const specError = specReadyError(dshSpec());
  if (specError) return done(commandId, false, specError);
  const requested =
    typeof payload.limit === "number" && Number.isFinite(payload.limit)
      ? Math.trunc(payload.limit)
      : MAX_USER_MESSAGES;
  const limit = Math.min(Math.max(requested, 1), MAX_USER_MESSAGES);
  const { entries, hasMore } = await readerForDsh().entries(taskId, limit);
  const task = busStore.taskById(taskId);
  busStore.emitTaskMessages({
    taskId,
    agentId: task?.agentId ?? busStore.agentId(),
    // Agent 回复里提到的本机文件：未取回时不带 artifactId，取回后由 fetchFile 补。
    messages: await messagesFromEntries(
      taskId,
      entries,
      task?.projectPath,
      busStore.messagesFor(taskId)?.messages,
    ),
    hasMore,
    fetchedAt: new Date().toISOString(),
  });
  return done(commandId, true, undefined, taskId);
}

async function dshDeleteTask(commandId: string, taskId: string): Promise<BusCommandResult> {
  const task = busStore.taskById(taskId);
  if (task && isMidTurnStatus(task.status)) {
    return done(commandId, false, "会话还在进行中，等它停下来再删除");
  }
  const specError = specReadyError(dshSpec());
  if (specError) return done(commandId, false, specError);
  const connector = connectorForDsh();
  if (!connector || typeof connector.deleteTask !== "function") {
    return done(commandId, false, "not supported");
  }
  await connector.deleteTask(taskId);
  sessions.delete(taskId);
  taskProjects.delete(taskId);
  busStore.removeTask(taskId);
  return done(commandId, true, undefined, taskId);
}

/** 与一档命令相同的所有权语义：按 outcome 决定认领/交还。 */
async function runDshOutcome(
  commandId: string,
  taskId: string,
  body: () => Promise<ConnectorOutcome>,
): Promise<BusCommandResult> {
  busHost.claimLive(taskId);
  try {
    const outcome = await body();
    const resulting = dshTaskId(outcome.taskId);
    if (resulting !== taskId) busHost.claimLive(resulting);
    if (!outcome.retainsLiveOwnership || resulting !== taskId) busHost.releaseLive(taskId);
    if (resulting !== taskId && !outcome.retainsLiveOwnership) busHost.releaseLive(resulting);
    return done(commandId, true, undefined, resulting);
  } catch (error) {
    busHost.releaseLive(taskId);
    throw error;
  }
}

async function ensureProcess(spec: AgentSpec) {
  const key = processKey(spec);
  const existing = processes.get(key);
  if (existing?.alive) return existing;
  if (!spec.executable) throw new AcpRejected("no executable");
  const epoch = processEpochs.get(key) ?? 0;
  const process = new AcpProcess(
    spec.executable,
    spec.args,
    spec.env,
    (message) => onAgentMessage(spec, message),
    () => failOpenTasks(spec),
    idleMs,
  );
  startingProcesses.set(key, process);
  try {
    await process.start();
  } catch (error) {
    startingProcesses.delete(key);
    process.kill();
    // 停用/重置导致的取消不是握手失败，不能因此藏掉注册表 agent。
    const cancelled = (processEpochs.get(key) ?? 0) !== epoch;
    if (!cancelled && spec.origin === "registry" && !(error instanceof AcpTimeout) && !(error instanceof AcpAuthRequired)) {
      hiddenRegistryIds.add(spec.id);
      spec.available = false;
      spec.lastError = messageOf(error);
      useAgents(specs.filter((agent) => agent.origin !== "registry" || !hiddenRegistryIds.has(agent.id)));
    }
    throw error;
  }
  startingProcesses.delete(key);
  // 启动期间被停用/重置了：不要把一个已经作废的进程挂进 map。
  if ((processEpochs.get(key) ?? 0) !== epoch) {
    process.kill();
    throw new AcpRejected("connector was reset");
  }
  processes.set(key, process);
  return process;
}

function onAgentMessage(spec: AgentSpec, message: Record<string, unknown>) {
  if (message.method === "session/update") {
    const params = record(message.params);
    const session = sessionByAcpId(typeof params.sessionId === "string" ? params.sessionId : "");
    if (!session) return;
    const update = parseSessionUpdate(record(params.update));
    const now = new Date().toISOString();
    // `session/load` 的历史重放进单独的一份，载入成功才换上去。
    if (session.replay) {
      session.replay.apply(update, now);
      return;
    }
    const task = busStore.taskById(session.taskId);
    if (!task) return;
    if (session.state.apply(update, now)) writeSessionRecord(task, session.state);
    return;
  }
  if (message.method !== "session/request_permission" || typeof message.id !== "number") return;
  const request = parsePermissionRequest(record(message.params));
  if (!request || typeof message.id !== "number") return;
  const session = sessionByAcpId(request.sessionId);
  const task = session ? busStore.taskById(session.taskId) : undefined;
  if (!session || !task) return;
  const process = processes.get(processKey(spec));
  // 轮次外的审批挂上去就再也没人收尾了：直接回 cancelled。
  if (!session.state.running) {
    process?.respond(message.id, { outcome: { outcome: "cancelled" } });
    return;
  }
  // 同一会话同时只挂一个：新的来了，旧的没有答案（子进程收到的是 ACP 的 cancelled）。
  if (session.state.pending) {
    process?.respond(session.state.pending.rpcId, { outcome: { outcome: "cancelled" } });
  }
  session.state.setPending(request, message.id, new Date().toISOString());
  writeSessionRecord(task, session.state);
}

/** 把会话推导出的字段写回任务；`pendingRequest` 没有就删掉，避免旧卡片残留。 */
function writeSessionRecord(task: BusTask, state: AcpSessionState) {
  const record = state.record;
  const next: BusTask = {
    ...task,
    title: record.title,
    status: record.status,
    updatedAt: record.updatedAt,
  };
  if (record.pendingRequest) next.pendingRequest = record.pendingRequest;
  else delete next.pendingRequest;
  if (record.lastMessage !== undefined) next.lastMessage = record.lastMessage;
  busStore.upsertTask(next);
}

function parseStopReason(value: unknown) {
  switch (value) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

/** `session/load`：历史先重放进一份新状态，成功了才替换内存里的；失败保留原来的。 */
async function loadSessionTranscript(process: AcpProcess, session: LiveSession) {
  const replay = new AcpSessionState({ ...session.state.record });
  session.replay = replay;
  try {
    await process.call("session/load", {
      sessionId: session.sessionId,
      cwd: session.cwd,
      mcpServers: [],
    });
  } finally {
    session.replay = undefined;
  }
  session.state = replay;
  const task = busStore.taskById(session.taskId);
  if (task) writeSessionRecord(task, replay);
}

async function runPrompt(
  process: AcpProcess,
  taskId: string,
  prompt: string,
  images: AcpImageBlock[] = [],
) {
  const session = sessions.get(taskId);
  const task = busStore.taskById(taskId);
  if (!session || !task) return;
  // 自己发的图也记进这一轮的对话：重放或下次拉取时手机仍能看到用户发过的图。
  const imageSources: ImageSource[] = images.map((block) => ({
    type: "data",
    data: Buffer.from(block.data, "base64"),
    contentType: block.mimeType,
  }));
  session.state.beginTurn(prompt, new Date().toISOString(), imageSources);
  writeSessionRecord(task, session.state);
  process.setTurnActive(true);
  try {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }, ...images];
    const result = record(
      await process.call("session/prompt", {
        sessionId: session.sessionId,
        prompt: content,
      }),
    );
    if (session.state.pending) {
      process.respond(session.state.pending.rpcId, { outcome: { outcome: "cancelled" } });
    }
    session.state.endTurn(parseStopReason(result.stopReason), undefined, new Date().toISOString());
  } catch (error) {
    if (session.state.pending) {
      process.respond(session.state.pending.rpcId, { outcome: { outcome: "cancelled" } });
    }
    session.state.endTurn(undefined, messageOf(error), new Date().toISOString());
  } finally {
    process.setTurnActive(false);
  }
  const current = busStore.taskById(taskId);
  if (!current) return;
  writeSessionRecord(current, session.state);
  await emitSessionMessages(taskId, current.agentId, session);
}

async function emitSessionMessages(taskId: string, agentId: string, session: LiveSession) {
  const all = session.state.transcript.transcriptEntries();
  const userAndAgent = all.filter((entry) => entry.message.role !== "tool");
  const tools = all.filter((entry) => entry.message.role === "tool");
  const selected = [...userAndAgent.slice(-MAX_USER_MESSAGES), ...tools.slice(-MAX_TOOL_MESSAGES)];
  const messages = await messagesFromEntries(
    taskId,
    selected,
    busStore.taskById(taskId)?.projectPath,
    busStore.messagesFor(taskId)?.messages,
  );
  busStore.emitTaskMessages({
    taskId,
    agentId,
    messages,
    hasMore: selected.length < all.length,
    fetchedAt: new Date().toISOString(),
  });
}

function failOpenTasks(spec: AgentSpec) {
  for (const session of sessions.values()) {
    const task = busStore.taskById(session.taskId);
    if (!task || specForTask(task)?.id !== spec.id || specForTask(task)?.kind !== spec.kind) continue;
    if (task.status === "running" || task.status === "waitingApproval") {
      // 进程没了：这一轮不会再有结果，别让会话状态停在"运行中"挡住下一次续聊。
      session.state.endTurn(undefined, "agent exited", new Date().toISOString());
      writeSessionRecord(task, session.state);
    }
  }
}

function markFailed(taskId: string, error: string) {
  const task = busStore.taskById(taskId);
  if (!task) return;
  busStore.upsertTask({
    ...withoutPending(task),
    status: "failed",
    lastMessage: error.slice(0, 500),
    updatedAt: new Date().toISOString(),
  });
}

function specForTask(task: BusTask) {
  // dsh 的任务不经 AcpProcess：命令在 `dsh*Task` 里按 `dsh:` 前缀直接路由到 native 连接器。
  if (task.source === "acp") return specs.find((agent) => agent.kind === "acp" && agent.id === task.connectorId);
  if (isDedicatedKind(task.source)) return dedicatedSpecFor(task.source);
  return undefined;
}

function sessionByAcpId(sessionId: string) {
  for (const session of sessions.values()) if (session.sessionId === sessionId) return session;
  return undefined;
}

function processKey(spec: AgentSpec) {
  return `${spec.kind}:${spec.id}`;
}

function baseTask(
  spec: AgentSpec,
  taskId: string,
  cwd: string,
  title: string,
  now: string,
  outsideProject = false,
): BusTask {
  return {
    id: taskId,
    agentId: busStore.agentId(),
    source: spec.kind,
    ...(spec.kind === "acp" ? { connectorId: spec.id } : {}),
    title,
    projectPath: outsideProject ? "" : cwd,
    projectName: outsideProject ? "" : basename(cwd) || cwd,
    ...(outsideProject ? { outsideProject: true } : {}),
    status: "running",
    origin: "watch",
    controllable: true,
    startedAt: now,
    updatedAt: now,
  };
}

function withoutPending(task: BusTask): BusTask {
  const next = { ...task };
  delete next.pendingRequest;
  return next;
}

function listed(agent: AgentSpec): ListedAgent {
  const models = isDedicatedKind(agent.kind)
    ? dedicatedModels.get(agent.kind)
    : connectorModels.get(agent.id);
  return {
    id: agent.id,
    kind: agent.kind,
    name: agent.name,
    available: agent.available,
    enabled: agent.enabled,
    lastError: agent.lastError,
    ...(agent.status ? { status: agent.status } : {}),
    ...(models?.length ? { models } : {}),
    // 与上游 `ConnectorRegistry` 一致：只有装了且支持自动批准的来源才报。
    ...(agent.available && supportsAutoApprove(agent.kind) ? { canAutoApprove: true } : {}),
    // 协议 3.8：只有真正实现了永久删除的来源才报。
    ...(agent.available && supportsDeleteTask(agent.kind) ? { canDeleteTasks: true } : {}),
  };
}

/** 所有执行类命令的前置检查：连接器要存在、启用、可用。 */
function specReadyError(spec: AgentSpec | undefined): string | undefined {
  if (!spec) return "no connector is available";
  if (!spec.enabled) return `${spec.kind} connector is disabled`;
  if (!spec.available) return spec.lastError ?? `${spec.kind} connector is not available`;
  return undefined;
}

/** 按命令里的 `{connector, connectorId}` 找 AgentSpec（ACP 必须带 connectorId）。 */
function specForRef(connector: unknown, connectorId: unknown): AgentSpec | undefined {
  if (typeof connector !== "string" || !connector) return undefined;
  if (connector === "acp") {
    if (typeof connectorId !== "string" || !connectorId) return undefined;
    return specs.find((agent) => agent.kind === "acp" && agent.id === connectorId);
  }
  if (connector === "dsh") return specs.find((agent) => agent.kind === "dsh");
  if (isDedicatedKind(connector)) return specs.find((agent) => agent.kind === connector);
  return undefined;
}

/** 停用/重启时真正把实例收掉；ACP 只杀进程，会话记录留给下次惰性重建。 */
function destroyForSpec(spec: AgentSpec) {
  if (spec.kind === "acp") {
    const key = processKey(spec);
    processEpochs.set(key, (processEpochs.get(key) ?? 0) + 1);
    startingProcesses.get(key)?.kill();
    startingProcesses.delete(key);
    const process = processes.get(key);
    processes.delete(key);
    process?.kill();
    // 停用或重启后重新握手：能力与列表基线都要重算。
    acpReconcileStates.delete(spec.id);
    return;
  }
  if (spec.kind === "dsh") {
    destroyDsh();
    return;
  }
  if (isDedicatedKind(spec.kind)) destroyDedicated(spec.kind);
}

function done(commandId: string, ok: boolean, error?: string, taskId?: string): BusCommandResult {
  return { commandId, ok, ...(error ? { error } : {}), ...(taskId ? { taskId } : {}), finishedAt: new Date().toISOString() };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "agent failed";
}
