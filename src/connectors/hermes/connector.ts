// Ported from botbus-protocol/Sources/BotBusConnectors/Hermes/HermesConnector.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// Hermes Agent（Nous Research）连接器：`hermes chat -q … --format stream-json` 负责"动手"。
// "看见"不在这里：桌面上的会话由观察者轮询 `state.db` 对账。本连接器只在**自己起的
// 那一轮**里认领实时所有权（`claimLive`），子进程一结束就写最终状态、`releaseLive`，
// 再催观察者 `onRunFinished` 马上读一轮。
//
// **审批做不了**：`-q` 模式没有审批通道，危险命令按 Hermes 自己的
// `approvals.single_query_mode`（默认 `deny`）处理。真正的审批要走 ACP，本期不做。
//
// **手机任务带上 agent 工具**：`-q` 不能临时挂 MCP，所以只注入三个 `BOTBUS_*` 环境
// 变量，说明文字用只讲 CLI 的那一版，经 `HERMES_EPHEMERAL_SYSTEM_PROMPT` 交给 Hermes。

import { randomUUID } from "node:crypto";
import { spawnSync, type ChildProcess } from "node:child_process";
import { spawnExecutable } from "../ported/spawn.js";
import { accessSync, constants as fsConstants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ConnectorError,
  nativeTaskId,
  rejectSelection,
  taskIdFor,
  type ConnectorHost,
  type ConnectorKind,
  type ConnectorOutcome,
  type FailureDiagnosis,
  type ImageSource,
  type ModelSelection,
  type TaskConnector,
} from "../ported/contract.js";
import {
  HermesStateReader,
  LAST_MESSAGE_LIMIT,
  TITLE_LIMIT,
  projectName,
  protocolTimestamp,
  truncate,
} from "./state-reader.js";
import {
  agentBinaryEnvironment,
  detectHermesBinary,
  hermesPaths,
  type HermesPaths,
} from "./paths.js";

const SESSION_ID_TIMEOUT_MS = 20_000;
const MAX_SESSIONS = 200;
const RELEASE_RETRY_DELAY_MS = 1_000;
const EPHEMERAL_PROMPT_VARIABLE = "HERMES_EPHEMERAL_SYSTEM_PROMPT";

// MARK: - agent 工具注入

export type AgentToolsConfiguration = {
  /** `botbus` CLI 的绝对路径。 */
  cliPath: string;
  /** `http://127.0.0.1:<port>`，本机工具服务器。 */
  toolsURL: string;
};

export type AgentToolsInjection = {
  token: string;
  /** 三个 `BOTBUS_*` 环境变量。 */
  environment: Record<string, string>;
  /** 只有 shell、没有 MCP 的 agent 用的说明文字。 */
  cliOnlyInstructions: string;
};

/** 与上游 `TaskContextRegistry` 对应的最小接口；测试可注入自己的实现。 */
export interface HermesTaskContextRegistry {
  tokenFor(taskId: string): string | undefined;
  issue(): string;
  bind(token: string, taskId: string): void;
}

export class InMemoryTaskContextRegistry implements HermesTaskContextRegistry {
  private readonly tokens = new Map<string, string>();

  tokenFor(taskId: string): string | undefined {
    return this.tokens.get(taskId);
  }

  issue(): string {
    return randomUUID();
  }

  bind(token: string, taskId: string): void {
    this.tokens.set(taskId, token);
  }
}

export function agentToolsConfigurationIsUsable(configuration: AgentToolsConfiguration): boolean {
  if (!configuration.toolsURL || !configuration.cliPath) return false;
  try {
    if (!statSync(configuration.cliPath).isFile()) return false;
    if (process.platform !== "win32") accessSync(configuration.cliPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 注入给 agent 的说明文字（上游 `AgentToolsInstructions.text(mcp: false)`）。
 * Hermes 的 `-q` 模式不能临时加 MCP，所以只提 CLI。
 */
export function agentToolsInstructions(cliPath: string): string {
  const intro =
    "This task was sent from the user's phone through BotBus. The user is not at this computer: they cannot see its screen or open localhost URLs. When you build or change something visual, share it";
  const tools = ` by running the \`botbus\` CLI at \`${cliPath}\` from your shell (\`--help\` lists everything):
- \`preview --port <port>\` for a running dev server, or \`preview --dir <dir>\` for static files (serves \`index.html\`). Background processes may be killed when your turn ends, so to run a dev server pass \`--cmd "<command>"\` (and \`--cwd <dir>\`) and BotBus will keep it running.
- \`share <file>\` for screenshots, images, videos or other files; \`link <url>\` for public URLs. Videos are compressed automatically.
`;
  return (
    intro +
    tools +
    "\n" +
    "Prefer relative URLs or the dev server's proxy over hard-coded `http://localhost:…` API URLs so the page works through the preview tunnel. Keep your final answer short; the user reads it on a phone."
  );
}

function makeInjection(
  configuration: AgentToolsConfiguration | null | undefined,
  registry: HermesTaskContextRegistry,
  reusing?: string,
): AgentToolsInjection | undefined {
  if (!configuration || !agentToolsConfigurationIsUsable(configuration)) return undefined;
  const existing = reusing === undefined ? undefined : registry.tokenFor(reusing);
  const token = existing ?? registry.issue();
  return {
    token,
    environment: {
      BOTBUS_TOOLS_URL: configuration.toolsURL,
      BOTBUS_TASK_TOKEN: token,
      BOTBUS_CLI: configuration.cliPath,
    },
    cliOnlyInstructions: agentToolsInstructions(configuration.cliPath),
  };
}

/** 注入的环境变量：三个 `BOTBUS_*` 加上给 Hermes 的一次性系统提示。没有注入就是空表。 */
export function injectedEnvironment(injection: AgentToolsInjection | undefined): Record<string, string> {
  if (!injection) return {};
  return {
    ...injection.environment,
    [EPHEMERAL_PROMPT_VARIABLE]: injection.cliOnlyInstructions,
  };
}

// MARK: - 子进程

/** 起一个 `hermes` 需要的全部信息。 */
export type HermesLaunchRequest = {
  executable: string;
  arguments: string[];
  workingDirectory: string;
  /** 完整环境（不是增量）。 */
  environment: Record<string, string>;
};

/** 一个跑着的 `hermes`。 */
export interface HermesRunningProcess {
  /** 让 Hermes 像在终端里按了 Ctrl-C 一样收尾。 */
  interrupt(): void;
  /** 停机或放弃这一轮时用。 */
  terminate(): void;
}

/**
 * 起子进程的方式。契约：`output` 按到达顺序送 stdout 的数据块；`exit` 恰好调一次，
 * 且在已读到的 stdout 都送完之后（进程退出码作参数）。
 */
export interface HermesProcessLauncher {
  launch(
    request: HermesLaunchRequest,
    output: (data: Buffer) => void,
    exit: (status: number) => void,
  ): HermesRunningProcess;
}

/**
 * 真的起子进程。stdin 接空设备（`-q` 不该读终端；万一它要确认什么，读到 EOF 也比
 * 永远挂着强），stderr 丢弃（不读的 Pipe 写满 64 KB 会把子进程卡死）。
 */
export class HermesSubprocessLauncher implements HermesProcessLauncher {
  /** 进程退出后最多再等 stdout 的 EOF 这么久；后台进程继承 stdout 时它永远不来。 */
  static readonly drainTimeout = 2_000;

  launch(
    request: HermesLaunchRequest,
    output: (data: Buffer) => void,
    exit: (status: number) => void,
  ): HermesRunningProcess {
    // PORT: 直接 spawn 可执行文件。Windows 上只有 `.cmd` / `.bat` 包装器才必须过 shell；
    // uv / pipx 装的 Hermes 是 `.exe`，走这条路径。真遇到脚本包装器时 spawn 会报错，
    // 由连接器如实回「起不了 hermes」，不为了"看起来能跑"把 prompt 拼进 shell 命令行。
    const child = spawnExecutable(request.executable, request.arguments, {
      cwd: request.workingDirectory,
      env: request.environment,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const stdout = child.stdout;
    let sawExit = false;
    let sawEOF = stdout === null;
    let fired = false;
    let status = 1;
    let drainTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (fired || !sawEOF) return;
      fired = true;
      if (drainTimer) clearTimeout(drainTimer);
      exit(status);
    };

    stdout?.on("data", (chunk: Buffer) => output(chunk));
    stdout?.on("end", () => {
      sawEOF = true;
      if (sawExit) finish();
    });
    stdout?.on("error", () => {
      sawEOF = true;
      if (sawExit) finish();
    });
    // spawn 失败时 Node 先发 'error' 再发 'close'（没有 'exit'）；下面的 close 兜底。
    child.on("error", () => {});
    child.on("exit", (code) => {
      sawExit = true;
      status = code ?? 1;
      if (sawEOF) {
        finish();
        return;
      }
      drainTimer = setTimeout(() => {
        sawEOF = true;
        try {
          stdout?.destroy();
        } catch {
          // 读端已经关了。
        }
        finish();
      }, HermesSubprocessLauncher.drainTimeout);
    });
    child.on("close", (code) => {
      if (sawExit) return;
      sawExit = true;
      sawEOF = true;
      status = code ?? 1;
      finish();
    });
    return new HermesSubprocess(child);
  }
}

class HermesSubprocess implements HermesRunningProcess {
  private readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
  }

  interrupt(): void {
    if (!this.isRunning()) return;
    const pid = this.child.pid;
    if (!pid) return;
    // PORT: Windows 没有信号，上游同样结束整棵进程树（taskkill /T /F）。
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    try {
      process.kill(pid, "SIGINT");
    } catch {
      // 进程已经没了。
    }
  }

  terminate(): void {
    if (!this.isRunning()) return;
    this.child.kill();
  }

  private isRunning(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }
}

// MARK: - stream-json

/**
 * 读 `hermes chat -q … --format stream-json` 的 stdout：一行一个 JSON 对象。
 *
 * 只关心三件事：
 * - `{"type":"system","subtype":"init","session_id":…}` —— 会话 id；
 * - `{"type":"text","text":…}` —— **增量**文本，遇到 `tool_use` / `tool_result` 就重新攒；
 * - `{"type":"result","session_id","exit_code","text","error"?}` —— 一轮结束。
 *
 * 其余类型忽略。解析全程容错：多一种没见过的行、一行坏 JSON，都不该让整轮白跑。
 */
export class HermesStreamReader {
  static readonly maxLineBytes = 8 << 20;

  private buffer = Buffer.alloc(0);
  private sessionID: string | undefined;
  private streamedText = "";
  private resultText: string | undefined;
  private sawResult = false;
  private resultFailed = false;
  private errorMessage: string | undefined;
  private finished = false;

  /** 喂一块 stdout。返回这一块里第一次出现的 session id。 */
  consume(data: Buffer | Uint8Array): string | undefined {
    if (this.finished) return undefined;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
    let found: string | undefined;
    let index = this.buffer.indexOf(0x0a);
    while (index >= 0) {
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      const id = this.handle(line);
      if (id !== undefined && found === undefined) found = id;
      index = this.buffer.indexOf(0x0a);
    }
    if (this.buffer.length > HermesStreamReader.maxLineBytes) this.buffer = Buffer.alloc(0);
    return found;
  }

  /** 进程退出：处理最后一行没带换行的残余，给出这一轮的结论。幂等。 */
  finish(exitStatus: number): HermesStreamResult {
    if (!this.finished && this.buffer.length > 0) {
      this.handle(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
    this.finished = true;
    const text =
      this.resultText !== undefined && this.resultText.trim() !== ""
        ? this.resultText
        : this.streamedText.trim() !== ""
          ? this.streamedText
          : undefined;
    const failed = this.resultFailed || !this.sawResult || exitStatus !== 0;
    let message = this.errorMessage;
    if (failed && message === undefined) {
      message = !this.sawResult
        ? `hermes 没有正常结束（退出码 ${exitStatus}）`
        : exitStatus !== 0
          ? `hermes 退出码 ${exitStatus}`
          : undefined;
    }
    return {
      sessionID: this.sessionID,
      lastText: text === undefined ? undefined : text.trim(),
      failed,
      errorMessage: message,
    };
  }

  private handle(line: Buffer): string | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const type = parsed.type;
    if (type === "system") {
      const subtype = parsed.subtype;
      if (subtype !== undefined && subtype !== null && subtype !== "init") return undefined;
      if (this.sessionID !== undefined) return undefined;
      const id = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
      if (!id) return undefined;
      this.sessionID = id;
      return id;
    }
    if (type === "text") {
      if (typeof parsed.text === "string") this.streamedText += parsed.text;
      return undefined;
    }
    if (type === "tool_use" || type === "tool_result") {
      this.streamedText = "";
      return undefined;
    }
    if (type === "result") {
      this.sawResult = true;
      if (typeof parsed.text === "string") this.resultText = parsed.text;
      const code = integerValue(parsed.exit_code);
      if (code !== undefined && code !== 0) this.resultFailed = true;
      const error = errorText(parsed.error);
      if (error !== undefined) {
        this.resultFailed = true;
        this.errorMessage = error;
      }
      // 极端情况下 init 没来、result 带了 id：也认。
      if (this.sessionID === undefined) {
        const id = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
        if (id) {
          this.sessionID = id;
          return id;
        }
      }
    }
    return undefined;
  }
}

export type HermesStreamResult = {
  sessionID?: string;
  lastText?: string;
  /** `result` 报了错、退出码非 0，或者根本没等到 `result`。 */
  failed: boolean;
  errorMessage?: string;
};

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

/** `error` 可能是字符串，也可能是 `{message: …}`；空串 / null / false 不算错。 */
function errorText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : undefined;
  }
  if (isRecord(value)) {
    const message = typeof value.message === "string" ? value.message.trim() : "";
    return message ? message : "hermes 报错";
  }
  return undefined;
}

// MARK: - 连接器

type Session = {
  sessionID: string;
  projectPath: string;
  title: string;
  status: string;
  origin: string;
  lastMessage?: string;
  startedAt: string;
  updatedAt: string;
};

type Run = {
  runID: string;
  process: HermesRunningProcess;
};

export type HermesConnectorOptions = {
  /** 每次读时现取；默认 `~/.hermes`。测试注入临时目录。 */
  paths?: () => HermesPaths;
  /** 默认按常见安装目录 + PATH 找 `hermes`。 */
  binary?: () => string | null | undefined;
  /** 测试注入假的，永远不跑真的 `hermes`。 */
  launcher?: HermesProcessLauncher;
  /** 启动前检查项目目录；返回诊断或 undefined。 */
  directoryProbe?: (path: string) => Promise<FailureDiagnosis | undefined>;
  now?: () => Date;
  /** 每次起子进程时现取；nil 或不可用 = 不注入 agent 工具。 */
  tools?: () => AgentToolsConfiguration | null | undefined;
  registry?: HermesTaskContextRegistry;
  /** 一轮结束、所有权交还之后调用（app 在这里催观察者读一轮）。 */
  onRunFinished?: () => void | Promise<void>;
  sessionIDTimeoutMs?: number;
  releaseRetryDelayMs?: number;
  /** 没有 cwd 的会话归到这个目录（与状态读取器一致）。 */
  fallbackDirectory?: string;
};

/**
 * 一个连接器实例对应一个宿主。`start` / `followUp` 在拿到 session id 时返回，
 * 不等待整轮结束；进展靠 `host.upsert` 表达。
 */
export class HermesConnector implements TaskConnector {
  readonly kind: ConnectorKind = "hermes";
  readonly runsUnderBotBus = true;

  private readonly host: ConnectorHost;
  private readonly paths: () => HermesPaths;
  private readonly binary: () => string | null | undefined;
  private readonly launcher: HermesProcessLauncher;
  private readonly directoryProbe: (path: string) => Promise<FailureDiagnosis | undefined>;
  private readonly now: () => Date;
  private readonly tools: () => AgentToolsConfiguration | null | undefined;
  private readonly registry: HermesTaskContextRegistry;
  private readonly onRunFinished: () => void | Promise<void>;
  private readonly sessionIDTimeoutMs: number;
  private readonly releaseRetryDelayMs: number;
  private readonly fallbackDirectory: string;

  private readonly sessions = new Map<string, Session>();
  /** session id → 正在跑的那一轮。桌面上用户自己开的会话不在这里。 */
  private readonly runs = new Map<string, Run>();
  /** 已经在起子进程、还没拿到 session id 的会话（续聊用）：挡住并发续聊。 */
  private readonly launching = new Set<string>();
  /** 子进程退出得比 `start` / `followUp` 登记这一轮还早时先存这里。 */
  private readonly earlyFinishes = new Map<string, HermesStreamResult>();
  /** 正在 `begin` 里登记的轮次。期间到达的 `finish` 先进 `earlyFinishes`。 */
  private readonly registering = new Set<string>();

  constructor(host: ConnectorHost, options: HermesConnectorOptions = {}) {
    this.host = host;
    this.paths = options.paths ?? (() => hermesPaths());
    this.binary = options.binary ?? (() => detectHermesBinary());
    this.launcher = options.launcher ?? new HermesSubprocessLauncher();
    this.directoryProbe = options.directoryProbe ?? liveDirectoryProbe;
    this.now = options.now ?? (() => new Date());
    this.tools = options.tools ?? (() => undefined);
    this.registry = options.registry ?? new InMemoryTaskContextRegistry();
    this.onRunFinished = options.onRunFinished ?? (() => {});
    this.sessionIDTimeoutMs = options.sessionIDTimeoutMs ?? SESSION_ID_TIMEOUT_MS;
    this.releaseRetryDelayMs = options.releaseRetryDelayMs ?? RELEASE_RETRY_DELAY_MS;
    this.fallbackDirectory = options.fallbackDirectory ?? homedir();
  }

  /** 停连接器：终止我们自己起的子进程。它们的退出照常走 `finish`。 */
  stop(): void {
    for (const run of this.runs.values()) run.process.terminate();
  }

  // MARK: - TaskConnector

  async start(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    rejectSelection(selection, "选模型");
    // 协议 2.9 的手机发图本期只接了 Codex 与 Claude；明说不支持。
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    const injection = makeInjection(this.tools(), this.registry);
    const runID = randomUUID();
    const { sessionID, process } = await this.run(
      runID,
      argumentsFor(prompt, projectPath, undefined),
      projectPath,
      injection,
    );
    const timestamp = this.timestamp();
    const session: Session = {
      sessionID,
      projectPath,
      title: HermesConnector.title(prompt, projectPath),
      status: "running",
      origin: "watch",
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    const stillRunning = await this.begin(session, runID, process, injection);
    return { taskId: sessionID, retainsLiveOwnership: stillRunning };
  }

  async followUp(
    taskId: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    rejectSelection(selection, "换模型");
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    const sessionID = nativeTaskId(taskId, "hermes");
    if (this.runs.has(sessionID) || this.launching.has(sessionID)) {
      throw new ConnectorError("这个会话还在跑，等这一轮结束再续聊");
    }
    // 第一个 await 之前就占位，否则两条并发续聊都能通过上面的检查。
    this.launching.add(sessionID);
    try {
      const existing = this.host.task(taskIdFor(sessionID, "hermes"));
      if (existing && existing.status === "running" && existing.origin === "desktop") {
        // 桌面上正开着的会话：`--resume` 会和它抢同一个会话。
        throw new ConnectorError("这个会话正在电脑上运行，等它停下再续聊");
      }
      const reader = new HermesStateReader({
        databasePath: join(this.paths().hermesHome, "state.db"),
        fallbackDirectory: this.fallbackDirectory,
        now: this.now,
      });
      const workingDirectory =
        reader.cwd(sessionID) ??
        this.sessions.get(sessionID)?.projectPath ??
        (existing && existing.projectPath.trim() ? existing.projectPath : undefined);
      if (!workingDirectory) throw new ConnectorError("找不到这个 Hermes 会话的项目目录");

      // 续聊沿用这条任务之前的 token。
      const injection = makeInjection(
        this.tools(),
        this.registry,
        taskIdFor(sessionID, "hermes"),
      );
      const runID = randomUUID();
      const { sessionID: newID, process } = await this.run(
        runID,
        argumentsFor(prompt, workingDirectory, sessionID),
        workingDirectory,
        injection,
      );

      const timestamp = this.timestamp();
      let session: Session;
      if (newID === sessionID) {
        // 同一个会话接着聊：标题、来源、开始时间都沿用，只把状态推回 running。
        const known = this.sessions.get(sessionID);
        session = {
          sessionID,
          projectPath: workingDirectory,
          title:
            known?.title ??
            existing?.title ??
            HermesConnector.title(prompt, workingDirectory),
          status: "running",
          origin: known?.origin ?? existing?.origin ?? "watch",
          ...((known?.lastMessage ?? existing?.lastMessage) === undefined
            ? {}
            : { lastMessage: (known?.lastMessage ?? existing?.lastMessage) as string }),
          startedAt: known?.startedAt ?? existing?.startedAt ?? timestamp,
          updatedAt: timestamp,
        };
      } else {
        // `--resume` 分出了新会话：当成手机上新开的一条，回执给新 id。
        session = {
          sessionID: newID,
          projectPath: workingDirectory,
          title: HermesConnector.title(prompt, workingDirectory),
          status: "running",
          origin: "watch",
          startedAt: timestamp,
          updatedAt: timestamp,
        };
      }
      const stillRunning = await this.begin(session, runID, process, injection);
      return { taskId: newID, retainsLiveOwnership: stillRunning };
    } finally {
      this.launching.delete(sessionID);
    }
  }

  async approve(
    _taskId: string,
    _requestId: string,
    _decision: "allow" | "deny",
    _answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome> {
    throw new ConnectorError(
      "Hermes 的 -q 模式没有审批通道：危险命令会按它自己的 approvals.single_query_mode 处理，请在电脑上操作",
    );
  }

  async interrupt(taskId: string): Promise<ConnectorOutcome> {
    const sessionID = nativeTaskId(taskId, "hermes");
    const run = this.runs.get(sessionID);
    if (!run) {
      // 桌面上用户自己开的会话不是我们的子进程，发不了信号。
      throw new ConnectorError("这个会话是在电脑上启动的，只能在电脑上中断");
    }
    run.process.interrupt();
    const session = this.sessions.get(sessionID);
    if (session) {
      session.status = "interrupted";
      session.updatedAt = this.timestamp();
      this.sessions.set(sessionID, session);
      this.host.upsert(this.record(session));
    }
    // 所有权仍由这一轮持有，等子进程真的退出（`finish`）再交还。
    return { taskId: sessionID, retainsLiveOwnership: true };
  }

  /** 上游 `TaskConnector` 的默认实现：Hermes 没有归档动作。 */
  async deleteTask(_taskId: string): Promise<void> {
    throw new ConnectorError("这个 Agent 不支持删除电脑端会话");
  }

  /** 上游 `TaskConnector` 的默认实现：什么都不做。 */
  async discard(_taskId: string): Promise<void> {}

  // MARK: - 一轮的开始与结束

  /**
   * 登记这一轮：认领所有权、推 running、绑 token。子进程若已经抢先退出，登记完再收尾。
   * 返回这一轮是否还在跑；已经跑完时不交还所有权（分发器会自己 claim 再 release）。
   */
  private async begin(
    session: Session,
    runID: string,
    process: HermesRunningProcess,
    injection: AgentToolsInjection | undefined,
  ): Promise<boolean> {
    const id = taskIdFor(session.sessionID, "hermes");
    this.sessions.set(session.sessionID, session);
    this.runs.set(session.sessionID, { runID, process });
    this.registering.add(runID);
    this.pruneIfNeeded();
    this.host.claimLive(id);
    this.host.upsert(this.record(this.sessions.get(session.sessionID) ?? session));
    if (injection) this.registry.bind(injection.token, id);
    this.registering.delete(runID);
    const early = this.earlyFinishes.get(runID);
    if (early) {
      this.earlyFinishes.delete(runID);
      await this.finish(runID, early, false);
      return false;
    }
    return true;
  }

  /** 子进程退出后的收尾：写最终状态（被 interrupt 标过的不改回 completed）、交还所有权、催观察者。 */
  private async finish(runID: string, result: HermesStreamResult, releasing = true): Promise<void> {
    const sessionID = result.sessionID;
    if (sessionID === undefined) return;
    if (this.registering.has(runID)) {
      this.earlyFinishes.set(runID, result);
      return;
    }
    const run = this.runs.get(sessionID);
    const session = this.sessions.get(sessionID);
    if (!run || run.runID !== runID || !session) {
      // 还没登记（`begin` 会来取），或者属于早已被替换掉的一轮（直接丢弃）。
      if (this.runs.get(sessionID)?.runID !== runID) this.earlyFinishes.set(runID, result);
      return;
    }
    this.runs.delete(sessionID);
    if (session.status !== "interrupted") {
      session.status = result.failed ? "failed" : "completed";
    }
    const trimmedLast = result.lastText?.trim();
    const trimmedError = result.errorMessage?.trim();
    const text =
      trimmedLast !== undefined && trimmedLast !== ""
        ? trimmedLast
        : result.failed && trimmedError
          ? trimmedError
          : undefined;
    if (text !== undefined) session.lastMessage = truncate(text, LAST_MESSAGE_LIMIT);
    session.updatedAt = this.timestamp();
    this.sessions.set(sessionID, session);
    this.host.upsert(this.record(session));
    if (releasing) {
      const id = taskIdFor(sessionID, "hermes");
      this.host.releaseLive(id);
      // 兜底（同 Pi）：分发器在命令返回**之后**才 claim；这一轮若恰好在空当里结束，
      // 这次 release 会先于那次 claim。过一会儿再放一次；期间若已有新一轮在跑就不动。
      const timer = setTimeout(() => this.releaseIfIdle(sessionID, id), this.releaseRetryDelayMs);
      timer.unref?.();
    }
    await this.onRunFinished();
  }

  private releaseIfIdle(sessionID: string, taskId: string): void {
    if (this.runs.has(sessionID) || this.launching.has(sessionID)) return;
    this.host.releaseLive(taskId);
  }

  private record(session: Session): {
    id: string;
    agentId: string;
    source: string;
    title: string;
    projectPath: string;
    projectName: string;
    status: string;
    lastMessage?: string;
    origin: string;
    controllable: boolean;
    startedAt: string;
    updatedAt: string;
  } {
    return {
      id: taskIdFor(session.sessionID, "hermes"),
      agentId: this.host.agentId,
      source: "hermes",
      title: session.title,
      projectPath: session.projectPath,
      projectName: projectName(session.projectPath),
      status: session.status,
      ...(session.lastMessage === undefined ? {} : { lastMessage: session.lastMessage }),
      origin: session.origin,
      // 自己起的这一轮能中断、跑完能续聊，所以一律可控；桌面上正在跑的由观察者标成不可控。
      controllable: true,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    };
  }

  private pruneIfNeeded(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    const doomed = [...this.sessions.values()]
      .filter((session) => !this.runs.has(session.sessionID))
      .sort((left, right) => (left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0))
      .slice(0, this.sessions.size - MAX_SESSIONS);
    for (const session of doomed) this.sessions.delete(session.sessionID);
  }

  static title(prompt: string, projectPath: string): string {
    const title = truncate(HermesStateReader.singleLine(prompt), TITLE_LIMIT);
    if (title) return title;
    const name = projectName(projectPath);
    return name ? name : "Hermes 会话";
  }

  private timestamp(): string {
    return protocolTimestamp(this.now());
  }

  // MARK: - 子进程启动

  /**
   * 起一个 `hermes chat -q …` 并**只等到 session id 出现就返回**；剩下的输出在后台
   * 接着读，用来把任务推进到结束。
   */
  private async run(
    runID: string,
    args: string[],
    workingDirectory: string,
    injection: AgentToolsInjection | undefined,
  ): Promise<{ sessionID: string; process: HermesRunningProcess }> {
    const executable = this.binary();
    if (!executable) {
      throw new ConnectorError("本机没找到 hermes 可执行文件", {
        diagnosis: { kind: "agentNotInstalled" },
      });
    }
    const diagnosis = await this.directoryProbe(workingDirectory);
    if (diagnosis) {
      throw new ConnectorError(
        diagnosis.kind === "folderAccessDenied"
          ? `BotBus 没有权限读取项目目录：${workingDirectory}`
          : `项目目录不存在：${workingDirectory}`,
        { diagnosis },
      );
    }

    const request: HermesLaunchRequest = {
      executable,
      arguments: args,
      workingDirectory,
      // Hermes 装在 uv / pipx 的 bin 目录里，GUI 进程的 PATH 未必有它的依赖。
      environment: agentBinaryEnvironment(
        executable,
        injectedEnvironment(injection),
        process.env,
      ),
    };

    const parser = new HermesStreamReader();
    let settled = false;
    let resolveID: (id: string) => void = () => {};
    let rejectID: (error: unknown) => void = () => {};
    const idPromise = new Promise<string>((resolve, reject) => {
      resolveID = (id) => {
        if (settled) return;
        settled = true;
        resolve(id);
      };
      rejectID = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });

    let running: HermesRunningProcess;
    try {
      running = this.launcher.launch(
        request,
        (data) => {
          const id = parser.consume(data);
          if (id !== undefined) resolveID(id);
        },
        (status) => {
          const result = parser.finish(status);
          // 一行 init 都没吐出来就退了：别让调用方一直等到超时。
          rejectID(
            new ConnectorError(
              result.errorMessage
                ? `hermes 退出了，没有拿到 session id：${result.errorMessage}`
                : "hermes 退出了，没有拿到 session id",
            ),
          );
          void this.finish(runID, result);
        },
      );
    } catch (error) {
      throw new ConnectorError(
        `起不了 hermes：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectorError("等 hermes 回应超时")), this.sessionIDTimeoutMs);
      timer.unref?.();
    });
    try {
      const sessionID = await Promise.race([idPromise, timeout]);
      return { sessionID, process: running };
    } catch (error) {
      // 没拿到 id 的一轮没人认领，也没法再中断：别让它在后台接着跑。
      running.terminate();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** `hermes` 的完整参数：`chat -q <prompt> --format stream-json --in <目录> [--resume <id>]`。 */
export function argumentsFor(
  prompt: string,
  projectPath: string,
  resuming?: string,
): string[] {
  const args = ["chat", "-q", prompt, "--format", "stream-json", "--in", projectPath];
  if (resuming !== undefined) args.push("--resume", resuming);
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 默认目录探测：不存在 → projectMissing；被系统/文件权限挡住 → folderAccessDenied。 */
async function liveDirectoryProbe(path: string): Promise<FailureDiagnosis | undefined> {
  if (!path) return undefined;
  try {
    readdirSync(path);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "projectMissing" };
    if (code === "EPERM") return { kind: "folderAccessDenied", folder: folderFor(path) };
    if (code === "EACCES") return { kind: "folderAccessDenied" };
    return undefined;
  }
}

function folderFor(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const home = homedir().replace(/\\/g, "/");
  const under = (base: string) => normalized === base || normalized.startsWith(`${base}/`);
  if (under(`${home}/Desktop`)) return "desktop";
  if (under(`${home}/Documents`)) return "documents";
  if (under(`${home}/Downloads`)) return "downloads";
  if (under(`${home}/Library/Mobile Documents`)) return "iCloudDrive";
  return "other";
}
