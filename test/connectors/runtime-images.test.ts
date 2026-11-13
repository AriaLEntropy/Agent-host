import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ARTIFACT_TTL_MS, putUpload, setArtifactsDir } from "../../src/bus/artifacts.js";
import { busStore } from "../../src/bus/store.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import type {
  ImageSource,
  MessageReader,
  TaskConnector,
} from "../../src/connectors/ported/contract.js";
import {
  MAX_ATTACHMENT_IMAGES,
  executeCommand,
  resetRuntime,
  resolveImages,
  setDedicatedFactories,
  setDshFactories,
  useAgents,
  type DshConnectorInstance,
} from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const projectDir = process.cwd();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

type Call = { method: string; args: unknown[] };

let dir: string;

function artifactId(seed: string): string {
  return createHash("sha256").update(seed).digest().subarray(0, 16).toString("base64url");
}

function attachmentFor(id: string): Record<string, unknown> {
  return { artifactId: id, contentType: "image/png", size: PNG.length };
}

function expectedPath(id: string): string {
  return join(dir, `${id}.bin`);
}

async function upload(seed: string, now?: Date): Promise<string> {
  const id = artifactId(seed);
  await putUpload(id, PNG, "image/png", now);
  return id;
}

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

function recordingConnector(kind: string, calls: Call[]): TaskConnector {
  const outcome = { taskId: `${kind}:native-1`, retainsLiveOwnership: true };
  return {
    kind: kind as TaskConnector["kind"],
    runsUnderBotBus: true,
    async start(projectPath, prompt, images, selection) {
      calls.push({ method: "start", args: [projectPath, prompt, images, selection] });
      return outcome;
    },
    async followUp(taskId, prompt, images, selection) {
      calls.push({ method: "followUp", args: [taskId, prompt, images, selection] });
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

function fakeDsh(calls: Call[]): DshConnectorInstance {
  const outcome = { taskId: "dsh:native-1", retainsLiveOwnership: true };
  return {
    kind: "dsh",
    runsUnderBotBus: true,
    startObserving() {},
    async stop() {},
    async start(projectPath, prompt, images, selection) {
      calls.push({ method: "start", args: [projectPath, prompt, images, selection] });
      return outcome;
    },
    async followUp(taskId, prompt, images, selection) {
      calls.push({ method: "followUp", args: [taskId, prompt, images, selection] });
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
      return { entries: [], hasMore: false };
    },
  };
}

function reset() {
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
}

function agentArgs() {
  const script = new URL("../fixtures/fake-acp.mjs", import.meta.url);
  return [script.pathname.replace(/^\/([A-Za-z]:)/, "$1")];
}

async function until(read: () => boolean) {
  const started = Date.now();
  while (!read()) {
    if (Date.now() - started > 5000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-host-runtime-images-"));
  setArtifactsDir(dir);
});

afterEach(async () => {
  resetRuntime();
  setArtifactsDir(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("runtime images", { concurrency: false }, () => {
  test("resolveImages maps artifact ids to file sources and rejects missing ones", async () => {
    const id = await upload("resolve-images");
    const images = await resolveImages([attachmentFor(id)], "codex");
    assert.deepEqual(images, [{ type: "file", path: expectedPath(id) }]);

    await assert.rejects(
      resolveImages([attachmentFor(artifactId("missing"))], "codex"),
      (error: unknown) =>
        error instanceof Error && error.message === `附件已过期或不存在：${artifactId("missing")}`,
    );
    assert.deepEqual(await resolveImages([], "codex"), []);
  });

  test("dedicated start and followUp receive resolved ImageSource paths", async () => {
    reset();
    const calls: Call[] = [];
    setDedicatedFactories({
      connectors: { codex: () => recordingConnector("codex", calls) },
      readers: { codex: () => fakeReader("codex") },
    });
    useAgents([specFor("codex")]);
    const id = await upload("dedicated-images");

    const started = await executeCommand({
      id: "start-image",
      kind: "startTask",
      startTask: {
        source: "codex",
        projectPath: projectDir,
        prompt: "see this",
        attachments: [attachmentFor(id)],
      },
    });
    assert.equal(started.ok, true, started.error);
    const start = calls.find((call) => call.method === "start");
    assert.deepEqual((start?.args?.[2] as ImageSource[]) ?? [], [
      { type: "file", path: expectedPath(id) },
    ]);

    const followed = await executeCommand({
      id: "follow-image",
      kind: "followUp",
      followUp: { taskId: "codex:native-1", prompt: "and this", attachments: [attachmentFor(id)] },
    });
    assert.equal(followed.ok, true, followed.error);
    const follow = calls.find((call) => call.method === "followUp");
    assert.deepEqual((follow?.args?.[2] as ImageSource[]) ?? [], [
      { type: "file", path: expectedPath(id) },
    ]);
  });

  test("a missing or expired attachment fails before the connector is called", async () => {
    reset();
    const calls: Call[] = [];
    setDedicatedFactories({
      connectors: { codex: () => recordingConnector("codex", calls) },
      readers: { codex: () => fakeReader("codex") },
    });
    useAgents([specFor("codex")]);

    const missing = artifactId("never-uploaded");
    const failed = await executeCommand({
      id: "start-missing-image",
      kind: "startTask",
      startTask: {
        source: "codex",
        projectPath: projectDir,
        prompt: "see this",
        attachments: [attachmentFor(missing)],
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, `附件已过期或不存在：${missing}`);
    assert.equal(calls.some((call) => call.method === "start"), false);

    const expired = await upload("expired-image", new Date(Date.now() - ARTIFACT_TTL_MS - 1000));
    const expiredResult = await executeCommand({
      id: "start-expired-image",
      kind: "startTask",
      startTask: {
        source: "codex",
        projectPath: projectDir,
        prompt: "see this",
        attachments: [attachmentFor(expired)],
      },
    });
    assert.equal(expiredResult.ok, false);
    assert.equal(expiredResult.error, `附件已过期或不存在：${expired}`);
    assert.equal(calls.some((call) => call.method === "start"), false);
  });

  test("more than four attachments are rejected defensively", async () => {
    reset();
    const calls: Call[] = [];
    setDedicatedFactories({
      connectors: { codex: () => recordingConnector("codex", calls) },
      readers: { codex: () => fakeReader("codex") },
    });
    useAgents([specFor("codex")]);
    const attachments = Array.from({ length: MAX_ATTACHMENT_IMAGES + 1 }, (_, index) =>
      attachmentFor(artifactId(`too-many-${index}`)),
    );

    const started = await executeCommand({
      id: "start-too-many-images",
      kind: "startTask",
      startTask: {
        source: "codex",
        projectPath: projectDir,
        prompt: "see these",
        attachments,
      },
    });
    assert.equal(started.ok, false);
    assert.match(started.error ?? "", new RegExp(`最多只能发 ${MAX_ATTACHMENT_IMAGES} 个附件`));
    assert.equal(calls.some((call) => call.method === "start"), false);
  });

  test("a connector that does not support images reports its own error", async () => {
    reset();
    // 不注入假连接器：走真实的 Hermes 连接器，确认错误文案由它自己给出。
    useAgents([specFor("hermes")]);
    const id = await upload("hermes-image");

    const started = await executeCommand({
      id: "start-hermes-image",
      kind: "startTask",
      startTask: {
        source: "hermes",
        projectPath: projectDir,
        prompt: "see this",
        attachments: [attachmentFor(id)],
      },
    });
    assert.equal(started.ok, false);
    assert.equal(started.error, "这个 Agent 暂不支持发图");
  });

  test("dsh receives resolved image paths and can reject them in its own words", async () => {
    reset();
    const calls: Call[] = [];
    setDshFactories({ connector: () => fakeDsh(calls), reader: () => fakeReader("dsh") });
    useAgents([specFor("dsh")]);
    const id = await upload("dsh-image");

    const started = await executeCommand({
      id: "start-dsh-image",
      kind: "startTask",
      startTask: { source: "dsh", projectPath: projectDir, prompt: "see this", attachments: [attachmentFor(id)] },
    });
    assert.equal(started.ok, true, started.error);
    const start = calls.find((call) => call.method === "start");
    assert.deepEqual((start?.args?.[2] as ImageSource[]) ?? [], [
      { type: "file", path: expectedPath(id) },
    ]);

    const followed = await executeCommand({
      id: "follow-dsh-image",
      kind: "followUp",
      followUp: { taskId: "dsh:native-1", prompt: "again", attachments: [attachmentFor(id)] },
    });
    assert.equal(followed.ok, true, followed.error);
    const follow = calls.find((call) => call.method === "followUp");
    assert.deepEqual((follow?.args?.[2] as ImageSource[]) ?? [], [
      { type: "file", path: expectedPath(id) },
    ]);
  });

  test("acp rejects images unless the agent advertises the image capability", async () => {
    reset();
    useAgents([
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable: process.execPath,
        args: agentArgs(),
        env: {},
        origin: "manifest",
        available: true,
        enabled: true,
      },
    ]);
    const id = await upload("acp-no-image");

    const started = await executeCommand({
      id: "start-acp-no-image",
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: projectDir,
        prompt: "see this",
        attachments: [attachmentFor(id)],
      },
    });
    assert.equal(started.ok, false);
    assert.equal(started.error, "image is not supported");
  });

  test("acp sends image content blocks when the agent supports them", async () => {
    reset();
    useAgents([
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable: process.execPath,
        args: agentArgs(),
        env: { FAKE_ACP_IMAGE: "1" },
        origin: "manifest",
        available: true,
        enabled: true,
      },
    ]);
    const id = await upload("acp-image");
    const suffix = `|images=image/png:${PNG.length}`;

    const started = await executeCommand({
      id: "start-acp-image",
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: projectDir,
        prompt: "ECHO:first",
        attachments: [attachmentFor(id)],
      },
    });
    assert.equal(started.ok, true, started.error);
    await until(() => busStore.taskById(started.taskId!)?.lastMessage === `first${suffix}`);

    const followed = await executeCommand({
      id: "follow-acp-image",
      kind: "followUp",
      followUp: { taskId: started.taskId!, prompt: "ECHO:second", attachments: [attachmentFor(id)] },
    });
    assert.equal(followed.ok, true, followed.error);
    await until(() => busStore.taskById(started.taskId!)?.lastMessage === `second${suffix}`);
  });

  test("commands without attachments still pass an empty image list", async () => {
    reset();
    const calls: Call[] = [];
    setDedicatedFactories({
      connectors: { codex: () => recordingConnector("codex", calls) },
      readers: { codex: () => fakeReader("codex") },
    });
    useAgents([specFor("codex")]);
    const started = await executeCommand({
      id: "start-no-images",
      kind: "startTask",
      startTask: { source: "codex", projectPath: projectDir, prompt: "hello" },
    });
    assert.equal(started.ok, true, started.error);
    assert.deepEqual(calls.find((call) => call.method === "start")?.args?.[2], []);
  });
});
