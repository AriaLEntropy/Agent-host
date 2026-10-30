import { refreshAgents } from "../src/connectors/runtime.js";
import { busStore } from "../src/bus/store.js";

await refreshAgents();
for (let i = 0; i < 30; i += 1) {
  const snapshot = busStore.snapshot() as any;
  const connectors = snapshot.agents?.[0]?.connectors ?? [];
  const withModels = connectors.filter((item: any) => item.models?.length);
  if (withModels.length === connectors.length) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const snapshot = busStore.snapshot() as any;
for (const connector of snapshot.agents?.[0]?.connectors ?? []) {
  console.log(`${connector.displayName}: ${(connector.models ?? []).length} models`);
}
process.exit(0);
