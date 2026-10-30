import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { busStore } from "../../src/bus/store.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import type { MessageReader } from "../../src/connectors/ported/contract.js";
import {
  executeCommand,
  refreshAgents,
  resetRuntime,
  setDshFactories,
  useAgents,
  type DshConnectorInstance,
} from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";

// 启停会写本机设置：测试一律指向临时目录，不碰真实 %APPDATA%。
process.env.AGENT_HOST_CONNECTOR_SETTINGS = join(
  mkdtempSync(join(tmpdir(), "agent-host-dsh-settings-")),
  "connector-settings.json",
);

type Call = { method: string; args: unknown[] };

function dshSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: "dsh",
    kind: "dsh",
    name: "DeepSeek Harness",
    executable: "C:/fake/dsh.exe",
    args: ["--profile", "acp"],
    env: {},
    origin: "dsh",
    available: true,
    enabled: true,
    ...overrides,
  };
}

function fakeConnector(
  calls: Call[],
  lifecycle: { started: number; stopped: number },
  options: { deleteTask?: boolean } = {},
): DshConnectorInstance {
  const outcome = { taskId: "dsh:native-1", retainsLiveOwnership: true };
  const connector: DshConnectorInstance = {
    kind: "dsh",
    runsUnderBotBus: true,
    startObserving() {
      lifecycle.started += 1;
    },
    async stop() {
      lifecycle.stopped += 1;
    },
    async start(projectPath, prompt, images, selection) {
      calls.push({ method: "start", args: [projectPath, prompt, images, selection] });
      return outcome;
    },
    async followUp(taskId, prompt, images, selection) {
      calls.push({ method: "followUp", args: [taskId, prompt, images, selection] });
      return outcome;
    },
    async approve(taskId, requestId, decision, answers) {
      calls.push({ method: "approve", args: [taskId, requestId, decision, answers] });
      return outcome;
    },
    async interrupt(taskId) {
      calls.push({ method: "interrupt", args: [taskId] });
      return outcome;
    },
  };
  if (options.deleteTask) {
    connector.deleteTask = async (taskId) => {
      calls.push({ method: "deleteTask", args: [taskId] });
    };
  }
  return connector;
}

function fakeReader(reads: string[]): MessageReader {
  return {
    kind: "dsh",
    async entries(taskId, limit) {
      reads.push(`${taskId}:${limit}`);
      return {
        entries: [
          {
            message: { id: "m1", role: "agent", text: "hello", createdAt: "2026-10-30T00:00:00Z" },
            // 图片与路径候选没有宿主服务：确认它们被丢掉而不是假装发出去。
            images: [{ type: "file", path: "C:/tmp/shot.png" }],
            pathCandidates: ["C:/tmp/shot.png"],
          },
        ],
        hasMore: true,
      };
    },
  };
}

function reset() {
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
}

describe("dsh runtime integration", { concurrency: false }, () => {
  test("start, followUp, approve, interrupt, fetchMessages and deleteTask route to dsh", async () => {
    reset();
    const calls: Call[] = [];
    const reads: string[] = [];
    const lifecycle = { started: 0, stopped: 0 };
    setDshFactories({
      connector: () => fakeConnector(calls, lifecycle, { deleteTask: true }),
      reader: () => fakeReader(reads),
    });
    useAgents([dshSpec()]);
    assert.equal(lifecycle.started, 1, "startObserving should run when the agent appears");

    const started = await executeCommand({
      id: "start-dsh",
      kind: "startTask",
      startTask: {
        source: "dsh",
        projectPath: "C:/work/demo",
        prompt: "hello",
        model: "deepseek",
        effort: "high",
      },
    });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.taskId, "dsh:native-1");
    assert.deepEqual(calls.find((call) => call.method === "start")?.args, [
      "C:/work/demo",
      "hello",
      [],
      { model: "deepseek", effort: "high" },
    ]);

    const taskId = "dsh:native-1";
    const followed = await executeCommand({
      id: "follow-dsh",
      kind: "followUp",
      followUp: { taskId, prompt: "again" },
    });
    assert.equal(followed.ok, true, followed.error);
    assert.equal(followed.taskId, taskId);
    assert.deepEqual(calls.find((call) => call.method === "followUp")?.args, [
      taskId,
      "again",
      [],
      undefined,
    ]);

    const approved = await executeCommand({
      id: "approve-dsh",
      kind: "approve",
      approve: {
        taskId,
        requestId: "req-1",
        decision: "deny",
        answers: { q1: ["no"] },
      },
    });
    assert.equal(approved.ok, true, approved.error);
    assert.deepEqual(calls.find((call) => call.method === "approve")?.args, [
      taskId,
      "req-1",
      "deny",
      { q1: ["no"] },
    ]);

    const interrupted = await executeCommand({
      id: "interrupt-dsh",
      kind: "interrupt",
      interrupt: { taskId },
    });
    assert.equal(interrupted.ok, true, interrupted.error);
    assert.deepEqual(calls.find((call) => call.method === "interrupt")?.args, [taskId]);

    const fetched = await executeCommand({
      id: "fetch-dsh",
      kind: "fetchMessages",
      fetchMessages: { taskId, limit: 20 },
    });
    assert.equal(fetched.ok, true, fetched.error);
    assert.deepEqual(reads, [`${taskId}:20`]);
    const stored = busStore.messagesFor(taskId);
    assert.ok(stored, "messages were not emitted");
    assert.equal(stored.agentId, agentId);
    assert.equal(stored.hasMore, true);
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.messages[0].text, "hello");

    const deleted = await executeCommand({
      id: "delete-dsh",
      kind: "deleteTask",
      deleteTask: { taskId },
    });
    assert.equal(deleted.ok, true, deleted.error);
    assert.deepEqual(calls.find((call) => call.method === "deleteTask")?.args, [taskId]);
  });

  test("a connector without deleteTask reports not supported", async () => {
    reset();
    const calls: Call[] = [];
    setDshFactories({ connector: () => fakeConnector(calls, { started: 0, stopped: 0 }) });
    useAgents([dshSpec()]);
    const deleted = await executeCommand({
      id: "delete-dsh",
      kind: "deleteTask",
      deleteTask: { taskId: "dsh:native-1" },
    });
    assert.equal(deleted.ok, false);
    assert.equal(deleted.error, "not supported");
  });

  test("an unresolvable attachment fails explicitly instead of being dropped", async () => {
    reset();
    const calls: Call[] = [];
    setDshFactories({ connector: () => fakeConnector(calls, { started: 0, stopped: 0 }) });
    useAgents([dshSpec()]);
    const started = await executeCommand({
      id: "start-dsh-image",
      kind: "startTask",
      startTask: {
        source: "dsh",
        projectPath: "C:/work/demo",
        prompt: "see this",
        // 旧协议形状：没有 artifactId，本机缓存里也没有对应的图。
        attachments: [{ type: "image", mimeType: "image/png", base64: "AAAA", name: "a.png" }],
      },
    });
    assert.equal(started.ok, false);
    assert.match(started.error ?? "", /^图片已过期或不存在：/);
    assert.equal(calls.some((call) => call.method === "start"), false);
  });

  test("refreshAgents creates and starts the instance; resetRuntime stops it", async () => {
    reset();
    const lifecycle = { started: 0, stopped: 0 };
    setDshFactories({
      connector: () => fakeConnector([], lifecycle),
      reader: () => fakeReader([]),
    });
    // 注入发现结果：不要真的探测本机、更不要把已安装的 ACP agent 拉起来做模型探测。
    await refreshAgents(async () => ({ agents: [dshSpec()] }));
    assert.equal(lifecycle.started, 1, "refreshAgents should start observation");
    resetRuntime();
    assert.equal(lifecycle.stopped, 1, "resetRuntime should stop the instance");
  });

  test("disabling dsh rejects commands; enabling is lazy and restart rebuilds", async () => {
    reset();
    const lifecycle = { started: 0, stopped: 0 };
    let built = 0;
    setDshFactories({
      connector: () => {
        built += 1;
        return fakeConnector([], lifecycle);
      },
      reader: () => fakeReader([]),
    });
    useAgents([dshSpec()]);
    assert.equal(built, 1);
    assert.equal(lifecycle.started, 1);

    const disabled = await executeCommand({
      id: "disable-dsh",
      kind: "setConnectorEnabled",
      setConnectorEnabled: { connector: "dsh", enabled: false },
    });
    assert.equal(disabled.ok, true, disabled.error);
    assert.equal(lifecycle.stopped, 1);

    const followDisabled = await executeCommand({
      id: "follow-disabled-dsh",
      kind: "followUp",
      followUp: { taskId: "dsh:native-1", prompt: "again" },
    });
    assert.equal(followDisabled.ok, false);
    assert.match(followDisabled.error ?? "", /disabled/);

    const enabled = await executeCommand({
      id: "enable-dsh",
      kind: "setConnectorEnabled",
      setConnectorEnabled: { connector: "dsh", enabled: true },
    });
    assert.equal(enabled.ok, true, enabled.error);
    assert.equal(built, 1, "enabling itself must not rebuild eagerly");

    const followed = await executeCommand({
      id: "follow-enabled-dsh",
      kind: "followUp",
      followUp: { taskId: "dsh:native-1", prompt: "again" },
    });
    assert.equal(followed.ok, true, followed.error);
    assert.equal(built, 2);

    const restarted = await executeCommand({
      id: "restart-dsh",
      kind: "restartConnector",
      restartConnector: { connector: "dsh" },
    });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(lifecycle.stopped, 2);
    assert.equal(built, 3);
  });

  test("runtime no longer depends on the legacy dsh web subset", () => {
    const source = readFileSync(
      new URL("../../src/connectors/runtime.ts", import.meta.url),
      "utf8",
    );
    for (const name of [
      "fetchDshWebMessages",
      "followUpDshWeb",
      "interruptDshWeb",
      "refreshDshWebTasks",
    ]) {
      assert.equal(source.includes(name), false, `${name} is still referenced`);
    }
    assert.equal(source.includes("./dsh/runtime.js"), false, "legacy dsh runtime is still imported");
  });
});
