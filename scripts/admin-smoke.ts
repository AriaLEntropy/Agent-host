import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createChecks, createHarness, sleep } from "./lib/sealed-harness.js";

const RELAY_DIR = resolve(fileURLToPath(new URL("../../dsh-scan-remote/relay", import.meta.url)));
const ADMIN_USER = "admin";
const ADMIN_PASSWORD = "test-admin-password";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHealth(base: string, child: ChildProcess, logs: string[]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Relay exited: ${logs.join("")}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Relay did not start: ${logs.join("")}`);
}

async function main() {
  const { check, finish } = createChecks();
  const dir = await mkdtemp(join(tmpdir(), "agent-host-admin-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const relay = spawn(process.execPath, ["dist/server.js"], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: randomBytes(48).toString("base64url"),
      ADMIN_USERNAME: ADMIN_USER,
      ADMIN_PASSWORD,
      ALLOW_LEGACY_WEB_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  relay.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  try {
    await waitForHealth(base, relay, logs);
    harness = await createHarness({ relayUrl: base, hostName: "Admin Smoke Host" });
    await sleep(500);

    const login = await fetch(`${base}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    check("admin login", login.status === 200 && cookie.includes("dsh_admin="), `status=${login.status}`);

    const statsResponse = await fetch(`${base}/admin/api/stats`, {
      headers: { cookie },
    });
    const stats = JSON.parse(await statsResponse.text()) as {
      hosts?: { online?: number; dshOnline?: number };
    };
    const hosts = stats.hosts;
    check(
      "admin stats show the host online",
      statsResponse.status === 200 && (hosts?.online ?? 0) >= 1,
      `status=${statsResponse.status} online=${String(hosts?.online)} dshOnline=${String(hosts?.dshOnline)}`,
    );
    check(
      "admin stats show dsh online",
      (hosts?.dshOnline ?? 0) >= 1,
      `dshOnline=${String(hosts?.dshOnline)}`,
    );
  } finally {
    await harness?.close();
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
