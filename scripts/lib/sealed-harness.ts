import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { loadCommandLog, setCommandLogPath } from "../../src/bus/commands.js";
import type { Config } from "../../src/config.js";
import {
  clientProof,
  createClientCipher,
  deriveClaimToken,
  encodeBase64Url,
  generateMasterKey,
  hashClaimToken,
  type SecureCipher,
} from "../../src/tunnel/e2ee.js";
import { RelayClient } from "../../src/tunnel/relay-client.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = resolve(SCRIPT_DIR, "../..");
export const RELAY_DIR =
  process.env.AGENT_HOST_RELAY_DIR?.trim() ||
  resolve(SCRIPT_DIR, "../../../dsh-scan-remote/relay");
export const RELAY_UPSTREAM = "https://github.com/yukiykchen/dsh-scan-remote";

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

type PendingResponse = {
  resolve: (response: HttpResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  status?: number;
  headers: Record<string, string>;
  chunks: Buffer[];
};

export type Pairing = {
  masterKey: string;
  clientToken: string;
  hostId: string;
  hostToken: string;
};

export type Harness = {
  relayUrl: string;
  tunnel: SealedTunnel;
  commandLogPath?: string;
  hostPid?: number;
  restartHost?: () => Promise<void>;
  openTunnel(): Promise<SealedTunnel>;
  close(): Promise<void>;
};

type SocketState = {
  messages: Record<string, any>[];
  openWaiter?: {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  waiter?: {
    resolve: (value: Record<string, any>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  closed?: Error;
};

export class BusSocket {
  constructor(
    private readonly tunnel: SealedTunnel,
    private readonly channel: string,
    private readonly state: SocketState,
  ) {}

  next(timeoutMs = 5_000): Promise<Record<string, any>> {
    const queued = this.state.messages.shift();
    if (queued) return Promise.resolve(queued);
    if (this.state.closed) return Promise.reject(this.state.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.state.waiter = undefined;
        reject(new Error("timed out waiting for a websocket message"));
      }, timeoutMs);
      this.state.waiter = { resolve, reject, timer };
    });
  }

  close() {
    this.tunnel.closeSocket(this.channel);
  }
}

export type HarnessOptions = {
  relayUrl?: string;
  hostName?: string;
  commandLog?: boolean;
  dshPort?: number;
  hostProcess?: boolean;
};

export class SealedTunnel {
  private ws!: WebSocket;
  private cipher?: SecureCipher;
  private readonly handshake: Array<Record<string, any>> = [];
  private handshakeWaiter?: {
    resolve: (value: Record<string, any>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  private readonly pending = new Map<string, PendingResponse>();
  private readonly sockets = new Map<string, SocketState>();
  private channelCounter = 0;
  private socketCounter = 0;
  private closed?: Error;

  constructor(
    private readonly url: string,
    private readonly ticket: string,
    private readonly accessSessionId: string,
    private readonly masterKey: string,
  ) {}

  async connect() {
    this.ws = new WebSocket(this.url, {
      headers: { authorization: `Bearer ${this.ticket}` },
    });
    this.ws.on("message", (raw) => this.receive(raw.toString()));
    this.ws.on("error", (error) => this.fail(error));
    this.ws.on("close", (code, reason) =>
      this.fail(new Error(`tunnel closed (${code} ${reason.toString()})`)),
    );
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });

    const clientRandomB64 = encodeBase64Url(randomBytes(32));
    this.send({
      v: 1,
      type: "client_hello",
      id: randomUUID(),
      ts: Date.now(),
      payload: {
        accessSessionId: this.accessSessionId,
        clientRandomB64,
        clientProofB64: clientProof(this.masterKey, this.accessSessionId, clientRandomB64),
      },
    });
    const hello = await this.nextHandshake(5_000);
    if (hello.type !== "server_hello")
      throw new Error(`expected server_hello, got ${String(hello.type)}`);
    this.cipher = createClientCipher(
      this.masterKey,
      this.accessSessionId,
      clientRandomB64,
      hello.payload,
    );
  }

  request(
    method: string,
    path: string,
    body?: Buffer,
    timeoutMs = 5_000,
  ): Promise<HttpResponse> {
    if (this.closed) return Promise.reject(this.closed);
    if (!this.cipher) return Promise.reject(new Error("tunnel is not open"));
    const channel = `smoke-${++this.channelCounter}`;
    this.sendSealed({
      v: 1,
      type: "http_req",
      channel,
      id: randomUUID(),
      ts: Date.now(),
      payload: {
        method,
        path,
        headers: { accept: "application/json" },
        bodyB64: body ? body.toString("base64") : "",
      },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(channel);
        reject(new Error(`${method} ${path} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(channel, { resolve, reject, timer, headers: {}, chunks: [] });
    });
  }

  async openSocket(path: string, timeoutMs = 5_000): Promise<BusSocket> {
    if (this.closed) throw this.closed;
    if (!this.cipher) throw new Error("tunnel is not open");
    const channel = `ws-${++this.socketCounter}`;
    const state: SocketState = { messages: [] };
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.openWaiter = undefined;
        reject(new Error(`timed out opening websocket ${path}`));
      }, timeoutMs);
      state.openWaiter = { resolve, reject, timer };
    });
    this.sockets.set(channel, state);
    this.sendSealed({
      v: 1,
      type: "ws_open",
      channel,
      id: randomUUID(),
      ts: Date.now(),
      payload: { path, headers: {} },
    });
    await opened;
    return new BusSocket(this, channel, state);
  }

  closeSocket(channel: string) {
    const state = this.sockets.get(channel);
    if (!state) return;
    this.sockets.delete(channel);
    this.closeSocketState(state, new Error("socket closed"));
    try {
      this.sendSealed({
        v: 1,
        type: "ws_close",
        channel,
        id: randomUUID(),
        ts: Date.now(),
        payload: { code: 1000, reason: "client closed" },
      });
    } catch {}
  }

  async close() {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED) return;
    try {
      this.send({
        v: 1,
        type: "client_close",
        id: randomUUID(),
        ts: Date.now(),
        payload: { accessSessionId: this.accessSessionId },
      });
    } catch {}
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 500);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close(1000);
    });
  }

  private send(value: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
  }

  private sendSealed(inner: Record<string, any>) {
    if (!this.cipher) throw new Error("tunnel is not open");
    const sealed = this.cipher.seal(inner);
    this.send({
      v: 1,
      type: "sealed",
      id: randomUUID(),
      ts: Date.now(),
      payload: { accessSessionId: this.accessSessionId, ...sealed },
    });
  }

  private closeSocketState(state: SocketState, error: Error) {
    if (state.closed) return;
    state.closed = error;
    if (state.openWaiter) {
      clearTimeout(state.openWaiter.timer);
      state.openWaiter.reject(error);
      state.openWaiter = undefined;
    }
    if (state.waiter) {
      clearTimeout(state.waiter.timer);
      state.waiter.reject(error);
      state.waiter = undefined;
    }
  }

  private nextHandshake(timeoutMs: number): Promise<Record<string, any>> {
    const queued = this.handshake.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiter = undefined;
        reject(new Error("timed out waiting for server_hello"));
      }, timeoutMs);
      this.handshakeWaiter = { resolve, reject, timer };
    });
  }

  private receive(raw: string) {
    let outer: Record<string, any>;
    try {
      outer = JSON.parse(raw);
    } catch {
      this.fail(new Error("tunnel returned invalid JSON"));
      return;
    }
    if (outer.type === "server_hello") {
      if (this.handshakeWaiter) {
        const waiter = this.handshakeWaiter;
        this.handshakeWaiter = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(outer);
      } else {
        this.handshake.push(outer);
      }
      return;
    }
    if (outer.type === "device_close") {
      this.fail(new Error(`host closed the session: ${String(outer.payload?.reason)}`));
      return;
    }
    if (outer.type !== "sealed" || !this.cipher) return;
    let inner: Record<string, any>;
    try {
      inner = this.cipher.open(outer.payload) as Record<string, any>;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (inner.type === "ws_open_ok") {
      const state = this.sockets.get(inner.channel);
      if (state?.openWaiter) {
        clearTimeout(state.openWaiter.timer);
        state.openWaiter.resolve();
        state.openWaiter = undefined;
      }
      return;
    }
    if (inner.type === "ws_frame") {
      const state = this.sockets.get(inner.channel);
      if (!state || state.closed) return;
      const text = Buffer.from(inner.payload?.dataB64 ?? "", "base64").toString("utf8");
      let value: Record<string, any>;
      try {
        value = JSON.parse(text);
      } catch {
        value = { type: "raw", text };
      }
      if (state.waiter) {
        const waiter = state.waiter;
        state.waiter = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        state.messages.push(value);
      }
      return;
    }
    if (inner.type === "ws_close") {
      const channel = inner.channel;
      if (typeof channel !== "string") return;
      const state = this.sockets.get(channel);
      if (!state) return;
      this.sockets.delete(channel);
      this.closeSocketState(
        state,
        new Error(
          `websocket closed (${String(inner.payload?.code)} ${String(inner.payload?.reason ?? "")})`,
        ),
      );
      return;
    }
    if (inner.type !== "http_res") return;
    const pending = this.pending.get(inner.channel);
    if (!pending) return;
    if (typeof inner.payload?.status === "number") pending.status = inner.payload.status;
    if (inner.payload?.headers && typeof inner.payload.headers === "object")
      pending.headers = inner.payload.headers;
    if (typeof inner.payload?.bodyB64 === "string" && inner.payload.bodyB64)
      pending.chunks.push(Buffer.from(inner.payload.bodyB64, "base64"));
    if (inner.payload?.final === true) {
      clearTimeout(pending.timer);
      this.pending.delete(inner.channel);
      pending.resolve({
        status: pending.status ?? 502,
        headers: pending.headers,
        body: Buffer.concat(pending.chunks),
      });
    }
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = error;
    if (this.handshakeWaiter) {
      clearTimeout(this.handshakeWaiter.timer);
      this.handshakeWaiter.reject(error);
      this.handshakeWaiter = undefined;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const state of this.sockets.values()) this.closeSocketState(state, error);
    this.sockets.clear();
  }
}

export function jsonBody(response: HttpResponse): Record<string, any> {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    return {};
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForRelay(base: string, child: ChildProcess, logs: string[]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Relay exited early (${child.exitCode})\n${logs.join("")}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Relay did not start\n${logs.join("")}`);
}

async function post(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; data: Record<string, any> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { status: response.status, data };
}

async function pair(base: string, hostName: string): Promise<Pairing> {
  const masterKey = generateMasterKey();
  const claimToken = deriveClaimToken(masterKey);
  const session = await post(base, "/pair/session", {
    claimTokenHash: hashClaimToken(claimToken),
    hostName,
  });
  if (session.status !== 201)
    throw new Error(`pair/session returned ${session.status}: ${JSON.stringify(session.data)}`);
  const claimed = await post(base, "/pair/claim-device", {
    pairId: session.data.pairId,
    claimToken,
    deviceLabel: "Bus smoke client",
    platform: "android",
  });
  if (claimed.status !== 200)
    throw new Error(`pair/claim-device returned ${claimed.status}: ${JSON.stringify(claimed.data)}`);
  const confirmed = await post(base, "/pair/confirm", {
    pairId: session.data.pairId,
    confirmSecret: session.data.confirmSecret,
  });
  if (confirmed.status !== 200)
    throw new Error(`pair/confirm returned ${confirmed.status}: ${JSON.stringify(confirmed.data)}`);
  return {
    masterKey,
    clientToken: String(claimed.data.clientToken),
    hostId: String(confirmed.data.hostId),
    hostToken: String(confirmed.data.hostToken),
  };
}

async function waitForConnected(host: RelayClient) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (host.status().connected) return;
    await sleep(100);
  }
  throw new Error("host did not connect to Relay");
}

async function waitForHostOnline(base: string, clientToken: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ticket = await post(base, "/access-ticket", {}, clientToken);
    if (ticket.status === 200) return;
    await sleep(100);
  }
  throw new Error("host process did not connect to Relay");
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const hostName = options.hostName ?? "Bus Smoke Host";
  const relayArg =
    (options.relayUrl ?? process.env.AGENT_HOST_RELAY_URL)?.trim().replace(/\/$/, "") ||
    undefined;
  const local = !relayArg;
  let base = relayArg ?? "";
  let child: ChildProcess | undefined;
  let hostChild: ChildProcess | undefined;
  let dataDir: string | undefined;
  let host: RelayClient | undefined;
  const tunnels = new Set<SealedTunnel>();
  let pairing: Pairing | undefined;
  let commandLogPath: string | undefined;
  let restartHost: (() => Promise<void>) | undefined;
  let closed = false;
  const logs: string[] = [];

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const item of tunnels) await item.close().catch(() => undefined);
    tunnels.clear();
    host?.stop();
    if (hostChild) {
      hostChild.kill("SIGTERM");
      await sleep(100);
      if (hostChild.exitCode === null) hostChild.kill("SIGKILL");
      hostChild = undefined;
    }
    if (pairing) {
      await fetch(`${base}/host-management/${encodeURIComponent(pairing.hostId)}/unbind`, {
        method: "POST",
        headers: { authorization: `Host ${pairing.hostToken}` },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined);
    }
    if (child) {
      child.kill("SIGTERM");
      await sleep(100);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    dataDir = await mkdtemp(join(tmpdir(), "agent-host-smoke-"));
    if (options.commandLog || options.hostProcess) {
      commandLogPath = join(dataDir, "commands.json");
    }
    if (options.commandLog && !options.hostProcess) {
      setCommandLogPath(commandLogPath);
      await loadCommandLog();
    }

    if (local) {
      const entry = join(RELAY_DIR, "dist", "server.js");
      if (!existsSync(entry))
        throw new Error(
          [
            `Relay build not found at ${entry}.`,
            "This smoke test needs the Relay service (a separate repo, not part of Agent-host).",
            "Pick one:",
            `  1. clone ${RELAY_UPSTREAM} next to this repo, then: cd "${RELAY_DIR}" && npm install && npm run build`,
            `  2. point AGENT_HOST_RELAY_DIR at an existing checkout's relay/ folder (current: ${RELAY_DIR})`,
            "  3. set AGENT_HOST_RELAY_URL to an already-running Relay (no local build needed)",
            "Unit tests (npm test) and the build do not need any of this.",
          ].join("\n"),
        );
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, [entry], {
        cwd: RELAY_DIR,
        env: {
          ...process.env,
          NODE_ENV: "test",
          PORT: String(port),
          HOST: "127.0.0.1",
          DATABASE_PATH: join(dataDir, "relay.sqlite"),
          JWT_SECRET: randomBytes(48).toString("base64url"),
          ALLOW_LEGACY_WEB_PROXY: "0",
          PAIR_RATE_LIMIT_PER_MINUTE: "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
      child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
      await waitForRelay(base, child, logs);
      console.log(`Relay    ${base} (local, temporary database)`);
    } else {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`${base}/health returned ${response.status}`);
      console.log(`Relay    ${base}`);
    }

    pairing = await pair(base, hostName);
    console.log(`Pairing  host=${pairing.hostId}`);

    const config: Config = {
      hostId: pairing.hostId,
      hostToken: pairing.hostToken,
      e2eeMasterKey: pairing.masterKey,
      hostName,
      relay: base,
      dshPort: options.dshPort ?? 1,
    };
    if (options.hostProcess) {
      const configPath = join(dataDir, "config.json");
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const startHost = async () => {
        hostChild = spawn(process.execPath, ["dist/cli.js", "up"], {
          cwd: HOST_DIR,
          env: { ...process.env, AGENT_HOST_CONFIG: configPath },
          stdio: ["ignore", "pipe", "pipe"],
        });
        hostChild.stdout?.on("data", (chunk) => logs.push(String(chunk)));
        hostChild.stderr?.on("data", (chunk) => logs.push(String(chunk)));
        await waitForHostOnline(base, pairing.clientToken);
      };
      await startHost();
      restartHost = async () => {
        if (!hostChild) throw new Error("host process is not running");
        const previous = hostChild;
        previous.kill("SIGTERM");
        await Promise.race([
          new Promise<void>((resolve) => previous.once("exit", () => resolve())),
          sleep(3_000),
        ]);
        if (previous.exitCode === null) previous.kill("SIGKILL");
        await startHost();
      };
    } else {
      host = new RelayClient(config);
      await host.start();
      await waitForConnected(host);
    }

    const openTunnel = async (): Promise<SealedTunnel> => {
      if (!pairing) throw new Error("host is not paired");
      const ticket = await post(base, "/access-ticket", {}, pairing.clientToken);
      if (ticket.status !== 200)
        throw new Error(`access-ticket returned ${ticket.status}: ${JSON.stringify(ticket.data)}`);
      const created = new SealedTunnel(
        String(ticket.data.tunnelUrl),
        String(ticket.data.ticket),
        String(ticket.data.accessSessionId),
        pairing.masterKey,
      );
      await created.connect();
      tunnels.add(created);
      return created;
    };

    const tunnel = await openTunnel();
    return {
      relayUrl: base,
      tunnel,
      commandLogPath,
      get hostPid() {
        return hostChild?.pid;
      },
      restartHost,
      openTunnel,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function createChecks() {
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
    if (!ok) failures += 1;
  };
  return {
    check,
    finish() {
      if (failures > 0) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
      }
      console.log("\nAll checks passed");
    },
  };
}
