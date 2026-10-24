import { createChecks, createHarness, jsonBody } from "./lib/sealed-harness.js";

const downMs = Number(process.argv[2] ?? 300_000);

async function main() {
  const harness = await createHarness({ hostName: "Outage Host", hostProcess: true });
  const { check, finish } = createChecks();

  try {
    const before = await harness.tunnel.request("GET", "/bus/describe");
    check("tunnel before outage", before.status === 200, `status=${before.status}`);

    console.log(`Stopping Relay for ${downMs}ms...`);
    const started = Date.now();
    await harness.restartRelay!(downMs);
    const elapsed = Date.now() - started;

    const afterTunnel = await harness.openTunnel();
    const after = await afterTunnel.request("GET", "/bus/describe");
    check(
      "host reconnected after outage",
      after.status === 200 && jsonBody(after).hostKind === "agent-host",
      `status=${after.status} elapsed=${elapsed}ms`,
    );
    check("outage lasted at least the requested time", elapsed >= downMs, `elapsed=${elapsed}ms`);
  } finally {
    await harness.close();
  }

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
