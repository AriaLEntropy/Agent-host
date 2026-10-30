import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents } from "../../src/connectors/discover.js";
import type { DedicatedDescriptor, DedicatedKind } from "../../src/connectors/descriptors.js";
import { belongsToNpmPackage } from "../../src/connectors/locate.js";
import type { RegistryEntry } from "../../src/connectors/registry.js";

const missing = () => undefined;

function dedicated(kind: DedicatedKind, available: boolean): DedicatedDescriptor {
  return {
    kind,
    id: kind,
    name: { codex: "Codex", claude: "Claude Code", hermes: "Hermes", pi: "Pi", openclaw: "OpenClaw" }[kind],
    ...(available ? { executable: `C:/tools/${kind}.cmd` } : {}),
    available,
    enabled: true,
    origin: "dedicated",
    status: available ? "ok" : "degraded",
  };
}

test("a manifest is found and a missing registry binary is not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-agents-"));
  await writeFile(
    join(dir, "my-agent.json"),
    JSON.stringify({ id: "my-agent", name: "My Agent", command: "my-agent", args: ["--acp"] }),
  );
  await writeFile(join(dir, "dsh.json"), JSON.stringify({ id: "dsh", name: "Nope", command: "dsh" }));
  const entries: RegistryEntry[] = [
    { id: "gemini", name: "Gemini CLI", binaries: ["gemini"], args: ["--acp"], npmPackage: "@google/gemini-cli" },
    { id: "gone", name: "Gone", binaries: ["gone"], args: [] },
  ];
  const found = await discoverAgents({
    manifestDir: dir,
    entries,
    locate: (name) => (name === "my-agent" ? "C:/tools/my-agent.cmd" : undefined),
    dshExecutable: "",
    descriptors: [],
  });
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0].reason, /已被占用/);
  const acp = found.agents.filter((agent) => agent.kind === "acp");
  assert.deepEqual(acp.map((agent) => agent.id), ["my-agent"]);
  assert.equal(acp[0].available, true);
  assert.equal(found.agents.at(-1)?.kind, "dsh");
  assert.equal(found.agents.at(-1)?.available, false);
});

test("an npm registry entry must live inside its package", async () => {
  const entries: RegistryEntry[] = [
    { id: "gemini", name: "Gemini CLI", binaries: ["gemini"], args: ["--acp"], npmPackage: "@google/gemini-cli" },
  ];
  const skipped = await discoverAgents({
    manifestDir: join(tmpdir(), "missing-agents-dir"),
    entries,
    locate: () => "C:/tools/gemini.cmd",
    dshExecutable: "",
    descriptors: [],
  });
  assert.equal(skipped.agents.some((agent) => agent.id === "gemini"), false);
  assert.equal(
    belongsToNpmPackage(
      "C:/Users/me/AppData/Roaming/npm/node_modules/@google/gemini-cli/gemini.cmd",
      "@google/gemini-cli",
    ),
    true,
  );
});

test("dsh is discovered from an explicit executable", async () => {
  const found = await discoverAgents({
    manifestDir: join(tmpdir(), "missing-agents-dir"),
    entries: [],
    locate: missing,
    dshExecutable: "C:/tools/dsh.cmd",
    descriptors: [],
  });
  const dsh = found.agents.find((agent) => agent.kind === "dsh");
  assert.equal(dsh?.available, true);
  assert.equal(dsh?.executable, "C:/tools/dsh.cmd");
});

test("only ten ACP agents are kept, in name order", async () => {
  const entries: RegistryEntry[] = Array.from({ length: 11 }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${String.fromCharCode(97 + index)}`,
    binaries: [`bin-${index}`],
    args: [],
  }));
  const found = await discoverAgents({
    manifestDir: join(tmpdir(), "missing-agents-dir"),
    entries,
    locate: (name) => `C:/tools/${name}`,
    dshExecutable: "",
    descriptors: [],
  });
  const acp = found.agents.filter((agent) => agent.kind === "acp");
  assert.equal(acp.length, 10);
  assert.equal(acp[0].id, "agent-0");
  assert.equal(acp.some((agent) => agent.id === "agent-10"), false);
  assert.equal(found.agents.at(-1)?.id, "dsh");
});

test("an available dedicated connector hides its ACP adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-agents-"));
  await writeFile(
    join(dir, "codex-acp-local.json"),
    JSON.stringify({ id: "codex-acp-local", name: "Codex", command: "codex-acp-local" }),
  );
  await writeFile(
    join(dir, "claude-code.json"),
    JSON.stringify({ id: "claude-code", name: "Claude Code", command: "claude-code" }),
  );
  await writeFile(
    join(dir, "gemini.json"),
    JSON.stringify({ id: "gemini", name: "Gemini CLI", command: "gemini" }),
  );
  const found = await discoverAgents({
    manifestDir: dir,
    entries: [],
    locate: (name) => `C:/tools/${name}.cmd`,
    dshExecutable: "",
    descriptors: [dedicated("codex", true), dedicated("claude", true)],
  });
  const acp = found.agents.filter((agent) => agent.kind === "acp");
  assert.deepEqual(acp.map((agent) => agent.id), ["gemini"]);
  assert.equal(found.agents.some((agent) => agent.kind === "codex" && agent.available), true);
  assert.equal(found.agents.some((agent) => agent.kind === "claude" && agent.available), true);
});

test("an unavailable dedicated connector leaves its ACP adapter listed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-agents-"));
  await writeFile(
    join(dir, "codex-acp-local.json"),
    JSON.stringify({ id: "codex-acp-local", name: "Codex", command: "codex-acp-local" }),
  );
  await writeFile(
    join(dir, "gemini.json"),
    JSON.stringify({ id: "gemini", name: "Gemini CLI", command: "gemini" }),
  );
  const found = await discoverAgents({
    manifestDir: dir,
    entries: [],
    locate: (name) => `C:/tools/${name}.cmd`,
    dshExecutable: "",
    descriptors: [dedicated("codex", false)],
  });
  const acp = found.agents.filter((agent) => agent.kind === "acp");
  assert.deepEqual(acp.map((agent) => agent.id), ["codex-acp-local", "gemini"]);
  assert.equal(found.agents.some((agent) => agent.kind === "codex" && agent.available), false);
});
