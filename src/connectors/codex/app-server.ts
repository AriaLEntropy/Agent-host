// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexAppServer.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { jsonArray, jsonInt, jsonPath, jsonString, parseIncomingLine, encodeOutgoingMessage, incomingLogDescription, outgoingLogDescription, requestIdKey, type CodexIncomingMessage, type CodexOutgoingMessage, type CodexRequestID, type JSONValue } from "./json.js";
import {
  CodexAppServerError,
  CodexServerRequest,
  codexNotification,
  describeError,
  type CodexAppServerEvent,
  type CodexFileChange,
  type CodexItem,
  type CodexNotification,
  type CodexProcessExit,
} from "./app-server-messages.js";
import type { FailureDiagnosis } from "../ported/contract.js";

/**
 * 一个已经在跑的 `codex app-server` 子进程。**这就是测试用的注入缝**：
 * 生产实现是 `CodexSubprocess`（child_process + 三根管子），测试实现是内存里的假管子，
 * 全套测试不起任何真实进程、不建线程、不发一次网络请求。
 *
 * 约定：
 * - `readStdout()` 只允许被单个读循环**串行**调用。返回的字节是**任意切分**的：
 *   可能是半行，也可能一口气好几行，分帧是调用方的事。返回 null = stdout 关了。
 * - `writeStdin(_:)` 必须把整个 buffer **原子地**写出去，否则两条并发的请求会交错成半行。
 * - `terminate()` 幂等。
 */
export interface CodexProcessHandle {
  readStdout(): Promise<Uint8Array | null>;
  writeStdin(data: Uint8Array): Promise<void>;
  terminate(): void;
  /** 等进程真的退出。只用于拿退出码与 stderr 末尾。 */
  waitForExit(): Promise<CodexProcessExit>;
}

/** 怎么起一个 `codex app-server`。失败表示这次没起成（`CodexAppServer` 会按重启节奏再试）。 */
export interface CodexProcessLauncher {
  launch(): Promise<CodexProcessHandle>;
}

/** 时间的注入缝：重启延迟与请求硬超时都走它，测试里换成“记一笔然后等闸门”，不真的睡。 */
export type CodexSleeper = (seconds: number, signal?: AbortSignal) => Promise<void>;

const defaultSleeper: CodexSleeper = (seconds, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** 带一条硬超时的单次结果盒。应答、超时、进程退出三条路径抢它，第二个静默丢弃。 */
class Once<T> {
  private settled = false;
  private resolvePromise: ((value: T) => void) | undefined;
  private rejectPromise: ((error: unknown) => void) | undefined;
  readonly promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  get isSettled(): boolean {
    return this.settled;
  }

  succeed(value: T): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.resolvePromise?.(value);
    return true;
  }

  fail(error: unknown): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.rejectPromise?.(error);
    return true;
  }
}

/** 单订阅者、有界（丢最旧）的事件队列。对应上游 `AsyncStream(bufferingNewest:)`。 */
class EventQueue {
  private readonly buffer: CodexAppServerEvent[] = [];
  private readonly waiters: Array<(event: CodexAppServerEvent | null) => void> = [];
  private closed = false;

  constructor(private readonly limit: number) {}

  push(event: CodexAppServerEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.buffer.push(event);
    while (this.buffer.length > this.limit) this.buffer.shift();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async *iterate(): AsyncGenerator<CodexAppServerEvent> {
    while (true) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<CodexAppServerEvent | null>((resolve) => this.waiters.push(resolve));
      if (next === null) return;
      yield next;
    }
  }
}

type ThreadState = { controlled: boolean; running: boolean };

type Live = {
  generation: number;
  handle: CodexProcessHandle;
  cancelled: boolean;
  handshake?: Promise<void>;
  handshakeError?: unknown;
};

type PendingRequest = {
  method: string;
  box: Once<JSONValue>;
  cancelled: boolean;
  timerAbort?: AbortController;
};

export type CodexAppServerConfiguration = {
  /** `initialize` 里报给 app-server 的客户端名。 */
  clientName: string;
  clientVersion: string;
  requestTimeout: number;
  restartDelay: number;
  maxLineBytes: number;
};

export function codexAppServerConfiguration(overrides: Partial<CodexAppServerConfiguration> = {}): CodexAppServerConfiguration {
  return {
    clientName: overrides.clientName ?? "BotBus",
    clientVersion: overrides.clientVersion ?? "1.0.0",
    requestTimeout: overrides.requestTimeout ?? CodexAppServer.defaultRequestTimeout,
    restartDelay: overrides.restartDelay ?? CodexAppServer.restartDelay,
    maxLineBytes: overrides.maxLineBytes ?? CodexAppServer.maxLineBytes,
  };
}

/**
 * 常驻的 `codex app-server` 子进程与它的协议层：分帧、请求应答对号、通知分发、挂起服务端请求、
 * 进程死了自动重启并把之前控制的线程 resume 回来。
 *
 * **不做**命令语义——`startTask` / `followUp` / `approve` / `interrupt` 怎么映射是连接器的事。
 * 这里只提供 `request` / `notify` / `respond` 三把工具和一条事件流。
 *
 * 几条不显然的约定：
 * - **分帧是按行的**：一行一个 JSON 对象，没有 Content-Length 头，也没有 `jsonrpc` 字段。
 * - **请求 id 可能是字符串也可能是整数**；对号表的键是 `CodexRequestID`。
 * - **服务端请求绝不自动回**：到达时只挂起来并推一条事件。
 * - **超时是同一个 Once 里的硬上限**，不是 Promise.race 的“先到者胜”。
 * - **日志只记种类、方法名、id 与字节数**，绝不记 params / result 本体。
 */
export class CodexAppServer {
  /** 子进程退出后隔多久重启（spec 6.1）。 */
  static readonly restartDelay = 3;
  /** 单条请求的硬超时。 */
  static readonly defaultRequestTimeout = 60;
  /** 单行上限。正常的一行可以很大（整个补丁），但不能无上限地攒下去。 */
  static readonly maxLineBytes = 16 * 1024 * 1024;
  /** `item/started` 补丁缓存的条数上限。 */
  static readonly maxCachedFileChangeItems = 128;
  /** 同时挂起的服务端请求上限。超了从最旧的丢，免得对端发疯把内存吃光。 */
  static readonly maxPendingServerRequests = 64;
  /** 记住多少个线程的控制/运行状态。 */
  static readonly maxTrackedThreads = 256;
  static readonly eventBufferLimit = 512;

  /** 会把某个线程变成“由本机驱动”的方法：发过这些，重启后就该把它 resume 回来。 */
  private static readonly threadControllingMethods = new Set([
    "thread/resume",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
  ]);

  private readonly launcher: CodexProcessLauncher;
  private readonly configuration: CodexAppServerConfiguration;
  private readonly sleeper: CodexSleeper;

  /** `start()` 过且没 `stop()` 过。决定进程死了要不要重启。 */
  private active = false;
  private generation = 0;
  private live: Live | undefined;
  /** 正在起的那个子进程（launcher.launch 是异步的；命令要能等它落定再判断）。 */
  private launching: Promise<void> | undefined;
  private restartToken: { cancelled: boolean; abort?: AbortController } | undefined;
  /** 协议 3.7：最近一次起子进程失败时错误带的原因，起成功就清掉。 */
  private launchFailureDiagnosis: FailureDiagnosis | undefined;

  private nextRequestNumber = 1;
  private readonly inFlight = new Map<string, PendingRequest>();

  private readonly serverRequests = new Map<string, CodexServerRequest>();
  private serverRequestOrder: string[] = [];

  /** itemId → 那个 `fileChange` 条目的补丁。审批请求不带 diff，只能从这里配对。 */
  private readonly fileChangeCache = new Map<string, CodexFileChange[]>();
  private fileChangeOrder: string[] = [];

  private readonly threads = new Map<string, ThreadState>();
  private threadOrder: string[] = [];
  /** 进程死的那一刻，“由本机控制且还在跑”的线程。下一代握手完就逐个 `thread/resume`。 */
  private pendingResumes: string[] = [];

  private eventQueue: EventQueue | undefined;

  constructor(
    launcher: CodexProcessLauncher,
    configuration: CodexAppServerConfiguration = codexAppServerConfiguration(),
    sleeper: CodexSleeper = defaultSleeper,
  ) {
    this.launcher = launcher;
    this.configuration = configuration;
    this.sleeper = sleeper;
  }

  // MARK: - 事件流

  /**
   * 事件出口。**只允许一个订阅者**：再调一次会终止上一条流并接管。
   * 没有订阅者时事件直接丢弃，不攒历史。
   */
  events(): AsyncIterable<CodexAppServerEvent> {
    this.eventQueue?.close();
    const queue = new EventQueue(CodexAppServer.eventBufferLimit);
    this.eventQueue = queue;
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = queue.iterate();
        return {
          next: async () => {
            const next = await iterator.next();
            if (next.done && this.eventQueue === queue) this.eventQueue = undefined;
            return next;
          },
          return: async (value?: unknown) => {
            queue.close();
            if (this.eventQueue === queue) this.eventQueue = undefined;
            return { done: true, value: value as never };
          },
        };
      },
    };
  }

  private publish(event: CodexAppServerEvent): void {
    this.eventQueue?.push(event);
  }

  // MARK: - 生命周期

  /** 起子进程并开始握手。幂等：已经在跑就什么都不做。不等握手完成就返回。 */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.beginLaunch();
  }

  /** 起进程并记住这个异步窗口：`start()` 之后立刻发命令时，`request` 会先等它。 */
  private beginLaunch(): void {
    if (this.launching) return;
    const task = this.launchProcess();
    this.launching = task;
    const clear = () => {
      if (this.launching === task) this.launching = undefined;
    };
    void task.then(clear, clear);
  }

  /** 停掉：不再重启、掐掉读循环、终止子进程、放掉所有在途与挂起请求。幂等。 */
  stop(): void {
    this.active = false;
    if (this.restartToken) {
      this.restartToken.cancelled = true;
      this.restartToken.abort?.abort();
    }
    this.restartToken = undefined;
    const live = this.live;
    if (live) {
      live.cancelled = true;
      live.handle.terminate();
      this.live = undefined;
    }
    this.failAllInFlight(new CodexAppServerError("notRunning", "Codex app-server 已停止"));
    this.serverRequests.clear();
    this.serverRequestOrder = [];
    this.fileChangeCache.clear();
    this.fileChangeOrder = [];
    this.pendingResumes = [];
  }

  /** 当前是不是有一个活着的子进程（不代表握手已完成）。 */
  get isProcessAlive(): boolean {
    return this.live !== undefined;
  }

  /** 已经起过几代子进程。第一代是 1，每重启一次加一。 */
  get processGeneration(): number {
    return this.generation;
  }

  private async launchProcess(): Promise<void> {
    if (!this.active || this.live) return;
    this.generation += 1;
    const mine = this.generation;
    let handle: CodexProcessHandle;
    try {
      handle = await this.launcher.launch();
      this.launchFailureDiagnosis = undefined;
    } catch (error) {
      // 起进程期间 stop()/重新 start() 过：这一次失败已经过期，不再排重启。
      if (!this.active || mine !== this.generation) return;
      this.launchFailureDiagnosis =
        error instanceof Error && "diagnosis" in error
          ? ((error as { diagnosis?: FailureDiagnosis }).diagnosis ?? undefined)
          : undefined;
      console.error(`[codexappserver] 起 codex app-server 失败（第 ${mine} 代）：${describeError(error)}`);
      this.publish({
        type: "exited",
        exit: { status: -1, reason: "无法启动 codex app-server" },
        restartingIn: this.configuration.restartDelay,
      });
      this.scheduleRestart(mine);
      return;
    }
    // 起进程期间被 stop() 了、或者已经换了一代：这个句柄没人要，直接收掉。
    if (!this.active || this.live || mine !== this.generation) {
      handle.terminate();
      return;
    }
    const live: Live = { generation: mine, handle, cancelled: false };
    this.live = live;
    console.info(`[codexappserver] codex app-server 起来了（第 ${mine} 代）`);
    this.publish({ type: "started", generation: mine });
    void this.runReadLoop(live);
    live.handshake = this.performHandshake(live).then(
      () => undefined,
      async (error) => {
        live.handshakeError = error;
        await this.handshakeFailed(live, error);
      },
    );
  }

  /** 握手没成：进程可能还活着但已经没用了。掐掉它，让读循环收尾走正常的重启流程。 */
  private async handshakeFailed(broken: Live, error: unknown): Promise<void> {
    if (this.live !== broken) return;
    console.error(`[codexappserver] Codex 握手失败：${describeError(error)}`);
    broken.handle.terminate();
  }

  private scheduleRestart(after: number): void {
    if (!this.active) return;
    if (this.restartToken) {
      this.restartToken.cancelled = true;
      this.restartToken.abort?.abort();
    }
    const abort = new AbortController();
    const token = { cancelled: false, abort };
    this.restartToken = token;
    const delay = this.configuration.restartDelay;
    void this.sleeper(delay, abort.signal).then(() => {
      if (token.cancelled) return;
      this.relaunch(after);
    });
  }

  private relaunch(after: number): void {
    if (!this.active || this.live || this.generation !== after) return;
    this.restartToken = undefined;
    this.beginLaunch();
  }

  // MARK: - 握手

  private async performHandshake(live: Live): Promise<void> {
    const params: JSONValue = {
      clientInfo: {
        name: this.configuration.clientName,
        version: this.configuration.clientVersion,
      },
    };
    // 这一条必须是写出去的第一行，所以它不走 `request`（那会先等握手，自己等自己）。
    await this.perform("initialize", params, this.configuration.requestTimeout, live);
    if (live.cancelled) return;
    await this.send({ type: "notification", method: "initialized" }, live);
    if (live.cancelled) return;
    this.publish({ type: "ready", generation: live.generation });
    // resume 放到握手之后的独立任务里：真实 resume 可能要几秒，不该把后面的命令全堵住。
    void this.resumeControlledThreads(live);
  }

  /** 重启后把之前由本机控制、当时还在跑的线程逐个 `thread/resume`（spec 6.1）。 */
  private async resumeControlledThreads(live: Live): Promise<void> {
    const ids = this.pendingResumes;
    this.pendingResumes = [];
    if (ids.length === 0) return;
    console.info(`[codexappserver] 重启后 resume ${ids.length} 个线程`);
    this.publish({ type: "resumingAfterRestart", threadIds: ids });
    for (const threadId of ids) {
      if (this.live !== live) return;
      this.markControlled(threadId);
      try {
        await this.perform(
          "thread/resume",
          { threadId },
          this.configuration.requestTimeout,
          live,
        );
      } catch (error) {
        // resume 失败不致命：那条线程回落成只读观察即可，别把重启流程一起拖垮。
        console.error(`[codexappserver] thread/resume 失败：${describeError(error)}`);
      }
    }
  }

  // MARK: - 对外的三把工具

  /** 发一条请求并等应答。会先等握手完成（`initialize` 永远是第一行）。 */
  async request(method: string, params?: JSONValue, timeout?: number): Promise<JSONValue> {
    await this.waitForHandshake();
    const live = this.live;
    if (!live) throw this.notRunning();
    // 发过这条就等于本机在驱动这个线程：重启后要把它 resume 回来。
    if (CodexAppServer.threadControllingMethods.has(method)) {
      const threadId = jsonString(jsonPath(params, "threadId"));
      if (threadId !== undefined) this.markControlled(threadId);
    }
    const result = await this.perform(method, params, timeout ?? this.configuration.requestTimeout, live);
    // `thread/start` 的 id 只能从应答里拿。
    if (method === "thread/start") {
      const id = jsonString(jsonPath(result, "thread", "id"));
      if (id !== undefined) this.markControlled(id);
    }
    return result;
  }

  /** 发一条不需要应答的通知。 */
  async notify(method: string, params?: JSONValue): Promise<void> {
    await this.waitForHandshake();
    const live = this.live;
    if (!live) throw this.notRunning();
    await this.send({ type: "notification", method, params }, live);
  }

  /**
   * 回复一条挂起的服务端请求。**只有上层调它**——`CodexAppServer` 自己永远不回审批。
   * `key` 是 `CodexServerRequest.key`。不在挂起表里就抛 `unknownRequest`。
   */
  async respond(key: string, result: JSONValue): Promise<void>;
  async respond(key: string, errorCode: number, message: string): Promise<void>;
  async respond(key: string, resultOrCode: JSONValue | number, message?: string): Promise<void> {
    const request = this.serverRequests.get(key);
    if (!request) {
      throw new CodexAppServerError("unknownRequest", `没有挂起的 Codex 请求 ${key}`);
    }
    const live = this.live;
    if (!live) throw this.notRunning();
    const outgoing: CodexOutgoingMessage =
      typeof resultOrCode === "number" && message !== undefined
        ? { type: "failure", id: request.id, code: resultOrCode, message }
        : { type: "response", id: request.id, result: resultOrCode as JSONValue };
    await this.send(outgoing, live);
    // 写成功才从表里摘：写失败时请求还挂着，上层可以重试。
    this.dropServerRequest(key);
  }

  // MARK: - 挂起的服务端请求

  /** 当前挂着、等人回答的服务端请求。按到达顺序。 */
  pendingServerRequests(): CodexServerRequest[] {
    return this.serverRequestOrder
      .map((key) => this.serverRequests.get(key))
      .filter((request): request is CodexServerRequest => request !== undefined);
  }

  pendingServerRequest(key: string): CodexServerRequest | undefined {
    return this.serverRequests.get(key);
  }

  /**
   * 丢掉某个线程（可选再限定某一轮）所有还挂着的请求，不回复。
   * 轮次被中断时用：那些请求已经没人收了。返回被丢掉的那些。
   */
  discardServerRequests(threadId: string, turnId?: string): CodexServerRequest[] {
    const doomed = this.pendingServerRequests().filter(
      (request) => request.threadId === threadId && (turnId === undefined || request.turnId === turnId),
    );
    for (const request of doomed) this.dropServerRequest(request.key);
    return doomed;
  }

  private dropServerRequest(key: string): void {
    if (!this.serverRequests.delete(key)) return;
    this.serverRequestOrder = this.serverRequestOrder.filter((item) => item !== key);
  }

  // MARK: - 线程控制记账

  /** 标记某个线程由本机驱动。 */
  markControlled(threadId: string): void {
    this.touchThread(threadId, (state) => {
      state.controlled = true;
    });
  }

  /** 交还控制权（任务结束、连接器不再驱动它）。重启后不会再 resume 它。 */
  releaseControl(threadId: string): void {
    const state = this.threads.get(threadId);
    if (!state) return;
    state.controlled = false;
    this.pendingResumes = this.pendingResumes.filter((id) => id !== threadId);
  }

  controlledThreads(): string[] {
    return this.threadOrder.filter((id) => this.threads.get(id)?.controlled === true);
  }

  /** 由本机控制、且最后一条通知说还在跑的线程。重启时要 resume 的就是这批。 */
  runningControlledThreads(): string[] {
    return this.threadOrder.filter((id) => {
      const state = this.threads.get(id);
      return state?.controlled === true && state.running === true;
    });
  }

  private touchThread(id: string, mutate: (state: ThreadState) => void): void {
    const existing = this.threads.get(id);
    const state: ThreadState = existing ?? { controlled: false, running: false };
    if (!existing) this.threadOrder.push(id);
    mutate(state);
    this.threads.set(id, state);
    // 上限只淘汰“已经不由本机控制”的，别把还要 resume 的线程挤掉。
    while (this.threadOrder.length > CodexAppServer.maxTrackedThreads) {
      const victim = this.threadOrder.find((candidate) => {
        if (candidate === id) return false;
        return this.threads.get(candidate)?.controlled !== true;
      });
      if (victim === undefined) break;
      this.threads.delete(victim);
      this.threadOrder = this.threadOrder.filter((candidate) => candidate !== victim);
    }
  }

  // MARK: - 请求对号

  /** 没有活着的子进程：“还没就绪”，带上最近一次起不来的原因。 */
  private notRunning(): CodexAppServerError {
    return CodexAppServerError.notRunning("Codex app-server 还没就绪", this.launchFailureDiagnosis);
  }

  private async waitForHandshake(): Promise<void> {
    let live = this.live;
    if (!live?.handshake) {
      // `start()` 之后立刻来的命令：launcher.launch() 还没返回，先等这一代落定。
      if (this.active && this.launching) {
        await this.launching.catch(() => undefined);
        live = this.live;
      }
    }
    if (!live?.handshake) throw this.notRunning();
    await live.handshake;
    if (live.handshakeError !== undefined) {
      throw live.handshakeError instanceof CodexAppServerError
        ? live.handshakeError
        : new CodexAppServerError("notRunning", describeError(live.handshakeError));
    }
  }

  private async perform(method: string, params: JSONValue | undefined, timeout: number, live: Live): Promise<JSONValue> {
    const id: CodexRequestID = { kind: "number", value: this.nextRequestNumber };
    this.nextRequestNumber += 1;
    const box = new Once<JSONValue>();
    const timerAbort = new AbortController();
    const pending: PendingRequest = { method, box, cancelled: false, timerAbort };
    // 超时是同一个盒子里的硬上限：定时器直接往盒子里塞错误，不是“先到者胜”。
    void this.sleeper(timeout, timerAbort.signal).then(() => {
      if (pending.cancelled) return;
      if (!box.fail(CodexAppServerError.timedOut(method, timeout))) return;
      console.error(`[codexappserver] Codex ${method} ${requestIdKey(id)} 超时`);
      this.inFlight.delete(requestIdKey(id));
    });
    this.inFlight.set(requestIdKey(id), pending);
    try {
      await this.send({ type: "request", id, method, params }, live);
    } catch (error) {
      this.inFlight.delete(requestIdKey(id));
      pending.cancelled = true;
      timerAbort.abort();
      throw error;
    }
    try {
      return await box.promise;
    } finally {
      pending.cancelled = true;
      timerAbort.abort();
    }
  }

  private resolve(id: CodexRequestID, outcome: { ok: true; result: JSONValue } | { ok: false; error: unknown }): void {
    const key = requestIdKey(id);
    const pending = this.inFlight.get(key);
    if (!pending) {
      // 超时之后迟到的应答会走到这里。不是错误，记一笔就好。
      console.debug(`[codexappserver] 无人认领的应答 ${key}`);
      return;
    }
    this.inFlight.delete(key);
    pending.cancelled = true;
    pending.timerAbort?.abort();
    if (outcome.ok) pending.box.succeed(outcome.result);
    else pending.box.fail(outcome.error);
  }

  private failAllInFlight(error: CodexAppServerError): void {
    const taken = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const pending of taken) {
      pending.cancelled = true;
      pending.timerAbort?.abort();
      pending.box.fail(error);
    }
  }

  // MARK: - 写

  private async send(message: CodexOutgoingMessage, live: Live): Promise<void> {
    let encoded: string;
    try {
      encoded = encodeOutgoingMessage(message);
    } catch {
      throw new CodexAppServerError("transport", `无法编码 Codex ${outgoingLogDescription(message)}`);
    }
    // 分帧就是这一个换行符：没有 Content-Length 头。
    const line = Buffer.from(`${encoded}\n`, "utf8");
    try {
      await live.handle.writeStdin(line);
    } catch (error) {
      throw new CodexAppServerError("transport", `写 Codex stdin 失败：${describeError(error)}`);
    }
    // 只记方法名、id 与字节数；载荷里是用户的会话内容，一个字都不进日志。
    console.debug(`[codexappserver] → ${outgoingLogDescription(message)} ${line.length}B`);
  }

  // MARK: - 读与分帧

  private async runReadLoop(live: Live): Promise<void> {
    let buffer = Buffer.alloc(0);
    /** 攒过头（对端一直不给换行符）就整段丢掉，不能无限长。 */
    let overflowed = false;
    while (!live.cancelled) {
      let chunk: Uint8Array | null;
      try {
        chunk = await live.handle.readStdout();
      } catch (error) {
        console.error(`[codexappserver] 读 Codex stdout 失败：${describeError(error)}`);
        break;
      }
      if (chunk === null) break;
      if (chunk.length === 0) continue;
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      // 一次 read 可能给回半行，也可能给回好几行：只处理到最后一个换行符为止，剩下的攒着。
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (overflowed) {
          // 丢掉的那一行的尾巴，跳过。
          overflowed = false;
        } else {
          this.ingest(line);
        }
        newline = buffer.indexOf(0x0a);
      }
      if (buffer.length > this.configuration.maxLineBytes) {
        console.error(`[codexappserver] Codex 单行超过 ${this.configuration.maxLineBytes} 字节，丢弃`);
        buffer = Buffer.alloc(0);
        overflowed = true;
      }
    }
    await this.handleExit(live);
  }

  private ingest(line: Uint8Array): void {
    // 容忍 CRLF 与空行。
    let end = line.length;
    if (end > 0 && line[end - 1] === 0x0d) end -= 1;
    if (end === 0) return;
    const trimmed = line.subarray(0, end);
    const message = parseIncomingLine(trimmed);
    if (!message) {
      console.warn(`[codexappserver] 无法解析的 Codex 行，${trimmed.length}B`);
      return;
    }
    console.debug(`[codexappserver] ← ${incomingLogDescription(message)} ${trimmed.length}B`);
    this.handleIncoming(message);
  }

  private handleIncoming(message: CodexIncomingMessage): void {
    switch (message.type) {
      case "response":
        this.resolve(message.id, { ok: true, result: message.result });
        return;
      case "failure":
        this.resolve(message.id, {
          ok: false,
          error: new CodexAppServerError(
            "server",
            `Codex 返回错误 ${message.code}：${message.message}`,
            { code: message.code },
          ),
        });
        return;
      case "request":
        this.surface(message.id, message.method, message.params);
        return;
      case "notification":
        this.dispatch(message.method, message.params);
        return;
    }
  }

  // MARK: - 服务端请求：只挂起，绝不自动回

  private surface(id: CodexRequestID, method: string, params: JSONValue): void {
    // `item/fileChange/requestApproval` 不带 diff，从同 itemId 的 `item/started` 缓存里补。
    const itemId = jsonString(jsonPath(params, "itemId"));
    const cached = itemId === undefined ? [] : (this.fileChangeCache.get(itemId) ?? []);
    const request = new CodexServerRequest(id, method, params, cached);
    const had = this.serverRequests.has(request.key);
    this.serverRequests.set(request.key, request);
    if (!had) this.serverRequestOrder.push(request.key);
    while (this.serverRequestOrder.length > CodexAppServer.maxPendingServerRequests) {
      const oldest = this.serverRequestOrder[0];
      if (oldest === undefined) break;
      console.error(`[codexappserver] 挂起的 Codex 请求过多，丢掉最旧的 ${oldest}`);
      this.dropServerRequest(oldest);
    }
    console.info(`[codexappserver] 挂起 Codex 服务端请求 ${method} ${request.key}`);
    this.publish({ type: "serverRequest", request });
  }

  // MARK: - 通知分发

  private dispatch(method: string, params: JSONValue): void {
    if (method === "serverRequest/resolved") {
      const rawId = jsonPath(params, "requestId");
      const number = jsonInt(rawId);
      if (number !== undefined) this.dropServerRequest(requestIdKey({ kind: "number", value: number }));
      else {
        const text = jsonString(rawId);
        if (text !== undefined) this.dropServerRequest(requestIdKey({ kind: "text", value: text }));
      }
    }
    const notification = codexNotification(method, params);
    switch (notification.type) {
      case "turnStarted":
        this.touchThread(notification.threadId, (state) => {
          state.running = true;
        });
        break;
      case "turnCompleted":
        this.touchThread(notification.threadId, (state) => {
          state.running = false;
        });
        // 轮次结束了，这一轮里还挂着的审批已经没人收，静默丢掉。
        this.discardServerRequests(notification.threadId, notification.turnId.length === 0 ? undefined : notification.turnId);
        break;
      case "threadStatusChanged":
        switch (notification.status.type) {
          case "active":
            this.touchThread(notification.threadId, (state) => {
              state.running = true;
            });
            break;
          case "idle":
          case "systemError":
          case "notLoaded":
            this.touchThread(notification.threadId, (state) => {
              state.running = false;
            });
            break;
          default:
            break;
        }
        break;
      case "itemStarted":
      case "itemCompleted":
        this.cacheFileChanges(notification.item);
        break;
      default:
        break;
    }
    this.publish({ type: "notification", notification });
  }

  private cacheFileChanges(item: CodexItem): void {
    if (item.changes.length === 0) return;
    if (!this.fileChangeCache.has(item.id)) this.fileChangeOrder.push(item.id);
    this.fileChangeCache.set(item.id, item.changes);
    while (this.fileChangeOrder.length > CodexAppServer.maxCachedFileChangeItems) {
      const oldest = this.fileChangeOrder.shift();
      if (oldest === undefined) break;
      this.fileChangeCache.delete(oldest);
    }
  }

  // MARK: - 进程退出

  private async handleExit(dead: Live): Promise<void> {
    // 已经换代了（或者被 stop() 了）：这个读循环是上一代的尾巴，什么都不做。
    if (this.live !== dead) return;
    this.live = undefined;
    dead.cancelled = true;
    const exit = await dead.handle.waitForExit();
    // 再确认一次：等退出码的这段时间里可能已经 stop() 又 start() 过了。
    if (this.generation !== dead.generation) return;

    // 进程死的那一刻还在跑、且由本机控制的线程，重启后要 resume 回来。
    this.pendingResumes = this.runningControlledThreads();
    for (const id of this.pendingResumes) {
      const state = this.threads.get(id);
      if (state) state.running = false;
    }

    this.failAllInFlight(CodexAppServerError.processExited("在途请求"));
    this.serverRequests.clear();
    this.serverRequestOrder = [];
    this.fileChangeCache.clear();
    this.fileChangeOrder = [];

    console.error(
      `[codexappserver] codex app-server 退出（第 ${dead.generation} 代，status=${exit.status}），${this.active ? "准备重启" : "不重启"}`,
    );
    this.publish({
      type: "exited",
      exit,
      restartingIn: this.active ? this.configuration.restartDelay : undefined,
    });
    if (!this.active) {
      this.pendingResumes = [];
      return;
    }
    this.scheduleRestart(dead.generation);
  }
}

/** 给测试与调用方：把若干行合到一起再分片，用来验证按行分帧。 */
export function chunkLines(lines: string[], splitAt: number): Buffer[] {
  const encoded = Buffer.from(lines.join(""), "utf8");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < encoded.length; offset += splitAt) {
    chunks.push(encoded.subarray(offset, Math.min(offset + splitAt, encoded.length)));
  }
  return chunks;
}

/** 从 `thread/read` 之类的应答里取线程 id（连接器与测试共用）。 */
export function threadIdFromResponse(response: JSONValue): string | undefined {
  const direct = jsonString(jsonPath(response, "threadId"));
  if (direct !== undefined) return direct;
  return jsonString(jsonPath(response, "thread", "id"));
}

/** 只用于类型收窄的小工具。 */
export function isJSONArray(value: JSONValue | undefined): value is JSONValue[] {
  return jsonArray(value) !== undefined;
}
