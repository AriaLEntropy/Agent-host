// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexConnector.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import type { BusPendingRequest, BusTask } from "../../bus/store.js";
import {
  ConnectorError,
  type ConnectorHost,
  type ConnectorOutcome,
  type FailureDiagnosis,
  type ImageSource,
  type ModelSelection,
  type TaskConnector,
} from "../ported/contract.js";
import {
  CodexAppServer,
  type CodexAppServerConfiguration,
  type CodexProcessLauncher,
} from "./app-server.js";
import {
  CodexAppServerError,
  CodexServerRequest,
  describeError,
  notificationStatusTransition,
  notificationThreadId,
  type CodexAppServerEvent,
  type CodexItem,
  type CodexNotification,
  type CodexProcessExit,
  type TaskStatus,
} from "./app-server-messages.js";
import { jsonArray, jsonBool, jsonInt, jsonObject, jsonPath, jsonString, type JSONValue } from "./json.js";
import { CodexPaths, isExecutableFile } from "./paths.js";
import {
  CodexThreadReader,
  isValidEffort,
  isValidModelId,
  protocolTimestamp,
  type ModelOption,
} from "./thread-reader.js";

// MARK: - 审批决策

/**
 * Codex app-server 的审批决策。四个值就是协议里 `CommandExecutionApprovalDecision` /
 * `FileChangeApprovalDecision` 的全集。
 *
 * 协议层的 `Command.Approve.Decision` 只有 `allow` / `deny` 两档——手机上就两个按钮——
 * 所以映射是收敛的：`allow → accept`、`deny → decline`。
 */
export type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export function codexApprovalDecision(decision: "allow" | "deny"): CodexApprovalDecision {
  switch (decision) {
    case "allow":
      return "accept";
    case "deny":
      return "decline";
  }
}

/** 是不是“同意”。`item/permissions/requestApproval` 的响应里没有 decision 字段。 */
export function decisionGrantsPermission(decision: CodexApprovalDecision): boolean {
  return decision === "accept" || decision === "acceptForSession";
}

/** 权限授予的作用域（`PermissionGrantScope`）。只有 `acceptForSession` 覆盖整个会话。 */
export function decisionPermissionScope(decision: CodexApprovalDecision): string {
  return decision === "acceptForSession" ? "session" : "turn";
}

// MARK: - 协议里的提问

export type CodexPendingOption = { label: string; description?: string };
export type CodexPendingQuestion = {
  id: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: CodexPendingOption[];
};

/** 协议 2.14 的上限。 */
export const MAX_QUESTIONS = 8;
export const MAX_OPTIONS = 16;

export type CodexPendingRequest = BusPendingRequest & {
  /** 协议 2.14：首道问题的正文（旧字段，保留兼容）。 */
  question?: string;
  questions?: CodexPendingQuestion[];
};

// MARK: - 状态

export type CodexConnectorStatus = {
  phase: "stopped" | "starting" | "ready" | "restarting";
  /** restarting 时：多少秒后重启。 */
  after?: number;
  /** 第几代子进程。每重启一次加一；没起过是 0。 */
  generation: number;
  /** 当前由本连接器实时驱动的线程数。 */
  liveTaskCount: number;
  /** 退出原因的一小段，只给界面看。**不进日志**。 */
  detail?: string;
};

/** 退出原因（stderr 末尾）在菜单里最多显示这么长。 */
export const STATUS_DETAIL_LIMIT = 120;

export function connectorStatusText(status: CodexConnectorStatus): string {
  switch (status.phase) {
    case "stopped":
      return "app-server：未运行";
    case "starting":
      return "app-server：正在启动…";
    case "ready":
      return status.liveTaskCount > 0
        ? `app-server：运行中 · 正在驱动 ${status.liveTaskCount} 个任务`
        : "app-server：运行中";
    case "restarting": {
      const after = status.after ?? 0;
      const seconds = after < 1 ? String(after) : String(Math.round(after));
      const head = `app-server：已退出，${seconds} 秒后重启`;
      return status.detail && status.detail.length > 0 ? `${head}（${status.detail}）` : head;
    }
  }
}

export function connectorStatusNeedsAttention(status: CodexConnectorStatus): boolean {
  return status.phase === "restarting";
}

// MARK: - agent 工具注入（Kit AgentTools.swift 的最小移植）

export type AgentToolsConfiguration = {
  /** `BotBus.app/Contents/Helpers/botbus` 的绝对路径。 */
  cliPath: string;
  /** `http://127.0.0.1:<port>`，本机工具服务器。 */
  toolsURL: string;
};

export function agentToolsUsable(configuration: AgentToolsConfiguration | undefined): boolean {
  if (!configuration) return false;
  return configuration.toolsURL.length > 0 && configuration.cliPath.length > 0 && isExecutableFile(configuration.cliPath);
}

export const AGENT_TOOLS_MCP_SERVER_NAME = "botbus";
export const AGENT_TOOLS_VARIABLES = {
  toolsURL: "BOTBUS_TOOLS_URL",
  taskToken: "BOTBUS_TASK_TOKEN",
  cli: "BOTBUS_CLI",
};

export function agentToolsInstructions(cliPath: string): string {
  const intro =
    "This task was sent from the user's phone through BotBus. The user is not at this computer: they cannot see its screen or open localhost URLs. When you build or change something visual, share it";
  const tools = ` with the \`botbus\` tools (MCP server \`botbus\`, or the CLI at \`${cliPath}\`):
- \`share_preview\` with a \`port\` for a running dev server, or a \`directory\` for static files (serves \`index.html\`). In this environment background processes may be killed when your turn ends, so to run a dev server pass its \`command\` (and \`cwd\`) and BotBus will keep it running.
- \`share_file\` for screenshots, images, videos or other files; \`share_link\` for public URLs. Videos are compressed automatically.
`;
  return (
    intro +
    tools +
    "Prefer relative URLs or the dev server's proxy over hard-coded `http://localhost:…` API URLs so the page works through the preview tunnel. Keep your final answer short; the user reads it on a phone."
  );
}

export type AgentToolsInjection = {
  configuration: AgentToolsConfiguration;
  token: string;
};

export function agentToolsEnvironment(injection: AgentToolsInjection): Record<string, string> {
  return {
    [AGENT_TOOLS_VARIABLES.toolsURL]: injection.configuration.toolsURL,
    [AGENT_TOOLS_VARIABLES.taskToken]: injection.token,
    [AGENT_TOOLS_VARIABLES.cli]: injection.configuration.cliPath,
  };
}

/** Codex `thread/start` / `thread/resume` 的 `config` 覆盖。点路径写到叶子，避免整表覆盖用户配置。 */
export function agentToolsCodexConfig(injection: AgentToolsInjection): JSONValue {
  const config: { [key: string]: JSONValue } = {
    [`mcp_servers.${AGENT_TOOLS_MCP_SERVER_NAME}.command`]: injection.configuration.cliPath,
    [`mcp_servers.${AGENT_TOOLS_MCP_SERVER_NAME}.args`]: ["mcp"],
  };
  for (const [name, value] of Object.entries(agentToolsEnvironment(injection))) {
    config[`mcp_servers.${AGENT_TOOLS_MCP_SERVER_NAME}.env.${name}`] = value;
    config[`shell_environment_policy.set.${name}`] = value;
  }
  return config;
}

/** 手机下发任务的“身份证”：token → 协议 id。只在内存里，app 重启后全部失效。 */
export class TaskContextRegistry {
  static readonly tokenBytes = 32;
  static readonly maxTokens = 1000;

  private readonly taskByToken = new Map<string, string | undefined>();
  private readonly tokenByTask = new Map<string, string>();
  private order: string[] = [];

  constructor(private readonly generateToken: () => string = () => randomBytes(TaskContextRegistry.tokenBytes).toString("base64url")) {}

  issue(): string {
    let token = this.generateToken();
    while (this.taskByToken.has(token)) token = this.generateToken();
    this.taskByToken.set(token, undefined);
    this.order.push(token);
    this.trim();
    return token;
  }

  /** 已知任务的手机续聊：复用 / 签发 / 绑定在同一次调用内完成。 */
  issueFor(taskId: string): string {
    const existing = this.tokenByTask.get(taskId);
    if (existing) return existing;
    const token = this.issue();
    this.bind(token, taskId);
    return token;
  }

  bind(token: string, taskId: string): boolean {
    if (!this.taskByToken.has(token) || taskId.length === 0) return false;
    this.taskByToken.set(token, taskId);
    this.tokenByTask.set(taskId, token);
    return true;
  }

  tokenFor(taskId: string): string | undefined {
    return this.tokenByTask.get(taskId);
  }

  taskIdFor(token: string): string | undefined {
    return this.taskByToken.get(token);
  }

  get tokenCount(): number {
    return this.taskByToken.size;
  }

  private trim(): void {
    while (this.order.length > TaskContextRegistry.maxTokens) {
      const victim = this.order.shift();
      if (victim === undefined) break;
      const bound = this.taskByToken.get(victim);
      this.taskByToken.delete(victim);
      if (bound !== undefined && this.tokenByTask.get(bound) === victim) this.tokenByTask.delete(bound);
    }
  }
}

export function makeAgentToolsInjection(
  configuration: AgentToolsConfiguration | undefined,
  registry: TaskContextRegistry,
  reusing?: string,
): AgentToolsInjection | undefined {
  if (!agentToolsUsable(configuration)) return undefined;
  const config = configuration as AgentToolsConfiguration;
  if (reusing !== undefined) {
    const existing = registry.tokenFor(reusing);
    if (existing !== undefined) return { configuration: config, token: existing };
  }
  return { configuration: config, token: registry.issue() };
}

function withInjection(base: { [key: string]: JSONValue }, injection: AgentToolsInjection | undefined): JSONValue {
  if (!injection) return base;
  return {
    ...base,
    developerInstructions: agentToolsInstructions(injection.configuration.cliPath),
    config: agentToolsCodexConfig(injection),
  };
}

export function threadStartParams(cwd: string, injection: AgentToolsInjection | undefined): JSONValue {
  return withInjection({ cwd }, injection);
}

export function threadResumeParams(threadId: string, injection: AgentToolsInjection | undefined): JSONValue {
  return withInjection({ threadId }, injection);
}

/**
 * `turn/start` 的参数。`UserInput` 的 text 变体带一个 `text_elements`（UI 用的富文本片段），
 * 我们没有富文本，给空数组。图用 `localImage {path}`（app-server 自己读文件），排在文字后面；
 * 只发图时没有 text 块——空字符串的 text 块会在对话里留下一条空消息。
 */
export function turnStartParams(
  threadId: string,
  text: string,
  imagePaths: string[] = [],
  selection: ModelSelection = {},
): JSONValue {
  const input: JSONValue[] = [];
  if (text.length > 0) input.push({ type: "text", text, text_elements: [] });
  for (const path of imagePaths) input.push({ type: "localImage", path });
  const params: { [key: string]: JSONValue } = { threadId, input };
  if (selection.model !== undefined) params["model"] = selection.model;
  if (selection.effort !== undefined) params["effort"] = selection.effort;
  return params;
}

// MARK: - 审批响应编码

/** 按请求种类编出 app-server 期待的响应结构。不是审批的返回 undefined。 */
export function approvalResult(request: CodexServerRequest, decision: CodexApprovalDecision): JSONValue | undefined {
  switch (request.kind) {
    case "commandExecution":
    case "fileChange":
      return { decision };
    case "permissions": {
      const granted = decisionGrantsPermission(decision)
        ? grantedPermissions(jsonPath(request.params, "permissions"))
        : {};
      return { permissions: granted, scope: decisionPermissionScope(decision) };
    }
    case "userInput":
      // 没有“同意/拒绝”。approve 命令里没有文本通道，只能回一份空答案把轮次放行。
      return { answers: {} };
    default:
      return undefined;
  }
}

/** 手机点选的答案 → `ToolRequestUserInputResponse{answers: {id: {answers: [...]}}}`。 */
export function userInputAnswers(
  answers: Record<string, string[]>,
  request: CodexServerRequest,
): JSONValue | undefined {
  const ids = new Set(
    (jsonArray(jsonPath(request.params, "questions")) ?? [])
      .map((question) => jsonString(jsonPath(question, "id")))
      .filter((id): id is string => id !== undefined),
  );
  const result: { [key: string]: JSONValue } = {};
  for (const [id, values] of Object.entries(answers)) {
    if (!ids.has(id)) continue;
    const picked = values.map((value) => value.trim()).filter((value) => value.length > 0);
    if (picked.length === 0) continue;
    result[id] = { answers: picked };
  }
  return Object.keys(result).length === 0 ? undefined : { answers: result };
}

/** `RequestPermissionProfile` → `GrantedPermissionProfile`：把非空的那几项原样授出去。 */
export function grantedPermissions(requested: JSONValue | undefined): JSONValue {
  const granted: { [key: string]: JSONValue } = {};
  for (const key of ["network", "fileSystem"]) {
    const value = jsonPath(requested, key);
    if (value === undefined || value === null) continue;
    granted[key] = value;
  }
  return granted;
}

/** 能用“协议内的拒绝值”答复的请求。答不上来的返回 undefined，由调用方回 JSON-RPC 错误。 */
export function refusalResult(request: CodexServerRequest): JSONValue | undefined {
  const payload = approvalResult(request, "decline");
  if (payload !== undefined) return payload;
  switch (request.method) {
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    default:
      return undefined;
  }
}

/** 回给“本 Agent 不实现这个请求”的 JSON-RPC 错误码（method not found）。 */
export const UNSUPPORTED_REQUEST_CODE = -32601;

// MARK: - PendingRequest 的构造

function nonEmpty(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.trim().length === 0 ? undefined : text;
}

function clampLine(text: string, limit: number): string {
  return CodexThreadReader.truncate(CodexThreadReader.singleLine(text), limit);
}

function clampBlock(text: string, limit: number): string {
  return CodexThreadReader.truncate(text, limit);
}

/** `RequestPermissionProfile` 的一句人话。只读字段名与路径，不带任何会话内容。 */
export function describePermissions(value: JSONValue | undefined): string {
  const lines: string[] = [];
  const network = jsonPath(value, "network");
  if (network !== undefined && network !== null) {
    lines.push(jsonBool(jsonPath(network, "enabled")) === true ? "网络访问" : "网络策略调整");
  }
  const fileSystem = jsonPath(value, "fileSystem");
  if (fileSystem !== undefined && fileSystem !== null) {
    for (const [label, key] of [["读取", "read"], ["写入", "write"]] as const) {
      const paths = (jsonArray(jsonPath(fileSystem, key)) ?? [])
        .map((path) => jsonString(path))
        .filter((path): path is string => path !== undefined);
      if (paths.length === 0) continue;
      lines.push(`${label}：${paths.join("、")}`);
    }
  }
  return lines.join("\n");
}

/** `requestUserInput` 的问题 → 协议 2.14 的 `questions`。Codex 的问题没有多选。 */
export function pendingQuestions(questions: JSONValue[]): CodexPendingQuestion[] | undefined {
  const mapped: CodexPendingQuestion[] = [];
  for (const item of questions.slice(0, MAX_QUESTIONS)) {
    const id = nonEmpty(jsonString(jsonPath(item, "id")));
    const header = nonEmpty(jsonString(jsonPath(item, "header")));
    const question = nonEmpty(jsonString(jsonPath(item, "question"))) ?? header;
    if (id === undefined || question === undefined) continue;
    const options: CodexPendingOption[] = [];
    for (const option of (jsonArray(jsonPath(item, "options")) ?? []).slice(0, MAX_OPTIONS)) {
      const label = nonEmpty(jsonString(jsonPath(option, "label")));
      if (label === undefined) continue;
      const description = nonEmpty(jsonString(jsonPath(option, "description")));
      options.push(description === undefined ? { label } : { label, description });
    }
    mapped.push({
      id,
      question: clampBlock(question, 4000),
      ...(header === undefined ? {} : { header }),
      options,
    });
  }
  return mapped.length === 0 ? undefined : mapped;
}

/** 把服务端请求翻成协议里的 `PendingRequest`。**只挑要给用户看的**，原始 params 不外泄。 */
export function pendingRequestFrom(
  request: CodexServerRequest,
  kind: "command" | "fileChange" | "permission" | "input",
): CodexPendingRequest {
  const reason = nonEmpty(jsonString(jsonPath(request.params, "reason")));
  switch (kind) {
    case "command": {
      const command = nonEmpty(jsonString(jsonPath(request.params, "command")));
      const summary = command !== undefined ? `执行命令：${command}` : (reason ?? "请求执行命令");
      const cwd = nonEmpty(jsonString(jsonPath(request.params, "cwd")));
      const detail = [reason, cwd === undefined ? undefined : `工作目录：${cwd}`]
        .filter((part): part is string => part !== undefined)
        .join("\n");
      const normalizedDetail = nonEmpty(detail);
      return {
        id: request.key,
        kind,
        summary: clampLine(summary, 200),
        ...(normalizedDetail === undefined ? {} : { detail: clampBlock(normalizedDetail, 4000) }),
      };
    }
    case "fileChange": {
      const paths = request.fileChanges.map((change) => basename(change.path));
      const summary =
        paths.length === 0
          ? (reason ?? "请求修改文件")
          : `修改 ${paths.length} 个文件：${paths.join("、")}`;
      const diffs = request.fileChanges
        .map((change) => `--- ${change.path} (${change.kind})\n${change.diff}`)
        .join("\n");
      const normalized = nonEmpty(diffs);
      return {
        id: request.key,
        kind,
        summary: clampLine(summary, 200),
        ...(normalized !== undefined
          ? { detail: clampBlock(normalized, 4000) }
          : reason !== undefined
            ? { detail: reason }
            : {}),
      };
    }
    case "permission": {
      const detail = nonEmpty(describePermissions(jsonPath(request.params, "permissions")));
      return {
        id: request.key,
        kind,
        summary: clampLine(reason ?? "请求额外权限", 200),
        ...(detail === undefined ? {} : { detail: clampBlock(detail, 4000) }),
      };
    }
    case "input": {
      const questions = jsonArray(jsonPath(request.params, "questions")) ?? [];
      const first = questions[0];
      const question = nonEmpty(jsonString(jsonPath(first, "question")));
      const header = nonEmpty(jsonString(jsonPath(first, "header")));
      const options = (jsonArray(jsonPath(first, "options")) ?? [])
        .map((option) => jsonString(jsonPath(option, "label")))
        .filter((label): label is string => label !== undefined);
      let detail = options.length === 0 ? "" : `可选项：${options.join("、")}`;
      if (questions.length > 1) {
        detail = detail.length === 0 ? `还有 ${questions.length - 1} 个问题` : `${detail}\n还有 ${questions.length - 1} 个问题`;
      }
      const normalized = nonEmpty(detail);
      const mappedQuestions = pendingQuestions(questions);
      return {
        id: request.key,
        kind,
        summary: clampLine(header ?? question ?? "Codex 在等你回答", 200),
        ...(normalized === undefined ? {} : { detail: clampBlock(normalized, 4000) }),
        ...(question === undefined ? {} : { question: clampBlock(question, 4000) }),
        ...(mappedQuestions === undefined ? {} : { questions: mappedQuestions }),
      };
    }
  }
}

/** Codex 的 `codexErrorInfo` → 协议 3.7 的诊断。 */
export function diagnosisFromErrorInfo(errorInfo: string | undefined): FailureDiagnosis | undefined {
  switch (errorInfo) {
    case "unauthorized":
      return { kind: "signInExpired" };
    case "usageLimitExceeded":
    case "rateLimitExceeded":
      return { kind: "usageLimit" };
    default:
      return undefined;
  }
}

// MARK: - 连接器

/** 一条由本连接器实时驱动的线程。 */
type LiveThread = {
  threadId: string;
  projectPath: string;
  projectName: string;
  title: string;
  status: TaskStatus;
  lastMessage?: string;
  pendingRequest?: CodexPendingRequest;
  origin: "watch" | "desktop";
  startedAt: number;
  updatedAt: number;
  /** 挂在这个任务上的服务端请求 key。 */
  pendingKey?: string;
  /** 最近一次 `turn/started` 的轮次 id。`turn/interrupt` 必须带它。 */
  currentTurnId?: string;
  /** 线程在哪一代子进程里被 `thread/start` / `thread/resume` 过。 */
  loadedGeneration?: number;
  /** 本连接器是否已向宿主认领这个 id。 */
  owned: boolean;
  /** 本轮是否已经收到过 `phase == final_answer` 的 agent 消息。 */
  hasFinalAnswer: boolean;
  diagnosis?: FailureDiagnosis;
  model?: string;
  effort?: string;
  /** 协议 3.3：共用桌面时，当前这一轮是不是手机起的。 */
  phoneTurn: boolean;
};

export type CodexTaskRecord = BusTask & { diagnosis?: FailureDiagnosis };

const MESSAGE_LIMIT = 500;
const TITLE_LIMIT = 80;

export type CodexConnectorOptions = {
  /** 每次 `thread/start` / `thread/resume` 前现取；nil 或不可用 = 不注入 agent 工具。 */
  tools?: () => AgentToolsConfiguration | undefined;
  registry?: TaskContextRegistry;
  now?: () => string | number | Date;
  statusObserver?: (status: CodexConnectorStatus) => void;
  sharedDesktop?: boolean;
  /** 项目自动批准。上游 `TaskStore.autoApproves(taskId:workingDirectory:)`。 */
  autoApproves?: (taskId: string, workingDirectory?: string) => boolean | Promise<boolean>;
  /** 注册表里的 `ConnectorInfo.models`；不提供时用 `model/list` 的缓存。 */
  models?: () => ModelOption[] | undefined;
  setModels?: (models: ModelOption[]) => boolean;
  broadcastSnapshot?: () => void | Promise<void>;
};

/**
 * Codex 的命令语义与审批生命周期：坐在 `CodexAppServer`（协议层）与宿主（状态与通知）中间。
 *
 * 几条不显然的约定：
 * - **命令返回 ≠ 轮次结束**。四条命令一律返回 `retainsLiveOwnership: true`。
 * - **服务端请求一条都不能不回**。四类审批转成待审批挂到任务上；其余**立刻**回掉。
 * - **审批请求本身不带 diff**，补丁由 `CodexAppServer` 从同 itemId 的 `item/started` 缓存里配好。
 * - **状态不自己推导**：一律取 `notificationStatusTransition`。
 * - **日志只记方法名、id、种类与条数**，审批摘要、补丁、消息正文一个字都不进日志。
 */
export class CodexConnector implements TaskConnector {
  readonly kind = "codex" as const;

  /** 只发图、不写字新建任务时的标题。 */
  static readonly imageOnlyTitle = "图片";
  static readonly titleLimit = TITLE_LIMIT;
  static readonly messageLimit = MESSAGE_LIMIT;
  static readonly summaryLimit = 200;
  static readonly detailLimit = 4000;
  static readonly maxTrackedThreads = 256;

  private readonly host: ConnectorHost;
  private readonly server: CodexAppServer;
  private readonly options: CodexConnectorOptions;
  private readonly nowValue: () => number;
  private readonly registry: TaskContextRegistry;
  private readonly sharedDesktop: boolean;

  private readonly threads = new Map<string, LiveThread>();
  private order: string[] = [];
  /** itemId → 正在流式拼接的 agent 消息。 */
  private readonly messageBuffers = new Map<string, Map<string, string>>();
  private eventLoop: Promise<void> | undefined;
  private eventIterator: AsyncIterator<CodexAppServerEvent> | undefined;
  private activeCommands = 0;
  private handoffRequested = false;
  private modelsCache: ModelOption[] | undefined;
  private readonly tempImages: string[] = [];
  private statusValue: CodexConnectorStatus = { phase: "stopped", generation: 0, liveTaskCount: 0 };

  constructor(host: ConnectorHost, server: CodexAppServer, options: CodexConnectorOptions = {}) {
    this.host = host;
    this.server = server;
    this.options = options;
    this.registry = options.registry ?? new TaskContextRegistry();
    this.sharedDesktop = options.sharedDesktop ?? false;
    const configured = options.now;
    this.nowValue = configured
      ? () => {
          const value = configured();
          if (typeof value === "number") return value;
          if (value instanceof Date) return value.getTime();
          const parsed = Date.parse(value);
          return Number.isFinite(parsed) ? parsed : Date.now();
        }
      : Date.now;
  }

  get status(): CodexConnectorStatus {
    return this.statusValue;
  }

  /** 和桌面版共用时 app-server 是桌面版起的，BotBus 的文件夹授权说明不了它。 */
  get runsUnderBotBus(): boolean {
    return !this.sharedDesktop;
  }

  // MARK: - 生命周期

  /** 订阅事件流、起 app-server。幂等。 */
  start(): Promise<void>;
  start(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome>;
  async start(
    projectPath?: string,
    prompt?: string,
    images?: ImageSource[],
    selection?: ModelSelection,
  ): Promise<void | ConnectorOutcome> {
    if (projectPath === undefined) return this.startServer();
    return this.startTask(projectPath, prompt ?? "", images ?? [], selection);
  }

  private async startServer(): Promise<void> {
    if (this.eventLoop) return;
    const stream = this.server.events();
    const iterator = stream[Symbol.asyncIterator]();
    this.eventIterator = iterator;
    this.eventLoop = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        await this.handle(next.value);
      }
    })().catch((error) => {
      console.error(`[codexconnector] 事件循环结束：${describeError(error)}`);
    });
    // 先报“正在启动”再真的起：`.started` 是异步送达的，不然菜单栏会有一小段写着“未运行”。
    this.updateStatus((next) => {
      next.phase = "starting";
    });
    this.server.start();
  }

  /** 停掉事件循环与 app-server，并把所有实时任务交还给只读观察。幂等。 */
  async stop(): Promise<void> {
    if (this.eventIterator?.return) await this.eventIterator.return();
    this.eventIterator = undefined;
    this.eventLoop = undefined;
    this.server.stop();
    for (const threadId of [...this.order]) {
      // 不动 server 的控制账：那是“重启后要不要 resume”的事，跟停机无关。
      await this.release(threadId, false);
    }
    this.threads.clear();
    this.order = [];
    this.messageBuffers.clear();
    for (const path of this.tempImages.splice(0)) {
      try {
        unlinkSync(path);
      } catch {
        // 临时文件已经被系统清掉：忽略。
      }
    }
    // `CodexAppServer.stop()` 不发 `.exited`，状态得自己收。
    this.updateStatus((next) => {
      next.phase = "stopped";
      next.detail = undefined;
      next.after = undefined;
    });
  }

  /** Stop accepting new commands once all in-flight commands have completed. */
  prepareForDesktopHandoff(): boolean {
    if (this.activeCommands !== 0 || this.statusValue.liveTaskCount !== 0) return false;
    this.handoffRequested = true;
    return true;
  }

  cancelDesktopHandoff(): void {
    this.handoffRequested = false;
  }

  private enterCommand(): void {
    if (this.handoffRequested) throw new ConnectorError("Codex 桌面正在连接，请稍后重试");
    this.activeCommands += 1;
  }

  /** 当前由本连接器实时驱动的线程 id（按首次出现顺序）。 */
  liveThreadIds(): string[] {
    return [...this.order];
  }

  /** 线程上最近一次 `turn/started` 的轮次 id。 */
  currentTurnId(threadId: string): string | undefined {
    return this.threads.get(threadId)?.currentTurnId;
  }

  /** 线程是否已在**当前这一代**子进程里加载过。 */
  isLoaded(threadId: string): boolean {
    const loaded = this.threads.get(threadId)?.loadedGeneration;
    if (loaded === undefined) return false;
    return loaded === this.server.processGeneration;
  }

  // MARK: - TaskConnector：四条命令

  /** `thread/start {cwd}` → `turn/start {threadId, input:[text, localImage…]}`。 */
  private async startTask(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    this.enterCommand();
    try {
      const path = projectPath.trim();
      if (path.length === 0) throw new ConnectorError("startTask 没有给项目目录");
      const text = prompt.trim();
      // 只发图不写字也是一条完整的消息。
      if (text.length === 0 && images.length === 0) throw new ConnectorError("startTask 的 prompt 是空的");
      // 在 `thread/start` 之前就查：选错了不该先建出一条空线程。
      this.validate(selection, undefined);

      const injection = makeAgentToolsInjection(this.options.tools?.(), this.registry);
      const response = await this.server.request("thread/start", threadStartParams(path, injection));
      const threadId = jsonString(jsonPath(response, "thread", "id"));
      if (threadId === undefined || threadId.length === 0) throw new ConnectorError("Codex 没有返回线程 id");
      if (injection) this.registry.bind(injection.token, codexProtocolId(threadId));
      // 应答里的 cwd 是 app-server 规范化过的绝对路径，比客户端传来的更可信。
      const cwd = jsonString(jsonPath(response, "cwd")) ?? path;
      // 手机端没有空标题兜底：只发图时总得给列表里的这一行起个名字。
      const title =
        text.length === 0
          ? CodexConnector.imageOnlyTitle
          : CodexThreadReader.truncate(CodexThreadReader.singleLine(text), TITLE_LIMIT);
      this.register(threadId, cwd, title, "watch");
      this.applyModel(response, threadId);
      const generation = this.server.processGeneration;
      this.mutate(threadId, (thread) => {
        thread.loadedGeneration = generation;
        thread.status = "running";
      });
      await this.claim(threadId);
      await this.publish(threadId);

      // 先记下再发：这一轮的第一条审批可能比 `turn/start` 的应答先到。
      this.mutate(threadId, (thread) => {
        thread.phoneTurn = true;
      });
      try {
        const paths = await this.imagePaths(images);
        await this.server.request("turn/start", turnStartParams(threadId, text, paths, selection));
        this.mutate(threadId, (thread) => {
          if (selection?.model !== undefined) thread.model = selection.model;
          if (selection?.effort !== undefined) thread.effort = selection.effort;
        });
      } catch (error) {
        this.mutate(threadId, (thread) => {
          thread.phoneTurn = false;
        });
        // 轮次没起来就别霸着所有权，让只读观察接手这条线程。
        await this.release(threadId);
        throw error;
      }
      await this.publish(threadId);
      return { taskId: codexProtocolId(threadId), retainsLiveOwnership: true, runsUnderBotBus: true };
    } finally {
      this.activeCommands -= 1;
    }
  }

  /**
   * 线程不在本进程里就先 `thread/resume`，再 `turn/start`。
   *
   * 有一个例外：这个线程正挂着一条 `item/tool/requestUserInput` 时，续聊**就是**那条回答，
   * 不另起一轮。
   */
  async followUp(
    taskId: string,
    prompt: string,
    images: ImageSource[],
    selection: ModelSelection = {},
  ): Promise<ConnectorOutcome> {
    this.enterCommand();
    try {
      const threadId = codexNativeId(taskId);
      const text = prompt.trim();
      if (text.length === 0 && images.length === 0) throw new ConnectorError("followUp 的 prompt 是空的");
      this.validate(selection, threadId);

      const question = this.pendingUserInput(threadId);
      if (question) {
        // `requestUserInput` 的回答只收文字：带图的续聊若当成回答，图会被悄悄丢掉。
        if (images.length > 0) throw new ConnectorError("Agent 正在等你回答问题，先回答再发图");
        if (await this.answerUserInput(question, text)) {
          this.mutate(threadId, (thread) => {
            thread.pendingKey = undefined;
            thread.pendingRequest = undefined;
            if (thread.status === "waitingInput") thread.status = "running";
          });
          await this.publish(threadId);
          return { taskId: codexProtocolId(threadId), retainsLiveOwnership: true, runsUnderBotBus: true };
        }
      }

      if (this.sharedDesktop && !this.isLoaded(threadId)) {
        // A desktop thread can already be loaded in the same upstream even if this Agent
        // has never seen it. Resuming that thread would unnecessarily alter its settings.
        const loaded = await this.server.request("thread/loaded/list", {});
        const ids = (jsonArray(jsonPath(loaded, "data")) ?? []).filter((id): id is string => typeof id === "string");
        if (ids.includes(threadId)) {
          await this.adopt(threadId, undefined);
          const generation = this.server.processGeneration;
          this.mutate(threadId, (thread) => {
            thread.loadedGeneration = generation;
          });
        }
      }

      if (!this.isLoaded(threadId)) {
        // 只有要重新加载线程时才注入：已加载的线程上次 start / resume 时已经带过了。
        const injection = makeAgentToolsInjection(
          this.options.tools?.(),
          this.registry,
          codexProtocolId(threadId),
        );
        const response = await this.server.request(
          "thread/resume",
          threadResumeParams(threadId, injection),
        );
        if (injection) this.registry.bind(injection.token, codexProtocolId(threadId));
        await this.adopt(threadId, response);
        const generation = this.server.processGeneration;
        this.mutate(threadId, (thread) => {
          thread.loadedGeneration = generation;
        });
      }
      const paths = await this.imagePaths(images);
      await this.claim(threadId);
      // 图与字一起进 `input`（localImage）：`turn/steer` 与 `turn/start` 收同一种 UserInput。
      const params = turnStartParams(threadId, text, paths, selection);
      const wasPhoneTurn = this.threads.get(threadId)?.phoneTurn ?? false;
      this.mutate(threadId, (thread) => {
        thread.phoneTurn = true;
      });
      try {
        const activeTurn = this.threads.get(threadId)?.currentTurnId;
        if (this.sharedDesktop && activeTurn !== undefined) {
          const input = jsonPath(params, "input") ?? [];
          await this.server.request("turn/steer", {
            threadId,
            expectedTurnId: activeTurn,
            input,
          });
        } else {
          await this.server.request("turn/start", params);
          this.mutate(threadId, (thread) => {
            if (selection.model !== undefined) thread.model = selection.model;
            if (selection.effort !== undefined) thread.effort = selection.effort;
          });
        }
      } catch (error) {
        this.mutate(threadId, (thread) => {
          thread.phoneTurn = wasPhoneTurn;
        });
        throw error;
      }
      this.mutate(threadId, (thread) => {
        thread.status = "running";
      });
      await this.publish(threadId);
      return { taskId: codexProtocolId(threadId), retainsLiveOwnership: true, runsUnderBotBus: true };
    } finally {
      this.activeCommands -= 1;
    }
  }

  /**
   * 回答一条挂起的服务端请求。
   *
   * 请求可能**已经不在了**：`turn/completed`（任何状态）会让 `CodexAppServer` 静默丢弃
   * 该轮所有挂起的服务端请求——是丢弃不是回答。
   */
  async approve(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome> {
    this.enterCommand();
    try {
      const threadId = codexNativeId(taskId);
      const request = this.server.pendingServerRequest(requestId);
      if (!request) {
        // 顺手把任务上那条已经没有对端的待审批摘掉，免得手机上一直挂着一颗按不动的按钮。
        await this.forgetPendingRequest(threadId, requestId);
        throw new ConnectorError(`审批请求 ${requestId} 已失效：所属轮次已经结束，或者它已经被回答过了`);
      }
      if (request.threadId !== undefined && request.threadId !== threadId) {
        throw new ConnectorError(`审批请求 ${requestId} 属于另一个 Codex 线程，不是 ${taskId}`);
      }
      const mapped = codexApprovalDecision(decision);
      let payload: JSONValue | undefined;
      if (request.kind === "userInput" && decision === "allow") {
        const answered = userInputAnswers(answers ?? {}, request);
        if (answered !== undefined) payload = answered;
      }
      if (payload === undefined) payload = approvalResult(request, mapped);
      if (payload === undefined) throw new ConnectorError(`不认识的审批请求 ${request.method}`);

      await this.claim(threadId);
      await this.server.respond(requestId, payload);
      console.info(`[codexconnector] 回答审批 ${request.method} ${requestId} → ${mapped}`);
      this.mutate(threadId, (thread) => {
        if (thread.pendingKey === requestId) {
          thread.pendingKey = undefined;
          thread.pendingRequest = undefined;
        }
        if (thread.status === "waitingApproval" || thread.status === "waitingInput") thread.status = "running";
      });
      await this.publish(threadId);
      return { taskId: codexProtocolId(threadId), retainsLiveOwnership: true, runsUnderBotBus: true };
    } finally {
      this.activeCommands -= 1;
    }
  }

  /** `turn/interrupt {threadId, turnId}`。轮次 id 来自最近一条 `turn/started`。 */
  async interrupt(taskId: string): Promise<ConnectorOutcome> {
    this.enterCommand();
    try {
      const threadId = codexNativeId(taskId);
      const turnId = this.threads.get(threadId)?.currentTurnId;
      if (turnId === undefined || turnId.length === 0) {
        throw new ConnectorError(`Codex 线程 ${threadId} 上没有本机在驱动的轮次，无法中断`);
      }
      await this.claim(threadId);
      await this.server.request("turn/interrupt", { threadId, turnId });
      // 中断只是发出去了：状态要等 turn/completed(interrupted) 才落地，所有权也留到那时再还。
      return { taskId: codexProtocolId(threadId), retainsLiveOwnership: true, runsUnderBotBus: true };
    } finally {
      this.activeCommands -= 1;
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    const threadId = codexNativeId(taskId);
    this.enterCommand();
    try {
      const thread = this.threads.get(threadId);
      if (thread && thread.currentTurnId !== undefined) {
        throw new ConnectorError("会话还在进行中，等它停下来再删除");
      }
      // 使用上游的删除事务，绝不写 Codex 数据库。老版本不支持时原样回失败。
      await this.server.request("thread/delete", { threadId });
      this.threads.delete(threadId);
      this.order = this.order.filter((id) => id !== threadId);
    } finally {
      this.activeCommands -= 1;
    }
  }

  /** 协议 3.4：合并并结束后把线程归档。尽力而为。 */
  async discard(taskId: string): Promise<void> {
    let threadId: string;
    try {
      threadId = codexNativeId(taskId);
    } catch {
      return;
    }
    try {
      this.enterCommand();
    } catch {
      console.info("[codexconnector] 桌面正在接管，跳过 thread/archive");
      return;
    }
    try {
      await this.server.request("thread/archive", { threadId });
    } catch (error) {
      console.error(`[codexconnector] thread/archive 失败：${describeError(error)}`);
    } finally {
      this.activeCommands -= 1;
    }
  }

  // MARK: - 事件

  private async handle(event: CodexAppServerEvent): Promise<void> {
    switch (event.type) {
      case "started":
        // 新一代子进程里什么线程都没加载；下一条命令会自己发现代数变了并重新 resume。
        console.info(`[codexconnector] app-server 第 ${event.generation} 代起来了`);
        this.updateStatus((next) => {
          next.phase = "starting";
          next.generation = event.generation;
          next.detail = undefined;
          next.after = undefined;
        });
        return;
      case "ready":
        this.updateStatus((next) => {
          next.phase = "ready";
          next.generation = event.generation;
          next.detail = undefined;
          next.after = undefined;
        });
        // 不在事件循环里等应答：`model/list` 慢一点不该挡住后面的通知。
        void this.refreshModels();
        return;
      case "notification":
        await this.applyNotification(event.notification);
        return;
      case "serverRequest":
        await this.applyServerRequest(event.request);
        return;
      case "exited":
        await this.handleProcessExit();
        this.updateStatus((next) => {
          if (event.restartingIn === undefined) {
            next.phase = "stopped";
            next.after = undefined;
          } else {
            next.phase = "restarting";
            next.after = event.restartingIn;
          }
          next.detail = exitDetail(event.exit);
        });
        return;
      case "resumingAfterRestart":
        console.info(`[codexconnector] app-server 重启后正在 resume ${event.threadIds.length} 个线程`);
        return;
    }
  }

  /** 只在值真的变了时才通知观察者。 */
  private updateStatus(body: (next: CodexConnectorStatus) => void): void {
    const next: CodexConnectorStatus = { ...this.statusValue };
    body(next);
    next.liveTaskCount = this.order.reduce((count, id) => count + (this.threads.get(id)?.owned === true ? 1 : 0), 0);
    const before = JSON.stringify(this.statusValue);
    if (JSON.stringify(next) === before) return;
    this.statusValue = next;
    this.options.statusObserver?.(next);
  }

  private async applyNotification(notification: CodexNotification): Promise<void> {
    if (notification.type === "other" && notification.method === "thread/deleted") {
      const id = jsonString(jsonPath(notification.params, "threadId"));
      if (id !== undefined) {
        this.threads.delete(id);
        this.order = this.order.filter((threadId) => threadId !== id);
        this.host.remove(codexProtocolId(id));
      }
      return;
    }
    let threadId = notificationThreadId(notification);
    // `error` 帧不带 threadId：归到最近还在跑的那条线程，别把失败原因丢掉。
    if (threadId === undefined && notification.type === "serverError") {
      threadId = this.activeThreadId();
    }
    if (threadId === undefined) return;
    if (!this.threads.has(threadId) && this.sharedDesktop) {
      // Desktop turns on the shared upstream are also actionable on the phone.
      let seed: JSONValue | undefined;
      if (notification.type === "threadStarted") {
        const thread = notification.thread;
        seed = { thread, cwd: jsonPath(thread, "cwd") ?? "" };
      } else {
        // A phone can attach halfway through a desktop turn. In that case the
        // thread/started event predates this Agent, so read its metadata once.
        try {
          seed = await this.server.request("thread/read", { threadId, includeTurns: false });
        } catch {
          seed = undefined;
        }
      }
      await this.adopt(threadId, seed);
      const generation = this.server.processGeneration;
      this.mutate(threadId, (thread) => {
        thread.loadedGeneration = generation;
      });
    }
    if (!this.threads.has(threadId)) return;

    switch (notification.type) {
      case "turnStarted": {
        if (this.sharedDesktop && this.threads.get(threadId)?.origin === "desktop") {
          try {
            const response = await this.server.request("thread/read", { threadId, includeTurns: false });
            // 桌面端可以在同一线程的两轮之间换模型；实时所有权期间观察者不能覆盖任务。
            this.applyModel(response, threadId);
          } catch {
            // 读不到就沿用旧值。
          }
        }
        this.mutate(threadId, (thread) => {
          thread.currentTurnId = notification.turnId.length === 0 ? undefined : notification.turnId;
          thread.hasFinalAnswer = false;
          // 上一轮的失败原因不带进这一轮。
          thread.diagnosis = undefined;
        });
        await this.claim(threadId);
        break;
      }
      case "turnCompleted":
        this.messageBuffers.delete(threadId);
        this.mutate(threadId, (thread) => {
          if (notification.turnId.length === 0 || thread.currentTurnId === notification.turnId) {
            thread.currentTurnId = undefined;
          }
          // 往保守的方向收：任何一轮结束都不再算手机的轮次。
          thread.phoneTurn = false;
          thread.pendingKey = undefined;
          thread.pendingRequest = undefined;
        });
        break;
      case "agentMessageDelta":
        this.accumulate(threadId, notification.itemId, notification.delta);
        break;
      case "itemStarted":
        if (notification.item.type === "agentMessage") {
          this.messageBuffers.get(threadId)?.delete(notification.item.id);
        }
        break;
      case "itemCompleted":
        this.complete(threadId, notification.item);
        break;
      case "serverError":
        this.mutate(threadId, (thread) => {
          thread.lastMessage = CodexThreadReader.truncate(notification.message, MESSAGE_LIMIT);
        });
        break;
      case "other": {
        if (notification.method === "serverRequest/resolved") {
          const raw = jsonPath(notification.params, "requestId");
          const number = jsonInt(raw);
          const id =
            number !== undefined
              ? `#${number}`
              : jsonString(raw) !== undefined
                ? `$${jsonString(raw) as string}`
                : undefined;
          if (id !== undefined) await this.forgetPendingRequest(threadId, id);
        }
        break;
      }
      default:
        break;
    }

    const transition = notificationStatusTransition(notification);
    if (transition !== undefined) {
      this.mutate(threadId, (thread) => {
        thread.status = transition;
      });
    }
    // 失败时把错误当作最后一条消息：通知正文取的就是 lastMessage。
    if (notification.type === "turnCompleted") {
      this.mutate(threadId, (thread) => {
        thread.diagnosis =
          notification.status.type === "failed" ? diagnosisFromErrorInfo(notification.errorInfo) : undefined;
        if (notification.status.type === "failed") {
          if (notification.error !== undefined && notification.error.length > 0) {
            thread.lastMessage = CodexThreadReader.truncate(notification.error, MESSAGE_LIMIT);
          } else if (thread.lastMessage === undefined || thread.lastMessage.length === 0) {
            thread.lastMessage = "Codex 轮次失败";
          }
        }
      });
    }

    await this.publish(threadId);
    if (notification.type === "turnCompleted") {
      // 轮次结束 = 本连接器不再实时驱动它，交还给只读观察。
      await this.release(threadId);
    }
  }

  /** `error` 通知不带 threadId 时，归到最近还在跑的那条线程。 */
  private activeThreadId(): string | undefined {
    let best: LiveThread | undefined;
    for (const thread of this.threads.values()) {
      if (thread.status !== "running" && thread.currentTurnId === undefined) continue;
      if (!best || thread.updatedAt >= best.updatedAt) best = thread;
    }
    return best?.threadId;
  }

  private async applyServerRequest(request: CodexServerRequest): Promise<void> {
    const kind = request.pendingRequestKind;
    if (kind === undefined) {
      if (!this.sharedDesktop) await this.autoAnswer(request);
      return;
    }
    if (this.sharedDesktop && request.threadId !== undefined && !this.threads.has(request.threadId)) {
      await this.adopt(request.threadId, undefined);
    }
    const threadId = request.threadId;
    if (threadId === undefined || !this.threads.has(threadId)) {
      if (this.sharedDesktop) return;
      // 没有任务可挂 = 没人能回答它。不能放着不管（codex 会一直等），只能按最保守的方向拒掉。
      console.error(`[codexconnector] 收到不属于任何实时任务的审批请求 ${request.method}，按拒绝处理`);
      await this.autoAnswer(request);
      return;
    }
    if (kind !== "input" && (await this.autoApprove(request, threadId))) return;
    const pending = pendingRequestFrom(request, kind);
    if (this.sharedDesktop) await this.claim(threadId);
    this.mutate(threadId, (thread) => {
      thread.pendingKey = request.key;
      thread.pendingRequest = pending;
      thread.status = kind === "input" ? "waitingInput" : "waitingApproval";
    });
    console.info(`[codexconnector] 挂起审批 ${request.method} ${request.key} kind=${kind}`);
    await this.publish(threadId);
  }

  /**
   * 协议 3.3：手机驱动的轮次里、项目开着自动批准时，审批（不含 `requestUserInput`）直接按
   * 「只这一次允许」回掉，不挂 pendingRequest。返回 true = 已经回了。
   */
  private async autoApprove(request: CodexServerRequest, threadId: string): Promise<boolean> {
    if (this.sharedDesktop && this.threads.get(threadId)?.phoneTurn !== true) return false;
    const workingDirectory = this.threads.get(threadId)?.projectPath;
    const enabled = await this.options.autoApproves?.(codexProtocolId(threadId), workingDirectory);
    if (enabled !== true) return false;
    const result = approvalResult(request, "accept");
    if (result === undefined) return false;
    try {
      await this.server.respond(request.key, result);
      console.info(`[codexconnector] 项目已开自动批准，放行 ${request.method} ${request.key}`);
    } catch (error) {
      // 回不出去多半是这一轮已经没了，挂成卡片也没人能答，只记日志。
      console.error(`[codexconnector] 自动批准 ${request.key} 失败：${describeError(error)}`);
    }
    return true;
  }

  /**
   * 子进程没了：这一轮的服务端请求全没了，线程也不在任何一代进程里加载着。
   * **不碰 `releaseControl`**：`CodexAppServer` 刚把重启后要 resume 的名单记好。
   */
  private async handleProcessExit(): Promise<void> {
    this.messageBuffers.clear();
    for (const threadId of [...this.order]) {
      this.mutate(threadId, (thread) => {
        thread.pendingKey = undefined;
        thread.pendingRequest = undefined;
        thread.currentTurnId = undefined;
        thread.loadedGeneration = undefined;
        thread.phoneTurn = false;
      });
      await this.release(threadId, false);
    }
  }

  // MARK: - 非审批的服务端请求

  /**
   * 不属于四类审批的服务端请求怎么答。**必须答**：不答 codex 就在那条请求上一直等，线程挂死。
   *
   * - 协议里本来就有“拒绝”取值的，用协议自己的拒绝（MCP elicitation 的 `action: "decline"`）。
   * - 其余的一律回 JSON-RPC 错误。`item/tool/call`、`account/chatgptAuthTokens/refresh`、
   *   `attestation/generate` 这三样本 Agent 都没有，也**故意不去读** `~/.codex/auth.json`。
   */
  private async autoAnswer(request: CodexServerRequest): Promise<void> {
    try {
      const refusal = refusalResult(request);
      if (refusal !== undefined) await this.server.respond(request.key, refusal);
      else await this.server.respond(request.key, UNSUPPORTED_REQUEST_CODE, `BotBus 不实现 ${request.method}`);
      console.info(`[codexconnector] 拒绝服务端请求 ${request.method} ${request.key}`);
    } catch (error) {
      console.error(`[codexconnector] 回复服务端请求 ${request.key} 失败：${describeError(error)}`);
    }
  }

  /** 这个线程上挂着的、还活着的 `item/tool/requestUserInput`。 */
  private pendingUserInput(threadId: string): CodexServerRequest | undefined {
    const key = this.threads.get(threadId)?.pendingKey;
    if (key === undefined) return undefined;
    const request = this.server.pendingServerRequest(key);
    return request?.kind === "userInput" ? request : undefined;
  }

  /** 把续聊的文本当成每个问题的答案回过去。没有可回答的问题时返回 false。 */
  private async answerUserInput(request: CodexServerRequest, text: string): Promise<boolean> {
    const ids = (jsonArray(jsonPath(request.params, "questions")) ?? [])
      .map((question) => jsonString(jsonPath(question, "id")))
      .filter((id): id is string => id !== undefined);
    if (ids.length === 0) {
      // 一个问题都解不出来：先把请求放行，别让轮次挂着。
      try {
        await this.server.respond(request.key, { answers: {} });
      } catch {
        // 请求已经没了：忽略。
      }
      return false;
    }
    const answers: { [key: string]: JSONValue } = {};
    for (const id of ids) answers[id] = { answers: [text] };
    await this.server.respond(request.key, { answers });
    console.info(`[codexconnector] 用 followUp 回答了 ${ids.length} 个问题 ${request.key}`);
    return true;
  }

  // MARK: - agent 消息的累积

  private accumulate(threadId: string, itemId: string, delta: string): void {
    if (this.threads.get(threadId)?.hasFinalAnswer === true) return;
    const buffers = this.messageBuffers.get(threadId) ?? new Map<string, string>();
    let text = buffers.get(itemId) ?? "";
    // 只显示前 messageLimit 个字符，攒过头没有意义，还会让长回答把内存吃掉。
    if (text.length >= MESSAGE_LIMIT) return;
    text += delta;
    buffers.set(itemId, text);
    this.messageBuffers.set(threadId, buffers);
    this.mutate(threadId, (thread) => {
      thread.lastMessage = CodexThreadReader.truncate(text, MESSAGE_LIMIT);
    });
  }

  private complete(threadId: string, item: CodexItem): void {
    if (item.type !== "agentMessage") return;
    this.messageBuffers.get(threadId)?.delete(item.id);
    const text = item.text;
    if (text === undefined || text.trim().length === 0) return;
    const isFinal = jsonString(jsonPath(item.raw, "phase")) === "final_answer";
    if (!isFinal && this.threads.get(threadId)?.hasFinalAnswer === true) return;
    this.mutate(threadId, (thread) => {
      thread.lastMessage = CodexThreadReader.truncate(text, MESSAGE_LIMIT);
      if (isFinal) thread.hasFinalAnswer = true;
    });
  }

  // MARK: - 线程账本

  private register(threadId: string, projectPath: string, title: string, origin: "watch" | "desktop"): void {
    const current = this.nowValue();
    if (!this.threads.has(threadId)) this.order.push(threadId);
    const existing = this.threads.get(threadId);
    this.threads.set(threadId, {
      threadId,
      projectPath,
      projectName: basename(projectPath),
      title,
      status: existing?.status ?? "running",
      lastMessage: existing?.lastMessage,
      pendingRequest: existing?.pendingRequest,
      origin: existing?.origin ?? origin,
      startedAt: existing?.startedAt ?? current,
      updatedAt: current,
      pendingKey: existing?.pendingKey,
      currentTurnId: existing?.currentTurnId,
      loadedGeneration: existing?.loadedGeneration,
      owned: existing?.owned ?? false,
      hasFinalAnswer: existing?.hasFinalAnswer ?? false,
      // 上游 register 不保留旧诊断：新一轮的失败原因由下一条 turn/completed 决定。
      diagnosis: undefined,
      model: existing?.model,
      effort: existing?.effort,
      phoneTurn: existing?.phoneTurn ?? false,
    });
    this.evictIfNeeded(threadId);
  }

  /**
   * 接管一个还没在本连接器里建账的线程（多半来自只读观察看到的桌面线程）。
   * 已有的 `TaskRecord` 是最好的种子：标题、项目、最后一条消息都别丢。
   */
  private async adopt(threadId: string, resumeResponse: JSONValue | undefined): Promise<void> {
    const existingThread = this.threads.get(threadId);
    if (existingThread) {
      const cwd = nonEmpty(jsonString(jsonPath(resumeResponse, "cwd")));
      if (cwd !== undefined) {
        this.mutate(threadId, (thread) => {
          thread.projectPath = cwd;
          thread.projectName = basename(cwd);
        });
      }
      if (resumeResponse !== undefined) this.applyModel(resumeResponse, threadId);
      return;
    }
    const existing = this.host.task(codexProtocolId(threadId));
    const cwd =
      nonEmpty(jsonString(jsonPath(resumeResponse, "cwd"))) ??
      nonEmpty(jsonString(jsonPath(resumeResponse, "thread", "cwd"))) ??
      existing?.projectPath ??
      "";
    const preview = nonEmpty(jsonString(jsonPath(resumeResponse, "thread", "preview")));
    const title =
      existing?.title ??
      (preview === undefined
        ? basename(cwd)
        : CodexThreadReader.truncate(CodexThreadReader.singleLine(preview), TITLE_LIMIT));
    this.register(threadId, cwd, title, existing?.origin === "watch" ? "watch" : "desktop");
    this.mutate(threadId, (thread) => {
      thread.lastMessage = existing?.lastMessage;
      if (existing) {
        const started = Date.parse(existing.startedAt);
        if (Number.isFinite(started)) thread.startedAt = started;
      }
      thread.model = existing?.model;
      thread.effort = existing?.effort;
    });
    if (resumeResponse !== undefined) this.applyModel(resumeResponse, threadId);
  }

  /**
   * `thread/start` / `thread/resume` 的应答在顶层带 `model` / `reasoningEffort`；
   * `thread/read` 和 `thread/started` 则放在 `thread` 里。共享桌面接入时两种形状都要读。
   */
  private applyModel(response: JSONValue, threadId: string): void {
    const rawModel =
      jsonString(jsonPath(response, "model")) ?? jsonString(jsonPath(response, "thread", "model"));
    const model = rawModel !== undefined && isValidModelId(rawModel) ? rawModel : undefined;
    const rawEffortValue =
      jsonPath(response, "reasoningEffort") ?? jsonPath(response, "thread", "reasoningEffort");
    const rawEffort = jsonString(rawEffortValue);
    const effort = rawEffort !== undefined && isValidEffort(rawEffort) ? rawEffort : undefined;
    this.mutate(threadId, (thread) => {
      if (model !== undefined) thread.model = model;
      if (rawEffortValue !== undefined) thread.effort = effort;
    });
  }

  // MARK: - 模型（协议 3.2）

  /**
   * 问 app-server 有哪些模型（`model/list`，不含 hidden），写进注册表；变了就补发一份快照。
   * 每代子进程握手完问一次：换了账号或升级了 Codex，列表会变。
   */
  async refreshModels(): Promise<void> {
    try {
      const response = await this.server.request("model/list", { limit: 50 });
      const models = modelOptions(response);
      this.modelsCache = models;
      if (this.options.setModels?.(models) === true) await this.options.broadcastSnapshot?.();
    } catch (error) {
      console.error(`[codexconnector] model/list 失败：${describeError(error)}`);
    }
  }

  /**
   * 手机选的模型与强度对不对得上 `model/list`；列表还没拿到时放行，让 app-server 自己判。
   * `threadId` 为 undefined 是新建任务：只换强度时按列表里的默认模型（排第一的）查。
   */
  private validate(selection: ModelSelection | undefined, threadId: string | undefined): void {
    if (!selection) return;
    const models = this.options.models?.() ?? this.modelsCache;
    if (!models) return;
    const modelId =
      selection.model ??
      (threadId === undefined ? undefined : this.threads.get(threadId)?.model) ??
      (threadId === undefined ? models[0]?.id : undefined);
    if (selection.model !== undefined && !models.some((model) => model.id === selection.model)) {
      throw new ConnectorError(`Codex 没有「${selection.model}」这个模型`);
    }
    if (selection.effort !== undefined) {
      const option = models.find((model) => model.id === modelId);
      if (option && option.efforts?.includes(selection.effort) !== true) {
        throw new ConnectorError(`${option.displayName} 不支持「${selection.effort}」这档思考强度`);
      }
    }
  }

  /** 只淘汰“已经不由本连接器驱动”的线程：正在跑的不能被挤掉。 */
  private evictIfNeeded(keeping: string): void {
    while (this.order.length > CodexConnector.maxTrackedThreads) {
      const victim = this.order.find((id) => id !== keeping && this.threads.get(id)?.owned !== true);
      if (victim === undefined) break;
      this.threads.delete(victim);
      this.messageBuffers.delete(victim);
      this.order = this.order.filter((id) => id !== victim);
    }
  }

  /** 改一个线程的实时状态。只有**记录里看得见的字段**变了才动 `updatedAt`。 */
  private mutate(threadId: string, body: (thread: LiveThread) => void): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const before = JSON.stringify(recordOf(thread, ""));
    body(thread);
    if (JSON.stringify(recordOf(thread, "")) !== before) thread.updatedAt = this.nowValue();
    this.threads.set(threadId, thread);
  }

  private async publish(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    // claimLive 是幂等的：分发器在命令失败路径上会交还所有权，这里每次都补一手，
    // 轮次还在跑的任务就不会被只读观察半路改写。
    if (thread.owned) this.host.claimLive(codexProtocolId(threadId));
    this.host.upsert(recordOf(thread, this.host.agentId));
  }

  private async claim(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.owned = true;
    this.updateStatus(() => undefined); // 只刷新 liveTaskCount
    this.host.claimLive(codexProtocolId(threadId));
  }

  /** 交还所有权。先把最终状态写进宿主再放手。 */
  private async release(threadId: string, relinquishControl = true): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread || !thread.owned) return;
    thread.owned = false;
    this.updateStatus(() => undefined);
    await this.publish(threadId);
    this.host.releaseLive(codexProtocolId(threadId));
    if (relinquishControl) this.server.releaseControl(threadId);
  }

  private async forgetPendingRequest(threadId: string, key: string): Promise<void> {
    if (this.threads.get(threadId)?.pendingKey !== key) return;
    this.mutate(threadId, (thread) => {
      thread.pendingKey = undefined;
      thread.pendingRequest = undefined;
      if (thread.status === "waitingApproval" || thread.status === "waitingInput") thread.status = "running";
    });
    await this.publish(threadId);
  }

  // MARK: - 图片

  /**
   * 手机发来的图在分发器里已经落成本机文件 URL；`data:` 形式（测试或旧调用方）落到系统临时目录，
   * 同样只给 app-server 一个 `localImage {path}`。**不碰 ~/.codex**。
   */
  private async imagePaths(images: ImageSource[]): Promise<string[]> {
    const paths: string[] = [];
    for (const image of images) {
      if (image.type === "file") {
        paths.push(image.path);
        continue;
      }
      const extension = extensionFor(image.contentType) ?? "img";
      const path = join(tmpdir(), `codex-image-${randomUUID()}.${extension}`);
      await writeFile(path, image.data);
      this.tempImages.push(path);
      paths.push(path);
    }
    return paths;
  }
}

function extensionFor(contentType: string): string | undefined {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return extname(contentType) || undefined;
  }
}

function exitDetail(exit: CodexProcessExit): string | undefined {
  const reason = nonEmpty(exit.reason);
  if (reason === undefined) return exit.status === 0 ? undefined : `退出码 ${exit.status}`;
  return clampLine(reason, STATUS_DETAIL_LIMIT);
}

function recordOf(thread: LiveThread, agentId: string): CodexTaskRecord {
  return {
    id: codexProtocolId(thread.threadId),
    agentId,
    source: "codex",
    title: thread.title,
    projectPath: thread.projectPath,
    projectName: thread.projectName,
    status: thread.status,
    lastMessage: thread.lastMessage,
    pendingRequest: thread.pendingRequest,
    origin: thread.origin,
    // 由本连接器实时驱动 = 四条命令都真的能执行。
    controllable: true,
    startedAt: protocolTimestamp(thread.startedAt),
    updatedAt: protocolTimestamp(thread.updatedAt),
    model: thread.model,
    effort: thread.effort,
    ...(thread.status === "failed" ? { diagnosis: thread.diagnosis } : {}),
  };
}

export function modelOptions(response: JSONValue): ModelOption[] {
  const models: ModelOption[] = [];
  for (const raw of jsonArray(jsonPath(response, "data")) ?? []) {
    if (jsonBool(jsonPath(raw, "hidden")) === true) continue;
    const id = jsonString(jsonPath(raw, "id"));
    if (id === undefined) continue;
    const efforts = (jsonArray(jsonPath(raw, "supportedReasoningEfforts")) ?? [])
      .map((effort) => jsonString(jsonPath(effort, "reasoningEffort")))
      .filter((effort): effort is string => effort !== undefined);
    models.push({
      id,
      displayName: jsonString(jsonPath(raw, "displayName")) ?? id,
      ...(efforts.length === 0 ? {} : { efforts }),
      ...(jsonString(jsonPath(raw, "defaultReasoningEffort")) === undefined
        ? {}
        : { defaultEffort: jsonString(jsonPath(raw, "defaultReasoningEffort")) }),
    });
  }
  return models;
}

/** 一个小工具：值是不是 JSON 对象（测试与共享桌面分支用）。 */
export function isJSONObject(value: JSONValue | undefined): value is { [key: string]: JSONValue } {
  return jsonObject(value) !== undefined;
}

export function codexProtocolId(threadId: string): string {
  return `codex:${threadId}`;
}

/** 从协议 id 取回原生 threadId。分发器给的一定带前缀，手工调用时不带也认。 */
export function codexNativeId(taskId: string): string {
  const prefix = "codex:";
  const native = taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
  if (native.length === 0 || native.includes(":")) throw new ConnectorError(`不是 Codex 的任务 id：${taskId}`);
  return native;
}

/** 生产装配用：探测可执行文件；找不到时给一个明确失败的 launcher，不静默起空壳。 */
export function detectedCodexLauncher(): CodexProcessLauncher {
  return {
    async launch(): Promise<never> {
      const paths = new CodexPaths();
      throw new CodexAppServerError("launchFailed", `电脑上找不到 Codex（${paths.codexHome}）`, {
        diagnosis: { kind: "agentNotInstalled" },
      });
    },
  };
}

export type { CodexAppServerConfiguration };
