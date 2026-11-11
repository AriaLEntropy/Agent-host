/**
 * 无外部依赖的端到端冒烟：
 * 本地 Relay + 电脑端 + 假 ACP Agent，覆盖配对隧道、快照、新建、续聊、审批。
 *
 * 不连真实模型、不读真实 ~/.dsh / ~/.claude、不需要手机或模拟器。
 * CI 用它做稳定门禁；真机 / 模拟器清单另做，避免把模拟器冷启动的抖动带进来。
 */
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetRuntime, useAgents } from "../src/connectors/runtime.js";
import {
  createChecks,
  createHarness,
  jsonBody,
  sleep,
  type SealedTunnel,
} from "./lib/sealed-harness.js";

const fakeAcp = fileURLToPath(new URL("../test/fixtures/fake-acp.mjs", import.meta.url));

async function send(tunnel: SealedTunnel, command: Record<string, unknown>) {
  return tunnel.request("POST", "/bus/commands", Buffer.from(JSON.stringify(command)));
}

async function snapshot(tunnel: SealedTunnel) {
  return jsonBody(await tunnel.request("GET", "/bus/snapshot"));
}

async function waitForResult(tunnel: SealedTunnel, commandId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await snapshot(tunnel);
    const result = body.recentResults?.find(
      (item: Record<string, unknown>) => item.commandId === commandId,
    );
    if (result) return result;
    await sleep(100);
  }
  return undefined;
}

async function waitForTask(
  tunnel: SealedTunnel,
  taskId: string,
  predicate: (task: Record<string, any>) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await snapshot(tunnel);
    const task = body.tasks?.find((item: Record<string, unknown>) => item.id === taskId);
    if (task && predicate(task)) return task;
    await sleep(100);
  }
  return undefined;
}

async function main() {
  const harness = await createHarness({ hostName: "E2E" });
  const { check, finish } = createChecks();
  const cwd = await mkdtemp(join(tmpdir(), "agent-host-e2e-"));

  try {
    useAgents(
      [
        {
          id: "fake",
          kind: "acp",
          name: "Fake ACP",
          executable: process.execPath,
          args: [fakeAcp],
          env: {},
          origin: "manifest",
          available: true,
          enabled: true,
        },
      ],
      true,
    );

    const describe = await harness.tunnel.request("GET", "/bus/describe");
    const describeBody = jsonBody(describe);
    check(
      "GET /bus/describe",
      describe.status === 200 && describeBody.hostKind === "agent-host",
      `status=${describe.status} hostKind=${String(describeBody.hostKind)}`,
    );

    const startId = `e2e-start-${Date.now()}`;
    await send(harness.tunnel, {
      id: startId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "fake",
        projectPath: cwd,
        prompt: "ECHO:ok",
      },
    });
    const startResult = await waitForResult(harness.tunnel, startId, 30_000);
    const taskId = String(startResult?.taskId ?? "");
    check("startTask ok", startResult?.ok === true, `ok=${String(startResult?.ok)}`);
    check("startTask returned taskId", Boolean(taskId), `taskId=${taskId}`);
    const completed = await waitForTask(
      harness.tunnel,
      taskId,
      (task) => task.status === "completed",
      30_000,
    );
    check("startTask completed", completed?.status === "completed", `status=${String(completed?.status)}`);

    const followId = `e2e-follow-${Date.now()}`;
    await send(harness.tunnel, {
      id: followId,
      kind: "followUp",
      followUp: { taskId, prompt: "ECHO:follow" },
    });
    const followResult = await waitForResult(harness.tunnel, followId, 30_000);
    check("followUp ok", followResult?.ok === true, `ok=${String(followResult?.ok)}`);

    const approvalStartId = `e2e-approval-start-${Date.now()}`;
    await send(harness.tunnel, {
      id: approvalStartId,
      kind: "startTask",
      startTask: {
        source: "acp",
        connectorId: "fake",
        projectPath: cwd,
        prompt: "NEED_PERMISSION",
      },
    });
    const approvalStart = await waitForResult(harness.tunnel, approvalStartId, 30_000);
    const approvalTaskId = String(approvalStart?.taskId ?? "");
    check("approval task started", approvalStart?.ok === true && Boolean(approvalTaskId), `taskId=${approvalTaskId}`);
    const waiting = await waitForTask(
      harness.tunnel,
      approvalTaskId,
      (task) => task.status === "waitingApproval",
      30_000,
    );
    check("task waits for approval", waiting?.status === "waitingApproval", `status=${String(waiting?.status)}`);
    const requestId = String(waiting?.pendingRequest?.id ?? "");
    check("pendingRequest has an id", Boolean(requestId), `id=${requestId}`);

    if (requestId) {
      const approveId = `e2e-approve-${Date.now()}`;
      await send(harness.tunnel, {
        id: approveId,
        kind: "approve",
        approve: { taskId: approvalTaskId, requestId, decision: "allow" },
      });
      const approveResult = await waitForResult(harness.tunnel, approveId, 30_000);
      check("approve ok", approveResult?.ok === true, `ok=${String(approveResult?.ok)}`);
      const resumed = await waitForTask(
        harness.tunnel,
        approvalTaskId,
        (task) => task.status === "running" || task.status === "completed",
        30_000,
      );
      check(
        "approval resumes the task",
        resumed?.status === "running" || resumed?.status === "completed",
        `status=${String(resumed?.status)}`,
      );
    }

    process.exitCode = finish();
  } finally {
    resetRuntime();
    await sleep(100);
    await harness.close();
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
