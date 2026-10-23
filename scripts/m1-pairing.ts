import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveClaimToken, generateMasterKey, hashClaimToken } from "../src/tunnel/e2ee.js";
import { RELAY_DIR, createChecks, createHarness, sleep } from "./lib/sealed-harness.js";

const PAIR_TTL_MS = 8_000;

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

async function post(base: string, path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { status: response.status, data };
}

async function main() {
  const { check, finish } = createChecks();
  const dir = await mkdtemp(join(tmpdir(), "m1-pairing-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const configPath = join(dir, "config.json");
  const relay = spawn(process.execPath, ["dist/server.js"], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PAIR_TTL_MS: String(PAIR_TTL_MS),
      PAIR_RATE_LIMIT_PER_MINUTE: "1000",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: randomBytes(48).toString("base64url"),
      ALLOW_LEGACY_WEB_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let host: ChildProcess | undefined;
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;

  try {
    await waitForRelay(base, relay);

    // A. 手机扫码到电脑端显示 Paired as 的耗时
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
    let qr: { pairId: string; key: string } | undefined;
    let qrAt = 0;
    host.stdout?.on("data", (chunk) => {
      output += String(chunk);
      if (!qr) {
        const match = String(chunk).match(/pair\?id=([^&]+)&key=([^&\s]+)/);
        if (match) {
          qr = { pairId: decodeURIComponent(match[1]), key: decodeURIComponent(match[2]) };
          qrAt = Date.now();
        }
      }
    });
    host.stderr?.on("data", (chunk) => (output += String(chunk)));

    const qrDeadline = Date.now() + 10_000;
    while (!qr && Date.now() < qrDeadline) await sleep(50);
    check("QR shown", Boolean(qr), `pair=${Boolean(qr)}`);
    if (!qr) throw new Error(output.slice(-2000));

    const claimed = await post(base, "/pair/claim-device", {
      pairId: qr.pairId,
      claimToken: deriveClaimToken(qr.key),
      deviceLabel: "M1 pairing smoke",
      platform: "android",
    });
    check("POST /pair/claim-device 2xx", claimed.status === 200, `status=${claimed.status}`);

    const pairedDeadline = Date.now() + 10_000;
    while (!output.includes("Paired as") && Date.now() < pairedDeadline) await sleep(50);
    const pairedAt = Date.now();
    check("host printed Paired as", output.includes("Paired as"), output.includes("Paired as") ? "yes" : output.slice(-500));
    check(
      "scan to Paired as < 5000ms",
      output.includes("Paired as") && pairedAt - qrAt < 5_000,
      `elapsed=${pairedAt - qrAt}ms`,
    );

    const exit =
      host.exitCode !== null
        ? host.exitCode
        : await new Promise<number | null>((resolve) => host!.once("exit", resolve));
    check("pair command exit 0", exit === 0, `exit=${String(exit)}`);
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { hostToken?: string };
    check("host credential saved", Boolean(saved.hostToken), `hostToken=${Boolean(saved.hostToken)}`);

    // B. 二维码过期与不存在的 pairId
    const session = await post(base, "/pair/session", {
      claimTokenHash: hashClaimToken(deriveClaimToken(generateMasterKey())),
      hostName: "Expiry smoke",
    });
    check("POST /pair/session 2xx", session.status === 201, `status=${session.status}`);
    const expiresAt = Number(session.data.expiresAt ?? 0);
    await sleep(Math.max(0, expiresAt - Date.now() + 1_200));
    const expired = await post(base, "/pair/confirm", {
      pairId: session.data.pairId,
      confirmSecret: session.data.confirmSecret,
    });
    check(
      "expired QR is rejected",
      expired.status === 410 || expired.status === 404,
      `status=${expired.status} (relay 语义：410 expired / 404 not_found)`,
    );
    const missing = await post(base, "/pair/claim-device", {
      pairId: "pair_missing",
      claimToken: deriveClaimToken(generateMasterKey()),
      deviceLabel: "missing",
      platform: "android",
    });
    check("unknown pairId returns 404", missing.status === 404, `status=${missing.status}`);

    // C. unpair：隧道断开、旧凭据失效
    harness = await createHarness({ hostName: "Unpair Host", hostProcess: true });
    const before = await harness.tunnel.request("GET", "/bus/describe");
    check("tunnel works before unpair", before.status === 200, `status=${before.status}`);
    if (!harness.configPath) throw new Error("harness config path is not available");
    const beforeConfig = JSON.parse(await readFile(harness.configPath, "utf8")) as {
      hostId?: string;
      hostToken?: string;
    };

    const unpair = spawn(process.execPath, ["dist/cli.js", "unpair"], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_HOST_CONFIG: harness.configPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let unpairOutput = "";
    unpair.stdout?.on("data", (chunk) => (unpairOutput += String(chunk)));
    unpair.stderr?.on("data", (chunk) => (unpairOutput += String(chunk)));
    const unpairExit =
      unpair.exitCode !== null
        ? unpair.exitCode
        : await new Promise<number | null>((resolve) => unpair.once("exit", resolve));
    check("unpair exit 0", unpairExit === 0, `exit=${String(unpairExit)} ${unpairOutput.trim()}`);

    const afterConfig = JSON.parse(await readFile(harness.configPath, "utf8")) as {
      hostToken?: string;
    };
    check("hostToken removed", !afterConfig.hostToken, `hostToken=${Boolean(afterConfig.hostToken)}`);

    let tunnelClosed = false;
    try {
      await harness.tunnel.request("GET", "/bus/describe", undefined, 5_000);
    } catch {
      tunnelClosed = true;
    }
    check("existing tunnel closed after unpair", tunnelClosed, `closed=${tunnelClosed}`);

    const ticket = await fetch(`${harness.relayUrl}/access-ticket`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.clientToken}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    check("old client token rejected", ticket.status === 401 || ticket.status === 403, `status=${ticket.status}`);

    const unbind = await fetch(
      `${harness.relayUrl}/host-management/${encodeURIComponent(beforeConfig.hostId ?? "")}/unbind`,
      {
        method: "POST",
        headers: { authorization: `Host ${beforeConfig.hostToken}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    check("old host token rejected", unbind.status === 401 || unbind.status === 403, `status=${unbind.status}`);
  } finally {
    host?.kill("SIGTERM");
    await harness?.close().catch(() => undefined);
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
