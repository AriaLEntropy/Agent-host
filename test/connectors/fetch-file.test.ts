// `fetchFile`（协议 2.9 / FR-14.5.3）与 `fetchMessages` 的文件卡片。
// 全部使用临时项目目录与临时产物目录，绝不读真实用户文件。

import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { getArtifact, setArtifactsDir } from "../../src/bus/artifacts.js";
import { busStore } from "../../src/bus/store.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import type {
  MessageReader,
  TaskConnector,
  TranscriptEntry,
} from "../../src/connectors/ported/contract.js";
import {
  executeCommand,
  resetRuntime,
  setDedicatedFactories,
  useAgents,
} from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const TASK_ID = "codex:thread-1";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33]);

let artifactsDir: string;
let projectDir: string;
let entries: TranscriptEntry[];

function specFor(kind: string): AgentSpec {
  return {
    id: kind,
    kind,
    name: kind,
    executable: `C:/fake/${kind}.exe`,
    args: [],
    env: {},
    origin: "dedicated",
    available: true,
    enabled: true,
    status: "ok",
  };
}

function fakeConnector(kind: string): TaskConnector {
  const outcome = { taskId: `${kind}:native-1`, retainsLiveOwnership: true };
  return {
    kind: kind as TaskConnector["kind"],
    runsUnderBotBus: true,
    async start() {
      return outcome;
    },
    async followUp() {
      return outcome;
    },
    async approve() {
      return outcome;
    },
    async interrupt() {
      return outcome;
    },
  };
}

function fakeReader(kind: string): MessageReader {
  return {
    kind: kind as MessageReader["kind"],
    async entries() {
      return { entries, hasMore: false };
    },
  };
}

function agentEntry(id: string, pathCandidates: string[]): TranscriptEntry {
  return {
    message: {
      id,
      role: "agent",
      text: pathCandidates.map((item) => `see ${item}`).join("\n"),
      createdAt: new Date().toISOString(),
    },
    images: [],
    pathCandidates,
  };
}

function rememberTask(projectPath = projectDir, taskId = TASK_ID) {
  const now = new Date().toISOString();
  busStore.upsertTask({
    id: taskId,
    agentId,
    source: "codex",
    title: "demo",
    projectPath,
    projectName: "demo",
    status: "completed",
    origin: "desktop",
    controllable: true,
    startedAt: now,
    updatedAt: now,
  });
}

async function createFile(relative: string, bytes: Buffer = PNG): Promise<string> {
  const path = join(projectDir, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return realpath(path);
}

function fetchFileCommand(path: string, messageId = "msg-agent", taskId = TASK_ID) {
  return executeCommand({
    id: `fetch-${Math.random().toString(16).slice(2)}`,
    kind: "fetchFile",
    fetchFile: { taskId, messageId, path },
  });
}

function fetchMessagesCommand() {
  return executeCommand({
    id: `messages-${Math.random().toString(16).slice(2)}`,
    kind: "fetchMessages",
    fetchMessages: { taskId: TASK_ID },
  });
}

function reset() {
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
  setDedicatedFactories({
    connectors: { codex: () => fakeConnector("codex") },
    readers: { codex: () => fakeReader("codex") },
  });
  useAgents([specFor("codex")]);
}

beforeEach(async () => {
  artifactsDir = await realpath(await mkdtemp(join(tmpdir(), "agent-host-fetch-artifacts-")));
  projectDir = await realpath(await mkdtemp(join(tmpdir(), "agent-host-fetch-project-")));
  setArtifactsDir(artifactsDir);
  entries = [];
  reset();
  rememberTask();
});

afterEach(async () => {
  resetRuntime();
  busStore.reset();
  setArtifactsDir(undefined);
  await rm(artifactsDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

async function storedMessages() {
  return busStore.messagesFor(TASK_ID)?.messages ?? [];
}

describe("fetchFile", { concurrency: false }, () => {
  test("uploads a file mentioned by an agent reply and publishes its artifactId", async () => {
    const path = await createFile("out/demo.png");
    entries = [agentEntry("msg-agent", ["out/demo.png"])];

    const result = await fetchFileCommand(path);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.taskId, TASK_ID);

    const messages = await storedMessages();
    assert.equal(messages.length, 1);
    const [file] = messages[0]!.files ?? [];
    assert.ok(file, "agent message has no files");
    assert.equal(file.path, path);
    assert.equal(file.name, "demo.png");
    assert.equal(file.contentType, "image/png");
    assert.equal(file.size, PNG.length);
    assert.match(file.artifactId ?? "", /^[A-Za-z0-9_-]{22}$/);

    const artifact = await getArtifact(file.artifactId!);
    assert.ok(artifact);
    assert.deepEqual(artifact.bytes, PNG);
    assert.equal(artifact.contentType, "image/png");

    // 只读：不碰任务状态。
    assert.equal(busStore.taskById(TASK_ID)?.status, "completed");
  });

  test("supports PDF and video content types beyond the upload limits", async () => {
    const pdf = await createFile("docs/spec.pdf", Buffer.from("%PDF-1.7\n..."));
    entries = [agentEntry("msg-agent", ["docs/spec.pdf"])];

    const result = await fetchFileCommand(pdf);
    assert.equal(result.ok, true, result.error);
    const [file] = (await storedMessages())[0]!.files ?? [];
    assert.equal(file?.contentType, "application/pdf");
    assert.deepEqual((await getArtifact(file!.artifactId!))?.bytes, Buffer.from("%PDF-1.7\n..."));
  });

  test("reuses the artifact id when the same file is fetched twice", async () => {
    const path = await createFile("out/demo.png");
    entries = [agentEntry("msg-agent", [path])];

    const first = await fetchFileCommand(path);
    assert.equal(first.ok, true, first.error);
    const firstId = (await storedMessages())[0]!.files![0]!.artifactId;

    const second = await fetchFileCommand(path);
    assert.equal(second.ok, true, second.error);
    const secondId = (await storedMessages())[0]!.files![0]!.artifactId;
    assert.equal(secondId, firstId);

    const bins = (await readdir(artifactsDir)).filter((name) => name.endsWith(".bin"));
    assert.equal(bins.length, 1, "the file was uploaded more than once");
  });

  test("rejects a message that is not an agent reply", async () => {
    const path = await createFile("out/demo.png");
    entries = [
      {
        message: {
          id: "msg-agent",
          role: "user",
          text: "mine",
          createdAt: new Date().toISOString(),
        },
        images: [],
        pathCandidates: [path],
      },
    ];
    const result = await fetchFileCommand(path);
    assert.equal(result.ok, false);
    assert.equal(result.error, "这个文件不在对话里");
    assert.deepEqual(await readdir(artifactsDir), []);
  });

  test("rejects a path the message does not mention", async () => {
    await createFile("out/mentioned.png");
    const other = await createFile("out/other.png");
    entries = [agentEntry("msg-agent", ["out/mentioned.png"])];

    const result = await fetchFileCommand(other);
    assert.equal(result.ok, false);
    assert.equal(result.error, "这个文件不在对话里");
    assert.deepEqual(await readdir(artifactsDir), []);
  });

  test("rejects missing files, unsupported extensions and dot directories", async () => {
    const missing = join(projectDir, "out", "missing.png");
    entries = [agentEntry("msg-agent", ["out/missing.png"])];
    assert.equal((await fetchFileCommand(missing)).ok, false);

    const text = await createFile("notes.txt");
    entries = [agentEntry("msg-agent", [text])];
    const unsupported = await fetchFileCommand(text);
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, "这个文件不在对话里");

    const dotted = await createFile(".hidden/secret.png");
    entries = [agentEntry("msg-agent", [dotted])];
    assert.equal((await fetchFileCommand(dotted)).ok, false);

    assert.deepEqual(await readdir(artifactsDir), []);
  });

  test("rejects a path outside the project even when the message mentions it", async () => {
    const outside = join(projectDir, "..", `outside-${process.pid}.png`);
    await writeFile(outside, PNG);
    try {
      entries = [agentEntry("msg-agent", [outside])];
      const result = await fetchFileCommand(outside);
      assert.equal(result.ok, false);
      assert.equal(result.error, "这个文件不在对话里");
      assert.deepEqual(await readdir(artifactsDir), []);
    } finally {
      await rm(outside, { force: true });
    }
  });

  test("rejects a symlink escaping the project", async (t) => {
    const outsideDir = join(projectDir, "..", `outside-${process.pid}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "escape.png"), PNG);
    const link = join(projectDir, "link");
    try {
      await symlink(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      await rm(outsideDir, { recursive: true, force: true });
      t.skip("creating symlinks is not permitted on this machine");
      return;
    }
    try {
      const candidate = join(link, "escape.png");
      entries = [agentEntry("msg-agent", [candidate])];
      const result = await fetchFileCommand(candidate);
      assert.equal(result.ok, false);
      assert.equal(result.error, "这个文件不在对话里");
      assert.deepEqual(await readdir(artifactsDir), []);
    } finally {
      // 先摘链接再删目标：Windows 上不要顺着 junction 删东西。
      await unlink(link).catch(() => undefined);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("rejects malformed payloads and unknown tasks without touching disk", async () => {
    assert.equal((await fetchFileCommand("", "msg-agent")).ok, false);
    assert.equal((await fetchFileCommand("x".repeat(1025), "msg-agent")).ok, false);
    assert.equal((await fetchFileCommand("C:/somewhere/a.png", "")).ok, false);

    const missingTask = await fetchFileCommand("C:/somewhere/a.png", "msg-agent", "codex:none");
    assert.equal(missingTask.ok, false);
    assert.match(missingTask.error ?? "", /本机没有这个任务/);

    // 项目外的会话（空 projectPath）同样拒绝。
    rememberTask("", "codex:outside");
    const outsideTask = await fetchFileCommand(join(projectDir, "x.png"), "msg-agent", "codex:outside");
    assert.equal(outsideTask.ok, false);
    assert.match(outsideTask.error ?? "", /本机没有这个任务/);
  });
});

describe("fetchMessages file metadata", { concurrency: false }, () => {
  test("agent messages carry files without an artifactId before fetchFile", async () => {
    const path = await createFile("out/demo.png");
    entries = [
      agentEntry("msg-agent", ["out/demo.png"]),
      {
        message: {
          id: "msg-user",
          role: "user",
          text: "thanks",
          createdAt: new Date().toISOString(),
        },
        images: [],
        pathCandidates: [],
      },
    ];

    const result = await fetchMessagesCommand();
    assert.equal(result.ok, true, result.error);
    const messages = await storedMessages();
    const agent = messages.find((message) => message.id === "msg-agent");
    assert.ok(agent?.files);
    assert.equal(agent.files.length, 1);
    assert.equal(agent.files[0]!.path, path);
    assert.equal(agent.files[0]!.name, "demo.png");
    assert.equal(agent.files[0]!.contentType, "image/png");
    assert.equal(agent.files[0]!.size, PNG.length);
    assert.equal("artifactId" in agent.files[0]!, false);
    assert.equal(messages.find((message) => message.id === "msg-user")?.files, undefined);
  });

  test("fetchMessages keeps an artifactId that was already fetched", async () => {
    const path = await createFile("out/demo.png");
    entries = [agentEntry("msg-agent", [path])];
    assert.equal((await fetchFileCommand(path)).ok, true);
    const fetchedId = (await storedMessages())[0]!.files![0]!.artifactId;

    assert.equal((await fetchMessagesCommand()).ok, true);
    assert.equal((await storedMessages())[0]!.files![0]!.artifactId, fetchedId);
  });
});
