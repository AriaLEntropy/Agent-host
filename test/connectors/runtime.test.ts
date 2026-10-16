import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Snapshot } from "../../../botbus-protocol/src/protocol.ts";
import { waitForCommands } from "../../src/bus/commands.js";
import { routeBus } from "../../src/bus/router.js";
import { busStore } from "../../src/bus/store.js";
import { resetRuntime, setIdleMs, useAgents } from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const fake = process.execPath;

function agentArgs() {
  const script = new URL("../fixtures/fake-acp.mjs", import.meta.url);
  return [script.pathname.replace(/^\/([A-Za-z]:)/, "$1")];
}

function reset() {
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
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

  test("an idle process is closed", async () => {
    reset();
    setIdleMs(400);
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
      id: "cmd-idle",
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
    await until(() => busStore.taskById("acp:my-agent:sess-1")?.status === "failed");
    resetRuntime();
  });
});
