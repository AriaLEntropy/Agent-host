import { refreshAgents } from "../src/connectors/runtime.js";
import { busStore } from "../src/bus/store.js";
await refreshAgents();
await new Promise((resolve) => setTimeout(resolve, 6000));
const snapshot = busStore.snapshot() as any;
for (const connector of snapshot.agents?.[0]?.connectors ?? []) {
  if (!connector.models?.length) continue;
  console.log(connector.displayName);
  for (const model of connector.models) console.log(`  ${model.id} | ${model.displayName} | efforts=${(model.efforts ?? []).join(",")} | default=${model.defaultEffort ?? "-"}`);
}
process.exit(0);
