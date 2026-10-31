import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { Config } from "../../src/config.js";
import { startSettingsServer } from "../../src/platform/settings-server.js";

let root: string;
let previousConfig: string | undefined;
let previousLogDir: string | undefined;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-host-settings-"));
  previousConfig = process.env.AGENT_HOST_CONFIG;
  previousLogDir = process.env.AGENT_HOST_LOG_DIR;
  process.env.AGENT_HOST_CONFIG = join(root, "config.json");
  process.env.AGENT_HOST_LOG_DIR = join(root, "logs");
  await mkdir(join(root, "logs"), { recursive: true });
  await writeFile(
    join(root, "logs", "agent-host-2026-10-31.log"),
    "2026-10-31T00:00:00.000Z INFO [agent-host:test] smoke count=1\n",
  );
});

test.afterEach(async () => {
  if (previousConfig === undefined) delete process.env.AGENT_HOST_CONFIG;
  else process.env.AGENT_HOST_CONFIG = previousConfig;
  if (previousLogDir === undefined) delete process.env.AGENT_HOST_LOG_DIR;
  else process.env.AGENT_HOST_LOG_DIR = previousLogDir;
  await rm(root, { recursive: true, force: true });
});

function config(): Config {
  return {
    hostName: "<Test Host>",
    relay: "http://127.0.0.1:8787",
    dshPort: 3080,
    hostId: "host_1",
    hostToken: "HOST-SECRET",
    e2eeMasterKey: "MASTER-SECRET",
    agentId: "agent_1",
  };
}

test("the settings page only answers with its one-time token and never shows credentials", async () => {
  const server = await startSettingsServer({
    config: config(),
    logDirectory: join(root, "logs"),
  });
  try {
    assert.equal(server.port > 0, true);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);

    const missing = await fetch(`${server.origin}/`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`${server.origin}/?token=not-the-token`);
    assert.equal(wrong.status, 401);

    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /导出诊断包/);
    assert.match(html, /agent-host-2026-10-31\.log|日志占用/);
    assert.match(html, /&lt;Test Host&gt;/);
    assert.doesNotMatch(html, /HOST-SECRET|MASTER-SECRET/);
    assert.doesNotMatch(html, /hostToken|e2eeMasterKey/);
  } finally {
    await server.close();
  }
});

test("the export button writes a credential-free bundle without taking a path", async () => {
  const server = await startSettingsServer({
    config: config(),
    logDirectory: join(root, "logs"),
  });
  try {
    const method = await fetch(`${server.origin}/?token=${server.token}`, { method: "PUT" });
    assert.equal(method.status, 405);

    const exported = await fetch(`${server.origin}/diagnostics?token=${server.token}`, {
      method: "POST",
    });
    assert.equal(exported.status, 200);
    const html = await exported.text();
    assert.match(html, /诊断包已导出/);
    assert.match(html, /\.tar\.gz/);

    const names = (await readdir(join(root, "diagnostics"))).filter((name) =>
      name.endsWith(".tar.gz"),
    );
    assert.equal(names.length, 1);
    const archive = gunzipSync(
      await readFile(join(root, "diagnostics", names[0]!)),
    ).toString("latin1");
    assert.ok(archive.includes("config.redacted.json"));
    assert.ok(archive.includes("summary.json"));
    assert.ok(archive.includes("logs/agent-host-2026-10-31.log"));
    assert.ok(archive.includes('"hostToken": "<private>"'));
    assert.ok(!archive.includes("HOST-SECRET"));
    assert.ok(!archive.includes("MASTER-SECRET"));
  } finally {
    await server.close();
  }
});
