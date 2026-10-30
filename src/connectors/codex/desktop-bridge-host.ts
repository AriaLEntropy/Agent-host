// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexDesktopBridgeHost.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConnectorError } from "../ported/contract.js";
import { encodeJSON, jsonObject, jsonPath, jsonString, parseJSON, type JSONValue } from "./json.js";
import { CodexBridgeRouter, type CodexBridgeDelivery } from "./bridge-router.js";
import { CodexAppServer } from "./app-server.js";
import type { CodexProcessHandle } from "./app-server.js";
import { CodexSubprocessLauncher } from "./subprocess.js";

/**
 * Published after the upstream's successful initialize response is forwarded to the desktop.
 * The containing directory is 0700, this file is 0600, and the token is never sent to Relay.
 */
export type CodexBridgeDescriptor = {
  port: number;
  token: string;
  pid: number;
  parentPID: number;
  instance: string;
};

/** `LocalHookServer.defaultSupportDirectory` 的移植。 */
export function botbusSupportDirectory(): string {
  if (process.platform === "linux") {
    const xdg = process.env["XDG_DATA_HOME"];
    const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
    return join(base, "botbus");
  }
  if (process.platform === "win32") {
    // `%LOCALAPPDATA%\BotBus`：不放 Roaming，漫游配置文件不该把一台电脑的配对与存档带到另一台上。
    const local = process.env["LOCALAPPDATA"];
    const base = local && local.length > 0 ? local : join(homedir(), "AppData", "Local");
    return join(base, "BotBus");
  }
  return join(homedir(), "Library", "Application Support", "BotBus");
}

const CODEX_BRIDGE_DEFAULT_DIRECTORY = join(botbusSupportDirectory(), "codex-desktop-bridge");

export const CodexBridgeDescriptor = {
  defaultDirectory: CODEX_BRIDGE_DEFAULT_DIRECTORY,

  read(directory: string = CODEX_BRIDGE_DEFAULT_DIRECTORY): CodexBridgeDescriptor | undefined {
    // PORT：Windows 的 ACL 与 POSIX mode 不可比，上游靠 0700/0600 判断安全；这里明确不读。
    if (process.platform === "win32") return undefined;
    const file = join(directory, "connection.json");
    try {
      const directoryMode = statSync(directory).mode;
      if ((directoryMode & 0o077) !== 0) return undefined;
      const fileMode = statSync(file).mode;
      if ((fileMode & 0o077) !== 0) return undefined;
      const parsed = jsonObject(parseJSON(readFileSync(file, "utf8")));
      if (!parsed) return undefined;
      const port = parsed["port"];
      const token = parsed["token"];
      const pid = parsed["pid"];
      const parentPID = parsed["parentPID"];
      const instance = parsed["instance"];
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
      if (typeof token !== "string" || token.length < 32) return undefined;
      if (typeof pid !== "number" || typeof parentPID !== "number" || typeof instance !== "string") return undefined;
      return { port, token, pid, parentPID, instance };
    } catch {
      return undefined;
    }
  },
};

type Hold = {
  promise: Promise<{ status: number; body: string; contentType: string }>;
  answer(value: { status: number; body: string; contentType: string }): boolean;
};

function jsonReply(value: JSONValue): { status: number; body: string; contentType: string } {
  return { status: 200, body: encodeJSON(value), contentType: "application/json" };
}

function textReply(status: number, body: string): { status: number; body: string; contentType: string } {
  return { status, body, contentType: "text/plain; charset=utf-8" };
}

function createHold(timeoutSeconds: number): Hold {
  let settled = false;
  let resolvePromise: ((value: { status: number; body: string; contentType: string }) => void) | undefined;
  const promise = new Promise<{ status: number; body: string; contentType: string }>((resolve) => {
    resolvePromise = resolve;
  });
  const timer = setTimeout(() => settle({ status: 200, body: "[]", contentType: "application/json" }), timeoutSeconds * 1000);
  timer.unref?.();
  const settle = (value: { status: number; body: string; contentType: string }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise?.(value);
  };
  return {
    promise,
    answer(value) {
      if (settled) return false;
      settle(value);
      return true;
    },
  };
}

/**
 * Executed as CODEX_CLI_PATH by the ChatGPT desktop. Its upstream process survives Agent
 * disconnections and holds the desktop thread writer locks for the desktop's lifetime.
 *
 * PORT：上游用 `LocalHookServer`（NWListener / POSIX socket 封装）。这里用
 * `node:http` 绑到 127.0.0.1:0，路由、Bearer token、Hold 语义保持一致；
 * 非 macOS 直接拒绝运行（桌面 app 的 CODEX_CLI_PATH 注入只在 macOS 存在）。
 */
export class CodexDesktopBridgeHost {
  private readonly executable: string;
  private readonly args: string[];
  private readonly environment: Record<string, string>;
  private readonly directory: string;
  private readonly instance = randomUUID();
  private readonly token = randomUUID() + randomUUID();
  private readonly router = new CodexBridgeRouter();
  private process: CodexProcessHandle | undefined;
  private server: Server | undefined;
  private port: number | undefined;
  private published = false;
  private agentQueue: JSONValue[] = [];
  private agentQueueBytes = 0;
  private pollHold: Hold | undefined;
  private closed = false;
  private stopDesktopInput: (() => void) | undefined;

  constructor(
    executable: string,
    args: string[],
    environment: Record<string, string>,
    directory: string = CodexBridgeDescriptor.defaultDirectory,
  ) {
    this.executable = executable;
    this.args = args;
    this.environment = environment;
    this.directory = directory;
  }

  async run(): Promise<number> {
    // PORT：桌面桥接依赖 macOS 桌面 app 注入与 POSIX 权限。非 macOS 明确失败，不空壳冒充成功。
    if (process.platform !== "darwin") {
      throw new ConnectorError("Codex 桌面桥接只在 macOS 上可用");
    }
    this.preparePrivateDirectory();
    const environment = { ...this.environment };
    delete environment["CODEX_CLI_PATH"];
    delete environment["BOTBUS_CODEX_REAL_CLI"];
    delete environment["BOTBUS_CODEX_BRIDGE_DIRECTORY"];
    const launcher = new CodexSubprocessLauncher(this.executable, this.args, environment);
    launcher.forwardStderr = true;
    const upstream = await launcher.launch();
    this.process = upstream;

    const server = createServer((request, response) => {
      void this.serve(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;

    const desktopInput = this.readDesktopInput();
    const upstreamReader = this.readUpstream(upstream);
    const exit = await upstream.waitForExit();
    this.closed = true;
    this.process = undefined;
    this.stopDesktopInput?.();
    this.stopDesktopInput = undefined;
    process.stdin.pause();
    await desktopInput;
    await upstreamReader;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.removeOwnDescriptor();
    this.pollHold?.answer(textReply(503, "bridge closed"));
    this.pollHold = undefined;
    return exit.status;
  }

  private readDesktopInput(): Promise<void> {
    return new Promise((resolve) => {
      const lines = new BridgeLineBuffer();
      let chain: Promise<void> = Promise.resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        resolve();
      };
      this.stopDesktopInput = finish;
      const onData = (chunk: Buffer) => {
        if (this.closed) return;
        for (const line of lines.append(chunk)) {
          const message = parseJSON(line.toString("utf8"));
          if (message === undefined) continue;
          chain = chain.then(() => this.acceptDesktop(message));
        }
      };
      const onEnd = () => {
        void chain.then(() => {
          this.desktopClosed();
          finish();
        });
      };
      process.stdin.on("data", onData);
      process.stdin.once("end", onEnd);
      process.stdin.resume();
    });
  }

  private desktopClosed(): void {
    this.process?.terminate();
  }

  private async readUpstream(upstream: CodexProcessHandle): Promise<void> {
    const lines = new BridgeLineBuffer();
    while (!this.closed) {
      let data: Uint8Array | null;
      try {
        data = await upstream.readStdout();
      } catch {
        break;
      }
      if (data === null) break;
      for (const line of lines.append(Buffer.from(data))) {
        const message = parseJSON(line.toString("utf8"));
        if (message === undefined) continue;
        await this.acceptUpstream(message);
      }
    }
  }

  private async acceptDesktop(message: JSONValue): Promise<void> {
    const deliveries = this.router.desktop(message);
    try {
      await this.deliver(deliveries);
    } catch {
      this.process?.terminate();
      return;
    }
    this.publishIfReady();
  }

  private async acceptUpstream(message: JSONValue): Promise<void> {
    const deliveries = this.router.upstream(message);
    try {
      await this.deliver(deliveries);
    } catch {
      this.process?.terminate();
      return;
    }
    this.publishIfReady();
  }

  private async deliver(deliveries: CodexBridgeDelivery[]): Promise<void> {
    for (const delivery of deliveries) {
      const line = Buffer.from(`${encodeJSON(delivery.message)}\n`, "utf8");
      switch (delivery.type) {
        case "upstream": {
          if (!this.process) throw new ConnectorError("Codex upstream 不可用");
          await this.process.writeStdin(line);
          break;
        }
        case "desktop":
          process.stdout.write(line);
          break;
        case "agent":
          this.queueForAgent(delivery.message, line.length);
          break;
      }
    }
  }

  private queueForAgent(message: JSONValue, bytes: number): void {
    if (this.pollHold) {
      const hold = this.pollHold;
      this.pollHold = undefined;
      if (hold.answer(jsonReply([message]))) return;
    }
    if (this.agentQueue.length >= 512 || this.agentQueueBytes + bytes > 32 * 1024 * 1024) {
      this.router.detach();
      this.agentQueue = [];
      this.agentQueueBytes = 0;
      return;
    }
    this.agentQueue.push(message);
    this.agentQueueBytes += bytes;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = await this.handle(request);
    response.writeHead(reply.status, { "Content-Type": reply.contentType });
    response.end(reply.body);
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body: string; contentType: string }> {
    if (request.headers.authorization !== `Bearer ${this.token}`) return textReply(401, "unauthorized");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = await readBody(request, CodexAppServer.maxLineBytes);
    if (body === undefined) return textReply(413, "body too large");
    switch (path) {
      case "/status":
        return jsonReply({ ready: this.router.ready, instance: this.instance });
      case "/connect": {
        const initialized = this.router.initializeResult;
        if (!this.router.ready || initialized === undefined) return textReply(503, "desktop handshake pending");
        const session = randomUUID();
        const pending = this.router.attach(session);
        this.agentQueue = pending;
        this.agentQueueBytes = pending.reduce<number>(
          (sum, message) => sum + Buffer.byteLength(encodeJSON(message), "utf8"),
          0,
        );
        this.pollHold?.answer(textReply(409, "replaced"));
        this.pollHold = undefined;
        return jsonReply({ session, initialize: initialized });
      }
      case "/send": {
        const payload = jsonObject(parseJSON(body.toString("utf8")));
        const session = jsonString(jsonPath(payload, "session"));
        const message = jsonPath(payload, "message");
        if (session === undefined || message === undefined) return textReply(400, "invalid message");
        let deliveries: CodexBridgeDelivery[];
        try {
          deliveries = this.router.agent(message, session);
        } catch {
          return textReply(409, "stale or unsupported command");
        }
        try {
          await this.deliver(deliveries);
          return jsonReply({});
        } catch {
          this.process?.terminate();
          return textReply(503, "Codex upstream unavailable");
        }
      }
      case "/poll": {
        const payload = jsonObject(parseJSON(body.toString("utf8")));
        if (jsonString(jsonPath(payload, "session")) !== this.router.agentSession) {
          return textReply(409, "stale session");
        }
        if (this.agentQueue.length > 0) {
          const batch = this.agentQueue;
          this.agentQueue = [];
          this.agentQueueBytes = 0;
          return jsonReply(batch);
        }
        // A timed-out or disconnected Hold can remain in this actor after its HTTP
        // response has finished. Settle the old poll before accepting the next one.
        if (this.pollHold) {
          const old = this.pollHold;
          this.pollHold = undefined;
          old.answer(jsonReply([]));
        }
        const hold = createHold(20);
        this.pollHold = hold;
        return hold.promise;
      }
      default:
        return textReply(404, "unknown route");
    }
  }

  private publishIfReady(): void {
    if (!this.router.ready || this.published || this.port === undefined) return;
    const descriptor: CodexBridgeDescriptor = {
      port: this.port,
      token: this.token,
      pid: process.pid,
      parentPID: process.ppid,
      instance: this.instance,
    };
    try {
      const file = join(this.directory, "connection.json");
      writeFileSync(file, encodeJSON(descriptor), { encoding: "utf8", mode: 0o600 });
      chmodSync(file, 0o600);
      this.published = true;
    } catch {
      // No descriptor means the Agent never attempts to attach to an unprotected endpoint.
    }
  }

  private preparePrivateDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const mode = statSync(this.directory).mode;
    if ((mode & 0o077) !== 0) throw new ConnectorError("Codex 桥接目录权限不是 0700");
  }

  private removeOwnDescriptor(): void {
    const file = join(this.directory, "connection.json");
    if (CodexBridgeDescriptor.read(this.directory)?.instance === this.instance) {
      try {
        unlinkSync(file);
      } catch {
        // 已经被别处删掉：忽略。
      }
    }
  }
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    request.on("error", () => resolve(undefined));
  });
}

/**
 * JSON lines; invalid oversized frames are discarded through their terminating newline.
 */
export class BridgeLineBuffer {
  private buffer = Buffer.alloc(0);
  private overflowing = false;

  append(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const result: Buffer[] = [];
    let index = this.buffer.indexOf(0x0a);
    while (index >= 0) {
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (!this.overflowing && line.length <= CodexAppServer.maxLineBytes) result.push(line);
      this.overflowing = false;
      index = this.buffer.indexOf(0x0a);
    }
    if (this.buffer.length > CodexAppServer.maxLineBytes) {
      this.buffer = Buffer.alloc(0);
      this.overflowing = true;
    }
    return result;
  }
}
