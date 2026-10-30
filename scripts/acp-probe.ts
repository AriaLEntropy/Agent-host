import { discoverAgents } from "../src/connectors/discover.js";
import {
  DEFAULT_CHECK_PROMPT,
  ProbeError,
  probeAcpAgent,
  probeErrorLabel,
  probeExitCode,
} from "../src/connectors/probe.js";

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
const prompt = argValue("--prompt", DEFAULT_CHECK_PROMPT)!;

const found = await discoverAgents();
const spec = found.agents.find((agent) => agent.id === agentId);
if (!spec) {
  console.error(`找不到 agent：${agentId}（可用 npm run list:agents 查看）`);
  process.exit(2);
}
if (!spec.available || !spec.executable) {
  console.error(`agent ${agentId} 不可用：${spec.lastError ?? "找不到可执行文件"}`);
  process.exit(2);
}

console.log(`agent: ${spec.id} (${spec.name}) origin=${spec.origin}`);
console.log(`command: ${spec.executable} ${spec.args.join(" ")}`.trim());

try {
  const result = await probeAcpAgent(spec, prompt);
  console.log("initialize: ok (protocolVersion=1)");
  console.log(
    `capabilities: loadSession=${result.capabilities.loadSession} resume=${result.capabilities.resume} image=${result.capabilities.image} session/list=${result.capabilities.listSessions}`,
  );
  console.log(`session/new: ok (${result.sessionId})`);
  console.log(`session/prompt: stopReason=${result.stopReason ?? "unknown"}`);
  for (const tool of result.toolCalls) console.log(`tool: ${tool.title || "(未命名)"}`);
  console.log(`agent text: ${result.agentText.slice(0, 400) || "(empty)"}`);
  process.exitCode = result.stopReason === "end_turn" ? 0 : 1;
} catch (error) {
  if (error instanceof ProbeError) {
    console.error(`${probeErrorLabel(error)}: ${error.message}`);
    process.exitCode = probeExitCode(error);
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
