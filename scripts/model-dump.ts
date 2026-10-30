import { discoverAgents } from "../src/connectors/discover.js";
import { AcpProcess } from "../src/connectors/runtime.js";

const id = process.argv[2];
if (!id) {
  console.log("usage: tsx scripts/model-dump.ts <agentId>");
  process.exit(1);
}

const found = await discoverAgents();
const spec = found.agents.find((agent) => agent.id === id);
if (!spec?.executable) {
  console.log(`${id}: unavailable`);
  process.exit(1);
}

const proc = new AcpProcess(spec.executable, spec.args, spec.env, () => {}, () => {}, 60_000);
try {
  await proc.start();
  const created = (await proc.call("session/new", { cwd: process.cwd(), mcpServers: [] }, 60_000)) as any;
  console.log("current:", created.models?.currentModelId);
  console.log(
    (created.models?.availableModels ?? [])
      .map((model: any) => `${model.modelId} = ${model.name}`)
      .join("\n"),
  );
} finally {
  proc.kill();
}
process.exit(0);
