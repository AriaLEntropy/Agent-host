import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { busStore } from "../../src/bus/store.js";
import type { DedicatedKind } from "../../src/connectors/descriptors.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import type {
  MessageReader,
  TaskConnector,
} from "../../src/connectors/ported/contract.js";
import {
  dedicatedConnectorHooks,
  executeCommand,
  flushConnectorSettings,
  refreshAgents,
  resetRuntime,
  setDedicatedFactories,
  useAgents,
} from "../../src/connectors/runtime.js";
import {
  loadConnectorSettings,
  normalizeProjectPath,
  saveConnectorSettings,
} from "../../src/connectors/settings-store.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const roots: string[] = [];

function fakeConnector(kind: DedicatedKind): TaskConnector {
  const outcome = { taskId: `${kind}:native-1`, retainsLiveOwnership: true };
  return {
    kind,
    runsUnderBotBus: true,
    async start() {
      return outcome;
    },
    async followUp() {
      return outcome;
    },
    async approve() {
      return outcome;
    },
    async interrupt() {
      return outcome;
    },
  };
}

function fakeReader(kind: DedicatedKind): MessageReader {
  return {
    kind,
    async entries() {
      return { entries: [], hasMore: false };
    },
  };
}

function installFake(kind: DedicatedKind) {
  setDedicatedFactories({
    connectors: { [kind]: () => fakeConnector(kind) },
    readers: { [kind]: () => fakeReader(kind) },
  });
}

function dedicatedSpec(kind: DedicatedKind, overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: kind,
    kind,
    name: kind,
    executable: `C:/fake/${kind}.exe`,
    args: [],
    env: {},
    origin: "dedicated",
    available: true,
    enabled: true,
    status: "ok",
    ...overrides,
  };
}

async function freshSettings(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `agent-host-runtime-${label}-`));
  roots.push(directory);
  // 先把上一份实例排队的写入刷到它自己的路径，再切到新文件。
  await flushConnectorSettings();
  const path = join(directory, "connector-settings.json");
  process.env.AGENT_HOST_CONNECTOR_SETTINGS = path;
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
  return path;
}

function connectorsSnapshot(): Array<Record<string, any>> {
  return (busStore.snapshot().agents as Array<{ connectors: Array<Record<string, any>> }>)[0]
    .connectors;
}

after(async () => {
  await flushConnectorSettings();
  delete process.env.AGENT_HOST_CONNECTOR_SETTINGS;
  for (const directory of roots) await rm(directory, { recursive: true, force: true });
});

describe("runtime connector settings persistence", { concurrency: false }, () => {
  test("auto approve survives resetRuntime and a fresh refreshAgents", async () => {
    await freshSettings("auto-approve");
    installFake("codex");
    useAgents([dedicatedSpec("codex")]);

    const started = await executeCommand({
      id: "start-auto-approve",
      kind: "startTask",
      startTask: {
        source: "codex",
        projectPath: "C:/work/demo",
        prompt: "hello",
        autoApprove: true,
      },
    });
    assert.equal(started.ok, true, started.error);
    const hooks = dedicatedConnectorHooks("codex");
    assert.equal(hooks.autoApproves(started.taskId!, "C:/work/demo"), true);
    await flushConnectorSettings();

    // 模拟宿主重启：清内存、重新发现。
    resetRuntime();
    busStore.reset();
    busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
    installFake("codex");
    await refreshAgents(async () => ({ agents: [dedicatedSpec("codex")] }));

    const reloaded = dedicatedConnectorHooks("codex");
    assert.equal(reloaded.autoApproves("codex:native-1", "C:/work/demo"), true);
    // 另一种路径写法也应命中同一个项目。
    assert.equal(
      reloaded.autoApproves(
        "codex:native-1",
        normalizeProjectPath("C:/work/demo").replace(/\//g, "\\") + "/",
      ),
      true,
    );
  });

  test("a disabled connector stays disabled after a restart, and restartConnector re-enables it", async () => {
    await freshSettings("enabled");
    installFake("codex");
    useAgents([dedicatedSpec("codex")]);

    const disabled = await executeCommand({
      id: "disable-codex",
      kind: "setConnectorEnabled",
      setConnectorEnabled: { connector: "codex", enabled: false },
    });
    assert.equal(disabled.ok, true, disabled.error);
    await flushConnectorSettings();

    resetRuntime();
    busStore.reset();
    busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
    installFake("codex");
    await refreshAgents(async () => ({ agents: [dedicatedSpec("codex")] }));
    assert.equal(connectorsSnapshot().find((item) => item.kind === "codex")?.enabled, false);

    const rejected = await executeCommand({
      id: "start-disabled",
      kind: "startTask",
      startTask: { source: "codex", projectPath: "C:/work/demo", prompt: "hello" },
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /disabled/);

    const restarted = await executeCommand({
      id: "restart-codex",
      kind: "restartConnector",
      restartConnector: { connector: "codex" },
    });
    assert.equal(restarted.ok, true, restarted.error);
    await flushConnectorSettings();

    resetRuntime();
    busStore.reset();
    busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
    installFake("codex");
    await refreshAgents(async () => ({ agents: [dedicatedSpec("codex")] }));
    assert.equal(connectorsSnapshot().find((item) => item.kind === "codex")?.enabled, true);
  });

  test("persisted OpenClaw enablement overrides its descriptor default in both directions", async () => {
    const path = await freshSettings("openclaw");
    assert.equal(
      await saveConnectorSettings(
        {
          version: 1,
          autoApprove: [],
          connectors: [{ kind: "openclaw", enabled: true }],
        },
        path,
      ),
      true,
    );

    await refreshAgents(async () => ({ agents: [dedicatedSpec("openclaw", { enabled: false })] }));
    assert.equal(connectorsSnapshot().find((item) => item.kind === "openclaw")?.enabled, true);

    // 反向：设置里关掉、发现结果默认开，最终仍以设置为准。
    const disabled = await executeCommand({
      id: "disable-openclaw",
      kind: "setConnectorEnabled",
      setConnectorEnabled: { connector: "openclaw", enabled: false },
    });
    assert.equal(disabled.ok, true, disabled.error);
    await flushConnectorSettings();

    resetRuntime();
    busStore.reset();
    busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
    await refreshAgents(async () => ({ agents: [dedicatedSpec("openclaw", { enabled: true })] }));
    assert.equal(connectorsSnapshot().find((item) => item.kind === "openclaw")?.enabled, false);
  });

  test("autoApprove outside a project is rejected and never persisted", async () => {
    const path = await freshSettings("outside");
    installFake("codex");
    useAgents([dedicatedSpec("codex")]);

    const outside = await executeCommand({
      id: "start-outside",
      kind: "startTask",
      startTask: { source: "codex", projectPath: "", prompt: "hello", autoApprove: true },
    });
    assert.equal(outside.ok, false);
    assert.equal(outside.error, "auto approve is not available outside a project");
    await flushConnectorSettings();

    const state = await loadConnectorSettings(path);
    assert.deepEqual(state.autoApprove, []);
  });

  test("a corrupt settings file warns once and does not break discovery or commands", async () => {
    const path = await freshSettings("corrupt");
    await writeFile(path, "{ this is not json");
    installFake("codex");

    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(args.map((item) => String(item)).join(" "));
    };
    try {
      const found = await refreshAgents(async () => ({ agents: [dedicatedSpec("codex")] }));
      assert.equal(found.agents.length, 1);
      assert.ok(connectorsSnapshot().some((item) => item.kind === "codex"));

      const started = await executeCommand({
        id: "start-with-corrupt-settings",
        kind: "startTask",
        startTask: { source: "codex", projectPath: "C:/work/demo", prompt: "hello" },
      });
      assert.equal(started.ok, true, started.error);
    } finally {
      console.error = original;
    }
    assert.equal(
      warnings.filter((message) => message.includes("connector settings")).length,
      1,
      `expected one settings warning, got ${JSON.stringify(warnings)}`,
    );
  });

  test("resetRuntime keeps the settings file on disk", async () => {
    const path = await freshSettings("keep-file");
    installFake("codex");
    useAgents([dedicatedSpec("codex")]);
    await executeCommand({
      id: "disable-before-reset",
      kind: "setConnectorEnabled",
      setConnectorEnabled: { connector: "codex", enabled: false },
    });
    await flushConnectorSettings();
    resetRuntime();
    const state = await loadConnectorSettings(path);
    assert.deepEqual(state.connectors, [{ kind: "codex", enabled: false }]);
  });
});
