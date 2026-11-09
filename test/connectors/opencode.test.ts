import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import {
  MAX_SESSIONS,
  OpenCodeSessionReader,
  createOpenCodeSessionReader,
  defaultOpenCodeDatabasePath,
  detectOpenCodeBinary,
  openCodeTaskId,
  openReadOnly,
  parseAcpTaskId,
  scanOpenCodeSessions,
  timestampFromMilliseconds,
} from "../../src/connectors/opencode/index.js";
import { ConnectorError } from "../../src/connectors/ported/contract.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = new Date("2026-10-30T12:00:00Z");
const nowMs = now.getTime();

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
  parentId?: string | null;
  directory?: string | null;
  title?: string | null;
  created: number;
  updated: number;
  archived?: number | null;
};

type MessageRow = { id: string; sessionId: string; time: number; data: unknown };
type PartRow = { id: string; messageId: string; data: unknown };

function createDatabase(path: string, sessions: SessionRow[], messages: MessageRow[], parts: PartRow[]): void {
  const database = new DatabaseSync(path);
  try {
    for (const statement of SCHEMA) database.exec(statement);
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
        row.parentId ?? null,
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
  } finally {
    database.close();
  }
}

function assistant(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "assistant", ...data };
}

function user(data: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "user", ...data };
}

describe("opencode task ids", () => {
  test("parses acp:<connectorId>:<sessionId>, keeping colons in the session id", () => {
    assert.deepEqual(parseAcpTaskId("acp:opencode:ses_abc"), { connectorId: "opencode", sessionId: "ses_abc" });
    assert.deepEqual(parseAcpTaskId("acp:opencode:ses:a:b"), { connectorId: "opencode", sessionId: "ses:a:b" });
    assert.equal(openCodeTaskId("ses_abc"), "acp:opencode:ses_abc");
  });

  test("rejects malformed ids", () => {
    assert.equal(parseAcpTaskId("opencode:ses_abc"), undefined);
    assert.equal(parseAcpTaskId("acp:opencode:"), undefined);
    assert.equal(parseAcpTaskId("acp::ses_abc"), undefined);
    assert.equal(parseAcpTaskId("acp:OpenCode:ses_abc"), undefined);
    assert.equal(parseAcpTaskId("acp:opencode"), undefined);
  });
});

describe("opencode scan", () => {
  let directory: string;
  let databasePath: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-host-opencode-"));
    databasePath = join(directory, "opencode.db");
    createDatabase(
      databasePath,
      [
        {
          id: "s-running",
          directory: "E:/work/demo",
          title: "  Fix\n the   bug ",
          created: nowMs - 2 * DAY,
          updated: nowMs - 60_000,
        },
        { id: "s-interrupted", directory: "E:/work/demo", title: "interrupted", created: nowMs - DAY, updated: nowMs - 90_000 },
        { id: "s-failed", directory: "E:/work/demo", title: "failed", created: nowMs - DAY, updated: nowMs - 120_000 },
        { id: "s-last-user", directory: "E:/work/other", title: "waiting", created: nowMs - DAY, updated: nowMs - 300_000 },
        { id: "s-completed", directory: "E:/work/other", title: "", created: nowMs - DAY, updated: nowMs - HOUR },
        { id: "s-idle-old", directory: "E:/work/old", title: null, created: nowMs - 4 * DAY, updated: nowMs - 2 * DAY },
        { id: "s-archived", directory: "E:/work/demo", title: "archived", created: nowMs - DAY, updated: nowMs - 60_000, archived: nowMs - 30_000 },
        { id: "s-child", parentId: "s-running", directory: "E:/work/demo", title: "child", created: nowMs - DAY, updated: nowMs - 60_000 },
        { id: "s-stale", directory: "E:/work/demo", title: "stale", created: nowMs - 500 * DAY, updated: nowMs - 400 * DAY },
      ],
      [
        { id: "m-running", sessionId: "s-running", time: nowMs - 60_000, data: assistant({ time: { created: nowMs - 60_000 } }) },
        {
          id: "m-interrupted",
          sessionId: "s-interrupted",
          time: nowMs - 90_000,
          data: assistant({ error: { name: "MessageAbortedError" } }),
        },
        {
          id: "m-failed",
          sessionId: "s-failed",
          time: nowMs - 120_000,
          data: assistant({ error: { name: "APIError" } }),
        },
        { id: "m-last-user", sessionId: "s-last-user", time: nowMs - 300_000, data: user() },
        {
          id: "m-completed",
          sessionId: "s-completed",
          time: nowMs - HOUR,
          data: assistant({ time: { completed: nowMs - HOUR } }),
        },
        { id: "m-idle-old", sessionId: "s-idle-old", time: nowMs - 2 * DAY, data: assistant({ time: { completed: nowMs - 2 * DAY } }) },
      ],
      [
        { id: "p-running", messageId: "m-running", data: { type: "text", text: "working on it" } },
        { id: "p-interrupted", messageId: "m-interrupted", data: { type: "text", text: "stopped" } },
        { id: "p-failed", messageId: "m-failed", data: { type: "text", text: "boom" } },
        { id: "p-last-user", messageId: "m-last-user", data: { type: "text", text: "new question" } },
        { id: "p-completed", messageId: "m-completed", data: { type: "text", text: "all done" } },
        {
          id: "p-idle-old",
          messageId: "m-idle-old",
          data: { type: "text", text: "x".repeat(600) },
        },
      ],
    );
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("maps sessions, statuses, ordering and filters", () => {
    const reader = new OpenCodeSessionReader({ databasePath, agentId: "agent-1" });
    const scan = reader.scan(now);
    assert.equal(scan.coverageStart, undefined);
    assert.deepEqual(
      scan.tasks.map((task) => task.id),
      ["s-running", "s-interrupted", "s-failed", "s-last-user", "s-completed", "s-idle-old"].map(openCodeTaskId),
    );

    const byId = new Map(scan.tasks.map((task) => [task.id, task]));
    const status = (sessionId: string) => byId.get(openCodeTaskId(sessionId))?.status;
    assert.equal(status("s-running"), "running");
    assert.equal(status("s-interrupted"), "interrupted");
    assert.equal(status("s-failed"), "failed");
    assert.equal(status("s-last-user"), "idle");
    assert.equal(status("s-completed"), "completed");
    assert.equal(status("s-idle-old"), "idle");

    const running = byId.get(openCodeTaskId("s-running"));
    assert.equal(running?.agentId, "agent-1");
    assert.equal(running?.source, "acp");
    assert.equal(running?.connectorId, "opencode");
    assert.equal(running?.origin, "desktop");
    assert.equal(running?.controllable, true);
    assert.equal(running?.title, "Fix the bug");
    assert.equal(running?.projectPath, "E:/work/demo");
    assert.equal(running?.projectName, "demo");
    assert.equal(running?.startedAt, timestampFromMilliseconds(nowMs - 2 * DAY));
    assert.equal(running?.updatedAt, timestampFromMilliseconds(nowMs - 60_000));
    assert.equal(running?.lastMessage, "working on it");

    // 标题为空时回落到项目名；lastMessage 按 500 字截断。
    assert.equal(byId.get(openCodeTaskId("s-completed"))?.title, "other");
    assert.equal(byId.get(openCodeTaskId("s-idle-old"))?.title, "old");
    assert.equal(byId.get(openCodeTaskId("s-idle-old"))?.lastMessage?.length, 500);
  });

  test("tasks() is scan().tasks and free scan function agrees", () => {
    const reader = createOpenCodeSessionReader({ databasePath, agentId: "agent-1" });
    const tasks = scanOpenCodeSessions({ databasePath, agentId: "agent-1" }, now).tasks;
    assert.equal(tasks.length, 6);
    assert.equal(tasks[0]?.agentId, "agent-1");
    // createOpenCodeSessionReader 只承诺 MessageReader；scan 由类/自由函数提供。
    assert.equal(reader.kind, "acp");
    assert.equal(new OpenCodeSessionReader({ databasePath }).tasks(now).length, 6);
  });

  test("empty agentId by default (MessageReader has no host)", () => {
    const scan = scanOpenCodeSessions({ databasePath }, now);
    assert.equal(scan.tasks[0]?.agentId, "");
  });

  test("lastMessage skips tool-only messages", async () => {
    const toolOnlyPath = join(directory, "tool-only.db");
    createDatabase(
      toolOnlyPath,
      [{ id: "s-tools", directory: "E:/work/demo", title: "tools", created: nowMs - HOUR, updated: nowMs - 200_000 }],
      [
        { id: "m-answer", sessionId: "s-tools", time: nowMs - 400_000, data: assistant({ time: { completed: nowMs - 400_000 } }) },
        { id: "m-tool", sessionId: "s-tools", time: nowMs - 200_000, data: assistant({ time: { created: nowMs - 200_000 } }) },
      ],
      [
        { id: "p-answer", messageId: "m-answer", data: { type: "text", text: "answer text" } },
        { id: "p-tool", messageId: "m-tool", data: { type: "tool", tool: "bash" } },
      ],
    );
    const task = scanOpenCodeSessions({ databasePath: toolOnlyPath }, now).tasks[0];
    assert.equal(task?.status, "running");
    assert.equal(task?.lastMessage, "answer text");
  });

  test("coverageStart is the oldest row when 200 sessions were read", () => {
    const bigPath = join(directory, "big.db");
    const sessions: SessionRow[] = [];
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
      sessions.push({
        id: `s-${String(index).padStart(3, "0")}`,
        directory: "/work/demo",
        title: `session ${index}`,
        created: nowMs - DAY,
        updated: nowMs - index * 1000,
      });
    }
    createDatabase(bigPath, sessions, [], []);
    const scan = scanOpenCodeSessions({ databasePath: bigPath }, now);
    assert.equal(scan.tasks.length, MAX_SESSIONS);
    assert.equal(scan.coverageStart, timestampFromMilliseconds(nowMs - (MAX_SESSIONS - 1) * 1000));
  });

  test("missing database is an explicit ConnectorError", () => {
    const reader = new OpenCodeSessionReader({ databasePath: join(directory, "absent.db") });
    assert.throws(() => reader.scan(now), ConnectorError);
  });
});

describe("opencode entries", () => {
  let directory: string;
  let databasePath: string;

  const t = (offset: number) => nowMs - offset;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-host-opencode-entries-"));
    databasePath = join(directory, "opencode.db");
    createDatabase(
      databasePath,
      [
        { id: "ses-main", directory: "E:/work/demo", title: "main", created: t(10_000), updated: t(1_000) },
        { id: "ses-image", directory: "E:/work/demo", title: "image", created: t(10_000), updated: t(1_000) },
        { id: "ses-paged", directory: "E:/work/demo", title: "paged", created: t(200_000), updated: t(1_000) },
      ],
      [
        { id: "m1", sessionId: "ses-main", time: t(9_000), data: user() },
        { id: "m2", sessionId: "ses-main", time: t(8_000), data: assistant() },
        { id: "m3", sessionId: "ses-main", time: t(7_000), data: user() },
        { id: "m4", sessionId: "ses-main", time: t(6_000), data: assistant() },
        { id: "m-image", sessionId: "ses-image", time: t(5_000), data: user() },
        ...Array.from({ length: 120 }, (_, index) => ({
          id: `mp-${String(index).padStart(3, "0")}`,
          sessionId: "ses-paged",
          time: t(100_000 - index * 100),
          data: user(),
        })),
      ],
      [
        { id: "p1", messageId: "m1", data: { type: "text", text: "hello" } },
        { id: "p1-img", messageId: "m1", data: { type: "file", url: "data:image/png;base64,aGVsbG8=" } },
        { id: "p1-tool", messageId: "m1", data: { type: "tool", tool: "bash" } },
        { id: "p2", messageId: "m2", data: { type: "text", text: "hi" } },
        { id: "p2-syn", messageId: "m2", data: { type: "text", text: "synthetic context", synthetic: true } },
        { id: "p2-tool", messageId: "m2", data: { type: "tool", tool: "bash", state: { title: "run tests" } } },
        { id: "p2-reason", messageId: "m2", data: { type: "reasoning", text: "thinking hard" } },
        { id: "p2-step", messageId: "m2", data: { type: "step-start" } },
        { id: "p2-snap", messageId: "m2", data: { type: "snapshot", text: "snapshot" } },
        { id: "p2-file", messageId: "m2", data: { type: "file", url: "data:image/png;base64,aGVsbG8=" } },
        { id: "p3", messageId: "m3", data: { type: "text", text: "again" } },
        { id: "p3-file", messageId: "m3", data: { type: "file", url: "https://example.com/x.png" } },
        { id: "p4", messageId: "m4", data: { type: "text", text: "ok saved out/a.png" } },
        { id: "p4-tool", messageId: "m4", data: { type: "tool" } },
        { id: "p-image", messageId: "m-image", data: { type: "file", url: "data:image/jpeg;base64,aGVsbG8=" } },
        ...Array.from({ length: 120 }, (_, index) => ({
          id: `pp-${String(index).padStart(3, "0")}`,
          messageId: `mp-${String(index).padStart(3, "0")}`,
          data: { type: "text", text: `msg ${index}` },
        })),
      ],
    );
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("returns ascending entries with tools, images and synthetic/reasoning filtering", async () => {
    const reader = new OpenCodeSessionReader({ databasePath });
    const { entries, hasMore } = await reader.entries(openCodeTaskId("ses-main"), 40);
    assert.equal(hasMore, false);
    assert.deepEqual(
      entries.map((entry) => entry.message.id),
      ["m1", "m2", "m2#p2-tool", "m3", "m4", "m4#p4-tool"],
    );
    assert.deepEqual(entries.map((entry) => entry.message.role), ["user", "agent", "tool", "user", "agent", "tool"]);

    const first = entries[0];
    assert.equal(first.message.text, "hello");
    assert.equal(first.images.length, 1);
    const image = first.images[0];
    if (image?.type !== "data") throw new Error("expected an inline image");
    assert.equal(image.contentType, "image/png");
    assert.equal(Buffer.from(image.data).toString("utf8"), "hello");
    assert.equal(first.message.createdAt, timestampFromMilliseconds(t(9_000)));

    const agent = entries[1];
    assert.equal(agent.message.text, "hi");
    assert.equal(agent.images.length, 0);
    assert.equal(entries[2].message.text, "run tests");
    assert.equal(entries[4].message.text, "ok saved out/a.png");
    assert.equal(entries[5].message.text, "tool");
    assert.equal(entries[3].images.length, 0);
    // Agent 回复用未截断原文认路径候选；用户消息不填。
    assert.deepEqual(entries[4].pathCandidates, ["out/a.png"]);
    assert.deepEqual(entries[0].pathCandidates, []);
  });

  test("latest window keeps only the newest conversations but their tool rows", async () => {
    const reader = new OpenCodeSessionReader({ databasePath });
    const { entries, hasMore } = await reader.entries(openCodeTaskId("ses-main"), 2);
    assert.equal(hasMore, true);
    // 契约的 latestWindow 会把紧挨着最旧一条对话之前的工具行也带上（m2 的工具行）。
    assert.deepEqual(
      entries.map((entry) => entry.message.id),
      ["m2#p2-tool", "m3", "m4", "m4#p4-tool"],
    );
  });

  test("pure image user message survives with empty text", async () => {
    const reader = new OpenCodeSessionReader({ databasePath });
    const { entries } = await reader.entries(openCodeTaskId("ses-image"), 10);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message.role, "user");
    assert.equal(entries[0].message.text, "");
    assert.equal(entries[0].images.length, 1);
    const image = entries[0].images[0];
    if (image?.type !== "data") throw new Error("expected an inline image");
    assert.equal(image.contentType, "image/jpeg");
  });

  test("paginates past 100 messages and caps the conversation limit", async () => {
    const reader = new OpenCodeSessionReader({ databasePath });
    const { entries, hasMore } = await reader.entries(openCodeTaskId("ses-paged"), 40);
    assert.equal(hasMore, true);
    assert.equal(entries.length, 40);
    assert.equal(entries[0].message.text, "msg 80");
    assert.equal(entries[39].message.text, "msg 119");

    const capped = await reader.entries(openCodeTaskId("ses-paged"), 500);
    assert.equal(capped.entries.length, 40);
    assert.equal(capped.hasMore, true);
  });

  test("rejects task ids from other connectors and missing databases", async () => {
    const reader = new OpenCodeSessionReader({ databasePath });
    await assert.rejects(reader.entries("acp:other:ses-main", 10), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.message, "无法识别的 OpenCode 任务");
      return true;
    });
    const missing = new OpenCodeSessionReader({ databasePath: join(directory, "absent.db") });
    await assert.rejects(missing.entries(openCodeTaskId("ses-main"), 10), ConnectorError);
  });
});

describe("opencode paths and read-only access", () => {
  test("default database path honours env overrides and XDG_DATA_HOME", () => {
    assert.equal(
      defaultOpenCodeDatabasePath({ XDG_DATA_HOME: "C:\\data" }),
      join("C:\\data", "opencode", "opencode.db"),
    );
    assert.equal(
      defaultOpenCodeDatabasePath({ XDG_DATA_HOME: "C:\\data", AGENT_HOST_OPENCODE_DB: "D:\\tmp\\x.db" }),
      "D:\\tmp\\x.db",
    );
    assert.equal(defaultOpenCodeDatabasePath({}).endsWith(join("opencode", "opencode.db")), true);
  });

  test("detects an opencode binary in an extra directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-host-opencode-bin-"));
    try {
      const executable = join(directory, "opencode");
      await writeFile(executable, "");
      await chmod(executable, 0o755);
      assert.equal(detectOpenCodeBinary({ PATH: "" }, [directory]), executable);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the database handle is read-only and reads leave the file untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-host-opencode-ro-"));
    try {
      const databasePath = join(directory, "opencode.db");
      const nowMs = Date.parse("2026-10-30T12:00:00Z");
      createDatabase(
        databasePath,
        [{ id: "ses-ro", directory: "/work/demo", title: "ro", created: nowMs - 1000, updated: nowMs - 500 }],
        [{ id: "m-ro", sessionId: "ses-ro", time: nowMs - 500, data: assistant({ time: { completed: nowMs - 500 } }) }],
        [{ id: "p-ro", messageId: "m-ro", data: { type: "text", text: "done" } }],
      );

      const handle = openReadOnly(databasePath);
      try {
        assert.throws(
          () => handle.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run("x", "ses-ro", 1, "{}"),
          /read.?only/i,
        );
      } finally {
        handle.close();
      }

      const check = new DatabaseSync(databasePath);
      let beforeCount = 0;
      try {
        beforeCount = Number((check.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n);
      } finally {
        check.close();
      }

      const reader = new OpenCodeSessionReader({ databasePath });
      reader.scan(new Date(nowMs));
      await reader.entries(openCodeTaskId("ses-ro"), 10);

      const verify = new DatabaseSync(databasePath);
      try {
        const afterCount = Number((verify.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n);
        assert.equal(afterCount, beforeCount);
      } finally {
        verify.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
