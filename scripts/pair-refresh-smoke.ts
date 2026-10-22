import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveClaimToken } from "../src/tunnel/e2ee.js";
import { createChecks, sleep } from "./lib/sealed-harness.js";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForRelay(base: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Relay exited");
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("Relay did not start");
}

async function main() {
  const { check, finish } = createChecks();
  const dir = await mkdtemp(join(tmpdir(), "agent-host-pair-refresh-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const configPath = join(dir, "config.json");
  const relay = spawn(process.execPath, ["dist/server.js"], {
    cwd: new URL("../../dsh-scan-remote/relay", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PAIR_TTL_MS: "5000",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: randomBytes(48).toString("base64url"),
      ALLOW_LEGACY_WEB_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let host: ChildProcess | undefined;
  try {
    await waitForRelay(base, relay);
    host = spawn(process.execPath, ["dist/cli.js", "pair"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_HOST_CONFIG: configPath,
        AGENT_HOST_RELAY: base,
        PUBLIC_RELAY_URL: base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const urls: Array<{ pairId: string; key: string }> = [];
    let sawExpiry = false;
    host.stdout?.on("data", (chunk) => {
      output += String(chunk);
      for (const match of String(chunk).matchAll(/pair\?id=([^&]+)&key=([^&\s]+)/g))
        urls.push({ pairId: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) });
      if (output.includes("Pairing QR expired; generating a new one")) sawExpiry = true;
    });
    host.stderr?.on("data", (chunk) => (output += String(chunk)));

    const deadline = Date.now() + 12_000;
    while ((urls.length < 2 || !sawExpiry) && Date.now() < deadline) await sleep(100);

    check("first QR was shown", urls.length >= 1, `urls=${urls.length}`);
    check("expired QR was refreshed", sawExpiry && urls.length >= 2, `urls=${urls.length} expiry=${sawExpiry}`);
    if (urls.length < 2) throw new Error(output.slice(-2000));

    const second = urls[urls.length - 1];
    const claimed = await fetch(`${base}/pair/claim-device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairId: second.pairId,
        claimToken: deriveClaimToken(second.key),
        deviceLabel: "refresh smoke client",
        platform: "android",
      }),
    });
    check("second QR was claimable", claimed.status === 200, `status=${claimed.status}`);

    const exit =
      host!.exitCode !== null
        ? host!.exitCode
        : await new Promise<number | null>((resolve) => host!.once("exit", resolve));
    check("host paired after refresh", exit === 0, `exit=${String(exit)}`);
    const config = JSON.parse(await readFile(configPath, "utf8")) as { hostToken?: string };
    check("pairing credential saved", Boolean(config.hostToken), `hostToken=${Boolean(config.hostToken)}`);
    check("paired message printed", output.includes("Pairing QR #2") && output.includes("Paired as"), `qr2=${output.includes("Pairing QR #2")}`);
    const countdownLines = output
      .split(/\r?\n/)
      .filter((line) => line.includes("Pairing QR expires in"));
    check(
      "countdown printed",
      countdownLines.length >= 2,
      `lines=${countdownLines.length} first=${countdownLines[0] ?? ""} last=${countdownLines.at(-1) ?? ""}`,
    );
    for (const line of countdownLines) console.log(line);
  } finally {
    host?.kill("SIGTERM");
    relay.kill("SIGTERM");
    await sleep(200);
    if (relay.exitCode === null) relay.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
