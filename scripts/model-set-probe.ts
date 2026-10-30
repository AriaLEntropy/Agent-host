import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/connectors/discover.js";
import { AcpProcess } from "../src/connectors/runtime.js";

const [id, modelId] = process.argv.slice(2);
const found = await discoverAgents();
const spec = found.agents.find((agent) => agent.id === id);
if (!spec?.executable) { console.log("unavailable"); process.exit(0); }
const cwd = await mkdtemp(join(tmpdir(), "model-set-"));
const proc = new AcpProcess(spec.executable, spec.args, spec.env, () => {}, () => {}, 60_000);
try {
  await proc.start();
  const created = (await proc.call("session/new", { cwd, mcpServers: [] }, 60_000)) as any;
  console.log("current:", created?.models?.currentModelId);
  const result = await proc.call("session/set_model", { sessionId: created.sessionId, modelId }, 60_000);
  console.log("set_model:", JSON.stringify(result));
} catch (error) {
  console.log("ERROR", error instanceof Error ? error.message : String(error));
} finally {
  proc.kill();
  try { await rm(cwd, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
