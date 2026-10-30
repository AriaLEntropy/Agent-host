/**
 * 连 OpenClaw Gateway（WebSocket 协议 v4）的一条连接：握手、按 id 配对请求与应答、把事件交给调用方。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/OpenClaw/OpenClawGateway.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * **一个实例只管一条连接**，断了就作废：重连由 `OpenClawConnector` 新建实例，
 * 这样「迟到的应答认错了连接」「旧连接的事件混进新连接」这类问题从结构上就不存在。
 *
 * 帧格式：
 * - 请求 `{type:"req", id, method, params?}`，应答 `{type:"res", id, ok, payload?, error?:{code,message}}`；
 * - 事件 `{type:"event", event, payload?, seq?}`。
 *
 * 握手：服务端先推 `connect.challenge`，客户端第一帧必须是 `connect` 请求，
 * 成功应答的 payload 是 `hello-ok`。我们走「回环 + 共享密钥 + gateway-client/backend」
 * 这条免设备签名的路，challenge 里的 nonce 用不上，只是等它到了再发
 * （最多等 challengeTimeout，老 Gateway 不发 challenge）。
 *
 * PORT: 上游用 URLSessionWebSocketTask，这里用 `ws`。单帧上限照上游调到 32 MiB：
 * Gateway 的帧上限是 25 MiB，而 `sessions.list` 或一页 `chat.history` 轻易超过
 * URLSession 默认的 1 MiB。
 */
import { WebSocket } from "ws";
import type { RawData } from "ws";
import { OpenClawConfig } from "./config.js";
import { integerValue, isRecord, stringValue } from "./values.js";

export type OpenClawGatewayErrorKind =
  /** WebSocket 都没建起来（Gateway 没跑、端口不对）。 */
  | "unreachable"
  /** `connect` 被拒：token 错、缺设备签名、配对未批准…… */
  | "rejected"
  /** `hello-ok` 报的协议版本不是 v4。 */
  | "protocolMismatch"
  /** 某个请求在时限内没等到应答。 */
  | "timedOut"
  /** 连接断了（对端关闭或本机 `close()`），在途请求一律以此结束。 */
  | "closed"
  /** 握手还没完成就发请求。 */
  | "notConnected"
  /** 请求送到了，Gateway 回了 `ok:false`。 */
  | "requestFailed";

export class OpenClawGatewayError extends Error {
  constructor(
    readonly kind: OpenClawGatewayErrorKind,
    message: string,
    /** Gateway 的 `error.code`（`AUTH_TOKEN_MISMATCH` 之类），本机错误为 undefined。 */
    readonly code?: string,
  ) {
    super(message);
    this.name = "OpenClawGatewayError";
  }
}

export class WebSocketClosed extends Error {
  constructor(
    readonly code: number,
    readonly reason: string = "",
  ) {
    super(`WebSocket closed (${code}${reason ? `: ${reason}` : ""})`);
    this.name = "WebSocketClosed";
  }
}

/** 一条已建立的 WebSocket 连接。对应上游 `WebSocketConnection`。 */
export interface WebSocketConnection {
  send(text: string): Promise<void>;
  /** 阻塞直到收到一帧文本；对端关闭时抛 `WebSocketClosed`。 */
  receiveText(): Promise<string>;
  sendPing(): Promise<void>;
  close(): void;
}

export interface WebSocketTransport {
  /** 完成握手后返回；握手被拒抛错。 */
  connect(url: string, headers: Record<string, string>): Promise<WebSocketConnection>;
}

export type OpenClawGatewayEvent =
  | { type: "event"; name: string; payload: unknown }
  | { type: "disconnected"; reason: string };

export type OpenClawGatewayConfiguration = {
  url: string;
  token?: string;
  password?: string;
  clientVersion: string;
  /** 普通请求的硬上限。 */
  requestTimeout: number;
  /** `connect` 请求的上限。 */
  connectTimeout: number;
  /** 等 `connect.challenge` 的上限；到点没来就直接发 `connect`。 */
  challengeTimeout: number;
  /** WebSocket ping 间隔（秒）；0 表示不发。 */
  pingInterval: number;
  /**
   * `connect` 的 `client.platform`。上游写死 `macos`；这里保留默认值以便逐帧核对，
   * 宿主可以按实际平台覆盖。
   */
  platform?: string;
};

export function openClawGatewayConfiguration(
  config: OpenClawConfig,
  clientVersion: string = defaultClientVersion(),
  overrides: Partial<OpenClawGatewayConfiguration> = {},
): OpenClawGatewayConfiguration {
  return {
    url: config.gatewayURL,
    token: config.token,
    password: config.password,
    clientVersion,
    requestTimeout: 15,
    connectTimeout: 10,
    challengeTimeout: 2,
    pingInterval: 30,
    ...overrides,
  };
}

/** 上游从 app bundle 取版本，缺省 `0.0.0`。 */
export function defaultClientVersion(): string {
  const version = process.env.AGENT_HOST_VERSION?.trim();
  return version && version.length > 0 ? version : "0.0.0";
}

type GatewayState = "idle" | "handshaking" | "connected" | "closed";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
};

/** 单消费者、无界缓冲的异步队列；事件与收到的帧都靠它排队。 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private ended = false;
  private error: Error | undefined;

  push(value: T) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  fail(error: Error) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.error) throw this.error;
    if (this.ended) return { value: undefined, done: true };
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

/** `ws` 连接的包装：把事件回调改成上游那样的阻塞 `receiveText()`。 */
export class NodeWebSocketConnection implements WebSocketConnection {
  private readonly incoming = new AsyncQueue<string>();
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: RawData, isBinary: boolean) => {
      this.incoming.push(
        Buffer.isBuffer(data)
          ? data.toString("utf8")
          : isBinary
            ? Buffer.from(data as ArrayBuffer).toString("utf8")
            : data.toString(),
      );
    });
    socket.on("close", (code, reason) => {
      this.closed = true;
      this.incoming.fail(new WebSocketClosed(code, reason.toString()));
    });
    socket.on("error", (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      this.incoming.fail(error);
    });
  }

  send(text: string): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket 已经关闭"));
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.send(text, (error) => (error ? reject(error) : resolve()));
    });
  }

  receiveText(): Promise<string> {
    return this.incoming.next().then((result) => {
      if (result.done) throw new WebSocketClosed(1006, "连接已关闭");
      return result.value;
    });
  }

  sendPing(): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket 已经关闭"));
    }
    return new Promise<void>((resolve, reject) => {
      this.socket.ping((error?: Error) => {
        if (!error) {
          resolve();
          return;
        }
        if (!this.closed) {
          this.closed = true;
          this.incoming.fail(error);
        }
        reject(error);
      });
    });
  }

  close(): void {
    this.closed = true;
    this.incoming.fail(new WebSocketClosed(1000, ""));
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000);
    }
  }
}

/**
 * 连 OpenClaw Gateway 用的 WebSocket 传输。和 `URLSessionWebSocketTransport`
 * 同一套握手（用 ping / open 逼出结果），只多一件事：把单帧上限调到 32 MiB。
 */
export class OpenClawWebSocketTransport implements WebSocketTransport {
  static readonly maximumMessageSize = 32 * 1024 * 1024;

  constructor(private readonly handshakeTimeoutMs = 8_000) {}

  connect(url: string, headers: Record<string, string>): Promise<WebSocketConnection> {
    const socket = new WebSocket(url, {
      headers,
      maxPayload: OpenClawWebSocketTransport.maximumMessageSize,
    });
    return new Promise<WebSocketConnection>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onUnexpected);
      };
      const timer = setTimeout(() => {
        cleanup();
        socket.terminate();
        reject(new Error("WebSocket 握手超时"));
      }, this.handshakeTimeoutMs);
      const onOpen = () => {
        cleanup();
        // 之后的 error 由 NodeWebSocketConnection 与调用方处理，避免 EventEmitter 抛未捕获错误。
        socket.on("error", () => undefined);
        resolve(new NodeWebSocketConnection(socket));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket 在握手前就关闭了"));
      };
      const onUnexpected = (_request: unknown, response: { statusCode?: number }) => {
        cleanup();
        socket.terminate();
        reject(new Error(`WebSocket 握手被拒绝：HTTP ${response.statusCode ?? "?"}`));
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpected as never);
    });
  }
}

/**
 * 一条 Gateway 连接。`connect()` 只能调一次；失败后实例作废。
 *
 * 事件流缓冲：握手与 `sessions.subscribe` 期间到达的事件先攒着，快照落定后
 * 再按序消费——文档要求「先装监听再订阅」，攒着就等于装好了。
 */
export class OpenClawGateway {
  static readonly protocolVersion = 4;
  static readonly clientId = "gateway-client";
  static readonly clientMode = "backend";
  static readonly scopes = ["operator.read", "operator.write", "operator.approvals"];
  /** `tool-events` 用不上，但不声明的话 Gateway 会裁剪手机发起任务的可用工具；`exec-approvals` 是真用。 */
  static readonly caps = ["tool-events", "exec-approvals"];

  private readonly eventsQueue = new AsyncQueue<OpenClawGatewayEvent>();
  private readonly inFlight = new Map<string, PendingRequest>();
  private state: GatewayState = "idle";
  private connection: WebSocketConnection | undefined;
  private nextRequestNumber = 1;
  private receiveTask: Promise<void> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private challengeSettled = false;
  private challengeResolve: ((value: unknown) => void) | undefined;
  private challengeReject: ((error: Error) => void) | undefined;
  private readonly challengePromise: Promise<unknown>;
  hello: unknown;

  constructor(
    private readonly transport: WebSocketTransport,
    private readonly configuration: OpenClawGatewayConfiguration,
  ) {
    this.challengePromise = new Promise<unknown>((resolve, reject) => {
      this.challengeResolve = resolve;
      this.challengeReject = reject;
    });
    // 连接在建立阶段就失败时，connect() 不会 await 这个 Promise；先挂一个
    // 空的 catch，免得它变成未处理的 rejection。
    void this.challengePromise.catch(() => undefined);
  }

  get events(): AsyncIterable<OpenClawGatewayEvent> {
    return this.eventsQueue;
  }

  get isConnected(): boolean {
    return this.state === "connected";
  }

  // MARK: - 握手

  /** 建连并完成 `connect` 握手，返回 `hello-ok` payload。 */
  async connect(): Promise<unknown> {
    if (this.state !== "idle") {
      throw new OpenClawGatewayError(
        "notConnected",
        "OpenClaw Gateway 连接已经用过，需要重新建立",
      );
    }
    this.state = "handshaking";
    let connection: WebSocketConnection;
    try {
      connection = await this.transport.connect(this.configuration.url, {});
    } catch {
      this.finish("连接失败");
      throw new OpenClawGatewayError("unreachable", this.unreachableMessage);
    }
    // 握手期间被 close()：迟到的连接不能留着。
    if (this.state !== "handshaking") {
      connection.close();
      throw new OpenClawGatewayError("closed", "OpenClaw Gateway 连接已关闭");
    }
    this.connection = connection;
    this.receiveTask = this.receiveLoop(connection);

    const challengeTimer = setTimeout(
      () => this.settleChallenge(null),
      Math.max(0, this.configuration.challengeTimeout) * 1000,
    );
    try {
      // nonce 只有设备签名才用得上；免签名的 backend 路径里只是「等服务端先开口」。
      await this.challengePromise;
      const payload = await this.perform(
        "connect",
        this.connectParams(),
        this.configuration.connectTimeout,
      );
      this.validateHello(payload);
      if (this.state !== "handshaking") {
        throw new OpenClawGatewayError("closed", "OpenClaw Gateway 连接已关闭");
      }
      this.hello = payload;
      this.state = "connected";
      this.startPing(connection);
      return payload;
    } catch (error) {
      let mapped: OpenClawGatewayError;
      if (error instanceof OpenClawGatewayError) {
        switch (error.kind) {
          case "requestFailed":
            mapped = new OpenClawGatewayError(
              "rejected",
              `OpenClaw Gateway 拒绝了连接：${error.message}`,
              error.code,
            );
            break;
          case "timedOut":
            mapped = new OpenClawGatewayError(
              "timedOut",
              `OpenClaw Gateway 握手超时（${this.address}）`,
            );
            break;
          case "closed":
            mapped = new OpenClawGatewayError("unreachable", this.unreachableMessage);
            break;
          default:
            mapped = error;
        }
      } else {
        mapped = new OpenClawGatewayError("unreachable", this.unreachableMessage);
      }
      this.close();
      throw mapped;
    } finally {
      clearTimeout(challengeTimer);
    }
  }

  /** `connect` 的 params。键必须都在 `ConnectParamsSchema` 里（闭合对象）。 */
  connectParams(): Record<string, unknown> {
    const auth: Record<string, unknown> = {};
    if (this.configuration.token !== undefined) auth["token"] = this.configuration.token;
    if (this.configuration.password !== undefined) auth["password"] = this.configuration.password;
    const version = this.configuration.clientVersion || "0.0.0";
    const params: Record<string, unknown> = {
      minProtocol: OpenClawGateway.protocolVersion,
      maxProtocol: OpenClawGateway.protocolVersion,
      client: {
        id: OpenClawGateway.clientId,
        displayName: "BotBus",
        version,
        platform: this.configuration.platform ?? "macos",
        mode: OpenClawGateway.clientMode,
      },
      role: "operator",
      scopes: [...OpenClawGateway.scopes],
      caps: [...OpenClawGateway.caps],
      userAgent: `botbus/${version}`,
    };
    if (Object.keys(auth).length > 0) params["auth"] = auth;
    return params;
  }

  /**
   * `hello-ok` 的形状只核两件事：确实是 hello（有 `type` 时），协议版本对得上
   * （有 `protocol` 时）。其余字段一概不强求——协议 v4 一直在加字段。
   */
  private validateHello(payload: unknown) {
    if (!isRecord(payload)) return;
    const type = stringValue(payload["type"]);
    if (type !== undefined && type !== "hello-ok") {
      throw new OpenClawGatewayError(
        "rejected",
        `OpenClaw Gateway 拒绝了连接：握手应答不是 hello-ok（${type}）`,
      );
    }
    const version = integerValue(payload["protocol"]);
    if (version !== undefined && version !== OpenClawGateway.protocolVersion) {
      throw new OpenClawGatewayError(
        "protocolMismatch",
        `OpenClaw Gateway 的协议版本是 v${version}，BotBus 只支持 v${OpenClawGateway.protocolVersion}，请升级两边中较旧的一方`,
      );
    }
  }

  private get address(): string {
    try {
      const url = new URL(this.configuration.url);
      return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    } catch {
      return this.configuration.url;
    }
  }

  private get unreachableMessage(): string {
    return `连不上 OpenClaw Gateway（${this.address}）`;
  }

  // MARK: - 请求

  /** 发一个请求并等应答的 payload（没有 payload 时给 null）。`ok:false` 抛 `requestFailed`。 */
  request(method: string, params?: unknown, timeout?: number): Promise<unknown> {
    if (this.state !== "connected") {
      return Promise.reject(
        new OpenClawGatewayError("notConnected", "OpenClaw Gateway 没有连上"),
      );
    }
    return this.perform(method, params, timeout ?? this.configuration.requestTimeout);
  }

  private perform(method: string, params: unknown, timeout: number): Promise<unknown> {
    const connection = this.connection;
    if (!connection) {
      return Promise.reject(
        new OpenClawGatewayError("notConnected", "OpenClaw Gateway 没有连上"),
      );
    }
    // id 用递增字符串：schema 要求非空字符串，一条连接内唯一就够了。
    const id = `botbus-${this.nextRequestNumber}`;
    this.nextRequestNumber += 1;
    let resolveRequest!: (value: unknown) => void;
    let rejectRequest!: (error: Error) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const timer = setTimeout(() => {
      // 超时与应答、断线共用同一个 Promise，谁先到谁算。
      if (!this.inFlight.delete(id)) return;
      rejectRequest(
        new OpenClawGatewayError(
          "timedOut",
          `OpenClaw Gateway 在 ${Math.round(timeout)} 秒内没有回应 ${method}`,
        ),
      );
    }, Math.max(0, timeout) * 1000);
    this.inFlight.set(id, { method, resolve: resolveRequest, reject: rejectRequest, timer });

    const frame: Record<string, unknown> = { type: "req", id, method };
    if (params !== undefined) frame["params"] = params;
    void connection.send(JSON.stringify(frame)).catch(() => {
      const pending = this.inFlight.get(id);
      if (!pending) return;
      this.inFlight.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new OpenClawGatewayError("closed", "OpenClaw Gateway 连接已断开"));
    });
    return promise;
  }

  // MARK: - 读

  private async receiveLoop(connection: WebSocketConnection): Promise<void> {
    try {
      while (true) {
        const text = await connection.receiveText();
        this.handle(text);
      }
    } catch (error) {
      if (error instanceof WebSocketClosed) {
        this.finish(
          error.reason.length > 0
            ? `连接被关闭（${error.code}：${error.reason}）`
            : `连接被关闭（${error.code}）`,
        );
      } else {
        this.finish("连接中断");
      }
      return;
    }
    this.finish("连接已关闭");
  }

  /** 一帧。解不出来、类型不认识的一律丢掉——协议在快速迭代，不能因为一个新帧型就断连。 */
  private handle(text: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    const type = stringValue(frame["type"]);
    if (type === "res") {
      const id = frameID(frame["id"]);
      if (id === undefined) return;
      const pending = this.inFlight.get(id);
      if (!pending) return;
      this.inFlight.delete(id);
      clearTimeout(pending.timer);
      if (frame["ok"] === true) {
        pending.resolve(frame["payload"] ?? null);
      } else {
        const error = isRecord(frame["error"]) ? frame["error"] : undefined;
        const message = stringValue(error?.["message"]) ?? "未知错误";
        pending.reject(
          new OpenClawGatewayError("requestFailed", message, stringValue(error?.["code"])),
        );
      }
      return;
    }
    if (type === "event") {
      const name = stringValue(frame["event"]);
      if (name === undefined) return;
      if (name === "connect.challenge") {
        this.settleChallenge(frame["payload"] ?? null);
        return;
      }
      if (this.state === "closed") return;
      this.eventsQueue.push({ type: "event", name, payload: frame["payload"] });
    }
  }

  private startPing(connection: WebSocketConnection) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const interval = this.configuration.pingInterval;
    if (!(interval > 0)) return;
    this.pingTimer = setInterval(() => {
      void connection.sendPing().catch(() => undefined);
    }, interval * 1000);
    this.pingTimer.unref?.();
  }

  // MARK: - 关闭

  /** 主动关闭。在途请求立即以 `closed` 结束，事件流收尾（最后一个事件是 `disconnected`）。幂等。 */
  close(): void {
    this.finish("连接已关闭");
  }

  private finish(reason: string) {
    if (this.state === "closed") return;
    const wasHandshaking = this.state === "handshaking";
    this.state = "closed";
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.connection?.close();
    this.connection = undefined;
    const error = new OpenClawGatewayError("closed", "OpenClaw Gateway 连接已断开");
    if (wasHandshaking) this.rejectChallenge(error);
    const taken = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const pending of taken) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.eventsQueue.push({ type: "disconnected", reason });
    this.eventsQueue.end();
  }

  private settleChallenge(value: unknown) {
    if (this.challengeSettled) return;
    this.challengeSettled = true;
    this.challengeResolve?.(value);
  }

  private rejectChallenge(error: Error) {
    if (this.challengeSettled) return;
    this.challengeSettled = true;
    this.challengeReject?.(error);
  }
}

/** 应答 id 我们发的是字符串；万一对端回成数字也认。 */
function frameID(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return undefined;
}
