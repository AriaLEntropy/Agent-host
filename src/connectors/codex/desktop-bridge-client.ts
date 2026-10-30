// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexDesktopBridgeClient.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { ConnectorError } from "../ported/contract.js";
import { encodeJSON, jsonArray, jsonPath, jsonString, parseJSON, type JSONValue } from "./json.js";
import type { CodexProcessExit } from "./app-server-messages.js";
import type { CodexProcessHandle, CodexProcessLauncher } from "./app-server.js";
import type { CodexBridgeDescriptor } from "./desktop-bridge-host.js";

/**
 * 连桥接回环端口的会话配置。上游不带 URLCache，并设了 28/30 秒超时；
 * PORT：fetch 只有一条总超时，这里取 30 秒（资源上限）。
 */
export const codexBridgeSessionConfiguration = {
  requestTimeout: 28,
  resourceTimeout: 30,
};

class BridgeError extends Error {
  constructor(
    readonly kind: "closed" | "invalidMessage" | "rejected",
    message?: string,
    readonly status?: number,
  ) {
    super(message ?? kind);
    this.name = "CodexBridgeError";
  }
}

class BridgeOutputQueue {
  private readonly buffer: Buffer[] = [];
  private readonly waiters: Array<(chunk: Buffer | null) => void> = [];
  private closed = false;

  push(chunk: Buffer): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.buffer.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next(): Promise<Buffer | null> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function deferredExit(): { promise: Promise<CodexProcessExit>; resolve(value: CodexProcessExit): void } {
  let resolvePromise: ((value: CodexProcessExit) => void) | undefined;
  const promise = new Promise<CodexProcessExit>((resolve) => {
    resolvePromise = resolve;
  });
  let done = false;
  return {
    promise,
    resolve(value) {
      if (done) return;
      done = true;
      resolvePromise?.(value);
    },
  };
}

/** A virtual Codex process for the existing CodexAppServer parser. */
export class CodexBridgeProcessLauncher implements CodexProcessLauncher {
  constructor(readonly descriptor: CodexBridgeDescriptor) {}

  async launch(): Promise<CodexProcessHandle> {
    // PORT：桌面桥接依赖 macOS 桌面 app 注入的 CODEX_CLI_PATH、私有回环与 0700/0600 权限。
    // 非 macOS 上明确失败，不写空壳冒充可用。
    if (process.platform !== "darwin") {
      throw new ConnectorError("Codex 桌面桥接只在 macOS 上可用");
    }
    return new CodexBridgeProcessHandle(this.descriptor);
  }
}

class CodexBridgeProcessHandle implements CodexProcessHandle {
  private readonly state: CodexBridgeRemoteState;

  constructor(descriptor: CodexBridgeDescriptor) {
    this.state = new CodexBridgeRemoteState(descriptor);
  }

  readStdout(): Promise<Uint8Array | null> {
    return this.state.readStdout();
  }

  async writeStdin(data: Uint8Array): Promise<void> {
    const text = Buffer.from(data).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const message = parseJSON(line);
      if (message === undefined) throw new BridgeError("invalidMessage");
      await this.state.send(message);
    }
  }

  terminate(): void {
    void this.state.close();
  }

  waitForExit(): Promise<CodexProcessExit> {
    return this.state.waitForExit();
  }
}

/** 上游是 actor；JS 里所有方法都走同一个实例、await 串行，效果一致。 */
class CodexBridgeRemoteState {
  private readonly descriptor: CodexBridgeDescriptor;
  private readonly output = new BridgeOutputQueue();
  private readonly exit = deferredExit();
  private connecting: Promise<{ session: string; initialize: JSONValue }> | undefined;
  private handshake: { session: string; initialize: JSONValue } | undefined;
  private polling: Promise<void> | undefined;
  private closed = false;
  private abort: AbortController | undefined;

  constructor(descriptor: CodexBridgeDescriptor) {
    this.descriptor = descriptor;
  }

  async send(message: JSONValue): Promise<void> {
    if (this.closed) throw new BridgeError("closed");
    const handshake = await this.connect();
    const method = jsonString(jsonPath(message, "method"));
    if (method === "initialize") {
      const id = jsonPath(message, "id");
      if (id === undefined) throw new BridgeError("invalidMessage");
      this.emit({ id, result: handshake.initialize });
      return;
    }
    if (method === "initialized") {
      if (!this.polling) this.polling = this.pollLoop();
      return;
    }
    const payload: JSONValue = { session: handshake.session, message };
    await this.post("/send", payload);
  }

  readStdout(): Promise<Buffer | null> {
    return this.output.next();
  }

  private async connect(): Promise<{ session: string; initialize: JSONValue }> {
    if (this.handshake) return this.handshake;
    if (!this.connecting) {
      this.connecting = (async () => {
        const response = await this.post("/connect", {});
        const session = jsonString(jsonPath(response, "session"));
        const initialize = jsonPath(response, "initialize");
        if (session === undefined || initialize === undefined) throw new BridgeError("invalidMessage");
        return { session, initialize };
      })();
    }
    const value = await this.connecting;
    this.handshake = value;
    return value;
  }

  private async pollLoop(): Promise<void> {
    try {
      const session = (await this.connect()).session;
      while (!this.closed) {
        const response = await this.post("/poll", { session });
        const messages = jsonArray(response);
        if (!messages) throw new BridgeError("invalidMessage");
        for (const message of messages) this.emit(message);
      }
    } catch {
      this.closeWithStatus(-1);
    }
  }

  private async post(route: string, body: JSONValue): Promise<JSONValue> {
    if (this.closed) throw new BridgeError("closed");
    const controller = new AbortController();
    this.abort = controller;
    const timeout = setTimeout(() => controller.abort(), codexBridgeSessionConfiguration.resourceTimeout * 1000);
    timeout.unref?.();
    try {
      const response = await fetch(`http://127.0.0.1:${this.descriptor.port}${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.descriptor.token}`,
          "Content-Type": "application/json",
        },
        body: encodeJSON(body),
        signal: controller.signal,
      });
      if (response.status !== 200) throw new BridgeError("rejected", `bridge rejected ${response.status}`, response.status);
      const text = await response.text();
      const parsed = parseJSON(text);
      if (parsed === undefined) throw new BridgeError("invalidMessage");
      return parsed;
    } finally {
      clearTimeout(timeout);
      if (this.abort === controller) this.abort = undefined;
    }
  }

  private emit(message: JSONValue): void {
    if (this.closed) return;
    try {
      this.output.push(Buffer.from(`${encodeJSON(message)}\n`, "utf8"));
    } catch {
      // 编码失败的内容不推，等价于上游 `try?`。
    }
  }

  close(): Promise<void> {
    this.closeWithStatus(0);
    return Promise.resolve();
  }

  private closeWithStatus(status: number): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.output.close();
    this.exit.resolve({ status, reason: undefined });
  }

  waitForExit(): Promise<CodexProcessExit> {
    return this.exit.promise;
  }
}
