import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, test } from "node:test";
import type { BusProject, BusTask, BusTaskMessages } from "../../src/bus/store.js";
import type { ConnectorHost } from "../../src/connectors/ported/contract.js";
import {
  AsyncQueue,
  DshConnector,
  createDshConnector,
  createDshMessageReader,
  DshLiveState,
  DshPaths,
  DshSessionFiles,
  DshSessionScanner,
  DshTaskMapping,
  DshTranscriptDecoder,
  DshTranscriptParser,
  eventsFrameFromJson,
  factsFromScanned,
  factsFromWeb,
  followFrameFromJson,
  isDshWeb,
  listeningPortsFromProcNet,
  sessionEventFromJson,
  summaryFromJson,
  turnEndReasonFromJson,
  usesHome,
  type AcpBackend,
  type DshAcpSpec,
  type DshConnectorOptions,
  type DshHTTPResponse,
  type DshHTTPTransport,
  type DshProcessListing,
  type DshQuestion,
  type DshSessionEvent,
  type DshWebSocketConnection,
  type DshWebSocketTransport,
  type DshWaterfall,
} from "../../src/connectors/dsh/native/index.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");

function event(type: string, seq: number, data: unknown = {}, extra: Record<string, unknown> = {}): DshSessionEvent {
  return { type, seq, data, time: new Date(NOW - 60_000), ...extra };
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushRepeatedly(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await flush();
}

// MARK: - DshTaskMapping

describe("dsh native task mapping", () => {
  const facts = {
    sessionId: "s1",
    cwd: "E:/work/demo",
    title: "Fix login",
    createdAt: new Date(NOW - 3_600_000),
    updatedAt: new Date(NOW - 60_000),
    webRunning: false,
    openTurnRecent: false,
  };

  test("maps facts to a running record and ages finished turns", () => {
    const live = new DshLiveState();
    live.apply(event("turn/start", 1, {}));
    live.apply(event("assistant/message", 2, { message: { content: [{ type: "text", text: "working" }] } }));
    const record = DshTaskMapping.record({ facts, live, controllable: true, now: new Date(NOW) });
    assert.equal(record.id, "dsh:s1");
    assert.equal(record.source, "dsh");
    assert.equal(record.status, "running");
    assert.equal(record.lastMessage, "working");
    assert.equal(record.projectName, "demo");
    assert.equal(record.controllable, true);
    assert.equal(record.origin, "desktop");

    const oldFacts = { ...facts, updatedAt: new Date(NOW - 30 * 3600 * 1000) };
    const aged = DshTaskMapping.record({ facts: oldFacts, controllable: true, now: new Date(NOW) });
    assert.equal(aged.status, "idle");
  });

  test("turns a waterfall approval with a bash call into a command request", () => {
    const live = new DshLiveState();
    live.apply(
      event("tool/call", 1, { callId: "c1", name: "bash", arguments: JSON.stringify({ command: "ls -la" }) }),
    );
    const waterfall: DshWaterfall = {
      eventId: "w1",
      sessionId: "s1",
      request: { type: "approval", toolName: "bash", callId: "c1", reason: "list files" },
    };
    const mapped = DshTaskMapping.pendingRequest(waterfall, live);
    assert.ok(mapped);
    assert.equal(mapped.status, "waitingApproval");
    assert.equal(mapped.request.id, "w1");
    assert.equal(mapped.request.kind, "command");
    assert.match(mapped.request.summary, /执行命令：ls -la/);
    assert.equal(mapped.request.detail, "list files");
  });

  test("maps questions and phone answers", () => {
    const questions: DshQuestion[] = [
      { id: "q1", question: "Where?", header: "Deploy", options: ["A", "B"], multiSelect: false },
      { id: "q2", question: "Why?", detail: "detail", options: ["x"], multiSelect: true },
    ];
    const waterfall: DshWaterfall = {
      eventId: "w2",
      sessionId: "s1",
      request: { type: "questions", questions },
    };
    const mapped = DshTaskMapping.pendingRequest(waterfall);
    assert.ok(mapped);
    assert.equal(mapped.status, "waitingInput");
    assert.equal(mapped.request.kind, "input");
    assert.equal(mapped.request.questions?.length, 2);
    assert.equal(mapped.request.questions?.[0]?.header, "Deploy");
    assert.match(mapped.request.question ?? "", /1\. A/);

    assert.deepEqual(DshTaskMapping.answers(questions, { q1: ["B"] })[0], { id: "q1", selected: ["B"] });
    assert.deepEqual(DshTaskMapping.answers(questions, { q1: ["typed"] })[0], {
      id: "q1",
      selected: [],
      custom: "typed",
    });
    assert.deepEqual(DshTaskMapping.answers(questions, { q2: ["x", "y"] })[1], {
      id: "q2",
      selected: ["x"],
      custom: "y",
    });
    assert.deepEqual(DshTaskMapping.skipped(questions), [
      { id: "q1", selected: [] },
      { id: "q2", selected: [] },
    ]);
    assert.deepEqual(DshTaskMapping.answersText(questions, "yes")[0], {
      id: "q1",
      selected: [],
      custom: "yes",
    });
  });

  test("merges ACP records: title and origin from ACP, newer status wins", () => {
    const base = [factsFromWeb({
      sessionId: "s1",
      updatedAt: new Date(NOW - 60_000),
      running: false,
      blank: false,
      cwd: "E:/work/demo",
      title: "web title",
    })];
    assert.ok(base[0]);
    const acp: BusTask = {
      id: "dsh:s1",
      agentId: "agent-1",
      source: "dsh",
      title: "ACP title",
      projectPath: "E:/work/demo",
      projectName: "demo",
      status: "completed",
      lastMessage: "acp done",
      origin: "watch",
      controllable: true,
      startedAt: new Date(NOW - 7_200_000).toISOString(),
      updatedAt: new Date(NOW - 30_000).toISOString(),
    };
    const merged = DshTaskMapping.merged({
      base: base as NonNullable<(typeof base)[number]>[],
      acp: [acp],
      live: new Map(),
      controllable: true,
      now: new Date(NOW),
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, "ACP title");
    assert.equal(merged[0].origin, "watch");
    assert.equal(merged[0].status, "completed");
    assert.equal(merged[0].lastMessage, "acp done");

    const onlyAcp = DshTaskMapping.merged({
      base: [],
      acp: [{ ...acp, id: "dsh:s2" }],
      live: new Map(),
      controllable: false,
      now: new Date(NOW),
    });
    assert.equal(onlyAcp.length, 1);
    assert.equal(onlyAcp[0].controllable, false);
  });
});

// MARK: - Transcript

describe("dsh native transcript", () => {
  const header = { type: "session", id: "s1", cwd: "E:/work/demo", createdAt: NOW - 60_000 };
  const events = [
    { type: "user/message", seq: 1, time: NOW - 50_000, data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "fix it" }] } },
    { type: "tool/call", seq: 2, time: NOW - 49_000, data: { callId: "c1", name: "bash", arguments: JSON.stringify({ command: "npm test" }) } },
    { type: "assistant/message", seq: 3, time: NOW - 48_000, data: { message: { id: "a1", content: [{ type: "text", text: "see `out/shot.png`" }] } } },
    { type: "assistant/message", seq: 4, time: NOW - 47_000, surfaceOp: { op: "replace" }, data: { message: { id: "a2", content: [{ type: "text", text: "replacement" }] } } },
    { type: "user/message", seq: 5, time: NOW - 46_000, data: { id: "u2", source: { kind: "plugin" }, content: [{ type: "text", text: "context" }] } },
    { type: "turn/start", seq: 6, time: NOW - 45_000, data: {} },
    { type: "turn/end", seq: 7, time: NOW - 44_000, data: { reason: { kind: "completed" } } },
  ];

  function jsonl(): string {
    return [header, ...events].map((item) => JSON.stringify(item)).join("\n") + "\n";
  }

  test("parses events, skips replacements and non-user context, adds path candidates", () => {
    const parsed = events.map((item) => sessionEventFromJson(item)).filter((item): item is DshSessionEvent => !!item);
    assert.equal(parsed.length, events.length);
    const window = DshTranscriptParser.window(parsed, 40);
    assert.deepEqual(window.entries.map((entry) => entry.message.role), ["user", "tool", "agent"]);
    assert.equal(window.entries[1].message.text, "$ npm test");
    assert.deepEqual(window.entries[2].pathCandidates, ["out/shot.png"]);
    assert.equal(DshTranscriptParser.lastAgentMessage(parsed), "see `out/shot.png`");
    assert.equal(DshTranscriptParser.hasOpenTurn(parsed), false);
    assert.equal(DshTranscriptParser.lastTurnEnd(parsed)?.reason.kind, "completed");
  });

  test("reads a plain log with header and tail", async () => {
    const dir = tempDir("dsh-native-log-");
    try {
      const file = join(dir, "session.v3.jsonl");
      writeFileSync(file, jsonl());
      const log = await new DshTranscriptDecoder({}).read(file);
      assert.equal(log.header?.id, "s1");
      assert.equal(log.events.length, events.length);
      assert.equal(log.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("decodes concatenated zstd frames and marks truncation", async () => {
    const dir = tempDir("dsh-native-zstd-");
    try {
      const lines = jsonl().trimEnd().split("\n");
      const first = zstdCompressSync(Buffer.from(lines.slice(0, 2).join("\n") + "\n", "utf8"));
      const second = zstdCompressSync(Buffer.from(lines.slice(2).join("\n") + "\n", "utf8"));
      const file = join(dir, "session.v3.jsonl.zstd");
      writeFileSync(file, Buffer.concat([first, second]));
      assert.equal(DshSessionFiles.isCompressed(file), true);

      const whole = await new DshTranscriptDecoder({}).read(file, 0);
      assert.equal(whole.header?.id, "s1");
      assert.equal(whole.events.length, events.length);
      assert.equal(whole.truncated, false);

      const tail = await new DshTranscriptDecoder({}).read(file, 1);
      assert.equal(tail.truncated, true);
      assert.ok(tail.events.length > 0);
      assert.equal(
        DshTranscriptParser.window(tail.events, 40, tail.truncated).hasMore,
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("decodes the embedded decoder output shape", () => {
    const body = JSON.stringify({ truncated: true }) + "\n" + JSON.stringify(header) + "\n" +
      JSON.stringify(events[0]) + "\n" + JSON.stringify(events[2]) + "\n";
    const log = DshTranscriptDecoder.parseDecoderOutput(Buffer.from(body, "utf8"));
    assert.equal(log.truncated, true);
    assert.equal(log.header?.id, "s1");
    assert.equal(log.events.length, 2);
  });
});

// MARK: - Scanner

describe("dsh native session scanner", () => {
  test("scans sessions, applies projection cache, skips subagent and blank", async () => {
    const home = tempDir("dsh-native-home-");
    const sessions = join(home, "sessions");
    try {
      mkdirSync(join(sessions, "--E-3A-work-demo--", "s1"), { recursive: true });
      mkdirSync(join(sessions, "--E-3A-work-demo--", "s2"), { recursive: true });
      mkdirSync(join(sessions, "--E-3A-work-demo--", "s3"), { recursive: true });
      const log = (id: string) =>
        JSON.stringify({ type: "session", id, cwd: "/fallback" }) + "\n" +
        JSON.stringify({ type: "turn/start", seq: 1, time: NOW - 1000, data: {} }) + "\n";
      const files = [
        join(sessions, "--E-3A-work-demo--", "s1", "session.v3.jsonl"),
        join(sessions, "--E-3A-work-demo--", "s2", "session.v3.jsonl"),
        join(sessions, "--E-3A-work-demo--", "s3", "session.v3.jsonl"),
      ];
      files.forEach((file, index) => {
        writeFileSync(file, log(`s${index + 1}`));
        utimesSync(file, new Date(NOW), new Date(NOW));
      });

      const cacheDir = join(home, "storages", "session_projcache", "sessions");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "s1.json"),
        JSON.stringify({
          record: {
            identity: { cwd: "E:/work/demo", createdAt: NOW - 3_600_000 },
            rows: {
              title: { val: "Fix login" },
              turnBoundary: { val: { lastTurn: 1, openTurnStartSeq: 1 } },
              sessionListMetadata: { val: { blank: false, lastPromptAt: NOW - 1000 } },
            },
          },
        }),
      );
      writeFileSync(
        join(cacheDir, "s3.json"),
        JSON.stringify({
          record: {
            identity: { cwd: "E:/work/demo" },
            rows: { sessionListMetadata: { val: { blank: true } } },
          },
        }),
      );
      // 缓存比日志新（与 web 写完缓存后的真实状态一致）。
      for (const name of ["s1.json", "s3.json"]) {
        utimesSync(join(cacheDir, name), new Date(NOW + 60_000), new Date(NOW + 60_000));
      }

      const scanner = new DshSessionScanner({
        paths: { sessionsDirectory: sessions, projectionCacheFile: (id) => join(cacheDir, `${id}.json`) },
        now: () => new Date(NOW),
        headers: async () =>
          new Map([
            [join(sessions, "--E-3A-work-demo--", "s2", "session.v3.jsonl"), { id: "s2", delegationDepth: 0, isSeeded: false, origin: "subagent" }],
          ]),
      });
      const found = await scanner.scan();
      assert.deepEqual(found.map((summary) => summary.sessionId), ["s1"]);
      const summary = found[0];
      assert.equal(summary.cwd, "E:/work/demo");
      assert.equal(summary.title, "Fix login");
      assert.equal(summary.hasOpenTurn, true);
      assert.equal(summary.createdAt?.getTime(), NOW - 3_600_000);
      assert.equal(summary.cacheIsStale, false);
      assert.ok(factsFromScanned(summary, new Date(NOW)).openTurnRecent);

      const ids = await DshSessionScanner.sessionIdsOnDisk(sessions);
      assert.deepEqual([...(ids ?? [])].sort(), ["s1", "s2", "s3"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// MARK: - Web messages

describe("dsh native web messages", () => {
  test("parses ready, emit, waterfall, cancel and follow frames", () => {
    const ready = eventsFrameFromJson({ type: "ready", clientId: "c1", host: { home: "/Users/me" } });
    assert.equal(ready.type, "ready");

    const emit = eventsFrameFromJson({ type: "emit", event: "api-session/status", args: ["s1", true] });
    assert.deepEqual(emit, { type: "emit", emit: { type: "status", sessionId: "s1", running: true } });

    const waterfall = eventsFrameFromJson({
      type: "waterfall",
      eventId: "w1",
      agentId: "s1",
      event: "user-questions/request",
      request: { questions: [{ id: "q1", question: "Pick", options: [{ label: "a" }], multiSelect: true }] },
    });
    assert.equal(waterfall.type, "waterfall");
    if (waterfall.type === "waterfall") {
      assert.equal(waterfall.waterfall.request.type, "questions");
      if (waterfall.waterfall.request.type === "questions") {
        assert.deepEqual(waterfall.waterfall.request.questions[0].options, ["a"]);
        assert.equal(waterfall.waterfall.request.questions[0].multiSelect, true);
      }
    }

    assert.deepEqual(eventsFrameFromJson({ type: "cancel", eventId: "w1" }), { type: "cancel", eventId: "w1" });
    assert.equal(eventsFrameFromJson({ type: "weird" }).type, "other");

    const follow = followFrameFromJson({
      type: "snapshot",
      header: { id: "s1", cwd: "E:/work/demo" },
      records: [{ type: "event", event: { type: "turn/end", seq: 2, data: { reason: { kind: "error", error: { message: "boom" } } } } }],
      hasMore: true,
    });
    assert.equal(follow.type, "snapshot");
    if (follow.type === "snapshot") {
      assert.equal(follow.events.length, 1);
      assert.equal(follow.events[0].type, "turn/end");
      assert.equal(follow.hasMore, true);
      assert.equal(turnEndReasonFromJson((follow.events[0].data as { reason: unknown }).reason).kind, "error");
    }
  });

  test("maps session summaries", () => {
    const summary = summaryFromJson({
      sessionId: "s1",
      updatedAt: NOW,
      running: true,
      blank: false,
      cwd: "E:/work/demo",
      projections: { values: { title: "T" }, asOfSeq: 9 },
    });
    assert.ok(summary);
    assert.equal(summary?.title, "T");
    assert.equal(summary?.asOfSeq, 9);
    assert.ok(factsFromWeb(summary!));
    assert.equal(factsFromWeb({ ...summary!, blank: true }), undefined);
  });

  test("locator helpers", () => {
    assert.equal(isDshWeb(["node", "/x/@deepseek-ai/dsh/lib/bin.js", "web"]), true);
    assert.equal(isDshWeb(["node", "/x/@deepseek-ai/dsh/lib/bin.js", "--profile", "web"]), true);
    assert.equal(isDshWeb(["npm", "exec", "@deepseek-ai/dsh", "web"]), false);
    assert.equal(usesHome({ DSH_HOME: "/tmp/.dsh" }, { home: "/tmp/.dsh" }), true);
    assert.equal(usesHome({ HOME: "/home/me" }, { home: "/home/me/.dsh" }), true);
    const ports = listeningPortsFromProcNet(
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
        "   0: 0100007F:0C6D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 12345 1\n" +
        "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 99999 1\n",
      new Set(["12345"]),
    );
    assert.deepEqual(ports, [3181]);
  });
});

// MARK: - Connector

class FakeHost implements ConnectorHost {
  readonly agentId = "agent-1";
  readonly tasksById = new Map<string, BusTask>();
  readonly projects: BusProject[] = [];
  readonly live = new Set<string>();
  readonly messages: BusTaskMessages[] = [];

  now(): string {
    return new Date(NOW).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  task(taskId: string): BusTask | undefined {
    return this.tasksById.get(taskId);
  }

  tasks(): readonly BusTask[] {
    return [...this.tasksById.values()];
  }

  upsert(task: BusTask): void {
    this.tasksById.set(task.id, task);
  }

  remove(taskId: string): void {
    this.tasksById.delete(taskId);
    this.live.delete(taskId);
  }

  rememberProject(project: BusProject): void {
    this.projects.push(project);
  }

  rememberSession(): void {}

  emitMessages(messages: BusTaskMessages): void {
    this.messages.push(messages);
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

class FakeAcp implements AcpBackend {
  spec: DshAcpSpec | undefined;
  readonly calls: string[] = [];
  readonly inProcess = new Set<string>();
  readonly running = new Set<string>();
  tasks: BusTask[] = [];

  async update(spec: DshAcpSpec): Promise<void> {
    this.spec = spec;
  }

  async start(): Promise<{ taskId: string; retainsLiveOwnership: boolean }> {
    this.calls.push("start");
    return { taskId: "dsh:acp-new", retainsLiveOwnership: true };
  }

  async followUp(taskId: string): Promise<{ taskId: string; retainsLiveOwnership: boolean }> {
    this.calls.push(`followUp:${taskId}`);
    return { taskId, retainsLiveOwnership: true };
  }

  async approve(taskId: string, requestId: string): Promise<{ taskId: string; retainsLiveOwnership: boolean }> {
    this.calls.push(`approve:${requestId}`);
    return { taskId, retainsLiveOwnership: true };
  }

  async interrupt(taskId: string): Promise<{ taskId: string; retainsLiveOwnership: boolean }> {
    this.calls.push(`interrupt:${taskId}`);
    return { taskId, retainsLiveOwnership: false };
  }

  isInProcess(taskId: string): boolean {
    return this.inProcess.has(taskId);
  }

  isRunningTurn(taskId: string): boolean {
    return this.running.has(taskId);
  }

  completeTranscript(): { entries: never[]; hasMore: boolean } | undefined {
    return undefined;
  }

  staticTasks(): readonly BusTask[] {
    return this.tasks;
  }

  noteSeen(): void {}

  forgetDeleted(): boolean {
    return false;
  }

  async stop(): Promise<void> {}
  async stopSubprocess(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class FakeClock {
  readonly entries: Array<{ ms: number; resolve: () => void }> = [];

  readonly sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      this.entries.push({ ms, resolve });
    });

  async advance(ms: number): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.ms === ms);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    entry.resolve();
    await flushRepeatedly();
  }
}

class FakeWeb {
  list: unknown[] = [];
  snapshotRecords: unknown[] = [];
  eventsStreamId: string | undefined;
  readonly followStreams = new Map<string, string>();

  readonly http: DshHTTPTransport = {
    post: async (_url, _headers, body): Promise<DshHTTPResponse> => {
      const envelope = JSON.parse(body.toString("utf8")) as {
        method: string;
        rpcId: string;
        payload: { args: Record<string, unknown> };
      };
      this.calls.push({ method: envelope.method, args: envelope.payload.args });
      const value = (() => {
        switch (envelope.method) {
          case "session/list":
            return { items: this.list };
          case "session/prompt":
            return { accepted: true };
          default:
            return {};
        }
      })();
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            type: "server-response",
            rpcId: envelope.rpcId,
            result: { ok: true, value },
          }),
          "utf8",
        ),
      };
    },
  };

  readonly calls: Array<{ method: string; args: unknown }> = [];
  readonly connections: FakeConnection[] = [];
  private readonly transport: DshWebSocketTransport;

  constructor() {
    this.transport = {
      connect: async () => {
        const connection = new FakeConnection(this);
        this.connections.push(connection);
        return connection;
      },
    };
  }

  get webSocket(): DshWebSocketTransport {
    return this.transport;
  }

  onOpen(connection: FakeConnection, frame: { streamId: string; endpoint: string; payload: { args: { request?: { address?: { sessionId?: string } } } } }): void {
    if (frame.endpoint === "$events") {
      this.eventsStreamId = frame.streamId;
      connection.push({ type: "item", streamId: frame.streamId, value: { type: "ready", clientId: "client-1" } });
      return;
    }
    if (frame.endpoint === "session/follow") {
      const sessionId = frame.payload.args.request?.address?.sessionId ?? "";
      this.followStreams.set(sessionId, frame.streamId);
      connection.push({
        type: "item",
        streamId: frame.streamId,
        value: {
          type: "snapshot",
          header: { id: sessionId },
          records: this.snapshotRecords,
          hasMore: false,
        },
      });
    }
  }

  eventsConnection(): FakeConnection {
    const connection = this.connections.at(-1);
    assert.ok(connection);
    return connection;
  }

  pushEvents(value: unknown): void {
    const streamId = this.eventsStreamId;
    assert.ok(streamId);
    this.eventsConnection().push({ type: "item", streamId, value });
  }

  pushFollow(sessionId: string, value: unknown): void {
    const streamId = this.followStreams.get(sessionId);
    assert.ok(streamId, `no follow stream for ${sessionId}`);
    this.eventsConnection().push({ type: "item", streamId, value });
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  call(method: string) {
    return this.calls.find((call) => call.method === method);
  }
}

class FakeConnection implements DshWebSocketConnection {
  private readonly inbox = new AsyncQueue<string>();
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(private readonly web: FakeWeb) {}

  async send(text: string): Promise<void> {
    const frame = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === "open") {
      this.web.onOpen(this, frame as unknown as Parameters<FakeWeb["onOpen"]>[1]);
    }
  }

  receive(): Promise<string> {
    return this.inbox.nextValue();
  }

  async sendPing(): Promise<void> {}

  close(): void {
    this.inbox.finish();
  }

  push(frame: unknown): void {
    this.inbox.push(JSON.stringify(frame));
  }
}

const INSTALLATION = {
  kind: "binary" as const,
  executable: "/fake/dsh",
  leadingArguments: [] as string[],
  version: null,
  node: "/fake/node",
};

const SESSION_LIST = [
  {
    sessionId: "s1",
    updatedAt: NOW - 60_000,
    running: true,
    blank: false,
    cwd: "E:/work/demo",
    projections: { values: { title: "Fix login" } },
  },
];

function setup(options: Partial<DshConnectorOptions> = {}) {
  const host = new FakeHost();
  const acp = new FakeAcp();
  const clock = new FakeClock();
  const web = new FakeWeb();
  web.list = SESSION_LIST;
  web.snapshotRecords = [{ type: "turn/start", seq: 1, time: NOW - 1000, data: {} }];
  const home = tempDir("dsh-native-connector-");
  const listing: DshProcessListing = { processes: () => [], listeningPorts: () => [] };
  const connector = new DshConnector(host, {
    paths: new DshPaths(home),
    installation: () => INSTALLATION,
    acp,
    http: web.http,
    webSocket: web.webSocket,
    listing,
    locateWeb: () => [{ pid: 42, ports: [3181], isDesktopHost: false }],
    loadSecret: () => Buffer.alloc(32, 7),
    now: () => new Date(NOW),
    sleep: clock.sleep,
    autoTick: false,
    ...options,
  });
  return { host, acp, clock, web, connector, home };
}

async function connected(options: Partial<DshConnectorOptions> = {}) {
  const context = setup(options);
  context.connector.startObserving();
  await context.connector.tick();
  await flushRepeatedly();
  return context;
}

describe("dsh native connector", () => {
  test("exports the factory functions from index", async () => {
    const home = tempDir("dsh-native-factory-");
    try {
      const host = new FakeHost();
      const connector = createDshConnector(host, {
        paths: new DshPaths(home),
        installation: () => null,
        acp: new FakeAcp(),
        autoTick: false,
      });
      assert.equal(connector.kind, "dsh");
      assert.equal(createDshMessageReader().kind, "dsh");
      await (connector as DshConnector).shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("routes start and followUp through the built-in ACP identity", async () => {
    const { host, acp, connector, web, home } = setup();
    try {
      connector.startObserving();
      const outcome = await connector.start("E:/work/demo", "hello", []);
      assert.equal(outcome.taskId, "dsh:acp-new");
      assert.deepEqual(acp.calls, ["start"]);
      assert.equal(acp.spec?.executable, "/fake/dsh");
      assert.deepEqual(acp.spec?.arguments, ["--profile", "acp"]);
      assert.equal(acp.spec?.environment.DSH_HOME, new DshPaths(home).home);

      acp.inProcess.add("dsh:s1");
      const followed = await connector.followUp("dsh:s1", "again", []);
      assert.equal(followed.taskId, "dsh:s1");
      assert.ok(acp.calls.includes("followUp:dsh:s1"));
      assert.equal(web.methods().includes("session/prompt"), false);

      acp.running.add("dsh:acp-1");
      await connector.approve("dsh:acp-1", "r1", "allow");
      assert.ok(acp.calls.includes("approve:r1"));
      await connector.interrupt("dsh:acp-1");
      assert.ok(acp.calls.includes("interrupt:dsh:acp-1"));

      await assert.rejects(
        connector.followUp("claude:x", "nope", []),
        /任务 id 不属于 DeepSeek Harness/,
      );
      assert.equal(host.tasks().length, 0);
    } finally {
      await connector.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("connects to web, routes followUp, approve and interrupt over web", async () => {
    const { host, connector, web, home } = await connected();
    try {
      assert.equal(connector.isWebConnected, true);
      assert.equal(connector.webPort, 3181);
      assert.deepEqual(web.methods(), ["session/list"]);

      // followUp over web marks the task live and sends session/prompt.
      await connector.followUp("dsh:s1", "hello", []);
      const prompt = web.call("session/prompt");
      assert.ok(prompt);
      assert.equal(((prompt!.args as any).request as any).sessionId, "s1");
      assert.equal(((prompt!.args as any).request as any).mode, "queue");
      assert.equal(((prompt!.args as any).request as any).requestId.startsWith("botbus-"), true);
      assert.equal(host.isLive("dsh:s1"), true);
      assert.equal(host.task("dsh:s1")?.status, "running");

      // Waterfall approval → $events/result with allowed-once.
      web.pushEvents({
        type: "waterfall",
        eventId: "w1",
        agentId: "s1",
        event: "approval/request",
        request: { toolName: "bash", callId: "c1", reason: "run tests" },
      });
      await flushRepeatedly();
      assert.equal(host.task("dsh:s1")?.status, "waitingApproval");
      assert.equal(host.task("dsh:s1")?.pendingRequest?.id, "w1");

      await connector.approve("dsh:s1", "w1", "allow");
      const answer = web.call("$events/result");
      assert.ok(answer);
      assert.equal(((answer!.args as any).outcome as any).value, "allowed-once");
      assert.equal(host.task("dsh:s1")?.pendingRequest, undefined);

      // Interrupt goes to session/cancel while the session is live.
      await connector.interrupt("dsh:s1");
      assert.ok(web.methods().includes("session/cancel"));

      // ACP turn wins over web.
      const acp = (connector as unknown as { acp: FakeAcp }).acp;
      acp.running.add("dsh:s1");
      await connector.interrupt("dsh:s1");
      assert.ok(acp.calls.includes("interrupt:dsh:s1"));
    } finally {
      await connector.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("owns a running web session and settles on status false with the grace timer", async () => {
    const events: Array<{ status: string; message?: string }> = [];
    const { host, connector, clock, web, home } = await connected({
      onHealth: (status, message) => {
        events.push({ status, message });
      },
    });
    try {
      assert.equal(host.isLive("dsh:s1"), true);
      assert.equal(host.task("dsh:s1")?.status, "running");
      assert.equal(events.at(-1)?.status, "ok");

      // status false before turn/end: wait for the 3s grace, then record interrupted and release.
      web.pushEvents({ type: "emit", event: "api-session/status", args: ["s1", false] });
      await flushRepeatedly();
      assert.equal(host.isLive("dsh:s1"), true);
      assert.equal(host.task("dsh:s1")?.status, "running");

      await clock.advance(3_000);
      assert.equal(host.isLive("dsh:s1"), false);
      assert.equal(host.task("dsh:s1")?.status, "interrupted");

      // A new running status re-claims; turn/end then status false settles immediately as completed.
      web.pushEvents({ type: "emit", event: "api-session/status", args: ["s1", true] });
      await flushRepeatedly();
      assert.equal(host.isLive("dsh:s1"), true);

      web.pushFollow("s1", {
        type: "event",
        event: { type: "turn/end", seq: 2, time: NOW - 500, data: { reason: { kind: "completed" } } },
      });
      await flushRepeatedly();
      // Still "running" from web's point of view; final message and turn end are recorded.
      web.pushEvents({ type: "emit", event: "api-session/status", args: ["s1", false] });
      await flushRepeatedly();
      assert.equal(host.isLive("dsh:s1"), false);
      assert.equal(host.task("dsh:s1")?.status, "completed");
    } finally {
      await connector.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("falls back to disk scanning when web is unavailable and reports degraded health", async () => {
    const health: Array<{ status: string; message?: string }> = [];
    const home = tempDir("dsh-native-offline-");
    const host = new FakeHost();
    const acp = new FakeAcp();
    const clock = new FakeClock();
    try {
      const sessionDir = join(home, "sessions", "--E-3A-work-demo--", "s9");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "session.v3.jsonl"),
        JSON.stringify({ type: "session", id: "s9", cwd: "E:/work/demo" }) + "\n" +
          JSON.stringify({ type: "turn/start", seq: 1, time: NOW - 1000, data: {} }) + "\n" +
          JSON.stringify({ type: "turn/end", seq: 2, time: NOW - 500, data: { reason: { kind: "completed" } } }) + "\n",
      );
      const connector = new DshConnector(host, {
        paths: new DshPaths(home),
        installation: () => null,
        acp,
        http: new FakeWeb().http,
        webSocket: new FakeWeb().webSocket,
        listing: { processes: () => [], listeningPorts: () => [] },
        locateWeb: () => [],
        loadSecret: () => null,
        now: () => new Date(NOW),
        sleep: clock.sleep,
        autoTick: false,
        onHealth: (status, message) => {
          health.push({ status, message });
        },
      });
      connector.startObserving();
      await connector.tick();
      await flushRepeatedly();
      assert.equal(host.task("dsh:s9")?.status, "completed");
      assert.equal(host.task("dsh:s9")?.controllable, false);
      assert.equal(health.at(-1)?.status, "degraded");
      assert.match(health.at(-1)?.message ?? "", /没找到 dsh 可执行文件/);
      await connector.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
