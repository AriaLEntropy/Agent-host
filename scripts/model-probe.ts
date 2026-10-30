import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/connectors/discover.js";
import { AcpProcess } from "../src/connectors/runtime.js";

const ids = process.argv.slice(2);
const found = await discoverAgents();
for (const id of ids) {
  const spec = found.agents.find((agent) => agent.id === id);
  if (!spec?.executable) { console.log(`${id}: unavailable`); continue; }
  const cwd = await mkdtemp(join(tmpdir(), "model-probe-"));
  const proc = new AcpProcess(spec.executable, spec.args, spec.env, () => {}, () => {}, 60_000);
  try {
    await proc.start();
    const created = await proc.call("session/new", { cwd, mcpServers: [] }, 60_000);
    console.log(`${id}: ${JSON.stringify(created).slice(0, 2000)}`);
  } catch (error) {
    console.log(`${id}: ERROR ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    proc.kill();
    try { await rm(cwd, { recursive: true, force: true }); } catch {}
  }
}
process.exit(0);
