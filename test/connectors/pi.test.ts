import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { BusTask } from "../../src/bus/store.js";
import type { ConnectorHost } from "../../src/connectors/ported/contract.js";
import { latestWindow, transcriptEntry } from "../../src/connectors/ported/contract.js";
import {
  createPiConnector,
  piArguments,
  type PiLaunchRequest,
  type PiProcessHandle,
  type PiProcessLauncher,
} from "../../src/connectors/pi/connector.js";
import { createPiMessageReader } from "../../src/connectors/pi/message-reader.js";
import {
  PiSessionFile,
  PiSessionReader,
  PiSessionSource,
  piPaths,
  transcriptFileRefCandidates,
} from "../../src/connectors/pi/index.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");

const homes: Array<{ cleanup(): Promise<void> }> = [];

after(async () => {
  for (const home of homes) await home.cleanup();
});

async function tempPiHome() {
  const root = await mkdtemp(join(tmpdir(), "agent-host-pi-"));
  const agent = join(root, "agent");
  const sessions = join(agent, "sessions");
  await mkdir(sessions, { recursive: true });
  const home = {
    root,
    agent,
    sessions,
    paths: piPaths(agent),
    async write(project: string, name: string, content: string): Promise<string> {
      const directory = join(sessions, project);
      await mkdir(directory, { recursive: true });
      const file = join(directory, name);
      await writeFile(file, content, "utf8");
      return file;
    },
    cleanup() {
      return rm(root, { recursive: true, force: true });
    },
  };
  homes.push(home);
  return home;
}

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function header(overrides: Record<string, unknown> = {}) {
  return {
    type: "session",
    version: 3,
    id: "s1",
    timestamp: "2026-10-30T10:00:00Z",
    cwd: "E:/work/demo",
    ...overrides,
  };
}

function userMessage(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-30T10:00:01Z",
    message: { role: "user", content: text, timestamp: NOW },
  };
}

function assistantMessage(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-30T10:00:02Z",
    message: { role: "assistant", content: text, stopReason: "stop", timestamp: NOW },
  };
}

describe("PiSessionReader tree", () => {
  test("walks the current branch backwards along parentId", () => {
    const file = PiSessionFile.parse(
      jsonl([
        header(),
        userMessage("e1", null, "root"),
        assistantMessage("e2", "e1", "first"),
        userMessage("e3", "e2", "branch A"),
        assistantMessage("e4", "e3", "answer A"),
        userMessage("e5", "e2", "branch B"),
        assistantMessage("e6", "e5", "answer B"),
      ]),
    );
    assert.ok(file);
    // 叶是文件里最后一条带 id 的 entry（e6）；被丢下的 A 支不进当前分支。
    assert.deepEqual(
      file.branch.map((entry) => entry.id),
      ["e1", "e2", "e5", "e6"],
    );
    assert.deepEqual(
      file.branch.map((entry) => (entry.kind.type === "message" ? entry.kind.message.text : "")),
      ["root", "first", "branch B", "answer B"],
    );
  });

  test("stops at a missing parent and keeps file order when ids are absent", () => {
    const broken = PiSessionFile.parse(
      jsonl([
        header(),
        userMessage("e1", "missing", "orphan"),
        assistantMessage("e2", "e1", "reply"),
      ]),
    );
    assert.ok(broken);
    assert.deepEqual(
      broken.branch.map((entry) => entry.id),
      ["e1", "e2"],
    );

    const linear = PiSessionFile.parse(
      jsonl([
        header(),
        { type: "message", timestamp: "2026-10-30T10:00:01Z", message: { role: "user", content: "a" } },
        { type: "message", timestamp: "2026-10-30T10:00:02Z", message: { role: "assistant", content: "b" } },
      ]),
    );
    assert.ok(linear);
    assert.equal(linear.branch.length, 2);
  });

  test("rejects a file whose first line is not a header", () => {
    assert.equal(PiSessionFile.parse(jsonl([userMessage("e1", null, "no header")])), null);
  });
});

describe("PiSessionSource cache", () => {
  test("reuses a summary until mtime or size changes", async () => {
    const home = await tempPiHome();
    const first = jsonl([
      header(),
      userMessage("e1", null, "hi"),
      assistantMessage("e2", "e1", "one"),
    ]);
    const second = first.replace('"content":"one"', '"content":"two"');
    const third = first.replace('"content":"one"', '"content":"three"');
    const fourth = first.replace('"content":"one"', '"content":"four!"');
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second));
    assert.equal(Buffer.byteLength(third), Buffer.byteLength(fourth));

    const file = await home.write("project", "20261030_s1.jsonl", first);
    const stamp = new Date("2026-10-29T00:00:00Z");
    await utimes(file, stamp, stamp);

    const source = new PiSessionSource({ paths: home.paths, now: () => NOW });
    const initial = await source.readSnapshot("agent-1");
    assert.equal(initial.tasks[0]?.lastMessage, "one");
    assert.deepEqual(
      initial.projects.map((project) => project.path),
      ["E:/work/demo"],
    );

    // 同样的大小与修改时间 → 命中缓存，仍是旧摘要。
    await writeFile(file, second, "utf8");
    await utimes(file, stamp, stamp);
    const cached = await source.readSnapshot("agent-1");
    assert.equal(cached.tasks[0]?.lastMessage, "one");

    // 修改时间不变但大小变了 → 缓存失效。
    await writeFile(file, third, "utf8");
    await utimes(file, stamp, stamp);
    const resized = await source.readSnapshot("agent-1");
    assert.equal(resized.tasks[0]?.lastMessage, "three");

    // 大小相同、内容不同、修改时间相同 → 仍命中缓存。
    await writeFile(file, fourth, "utf8");
    await utimes(file, stamp, stamp);
    assert.equal((await source.readSnapshot("agent-1")).tasks[0]?.lastMessage, "three");

    // 修改时间变了 → 重读，拿到新摘要。
    const later = new Date(stamp.getTime() + 60_000);
    await utimes(file, later, later);
    const refreshed = await source.readSnapshot("agent-1");
    assert.equal(refreshed.tasks[0]?.lastMessage, "four!");
  });

  test("infers status from tail, activity and file mtime", () => {
    assert.equal(PiSessionReader.status("completed", NOW, NOW, NOW), "completed");
    assert.equal(PiSessionReader.status("failed", NOW, NOW, NOW), "failed");
    assert.equal(PiSessionReader.status("aborted", NOW, NOW, NOW), "interrupted");
    assert.equal(PiSessionReader.status("empty", NOW, NOW, NOW), "idle");
    assert.equal(PiSessionReader.status("open", NOW, NOW - 60_000, NOW), "running");
    assert.equal(PiSessionReader.status("open", NOW, NOW - 5 * 60_000, NOW), "interrupted");
    assert.equal(
      PiSessionReader.status("completed", NOW - 25 * 60 * 60_000, NOW, NOW),
      "idle",
    );
  });
});

describe("PiMessageReader mapping", () => {
  test("maps user/assistant/tool/bashExecution and skips toolResult", async () => {
    const home = await tempPiHome();
    const png = Buffer.from("PNGDATA").toString("base64");
    await home.write(
      "project",
      "20261030_s1.jsonl",
      jsonl([
        header(),
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-10-30T10:00:01Z",
          message: {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", data: png, mimeType: "image/png" },
            ],
            timestamp: NOW,
          },
        },
        {
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: "2026-10-30T10:00:02Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "done out/a.png." },
              { type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
              { type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
            ],
            stopReason: "stop",
            timestamp: NOW,
          },
        },
        {
          type: "message",
          id: "m3",
          parentId: "m2",
          timestamp: "2026-10-30T10:00:03Z",
          message: { role: "toolResult", content: "huge log", timestamp: NOW },
        },
        {
          type: "message",
          id: "m4",
          parentId: "m3",
          timestamp: "2026-10-30T10:00:04Z",
          message: { role: "bashExecution", command: "ls\n-la", timestamp: NOW },
        },
      ]),
    );

    const reader = createPiMessageReader({ paths: home.paths });
    assert.equal(reader.kind, "pi");
    const { entries, hasMore } = await reader.entries("pi:s1", 40);
    assert.equal(hasMore, false);
    assert.deepEqual(
      entries.map((entry) => `${entry.message.role}|${entry.message.id}|${entry.message.text}`),
      [
        "user|m1|look",
        "agent|m2|done out/a.png.",
        "tool|m2#1|bash: ls -la",
        "tool|m2#2|read src/a.ts",
        "tool|m4|$ ls -la",
      ],
    );

    const image = entries[0]?.images[0];
    assert.equal(image?.type, "data");
    if (image?.type === "data") {
      assert.equal(Buffer.from(image.data).toString(), "PNGDATA");
    }
    assert.deepEqual(entries[1]?.pathCandidates, ["out/a.png"]);
  });

  test("keeps only the latest conversation and adjacent tool rows", async () => {
    const home = await tempPiHome();
    await home.write(
      "project",
      "20261030_s1.jsonl",
      jsonl([
        header(),
        userMessage("m1", null, "one"),
        assistantMessage("m2", "m1", "reply one"),
        userMessage("m3", "m2", "two"),
        assistantMessage("m4", "m3", "answer two"),
      ]),
    );
    const reader = createPiMessageReader({ paths: home.paths });
    const { entries, hasMore } = await reader.entries("pi:s1", 1);
    assert.equal(hasMore, true);
    assert.deepEqual(
      entries.map((entry) => entry.message.id),
      ["m4"],
    );

    // 窗口规则本身：工具行不占对话名额，夹在其中的工具行跟着保留。
    const at = "2026-10-30T10:00:00.000Z";
    const make = (id: string, role: "user" | "agent" | "tool", text: string) =>
      transcriptEntry({ id, role, text, createdAt: at });
    const all = [
      make("u1", "user", "one"),
      make("t1", "tool", "cmd1"),
      make("a1", "agent", "reply"),
      make("u2", "user", "two"),
      make("t2", "tool", "cmd2"),
      make("a2", "agent", "answer"),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const window = latestWindow(all, 1);
    assert.equal(window.hasMore, true);
    assert.deepEqual(
      window.entries.map((entry) => entry.message.id),
      ["t2", "a2"],
    );
  });

  test("extracts media path candidates from replies", () => {
    assert.deepEqual(
      transcriptFileRefCandidates("见 out/a.png. 还有 `src/shot.webp`，跳过 https://x/y.png"),
      ["out/a.png", "src/shot.webp"],
    );
  });
});

class FakeHandle implements PiProcessHandle {
  interrupted = false;
  terminated = false;
  interrupt() {
    this.interrupted = true;
  }
  terminate() {
    this.terminated = true;
  }
}

type FakeLaunch = {
  request: PiLaunchRequest;
  handle: FakeHandle;
  output(line: string): void;
  exit(status: number): void;
};

function fakeLauncher(sessionID = "s1") {
  const launches: FakeLaunch[] = [];
  const launcher: PiProcessLauncher = {
    launch(request, onOutput, onExit) {
      const handle = new FakeHandle();
      const record: FakeLaunch = {
        request,
        handle,
        output: (line) => onOutput(Buffer.from(`${line}\n`)),
        exit: onExit,
      };
      launches.push(record);
      queueMicrotask(() => record.output(JSON.stringify({ type: "session", id: sessionID })));
      return handle;
    },
  };
  return { launcher, launches };
}

function fakeHost(initial: BusTask[] = []) {
  const tasks = new Map(initial.map((task) => [task.id, task]));
  const live = new Set<string>();
  const host: ConnectorHost = {
    agentId: "agent-1",
    now: () => "2026-10-30T12:00:00.000Z",
    task: (taskId) => tasks.get(taskId),
    tasks: () => [...tasks.values()],
    upsert: (task) => {
      tasks.set(task.id, task);
    },
    remove: (taskId) => {
      tasks.delete(taskId);
    },
    rememberProject: () => undefined,
    rememberSession: () => undefined,
    emitMessages: () => undefined,
    claimLive: (taskId) => {
      live.add(taskId);
    },
    releaseLive: (taskId) => {
      live.delete(taskId);
    },
    isLive: (taskId) => live.has(taskId),
  };
  return { host, tasks, live };
}

async function projectDirectory(home: { root: string }) {
  const project = join(home.root, "project");
  await mkdir(project, { recursive: true });
  return project;
}

describe("PiConnector", () => {
  test("launches pi, owns the turn and releases after completion", async () => {
    const home = await tempPiHome();
    const project = await projectDirectory(home);
    const { launcher, launches } = fakeLauncher("s1");
    const { host, live } = fakeHost();
    const connector = createPiConnector(host, {
      paths: () => home.paths,
      binary: () => "pi",
      launcher,
      sessionIdTimeoutMs: 1_000,
      releaseRetryDelayMs: 5,
    });

    const outcome = await connector.start(project, "hello", []);
    assert.equal(outcome.taskId, "pi:s1");
    assert.equal(outcome.retainsLiveOwnership, true);
    assert.equal(live.has("pi:s1"), true);

    assert.deepEqual(launches[0].request.arguments, ["--mode", "json", "hello"]);
    assert.equal(launches[0].request.workingDirectory, project);
    assert.equal(host.task("pi:s1")?.status, "running");
    assert.equal(host.task("pi:s1")?.origin, "watch");

    launches[0].output(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: "done", stopReason: "stop" },
      }),
    );
    launches[0].output(JSON.stringify({ type: "agent_settled" }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(host.task("pi:s1")?.status, "completed");
    assert.equal(host.task("pi:s1")?.lastMessage, "done");
    assert.equal(live.has("pi:s1"), false);
    launches[0].exit(0);
  });

  test("interrupt marks the turn interrupted and keeps ownership until exit", async () => {
    const home = await tempPiHome();
    const project = await projectDirectory(home);
    const { launcher, launches } = fakeLauncher("s1");
    const { host } = fakeHost();
    const connector = createPiConnector(host, {
      paths: () => home.paths,
      binary: () => "pi",
      launcher,
      sessionIdTimeoutMs: 1_000,
      releaseRetryDelayMs: 5,
    });
    await connector.start(project, "hello", []);

    const outcome = await connector.interrupt("pi:s1");
    assert.equal(outcome.retainsLiveOwnership, true);
    assert.equal(launches[0].handle.interrupted, true);
    assert.equal(host.task("pi:s1")?.status, "interrupted");

    // 进程退出时不要把 interrupted 改回 completed。
    launches[0].output(JSON.stringify({ type: "agent_settled" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(host.task("pi:s1")?.status, "interrupted");
  });

  test("followUp resumes with the absolute session file and header cwd", async () => {
    const home = await tempPiHome();
    const project = await projectDirectory(home);
    const file = await home.write(
      "project",
      "20261030_s1.jsonl",
      jsonl([header({ cwd: project }), userMessage("e1", null, "hi"), assistantMessage("e2", "e1", "hello")]),
    );
    const { launcher, launches } = fakeLauncher("s1");
    const { host } = fakeHost();
    const connector = createPiConnector(host, {
      paths: () => home.paths,
      binary: () => "pi",
      launcher,
      sessionIdTimeoutMs: 1_000,
      releaseRetryDelayMs: 5,
    });

    const outcome = await connector.followUp("pi:s1", "again", []);
    assert.equal(outcome.taskId, "pi:s1");
    assert.deepEqual(launches[0].request.arguments, [
      "--mode",
      "json",
      "--session",
      file,
      "again",
    ]);
    assert.equal(launches[0].request.workingDirectory, project);
  });

  test("rejects images, model selection and approvals explicitly", async () => {
    const home = await tempPiHome();
    const project = await projectDirectory(home);
    const { launcher, launches } = fakeLauncher("s1");
    const { host } = fakeHost();
    const connector = createPiConnector(host, {
      paths: () => home.paths,
      binary: () => "pi",
      launcher,
      sessionIdTimeoutMs: 1_000,
      releaseRetryDelayMs: 5,
    });

    await assert.rejects(
      connector.start(project, "hi", [{ type: "file", path: "x.png" }]),
      /这个 Agent 暂不支持发图/,
    );
    await assert.rejects(
      connector.start(project, "hi", [], { model: "x" }),
      /不能从手机换模型/,
    );
    await assert.rejects(
      connector.approve("pi:s1", "r1", "allow"),
      /Pi 没有审批机制，工具调用不需要批准/,
    );
    assert.equal(launches.length, 0);

    // prompt 以 - / @ 开头时垫一个空格，避免被解释成命令行语法。
    assert.deepEqual(piArguments("-rf", undefined, undefined), ["--mode", "json", " -rf"]);
    assert.deepEqual(piArguments("@file", undefined, undefined), ["--mode", "json", " @file"]);
  });
});
