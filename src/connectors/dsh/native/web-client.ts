// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshWebClient.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { DshWebCookie } from "./web-auth.js";
import {
  isRecord,
  jsonPath,
  record,
  stringValue,
  summaryFromJson,
  sessionEventFromJson,
  type DshSessionEvent,
  type DshWebSessionSummary,
} from "./web-messages.js";

/** 本机一个 `dsh web` 的地址。cookie 按 `authority` 签，所以一律用 `127.0.0.1:<port>`。 */
export class DshWebEndpoint {
  constructor(readonly port: number) {}

  get authority(): string {
    return `127.0.0.1:${this.port}`;
  }

  get baseUrl(): string {
    return `http://${this.authority}`;
  }

  get muxUrl(): string {
    return `ws://${this.authority}/api/remote.mux`;
  }

  methodUrl(method: string): string {
    return `${this.baseUrl}/api/${method}`;
  }
}

/** 一元调用的 HTTP 层，测试注入假的。 */
export type DshHTTPResponse = { status: number; body: Buffer };

export interface DshHTTPTransport {
  /** POST 并返回状态码与响应体。连不上抛错（任何错误都当"web 不在"）。 */
  post(url: string, headers: Record<string, string>, body: Buffer): Promise<DshHTTPResponse>;
}

/** 生产用：无 cookie、无缓存、15 秒超时。 */
export class FetchDshHTTPTransport implements DshHTTPTransport {
  static readonly timeout = 15_000;

  async post(url: string, headers: Record<string, string>, body: Buffer): Promise<DshHTTPResponse> {
    // `// PORT:` undici 的 BodyInit 只收 ArrayBuffer 视图；把 Buffer 复制成普通 Uint8Array。
    const bytes = new Uint8Array(body.byteLength);
    bytes.set(body);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bytes,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(FetchDshHTTPTransport.timeout),
    });
    const data = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: data };
  }
}

export type DshWebErrorKind =
  | "unauthorized"
  | "httpStatus"
  | "malformedResponse"
  | "remote"
  | "streamFailed"
  | "disconnected"
  | "timeout";

/** web 通道的错误。`message` 里可能带 dsh 自己的错误文本（`containsPrivateDetail`），只给界面。 */
export class DshWebError extends Error {
  constructor(
    readonly kind: DshWebErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly method?: string,
  ) {
    super(message);
    this.name = "DshWebError";
  }

  static unauthorized(): DshWebError {
    return new DshWebError("unauthorized", "DeepSeek Harness 网页端拒绝了 BotBus 的登录");
  }

  static httpStatus(status: number): DshWebError {
    return new DshWebError("httpStatus", `DeepSeek Harness 网页端返回 HTTP ${status}`, status);
  }

  static malformed(method: string): DshWebError {
    return new DshWebError("malformedResponse", `看不懂 DeepSeek Harness 网页端的回应：${method}`, undefined, undefined, method);
  }

  static remote(code: string | undefined, message: string): DshWebError {
    return new DshWebError("remote", message, undefined, code);
  }

  static streamFailed(code: string | undefined, message: string): DshWebError {
    return new DshWebError("streamFailed", message, undefined, code);
  }

  static disconnected(): DshWebError {
    return new DshWebError("disconnected", "和 DeepSeek Harness 网页端的连接断开了");
  }

  static timeout(): DshWebError {
    return new DshWebError("timeout", "DeepSeek Harness 网页端没有及时回应");
  }

  get errorDescription(): string {
    return this.message;
  }

  get containsPrivateDetail(): boolean {
    return this.kind === "remote" || this.kind === "streamFailed";
  }

  /** 能公开进日志的类别（不带 dsh 的错误文本）。 */
  get logCategory(): string {
    switch (this.kind) {
      case "unauthorized":
        return "unauthorized";
      case "httpStatus":
        return `http ${this.status ?? "?"}`;
      case "malformedResponse":
        return `malformed ${this.method ?? "?"}`;
      case "remote":
        return `remote ${this.code ?? "?"}`;
      case "streamFailed":
        return `stream ${this.code ?? "?"}`;
      case "disconnected":
        return "disconnected";
      case "timeout":
        return "timeout";
    }
  }
}

export type DshWebClientOptions = {
  endpoint: DshWebEndpoint;
  secret: Buffer;
  http?: DshHTTPTransport;
  now?: () => Date;
};

/**
 * `dsh web` 的一元调用（`POST /api/<ns>/<method>`）。无状态、可并发；每次请求现签一张 cookie。
 *
 * 请求体 `{type:"client-request", rpcId, method, payload:{args:{<参数名>: 参数}}}`，
 * `session/list` 用 `_request`、其余用 `request`；`$events/result` 例外，`args` 就是结果本身。
 */
export class DshWebClient {
  readonly endpoint: DshWebEndpoint;
  private readonly secret: Buffer;
  private readonly http: DshHTTPTransport;
  private readonly now: () => Date;

  constructor(options: DshWebClientOptions) {
    this.endpoint = options.endpoint;
    this.secret = options.secret;
    this.http = options.http ?? new FetchDshHTTPTransport();
    this.now = options.now ?? (() => new Date());
  }

  /** `Cookie` 头的值。mux 握手也用它。 */
  cookieHeader(): string {
    return DshWebCookie.header(this.secret, this.endpoint.authority, this.now());
  }

  /** 发一次调用，返回 `result.value`（没有就是 null）。 */
  async call(method: string, argument: unknown): Promise<unknown> {
    const args =
      method === "$events/result"
        ? argument
        : method === "session/list"
          ? { _request: argument }
          : { request: argument };
    const envelope = {
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args },
    };
    let response: DshHTTPResponse;
    try {
      response = await this.http.post(
        this.endpoint.methodUrl(method),
        { Cookie: this.cookieHeader(), "Content-Type": "application/json" },
        Buffer.from(JSON.stringify(envelope), "utf8"),
      );
    } catch {
      // `// PORT:` 上游把传输错误原样当"web 不在"；连接层异常不暴露给手机。
      throw DshWebError.disconnected();
    }
    if (response.status === 401 || response.status === 403) throw DshWebError.unauthorized();
    if (response.status < 200 || response.status >= 300) throw DshWebError.httpStatus(response.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw DshWebError.malformed(method);
    }
    const result = record(record(parsed).result);
    const ok = result.ok;
    if (typeof ok !== "boolean") throw DshWebError.malformed(method);
    if (!ok) {
      throw DshWebError.remote(stringValue(jsonPath(result, "error", "code")), stringValue(jsonPath(result, "error", "message")) ?? "DeepSeek Harness 报错");
    }
    return result.value ?? null;
  }

  /** `session/list`：每次都重读持久层，ACP 进程建的会话也在里面。 */
  async listSessions(): Promise<DshWebSessionSummary[]> {
    const value = await this.call("session/list", {});
    const items = record(value).items;
    if (!Array.isArray(items)) throw DshWebError.malformed("session/list");
    return items.flatMap((item) => {
      const summary = summaryFromJson(item);
      return summary ? [summary] : [];
    });
  }

  /** 桌面不会实时索引外部 ACP 新会话；首轮交还写锁后经它接入原会话与工作区。 */
  async adoptSession(sessionId: string, cwd: string): Promise<void> {
    const workspace = await this.call("workspace/create", { path: cwd });
    const workspaceId = stringValue(jsonPath(workspace, "workspace", "workspaceId"));
    if (!workspaceId) throw DshWebError.malformed("workspace/create");
    const session = await this.call("session/create", { sessionId, workspaceId });
    if (stringValue(record(session).sessionId) !== sessionId) throw DshWebError.malformed("session/create");
  }

  /** 续聊（`mode: "queue"`：这一轮在跑就排在后面）。返回 dsh 是否接受。 */
  async prompt(sessionId: string, text: string, requestId = `botbus-${randomUUID()}`): Promise<boolean> {
    const value = await this.call("session/prompt", {
      requestId,
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
    return record(value).accepted !== false;
  }

  /** 中断这一轮（以 `aborted{user}` 收尾）。 */
  async cancel(sessionId: string): Promise<void> {
    await this.call("session/cancel", { sessionId });
  }

  /** 取一页历史，**不激活会话**。 */
  async page(
    sessionId: string,
    throughSeq: number,
    beforeSeq?: number,
    maxMessages = 50,
  ): Promise<{ events: DshSessionEvent[]; hasMore: boolean }> {
    const request: Record<string, unknown> = {
      address: { kind: "session", sessionId },
      throughSeq,
      maxMessages,
    };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    const value = await this.call("session/page", request);
    const records = record(value).records;
    if (!Array.isArray(records)) throw DshWebError.malformed("session/page");
    return {
      events: records.flatMap((item) => {
        const event = sessionEventFromJson(item);
        return event ? [event] : [];
      }),
      hasMore: record(value).hasMore === true,
    };
  }

  /**
   * 最近的一页历史，不激活会话、也不信 `asOfSeq`：先用一个一定越界的 `throughSeq` 问一次，
   * 从 `past cursor N` 错误里取出真正的游标再取一次。
   */
  async latestPage(sessionId: string, maxMessages = 50): Promise<{ events: DshSessionEvent[]; hasMore: boolean }> {
    try {
      return await this.page(sessionId, DshWebClient.probeSeq, undefined, maxMessages);
    } catch (error) {
      if (!(error instanceof DshWebError) || error.kind !== "remote" || error.code !== "gateway/bad-request") {
        throw error;
      }
      const cursor = cursorFromPastCursorMessage(error.message);
      if (cursor === null) throw error;
      if (cursor < 0) return { events: [], hasMore: false };
      return this.page(sessionId, cursor, undefined, maxMessages);
    }
  }

  static readonly probeSeq = 9_007_199_254_740_991;

  /** 回一条 waterfall（`$events/result`）。`clientId` 是这条 `$events` 流 `ready` 给的。 */
  async answer(clientId: string, eventId: string, value: unknown): Promise<void> {
    await this.call("$events/result", {
      clientId,
      eventId,
      outcome: { kind: "result", value },
    });
  }

  /** 审批：允许（只这一次）或拒绝。dsh 的审批没有"以后都允许"。 */
  async answerApproval(clientId: string, eventId: string, allow: boolean): Promise<void> {
    await this.answer(clientId, eventId, allow ? "allowed-once" : "rejected");
  }

  /** 提问：`answers` 是 题目 id → 选中的选项名，或带 `custom` 的完整回答。 */
  async answerQuestions(
    clientId: string,
    eventId: string,
    answers: readonly DshQuestionAnswer[] | Readonly<Record<string, string[]>>,
  ): Promise<void> {
    const items = Array.isArray(answers)
      ? answers
      : Object.keys(answers)
          .sort()
          .map((id) => ({ id, selected: (answers as Record<string, string[]>)[id] }));
    await this.answer(clientId, eventId, {
      answers: items.map((item) => questionAnswerJson(item)),
    });
  }
}

/** 一道题的回答（`AskUserQuestionAnswer.answers[]`）。 */
export type DshQuestionAnswer = {
  id: string;
  selected: string[];
  custom?: string;
};

export function questionAnswerJson(answer: DshQuestionAnswer): Record<string, unknown> {
  const object: Record<string, unknown> = { id: answer.id, selected: answer.selected };
  if (answer.custom !== undefined) object.custom = answer.custom;
  return object;
}

/** 什么都没答（跳过）。 */
export function isEmptyAnswer(answer: DshQuestionAnswer): boolean {
  return answer.selected.length === 0 && (answer.custom === undefined || answer.custom.length === 0);
}

export function cursorFromPastCursorMessage(message: string): number | null {
  const marker = "past cursor ";
  const index = message.indexOf(marker);
  if (index < 0) return null;
  const rest = message.slice(index + marker.length);
  const match = /^-?\d+/.exec(rest);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

// MARK: - mux

/** 一条逻辑流。`items` 在 dsh 发 `end` 时正常结束；取消迭代时自动给 dsh 发 `cancel`。 */
export type DshWebStream = {
  id: string;
  items: AsyncIterable<unknown>;
};

export interface DshWebSocketConnection {
  send(text: string): Promise<void>;
  sendPing(): Promise<void>;
  close(): void;
  /** 下一帧文本；连接关闭/出错时抛出。 */
  receive(): Promise<string>;
}

export interface DshWebSocketTransport {
  connect(url: string, headers: Record<string, string>): Promise<DshWebSocketConnection>;
}

export class DshWebSocketHandshakeError extends Error {
  constructor(readonly status: number) {
    super(`websocket handshake failed: ${status}`);
    this.name = "DshWebSocketHandshakeError";
  }
}

/** 生产传输：`ws`，握手只带 `Cookie`，单帧上限 32 MiB（follow 的首帧 snapshot 可能很大）。 */
export class NodeWebSocketTransport implements DshWebSocketTransport {
  static readonly maxPayload = 32 * 1024 * 1024;

  connect(url: string, headers: Record<string, string>): Promise<DshWebSocketConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers, maxPayload: NodeWebSocketTransport.maxPayload });
      let settled = false;
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        resolve(new NodeWebSocketConnection(socket));
      });
      socket.once("unexpected-response", (_request, response) => {
        if (settled) return;
        settled = true;
        reject(new DshWebSocketHandshakeError(response.statusCode ?? 0));
        socket.terminate();
      });
      socket.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }
}

class NodeWebSocketConnection implements DshWebSocketConnection {
  private readonly queue = new AsyncQueue<string>();

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.queue.push(data.toString()));
    socket.on("close", () => this.queue.finish());
    socket.on("error", (error) => this.queue.fail(error));
  }

  receive(): Promise<string> {
    return this.queue.nextValue();
  }

  send(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(text, (error) => (error ? reject(error) : resolve()));
    });
  }

  sendPing(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.ping((error?: Error) => (error ? reject(error) : resolve()));
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

/**
 * `dsh web` 的流式通道：一条 WebSocket（`/api/remote.mux`），上面按 `streamId` 复用多条逻辑流。
 * 发 `{type:"open", streamId, endpoint, payload:{args}}` / `{type:"cancel", streamId}`；
 * 收 `item` / `error` / `end`。连接断开后所有流以 `disconnected` 结束。
 */
export class DshWebMux {
  readonly endpoint: DshWebEndpoint;
  private readonly cookie: () => string;
  private readonly transport: DshWebSocketTransport;
  private connection: DshWebSocketConnection | undefined;
  private connecting: Promise<void> | undefined;
  private readonly streams = new Map<string, AsyncQueue<unknown>>();
  private nextStream = 0;
  private closed = false;
  private onClose: (() => void | Promise<void>) | undefined;

  constructor(options: {
    endpoint: DshWebEndpoint;
    cookie: () => string;
    transport?: DshWebSocketTransport;
  }) {
    this.endpoint = options.endpoint;
    this.cookie = options.cookie;
    this.transport = options.transport ?? new NodeWebSocketTransport();
  }

  static fromClient(client: DshWebClient, transport?: DshWebSocketTransport): DshWebMux {
    return new DshWebMux({ endpoint: client.endpoint, cookie: () => client.cookieHeader(), transport });
  }

  get isConnected(): boolean {
    return this.connection !== undefined && !this.closed;
  }

  /** 连接断开（对端关、读失败，不含自己 `close()`）时调一次。 */
  setOnClose(handler: (() => void | Promise<void>) | undefined): void {
    this.onClose = handler;
  }

  /** 握手。已连上就直接返回；同时到的几次共用一次握手。关过的 mux 不能再连。 */
  async connect(): Promise<void> {
    if (this.closed) throw DshWebError.disconnected();
    if (this.connection) return;
    if (this.connecting) return this.connecting;
    const task = (async () => {
      let established: DshWebSocketConnection;
      try {
        established = await this.transport.connect(this.endpoint.muxUrl, { Cookie: this.cookie() });
      } catch (error) {
        if (error instanceof DshWebSocketHandshakeError && (error.status === 401 || error.status === 403)) {
          throw DshWebError.unauthorized();
        }
        throw error;
      }
      if (this.closed) {
        established.close();
        throw DshWebError.disconnected();
      }
      this.connection = established;
      void this.readLoop(established);
    })();
    this.connecting = task;
    try {
      await task;
    } finally {
      this.connecting = undefined;
    }
  }

  /** 开一条流。`args` 是 `payload.args`：`$events` 为 `{}`，`session/follow` 为 `{request:{…}}`。 */
  async open(name: string, args: unknown): Promise<DshWebStream> {
    const connection = this.connection;
    if (!connection || this.closed) throw DshWebError.disconnected();
    this.nextStream += 1;
    const id = `botbus-${this.nextStream}`;
    const queue = new AsyncQueue<unknown>(() => {
      void this.cancel(id);
    });
    this.streams.set(id, queue);
    const frame = { type: "open", streamId: id, endpoint: name, payload: { args } };
    try {
      await connection.send(JSON.stringify(frame));
    } catch {
      this.streams.delete(id);
      queue.fail(DshWebError.disconnected());
      throw DshWebError.disconnected();
    }
    return { id, items: queue };
  }

  /** `$events`：首条是 `ready`，之后是 emit / waterfall / cancel。 */
  openEvents(): Promise<DshWebStream> {
    return this.open("$events", {});
  }

  /** `session/follow`：首帧 snapshot，之后逐条 event。**会让 web 载入这个会话**。 */
  follow(sessionId: string, maxMessages = 50): Promise<DshWebStream> {
    return this.open("session/follow", {
      request: { address: { kind: "session", sessionId }, maxMessages },
    });
  }

  /** 关一条流：从路由表摘掉、正常结束它，并告诉 dsh（连接还在的话）。 */
  async cancel(streamId: string): Promise<void> {
    const queue = this.streams.get(streamId);
    if (!queue) return;
    this.streams.delete(streamId);
    queue.finish();
    const connection = this.connection;
    if (!connection || this.closed) return;
    try {
      await connection.send(JSON.stringify({ type: "cancel", streamId }));
    } catch {
      // 连接已断，dsh 那边会自己收尾。
    }
  }

  /** 保活：发一次 WebSocket ping。失败说明连接已死。 */
  async ping(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.closed) throw DshWebError.disconnected();
    await connection.sendPing();
  }

  /** 主动关：所有流以 `disconnected` 结束，不调 `onClose`。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
    this.finishAll();
  }

  private async readLoop(connection: DshWebSocketConnection): Promise<void> {
    for (;;) {
      let text: string;
      try {
        text = await connection.receive();
      } catch {
        break;
      }
      this.route(text);
    }
    if (this.closed || this.connection !== connection) return;
    this.closed = true;
    this.connection = undefined;
    connection.close();
    this.finishAll();
    await this.onClose?.();
  }

  /** 按 `streamId` 分发一帧。认不出的帧、没人要的流直接丢。 */
  route(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    const streamId = stringValue(frame.streamId);
    if (streamId === undefined) return;
    const queue = this.streams.get(streamId);
    if (!queue) return;
    switch (frame.type) {
      case "item":
        queue.push(frame.value ?? null);
        break;
      case "error": {
        this.streams.delete(streamId);
        const error = record(frame.error);
        queue.fail(
          DshWebError.streamFailed(
            stringValue(error.code),
            stringValue(error.message) ?? "流出错了",
          ),
        );
        break;
      }
      case "end":
        this.streams.delete(streamId);
        queue.finish();
        break;
      default:
        break;
    }
  }

  private finishAll(): void {
    const all = [...this.streams.values()];
    this.streams.clear();
    for (const queue of all) queue.fail(DshWebError.disconnected());
  }
}

/** 极简异步队列：`for await` 能消费，提前退出会触发 `onCancel`。 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private done = false;
  private failure: Error | undefined;
  private readonly onCancel: (() => void) | undefined;

  constructor(onCancel?: () => void) {
    this.onCancel = onCancel;
  }

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async nextValue(): Promise<T> {
    const result = await this.next();
    if (result.done) throw DshWebError.disconnected();
    return result.value;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.onCancel?.();
        this.finish();
        return { done: true, value: undefined };
      },
    };
  }
}

/** 一小段 JSON 文本（测试与日志用）。 */
export function encodeFrame(value: unknown): string {
  return JSON.stringify(value);
}
