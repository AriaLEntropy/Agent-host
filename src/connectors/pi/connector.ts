/**
 * Ported from botbus-protocol/Sources/BotBusConnectors/Pi/PiConnector.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * Pi 连接器：会话 JSONL 由 `PiSessionSource` 负责"看见"，本连接器只负责"动手"——
 * `start` / `followUp` 各起一个 `pi --mode json` 子进程，一轮跑完就退出。
 *
 * **所有权只在自己那一轮里拿着**：session id 一到手就 `claimLive`，子进程结束写完最终状态后
 * `releaseLive`，交还观察者，再调 `onRunFinished` 催观察者立刻读一轮。Pi 有观察者，
 * 桌面上的会话归它管，我们不该长期挡着它。
 *
 * Pi 没有审批，也没有 MCP：手机任务只注入 `BOTBUS_*` 环境变量与 `--append-system-prompt`
 * 的 CLI 版说明文字（`cliOnlyInstructions`），让 agent 在 shell 里调 `botbus`。
 */
import { spawnSync, type ChildProcessByStdio } from "node:child_process";
import { spawnExecutable } from "../ported/spawn.js";
import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { BusTask } from "../../bus/store.js";
import type {
  ConnectorHost,
  ConnectorKind,
  ConnectorOutcome,
  FailureDiagnosis,
  ImageSource,
  ModelSelection,
  TaskConnector,
} from "../ported/contract.js";
import { ConnectorError, nativeTaskId, rejectSelection, taskIdFor } from "../ported/contract.js";
import type { PiPaths } from "./session-reader.js";
import {
  PI_LAST_MESSAGE_LIMIT,
  PI_TITLE_LIMIT,
  PiSessionFile,
  PiSessionReader,
  detectPiBinary,
  isoFromMs,
  parsePiMessage,
  piPaths,
  projectName,
  singleLine,
  truncate,
} from "./session-reader.js";

/** 等首行 header（里面才有 session id）的上限。命令回执只表示"已接受"，不该为它等一整轮。 */
export const PI_SESSION_ID_TIMEOUT_MS = 20_000;
/** 收尾后隔多久再补一次 `releaseLive`，见 `complete`。 */
export const PI_RELEASE_RETRY_DELAY_MS = 1_000;

/** `AgentToolsConfiguration` 在 Agent-host 侧的等价物。 */
export type PiToolsConfiguration = {
  /** 嵌在 app 里的 `botbus` CLI 绝对路径。 */
  cliPath: string;
  /** `http://127.0.0.1:<port>`，本机工具服务器。 */
  toolsURL: string;
};

/** 一次注入的全部内容：配置 + 这条任务的 token。 */
export type PiToolsInjection = {
  configuration: PiToolsConfiguration;
  token: string;
  environment: Record<string, string>;
  cliOnlyInstructions: string;
};

export type PiConnectorOptions = {
  /** 每次现取路径；测试注入临时目录，避免碰真实的 ~/.pi。 */
  paths?: () => PiPaths;
  /** 每次起子进程时现取可执行文件。 */
  binary?: () => string | undefined;
  /** 测试注入假的，永远不起真实 `pi`。 */
  launcher?: PiProcessLauncher;
  /** 每次起子进程时现取；nil 或不可用 = 不注入 agent 工具。 */
  tools?: () => PiToolsConfiguration | undefined;
  /** 签发 task token；默认 randomUUID。 */
  issueToken?: () => string;
  /** 起 `pi` 之前看一眼工作目录（协议 3.7）。 */
  directoryProbe?: (path: string) => FailureDiagnosis | undefined | Promise<FailureDiagnosis | undefined>;
  /** 一轮结束、所有权交还之后调用；app 用它催 `SessionObserver.pollOnce()`。 */
  onRunFinished?: () => void | Promise<void>;
  sessionIdTimeoutMs?: number;
  releaseRetryDelayMs?: number;
};

export type PiConnector = TaskConnector & {
  /** 停连接器：终止我们自己起的子进程，并把它们标成 interrupted。 */
  stop(): void;
};

type Launch = {
  handle?: PiProcessHandle;
  sessionID?: string;
  /**
   * `start` / `followUp` 已经写完 running 状态。在此之前到达的结束只记下，由它们收尾——
   * 否则结束先写 completed、随后的 running 反把它盖掉，任务就永远停在"运行中"。
   */
  ready: boolean;
  result?: PiJSONStreamResult;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

/** 一次性的等待盒子：两条路径可能同时来（header 与进程退出），只有第一次作数。 */
function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

export function createPiConnector(host: ConnectorHost, options: PiConnectorOptions = {}): PiConnector {
  const paths = options.paths ?? (() => piPaths());
  const binary = options.binary ?? (() => detectPiBinary());
  const launcher = options.launcher ?? new PiSubprocessLauncher();
  const tools = options.tools ?? (() => undefined);
  const issueToken = options.issueToken ?? (() => randomUUID());
  const directoryProbe = options.directoryProbe ?? (async () => undefined);
  const onRunFinished = options.onRunFinished ?? (() => undefined);
  const sessionIdTimeoutMs = options.sessionIdTimeoutMs ?? PI_SESSION_ID_TIMEOUT_MS;
  const releaseRetryDelayMs = options.releaseRetryDelayMs ?? PI_RELEASE_RETRY_DELAY_MS;

  /** 以启动为单位记账而不是以 session 为单位：id 要等首行才知道。 */
  const launches = new Map<string, Launch>();
  /** 正在跑的那一轮：sessionId → 启动。`interrupt` 与"正在运行不能续聊"都看它。 */
  const active = new Map<string, string>();
  /** 已经在起子进程、还没拿到 header 的续聊：挡住同一会话的并发续聊。 */
  const launching = new Set<string>();
  /** 我们驱动过的任务的最新记录，收尾时在它上面改状态。 */
  const records = new Map<string, BusTask>();
  /** 已签发的 task token，续聊时沿用。对应上游 `TaskContextRegistry`。 */
  const tokens = new Map<string, string>();

  async function makeInjection(reusingTaskId?: string): Promise<PiToolsInjection | undefined> {
    const configuration = tools();
    if (!isUsableTools(configuration)) return undefined;
    let token = reusingTaskId ? tokens.get(reusingTaskId) : undefined;
    if (!token) token = issueToken();
    if (!token) return undefined;
    return {
      configuration,
      token,
      environment: {
        BOTBUS_TOOLS_URL: configuration.toolsURL,
        BOTBUS_TASK_TOKEN: token,
        BOTBUS_CLI: configuration.cliPath,
      },
      cliOnlyInstructions: agentToolsInstructions(configuration.cliPath),
    };
  }

  function bindInjection(injection: PiToolsInjection | undefined, taskId: string): void {
    if (injection) tokens.set(taskId, injection.token);
  }

  async function checkDirectory(path: string): Promise<void> {
    const missing = { kind: "projectMissing", folder: path } satisfies FailureDiagnosis;
    if (!path) throw new ConnectorError("项目目录不存在", { diagnosis: missing });
    const diagnosis = await directoryProbe(path);
    if (diagnosis) throw new ConnectorError(`项目目录不可用：${path}`, { diagnosis });
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new ConnectorError(`项目目录不存在：${path}`, { diagnosis: missing });
    }
    if (!info.isDirectory()) {
      // 探测同一目录还有读取没回来、或超时时回 nil（不下结论）：至少不能在不存在的目录里起进程。
      throw new ConnectorError(`项目目录不存在：${path}`, { diagnosis: missing });
    }
  }

  /**
   * 起一个 `pi --mode json …` 并**只等到首行 header 出现就返回**。剩下的输出在后台接着读，
   * 结束时经 `runFinished` 收尾——一轮可能跑几分钟，不能让命令回执挂在那里。
   */
  async function launch(
    argumentsList: string[],
    workingDirectory: string,
    injection: PiToolsInjection | undefined,
  ): Promise<[string, string]> {
    const executable = binary();
    if (!executable) throw new ConnectorError("本机没找到 pi 可执行文件");
    const launchID = randomUUID();
    const sessionID = deferred<string>();
    // 进程可能在 `awaitSessionID` 之前就退出并 reject 这个盒子；先挂一个消费者免得成为未处理拒绝。
    sessionID.promise.catch(() => undefined);

    const reader = new PiJSONStreamReader();
    reader.onSessionID = (id) => sessionID.resolve(id);
    reader.onFinished = (result) => {
      void runFinished(launchID, result);
    };

    const request: PiLaunchRequest = {
      executable,
      arguments: argumentsList,
      workingDirectory,
      // pi 是 `#!/usr/bin/env node` 脚本：可执行文件所在目录要补到 PATH 最前。
      environment: piEnvironment(executable, injection?.environment ?? {}),
    };

    // 先登记再起进程：输出可能在 `launcher.launch` 的 await 期间就到达，runFinished 要能找到这条记录。
    const entry: Launch = { ready: false };
    launches.set(launchID, entry);
    try {
      entry.handle = await launcher.launch(
        request,
        (chunk) => reader.consume(chunk),
        (status) => {
          // 一行 header 都没吐出来就退了：别让调用方一直等到超时。
          sessionID.reject(new ConnectorError(`pi 退出了，没有拿到会话 id（退出码 ${status}）`));
          reader.finish(status);
        },
      );
    } catch (error) {
      launches.delete(launchID);
      throw new ConnectorError(`起不了 pi：${error instanceof Error ? error.message : String(error)}`);
    }

    let id: string;
    try {
      id = await awaitSessionID(sessionID, sessionIdTimeoutMs);
    } catch (error) {
      // 超时或提前退出：进程若还活着就别留一个没人认领的孤儿。
      entry.handle?.terminate();
      launches.delete(launchID);
      throw error;
    }
    entry.sessionID = id;
    active.set(id, launchID);
    return [launchID, id];
  }

  async function awaitSessionID(box: Deferred<string>, timeoutMs: number): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectorError("等 pi 回应超时")), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([box.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 写 running 状态并认领所有权。返回这一轮是否还在跑：已经跑完（结束在登记完成前到达）时
   * 在这里就地收尾，但**不交还**所有权——分发器拿到 `retainsLiveOwnership: false` 后会自己
   * claim 再 release，我们先 release 的话分发器随后那一手 claim 就再也没人放了。
   */
  async function markRunning(record: BusTask, launchID: string): Promise<boolean> {
    const sessionID = record.id.startsWith("pi:") ? record.id.slice("pi:".length) : record.id;
    records.set(sessionID, record);
    host.claimLive(record.id);
    host.upsert(record);
    const entry = launches.get(launchID);
    if (!entry) return false;
    entry.ready = true;
    if (!entry.result) return true;
    await complete(launchID, false);
    return false;
  }

  /** 后台读完一轮（或进程退出）。`start` / `followUp` 还没写完 running 时只记下结果。 */
  async function runFinished(launchID: string, result: PiJSONStreamResult): Promise<void> {
    const entry = launches.get(launchID);
    if (!entry || entry.result) return;
    entry.result = result;
    if (!entry.ready) return;
    await complete(launchID, true);
  }

  async function releaseIfIdle(sessionID: string, taskId: string): Promise<void> {
    if (active.has(sessionID)) return;
    host.releaseLive(taskId);
  }

  /** 写最终状态 → 交还所有权 → 催观察者。 */
  async function complete(launchID: string, releasing: boolean): Promise<void> {
    const entry = launches.get(launchID);
    if (!entry) return;
    launches.delete(launchID);
    const result = entry.result;
    const sessionID = entry.sessionID;
    if (!result || !sessionID) return;
    if (active.get(sessionID) === launchID) active.delete(sessionID);
    const record = records.get(sessionID);
    if (!record) return;

    // 已经被 interrupt / stop 标过的不要被"进程退出"改回 completed 或 failed。
    if (record.status !== "interrupted") {
      record.status = result.failed ? "failed" : result.aborted ? "interrupted" : "completed";
    }
    const text = result.lastText?.trim();
    if (text) {
      record.lastMessage = truncate(text, PI_LAST_MESSAGE_LIMIT);
    } else if (result.failed && result.errorMessage?.trim()) {
      // 出错的一轮往往没有正文：把 pi 给的错误原因放上去，手机上至少知道为什么失败。
      record.lastMessage = truncate(result.errorMessage, PI_LAST_MESSAGE_LIMIT);
    }
    record.pendingRequest = undefined;
    record.updatedAt = host.now();
    records.set(sessionID, record);
    host.upsert(record);

    // 写状态的空当里可能已经有新一轮续聊起来了：那一轮自己拿着所有权，这里不能替它放掉。
    if (releasing && !active.has(sessionID)) {
      host.releaseLive(record.id);
      // 兜底：分发器在 `start` 返回**之后**才 claim 一次。这一轮若恰好在"回执已返回、
      // 分发器还没 claim"的空当里结束，我们这次 release 会先于那次 claim。过一会儿再放一次；
      // 期间若已有新一轮在跑就不动（它自己拿着所有权）。
      const taskId = record.id;
      const timer = setTimeout(() => {
        void releaseIfIdle(sessionID, taskId);
      }, releaseRetryDelayMs);
      timer.unref?.();
    }

    await onRunFinished();
  }

  async function start(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    // 协议 2.9 的手机发图本期只接了 Codex 与 Claude；明说不支持，别只发文字让用户以为 agent 看过图。
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    rejectSelection(selection, "换模型");
    await checkDirectory(projectPath);
    const injection = await makeInjection();
    const [launchID, sessionID] = await launch(
      piArguments(prompt, undefined, injection),
      projectPath,
      injection,
    );
    const taskId = taskIdFor(sessionID, "pi");
    const timestamp = host.now();
    const name = projectName(projectPath);
    const title = truncate(singleLine(prompt), PI_TITLE_LIMIT);
    const record: BusTask = {
      id: taskId,
      agentId: host.agentId,
      source: "pi",
      title: title || (name || "Pi 会话"),
      projectPath,
      projectName: name,
      status: "running",
      origin: "watch",
      // 自己起的这一轮能中断、结束后能续聊。
      controllable: true,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    bindInjection(injection, taskId);
    const stillRunning = await markRunning(record, launchID);
    return { taskId, retainsLiveOwnership: stillRunning };
  }

  async function followUp(
    taskId: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome> {
    if (images.length > 0) throw new ConnectorError("这个 Agent 暂不支持发图");
    rejectSelection(selection, "换模型");
    const sessionID = nativeTaskId(taskId, "pi");
    if (active.has(sessionID) || launching.has(sessionID)) {
      throw new ConnectorError("这个会话正在运行，等它这一轮结束再续聊");
    }
    // 第一个 await 之前就占位：`active` 要等 header 到了才写，中间最多 20 秒，
    // 手机和手表同时发的两条续聊会各起一个 pi 往同一份 JSONL 里追加。
    launching.add(sessionID);
    try {
      const existingTask = host.task(taskIdFor(sessionID, "pi"));
      if (existingTask?.status === "running" && existingTask.origin === "desktop") {
        // 电脑上正开着的会话不是我们的进程：再起一个 `--session` 会和它抢着写同一个文件。
        throw new ConnectorError("这个会话正在电脑上运行，等它停下再续聊");
      }
      const file = await new PiSessionReader({ paths: paths() }).sessionFile(sessionID);
      if (!file) throw new ConnectorError("找不到这个 Pi 会话的记录文件");
      // 没有 `--cwd`：子进程的工作目录就是会话的 cwd，以 header 为准（目录名反解不回路径）。
      const header = await PiSessionFile.headerAtPath(file);
      if (!header) throw new ConnectorError("这个 Pi 会话的记录文件认不出来");
      await checkDirectory(header.cwd);

      // 续聊沿用这条任务之前的 token（agent 若把它记在了别处也照样有效）。
      const injection = await makeInjection(taskIdFor(sessionID, "pi"));
      // 只传绝对路径：传 id 若命中别的项目，pi 会弹"fork 到当前目录？"的确认，子进程就卡死了。
      const [launchID, resolvedID] = await launch(
        piArguments(prompt, file, injection),
        header.cwd,
        injection,
      );
      const resultingTaskId = taskIdFor(resolvedID, "pi");
      bindInjection(injection, resultingTaskId);

      const timestamp = host.now();
      const existing = host.task(resultingTaskId);
      const record: BusTask = existing ??
        records.get(resolvedID) ?? {
          id: resultingTaskId,
          agentId: host.agentId,
          source: "pi",
          title: truncate(singleLine(prompt), PI_TITLE_LIMIT),
          projectPath: header.cwd,
          projectName: projectName(header.cwd),
          status: "running",
          origin: "watch",
          controllable: true,
          startedAt: header.timestamp !== undefined ? isoFromMs(header.timestamp) : timestamp,
          updatedAt: timestamp,
        };
      record.status = "running";
      record.pendingRequest = undefined;
      record.controllable = true;
      record.updatedAt = timestamp;
      const stillRunning = await markRunning(record, launchID);
      return { taskId: resultingTaskId, retainsLiveOwnership: stillRunning };
    } finally {
      launching.delete(sessionID);
    }
  }

  async function approve(
    _taskId: string,
    _requestId: string,
    _decision: "allow" | "deny",
    _answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome> {
    throw new ConnectorError("Pi 没有审批机制，工具调用不需要批准");
  }

  async function interrupt(taskId: string): Promise<ConnectorOutcome> {
    const sessionID = nativeTaskId(taskId, "pi");
    const launchID = active.get(sessionID);
    const entry = launchID !== undefined ? launches.get(launchID) : undefined;
    if (launchID === undefined || !entry?.handle) {
      // 桌面上用户自己开的会话不是我们的子进程，发不了信号。
      throw new ConnectorError("这个会话是在电脑上启动的，只能在电脑上中断");
    }
    entry.handle.interrupt();
    const record = records.get(sessionID);
    if (record) {
      record.status = "interrupted";
      record.updatedAt = host.now();
      records.set(sessionID, record);
      host.upsert(record);
    }
    // 子进程退出时由收尾交还所有权。
    return { taskId: taskIdFor(sessionID, "pi"), retainsLiveOwnership: true };
  }

  function stop(): void {
    // 先把它们标成 interrupted，随后到达的"进程退出"不会把它们改成 failed。
    for (const sessionID of active.keys()) {
      const record = records.get(sessionID);
      if (record) record.status = "interrupted";
    }
    for (const entry of launches.values()) entry.handle?.terminate();
  }

  const kind: ConnectorKind = "pi";
  return {
    kind,
    runsUnderBotBus: true,
    start,
    followUp,
    approve,
    interrupt,
    stop,
  };
}

/** `pi` 的完整参数：`--mode json [--session <绝对路径>] [--append-system-prompt <说明>] <prompt>`。 */
export function piArguments(
  prompt: string,
  sessionFile: string | undefined,
  injection: PiToolsInjection | undefined,
): string[] {
  const argumentsList = ["--mode", "json"];
  if (sessionFile) argumentsList.push("--session", sessionFile);
  if (injection) argumentsList.push("--append-system-prompt", injection.cliOnlyInstructions);
  // prompt 以 `-` 或 `@` 开头时前面垫一个空格：pi 会把 `-x` 当成选项、把 `@路径` 当成要附带的文件。
  argumentsList.push(prompt.startsWith("-") || prompt.startsWith("@") ? ` ${prompt}` : prompt);
  return argumentsList;
}

/**
 * 子进程环境：继承本进程，把可执行文件所在目录（以及它软链接指向的目录）放到 PATH 最前，
 * 再叠上 `extra`。Pi 是 `#!/usr/bin/env node` 脚本，GUI 进程的 PATH 里找不到 node。
 */
export function piEnvironment(
  executable: string,
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  const directories = [dirname(executable)];
  try {
    const resolvedDirectory = dirname(realpathSync(executable));
    if (!directories.includes(resolvedDirectory)) directories.push(resolvedDirectory);
  } catch {
    // 软链接解析失败就用原目录。
  }
  // Windows 上环境变量的实际键名可能是 `Path`，按大小写不敏感找。
  const key = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const existing = (environment[key] ?? "").split(delimiter).filter(Boolean);
  environment[key] = [
    ...directories,
    ...existing.filter((directory) => !directories.includes(directory)),
  ].join(delimiter);
  return { ...environment, ...extra };
}

function isUsableTools(
  configuration: PiToolsConfiguration | undefined,
): configuration is PiToolsConfiguration {
  if (!configuration || !configuration.toolsURL || !configuration.cliPath) return false;
  try {
    accessSync(configuration.cliPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 只有 shell、没有 MCP 的 agent（Pi）用这一份说明文字。对应 `AgentToolsInstructions.text(mcp: false)`。 */
export function agentToolsInstructions(cliPath: string): string {
  const intro =
    "This task was sent from the user's phone through BotBus. The user is not at this computer: they cannot see its screen or open localhost URLs. When you build or change something visual, share it";
  const tools = ` with the \`botbus\` CLI at \`${cliPath}\` from your shell (\`--help\` lists everything):
- \`preview --port <port>\` for a running dev server, or \`preview --dir <dir>\` for static files (serves \`index.html\`). Background processes may be killed when your turn ends, so to run a dev server pass \`--cmd "<command>"\` (and \`--cwd <dir>\`) and BotBus will keep it running.
- \`share <file>\` for screenshots, images, videos or other files; \`link <url>\` for public URLs. Videos are compressed automatically.`;
  const footer =
    "Prefer relative URLs or the dev server's proxy over hard-coded `http://localhost:…` API URLs so the page works through the preview tunnel. Keep your final answer short; the user reads it on a phone.";
  return `${intro}${tools}\n${footer}`;
}

// MARK: - 进程抽象

/** 起一个 `pi` 子进程需要的全部。 */
export type PiLaunchRequest = {
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
};

/** 一个跑着的 `pi`。只需要两种信号：中断这一轮、停机时终止。 */
export interface PiProcessHandle {
  /** SIGINT（Windows 上是结束整棵进程树）：pi 把当前轮次标成 aborted 然后退出。 */
  interrupt(): void;
  terminate(): void;
}

/** 可替换的启动器：生产用 `PiSubprocessLauncher`，测试注入假的，全套测试不起真实进程。 */
export interface PiProcessLauncher {
  /**
   * - `onOutput`：stdout 的原始字节块（不保证按行切）。
   * - `onExit`：进程退出**且** stdout 读完之后调用一次，参数是退出码。
   */
  launch(
    request: PiLaunchRequest,
    onOutput: (chunk: Buffer) => void,
    onExit: (status: number) => void,
  ): PiProcessHandle | Promise<PiProcessHandle>;
}

export class PiSubprocessLauncher implements PiProcessLauncher {
  async launch(
    request: PiLaunchRequest,
    onOutput: (chunk: Buffer) => void,
    onExit: (status: number) => void,
  ): Promise<PiProcessHandle> {
    const subprocess = new PiSubprocess(request, onOutput, onExit);
    await subprocess.waitUntilStarted();
    return subprocess;
  }
}

/**
 * 真实的 `pi` 子进程。退出与 stdout 的 EOF 是两条独立的回调，谁先到都有可能；
 * 两样都到了才报 `onExit`，否则最后几行（`message_end` / `agent_settled`）会在收尾之后才到，白读了。
 */
export class PiSubprocess implements PiProcessHandle {
  private readonly child: ChildProcessByStdio<null, Readable, null>;
  private readonly ready: Promise<void>;
  private readonly onExit: (status: number) => void;
  private exitStatus: number | undefined;
  private reachedEOF = false;
  private reported = false;
  private running = true;

  constructor(
    request: PiLaunchRequest,
    onOutput: (chunk: Buffer) => void,
    onExit: (status: number) => void,
  ) {
    this.onExit = onExit;
    const child = spawnExecutable(request.executable, request.arguments, {
      cwd: request.workingDirectory,
      env: request.environment,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    this.child = child as ChildProcessByStdio<null, Readable, null>;

    this.ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.child.off("spawn", handleSpawn);
        this.child.off("error", handleError);
      };
      const handleSpawn = () => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
        this.markExit(-1);
      };
      this.child.once("spawn", handleSpawn);
      this.child.once("error", handleError);
    });

    this.child.stdout.on("data", (chunk: Buffer) => {
      if (!this.reachedEOF) onOutput(chunk);
    });
    this.child.stdout.on("end", () => this.markEOF());
    this.child.stdout.on("error", () => this.markEOF());
    this.child.on("exit", (code, signal) => {
      this.running = false;
      this.markExit(code ?? (signal ? 1 : 0));
    });
    this.child.on("error", () => {
      this.running = false;
    });
  }

  async waitUntilStarted(): Promise<void> {
    await this.ready;
  }

  interrupt(): void {
    if (!this.running || this.child.pid === undefined) return;
    if (process.platform === "win32") {
      // PORT: 上游 Windows 用 Win32 结束整棵进程树。Node 没有等价 API，用系统自带的 taskkill。
      try {
        spawnSync("taskkill", ["/pid", String(this.child.pid), "/t", "/f"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        // 进程已经不在了就算了。
      }
      return;
    }
    this.child.kill("SIGINT");
  }

  terminate(): void {
    if (this.running) this.child.kill();
  }

  private markEOF(): void {
    this.reachedEOF = true;
    this.reportIfDone();
  }

  private markExit(status: number): void {
    if (this.exitStatus !== undefined) return;
    this.exitStatus = status;
    this.reportIfDone();
    // 子进程若把 stdout 交给了还活着的孙进程，EOF 可能永远不来；退出后最多再等 2 秒。
    const timer = setTimeout(() => this.markEOF(), 2_000);
    timer.unref?.();
  }

  private reportIfDone(): void {
    if (this.reported || !this.reachedEOF || this.exitStatus === undefined) return;
    this.reported = true;
    this.onExit(this.exitStatus);
  }
}

// MARK: - 输出解析

export type PiJSONStreamResult = {
  sessionID?: string;
  lastText?: string;
  /** 退出码非 0，或最后一条 assistant 的 `stopReason` 是 `error`。 */
  failed: boolean;
  /** 最后一条 assistant 的 `stopReason` 是 `aborted`。 */
  aborted: boolean;
  errorMessage?: string;
};

/**
 * 读 `pi --mode json` 的 stdout：一行一个 JSON 事件。只关心：
 * - 首个 `{"type":"session","id":…}`（就是会话 header）：session id，命令回执等的就是它；
 * - `message_end` 里的 assistant 消息：留最后一段文本与 `stopReason`；
 * - `agent_settled`：这一轮真正结束（`agent_end` 之后还可能有自动重试 / 压缩，所以不认它）。
 * 其余事件一律忽略，**全程容错**。
 */
export class PiJSONStreamReader {
  private readonly decoder = new StringDecoder("utf8");
  private decoderEnded = false;
  private buffer = "";
  private sessionID: string | undefined;
  private lastText: string | undefined;
  private lastStopReason: string | undefined;
  private errorMessage: string | undefined;
  private finished = false;

  onSessionID: ((id: string) => void) | undefined;
  onFinished: ((result: PiJSONStreamResult) => void) | undefined;

  consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handle(line);
      newline = this.buffer.indexOf("\n");
    }
    // 一行都没读完整就先攒着。上限只是防一个坏掉的流把内存吃光。
    if (this.buffer.length > 1 << 22) this.buffer = "";
  }

  /**
   * 幂等：`agent_settled` 与进程退出各会调一次，只有第一次作数。
   * - Parameter exitStatus：进程退出码；由 `agent_settled` 触发时为 undefined（进程还没退）。
   */
  finish(exitStatus?: number): void {
    if (exitStatus !== undefined) {
      // 进程退出时缓冲里可能还剩没带换行的最后一行。`agent_settled` 触发时流还没完，不能动缓冲。
      const tail = this.buffer + this.flushDecoder();
      this.buffer = "";
      if (tail) this.handle(tail);
    }
    if (this.finished) return;
    this.finished = true;
    this.onFinished?.({
      sessionID: this.sessionID,
      lastText: this.lastText,
      failed: (exitStatus ?? 0) !== 0 || this.lastStopReason === "error",
      aborted: this.lastStopReason === "aborted",
      errorMessage: this.errorMessage,
    });
  }

  private flushDecoder(): string {
    if (this.decoderEnded) return "";
    this.decoderEnded = true;
    return this.decoder.end();
  }

  private handle(line: string): void {
    let object: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      object = parsed;
    } catch {
      return;
    }
    switch (object.type) {
      case "session": {
        if (this.sessionID !== undefined) return;
        const id = object.id;
        if (typeof id !== "string" || !id) return;
        this.sessionID = id;
        this.onSessionID?.(id);
        return;
      }
      case "message_end": {
        const message = parsePiMessage(object.message);
        if (!message || message.role !== "assistant") return;
        const raw = isRecord(object.message) ? object.message.errorMessage : undefined;
        this.lastStopReason = message.stopReason;
        if (message.text.trim()) this.lastText = message.text;
        if (typeof raw === "string" && raw) this.errorMessage = raw;
        return;
      }
      case "agent_settled":
        this.finish();
        return;
      default:
        return;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
