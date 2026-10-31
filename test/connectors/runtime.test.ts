import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Snapshot } from "../contract/protocol.js";
import { waitForCommands } from "../../src/bus/commands.js";
import { routeBus } from "../../src/bus/router.js";
import { busStore } from "../../src/bus/store.js";
import {
  resetRuntime,
  setIdleMs,
  setDshFactories,
  useAgents,
  type DshConnectorInstance,
} from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const fake = process.execPath;

/**
 * 这一组用例只测 ACP 路径与 dsh 的路由形状。dsh 的真实连接器会去扫 `~/.dsh`、
 * 找本机 web，测试里一律换成假实例：`start` 直接写一条完成的 `dsh:sess-1`。
 */
function fakeDsh(): DshConnectorInstance {
  return {
    kind: "dsh",
    runsUnderBotBus: true,
    startObserving() {},
    async stop() {},
    async start(projectPath, prompt, images, selection) {
      void prompt;
      void images;
      void selection;
      const now = new Date().toISOString();
      busStore.upsertTask({
        id: "dsh:sess-1",
        agentId,
        source: "dsh",
        title: "demo",
        projectPath,
        projectName: "demo",
        status: "completed",
        origin: "watch",
        controllable: true,
        startedAt: now,
        updatedAt: now,
      });
      return { taskId: "dsh:sess-1", retainsLiveOwnership: false };
    },
    async followUp() {
      return { taskId: "dsh:sess-1", retainsLiveOwnership: false };
    },
    async approve() {
      return { taskId: "dsh:sess-1", retainsLiveOwnership: false };
    },
    async interrupt() {
      return { taskId: "dsh:sess-1", retainsLiveOwnership: false };
    },
  };
}

function agentArgs() {
  const script = new URL("../fixtures/fake-acp.mjs", import.meta.url);
  return [script.pathname.replace(/^\/([A-Za-z]:)/, "$1")];
}

function reset() {
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
  // 不启动真实 dsh，也不让它扫 ~/.dsh。
  setDshFactories({ connector: () => fakeDsh() });
}

async function post(body: Record<string, unknown>) {
  const response = await routeBus({
    method: "POST",
    path: "/bus/commands",
    agentId,
    body: Buffer.from(JSON.stringify(body)),
  });
  await waitForCommands();
  return response;
}

async function until(read: () => boolean) {
  const started = Date.now();
  while (!read()) {
    if (Date.now() - started > 5000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 只装一个假 ACP agent；`env` 用来给 fake-acp.mjs 开关行为。 */
function useFakeAgent(env: Record<string, string> = {}) {
  useAgents([
    {
      id: "my-agent",
      kind: "acp",
      name: "My Agent",
      executable: fake,
      args: agentArgs(),
      env,
      origin: "manifest",
      available: true,
      enabled: true,
    },
  ]);
}

function startCommand(id: string, prompt: string) {
  return {
    id,
    createdAt: "2026-10-16T00:00:00Z",
    agentId,
    kind: "startTask",
    startTask: {
      source: "acp",
      connectorId: "my-agent",
      projectPath: "C:/work/demo",
      prompt,
    },
  };
}

describe("acp runtime", { concurrency: false }, () => {
  test("startTask, approval, and fetchMessages go through a fake ACP process", async () => {
    reset();
    const executable = fake;
    useAgents([
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable,
        args: agentArgs(),
        env: {},
        origin: "manifest",
        available: true,
        enabled: true,
      },
      {
        id: "dsh",
        kind: "dsh",
        name: "DeepSeek Harness",
        args: ["--profile", "acp"],
        env: {},
        origin: "dsh",
        available: false,
        enabled: true,
        lastError: "dsh is not installed",
      },
    ]);
    const started = await post({
      id: "cmd-start",
      createdAt: "2026-10-16T00:00:00Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: "C:/work/demo",
        prompt: "NEED_PERMISSION",
      },
    });
    assert.equal(started.status, 202);
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "waitingApproval");
    const approved = await post({
      id: "cmd-approve",
      createdAt: "2026-10-16T00:00:01Z",
      agentId,
      kind: "approve",
      approve: { taskId: "acp:my-agent:sess-1", requestId: "call_01", decision: "allow" },
    });
    assert.equal(approved.status, 202);
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "completed");
    const again = await post({
      id: "cmd-start",
      createdAt: "2026-10-16T00:00:02Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: "C:/work/demo",
        prompt: "再次",
      },
    });
    assert.equal(again.status, 202);
    assert.equal(busStore.taskById("acp:my-agent:sess-1")?.status, "completed");
    const fetched = await post({
      id: "cmd-fetch",
      createdAt: "2026-10-16T00:00:03Z",
      agentId,
      kind: "fetchMessages",
      fetchMessages: { taskId: "acp:my-agent:sess-1" },
    });
    assert.equal(fetched.status, 202);
    const snapshot = busStore.snapshot();
    assert.equal(Snapshot.safeParse(snapshot).success, true);
    const connectors = (snapshot.agents as Array<{ connectors: Array<{ kind: string; available: boolean }> }>)[0]
      .connectors;
    assert.equal(connectors.some((item) => item.kind === "dsh" && item.available === false), true);
    resetRuntime();
  });

  test("the same command id does not start a second session", async () => {
    reset();
    useAgents([
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable: fake,
        args: agentArgs(),
        env: {},
        origin: "manifest",
        available: true,
        enabled: true,
      },
    ]);
    const body = {
      id: "cmd-once",
      createdAt: "2026-10-16T00:00:00Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: "C:/work/demo",
        prompt: "hello",
      },
    };
    await post(body);
    await post(body);
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "completed");
    assert.equal(busStore.taskById("acp:my-agent:sess-2"), undefined);
    resetRuntime();
  });

  test("a registry agent that speaks the wrong version is hidden", async () => {
    reset();
    useAgents([
      {
        id: "gemini",
        kind: "acp",
        name: "Gemini CLI",
        executable: fake,
        args: agentArgs(),
        env: { FAKE_ACP_VERSION: "99" },
        origin: "registry",
        available: true,
        enabled: true,
      },
    ]);
    await post({
      id: "cmd-bad",
      createdAt: "2026-10-16T00:00:00Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "gemini",
        projectPath: "C:/work/demo",
        prompt: "hello",
      },
    });
    const connectors = (busStore.snapshot().agents as Array<{ connectors: unknown[] }>)[0].connectors;
    assert.equal(connectors.length, 0);
    resetRuntime();
  });

  test("followUp and interrupt work on the same fake ACP session", async () => {
    reset();
    useAgents([
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable: fake,
        args: agentArgs(),
        env: {},
        origin: "manifest",
        available: true,
        enabled: true,
      },
    ]);
    await post({
      id: "cmd-follow-start",
      createdAt: "2026-10-16T00:00:00Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: "C:/work/demo",
        prompt: "hello",
      },
    });
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "completed");
    const follow = await post({
      id: "cmd-follow",
      createdAt: "2026-10-16T00:00:01Z",
      agentId,
      kind: "followUp",
      followUp: { taskId: "acp:my-agent:sess-1", prompt: "ECHO:follow-up" },
    });
    assert.equal(follow.status, 202);
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.lastMessage === "follow-up");

    const started = await post({
      id: "cmd-interrupt-start",
      createdAt: "2026-10-16T00:00:02Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: "C:/work/demo",
        prompt: "NEED_PERMISSION",
      },
    });
    assert.equal(started.status, 202);
    await until(() => busStore.taskById("acp:my-agent:sess-2")?.status === "waitingApproval");
    const interrupted = await post({
      id: "cmd-interrupt",
      createdAt: "2026-10-16T00:00:03Z",
      agentId,
      kind: "interrupt",
      interrupt: { taskId: "acp:my-agent:sess-2" },
    });
    assert.equal(interrupted.status, 202);
    await until(() => busStore.taskById("acp:my-agent:sess-2")?.status === "interrupted");
    resetRuntime();
  });

  test("an agent crash marks the task failed with the stderr tail", async () => {
    reset();
    useAgents([
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable: fake,
        args: agentArgs(),
        env: {},
        origin: "manifest",
        available: true,
        enabled: true,
      },
    ]);
    await post({
      id: "cmd-crash",
      createdAt: "2026-10-16T00:00:00Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: "C:/work/demo",
        prompt: "CRASH",
      },
    });
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "failed");
    const task = busStore.taskById("acp:my-agent:sess-1");
    assert.equal(task?.status, "failed");
    assert.match(task?.lastMessage ?? "", /fake crash/);
    resetRuntime();
  });

  test("a dsh task uses dsh:<sessionId> and no connectorId", async () => {
    reset();
    useAgents([
      {
        id: "dsh",
        kind: "dsh",
        name: "DeepSeek Harness",
        executable: fake,
        args: agentArgs(),
        env: {},
        origin: "dsh",
        available: true,
        enabled: true,
      },
    ]);
    const started = await post({
      id: "cmd-dsh",
      createdAt: "2026-10-16T00:00:00Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "dsh",
        projectPath: "C:/work/demo",
        prompt: "hello",
      },
    });
    assert.equal(started.status, 202);
    await until(() => busStore.taskById("dsh:sess-1")?.status === "completed");
    const task = busStore.taskById("dsh:sess-1");
    assert.equal(task?.source, "dsh");
    assert.equal(task?.connectorId, undefined);
    resetRuntime();
  });

  test("a turn waiting for approval is not closed while idle", async () => {
    reset();
    setIdleMs(1000);
    useAgents([
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable: fake,
        args: agentArgs(),
        env: {},
        origin: "manifest",
        available: true,
        enabled: true,
      },
    ]);
    await post({
      id: "cmd-idle-approval",
      createdAt: "2026-10-16T00:00:00Z",
      agentId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "my-agent",
        projectPath: "C:/work/demo",
        prompt: "NEED_PERMISSION",
      },
    });
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "waitingApproval");
    // 审批可能等上很久：空闲关闭不能把正在等用户的一轮杀掉。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(busStore.taskById("acp:my-agent:sess-1")?.status, "waitingApproval");
    const approved = await post({
      id: "cmd-idle-approve",
      createdAt: "2026-10-16T00:00:01Z",
      agentId,
      kind: "approve",
      approve: { taskId: "acp:my-agent:sess-1", requestId: "call_01", decision: "allow" },
    });
    assert.equal(approved.status, 202);
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "completed");
    resetRuntime();
  });

  test("an idle process is closed after a turn finishes", async () => {
    reset();
    const directory = await mkdtemp(join(tmpdir(), "agent-host-acp-idle-"));
    const callsPath = join(directory, "init.txt");
    try {
      setIdleMs(1000);
      useAgents([
        {
          id: "my-agent",
          kind: "acp",
          name: "My Agent",
          executable: fake,
          args: agentArgs(),
          env: { FAKE_ACP_INIT_CALLS: callsPath },
          origin: "manifest",
          available: true,
          enabled: true,
        },
      ]);
      await post({
        id: "cmd-idle-first",
        createdAt: "2026-10-16T00:00:00Z",
        agentId,
        kind: "startTask",
        startTask: {
          source: "acp",
          connectorId: "my-agent",
          projectPath: "C:/work/demo",
          prompt: "hello",
        },
      });
      await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "completed");
      await until(() => existsSync(callsPath) && readFileSync(callsPath, "utf8") === "x");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await post({
        id: "cmd-idle-second",
        createdAt: "2026-10-16T00:00:01Z",
        agentId,
        kind: "startTask",
        startTask: {
          source: "acp",
          connectorId: "my-agent",
          projectPath: "C:/work/demo",
          prompt: "ECHO:second",
        },
      });
      // 新进程的 session 计数从 1 重新开始，所以还是 sess-1；若是同一个进程，会拿到 sess-2。
      await until(() => busStore.taskById("acp:my-agent:sess-1")?.lastMessage === "second");
      assert.equal(busStore.taskById("acp:my-agent:sess-2"), undefined);
      assert.equal(readFileSync(callsPath, "utf8"), "xx");
    } finally {
      resetRuntime();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a permission scope answer picks the always option", async () => {
    reset();
    useFakeAgent();
    await post(startCommand("cmd-scope", "NEED_SCOPE"));
    const taskId = "acp:my-agent:sess-1";
    await until(() => busStore.taskById(taskId)?.status === "waitingApproval");
    const pending = busStore.taskById(taskId)?.pendingRequest;
    assert.equal(pending?.id, "call_scope");
    assert.equal(pending?.questions?.[0]?.id, "scope");
    assert.deepEqual(pending?.questions?.[0]?.options.map((option) => option.label), ["仅此一次", "始终允许"]);
    const approved = await post({
      id: "cmd-scope-approve",
      createdAt: "2026-10-16T00:00:01Z",
      agentId,
      kind: "approve",
      approve: {
        taskId,
        requestId: "call_scope",
        decision: "allow",
        answers: { scope: ["始终允许"] },
      },
    });
    assert.equal(approved.status, 202);
    await until(() => busStore.taskById(taskId)?.status === "completed");
    assert.equal(busStore.taskById(taskId)?.lastMessage, "approved:allow-always");
    assert.equal(busStore.taskById(taskId)?.pendingRequest, undefined);
    resetRuntime();
  });

  test("the agent echoing the prompt does not duplicate the user message", async () => {
    reset();
    useFakeAgent();
    await post(startCommand("cmd-echo-self", "ECHO_SELF:hi"));
    const taskId = "acp:my-agent:sess-1";
    await until(() => busStore.taskById(taskId)?.status === "completed");
    const messages = busStore.messagesFor(taskId)?.messages ?? [];
    const user = messages.filter((message) => message.role === "user");
    assert.equal(user.length, 1);
    assert.equal(user[0]?.text, "ECHO_SELF:hi");
    assert.equal(messages.some((message) => message.role === "agent" && message.text === "已完成"), true);
    resetRuntime();
  });

  test("a tool call update keeps a single transcript row", async () => {
    reset();
    useFakeAgent();
    await post(startCommand("cmd-tool", "TOOL_UPDATE"));
    const taskId = "acp:my-agent:sess-1";
    await until(() => busStore.taskById(taskId)?.status === "completed");
    const tools = (busStore.messagesFor(taskId)?.messages ?? []).filter((message) => message.role === "tool");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.id, "tool-call_tool");
    assert.equal(tools[0]?.text, "npm test");
    resetRuntime();
  });

  test("max_tokens ends the turn as failed with the partial reply", async () => {
    reset();
    useFakeAgent();
    await post(startCommand("cmd-max-tokens", "MAX_TOKENS"));
    const taskId = "acp:my-agent:sess-1";
    await until(() => busStore.taskById(taskId)?.status === "failed");
    assert.equal(busStore.taskById(taskId)?.lastMessage, "partial");
    assert.equal(busStore.taskById(taskId)?.pendingRequest, undefined);
    resetRuntime();
  });

  test("an approve with a stale request id is ignored", async () => {
    reset();
    useFakeAgent();
    await post(startCommand("cmd-stale-approve", "NEED_PERMISSION"));
    const taskId = "acp:my-agent:sess-1";
    await until(() => busStore.taskById(taskId)?.status === "waitingApproval");
    const stale = await post({
      id: "cmd-stale",
      createdAt: "2026-10-16T00:00:01Z",
      agentId,
      kind: "approve",
      approve: { taskId, requestId: "call_other", decision: "allow" },
    });
    assert.equal(stale.status, 202);
    assert.equal(busStore.taskById(taskId)?.status, "waitingApproval");
    assert.equal(busStore.taskById(taskId)?.pendingRequest?.id, "call_01");
    await post({
      id: "cmd-fresh",
      createdAt: "2026-10-16T00:00:02Z",
      agentId,
      kind: "approve",
      approve: { taskId, requestId: "call_01", decision: "allow" },
    });
    await until(() => busStore.taskById(taskId)?.status === "completed");
    resetRuntime();
  });

  test("a follow-up while a turn is running is rejected", async () => {
    reset();
    useFakeAgent();
    await post(startCommand("cmd-busy", "NEED_PERMISSION"));
    const taskId = "acp:my-agent:sess-1";
    await until(() => busStore.taskById(taskId)?.status === "waitingApproval");
    const follow = await post({
      id: "cmd-busy-follow",
      createdAt: "2026-10-16T00:00:01Z",
      agentId,
      kind: "followUp",
      followUp: { taskId, prompt: "ECHO:second" },
    });
    assert.equal(follow.status, 202);
    assert.equal(busStore.taskById(taskId)?.status, "waitingApproval");
    await post({
      id: "cmd-busy-approve",
      createdAt: "2026-10-16T00:00:02Z",
      agentId,
      kind: "approve",
      approve: { taskId, requestId: "call_01", decision: "allow" },
    });
    await until(() => busStore.taskById(taskId)?.status === "completed");
    const user = (busStore.messagesFor(taskId)?.messages ?? []).filter((message) => message.role === "user");
    assert.equal(user.length, 1);
    assert.equal(user[0]?.text, "NEED_PERMISSION");
    resetRuntime();
  });
});
