/**
 * OpenClaw 连接器冒烟测试：不启动真实 OpenClaw Gateway，也不读用户的 ~/.openclaw。
 *
 * 覆盖：JSON5 解析、配置读取、v4 握手帧、请求 ID 关联、事件映射、
 * chat.history 消息映射、审批 scope 映射、claimLive/reconcile、断线保留任务。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { after, describe, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { BusProject, BusTask, BusTaskMessages } from "../../src/bus/store.js";
import type { ConnectorHost } from "../../src/connectors/ported/contract.js";
import { OpenClawConfig, portValue } from "../../src/connectors/openclaw/config.js";
import {
  OpenClawConnector,
  openClawApprovalFrom,
  openClawGatewayDecision,
  openClawRunStatus,
  openClawScopeQuestion,
  openClawSessionFromRow,
  type OpenClawConnectorOptions,
} from "../../src/connectors/openclaw/connector.js";
import {
  OpenClawGateway,
  OpenClawGatewayError,
  OpenClawWebSocketTransport,
  type OpenClawGatewayConfiguration,
} from "../../src/connectors/openclaw/gateway.js";
import { Json5Error, parseJson5 } from "../../src/connectors/openclaw/json5.js";
import {
  createOpenClawConnector,
  createOpenClawMessageReader,
} from "../../src/connectors/openclaw/index.js";
import {
  OpenClawMessageReader,
  openClawRecordLimit,
} from "../../src/connectors/openclaw/message-reader.js";

const servers: FakeGateway[] = [];
after(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// 假 Gateway
// ---------------------------------------------------------------------------

type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type FakeResponse = {
  payload?: unknown;
  error?: { code?: string; message: string };
};

type FakeGatewayOptions = {
  challenge?: boolean;
  onRequest?: (frame: RequestFrame) => FakeResponse | undefined;
};

type FakeGateway = {
  port: number;
  url: string;
  frames: RequestFrame[];
  sockets: Set<WebSocket>;
  sendEvent: (event: string, payload?: unknown) => void;
  respond: (id: string, response: FakeResponse) => void;
  close: () => Promise<void>;
};

async function startFakeGateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;
  const frames: RequestFrame[] = [];
  const sockets = new Set<WebSocket>();

  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      let frame: RequestFrame;
      try {
        frame = JSON.parse(raw.toString()) as RequestFrame;
      } catch {
        return;
      }
      if (frame.type !== "req") return;
      frames.push(frame);
      const response = options.onRequest?.(frame);
      if (response) {
        send(
          socket,
          response.error
            ? { type: "res", id: frame.id, ok: false, error: response.error }
            : { type: "res", id: frame.id, ok: true, payload: response.payload ?? null },
        );
      }
    });
    if (options.challenge !== false) {
      setImmediate(() => send(socket, { type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    }
  });

  const server: FakeGateway = {
    port,
    url: `ws://127.0.0.1:${port}`,
    frames,
    sockets,
    sendEvent(event, payload) {
      for (const socket of sockets) send(socket, { type: "event", event, payload });
    },
    respond(id, response) {
      for (const socket of sockets) {
        send(
          socket,
          response.error
            ? { type: "res", id, ok: false, error: response.error }
            : { type: "res", id, ok: true, payload: response.payload ?? null },
        );
      }
    },
    async close() {
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // 已经关了。
        }
      }
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  servers.push(server);
  return server;
}

function hello(overrides: Record<string, unknown> = {}) {
  return { type: "hello-ok", protocol: 4, ...overrides };
}

function gatewayConfiguration(
  server: FakeGateway,
  overrides: Partial<OpenClawGatewayConfiguration> = {},
): OpenClawGatewayConfiguration {
  return {
    url: server.url,
    token: "secret-token",
    password: "secret-password",
    clientVersion: "test",
    requestTimeout: 1,
    connectTimeout: 1,
    challengeTimeout: 0.2,
    pingInterval: 0,
    ...overrides,
  };
}

async function waitFor<T>(
  probe: () => T | undefined | false | null,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = probe();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

// ---------------------------------------------------------------------------
// JSON5 / 配置
// ---------------------------------------------------------------------------

describe("openclaw json5", () => {
  test("parses comments, trailing commas, single quotes and bare keys", () => {
    const value = parseJson5(`
      // 用户手写的注释
      {
        gateway: {
          port: 18789, /* 端口 */
          auth: { token: '\${TOKEN}', password: "p//still-string", },
        },
        list: [1, 2, 3,],
        hex: 0x10,
        inf: Infinity,
        neg: -Infinity,
        nan: NaN,
        dotted: .5,
        'quoted key': "line\\
continued",
        $dollar_key: true,
      }
    `) as Record<string, any>;
    assert.equal(value.gateway.port, 18789);
    assert.equal(value.gateway.auth.token, "${TOKEN}");
    assert.equal(value.gateway.auth.password, "p//still-string");
    assert.deepEqual(value.list, [1, 2, 3]);
    assert.equal(value.hex, 16);
    assert.equal(value.inf, Infinity);
    assert.equal(value.neg, -Infinity);
    assert.ok(Number.isNaN(value.nan));
    assert.equal(value.dotted, 0.5);
    assert.equal(value["quoted key"], "linecontinued");
    assert.equal(value.$dollar_key, true);
  });

  test("rejects malformed input", () => {
    assert.throws(() => parseJson5("{a: }"), Json5Error);
    assert.throws(() => parseJson5("{a: 1} trailing"), Json5Error);
    assert.throws(() => parseJson5(""), Json5Error);
  });
});

describe("openclaw config", () => {
  test("reads port, secrets and workspace from JSON5", () => {
    const config = OpenClawConfig.parse(
      `{
        // 用户手改的配置
        gateway: {
          port: '19999',
          auth: { token: 'tok', password: '\${PW}', },
        },
        agents: { defaults: { workspace: '~/proj', }, },
      }`,
      {
        stateDirectory: join("C:", "tmp", "openclaw-state"),
        environment: { PW: "pw-env", OPENCLAW_GATEWAY_TOKEN: "env-token" },
      },
    );
    assert.equal(config.port, 19999);
    assert.equal(config.token, "tok");
    assert.equal(config.password, "pw-env");
    assert.equal(config.workspaceDirectory, join(homedir(), "proj"));
    assert.equal(config.gatewayURL, "ws://127.0.0.1:19999");
    assert.equal(config.displayAddress, "127.0.0.1:19999");
    assert.equal(config.toString().includes("token: tok"), false);
    assert.equal(config.toString().includes("password: pw-env"), false);
    assert.match(config.toString(), /<redacted>/);
  });

  test("environment port wins; missing file falls back to defaults", () => {
    const config = OpenClawConfig.parse("{ gateway: { port: 19999 } }", {
      stateDirectory: "/state",
      environment: { OPENCLAW_GATEWAY_PORT: " 20001 " },
    });
    assert.equal(config.port, 20001);

    const fallback = OpenClawConfig.parse("not json5 at all", {
      stateDirectory: "/state",
      environment: {},
    });
    assert.equal(fallback.port, 18789);
    assert.equal(fallback.workspaceDirectory, join("/state", "workspace"));
    assert.equal(fallback.token, undefined);
  });

  test("ignores SecretRef objects and validates ports", () => {
    const config = OpenClawConfig.parse(
      "{ gateway: { auth: { token: { source: 'env', id: 'X' } } } }",
      { stateDirectory: "/state", environment: { OPENCLAW_GATEWAY_TOKEN: "from-env" } },
    );
    assert.equal(config.token, "from-env");
    assert.equal(portValue(18789), 18789);
    assert.equal(portValue(" 8080 "), 8080);
    assert.equal(portValue(0), undefined);
    assert.equal(portValue(70000), undefined);
    assert.equal(portValue(true), undefined);
    assert.equal(portValue("1.5"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

describe("openclaw gateway", () => {
  test("performs the v4 handshake and sends the exact connect frame", async () => {
    const server = await startFakeGateway({
      onRequest: (frame) =>
        frame.method === "connect"
          ? { payload: hello() }
          : frame.method === "sessions.list"
            ? { payload: { sessions: [] } }
            : { payload: {} },
    });
    const gateway = new OpenClawGateway(
      new OpenClawWebSocketTransport(),
      gatewayConfiguration(server),
    );
    try {
      const payload = (await gateway.connect()) as Record<string, any>;
      assert.equal(payload.type, "hello-ok");
      assert.equal(payload.protocol, 4);

      const connectFrame = server.frames.find((frame) => frame.method === "connect");
      assert.ok(connectFrame);
      assert.equal(connectFrame.type, "req");
      const params = connectFrame.params!;
      assert.equal(params.minProtocol, 4);
      assert.equal(params.maxProtocol, 4);
      assert.equal(params.role, "operator");
      assert.deepEqual(params.scopes, [
        "operator.read",
        "operator.write",
        "operator.approvals",
      ]);
      assert.deepEqual(params.caps, ["tool-events", "exec-approvals"]);
      assert.equal(params.userAgent, "botbus/test");
      assert.deepEqual(params.client, {
        id: "gateway-client",
        displayName: "BotBus",
        version: "test",
        platform: "macos",
        mode: "backend",
      });
      assert.deepEqual(params.auth, { token: "secret-token", password: "secret-password" });

      assert.deepEqual(await gateway.request("sessions.list", { limit: 5 }), { sessions: [] });
      const listFrame = server.frames.find((frame) => frame.method === "sessions.list");
      assert.deepEqual(listFrame?.params, { limit: 5 });
    } finally {
      gateway.close();
      await server.close();
    }
  });

  test("waits for connect.challenge but falls back to connect without it", async () => {
    const server = await startFakeGateway({
      challenge: false,
      onRequest: (frame) => (frame.method === "connect" ? { payload: hello() } : undefined),
    });
    const gateway = new OpenClawGateway(
      new OpenClawWebSocketTransport(),
      gatewayConfiguration(server, { challengeTimeout: 0.02 }),
    );
    try {
      await gateway.connect();
      assert.equal(gateway.isConnected, true);
    } finally {
      gateway.close();
      await server.close();
    }
  });

  test("correlates responses by request id, including out-of-order and errors", async () => {
    const server = await startFakeGateway({
      onRequest: (frame) =>
        frame.method === "connect" ? { payload: hello() } : undefined,
    });
    const gateway = new OpenClawGateway(
      new OpenClawWebSocketTransport(),
      gatewayConfiguration(server),
    );
    try {
      await gateway.connect();
      const first = gateway.request("hold.one");
      const second = gateway.request("hold.two");
      await waitFor(
        () => server.frames.filter((frame) => frame.method.startsWith("hold.")).length === 2,
        "hold requests",
      );
      const one = server.frames.find((frame) => frame.method === "hold.one")!;
      const two = server.frames.find((frame) => frame.method === "hold.two")!;
      server.respond(two.id, { payload: { value: "two" } });
      server.respond(one.id, { payload: { value: "one" } });
      assert.deepEqual(await first, { value: "one" });
      assert.deepEqual(await second, { value: "two" });

      const failing = gateway.request("hold.fail");
      const failFrame = await waitFor(
        () => server.frames.find((frame) => frame.method === "hold.fail"),
        "fail request",
      );
      server.respond(failFrame.id, {
        error: { code: "INVALID_REQUEST", message: "bad request" },
      });
      await assert.rejects(failing, (error: unknown) => {
        assert.ok(error instanceof OpenClawGatewayError);
        assert.equal(error.kind, "requestFailed");
        assert.equal(error.code, "INVALID_REQUEST");
        return true;
      });
    } finally {
      gateway.close();
      await server.close();
    }
  });

  test("maps rejection and protocol mismatch during the handshake", async () => {
    const rejecting = await startFakeGateway({
      onRequest: (frame) =>
        frame.method === "connect"
          ? { error: { code: "AUTH_TOKEN_MISMATCH", message: "bad token" } }
          : undefined,
    });
    const rejectingGateway = new OpenClawGateway(
      new OpenClawWebSocketTransport(),
      gatewayConfiguration(rejecting),
    );
    try {
      await assert.rejects(rejectingGateway.connect(), (error: unknown) => {
        assert.ok(error instanceof OpenClawGatewayError);
        assert.equal(error.kind, "rejected");
        assert.equal(error.code, "AUTH_TOKEN_MISMATCH");
        return true;
      });
    } finally {
      rejectingGateway.close();
      await rejecting.close();
    }

    const mismatched = await startFakeGateway({
      onRequest: (frame) =>
        frame.method === "connect" ? { payload: hello({ protocol: 3 }) } : undefined,
    });
    const mismatchGateway = new OpenClawGateway(
      new OpenClawWebSocketTransport(),
      gatewayConfiguration(mismatched),
    );
    try {
      await assert.rejects(mismatchGateway.connect(), (error: unknown) => {
        assert.ok(error instanceof OpenClawGatewayError);
        assert.equal(error.kind, "protocolMismatch");
        return true;
      });
    } finally {
      mismatchGateway.close();
      await mismatched.close();
    }
  });

  test("buffers events and ends the stream with disconnected", async () => {
    const server = await startFakeGateway({
      onRequest: (frame) =>
        frame.method === "connect" ? { payload: hello() } : undefined,
    });
    const gateway = new OpenClawGateway(
      new OpenClawWebSocketTransport(),
      gatewayConfiguration(server),
    );
    try {
      await gateway.connect();
      const iterator = gateway.events[Symbol.asyncIterator]();
      server.sendEvent("chat", { sessionKey: "s", state: "delta" });
      const first = await iterator.next();
      assert.equal(first.done, false);
      assert.equal(first.value?.type, "event");
      if (first.value?.type === "event") {
        assert.equal(first.value.name, "chat");
        assert.deepEqual(first.value.payload, { sessionKey: "s", state: "delta" });
      }
      gateway.close();
      const second = await iterator.next();
      assert.equal(second.value?.type, "disconnected");
      const third = await iterator.next();
      assert.equal(third.done, true);
    } finally {
      gateway.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 消息映射
// ---------------------------------------------------------------------------

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString("base64");

describe("openclaw message reader", () => {
  test("maps chat.history records to protocol entries", async () => {
    let requestedLimit = 0;
    let requestedKey = "";
    const reader = new OpenClawMessageReader(async (sessionKey, limit) => {
      requestedKey = sessionKey;
      requestedLimit = limit;
      return {
        hasMore: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "image", data: PNG_BASE64, mimeType: "image/png" },
            ],
            timestamp: 1_700_000_000_000,
            __openclaw: { id: "u1" },
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "secret reasoning" },
              { type: "text", text: "line1" },
              { type: "text", text: "line2 saved /tmp/a.png" },
              { type: "toolCall", name: "bash", arguments: { command: " ls -la " } },
              { type: "toolCall", name: "read", input: '{"path":"/a/b/c.txt"}' },
            ],
            timestamp: 1_700_000_001_000,
            __openclaw: { id: "a1" },
          },
          {
            role: "toolResult",
            content: "a whole file",
            timestamp: 1_700_000_002_000,
          },
          {
            role: "user",
            runtimeContextCarrier: true,
            content: "system context",
            timestamp: 1_700_000_003_000,
          },
          {
            role: "assistant",
            content: "compaction marker",
            __openclaw: { kind: "compaction" },
            timestamp: 1_700_000_004_000,
          },
          {
            role: "user",
            content: [{ type: "text", text: "again" }],
            timestamp: 1_700_000_005_000,
            __openclaw: { seq: 7 },
          },
        ],
      };
    });

    const result = await reader.entries("openclaw:agent:main:main", 10);
    assert.equal(requestedKey, "agent:main:main");
    assert.equal(requestedLimit, openClawRecordLimit(10));
    assert.equal(result.hasMore, true);
    assert.deepEqual(
      result.entries.map((entry) => [entry.message.id, entry.message.role, entry.message.text]),
      [
        ["u1", "user", "hello"],
        ["a1", "agent", "line1\nline2 saved /tmp/a.png"],
        ["a1#1", "tool", "$ ls -la"],
        ["a1#2", "tool", "调用 read：c.txt"],
        ["seq-7", "user", "again"],
      ],
    );
    assert.equal(result.entries[0].images.length, 1);
    assert.equal(result.entries[0].images[0]?.type, "data");
    assert.deepEqual(result.entries[1].pathCandidates, ["/tmp/a.png"]);
    assert.equal(result.entries[0].message.createdAt, "2023-11-14T22:13:20Z");
  });

  test("deduplicates ids, skips synthetic rows and applies the window", async () => {
    const reader = new OpenClawMessageReader(async () => [
      { role: "user", content: "a", __openclaw: { id: "same" }, timestamp: 1 },
      { role: "user", content: "b", __openclaw: { id: "same" }, timestamp: 2 },
    ]);
    const all = await reader.entries("openclaw:k", 40);
    assert.deepEqual(
      all.entries.map((entry) => [entry.message.id, entry.message.text]),
      [
        ["same", "a"],
        ["same~1", "b"],
      ],
    );

    const limited = await reader.entries("openclaw:k", 1);
    assert.deepEqual(
      limited.entries.map((entry) => entry.message.text),
      ["b"],
    );
    assert.equal(limited.hasMore, true);

    await assert.rejects(reader.entries("not-openclaw:k", 10), /不属于 openclaw/);
    assert.equal(openClawRecordLimit(0), 16);
    assert.equal(openClawRecordLimit(100), 328);
  });
});

// ---------------------------------------------------------------------------
// 会话 / 审批映射
// ---------------------------------------------------------------------------

describe("openclaw session and approval mapping", () => {
  test("maps run status and session rows", () => {
    assert.equal(openClawRunStatus("running", false), "interrupted");
    assert.equal(openClawRunStatus("queued", undefined), "running");
    assert.equal(openClawRunStatus("done", undefined), "completed");
    assert.equal(openClawRunStatus("failed", undefined), "failed");
    assert.equal(openClawRunStatus("timeout", undefined), "failed");
    assert.equal(openClawRunStatus("killed", undefined), "interrupted");
    assert.equal(openClawRunStatus(undefined, undefined), "idle");

    const now = new Date("2026-01-01T00:00:00Z");
    const session = openClawSessionFromRow(
      {
        key: "agent:main:main",
        label: "  Demo  ",
        workspaceDir: "C:\\work\\demo",
        status: "running",
        hasActiveRun: false,
        lastMessagePreview: "working",
        updatedAt: now.getTime() - 1_000,
        createdAt: now.getTime() - 2_000,
      },
      "C:/workspace",
      now,
    );
    assert.ok(session);
    assert.equal(session.title, "Demo");
    assert.equal(session.projectPath, "C:\\work\\demo");
    assert.equal(session.runStatus, "interrupted");
    assert.equal(session.lastMessage, "working");
    assert.equal(session.startedAt.toISOString(), "2025-12-31T23:59:58.000Z");
    assert.equal(openClawSessionFromRow({ key: "" }, "/w", now), undefined);
    assert.equal(
      openClawSessionFromRow({ key: "k", archived: true }, "/w", now),
      undefined,
    );
  });

  test("maps exec approval payloads, including systemRunPlan fallbacks", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const approval = openClawApprovalFrom(
      {
        id: "ap1",
        request: {
          commandArgv: ["rm", "-rf", "/tmp/x"],
          cwd: "/tmp",
          systemRunPlan: { sessionKey: "agent:main:main" },
        },
        createdAtMs: now.getTime() - 1_000,
        expiresAtMs: now.getTime() + 60_000,
      },
      now,
    );
    assert.ok(approval);
    assert.equal(approval.sessionKey, "agent:main:main");
    assert.equal(approval.command, "rm -rf /tmp/x");
    assert.equal(approval.cwd, "/tmp");
    assert.equal(
      openClawApprovalFrom(
        { id: "ap2", sessionKey: "k", request: { command: "ls" }, expiresAtMs: now.getTime() },
        now,
      ),
      undefined,
    );
    assert.equal(openClawApprovalFrom({ id: "ap3", request: { command: "ls" } }, now), undefined);
  });

  test("maps approval scope to allow-once / allow-always", () => {
    assert.equal(openClawGatewayDecision("allow"), "allow-once");
    assert.equal(openClawGatewayDecision("allow", {}), "allow-once");
    assert.equal(openClawGatewayDecision("allow", { scope: ["只这一次"] }), "allow-once");
    assert.equal(openClawGatewayDecision("allow", { scope: ["以后都允许"] }), "allow-always");
    assert.equal(openClawGatewayDecision("deny", { scope: ["以后都允许"] }), "deny");
    assert.equal(
      openClawGatewayDecision("allow", { scope: ["以后都允许", "只这一次"] }),
      "allow-once",
    );
    assert.deepEqual(openClawScopeQuestion, {
      id: "scope",
      question: "允许范围",
      options: [
        { label: "只这一次" },
        {
          label: "以后都允许",
          description: "记进白名单，同样的命令以后不再问",
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 连接器：claimLive / 发布 / 审批 / 断线
// ---------------------------------------------------------------------------

class FakeHost implements ConnectorHost {
  readonly agentId = "host-test";
  readonly tasksById = new Map<string, BusTask>();
  readonly projects: BusProject[] = [];
  readonly live = new Set<string>();
  readonly emitted: BusTaskMessages[] = [];

  now(): string {
    return new Date().toISOString();
  }

  task(taskId: string): BusTask | undefined {
    return this.tasksById.get(taskId);
  }

  tasks(): readonly BusTask[] {
    return [...this.tasksById.values()];
  }

  upsert(task: BusTask): void {
    this.tasksById.set(task.id, { ...task });
  }

  remove(taskId: string): void {
    this.tasksById.delete(taskId);
    this.live.delete(taskId);
  }

  rememberProject(project: BusProject): void {
    this.projects.push(project);
  }

  rememberSession(): void {
    // 不适用。
  }

  emitMessages(messages: BusTaskMessages): void {
    this.emitted.push(messages);
  }

  claimLive(taskId: string): void {
    this.live.add(taskId);
  }

  releaseLive(taskId: string): void {
    this.live.delete(taskId);
  }

  isLive(taskId: string): boolean {
    return this.live.has(taskId);
  }
}

describe("openclaw connector", () => {
  test("index factories expose the connector and reader", () => {
    const host = new FakeHost();
    const connector = createOpenClawConnector(host, {
      autoStart: false,
      config: () => new OpenClawConfig({ port: 1 }),
    });
    assert.equal(connector.kind, "openclaw");
    assert.equal(connector.runsUnderBotBus, false);
    const reader = createOpenClawMessageReader({ fetch: async () => [] });
    assert.equal(reader.kind, "openclaw");
  });

  test("bootstraps, claims live tasks, resolves approvals and keeps tasks after disconnect", async () => {
    const now = Date.now();
    const row = {
      key: "agent:main:main",
      label: "Demo session",
      workspaceDir: "C:/work/demo",
      status: "running",
      hasActiveRun: true,
      lastMessagePreview: "working",
      updatedAt: now - 1_000,
      createdAt: now - 2_000,
    };
    const approval = {
      id: "ap1",
      request: { sessionKey: "agent:main:main", command: "rm -rf /tmp/x", cwd: "C:/work/demo" },
      createdAtMs: now - 500,
      expiresAtMs: now + 60_000,
    };
    const server = await startFakeGateway({
      onRequest: (frame) => {
        switch (frame.method) {
          case "connect":
            return { payload: hello() };
          case "sessions.subscribe":
            return { payload: { subscribed: true, list: { sessions: [row] } } };
          case "sessions.list":
            return { payload: { sessions: [row] } };
          case "exec.approval.list":
            return { payload: { approvals: [approval] } };
          case "exec.approval.resolve":
            return { payload: {} };
          case "chat.send":
          case "chat.abort":
            return { payload: {} };
          case "sessions.create":
            return { payload: { key: "agent:main:new", entry: { workspaceDir: "C:/work/new" } } };
          default:
            return { payload: {} };
        }
      },
    });

    const host = new FakeHost();
    const health: Array<{ status: string; error: string | null }> = [];
    const options: OpenClawConnectorOptions = {
      config: () =>
        new OpenClawConfig({
          port: server.port,
          token: "secret",
          workspaceDirectory: "C:/workspace",
        }),
      transport: new OpenClawWebSocketTransport(),
      timing: {
        initialBackoff: 30,
        maxBackoff: 30,
        refreshDelay: 0.05,
        refreshRetryDelay: 0.05,
        requestTimeout: 1,
        challengeTimeout: 0.5,
        pingInterval: 0,
      },
      onHealth: (status, error) => {
        health.push({ status, error });
      },
      autoStart: false,
    };
    const connector = new OpenClawConnector(host, options);
    try {
      connector.start();
      const taskId = "openclaw:agent:main:main";
      const task = await waitFor(() => host.task(taskId), "bootstrapped task");
      assert.equal(task.status, "waitingApproval");
      assert.equal(task.controllable, true);
      assert.equal(task.origin, "desktop");
      assert.equal(task.projectName, "demo");
      assert.equal(task.pendingRequest?.id, "ap1");
      assert.equal(task.pendingRequest?.kind, "command");
      assert.match(task.pendingRequest?.summary ?? "", /rm -rf/);
      assert.deepEqual(
        (task.pendingRequest as unknown as { questions?: unknown }).questions,
        [openClawScopeQuestion],
      );
      assert.equal(host.isLive(taskId), true);
      assert.equal(host.projects[0]?.path, "C:/work/demo");
      await waitFor(() => health.some((item) => item.status === "ok"), "health ok");

      const approved = await connector.approve(taskId, "ap1", "allow", {
        scope: ["以后都允许"],
      });
      assert.equal(approved.retainsLiveOwnership, true);
      const resolveFrame = await waitFor(
        () => server.frames.find((frame) => frame.method === "exec.approval.resolve"),
        "approval resolve frame",
      );
      assert.deepEqual(resolveFrame.params, { id: "ap1", decision: "allow-always" });
      const afterApproval = await waitFor(
        () => {
          const current = host.task(taskId);
          return current && current.pendingRequest === undefined ? current : undefined;
        },
        "approval cleared",
      );
      assert.equal(afterApproval.status, "running");

      const followed = await connector.followUp(taskId, "more", []);
      assert.equal(followed.retainsLiveOwnership, true);
      const sendFrame = await waitFor(
        () => server.frames.find((frame) => frame.method === "chat.send"),
        "chat.send frame",
      );
      assert.equal(sendFrame.params?.sessionKey, "agent:main:main");
      assert.equal(sendFrame.params?.message, "more");
      assert.equal(typeof sendFrame.params?.idempotencyKey, "string");

      server.sendEvent("chat", {
        sessionKey: "agent:main:main",
        state: "final",
        message: [{ type: "text", text: "done" }],
      });
      const finished = await waitFor(
        () => {
          const current = host.task(taskId);
          return current?.status === "completed" ? current : undefined;
        },
        "completed task",
      );
      assert.equal(finished.lastMessage, "done");

      const started = await connector.start("C:/work/new", "hello", []);
      assert.equal(started.taskId, "openclaw:agent:main:new");
      assert.equal(started.retainsLiveOwnership, true);
      const created = await waitFor(
        () => host.task("openclaw:agent:main:new"),
        "created task",
      );
      assert.equal(created.origin, "watch");
      assert.equal(created.title, "hello");
      assert.equal(created.projectPath, "C:/work/new");
      assert.equal(created.lastMessage, undefined);

      await assert.rejects(
        connector.start("C:/work/new", "with image", [
          { type: "file", path: "C:/tmp/a.png" },
        ]),
        /暂不支持发图/,
      );

      await server.close();
      await waitFor(
        () => health.some((item) => item.status === "degraded"),
        "health degraded",
      );
      const afterDisconnect = await waitFor(
        () => {
          const current = host.task(taskId);
          return current && current.controllable === false ? current : undefined;
        },
        "task retained but uncontrollable",
      );
      assert.equal(afterDisconnect.status, "completed");
      assert.equal(afterDisconnect.lastMessage, "done");
    } finally {
      await connector.stop();
      await server.close();
    }
  });
});
