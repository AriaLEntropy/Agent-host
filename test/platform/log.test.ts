import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  LOG_RETENTION_MS,
  cleanupLogs,
  createLogger,
  createTarGz,
  exportDiagnostics,
  initializeLogging,
  logPublic,
  redactedConfig,
  shutdownLogging,
} from "../../src/platform/log.js";
import type { Config } from "../../src/config.js";

let root: string;

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agent-host-log-")));
  delete process.env.AGENT_HOST_LOG_PRIVATE;
});

test.afterEach(async () => {
  await shutdownLogging();
  delete process.env.AGENT_HOST_LOG_PRIVATE;
  await rm(root, { recursive: true, force: true });
});

async function onlyLogFile(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => /^agent-host-.*\.log$/.test(name));
  assert.equal(names.length, 1, `expected one log file, got ${names.join(", ")}`);
  return join(directory, names[0]!);
}

test("values are private unless they are numbers, booleans or explicitly public", async () => {
  const directory = join(root, "logs");
  await initializeLogging({ directory, stderr: false });
  const log = createLogger("agent-host", "test");
  log.info("images uploaded", {
    count: 2,
    ok: true,
    path: "C:\\Users\\alice\\secret.png",
    token: "tok-123",
    nested: { text: "hello" },
    shown: logPublic("demo"),
  });
  await shutdownLogging();

  const text = await readFile(await onlyLogFile(directory), "utf8");
  assert.match(text, /INFO \[agent-host:test\] images uploaded/);
  assert.match(text, /count=2/);
  assert.match(text, /ok=true/);
  assert.match(text, /shown="demo"/);
  assert.doesNotMatch(text, /alice/);
  assert.doesNotMatch(text, /tok-123/);
  assert.doesNotMatch(text, /hello/);
  assert.match(text, /path=<private>/);
  assert.match(text, /nested=<private>/);
});

test("AGENT_HOST_LOG_PRIVATE=1 reveals the values, including newlines collapsed to one line", async () => {
  const directory = join(root, "logs-private");
  await initializeLogging({ directory, stderr: false });
  process.env.AGENT_HOST_LOG_PRIVATE = "1";
  createLogger("agent-host", "test").warning("line one\nline two", { detail: "boom" });
  await shutdownLogging();

  const text = await readFile(await onlyLogFile(directory), "utf8");
  assert.match(text, /line one line two/);
  assert.match(text, /detail="boom"/);
  assert.equal(text.trim().split(/\r?\n/).length, 1);
});

test("cleanup drops logs older than the retention window", async () => {
  const directory = join(root, "old-logs");
  await mkdir(directory, { recursive: true });
  const old = join(directory, "agent-host-2026-01-01.log");
  await writeFile(old, "old\n");
  const now = new Date("2026-01-11T00:00:00Z");
  await utimes(old, new Date(now.getTime() - LOG_RETENTION_MS - 1000), new Date(now.getTime() - LOG_RETENTION_MS - 1000));
  const fresh = join(directory, "agent-host-2026-01-10.log");
  await writeFile(fresh, "fresh\n");
  await utimes(fresh, now, now);

  assert.equal(await cleanupLogs(directory, now), 1);
  assert.deepEqual(await readdir(directory), ["agent-host-2026-01-10.log"]);
});

test("cleanup keeps the total under the limit by deleting the oldest files first", async () => {
  const directory = join(root, "big-logs");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  const older = join(directory, "agent-host-2026-02-01.log");
  const newer = join(directory, "agent-host-2026-02-02.log");
  await writeFile(older, Buffer.alloc(100, 0x61));
  await writeFile(newer, Buffer.alloc(100, 0x62));
  const now = new Date("2026-02-02T12:00:00Z");
  await utimes(older, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
  await utimes(newer, now, now);

  assert.equal(await cleanupLogs(directory, now, { totalLimitBytes: 150 }), 1);
  assert.deepEqual(await readdir(directory), ["agent-host-2026-02-02.log"]);
});

test("the diagnostic bundle carries logs and a credential-free config", async () => {
  const directory = join(root, "logs");
  await initializeLogging({ directory, stderr: false });
  createLogger("agent-host", "test").info("smoke", { count: 1 });
  await shutdownLogging();

  const settings = join(root, "connector-settings.json");
  await writeFile(settings, '{"version":1,"autoApprove":[]}\n');
  const config: Config = {
    hostName: "Test Mac",
    relay: "http://127.0.0.1:8787",
    dshPort: 3080,
    hostId: "host_1",
    hostToken: "HOST-SECRET",
    e2eeMasterKey: "MASTER-SECRET",
    agentId: "agent_1",
  };
  assert.deepEqual(redactedConfig(config), {
    hostName: "Test Mac",
    relay: "http://127.0.0.1:8787",
    dshPort: 3080,
    hostId: "host_1",
    hostToken: "<private>",
    e2eeMasterKey: "<private>",
    agentId: "agent_1",
  });

  const out = join(root, "diagnostics", "bundle.tar.gz");
  await exportDiagnostics({
    config,
    outPath: out,
    logDirectory: directory,
    extraFiles: [{ name: "connector-settings.json", path: settings }],
    now: new Date("2026-03-04T05:06:07Z"),
  });

  const entries = readTar(gunzipSync(await readFile(out)));
  assert.ok(entries.has("summary.json"));
  assert.ok(entries.has("config.redacted.json"));
  assert.ok(entries.has("connector-settings.json"));
  const logName = [...entries.keys()].find((name) => name.startsWith("logs/"));
  assert.ok(logName, "the bundle must contain the daily log");
  assert.match(entries.get(logName!)!.toString("utf8"), /smoke count=1/);

  const configText = entries.get("config.redacted.json")!.toString("utf8");
  assert.match(configText, /"hostToken": "<private>"/);
  assert.match(configText, /"e2eeMasterKey": "<private>"/);
  assert.doesNotMatch(configText, /HOST-SECRET|MASTER-SECRET/);

  const summary = JSON.parse(entries.get("summary.json")!.toString("utf8")) as {
    platform: string;
    version: string;
  };
  assert.equal(summary.platform, process.platform);
  assert.equal(summary.version, "1.0.0");
});

test("tar headers carry a valid checksum and padding", () => {
  const archive = gunzipSync(
    createTarGz(
      [
        { name: "a.txt", data: Buffer.from("hello") },
        { name: "nested/b.bin", data: Buffer.alloc(513, 7) },
      ],
      new Date("2026-01-01T00:00:00Z"),
    ),
  );
  const entries = readTar(archive);
  assert.equal(entries.get("a.txt")!.toString("utf8"), "hello");
  assert.equal(entries.get("nested/b.bin")!.length, 513);
  assert.equal(archive.length % 512, 0);
});

/** Walk a ustar archive, validating each header's checksum. */
function readTar(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const stored = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
    let actual = 0;
    for (let index = 0; index < 512; index += 1) {
      actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
    }
    assert.equal(actual, stored, "tar header checksum");

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const dataStart = offset + 512;
    entries.set(name, archive.subarray(dataStart, dataStart + size));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}
