/**
 * 真实 Agent 冒烟：只跑本机已发现的 codex / claude，走完整的
 * startTask → followUp → fetchMessages 链路。
 *
 * 用法：
 *   npx tsx scripts/real-agent-smoke.ts
 *   npx tsx scripts/real-agent-smoke.ts --kind codex
 *
 * 注意：会真的启动 codex app-server / claude -p，并产生少量模型调用；
 * 每个任务都在系统临时目录里跑，结束后删除。不会写用户项目。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busStore } from "../src/bus/store.js";
import {
  executeCommand,
  refreshAgents,
  resetRuntime,
  setAcpReconcileInterval,
} from "../src/connectors/runtime.js";

const argKind = (() => {
  const index = process.argv.indexOf("--kind");
  return index >= 0 ? process.argv[index + 1] : undefined;
})();

const TASK_TIMEOUT_MS = 180_000;
const agentId = `smoke-${Date.now()}`;

busStore.identify({ agentId, hostName: "agent-host-smoke", platform: "windows" });
// 对账计时器不需要参与冒烟，避免它拉起其他 ACP agent。
setAcpReconcileInterval(0);

type Task = NonNullable<ReturnType<typeof busStore.taskById>>;

async function waitForTask(
  taskId: string,
  predicate: (task: Task) => boolean,
  timeoutMs = TASK_TIMEOUT_MS,
): Promise<Task | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = busStore.taskById(taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return busStore.taskById(taskId);
}

function terminal(status: string) {
  return ["completed", "failed", "interrupted", "idle"].includes(status);
}

async function runKind(kind: "codex" | "claude"): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), `agent-host-smoke-${kind}-`));
  const command = (id: string, payload: Record<string, unknown>) => ({
    id,
    createdAt: new Date().toISOString(),
    agentId,
    ...payload,
  });
  console.log(`\n[${kind}] project=${project}`);
  try {
    const start = await executeCommand(
      command(`${kind}-start-${Date.now()}`, {
        kind: "startTask",
        startTask: {
          source: kind,
          projectPath: project,
          prompt: "Reply with exactly OK and nothing else.",
        },
      }),
    );
    console.log(`[${kind}] start ->`, start);
    if (!start.ok || !start.taskId) return;

    const afterStart = await waitForTask(start.taskId, (task) => terminal(task.status));
    console.log(
      `[${kind}] start finished: status=${afterStart?.status} lastMessage=${afterStart?.lastMessage?.slice(0, 120) ?? ""}`,
    );
    if (afterStart?.status !== "completed") return;

    const follow = await executeCommand(
      command(`${kind}-follow-${Date.now()}`, {
        kind: "followUp",
        followUp: { taskId: start.taskId, prompt: "Reply with exactly DONE and nothing else." },
      }),
    );
    console.log(`[${kind}] followUp ->`, follow);
    if (!follow.ok) return;

    const afterFollow = await waitForTask(
      start.taskId,
      // followUp 返回时状态可能还是上一轮的 completed；等这一轮真正结束。
      (task) =>
        task.lastMessage === "DONE" ||
        task.status === "failed" ||
        task.status === "interrupted",
    );
    console.log(
      `[${kind}] followUp finished: status=${afterFollow?.status} lastMessage=${afterFollow?.lastMessage?.slice(0, 120) ?? ""}`,
    );

    const messages = await executeCommand(
      command(`${kind}-messages-${Date.now()}`, {
        kind: "fetchMessages",
        fetchMessages: { taskId: start.taskId, limit: 20 },
      }),
    );
    console.log(`[${kind}] fetchMessages ->`, messages);
    const stored = busStore.messagesFor(start.taskId);
    console.log(
      `[${kind}] messages: ${stored?.messages.length ?? 0} (hasMore=${stored?.hasMore ?? false})`,
    );
    for (const message of stored?.messages.slice(-4) ?? []) {
      console.log(`  ${message.role}: ${message.text.slice(0, 120)}`);
    }
  } catch (error) {
    console.error(`[${kind}] smoke failed:`, error instanceof Error ? error.message : error);
  } finally {
    // Windows 上 app-server 可能还短暂持有 cwd，删不掉不影响冒烟结论。
    await rm(project, { recursive: true, force: true }).catch(() => undefined);
  }
}

try {
  const found = await refreshAgents();
  console.log(
    "discovered:",
    found.agents
      .filter((agent) => agent.kind === "codex" || agent.kind === "claude")
      .map(
        (agent) =>
          `${agent.kind}:${agent.id}:available=${agent.available}:enabled=${agent.enabled}:${agent.executable ?? "-"}`,
      ),
  );
  const kinds = argKind
    ? [argKind as "codex" | "claude"]
    : (["codex", "claude"] as const);
  for (const kind of kinds) {
    const spec = found.agents.find(
      (agent) => agent.kind === kind && agent.available && agent.enabled,
    );
    if (!spec) {
      console.log(`[${kind}] skip: not available/enabled`);
      continue;
    }
    await runKind(kind);
  }
} finally {
  resetRuntime();
  console.log("\ndone.");
  process.exit(0);
}
