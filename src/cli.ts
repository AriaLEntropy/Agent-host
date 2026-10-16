#!/usr/bin/env node
import { Command } from "commander";
import { join } from "node:path";
import { loadCommandLog, setCommandLogPath } from "./bus/commands.js";
import { refreshAgents } from "./connectors/runtime.js";
import { hostDataDir, loadConfig, saveConfig } from "./config.js";
import { pair } from "./tunnel/pairing.js";
import { RelayClient } from "./tunnel/relay-client.js";
import { PLUGIN_VERSION } from "./tunnel/version.js";

async function prepare() {
  setCommandLogPath(join(hostDataDir(), "commands.json"));
  await loadCommandLog();
  await refreshAgents().catch(() => undefined);
  return loadConfig();
}

const program = new Command()
  .name("agent-host")
  .description("Pair a phone with this computer over the sealed tunnel")
  .version(PLUGIN_VERSION);

program
  .command("pair")
  .description("Print a pairing QR and wait for the phone")
  .action(async () => {
    const config = await prepare();
    await pair(config);
  });

program
  .command("up")
  .description("Run in the foreground and connect to Relay")
  .action(async () => {
    let config = await prepare();
    if (!config.hostToken) config = await pair(config);
    const client = new RelayClient(config);
    await client.start();
    const stop = () => {
      client.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("unpair")
  .description("Revoke this computer and delete the local device credential")
  .action(async () => {
    const config = await prepare();
    if (config.hostId && config.hostToken) {
      const response = await fetch(
        `${config.relay}/host-management/${encodeURIComponent(config.hostId)}/unbind`,
        {
          method: "POST",
          headers: { authorization: `Host ${config.hostToken}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new Error(`Relay rejected unpair (${response.status})`);
    }
    await saveConfig({
      hostName: config.hostName,
      relay: config.relay,
      publicRelayUrl: config.publicRelayUrl,
      dshPort: config.dshPort,
      agentId: config.agentId,
    });
    console.log("Pairing removed");
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
