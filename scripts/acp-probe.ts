import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/connectors/discover.js";
import {
  AcpAuthRequired,
  AcpProcess,
  AcpRejected,
  AcpTimeout,
} from "../src/connectors/runtime.js";

function argValue(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const agentId = argValue("--agent");
if (!agentId) {
  console.error("用法：npm run probe:acp -- --agent <id> [--prompt <text>]");
  process.exit(64);
}
const prompt = argValue("--prompt", "Reply with exactly: OK")!;

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

console.log(`agent: ${spec.id} (${spec.name}) origin=${spec.origin}`);
console.log(`command: ${spec.executable} ${spec.args.join(" ")}`.trim());

const updates: string[] = [];
let exited = "";
const cwd = await mkdtemp(join(tmpdir(), "acp-probe-"));
const proc = new AcpProcess(
  spec.executable,
  spec.args,
  spec.env,
  (message) => {
    if (message.method === "session/update") {
      const params = message.params as Record<string, unknown> | undefined;
      const update = (params?.update ?? {}) as Record<string, unknown>;
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = (update.content ?? {}) as Record<string, unknown>;
        if (typeof content.text === "string") updates.push(content.text);
      }
      return;
    }
    if (message.method === "session/request_permission" && typeof message.id === "number") {
      console.log("permission: auto-cancelled");
      proc.respond(message.id, { outcome: { outcome: "cancelled" } });
    }
  },
  () => {
    exited = "agent exited";
  },
  60_000,
);

try {
  await proc.start();
  console.log("initialize: ok (protocolVersion=1)");
  console.log(
    `capabilities: loadSession=${proc.capabilities.loadSession} resume=${proc.capabilities.resume} image=${proc.capabilities.image}`,
  );

  const created = (await proc.call("session/new", { cwd, mcpServers: [] }, 60_000)) as Record<
    string,
    unknown
  >;
  const sessionId = typeof created.sessionId === "string" ? created.sessionId : "";
  if (!sessionId) throw new Error("session/new did not return a session id");
  console.log(`session/new: ok (${sessionId})`);

  const result = (await proc.call(
    "session/prompt",
    { sessionId, prompt: [{ type: "text", text: prompt }] },
    180_000,
  )) as Record<string, unknown>;
  const stopReason = String(result.stopReason ?? "unknown");
  console.log(`session/prompt: stopReason=${stopReason}`);
  console.log(`agent text: ${updates.join("").trim().slice(0, 400) || "(empty)"}`);
  process.exitCode = stopReason === "end_turn" ? 0 : 1;
} catch (error) {
  if (error instanceof AcpAuthRequired) {
    console.error(`AUTH_REQUIRED: ${error.message}`);
    process.exitCode = 3;
  } else if (error instanceof AcpTimeout) {
    console.error(`TIMEOUT: ${error.message}`);
    process.exitCode = 1;
  } else if (error instanceof AcpRejected) {
    console.error(`REJECTED: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  proc.kill();
  try {
    await rm(cwd, { recursive: true, force: true });
  } catch {
    // Windows may keep the agent's cwd locked for a moment after kill.
    console.error(`cleanup skipped: ${cwd}`);
  }
  if (exited) console.error(exited);
}
