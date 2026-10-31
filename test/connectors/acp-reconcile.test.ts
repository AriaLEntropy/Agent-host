import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { busStore, type BusEvent } from "../../src/bus/store.js";
import { busHost } from "../../src/connectors/ported/host.js";
import {
  MAX_SESSIONS,
  openCodeTaskId,
} from "../../src/connectors/opencode/index.js";
import {
  executeCommand,
  reconcileAcpSessionsNow,
  resetRuntime,
  setAcpIdleReconcileInterval,
  setAcpReconcileInterval,
  setAcpReconcileLogger,
  useAgents,
} from "../../src/connectors/runtime.js";
import type { AgentSpec } from "../../src/connectors/discover.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const fake = process.execPath;

const SCHEMA = [
  `CREATE TABLE session (
     id TEXT PRIMARY KEY,
     parent_id TEXT,
     directory TEXT,
     title TEXT,
     time_created INTEGER NOT NULL,
     time_updated INTEGER NOT NULL,
     time_archived INTEGER
   )`,
  `CREATE TABLE message (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     time_created INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE TABLE part (
     id TEXT PRIMARY KEY,
     message_id TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
];

type SessionRow = {
  id: string;
  directory?: string | null;
  title?: string | null;
  created: number;
  updated: number;
  archived?: number | null;
};
type MessageRow = { id: string; sessionId: string; time: number; data: unknown };
type PartRow = { id: string; messageId: string; data: unknown };

function agentArgs() {
  const script = new URL("../fixtures/fake-acp.mjs", import.meta.url);
  return [script.pathname.replace(/^\/([A-Za-z]:)/, "$1")];
}

function makeSpec(overrides: Partial<AgentSpec> & { id: string }): AgentSpec {
  return {
    id: overrides.id,
    kind: "acp",
    name: overrides.id,
    executable: fake,
    args: agentArgs(),
    env: {},
    origin: "manifest",
    available: true,
    enabled: true,
    ...overrides,
  };
}

function reset() {
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
  // 大多数用例手动对账，避免真实计时器插进来。
  setAcpReconcileInterval(0);
  setAcpReconcileLogger(() => {});
  delete process.env.AGENT_HOST_OPENCODE_DB;
}

function createDatabase(
  path: string,
  sessions: SessionRow[],
  messages: MessageRow[] = [],
  parts: PartRow[] = [],
): void {
  const database = new DatabaseSync(path);
  try {
    for (const statement of SCHEMA) database.exec(statement);
    insertRows(database, sessions, messages, parts);
  } finally {
    database.close();
  }
}

function insertRows(
  database: DatabaseSync,
  sessions: SessionRow[],
  messages: MessageRow[] = [],
  parts: PartRow[] = [],
): void {
  const insertSession = database.prepare(
    `INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = database.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  const insertPart = database.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)");
  database.exec("BEGIN");
  for (const row of sessions) {
    insertSession.run(
      row.id,
      null,
      row.directory ?? null,
      row.title ?? null,
      row.created,
      row.updated,
      row.archived ?? null,
    );
  }
  for (const row of messages) {
    insertMessage.run(row.id, row.sessionId, row.time, JSON.stringify(row.data));
  }
  for (const row of parts) {
    insertPart.run(row.id, row.messageId, JSON.stringify(row.data));
  }
  database.exec("COMMIT");
}

function insertInto(path: string, sessions: SessionRow[], messages: MessageRow[] = [], parts: PartRow[] = []) {
  const database = new DatabaseSync(path);
  try {
    insertRows(database, sessions, messages, parts);
  } finally {
    database.close();
  }
}

async function writeList(path: string, sessions: unknown[]) {
  await writeFile(path, JSON.stringify({ sessions }));
}

function listed(sessionId: string, updatedAt: string, title?: string, cwd = "E:/work/demo") {
  return {
    sessionId,
    cwd,
    ...(title === undefined ? {} : { title }),
    updatedAt,
  };
}

function captureEvents() {
  const events: BusEvent[] = [];
  const stop = busStore.subscribe((event) => events.push(event));
  return { events, stop };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(read: () => boolean, timeoutMs = 5000) {
  const started = Date.now();
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await sleep(10);
  }
}

async function callCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).length;
  } catch {
    return 0;
  }
}

function taskShell(taskId: string) {
  const now = new Date().toISOString();
  return {
    id: taskId,
    agentId,
    source: "acp",
    connectorId: "opencode",
    title: "desktop session",
    projectPath: "E:/work/demo",
    projectName: "demo",
    status: "completed",
    origin: "desktop",
    controllable: true,
    startedAt: now,
    updatedAt: now,
  };
}

describe("acp reconcile", { concurrency: false }, () => {
  test("first session/list only baselines; later changes push", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-reconcile-"));
    try {
      const listPath = join(directory, "list.json");
      const updated = new Date(Date.now() - 60_000).toISOString();
      await writeList(listPath, [listed("s1", updated, "First")]);

      useAgents([
        makeSpec({
          id: "my-agent",
          env: { FAKE_ACP_LIST: "1", FAKE_ACP_LIST_FILE: listPath },
        }),
      ]);
      const { events, stop } = captureEvents();
      await reconcileAcpSessionsNow();

      const first = busStore.taskById("acp:my-agent:s1");
      assert.equal(first?.title, "First");
      assert.equal(first?.source, "acp");
      assert.equal(first?.connectorId, "my-agent");
      assert.equal(first?.projectName, "demo");
      assert.equal(first?.origin, "desktop");
      assert.equal(first?.status, "completed");
      assert.equal(first?.controllable, true);
      assert.equal(events.filter((event) => event.kind === "taskUpdated").length, 0);

      const second = new Date(Date.now() - 30_000).toISOString();
      await writeList(listPath, [listed("s1", updated, "Renamed"), listed("s2", second, "Second")]);
      events.length = 0;
      await reconcileAcpSessionsNow();

      assert.equal(busStore.taskById("acp:my-agent:s1")?.title, "Renamed");
      assert.equal(busStore.taskById("acp:my-agent:s2")?.title, "Second");
      const pushed = events
        .filter((event) => event.kind === "taskUpdated")
        .map((event) => event.task?.id)
        .sort();
      assert.deepEqual(pushed, ["acp:my-agent:s1", "acp:my-agent:s2"]);
      stop();
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("disappeared sessions are removed, but live ones are kept", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-live-"));
    const liveId = "acp:my-agent:s1";
    try {
      const listPath = join(directory, "list.json");
      const updated = new Date(Date.now() - 60_000).toISOString();
      await writeList(listPath, [
        listed("s1", updated),
        listed("s2", updated),
        listed("s3", updated),
      ]);
      useAgents([
        makeSpec({
          id: "my-agent",
          env: { FAKE_ACP_LIST: "1", FAKE_ACP_LIST_FILE: listPath },
        }),
      ]);
      await reconcileAcpSessionsNow();

      busHost.claimLive(liveId);
      await writeList(listPath, [listed("s2", updated)]);
      const { events, stop } = captureEvents();
      await reconcileAcpSessionsNow();

      assert.ok(busStore.taskById(liveId), "live task must survive a missing list entry");
      assert.ok(busStore.taskById("acp:my-agent:s2"));
      assert.equal(busStore.taskById("acp:my-agent:s3"), undefined);
      const removed = events.filter((event) => event.kind === "taskRemoved").map((event) => event.taskId);
      assert.deepEqual(removed, ["acp:my-agent:s3"]);
      stop();
    } finally {
      busHost.releaseLive(liveId);
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenCode scan merges database sessions and only pushes after the baseline", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-opencode-"));
    try {
      const databasePath = join(directory, "opencode.db");
      const nowMs = Date.now();
      createDatabase(
        databasePath,
        [
          { id: "ses-1", directory: "E:/work/demo", title: "desktop one", created: nowMs - 60_000, updated: nowMs - 30_000 },
        ],
        [
          { id: "m1", sessionId: "ses-1", time: nowMs - 40_000, data: { role: "user" } },
          {
            id: "m2",
            sessionId: "ses-1",
            time: nowMs - 30_000,
            data: { role: "assistant", time: { completed: nowMs - 30_000 } },
          },
        ],
        [
          { id: "p1", messageId: "m1", data: { type: "text", text: "hello" } },
          { id: "p2", messageId: "m2", data: { type: "text", text: "done" } },
        ],
      );
      process.env.AGENT_HOST_OPENCODE_DB = databasePath;

      useAgents([makeSpec({ id: "opencode", available: false, executable: undefined })]);
      const { events, stop } = captureEvents();
      await reconcileAcpSessionsNow();

      const first = busStore.taskById(openCodeTaskId("ses-1"));
      assert.equal(first?.agentId, agentId);
      assert.equal(first?.source, "acp");
      assert.equal(first?.connectorId, "opencode");
      assert.equal(first?.title, "desktop one");
      assert.equal(first?.projectName, "demo");
      assert.equal(first?.status, "completed");
      assert.equal(first?.lastMessage, "done");
      assert.equal(events.filter((event) => event.kind === "taskUpdated").length, 0);

      insertInto(
        databasePath,
        [{ id: "ses-2", directory: "E:/work/other", title: "desktop two", created: nowMs, updated: nowMs }],
        [{ id: "m3", sessionId: "ses-2", time: nowMs, data: { role: "assistant", time: { completed: nowMs } } }],
        [{ id: "p3", messageId: "m3", data: { type: "text", text: "second" } }],
      );
      events.length = 0;
      await reconcileAcpSessionsNow();

      assert.equal(busStore.taskById(openCodeTaskId("ses-2"))?.title, "desktop two");
      const pushed = events
        .filter((event) => event.kind === "taskUpdated")
        .map((event) => event.task?.id);
      assert.deepEqual(pushed, [openCodeTaskId("ses-2")]);
      stop();
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenCode coverageStart keeps older list entries and drops covered ones", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-coverage-"));
    try {
      const databasePath = join(directory, "opencode.db");
      const listPath = join(directory, "list.json");
      const nowMs = Date.now();
      const sessions: SessionRow[] = [];
      for (let index = 0; index < MAX_SESSIONS; index += 1) {
        sessions.push({
          id: `s-${String(index).padStart(3, "0")}`,
          directory: "/work/demo",
          title: `session ${index}`,
          created: nowMs - 200_000,
          updated: nowMs - index * 1000,
        });
      }
      createDatabase(databasePath, sessions);
      process.env.AGENT_HOST_OPENCODE_DB = databasePath;

      // coverageStart 是最旧那条（约 199 秒前）；比它更旧的列表项数据库没覆盖到，要保留。
      await writeList(listPath, [
        listed("old-listed", new Date(nowMs - 86_400_000).toISOString(), "older than coverage"),
        listed("new-listed", new Date(nowMs - 1000).toISOString(), "covered but absent"),
      ]);

      useAgents([
        makeSpec({
          id: "opencode",
          env: { FAKE_ACP_LIST: "1", FAKE_ACP_LIST_FILE: listPath },
        }),
      ]);
      const { events, stop } = captureEvents();
      await reconcileAcpSessionsNow();

      assert.ok(busStore.taskById(openCodeTaskId("old-listed")));
      assert.equal(busStore.taskById(openCodeTaskId("new-listed")), undefined);
      assert.ok(busStore.taskById(openCodeTaskId("s-000")));
      assert.equal(events.filter((event) => event.kind === "taskUpdated").length, 0);
      stop();
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fetchMessages reads OpenCode SQLite without a live process, then falls back to stored messages", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-fetch-"));
    try {
      const databasePath = join(directory, "opencode.db");
      const nowMs = Date.now();
      createDatabase(
        databasePath,
        [{ id: "ses-chat", directory: "E:/work/demo", title: "chat", created: nowMs - 10_000, updated: nowMs - 1000 }],
        [
          { id: "m1", sessionId: "ses-chat", time: nowMs - 9000, data: { role: "user" } },
          {
            id: "m2",
            sessionId: "ses-chat",
            time: nowMs - 1000,
            data: { role: "assistant", time: { completed: nowMs - 1000 } },
          },
        ],
        [
          { id: "p1", messageId: "m1", data: { type: "text", text: "from sqlite" } },
          { id: "p2", messageId: "m2", data: { type: "text", text: "answer" } },
        ],
      );
      process.env.AGENT_HOST_OPENCODE_DB = databasePath;

      const taskId = openCodeTaskId("ses-chat");
      busStore.upsertTask(taskShell(taskId));
      const { events, stop } = captureEvents();
      const result = await executeCommand({
        id: "cmd-fetch",
        kind: "fetchMessages",
        fetchMessages: { taskId },
      });
      assert.equal(result.ok, true);
      const emitted = events.filter((event) => event.kind === "taskMessages");
      assert.equal(emitted.length, 1);
      assert.deepEqual(
        emitted[0].taskMessages?.messages.map((message) => [message.role, message.text]),
        [
          ["user", "from sqlite"],
          ["agent", "answer"],
        ],
      );

      // 库读不了时回退到 store 里上次取到的记录。
      const fallbackId = openCodeTaskId("no-database");
      busStore.upsertTask(taskShell(fallbackId));
      busStore.emitTaskMessages({
        taskId: fallbackId,
        agentId,
        messages: [{ id: "stored", role: "agent", text: "stored copy", createdAt: new Date().toISOString() }],
        hasMore: false,
        fetchedAt: new Date().toISOString(),
      });
      process.env.AGENT_HOST_OPENCODE_DB = join(directory, "absent.db");
      events.length = 0;
      const fallback = await executeCommand({
        id: "cmd-fetch-fallback",
        kind: "fetchMessages",
        fetchMessages: { taskId: fallbackId },
      });
      assert.equal(fallback.ok, true);
      const fallbackEvents = events.filter((event) => event.kind === "taskMessages");
      assert.equal(fallbackEvents.length, 1);
      assert.equal(fallbackEvents[0].taskMessages?.messages[0]?.text, "stored copy");
      stop();
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an agent without list capability is skipped silently", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-nolist-"));
    try {
      const callsPath = join(directory, "calls.txt");
      useAgents([
        makeSpec({
          id: "no-list",
          env: { FAKE_ACP_LIST_CALLS: callsPath },
        }),
      ]);
      await reconcileAcpSessionsNow();
      assert.equal(await callCount(callsPath), 0);
      assert.equal(existsSync(callsPath), false);
      const tasks = busStore.snapshot().tasks as Array<{ connectorId?: string }>;
      assert.equal(tasks.filter((task) => task.connectorId === "no-list").length, 0);
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a failing session/list is skipped and logged only once", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-list-error-"));
    try {
      const messages: string[] = [];
      setAcpReconcileLogger((message) => messages.push(message));
      useAgents([
        makeSpec({
          id: "broken-list",
          env: { FAKE_ACP_LIST: "1", FAKE_ACP_LIST_ERROR: "1" },
        }),
      ]);
      await reconcileAcpSessionsNow();
      await reconcileAcpSessionsNow();

      assert.equal(messages.length, 1);
      assert.match(messages[0], /broken-list/);
      const tasks = busStore.snapshot().tasks as Array<{ connectorId?: string }>;
      assert.equal(tasks.filter((task) => task.connectorId === "broken-list").length, 0);
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a disabled agent stops reconciling", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-disable-"));
    try {
      const listPath = join(directory, "list.json");
      const callsPath = join(directory, "calls.txt");
      const updated = new Date(Date.now() - 60_000).toISOString();
      await writeList(listPath, [listed("s1", updated)]);
      const env = {
        FAKE_ACP_LIST: "1",
        FAKE_ACP_LIST_FILE: listPath,
        FAKE_ACP_LIST_CALLS: callsPath,
      };

      setAcpReconcileInterval(25);
      useAgents([makeSpec({ id: "my-agent", env })]);
      await until(() => busStore.taskById("acp:my-agent:s1") !== undefined);
      assert.ok((await callCount(callsPath)) > 0);

      useAgents([makeSpec({ id: "my-agent", env, enabled: false })]);
      // 让对账那一拍的中途调用落定，再比较计数。
      await sleep(150);
      const before = await callCount(callsPath);
      await sleep(150);
      const after = await callCount(callsPath);
      assert.equal(after, before);
      assert.ok(busStore.taskById("acp:my-agent:s1"));
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resetRuntime clears the reconcile timer", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-reset-"));
    try {
      const listPath = join(directory, "list.json");
      const callsPath = join(directory, "calls.txt");
      const updated = new Date(Date.now() - 60_000).toISOString();
      await writeList(listPath, [listed("s1", updated)]);

      setAcpReconcileInterval(25);
      useAgents([
        makeSpec({
          id: "my-agent",
          env: {
            FAKE_ACP_LIST: "1",
            FAKE_ACP_LIST_FILE: listPath,
            FAKE_ACP_LIST_CALLS: callsPath,
          },
        }),
      ]);
      await until(() => busStore.taskById("acp:my-agent:s1") !== undefined);

      resetRuntime();
      // 给在途的一拍留出收尾时间，之后计数不应再增长。
      await sleep(150);
      const before = await callCount(callsPath);
      await sleep(200);
      const after = await callCount(callsPath);
      assert.equal(after, before);
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an idle agent is only reconciled on the idle interval", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-idle-list-"));
    try {
      const listPath = join(directory, "list.json");
      const callsPath = join(directory, "calls.txt");
      const updated = new Date(Date.now() - 60_000).toISOString();
      await writeList(listPath, [listed("s1", updated)]);
      setAcpIdleReconcileInterval(10_000);
      useAgents([
        makeSpec({
          id: "my-agent",
          env: {
            FAKE_ACP_LIST: "1",
            FAKE_ACP_LIST_FILE: listPath,
            FAKE_ACP_LIST_CALLS: callsPath,
            FAKE_ACP_EXIT_AFTER_LIST: "1",
          },
        }),
      ]);
      // 手动跑第一拍；假 agent 回完列表就自己退出，模拟"没在跑"。
      await reconcileAcpSessionsNow();
      assert.equal(await callCount(callsPath), 1);
      await sleep(100);

      // 进程已经不在：接下来几拍都不该再为它拉起进程。
      setAcpReconcileInterval(20);
      await sleep(200);
      assert.equal(await callCount(callsPath), 1);

      // 把空闲节流调成跟运行周期一样，下一拍就会重试。
      setAcpIdleReconcileInterval(0);
      const started = Date.now();
      while ((await callCount(callsPath)) <= 1) {
        if (Date.now() - started > 5000) throw new Error("timed out");
        await sleep(10);
      }
    } finally {
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("enabling an agent reconciles it immediately", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-enable-"));
    process.env.AGENT_HOST_CONNECTOR_SETTINGS = join(directory, "connector-settings.json");
    try {
      const listPath = join(directory, "list.json");
      const updated = new Date(Date.now() - 60_000).toISOString();
      await writeList(listPath, [listed("s1", updated)]);
      useAgents([
        makeSpec({
          id: "my-agent",
          env: { FAKE_ACP_LIST: "1", FAKE_ACP_LIST_FILE: listPath },
          enabled: false,
        }),
      ]);
      assert.equal(busStore.taskById("acp:my-agent:s1"), undefined);
      const enabled = await executeCommand({
        id: "enable-my-agent",
        kind: "setConnectorEnabled",
        setConnectorEnabled: { connector: "acp", connectorId: "my-agent", enabled: true },
      });
      assert.equal(enabled.ok, true, enabled.error);
      // 周期是 0（手动对账），能出现列表项就是启用时那次后台刷新做的。
      await until(() => busStore.taskById("acp:my-agent:s1") !== undefined);
    } finally {
      delete process.env.AGENT_HOST_CONNECTOR_SETTINGS;
      reset();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
