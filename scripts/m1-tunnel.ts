import { execFileSync } from "node:child_process";
import { createChecks, createHarness, jsonBody } from "./lib/sealed-harness.js";

async function main() {
  const harness = await createHarness({ hostName: "Tunnel Host", hostProcess: true });
  const { check, finish } = createChecks();

  try {
    const describe = await harness.tunnel.request("GET", "/bus/describe");
    const body = jsonBody(describe);
    check("GET /bus/describe 200", describe.status === 200, `status=${describe.status}`);
    check("hostKind=agent-host", body.hostKind === "agent-host", `hostKind=${String(body.hostKind)}`);
    check("protocolVersion=3.9", body.protocolVersion === "3.9", `version=${String(body.protocolVersion)}`);
    check(
      "agentId is 22-char base64url",
      typeof body.agentId === "string" && /^[A-Za-z0-9_-]{22}$/.test(body.agentId),
      `agentId=${String(body.agentId)}`,
    );
    check(
      "forwardsDsh is boolean",
      typeof body.forwardsDsh === "boolean",
      `forwardsDsh=${String(body.forwardsDsh)}`,
    );

    const unknown = await harness.tunnel.request("GET", "/bus/not-a-route");
    check("unknown /bus/* returns 404", unknown.status === 404, `status=${unknown.status}`);

    if (process.platform === "win32" && harness.hostPid) {
      const output = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      const pattern = new RegExp(`\\s${harness.hostPid}\\s*$`);
      const listening = output
        .split(/\r?\n/)
        .filter((line) => line.includes("LISTENING") && pattern.test(line));
      check(
        "host process has no LISTENING TCP port",
        listening.length === 0,
        `pid=${harness.hostPid} lines=${listening.length}`,
      );
    } else {
      console.log(`SKIP  no-LISTENING check (platform=${process.platform})`);
    }

    if (!harness.restartRelay) throw new Error("restartRelay is not available");
    await harness.restartRelay();
    const afterTunnel = await harness.openTunnel();
    const after = await afterTunnel.request("GET", "/bus/describe");
    check(
      "host reconnects after Relay restart",
      after.status === 200 && jsonBody(after).hostKind === "agent-host",
      `status=${after.status}`,
    );
  } finally {
    await harness.close();
  }

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
