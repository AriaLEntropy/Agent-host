import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import {
  HermesMessageReader,
  HermesStateReader,
  HermesSourceUnavailable,
  HermesStreamReader,
  argumentsFor,
  createHermesConnector,
  entriesFromRow,
  injectedEnvironment,
  hermesPaths,
  type HermesLaunchRequest,
  type HermesProcessLauncher,
  type HermesRunningProcess,
} from "../../src/connectors/hermes/index.js";
import type { ConnectorHost, ImageSource } from "../../src/connectors/ported/contract.js";
import type { BusProject, BusTask, BusTaskMessages } from "../../src/bus/store.js";

const nowMs = Date.parse("2026-10-30T12:00:00Z");
const nowSeconds = nowMs / 1000;
const recent = nowSeconds - 3600;
const older = nowSeconds - 7200;
const day = 24 * 3600;

type Insert = (database: DatabaseSync) => void;

function createDatabase(path: string, statements: string[], insert: Insert): void {
  const database = new DatabaseSync(path);
  try {
    for (const statement of statements) database.exec(statement);
    insert(database);
  } finally {
    database.close();
  }
}

function insertSession(
  database: DatabaseSync,
  row: {
    id: string;
    cwd: string | null;
    title: string | null;
    started_at: number;
    ended_at: number | null;
    last_activity_at: number;
    end_reason: string | null;
    archived?: number | null;
    hidden?: number | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO sessions (id, cwd, title, started_at, ended_at, last_activity_at, end_reason, archived, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.cwd,
      row.title,
      row.started_at,
      row.ended_at,
      row.last_activity_at,
      row.end_reason,
      row.archived ?? 0,
      row.hidden ?? 0,
    );
}

function insertMessage(
  database: DatabaseSync,
  row: {
    id: string;
    session_id: string;
    role: string;
    content: string | null;
    timestamp: number;
    tool_calls?: string | null;
    finish_reason?: string | null;
    active?: number | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, finish_reason, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.session_id,
      row.role,
      row.content,
      row.timestamp,
      row.tool_calls ?? null,
      row.finish_reason ?? null,
      row.active ?? 1,
    );
}

const jsonPrefix = "\u0000json:";

function modernDatabase(path: string): void {
  createDatabase(
    path,
    [
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY, cwd TEXT, title TEXT, started_at REAL, ended_at REAL,
         last_activity_at REAL, end_reason TEXT, archived INTEGER, hidden INTEGER)`,
      `CREATE TABLE messages (
         id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content BLOB, timestamp REAL,
         tool_calls TEXT, finish_reason TEXT, active INTEGER)`,
    ],
    (database) => {
      insertSession(database, {
        id: "s1",
        cwd: "E:/work/demo",
        title: "Fix login",
        started_at: older,
        ended_at: recent,
        last_activity_at: recent,
        end_reason: null,
      });
      insertSession(database, {
        id: "s2",
        cwd: null,
        title: "",
        started_at: older,
        ended_at: null,
        last_activity_at: recent,
        end_reason: null,
      });
      insertSession(database, {
        id: "parent",
        cwd: "E:/work/demo",
        title: "Compressed parent",
        started_at: older - day,
        ended_at: recent,
        last_activity_at: recent,
        end_reason: "compression",
      });
      insertSession(database, {
        id: "archived",
        cwd: "E:/work/demo",
        title: "Archived",
        started_at: older,
        ended_at: recent,
        last_activity_at: recent,
        end_reason: null,
        archived: 1,
      });
      insertSession(database, {
        id: "hidden",
        cwd: "E:/work/demo",
        title: "Hidden",
        started_at: older,
        ended_at: recent,
        last_activity_at: recent,
        end_reason: null,
        hidden: 1,
      });
      insertSession(database, {
        id: "old",
        cwd: "E:/work/demo",
        title: "Old",
        started_at: nowSeconds - 10 * day,
        ended_at: nowSeconds - 10 * day,
        last_activity_at: nowSeconds - 10 * day,
        end_reason: null,
      });
      insertSession(database, {
        id: "failed",
        cwd: "E:/work/other",
        title: "Broke",
        started_at: older,
        ended_at: recent,
        last_activity_at: recent,
        end_reason: "agent_error",
      });

      insertMessage(database, {
        id: "m1",
        session_id: "s1",
        role: "user",
        content: "hello",
        timestamp: nowSeconds - 400,
      });
      insertMessage(database, {
        id: "m2",
        session_id: "s1",
        role: "assistant",
        content: "I'll check",
        timestamp: nowSeconds - 300,
        tool_calls: JSON.stringify([
          { type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "ls -la" }) } },
        ]),
        finish_reason: "tool_calls",
      });
      insertMessage(database, {
        id: "m3",
        session_id: "s1",
        role: "tool",
        content: "huge tool output",
        timestamp: nowSeconds - 200,
      });
      insertMessage(database, {
        id: "m4",
        session_id: "s1",
        role: "assistant",
        content: "done",
        timestamp: nowSeconds - 100,
        finish_reason: "stop",
      });
      insertMessage(database, {
        id: "m5",
        session_id: "s1",
        role: "user",
        content: "inactive branch",
        timestamp: nowSeconds - 50,
        active: 0,
      });

      insertMessage(database, {
        id: "s2m1",
        session_id: "s2",
        role: "user",
        content:
          `${jsonPrefix}[` +
          JSON.stringify({ type: "text", text: "look at this" }) +
          "," +
          JSON.stringify({
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
          }) +
          "]",
        timestamp: nowSeconds - 300,
      });
      insertMessage(database, {
        id: "s2m2",
        session_id: "s2",
        role: "assistant",
        content: "finishing",
        timestamp: nowSeconds - 200,
        finish_reason: "stop",
      });
    },
  );
}

const legacyStatements = [
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, started_at REAL, ended_at REAL)`,
  `CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT)`,
];

function legacyDatabase(path: string): void {
  createDatabase(path, legacyStatements, (database) => {
    database
      .prepare("INSERT INTO sessions (id, cwd, title, started_at, ended_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy", "E:/legacy/app", "Legacy session", older, recent);
    database
      .prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)")
      .run("a", "legacy", "user", "hi");
    database
      .prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)")
      .run("b", "legacy", "assistant", "hello");
  });
}

describe("hermes state reader", () => {
  test("hides compressed parents, archived/hidden/old sessions and tolerates missing columns", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-host-hermes-state-"));
    try {
      const databasePath = join(home, "state.db");
      modernDatabase(databasePath);
      const reader = new HermesStateReader({
        databasePath,
        fallbackDirectory: "E:/fallback",
        now: () => new Date(nowMs),
      });

      const { tasks, projects } = reader.readSnapshot("agent-1");
      const ids = tasks.map((task) => task.id).sort();
      assert.deepEqual(ids, ["hermes:failed", "hermes:s1", "hermes:s2"]);

      const s1 = tasks.find((task) => task.id === "hermes:s1");
      assert.ok(s1);
      assert.equal(s1.title, "Fix login");
      assert.equal(s1.projectPath, "E:/work/demo");
      assert.equal(s1.projectName, "demo");
      assert.equal(s1.status, "completed");
      assert.equal(s1.lastMessage, "done");
      assert.equal(s1.origin, "desktop");
      assert.equal(s1.controllable, true);

      const s2 = tasks.find((task) => task.id === "hermes:s2");
      assert.ok(s2);
      // 没有 cwd 的会话归到 fallback；标题取首条 user 文本。
      assert.equal(s2.projectPath, "E:/fallback");
      assert.equal(s2.title, "look at this");
      // ended_at 为空，但最后一条 assistant 是收尾类 finish_reason：算 completed 而不是 running。
      assert.equal(s2.status, "completed");

      const failed = tasks.find((task) => task.id === "hermes:failed");
      assert.ok(failed);
      assert.equal(failed.status, "failed");

      assert.deepEqual(
        projects.map((project) => project.path).sort(),
        ["E:/fallback", "E:/work/demo", "E:/work/other"].sort(),
      );
      assert.equal(reader.cwd("s2"), "E:/fallback");
      assert.equal(reader.cwd("s1"), "E:/work/demo");
      assert.equal(reader.cwd("missing"), undefined);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reads an old schema without last_activity_at / archived / hidden / end_reason", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-host-hermes-legacy-"));
    try {
      const databasePath = join(home, "state.db");
      legacyDatabase(databasePath);
      const reader = new HermesStateReader({
        databasePath,
        fallbackDirectory: "E:/fallback",
        now: () => new Date(nowMs),
      });
      const { tasks } = reader.readSnapshot("agent-1");
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.id, "hermes:legacy");
      assert.equal(tasks[0]?.title, "Legacy session");
      assert.equal(tasks[0]?.status, "completed");
      assert.equal(tasks[0]?.projectPath, "E:/legacy/app");
      assert.equal(tasks[0]?.lastMessage, "hello");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reports a missing database as unavailable", () => {
    const reader = new HermesStateReader({
      databasePath: join(tmpdir(), "agent-host-hermes-does-not-exist", "state.db"),
      now: () => new Date(nowMs),
    });
    assert.throws(() => reader.readSnapshot("agent-1"), HermesSourceUnavailable);
  });
});

describe("hermes message reader", () => {
  test("maps user / assistant / tool rows and skips tool output, system and inactive branches", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-host-hermes-messages-"));
    try {
      const databasePath = join(home, "state.db");
      modernDatabase(databasePath);
      const reader = new HermesMessageReader({ paths: () => hermesPaths(home) });

      const { entries, hasMore } = await reader.entries("hermes:s1", 40);
      assert.equal(hasMore, false);
      assert.deepEqual(
        entries.map((entry) => [entry.message.id, entry.message.role, entry.message.text]),
        [
          ["m1", "user", "hello"],
          ["m2", "agent", "I'll check"],
          ["m2#1", "tool", "terminal: ls -la"],
          ["m4", "agent", "done"],
        ],
      );
      assert.ok(entries.every((entry) => entry.pathCandidates.length === 0));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("agent replies carry path candidates; user and tool rows do not", () => {
    const agent = entriesFromRow({
      id: "a1",
      role: "assistant",
      content: "saved out/a.png and `src/b.jpg`",
      timestamp: 1,
    });
    assert.deepEqual(agent[0]?.pathCandidates, ["out/a.png", "src/b.jpg"]);

    const user = entriesFromRow({
      id: "u1",
      role: "user",
      content: "see out/a.png",
      timestamp: 1,
    });
    assert.deepEqual(user[0]?.pathCandidates, []);

    const withTool = entriesFromRow({
      id: "a2",
      role: "assistant",
      content: "done",
      timestamp: 1,
      tool_calls: JSON.stringify([
        { type: "function", function: { name: "read", arguments: JSON.stringify({ path: "out/a.png" }) } },
      ]),
    });
    assert.deepEqual(withTool[0]?.pathCandidates, []);
    assert.equal(withTool[1]?.message.role, "tool");
    assert.deepEqual(withTool[1]?.pathCandidates, []);
  });

  test("applies the conversation window (tools do not take a conversation slot)", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-host-hermes-window-"));
    try {
      modernDatabase(join(home, "state.db"));
      const reader = new HermesMessageReader({ paths: () => hermesPaths(home) });
      const { entries, hasMore } = await reader.entries("hermes:s1", 2);
      assert.equal(hasMore, true);
      // 最近两条对话是 m2 与 m4；m2 的工具行夹在窗口里，m1 被截掉。
      assert.deepEqual(
        entries.map((entry) => entry.message.id),
        ["m2", "m2#1", "m4"],
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("keeps a user message with a data-url image", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-host-hermes-image-"));
    try {
      modernDatabase(join(home, "state.db"));
      const reader = new HermesMessageReader({ paths: () => hermesPaths(home) });
      const { entries } = await reader.entries("hermes:s2", 40);
      const user = entries.find((entry) => entry.message.id === "s2m1");
      assert.ok(user);
      assert.equal(user.message.role, "user");
      assert.equal(user.message.text, "look at this");
      assert.equal(user.images.length, 1);
      const image = user.images[0];
      assert.ok(image && image.type === "data");
      assert.equal(image.contentType, "image/png");
      assert.ok(image.data.length > 0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("reads an old messages schema missing tool_calls / timestamp / active", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-host-hermes-messages-legacy-"));
    try {
      legacyDatabase(join(home, "state.db"));
      const reader = new HermesMessageReader({ paths: () => hermesPaths(home) });
      const { entries, hasMore } = await reader.entries("hermes:legacy", 40);
      assert.equal(hasMore, false);
      assert.deepEqual(
        entries.map((entry) => [entry.message.id, entry.message.role, entry.message.text]),
        [
          ["a", "user", "hi"],
          ["b", "agent", "hello"],
        ],
      );
      assert.equal(entries[0]?.message.createdAt, "1970-01-01T00:00:00Z");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rejects a task id from another connector", async () => {
    const reader = new HermesMessageReader({ paths: () => hermesPaths(tmpdir()) });
    await assert.rejects(() => reader.entries("codex:abc", 10), /任务 id 不属于 hermes/);
  });
});

describe("hermes connector seam", () => {
  test("builds the documented subprocess arguments", () => {
    assert.deepEqual(argumentsFor("fix it", "E:/work/demo"), [
      "chat",
      "-q",
      "fix it",
      "--format",
      "stream-json",
      "--in",
      "E:/work/demo",
    ]);
    assert.deepEqual(argumentsFor("-q looks like a flag", "E:/work/demo", "sess-1"), [
      "chat",
      "-q",
      "-q looks like a flag",
      "--format",
      "stream-json",
      "--in",
      "E:/work/demo",
      "--resume",
      "sess-1",
    ]);
  });

  test("injects the three BOTBUS variables plus the ephemeral system prompt", () => {
    const environment = injectedEnvironment({
      token: "token",
      environment: { BOTBUS_TOOLS_URL: "http://127.0.0.1:9000", BOTBUS_TASK_TOKEN: "token", BOTBUS_CLI: "/bin/botbus" },
      cliOnlyInstructions: "instructions",
    });
    assert.equal(environment.BOTBUS_TOOLS_URL, "http://127.0.0.1:9000");
    assert.equal(environment.BOTBUS_TASK_TOKEN, "token");
    assert.equal(environment.BOTBUS_CLI, "/bin/botbus");
    assert.equal(environment.HERMES_EPHEMERAL_SYSTEM_PROMPT, "instructions");
    assert.deepEqual(injectedEnvironment(undefined), {});
  });

  test("stream reader extracts the session id and tolerates unknown or broken lines", () => {
    const reader = new HermesStreamReader();
    const first = reader.consume(
      Buffer.from(
        `{"type":"unknown","x":1}\nnot json\n{"type":"system","subtype":"init","session_id":" sess-1 "}\n`,
      ),
    );
    assert.equal(first, "sess-1");
    reader.consume(Buffer.from(`{"type":"text","text":"looking"}\n`));
    reader.consume(Buffer.from(`{"type":"tool_use","name":"terminal"}\n`));
    reader.consume(Buffer.from(`{"type":"text","text":" final answer"}\n`));
    reader.consume(Buffer.from(`{"type":"result","exit_code":0,"text":" final answer"}\n`));
    const result = reader.finish(0);
    assert.equal(result.sessionID, "sess-1");
    assert.equal(result.lastText, "final answer");
    assert.equal(result.failed, false);
  });

  test("stream reader reports a failed result without a result line", () => {
    const reader = new HermesStreamReader();
    reader.consume(Buffer.from(`{"type":"system","subtype":"init","session_id":"s"}\n`));
    const result = reader.finish(2);
    assert.equal(result.sessionID, "s");
    assert.equal(result.failed, true);
    assert.match(result.errorMessage ?? "", /退出码 2/);
  });
});

class FakeHost implements ConnectorHost {
  readonly agentId = "agent-1";
  private readonly taskMap = new Map<string, BusTask>();
  private readonly live = new Set<string>();
  readonly emitted: BusTaskMessages[] = [];

  now(): string {
    return protocolNow;
  }

  task(taskId: string): BusTask | undefined {
    return this.taskMap.get(taskId);
  }

  tasks(): readonly BusTask[] {
    return [...this.taskMap.values()];
  }

  upsert(task: BusTask): void {
    this.taskMap.set(task.id, task);
  }

  remove(taskId: string): void {
    this.taskMap.delete(taskId);
  }

  rememberProject(_project: BusProject): void {}

  rememberSession(_taskId: string, _nativeSessionId: string, _catalog: "acp" | "dsh-acp"): void {}

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

const protocolNow = "2026-10-30T12:00:00Z";

class FakeLauncher implements HermesProcessLauncher {
  readonly requests: HermesLaunchRequest[] = [];
  interrupted = 0;
  terminated = 0;
  private output: ((data: Buffer) => void) | undefined;
  private exit: ((status: number) => void) | undefined;

  launch(
    request: HermesLaunchRequest,
    output: (data: Buffer) => void,
    exit: (status: number) => void,
  ): HermesRunningProcess {
    this.requests.push(request);
    this.output = output;
    this.exit = exit;
    output(Buffer.from(`{"type":"system","subtype":"init","session_id":"sess-1"}\n`));
    return {
      interrupt: () => {
        this.interrupted += 1;
      },
      terminate: () => {
        this.terminated += 1;
      },
    };
  }

  emitResult(payload: unknown, status: number): void {
    this.output?.(Buffer.from(`${JSON.stringify(payload)}\n`));
    this.exit?.(status);
  }
}

describe("hermes connector ownership", () => {
  test("start claims live ownership, interrupt wins over a later successful result, finish releases", async () => {
    const host = new FakeHost();
    const launcher = new FakeLauncher();
    let finished = 0;
    const connector = createHermesConnector(host, {
      paths: () => hermesPaths(tmpdir()),
      binary: () => "hermes",
      launcher,
      directoryProbe: async () => undefined,
      now: () => new Date(nowMs),
      tools: () => ({ cliPath: process.execPath, toolsURL: "http://127.0.0.1:9000" }),
      onRunFinished: () => {
        finished += 1;
      },
    });

    const outcome = await connector.start("E:/work/demo", "fix it", []);
    assert.deepEqual(outcome, { taskId: "sess-1", retainsLiveOwnership: true });
    assert.equal(host.isLive("hermes:sess-1"), true);
    assert.equal(host.task("hermes:sess-1")?.status, "running");
    assert.equal(host.task("hermes:sess-1")?.origin, "watch");
    assert.equal(host.task("hermes:sess-1")?.controllable, true);

    const request = launcher.requests[0];
    assert.ok(request);
    assert.deepEqual(request.arguments, argumentsFor("fix it", "E:/work/demo"));
    assert.equal(request.workingDirectory, "E:/work/demo");
    assert.equal(request.environment.BOTBUS_TOOLS_URL, "http://127.0.0.1:9000");
    assert.ok(request.environment.BOTBUS_TASK_TOKEN);
    assert.match(request.environment.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? "", /botbus/);

    const interrupted = await connector.interrupt("hermes:sess-1");
    assert.deepEqual(interrupted, { taskId: "sess-1", retainsLiveOwnership: true });
    assert.equal(launcher.interrupted, 1);
    assert.equal(host.task("hermes:sess-1")?.status, "interrupted");

    launcher.emitResult({ type: "result", exit_code: 0, text: "done" }, 0);
    assert.equal(host.task("hermes:sess-1")?.status, "interrupted");
    assert.equal(host.task("hermes:sess-1")?.lastMessage, "done");
    assert.equal(host.isLive("hermes:sess-1"), false);
    assert.equal(finished, 1);
  });

  test("approve reports that -q mode has no approval channel; images are rejected", async () => {
    const host = new FakeHost();
    const connector = createHermesConnector(host, {
      paths: () => hermesPaths(tmpdir()),
      binary: () => "hermes",
      directoryProbe: async () => undefined,
    });
    await assert.rejects(
      () => connector.approve("hermes:sess-1", "req-1", "allow"),
      /-q 模式没有审批通道/,
    );
    const images: ImageSource[] = [{ type: "file", path: "E:/tmp/shot.png" }];
    await assert.rejects(
      () => connector.start("E:/work/demo", "look", images),
      /这个 Agent 暂不支持发图/,
    );
  });

  test("refuses to resume a conversation that is running on the desktop", async () => {
    const host = new FakeHost();
    host.upsert({
      id: "hermes:sess-1",
      agentId: "agent-1",
      source: "hermes",
      title: "Desktop",
      projectPath: "E:/work/demo",
      projectName: "demo",
      status: "running",
      origin: "desktop",
      controllable: false,
      startedAt: protocolNow,
      updatedAt: protocolNow,
    });
    const connector = createHermesConnector(host, {
      paths: () => hermesPaths(tmpdir()),
      binary: () => "hermes",
      launcher: new FakeLauncher(),
      directoryProbe: async () => undefined,
    });
    await assert.rejects(
      () => connector.followUp("hermes:sess-1", "continue", []),
      /这个会话正在电脑上运行/,
    );
  });
});
