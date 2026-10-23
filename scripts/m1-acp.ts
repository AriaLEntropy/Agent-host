import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/connectors/discover.js";
import { resetRuntime, useAgents } from "../src/connectors/runtime.js";
import {
  createChecks,
  createHarness,
  jsonBody,
  sleep,
  type BusSocket,
  type SealedTunnel,
} from "./lib/sealed-harness.js";

function argValue(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const agentId = argValue("--agent");
if (!agentId) {
  console.error("用法：npm run smoke:m1-acp -- --agent <id>");
  process.exit(64);
}

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
    await sleep(200);
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
    await sleep(200);
  }
  return undefined;
}

async function waitForEvent(
  socket: BusSocket,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await socket.next(Math.max(1, deadline - Date.now()));
    if (predicate(message)) return message;
  }
  return undefined;
}

async function fetchMessages(tunnel: SealedTunnel, socket: BusSocket, taskId: string) {
  const commandId = `m1-fetch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await send(tunnel, { id: commandId, kind: "fetchMessages", fetchMessages: { taskId } });
  const event = await waitForEvent(
    socket,
    (message) =>
      message.type === "event" &&
      message.event?.kind === "taskMessages" &&
      message.event?.taskMessages?.taskId === taskId,
    15_000,
  );
  return event?.event?.taskMessages?.messages ?? [];
}

async function main() {
  const found = await discoverAgents();
  const spec = found.agents.find((agent) => agent.id === agentId);
  if (!spec) {
    console.error(`找不到 agent：${agentId}（可用 npm run list:agents 查看）`);
    process.exit(2);
  }
  if (!spec.executable) {
    console.error(`agent ${agentId} 不可用：${spec.lastError ?? "找不到可执行文件"}`);
    process.exit(2);
  }

  const cwd = await mkdtemp(join(tmpdir(), "m1-acp-"));
  const harness = await createHarness({ hostName: `ACP ${agentId}` });
  const { check, finish } = createChecks();
  let socket: BusSocket | undefined;

  const startPayload = (prompt: string) => ({
    source: spec.kind === "dsh" ? "dsh" : "acp",
    ...(spec.kind === "dsh" ? {} : { connectorId: spec.id }),
    projectPath: cwd,
    prompt,
  });

  try {
    useAgents([spec], true);
    socket = await harness.tunnel.openSocket("/bus/ws");
    await socket.next(3_000);
    console.log(`agent: ${spec.id} (${spec.name}) kind=${spec.kind}`);

    // 1. startTask
    const startId = `m1-start-${Date.now()}`;
    await send(harness.tunnel, {
      id: startId,
      kind: "startTask",
      startTask: startPayload("Reply with exactly: M1-OK"),
    });
    const startResult = await waitForResult(harness.tunnel, startId, 120_000);
    check("startTask ok", startResult?.ok === true, `ok=${String(startResult?.ok)} error=${String(startResult?.error ?? "-")}`);
    const taskId = String(startResult?.taskId ?? "");
    check("startTask returned taskId", Boolean(taskId), `taskId=${taskId}`);
    const completed = await waitForTask(
      harness.tunnel,
      taskId,
      (task) => task.status === "completed",
      120_000,
    );
    check("startTask completed", completed?.status === "completed", `status=${String(completed?.status)}`);

    const messages = await fetchMessages(harness.tunnel, socket, taskId);
    check(
      "messages include the user prompt",
      messages.some((message: any) => message.role === "user" && String(message.text).includes("M1-OK")),
      `messages=${messages.length}`,
    );
    check(
      "messages include the agent reply",
      messages.some((message: any) => message.role === "agent" && String(message.text).includes("M1-OK")),
      `agent=${messages.find((message: any) => message.role === "agent")?.text ?? "(none)"}`,
    );

    // 2. followUp
    const followId = `m1-follow-${Date.now()}`;
    await send(harness.tunnel, {
      id: followId,
      kind: "followUp",
      followUp: { taskId, prompt: "Reply with exactly: M1-FOLLOW" },
    });
    const followResult = await waitForResult(harness.tunnel, followId, 120_000);
    check("followUp ok", followResult?.ok === true, `ok=${String(followResult?.ok)} error=${String(followResult?.error ?? "-")}`);

    let followMessages: any[] = [];
    const followDeadline = Date.now() + 120_000;
    while (Date.now() < followDeadline) {
      followMessages = await fetchMessages(harness.tunnel, socket, taskId);
      const hasUser = followMessages.some(
        (message) => message.role === "user" && String(message.text).includes("M1-FOLLOW"),
      );
      const hasAgent = followMessages.some(
        (message) => message.role === "agent" && String(message.text).includes("M1-FOLLOW"),
      );
      if (hasUser && hasAgent) break;
      await sleep(1_000);
    }
    check(
      "followUp messages include user and agent turn",
      followMessages.some((message) => message.role === "user" && String(message.text).includes("M1-FOLLOW")) &&
        followMessages.some((message) => message.role === "agent" && String(message.text).includes("M1-FOLLOW")),
      `messages=${followMessages.length}`,
    );

    // 3. interrupt
    const interruptStartId = `m1-interrupt-start-${Date.now()}`;
    await send(harness.tunnel, {
      id: interruptStartId,
      kind: "startTask",
      startTask: startPayload("Write a 500-word story about a robot. Do not stop early."),
    });
    const interruptStart = await waitForResult(harness.tunnel, interruptStartId, 120_000);
    const interruptTaskId = String(interruptStart?.taskId ?? "");
    check("interrupt target started", interruptStart?.ok === true && Boolean(interruptTaskId), `taskId=${interruptTaskId}`);
    await sleep(1_000);
    const interruptId = `m1-interrupt-${Date.now()}`;
    await send(harness.tunnel, {
      id: interruptId,
      kind: "interrupt",
      interrupt: { taskId: interruptTaskId },
    });
    const interruptResult = await waitForResult(harness.tunnel, interruptId, 10_000);
    check("interrupt command ok", interruptResult?.ok === true, `ok=${String(interruptResult?.ok)}`);
    const interrupted = await waitForTask(
      harness.tunnel,
      interruptTaskId,
      (task) => task.status === "interrupted",
      10_000,
    );
    check("task interrupted within 10s", interrupted?.status === "interrupted", `status=${String(interrupted?.status)}`);

    // 4. approval (Claude Code only; skip if the agent never asks)
    if (spec.id === "claude-code") {
      const approvalStartId = `m1-approval-start-${Date.now()}`;
      await send(harness.tunnel, {
        id: approvalStartId,
        kind: "startTask",
        startTask: startPayload(
          "Use the Write tool to create a file named m1-approval.txt in the current working directory with the text: approved. Then report done.",
        ),
      });
      const approvalStart = await waitForResult(harness.tunnel, approvalStartId, 120_000);
      const approvalTaskId = String(approvalStart?.taskId ?? "");
      const waiting = await waitForTask(
        harness.tunnel,
        approvalTaskId,
        (task) => task.status === "waitingApproval",
        90_000,
      );
      if (!waiting) {
        console.log("SKIP  approval (agent did not request permission)");
      } else {
        const requestId = waiting.pendingRequest?.id;
        const approveId = `m1-approve-${Date.now()}`;
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
          60_000,
        );
        check(
          "approval resumes the task",
          resumed?.status === "running" || resumed?.status === "completed",
          `status=${String(resumed?.status)}`,
        );
      }
    } else {
      console.log("SKIP  approval (covered by fake ACP unit tests for this agent)");
    }
  } finally {
    resetRuntime();
    socket?.close();
    await sleep(100);
    await harness.close();
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  finish();
  // Some agents leave detached children or open stdio handles; a smoke script
  // should not hang after its checks have passed.
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
