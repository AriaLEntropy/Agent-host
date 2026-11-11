import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import {
  CodexAppServer,
  codexAppServerConfiguration,
  type CodexProcessHandle,
  type CodexProcessLauncher,
} from "../../src/connectors/codex/app-server.js";
import {
  CodexServerRequest,
  codexNotification,
  notificationStatusTransition,
  type CodexAppServerEvent,
  type CodexProcessExit,
} from "../../src/connectors/codex/app-server-messages.js";
import {
  CodexBridgeRouter,
  CodexBridgeFailure,
} from "../../src/connectors/codex/bridge-router.js";
import { CodexBridgeInvocation } from "../../src/connectors/codex/bridge-invocation.js";
import {
  CodexConnector,
  approvalResult,
  codexNativeId,
  codexProtocolId,
  connectorStatusNeedsAttention,
  connectorStatusText,
  describePermissions,
  diagnosisFromErrorInfo,
  grantedPermissions,
  modelOptions,
  pendingQuestions,
  pendingRequestFrom,
  refusalResult,
  threadStartParams,
  turnStartParams,
  userInputAnswers,
} from "../../src/connectors/codex/connector.js";
import {
  encodeJSON,
  encodeOutgoingMessage,
  incomingLogDescription,
  jsonPath,
  parseIncomingLine,
  requestIdFromKey,
  requestIdKey,
  type JSONValue,
} from "../../src/connectors/codex/json.js";
import { CodexMessageReader } from "../../src/connectors/codex/message-reader.js";
import { reconcileWithHost, type CodexObserverHost } from "../../src/connectors/codex/observer.js";
import { CodexPaths } from "../../src/connectors/codex/paths.js";
import {
  CodexThreadReader,
  SQLiteDatabase,
  isValidEffort,
  isValidModelId,
  protocolTimestamp,
} from "../../src/connectors/codex/thread-reader.js";
import { CodexSubprocessLauncher } from "../../src/connectors/codex/subprocess.js";
import type { BusProject, BusTask } from "../../src/bus/store.js";

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function tempDir(prefix = "codex-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

// MARK: - JSON

describe("codex json", { concurrency: false }, () => {
  test("request ids keep number and string apart", () => {
    const number = { kind: "number" as const, value: 5 };
    const text = { kind: "text" as const, value: "5" };
    assert.equal(requestIdKey(number), "#5");
    assert.equal(requestIdKey(text), "$5");
    assert.notEqual(requestIdKey(number), requestIdKey(text));
    assert.deepEqual(requestIdFromKey("#5"), number);
    assert.deepEqual(requestIdFromKey("$5"), text);
    assert.equal(requestIdFromKey("5"), null);
    assert.equal(requestIdFromKey("#x"), null);
  });

  test("parses the four incoming shapes and rejects malformed lines", () => {
    const response = parseIncomingLine('{"id":5,"result":{"ok":true}}');
    assert.deepEqual(response, { type: "response", id: { kind: "number", value: 5 }, result: { ok: true } });

    const failure = parseIncomingLine('{"id":"x","error":{"code":-32000,"message":"boom"}}');
    assert.equal(failure?.type, "failure");
    assert.equal((failure as any).code, -32000);
    assert.equal((failure as any).message, "boom");

    const request = parseIncomingLine('{"id":"approval","method":"item/commandExecution/requestApproval","params":{"threadId":"t"}}');
    assert.equal(request?.type, "request");
    assert.equal((request as any).method, "item/commandExecution/requestApproval");

    const notification = parseIncomingLine('{"method":"turn/started","params":{"threadId":"t","turn":{"id":"u"}}}');
    assert.equal(notification?.type, "notification");

    assert.equal(parseIncomingLine("not json"), null);
    assert.equal(parseIncomingLine('{"id":{"bad":true}}'), null);
    assert.equal(parseIncomingLine('{"result":1}'), null);
  });

  test("encodes sorted keys with no jsonrpc field and keeps ids verbatim", () => {
    assert.equal(
      encodeOutgoingMessage({ type: "request", id: { kind: "number", value: 1 }, method: "m", params: { b: 2, a: 1 } }),
      '{"id":1,"method":"m","params":{"a":1,"b":2}}',
    );
    assert.equal(
      encodeOutgoingMessage({ type: "failure", id: { kind: "text", value: "x" }, code: -1, message: "no" }),
      '{"error":{"code":-1,"message":"no"},"id":"x"}',
    );
    assert.equal(encodeJSON({ b: [1, 2], a: null }), '{"a":null,"b":[1,2]}');
    assert.ok(!encodeOutgoingMessage({ type: "notification", method: "initialized" }).includes("jsonrpc"));
  });

  test("log descriptions never carry params or result", () => {
    const parsed = parseIncomingLine('{"id":1,"result":{"secret":"payload"}}')!;
    const description = incomingLogDescription(parsed);
    assert.equal(description, "response #1");
    assert.ok(!description.includes("payload"));
  });
});

// MARK: - app-server messages

describe("codex app-server messages", { concurrency: false }, () => {
  test("maps notifications and their status transitions", () => {
    const started = codexNotification("turn/started", { threadId: "t", turn: { id: "u" } });
    assert.equal(started.type, "turnStarted");
    assert.equal(notificationStatusTransition(started), "running");

    const completed = codexNotification("turn/completed", {
      threadId: "t",
      turn: { id: "u", status: "failed", error: { message: "quota", codexErrorInfo: { usageLimitExceeded: {} } } },
    });
    assert.equal(completed.type, "turnCompleted");
    if (completed.type === "turnCompleted") {
      assert.equal(completed.status.type, "failed");
      assert.equal(completed.error, "quota");
      assert.equal(completed.errorInfo, "usageLimitExceeded");
    }
    assert.equal(notificationStatusTransition(completed), "failed");

    const idle = codexNotification("thread/status/changed", { threadId: "t", status: { type: "idle" } });
    assert.equal(notificationStatusTransition(idle), "idle");

    const unknown = codexNotification("brand/new", { threadId: "t" });
    assert.equal(unknown.type, "other");
    assert.equal(notificationStatusTransition(unknown), undefined);
  });

  test("keeps the thread id on error notifications", () => {
    const error = codexNotification("error", { threadId: "t", message: "502 Bad Gateway" });
    assert.equal(error.type, "serverError");
    if (error.type === "serverError") {
      assert.equal(error.threadId, "t");
      assert.equal(error.message, "502 Bad Gateway");
    }

    const bare = codexNotification("error", { message: "boom" });
    assert.equal(bare.type, "serverError");
    if (bare.type === "serverError") assert.equal(bare.threadId, undefined);
  });

  test("parses server requests, approval kinds and cached diffs", () => {
    const request = new CodexServerRequest(
      { kind: "text", value: "srv-1" },
      "item/fileChange/requestApproval",
      { threadId: "t", turnId: "u", itemId: "i", reason: "write" },
      [{ path: "/p/a.txt", kind: "update", diff: "+hi" }],
    );
    assert.equal(request.key, "$srv-1");
    assert.equal(request.kind, "fileChange");
    assert.equal(request.isApproval, true);
    assert.equal(request.pendingRequestKind, "fileChange");
    assert.equal(request.fileChanges[0]?.diff, "+hi");

    const input = new CodexServerRequest({ kind: "number", value: 2 }, "item/tool/requestUserInput", {});
    assert.equal(input.isApproval, false);
    assert.equal(input.pendingRequestKind, "input");
    assert.equal(input.key, "#2");
  });

  test("encodes approval payloads and refusals", () => {
    const command = new CodexServerRequest({ kind: "number", value: 1 }, "item/commandExecution/requestApproval", {});
    assert.deepEqual(approvalResult(command, "accept"), { decision: "accept" });
    assert.deepEqual(approvalResult(command, "decline"), { decision: "decline" });

    const permissions = new CodexServerRequest(
      { kind: "number", value: 2 },
      "item/permissions/requestApproval",
      { permissions: { network: { enabled: true }, fileSystem: { read: ["/p"], write: [] }, nulls: null } },
    );
    assert.deepEqual(approvalResult(permissions, "accept"), {
      permissions: { network: { enabled: true }, fileSystem: { read: ["/p"], write: [] } },
      scope: "turn",
    });
    assert.deepEqual(approvalResult(permissions, "acceptForSession"), {
      permissions: { network: { enabled: true }, fileSystem: { read: ["/p"], write: [] } },
      scope: "session",
    });
    assert.deepEqual(approvalResult(permissions, "decline"), { permissions: {}, scope: "turn" });
    assert.equal(describePermissions({ network: { enabled: false }, fileSystem: { read: ["/a"], write: ["/b"] } }), "网络策略调整\n读取：/a\n写入：/b");

    const elicitation = new CodexServerRequest({ kind: "number", value: 3 }, "mcpServer/elicitation/request", {});
    assert.deepEqual(refusalResult(elicitation), { action: "decline", content: null, _meta: null });
    const toolCall = new CodexServerRequest({ kind: "number", value: 4 }, "item/tool/call", {});
    assert.equal(refusalResult(toolCall), undefined);
  });

  test("builds pending requests and filters answers by question id", () => {
    const input = new CodexServerRequest(
      { kind: "number", value: 7 },
      "item/tool/requestUserInput",
      {
        threadId: "t",
        questions: [
          { id: "q1", header: "Deploy?", question: "Where?", options: [{ label: "A", description: "first" }, { label: "B" }] },
          { id: "q2", question: "When?" },
        ],
      },
    );
    const pending = pendingRequestFrom(input, "input");
    assert.equal(pending.kind, "input");
    assert.equal(pending.summary, "Deploy?");
    assert.equal(pending.question, "Where?");
    assert.equal(pending.detail, "可选项：A、B\n还有 1 个问题");
    assert.equal(pending.questions?.length, 2);
    assert.deepEqual(pending.questions?.[0]?.options[0], { label: "A", description: "first" });

    assert.deepEqual(userInputAnswers({ q1: ["  A  "], q2: ["", "  "], zz: ["x"] }, input), {
      answers: { q1: { answers: ["A"] } },
    });
    assert.equal(userInputAnswers({ zz: ["x"] }, input), undefined);
    assert.equal(pendingQuestions([{ id: "", question: "x" }]), undefined);
  });

  test("builds command and file-change pending summaries", () => {
    const command = new CodexServerRequest(
      { kind: "number", value: 1 },
      "item/commandExecution/requestApproval",
      { command: "rm -rf build", cwd: "/p", reason: "cleanup" },
    );
    const pending = pendingRequestFrom(command, "command");
    assert.equal(pending.summary, "执行命令：rm -rf build");
    assert.equal(pending.detail, "cleanup\n工作目录：/p");

    const fileChange = new CodexServerRequest(
      { kind: "number", value: 2 },
      "item/fileChange/requestApproval",
      { reason: "edit" },
      [{ path: "/p/a.txt", kind: "update", diff: "+x" }],
    );
    const pendingFile = pendingRequestFrom(fileChange, "fileChange");
    assert.equal(pendingFile.summary, "修改 1 个文件：a.txt");
    assert.ok(pendingFile.detail?.includes("--- /p/a.txt (update)"));
  });

  test("encodes turn start params with images and model selection", () => {
    assert.deepEqual(
      turnStartParams("t", "hello", ["/tmp/a.png"], { model: "gpt-5", effort: "high" }),
      {
        threadId: "t",
        input: [
          { type: "text", text: "hello", text_elements: [] },
          { type: "localImage", path: "/tmp/a.png" },
        ],
        model: "gpt-5",
        effort: "high",
      },
    );
    // 只发图时没有空 text 块。
    assert.deepEqual(jsonPath(turnStartParams("t", "", ["/tmp/a.png"]), "input"), [
      { type: "localImage", path: "/tmp/a.png" },
    ]);
    assert.deepEqual(threadStartParams("/p", undefined), { cwd: "/p" });
  });

  test("maps ids, status text and error diagnostics", () => {
    assert.equal(codexProtocolId("t"), "codex:t");
    assert.equal(codexNativeId("codex:t"), "t");
    assert.equal(codexNativeId("t"), "t");
    assert.throws(() => codexNativeId("codex:"), /不是 Codex/);
    assert.throws(() => codexNativeId("codex:a:b"), /不是 Codex/);

    assert.equal(connectorStatusText({ phase: "ready", generation: 1, liveTaskCount: 2 }), "app-server：运行中 · 正在驱动 2 个任务");
    assert.equal(
      connectorStatusText({ phase: "restarting", after: 3, generation: 1, liveTaskCount: 0, detail: "boom" }),
      "app-server：已退出，3 秒后重启（boom）",
    );
    assert.equal(connectorStatusNeedsAttention({ phase: "restarting", after: 3, generation: 1, liveTaskCount: 0 }), true);

    assert.deepEqual(diagnosisFromErrorInfo("unauthorized"), { kind: "signInExpired" });
    assert.deepEqual(diagnosisFromErrorInfo("usageLimitExceeded"), { kind: "usageLimit" });
    assert.equal(diagnosisFromErrorInfo("somethingElse"), undefined);
    assert.deepEqual(grantedPermissions({ network: null, fileSystem: { read: ["/x"] } }), { fileSystem: { read: ["/x"] } });
  });

  test("filters hidden models from model/list", () => {
    assert.deepEqual(
      modelOptions({
        data: [
          { id: "gpt-5", displayName: "GPT-5", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "high" },
          { id: "hidden", hidden: true },
          { displayName: "no id" },
        ],
      }),
      [{ id: "gpt-5", displayName: "GPT-5", efforts: ["low", "high"], defaultEffort: "high" }],
    );
  });
});

// MARK: - paths

describe("codex paths", { concurrency: false }, () => {
  test("picks the highest schema version database", () => {
    const directory = tempDir();
    try {
      for (const name of ["state_1.sqlite", "state_10.sqlite", "state_2.sqlite", "state_x.sqlite", "state.sqlite", "thread_history_3.sqlite", "thread_history.sqlite"]) {
        writeFileSync(join(directory, name), "");
      }
      const paths = new CodexPaths(directory);
      assert.equal(paths.stateDatabase, join(directory, "state_10.sqlite"));
      assert.equal(paths.historyDatabase, join(directory, "thread_history_3.sqlite"));
    } finally {
      cleanup(directory);
    }
  });

  test("missing home or no matching file yields undefined", () => {
    const directory = tempDir();
    try {
      const paths = new CodexPaths(join(directory, "absent"));
      assert.equal(paths.stateDatabase, undefined);
      assert.equal(new CodexPaths(directory).historyDatabase, undefined);
    } finally {
      cleanup(directory);
    }
  });
});

// MARK: - pure mapping

describe("codex thread mapping", { concurrency: false }, () => {
  test("status mapping and text helpers", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    assert.equal(CodexThreadReader.status("completed", now - 1000, now), "completed");
    assert.equal(CodexThreadReader.status("failed", now - 1000, now), "failed");
    assert.equal(CodexThreadReader.status("interrupted", now - 1000, now), "interrupted");
    assert.equal(CodexThreadReader.status("inProgress", now - 1000, now), "running");
    assert.equal(CodexThreadReader.status(undefined, now - 1000, now), "idle");
    assert.equal(CodexThreadReader.status("completed", now - 25 * 3600 * 1000, now), "idle");

    assert.equal(CodexThreadReader.singleLine(" a\n\n b\t c "), "a b c");
    assert.equal(CodexThreadReader.truncate("abcdef", 3), "abc");
    assert.equal(CodexThreadReader.agentMessageText('{"text":"done"}'), "done");
    assert.equal(CodexThreadReader.agentMessageText('{"text":"   "}'), undefined);
    assert.equal(CodexThreadReader.agentMessageText("not json"), undefined);
    assert.equal(protocolTimestamp(1_790_000_000_000), "2026-09-21T14:13:20Z");
  });

  test("model and effort validation matches the protocol", () => {
    assert.equal(isValidModelId("gpt-5.1-codex"), true);
    assert.equal(isValidModelId("-bad"), false);
    assert.equal(isValidModelId("a".repeat(65)), false);
    assert.equal(isValidModelId("bad model"), false);
    assert.equal(isValidEffort("xhigh"), true);
    assert.equal(isValidEffort("-high"), false);
    assert.equal(isValidEffort("HIGH"), false);
    assert.equal(isValidEffort("a".repeat(17)), false);
  });
});

// MARK: - SQLite readers

type Fixture = {
  directory: string;
  paths: CodexPaths;
  now: number;
  projectPath: string;
};

function buildFixture(): Fixture {
  const directory = tempDir("codex-sql-");
  const now = Date.parse("2026-10-30T12:00:00Z");
  const projectPath = join(directory, "project-demo");
  const statePath = join(directory, "state_5.sqlite");
  const historyPath = join(directory, "thread_history_1.sqlite");

  const state = new DatabaseSync(statePath);
  state.exec(`
    CREATE TABLE threads (
      id TEXT, cwd TEXT, name TEXT, title TEXT, first_user_message TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER, source TEXT,
      model TEXT, reasoning_effort TEXT
    );
    CREATE TABLE projects (id TEXT, name TEXT, updated_at_ms INTEGER);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
  `);
  const insertThread = state.prepare(
    "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertThread.run("t1", projectPath, null, "Fix login", "hello", now - 3_600_000, now - 600_000, 0, "cli", "gpt-5.1", "high");
  insertThread.run("t2", projectPath, "Bad model", null, null, now - 3_600_000, now - 700_000, 0, "cli", "-bad", "HIGH");
  insertThread.run("t3", projectPath, "Archived", null, null, now - 3_600_000, now - 800_000, 1, "cli", null, null);
  insertThread.run("t4", projectPath, "Old", null, null, now - 3_600_000, now - 400 * 24 * 3600_000, 0, "cli", null, null);
  insertThread.run("t5", projectPath, "Subagent", null, null, now - 3_600_000, now - 900_000, 0, "{%sub}", null, null);
  state.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("p1", "Demo", now - 1000);
  state.prepare("INSERT INTO project_roots VALUES (?, ?, ?)").run("p1", 0, projectPath);
  state.close();

  const history = new DatabaseSync(historyPath);
  history.exec(`
    CREATE TABLE thread_items (
      item_id TEXT, thread_id TEXT, item_type TEXT, item_json TEXT,
      created_at_ms INTEGER, rollout_ordinal INTEGER, updated_at_ordinal INTEGER
    );
    CREATE TABLE thread_turns (thread_id TEXT, status TEXT, rollout_ordinal INTEGER);
  `);
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?)").run("t1", "completed", 4);
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?)").run("t2", "failed", 1);
  const insertItem = history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)");
  const imagePath = join(directory, "shot.png");
  writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  insertItem.run("i1", "t1", "userMessage", JSON.stringify({
    content: [
      { type: "text", text: "look" },
      { type: "localImage", path: imagePath },
      { type: "image", url: `data:image/png;base64,${PNG_BASE64}` },
    ],
  }), now - 3000, 1, 1);
  insertItem.run("i2", "t1", "reasoning", JSON.stringify({ text: "internal thinking" }), now - 2900, 2, 1);
  insertItem.run("i3", "t1", "commandExecution", JSON.stringify({ command: "ls", exitCode: 2 }), now - 2800, 3, 1);
  insertItem.run("i4", "t1", "fileChange", JSON.stringify({ changes: [{ path: "/p/a.txt" }, { path: "/p/b.txt" }] }), now - 2700, 4, 1);
  insertItem.run("i5", "t1", "agentMessage", JSON.stringify({ text: "All done" }), now - 2600, 5, 1);
  insertItem.run("i6", "t1", "imageGeneration", JSON.stringify({ revisedPrompt: "a cat", result: PNG_BASE64 }), now - 2500, 6, 1);
  insertItem.run("i7", "t2", "agentMessage", JSON.stringify({ text: "failed turn" }), now - 2400, 7, 1);
  history.close();

  return { directory, paths: new CodexPaths(directory), now, projectPath };
}

describe("codex readers", { concurrency: false }, () => {
  test("thread reader maps tasks, filters archived/old/subagent and injects agentId", () => {
    const fixture = buildFixture();
    try {
      const reader = CodexThreadReader.create(fixture.paths, () => fixture.now);
      assert.ok(reader);
      const tasks = reader.readTasks("agent-1");
      assert.equal(tasks.length, 2);
      const task = tasks[0]!;
      assert.equal(task.id, "codex:t1");
      assert.equal(task.agentId, "agent-1");
      assert.equal(task.source, "codex");
      assert.equal(task.title, "Fix login");
      assert.equal(task.projectPath, fixture.projectPath);
      assert.equal(task.projectName, basename(fixture.projectPath));
      assert.equal(task.status, "completed");
      assert.equal(task.controllable, true);
      assert.equal(task.origin, "desktop");
      assert.equal(task.lastMessage, "All done");
      assert.equal(task.model, "gpt-5.1");
      assert.equal(task.effort, "high");
      assert.equal(task.startedAt, protocolTimestamp(fixture.now - 3_600_000));

      // 非法模型 id 与强度不报（对端会拒收整条），但任务照常列出。
      const failed = tasks[1]!;
      assert.equal(failed.id, "codex:t2");
      assert.equal(failed.title, "Bad model");
      assert.equal(failed.status, "failed");
      assert.equal(failed.model, undefined);
      assert.equal(failed.effort, undefined);

      const projects = reader.readProjects("agent-1");
      assert.equal(projects.length, 1);
      assert.equal(projects[0]?.path, fixture.projectPath);
      assert.equal(projects[0]?.name, "Demo");
    } finally {
      cleanup(fixture.directory);
    }
  });

  test("thread reader refuses when a database is missing", () => {
    const directory = tempDir();
    try {
      assert.equal(CodexThreadReader.create(new CodexPaths(directory)), undefined);
    } finally {
      cleanup(directory);
    }
  });

  test("message reader maps entry types, images and truncates tool lines", async () => {
    const fixture = buildFixture();
    try {
      const reader = new CodexMessageReader({ paths: fixture.paths });
      const { entries, hasMore } = await reader.entries("codex:t1", 40);
      assert.equal(hasMore, false);
      assert.deepEqual(entries.map((entry) => entry.message.role), ["user", "tool", "tool", "agent", "agent"]);
      assert.deepEqual(entries.map((entry) => entry.message.id), ["i1", "i3", "i4", "i5", "i6"]);

      const user = entries[0]!;
      assert.equal(user.message.text, "look");
      assert.equal(user.images.length, 2);
      assert.equal(user.images[0]?.type, "file");
      assert.equal(user.images[1]?.type, "data");

      assert.equal(entries[1]?.message.text, "$ ls（退出码 2）");
      assert.equal(entries[2]?.message.text, "改动 a.txt、b.txt");
      assert.equal(entries[3]?.message.text, "All done");
      assert.equal(entries[4]?.message.text, "a cat");
      assert.equal(entries[4]?.images[0]?.type, "data");
      assert.equal(user.message.createdAt, protocolTimestamp(fixture.now - 3000));

      // reasoning 不在窗口里。
      assert.ok(!entries.some((entry) => entry.message.text.includes("internal thinking")));

      await assert.rejects(reader.entries("t1", 10), /任务 id 不属于/);
    } finally {
      cleanup(fixture.directory);
    }
  });

  test("agent replies expose path candidates from untruncated text", () => {
    const agent = CodexMessageReader.entry({
      item_id: "a1",
      item_type: "agentMessage",
      item_json: JSON.stringify({ text: "saved out/a.png and `src/b.jpg`" }),
      created_at_ms: 0,
    });
    assert.deepEqual(agent?.pathCandidates, ["out/a.png", "src/b.jpg"]);

    const user = CodexMessageReader.entry({
      item_id: "u1",
      item_type: "userMessage",
      item_json: JSON.stringify({ content: "see out/a.png" }),
      created_at_ms: 0,
    });
    assert.deepEqual(user?.pathCandidates, []);
  });

  test("message reader content handles saved files, relative paths and tool summaries", () => {
    const directory = tempDir();
    try {
      const absolute = join(directory, "saved.png");
      writeFileSync(absolute, Buffer.from([1]));
      const saved = CodexMessageReader.content(
        "imageGeneration",
        JSON.stringify({ revisedPrompt: "p", savedPath: absolute, result: PNG_BASE64 }),
      );
      assert.equal(saved.text, "p");
      assert.deepEqual(saved.images, [{ type: "file", path: absolute }]);

      const deleted = CodexMessageReader.content(
        "imageGeneration",
        JSON.stringify({ revisedPrompt: "p", savedPath: join(directory, "gone.png"), result: PNG_BASE64 }),
      );
      assert.equal(deleted.images[0]?.type, "data");

      const relative = CodexMessageReader.content(
        "imageGeneration",
        JSON.stringify({ savedPath: "relative.png", result: PNG_BASE64 }),
      );
      assert.equal(relative.images[0]?.type, "data");

      assert.equal(CodexMessageReader.localFile("relative.png"), undefined);
      assert.equal(
        CodexMessageReader.text("mcpToolCall", { server: "fs", tool: "read" }),
        "调用 fs/read",
      );
      assert.equal(CodexMessageReader.text("webSearch", { query: "rust" }), "搜索「rust」");
      assert.equal(
        CodexMessageReader.text("commandExecution", { command: "ok" }),
        "$ ok",
      );
    } finally {
      cleanup(directory);
    }
  });

  test("read-only SQLite wrapper opens an existing database and rejects missing files", () => {
    const fixture = buildFixture();
    try {
      const statePath = fixture.paths.stateDatabase!;
      const database = new SQLiteDatabase(statePath);
      try {
        assert.equal(database.query("SELECT id FROM threads ORDER BY id").length, 5);
      } finally {
        database.close();
      }
      assert.throws(() => new SQLiteDatabase(join(fixture.directory, "absent.sqlite")), /SQLite error/);
    } finally {
      cleanup(fixture.directory);
    }
  });
});

// MARK: - bridge invocation / router

describe("codex bridge", { concurrency: false }, () => {
  test("finds app-server after global value options", () => {
    assert.equal(CodexBridgeInvocation.isAppServer(["app-server"]), true);
    assert.equal(CodexBridgeInvocation.isAppServer(["-c", "model=gpt-5", "app-server"]), true);
    assert.equal(CodexBridgeInvocation.isAppServer(["-cmodel=gpt-5", "app-server"]), true);
    assert.equal(CodexBridgeInvocation.isAppServer(["--config=model=gpt-5", "app-server"]), true);
    assert.equal(CodexBridgeInvocation.isAppServer(["--oss", "app-server"]), true);
    assert.equal(CodexBridgeInvocation.isAppServer(["--", "app-server"]), false);
    assert.equal(CodexBridgeInvocation.isAppServer(["something", "app-server"]), false);
    assert.equal(CodexBridgeInvocation.shouldBridge(["app-server"], "com.openai.codex"), true);
    assert.equal(CodexBridgeInvocation.shouldBridge(["app-server"], "other.bundle"), false);
  });

  test("router isolates ids, restores them, and relays phone approvals", () => {
    const router = new CodexBridgeRouter();
    const desktopInit = router.desktop({ id: 1, method: "initialize", params: { clientInfo: {} } });
    assert.equal(desktopInit[0]?.type, "upstream");
    assert.equal((desktopInit[0] as any).message.id, "botbus-1");

    const upstreamInit = router.upstream({ id: "botbus-1", result: { serverInfo: {} } });
    assert.equal(upstreamInit[0]?.type, "desktop");
    assert.equal((upstreamInit[0] as any).message.id, 1);
    assert.equal(router.ready, true);
    assert.deepEqual(router.initializeResult, { serverInfo: {} });

    router.attach("session-1");
    const request = router.desktop({ id: 2, method: "thread/start", params: { cwd: "/p" } });
    assert.equal((request[0] as any).message.id, "botbus-2");
    router.upstream({ id: "botbus-2", result: { thread: { id: "t1" } } });

    // 上游的服务端请求同时交给桌面与手机。
    const approval = router.upstream({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t1", turnId: "u1" },
    });
    assert.equal(approval.length, 2);
    assert.equal(approval[1]?.type, "agent");

    // 手机回答：转给上游 + 给桌面一条 serverRequest/resolved。
    const answered = router.agent({ id: 99, result: { decision: "accept" } }, "session-1");
    assert.equal(answered.length, 2);
    assert.equal(answered[1]?.type, "desktop");
    assert.equal((answered[1] as any).message.method, "serverRequest/resolved");

    assert.throws(() => router.agent({ id: 3, method: "thread/start" }, "stale"), CodexBridgeFailure);
    assert.throws(() => router.agent({ id: 4, method: "danger/delete" }, "session-1"), CodexBridgeFailure);
  });
});

// MARK: - observer reconciliation

describe("codex observer reconciliation", { concurrency: false }, () => {
  test("upserts observer-owned tasks, skips live tasks and removes disappeared ones", () => {
    const tasks = new Map<string, BusTask>();
    const projects: BusProject[] = [];
    const live = new Set<string>();
    let upserts = 0;
    const host: CodexObserverHost = {
      agentId: "agent-1",
      task: (taskId) => tasks.get(taskId),
      tasks: () => [...tasks.values()],
      upsert: (task) => {
        upserts += 1;
        tasks.set(task.id, task);
      },
      remove: (taskId) => {
        tasks.delete(taskId);
      },
      rememberProject: (project) => {
        projects.push(project);
      },
      isLive: (taskId) => live.has(taskId),
    };
    const task: BusTask = {
      id: "codex:t1",
      agentId: "agent-1",
      source: "codex",
      title: "T",
      projectPath: "/p",
      projectName: "p",
      status: "completed",
      origin: "desktop",
      controllable: true,
      startedAt: "2026-10-30T12:00:00Z",
      updatedAt: "2026-10-30T12:00:00Z",
    };
    const project: BusProject = { agentId: "agent-1", path: "/p", name: "p", lastUsedAt: "2026-10-30T12:00:00Z", pinned: false };

    reconcileWithHost(host, [task], [project]);
    assert.equal(tasks.has("codex:t1"), true);
    assert.equal(projects.length, 1);
    assert.equal(upserts, 1);

    // 内容没变：不重复 upsert。
    reconcileWithHost(host, [task], [project]);
    assert.equal(upserts, 1);

    // 实时任务不被观察者改写或摘掉。
    live.add("codex:t1");
    reconcileWithHost(host, [], [project]);
    assert.equal(tasks.has("codex:t1"), true);
    live.delete("codex:t1");
    reconcileWithHost(host, [], [project]);
    assert.equal(tasks.has("codex:t1"), false);
  });
});

// MARK: - AppServer protocol loop (fake process)

class FakeHandle implements CodexProcessHandle {
  readonly written: string[] = [];
  private readonly chunks: Buffer[] = [];
  private readonly waiters: Array<(chunk: Uint8Array | null) => void> = [];
  private closed = false;
  private resolveExit: ((exit: CodexProcessExit) => void) | undefined;
  private readonly exit: Promise<CodexProcessExit>;
  onWrite: ((line: string, handle: FakeHandle) => void) | undefined;

  constructor() {
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  pushRaw(text: string): void {
    const chunk = Buffer.from(text, "utf8");
    const waiter = this.waiters.shift();
    if (waiter) waiter(chunk);
    else this.chunks.push(chunk);
  }

  pushJSON(value: unknown): void {
    this.pushRaw(`${JSON.stringify(value)}\n`);
  }

  async readStdout(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk) return chunk;
    if (this.closed) return null;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async writeStdin(data: Uint8Array): Promise<void> {
    const text = Buffer.from(data).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      this.written.push(line);
      this.onWrite?.(line, this);
    }
  }

  terminate(): void {
    this.close(0);
  }

  close(status: number): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    this.resolveExit?.({ status, reason: undefined });
  }

  waitForExit(): Promise<CodexProcessExit> {
    return this.exit;
  }
}

async function nextEvent(
  iterator: AsyncIterator<CodexAppServerEvent>,
  predicate: (event: CodexAppServerEvent) => boolean,
): Promise<CodexAppServerEvent> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const next = await iterator.next();
    if (next.done) throw new Error("event stream ended");
    if (predicate(next.value)) return next.value;
  }
  throw new Error("event not received");
}

describe("codex app-server protocol loop", { concurrency: false }, () => {
  test("handshake, request id isolation, notifications and server requests", async () => {
    const handles: FakeHandle[] = [];
    const deferred: Array<{ method: string; id: number }> = [];
    const launcher: CodexProcessLauncher = {
      async launch() {
        const handle = new FakeHandle();
        handle.onWrite = (line, current) => {
          const message = JSON.parse(line) as { id?: number; method?: string; params?: JSONValue };
          if (message.method === "initialize") {
            current.pushJSON({ id: message.id, result: { userAgent: "fake" } });
          } else if (message.method === "a" || message.method === "b") {
            deferred.push({ method: message.method, id: message.id as number });
          } else if (message.method === "thread/start") {
            current.pushJSON({ id: message.id, result: { thread: { id: "t1" }, cwd: "/p" } });
          }
        };
        handles.push(handle);
        return handle;
      },
    };

    const server = new CodexAppServer(launcher, codexAppServerConfiguration({ requestTimeout: 60 }));
    const iterator = server.events()[Symbol.asyncIterator]();
    server.start();
    const ready = await nextEvent(iterator, (event) => event.type === "ready");
    assert.equal(ready.type, "ready");
    assert.equal(server.processGeneration, 1);
    assert.equal(server.isProcessAlive, true);

    const startedResponse = await server.request("thread/start", { cwd: "/p" });
    assert.deepEqual(startedResponse, { thread: { id: "t1" }, cwd: "/p" });
    assert.deepEqual(server.controlledThreads(), ["t1"]);
    assert.equal(server.runningControlledThreads().length, 0);

    // 两条并发请求：id 各自独立，应答乱序也能对上。
    const first = server.request("a");
    const second = server.request("b");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deferred.length, 2);
    const a = deferred.find((item) => item.method === "a")!;
    const b = deferred.find((item) => item.method === "b")!;
    assert.notEqual(a.id, b.id);
    handles[0]!.pushJSON({ id: b.id, result: { which: "b" } });
    handles[0]!.pushJSON({ id: a.id, result: { which: "a" } });
    assert.deepEqual(await first, { which: "a" });
    assert.deepEqual(await second, { which: "b" });

    // 通知：分片到达也要按行拼回来。
    const turnLine = JSON.stringify({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } });
    handles[0]!.pushRaw(turnLine.slice(0, 10));
    handles[0]!.pushRaw(`${turnLine.slice(10)}\n`);
    const notification = await nextEvent(
      iterator,
      (event) => event.type === "notification" && event.notification.type === "turnStarted",
    );
    assert.equal(notification.type, "notification");
    assert.deepEqual(server.runningControlledThreads(), ["t1"]);

    // item/started 带补丁；审批请求不带 diff，要从缓存里配对。
    handles[0]!.pushJSON({
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "u1",
        item: { id: "item-1", type: "fileChange", changes: [{ path: "/p/a.txt", kind: "update", diff: "+x" }] },
      },
    });
    await nextEvent(iterator, (event) => event.type === "notification" && event.notification.type === "itemStarted");
    handles[0]!.pushJSON({
      id: "srv-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "u1", itemId: "item-1" },
    });
    const requestEvent = await nextEvent(iterator, (event) => event.type === "serverRequest");
    assert.equal(requestEvent.type, "serverRequest");
    if (requestEvent.type === "serverRequest") {
      assert.equal(requestEvent.request.key, "$srv-1");
      assert.equal(requestEvent.request.fileChanges[0]?.diff, "+x");
    }
    assert.equal(server.pendingServerRequests().length, 1);

    // 绝不自动回：应答要由上层显式 respond。
    assert.ok(!handles[0]!.written.some((line) => line.includes('"id":"srv-1"')));
    await server.respond("$srv-1", { decision: "accept" });
    assert.equal(server.pendingServerRequest("$srv-1"), undefined);
    const answer = JSON.parse(handles[0]!.written[handles[0]!.written.length - 1]!);
    assert.deepEqual(answer, { id: "srv-1", result: { decision: "accept" } });

    server.stop();
    assert.equal(server.isProcessAlive, false);
  });

  test("hard timeout rejects a request that never gets an answer", async () => {
    const handle = new FakeHandle();
    handle.onWrite = (line, current) => {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (message.method === "initialize") current.pushJSON({ id: message.id, result: {} });
    };
    const launcher: CodexProcessLauncher = { async launch() { return handle; } };
    const server = new CodexAppServer(launcher, codexAppServerConfiguration({ requestTimeout: 0.02 }));
    const iterator = server.events()[Symbol.asyncIterator]();
    server.start();
    await nextEvent(iterator, (event) => event.type === "ready");

    await assert.rejects(server.request("slow"), (error: any) => error?.reason === "timedOut");
    server.stop();
  });

  test("process exit schedules a restart with the configured delay", async () => {
    const sleepCalls: number[] = [];
    let handles = 0;
    const launcher: CodexProcessLauncher = {
      async launch() {
        const handle = new FakeHandle();
        handle.onWrite = (line, current) => {
          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.method === "initialize") current.pushJSON({ id: message.id, result: {} });
        };
        handles += 1;
        return handle;
      },
    };
    const server = new CodexAppServer(
      launcher,
      codexAppServerConfiguration({ requestTimeout: 60, restartDelay: 3 }),
      async (seconds) => {
        sleepCalls.push(seconds);
        await new Promise(() => undefined); // 闸门不打开：只验证“排了重启、等了 3 秒”。
      },
    );
    const iterator = server.events()[Symbol.asyncIterator]();
    server.start();
    await nextEvent(iterator, (event) => event.type === "ready");

    // 让读循环先拿到 handle：关闭 stdout，模拟进程退出。
    const handle = (server as unknown as { live?: { handle: FakeHandle } }).live?.handle;
    assert.ok(handle);
    handle!.close(0);
    const exited = await nextEvent(iterator, (event) => event.type === "exited");
    assert.equal(exited.type, "exited");
    if (exited.type === "exited") {
      assert.equal(exited.exit.status, 0);
      assert.equal(exited.restartingIn, 3);
    }
    assert.equal(handles, 1);
    assert.ok(sleepCalls.includes(3));
    server.stop();
  });
});

// MARK: - connector smoke test (fake process, fake host)

async function waitUntil(read: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("codex connector with a fake app-server", { concurrency: false }, () => {
  test("start, interrupt, approve and followUp go through the protocol", async () => {
    const handle = new FakeHandle();
    const tasks = new Map<string, BusTask>();
    const live = new Set<string>();
    const host = {
      agentId: "agent-1",
      now: () => "2026-10-30T12:00:00Z",
      task: (taskId: string) => tasks.get(taskId),
      tasks: () => [...tasks.values()],
      upsert: (task: BusTask) => {
        tasks.set(task.id, task);
      },
      remove: (taskId: string) => {
        tasks.delete(taskId);
      },
      rememberProject: () => undefined,
      rememberSession: () => undefined,
      emitMessages: () => undefined,
      claimLive: (taskId: string) => {
        live.add(taskId);
      },
      releaseLive: (taskId: string) => {
        live.delete(taskId);
      },
      isLive: (taskId: string) => live.has(taskId),
    };
    handle.onWrite = (line, current) => {
      const message = JSON.parse(line) as { id?: number | string; method?: string };
      switch (message.method) {
        case "initialize":
          current.pushJSON({ id: message.id, result: {} });
          break;
        case "thread/start":
          current.pushJSON({ id: message.id, result: { thread: { id: "t1" }, cwd: "/p", model: "gpt-5.1", reasoningEffort: "high" } });
          break;
        case "turn/start":
          current.pushJSON({ id: message.id, result: { turn: { id: "u1" } } });
          current.pushJSON({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } });
          break;
        case "turn/interrupt":
          current.pushJSON({ id: message.id, result: {} });
          break;
        default:
          break;
      }
    };
    const server = new CodexAppServer(
      { async launch() { return handle; } },
      codexAppServerConfiguration({ requestTimeout: 60 }),
    );
    const connector = new CodexConnector(host, server, { now: () => "2026-10-30T12:00:00Z" });
    try {
      await connector.start();
      const outcome = await connector.start("/p", "hello", []);
      assert.equal(outcome.taskId, "codex:t1");
      assert.equal(outcome.retainsLiveOwnership, true);
      assert.equal(connector.runsUnderBotBus, true);
      await waitUntil(() => connector.currentTurnId("t1") === "u1");
      assert.equal(tasks.get("codex:t1")?.status, "running");
      assert.equal(tasks.get("codex:t1")?.title, "hello");
      assert.equal(tasks.get("codex:t1")?.model, "gpt-5.1");
      assert.equal(tasks.get("codex:t1")?.effort, "high");
      assert.equal(live.has("codex:t1"), true);

      const interrupted = await connector.interrupt("codex:t1");
      assert.equal(interrupted.retainsLiveOwnership, true);
      handle.pushJSON({
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "u1", status: "interrupted" } },
      });
      await waitUntil(() => tasks.get("codex:t1")?.status === "interrupted" && !live.has("codex:t1"));

      // 审批：挂起 → 手机点允许 → 回给 app-server 并清掉任务上的 pendingRequest。
      handle.pushJSON({
        id: "srv-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t1", turnId: "u1", command: "ls", cwd: "/p" },
      });
      await waitUntil(() => tasks.get("codex:t1")?.pendingRequest?.id === "$srv-1");
      assert.equal(tasks.get("codex:t1")?.status, "waitingApproval");
      const approved = await connector.approve("codex:t1", "$srv-1", "allow");
      assert.equal(approved.retainsLiveOwnership, true);
      await waitUntil(() => tasks.get("codex:t1")?.pendingRequest === undefined);
      assert.ok(handle.written.some((line) => line.includes('"id":"srv-1"') && line.includes('"decision":"accept"')));

      // 续聊：线程已在当前代加载，直接 turn/start。
      handle.pushJSON({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u2", status: "completed" } } });
      const followed = await connector.followUp("codex:t1", "again", []);
      assert.equal(followed.taskId, "codex:t1");
      await waitUntil(() => tasks.get("codex:t1")?.status === "running");
    } finally {
      await connector.stop();
    }
  });
});

// MARK: - subprocess detection (no process is started)

describe("codex subprocess launcher", { concurrency: false }, () => {
  test("explicit launcher keeps its arguments and does not launch here", () => {
    const launcher = new CodexSubprocessLauncher("C:\\fake\\codex.exe", ["app-server"], { CODEX_HOME: "x" }, "C:\\work");
    assert.equal(launcher.executablePath, "C:\\fake\\codex.exe");
    assert.deepEqual(launcher.arguments, ["app-server"]);
    assert.equal(launcher.environment?.CODEX_HOME, "x");
    assert.equal(launcher.currentDirectory, "C:\\work");
    assert.equal(launcher.forwardStderr, false);
  });

  test("connector factory can be built without launching a real process", () => {
    const connector = new CodexConnector(
      {
        agentId: "agent-1",
        now: () => "2026-10-30T12:00:00Z",
        task: () => undefined,
        tasks: () => [],
        upsert: () => undefined,
        remove: () => undefined,
        rememberProject: () => undefined,
        rememberSession: () => undefined,
        emitMessages: () => undefined,
        claimLive: () => undefined,
        releaseLive: () => undefined,
        isLive: () => false,
      },
      new CodexAppServer({ async launch() { throw new Error("not started"); } }),
    );
    assert.equal(connector.kind, "codex");
    assert.equal(connector.runsUnderBotBus, true);
    assert.equal(connector.status.phase, "stopped");
  });
});
