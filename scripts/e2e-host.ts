/**
 * 模拟器 E2E 的电脑端编排：起临时 Relay + 电脑端，注册假 ACP Agent，
 * 并把配对链接打到 stdout（CI 解析 PAIR_LINK=... 后注入手机）。
 *
 * 不读真实配置、不启真实 Agent、不依赖外部网络。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const RELAY_DIR =
  process.env.AGENT_HOST_RELAY_DIR?.trim() ||
  resolve(HOST_DIR, "../dsh-scan-remote/relay");
const fakeAcp = resolve(HOST_DIR, "test/fixtures/fake-acp.mjs");

function log(line: string) {
  process.stdout.write(`${line}\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForRelay(url: string, child: ChildProcess, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("relay exited");
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("relay did not become healthy");
}

async function main() {
  const port = await freePort();
  const relayUrl = `http://127.0.0.1:${port}`;
  const publicRelayUrl = process.env.E2E_PUBLIC_RELAY_URL?.trim() || `http://10.0.2.2:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), "agent-host-emulator-e2e-"));
  await mkdir(join(dataDir, "agents"), { recursive: true });
  await writeFile(
    join(dataDir, "agents", "fake.json"),
    JSON.stringify(
      {
        id: "fake",
        name: "Fake ACP",
        command: process.execPath,
        args: [fakeAcp],
        env: { FAKE_ACP_IMAGE: "1" },
      },
      null,
      2,
    ),
  );
  const configPath = join(dataDir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        hostName: "E2E Computer",
        relay: relayUrl,
        publicRelayUrl,
        dshPort: 1,
      },
      null,
      2,
    ),
  );

  const relay = spawn(process.execPath, [join(RELAY_DIR, "dist", "server.js")], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dataDir, "relay.sqlite"),
      JWT_SECRET: "e2e-secret",
      ALLOW_LEGACY_WEB_PROXY: "0",
      PAIR_RATE_LIMIT_PER_MINUTE: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout?.on("data", (chunk) => process.stderr.write(String(chunk)));
  relay.stderr?.on("data", (chunk) => process.stderr.write(String(chunk)));

  const host = spawn(process.execPath, ["dist/cli.js", "up"], {
    cwd: HOST_DIR,
    env: {
      ...process.env,
      HOME: dataDir,
      USERPROFILE: dataDir,
      AGENT_HOST_CONFIG: configPath,
      AGENT_HOST_RELAY: relayUrl,
      PUBLIC_RELAY_URL: publicRelayUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let printed = false;
  const scan = (chunk: Buffer) => {
    const text = String(chunk);
    process.stderr.write(text);
    if (printed) return;
    const match = text.match(/https?:\/\/\S*\/pair\?\S+/);
    if (match) {
      printed = true;
      log(`PAIR_LINK=${match[0]}`);
    }
  };
  host.stdout?.on("data", scan);
  host.stderr?.on("data", scan);

  const cleanup = () => {
    host.kill("SIGTERM");
    relay.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  await waitForRelay(relayUrl, relay);
  log(`RELAY_URL=${publicRelayUrl}`);
  const deadline = Date.now() + 60_000;
  while (!printed && Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error(`host exited code=${host.exitCode}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!printed) throw new Error("host did not print a pair link");
  log("E2E_HOST_READY");
  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
