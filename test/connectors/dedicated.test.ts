import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { busStore, type BusTask } from "../../src/bus/store.js";
import {
  DEDICATED_KINDS,
  type DedicatedDescriptor,
  type DedicatedKind,
} from "../../src/connectors/descriptors.js";
import { discoverAgents, type AgentSpec } from "../../src/connectors/discover.js";
import type {
  MessageReader,
  TaskConnector,
} from "../../src/connectors/ported/contract.js";
import {
  dedicatedConnectorHooks,
  executeCommand,
  resetRuntime,
  setDedicatedFactories,
  startDedicatedConnectors,
  useAgents,
  type DedicatedConnectorFactory,
  type DedicatedReaderFactory,
} from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const projectDir = process.cwd();

// 启停与自动批准会写本机设置：测试一律指向临时目录，不碰真实 %APPDATA%。
process.env.AGENT_HOST_CONNECTOR_SETTINGS = join(
  mkdtempSync(join(tmpdir(), "agent-host-dedicated-settings-")),
  "connector-settings.json",
);

type Call = { method: string; args: unknown[] };

function fakeConnector(kind: DedicatedKind, calls: Call[]): TaskConnector {
  const outcome = { taskId: `${kind}:native-1`, retainsLiveOwnership: true };
  return {
    kind,
    runsUnderBotBus: true,
    async start(projectPath, prompt, images, selection) {
      calls.push({ method: "start", args: [projectPath, prompt, images, selection] });
      return outcome;
    },
    async followUp(taskId, prompt, images, selection) {
      calls.push({ method: "followUp", args: [taskId, prompt, images, selection] });
      return outcome;
    },
    async approve(taskId, requestId, decision, answers) {
      calls.push({ method: "approve", args: [taskId, requestId, decision, answers] });
      return outcome;
    },
    async interrupt(taskId) {
      calls.push({ method: "interrupt", args: [taskId] });
      return outcome;
    },
    async deleteTask(taskId) {
      calls.push({ method: "deleteTask", args: [taskId] });
    },
  };
}

function fakeReader(kind: DedicatedKind, reads: string[]): MessageReader {
  return {
    kind,
    async entries(taskId, limit) {
      reads.push(`${taskId}:${limit}`);
      return {
        entries: [
          {
            message: {
              id: "m1",
              role: "agent",
              text: "hello",
              createdAt: "2026-10-30T00:00:00Z",
            },
            images: [],
            pathCandidates: [],
          },
        ],
        hasMore: false,
      };
    },
  };
}

function specFor(kind: DedicatedKind): AgentSpec {
  return {
    id: kind,
    kind,
    name: kind,
    executable: `C:/fake/${kind}.exe`,
    args: [],
    env: {},
    origin: "dedicated",
    available: true,
    // 命令路由用例需要连接器处于启用状态；OpenClaw 的默认关闭由 discovery 用例单独覆盖。
    enabled: true,
    status: "ok",
  };
}

function reset() {
  resetRuntime();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
}

function snapshotConnectors(): Array<Record<string, any>> {
  return (busStore.snapshot().agents as Array<{ connectors: Array<Record<string, any>> }>)[0]
    .connectors;
}

function installFake(kind: DedicatedKind, calls: Call[], reads: string[]) {
  const connectors: Partial<Record<DedicatedKind, DedicatedConnectorFactory>> = {};
  const readers: Partial<Record<DedicatedKind, DedicatedReaderFactory>> = {};
  connectors[kind] = (spec) => {
    assert.equal(spec.kind, kind);
    return fakeConnector(kind, calls);
  };
  readers[kind] = () => fakeReader(kind, reads);
  setDedicatedFactories({ connectors, readers });
}

describe("dedicated connectors", { concurrency: false }, () => {
  test("startDedicatedConnectors builds enabled connectors before a phone command", () => {
    reset();
    let built = 0;
    setDedicatedFactories({
      connectors: {
        hermes: () => {
          built += 1;
          return fakeConnector("hermes", []);
        },
      },
    });
    useAgents([specFor("hermes")]);
    assert.equal(built, 0);
    startDedicatedConnectors();
    assert.equal(built, 1);
    startDedicatedConnectors();
    assert.equal(built, 1, "already built instances are reused");
  });

  for (const kind of DEDICATED_KINDS) {
    test(`${kind}: commands route to its connector and reader`, async () => {
      reset();
      const calls: Call[] = [];
      const reads: string[] = [];
      installFake(kind, calls, reads);
      useAgents([specFor(kind)]);
      const taskId = `${kind}:native-1`;

      const started = await executeCommand({
        id: `start-${kind}`,
        kind: "startTask",
        startTask: {
          source: kind,
          projectPath: projectDir,
          prompt: "hello",
          model: "gpt-5",
          effort: "high",
        },
      });
      assert.equal(started.ok, true, started.error);
      assert.equal(started.taskId, taskId);
      const start = calls.find((call) => call.method === "start");
      assert.ok(start, "start was not called");
      assert.deepEqual(start.args, [
        projectDir,
        "hello",
        [],
        { model: "gpt-5", effort: "high" },
      ]);

      const followed = await executeCommand({
        id: `follow-${kind}`,
        kind: "followUp",
        followUp: { taskId, prompt: "again" },
      });
      assert.equal(followed.ok, true, followed.error);
      assert.equal(followed.taskId, taskId);
      const follow = calls.find((call) => call.method === "followUp");
      assert.ok(follow, "followUp was not called");
      assert.deepEqual(follow.args, [taskId, "again", [], undefined]);

      const approved = await executeCommand({
        id: `approve-${kind}`,
        kind: "approve",
        approve: {
          taskId,
          requestId: "req-1",
          decision: "allow",
          answers: { q1: ["Yes"] },
        },
      });
      assert.equal(approved.ok, true, approved.error);
      const approve = calls.find((call) => call.method === "approve");
      assert.ok(approve, "approve was not called");
      assert.deepEqual(approve.args, [taskId, "req-1", "allow", { q1: ["Yes"] }]);

      const interrupted = await executeCommand({
        id: `interrupt-${kind}`,
        kind: "interrupt",
        interrupt: { taskId },
      });
      assert.equal(interrupted.ok, true, interrupted.error);
      const interrupt = calls.find((call) => call.method === "interrupt");
      assert.ok(interrupt, "interrupt was not called");
      assert.deepEqual(interrupt.args, [taskId]);

      const fetched = await executeCommand({
        id: `fetch-${kind}`,
        kind: "fetchMessages",
        fetchMessages: { taskId, limit: 20 },
      });
      assert.equal(fetched.ok, true, fetched.error);
      assert.deepEqual(reads, [`${taskId}:20`]);
      const stored = busStore.messagesFor(taskId);
      assert.ok(stored, "messages were not emitted");
      assert.equal(stored.agentId, agentId);
      assert.equal(stored.hasMore, false);
      assert.equal(stored.messages.length, 1);
      assert.equal(stored.messages[0].text, "hello");

      const deleted = await executeCommand({
        id: `delete-${kind}`,
        kind: "deleteTask",
        deleteTask: { taskId },
      });
      assert.equal(deleted.ok, true, deleted.error);
      assert.ok(calls.some((call) => call.method === "deleteTask"));
    });
  }

  test("an unresolvable attachment fails explicitly instead of being dropped", async () => {
    reset();
    const calls: Call[] = [];
    installFake("codex", calls, []);
    useAgents([specFor("codex")]);
    const started = await executeCommand({
      id: "start-image",
      kind: "startTask",
      startTask: {
        source: "codex",
        projectPath: projectDir,
        prompt: "see this",
        // 旧协议形状：没有 artifactId，本机缓存里也没有对应的图。
        attachments: [{ type: "image", mimeType: "image/png", base64: "AAAA", name: "a.png" }],
      },
    });
    assert.equal(started.ok, false);
    assert.match(started.error ?? "", /^附件已过期或不存在：/);
    assert.equal(calls.some((call) => call.method === "start"), false);
  });

  test("a bare id returned by a connector is normalized to <kind>:<native>", async () => {
    reset();
    const readers: Partial<Record<DedicatedKind, DedicatedReaderFactory>> = {};
    const connectors: Partial<Record<DedicatedKind, DedicatedConnectorFactory>> = {};
    connectors.claude = () => ({
      kind: "claude",
      runsUnderBotBus: true,
      async start() {
        return { taskId: "native-claude", retainsLiveOwnership: true };
      },
      async followUp() {
        return { taskId: "native-claude", retainsLiveOwnership: true };
      },
      async approve() {
        return { taskId: "native-claude", retainsLiveOwnership: true };
      },
      async interrupt() {
        return { taskId: "native-claude", retainsLiveOwnership: true };
      },
    });
    readers.claude = () => fakeReader("claude", []);
    setDedicatedFactories({ connectors, readers });
    useAgents([specFor("claude")]);
    const started = await executeCommand({
      id: "start-bare",
      kind: "startTask",
      startTask: { source: "claude", projectPath: projectDir, prompt: "hello" },
    });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.taskId, "claude:native-claude");
  });

  test("an unavailable connector rejects start with its probe error", async () => {
    reset();
    const calls: Call[] = [];
    installFake("hermes", calls, []);
    useAgents([
      {
        ...specFor("hermes"),
        available: false,
        executable: undefined,
        lastError: "本机未检测到 Hermes",
        status: "degraded",
      },
    ]);
    const started = await executeCommand({
      id: "start-unavailable",
      kind: "startTask",
      startTask: { source: "hermes", projectPath: projectDir, prompt: "hello" },
    });
    assert.equal(started.ok, false);
    assert.equal(started.error, "本机未检测到 Hermes");
    assert.equal(calls.some((call) => call.method === "start"), false);
  });

  test("taskCount counts dedicated task.source and keeps ACP by connectorId", () => {
    reset();
    useAgents([
      specFor("codex"),
      specFor("openclaw"),
      {
        id: "my-agent",
        kind: "acp",
        name: "My Agent",
        executable: "C:/fake/acp.exe",
        args: [],
        env: {},
        origin: "manifest",
        available: true,
        enabled: true,
      },
    ]);
    const task = (id: string, source: string, connectorId?: string): BusTask => ({
      id,
      agentId,
      source,
      ...(connectorId ? { connectorId } : {}),
      title: id,
      projectPath: "",
      projectName: "",
      status: "completed",
      origin: "watch",
      controllable: true,
      startedAt: "2026-10-30T00:00:00Z",
      updatedAt: "2026-10-30T00:00:00Z",
    });
    busStore.upsertTask(task("codex:a", "codex"));
    busStore.upsertTask(task("codex:b", "codex"));
    busStore.upsertTask(task("openclaw:agent:main:main", "openclaw"));
    busStore.upsertTask(task("acp:my-agent:s1", "acp", "my-agent"));
    busStore.upsertTask(task("dsh:s1", "dsh"));
    const connectors = (
      busStore.snapshot().agents as Array<{
        connectors: Array<{ kind: string; connectorId?: string; taskCount: number }>;
      }>
    )[0].connectors;
    const byKind = new Map(connectors.map((item) => [item.kind, item]));
    assert.equal(byKind.get("codex")?.taskCount, 2);
    assert.equal(byKind.get("openclaw")?.taskCount, 1);
    assert.equal(byKind.get("acp")?.taskCount, 1);
    assert.equal(byKind.get("acp")?.connectorId, "my-agent");
    assert.equal(byKind.get("codex")?.connectorId, undefined);
  });

  test("model list changes are reported on ListedAgent and broadcast a snapshot", () => {
    reset();
    installFake("codex", [], []);
    useAgents([specFor("codex")]);
    const snapshots: string[] = [];
    const unsubscribe = busStore.subscribe((event) => {
      if (event.kind === "snapshot") snapshots.push(event.snapshot?.generatedAt as string);
    });

    const hooks = dedicatedConnectorHooks("codex");
    const models = [
      { id: "gpt-6.1", displayName: "GPT 6.1", efforts: ["low", "high"], defaultEffort: "high" },
    ];
    assert.equal(hooks.setModels(models), true);
    assert.equal(hooks.setModels(models), false, "unchanged list must not announce twice");
    assert.deepEqual(hooks.models(), models);
    assert.equal(snapshots.length, 1);
    const codex = snapshotConnectors().find((item) => item.kind === "codex");
    assert.deepEqual(codex?.models, models);

    assert.equal(hooks.setModels([]), true);
    assert.equal(hooks.models(), undefined);
    assert.equal(
      snapshotConnectors().find((item) => item.kind === "codex")?.models,
      undefined,
    );
    unsubscribe();
  });

  test("autoApprove is written by startTask and cleared by followUp", async () => {
    reset();
    const calls: Call[] = [];
    installFake("codex", calls, []);
    useAgents([specFor("codex")]);
    const hooks = dedicatedConnectorHooks("codex");

    const started = await executeCommand({
      id: "start-auto-approve",
      kind: "startTask",
      startTask: {
        source: "codex",
        projectPath: projectDir,
        prompt: "hello",
        autoApprove: true,
      },
    });
    assert.equal(started.ok, true, started.error);
    assert.equal(hooks.autoApproves(started.taskId!, projectDir), true);
    // 末尾多一个分隔符也应命中同一个项目
    assert.equal(hooks.autoApproves(started.taskId!, projectDir + (projectDir.includes("\\") ? "\\" : "/")), true);

    const followed = await executeCommand({
      id: "follow-auto-approve-off",
      kind: "followUp",
      followUp: { taskId: started.taskId!, prompt: "again", autoApprove: false },
    });
    assert.equal(followed.ok, true, followed.error);
    assert.equal(hooks.autoApproves(started.taskId!, projectDir), false);
  });

  test("autoApprove outside a project and on unsupported connectors fails explicitly", async () => {
    reset();
    installFake("codex", [], []);
    installFake("hermes", [], []);
    useAgents([specFor("codex"), specFor("hermes")]);

    const outside = await executeCommand({
      id: "start-auto-approve-outside",
      kind: "startTask",
      startTask: { source: "codex", projectPath: "", prompt: "hello", autoApprove: true },
    });
    assert.equal(outside.ok, false);
    assert.equal(outside.error, "auto approve is not available outside a project");

    const unsupported = await executeCommand({
      id: "start-auto-approve-hermes",
      kind: "startTask",
      startTask: { source: "hermes", projectPath: projectDir, prompt: "hello", autoApprove: true },
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, "this agent does not support auto approve");
  });

  test("canAutoApprove is only reported by codex and claude", () => {
    reset();
    useAgents(DEDICATED_KINDS.map((kind) => specFor(kind)));
    const byKind = new Map(snapshotConnectors().map((item) => [item.kind, item]));
    assert.equal(byKind.get("codex")?.canAutoApprove, true);
    assert.equal(byKind.get("claude")?.canAutoApprove, true);
    for (const kind of ["hermes", "pi", "openclaw"] as const) {
      assert.equal(byKind.get(kind)?.canAutoApprove, undefined, kind);
    }
  });

  test("disabling a connector rejects commands until it is re-enabled", async () => {
    reset();
    const calls: Call[] = [];
    installFake("codex", calls, []);
    useAgents([specFor("codex")]);

    const started = await executeCommand({
      id: "start-before-disable",
      kind: "startTask",
      startTask: { source: "codex", projectPath: projectDir, prompt: "hello" },
    });
    assert.equal(started.ok, true, started.error);

    const disabled = await executeCommand({
      id: "disable-codex",
      kind: "setConnectorEnabled",
      setConnectorEnabled: { connector: "codex", enabled: false },
    });
    assert.equal(disabled.ok, true, disabled.error);
    const listed = snapshotConnectors().find((item) => item.kind === "codex");
    assert.equal(listed?.enabled, false);

    const followUp = await executeCommand({
      id: "follow-disabled",
      kind: "followUp",
      followUp: { taskId: started.taskId!, prompt: "again" },
    });
    assert.equal(followUp.ok, false);
    assert.match(followUp.error ?? "", /disabled/);
    const start = await executeCommand({
      id: "start-disabled",
      kind: "startTask",
      startTask: { source: "codex", projectPath: projectDir, prompt: "hello" },
    });
    assert.equal(start.ok, false);
    assert.match(start.error ?? "", /disabled/);
    const fetch = await executeCommand({
      id: "fetch-disabled",
      kind: "fetchMessages",
      fetchMessages: { taskId: started.taskId! },
    });
    assert.equal(fetch.ok, false);
    assert.match(fetch.error ?? "", /disabled/);
    assert.equal(calls.filter((call) => call.method === "followUp").length, 0);

    const enabled = await executeCommand({
      id: "enable-codex",
      kind: "setConnectorEnabled",
      setConnectorEnabled: { connector: "codex", enabled: true },
    });
    assert.equal(enabled.ok, true, enabled.error);
    const followAfter = await executeCommand({
      id: "follow-enabled",
      kind: "followUp",
      followUp: { taskId: started.taskId!, prompt: "again" },
    });
    assert.equal(followAfter.ok, true, followAfter.error);
  });

  test("restartConnector destroys and rebuilds the connector instance", async () => {
    reset();
    let built = 0;
    let stopped = 0;
    const calls: Call[] = [];
    const connectors: Partial<Record<DedicatedKind, DedicatedConnectorFactory>> = {
      codex: () => {
        built += 1;
        const connector = fakeConnector("codex", calls) as TaskConnector & { stop?: () => void };
        connector.stop = () => {
          stopped += 1;
        };
        return connector;
      },
    };
    setDedicatedFactories({ connectors, readers: { codex: () => fakeReader("codex", []) } });
    useAgents([specFor("codex")]);

    const started = await executeCommand({
      id: "start-before-restart",
      kind: "startTask",
      startTask: { source: "codex", projectPath: projectDir, prompt: "hello" },
    });
    assert.equal(started.ok, true, started.error);
    assert.equal(built, 1);

    const restarted = await executeCommand({
      id: "restart-codex",
      kind: "restartConnector",
      restartConnector: { connector: "codex" },
    });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(stopped, 1);
    assert.equal(built, 2);
    assert.equal(snapshotConnectors().find((item) => item.kind === "codex")?.enabled, true);
  });
});

describe("dedicated discovery", { concurrency: false }, () => {
  test("the five dedicated connectors are listed and OpenClaw is off by default", async () => {
    const descriptors: DedicatedDescriptor[] = DEDICATED_KINDS.map((kind) => ({
      kind,
      id: kind,
      name: kind,
      executable: `C:/fake/${kind}.exe`,
      available: true,
      enabled: kind !== "openclaw",
      origin: "dedicated",
      status: "ok",
    }));
    const found = await discoverAgents({
      manifestDir: join(tmpdir(), "missing-agents-dir-dedicated"),
      entries: [],
      locate: () => undefined,
      dshExecutable: "",
      descriptors,
    });
    const dedicated = found.agents.filter((agent) => agent.origin === "dedicated");
    assert.deepEqual(
      dedicated.map((agent) => agent.kind),
      [...DEDICATED_KINDS],
    );
    assert.equal(dedicated.find((agent) => agent.kind === "openclaw")?.enabled, false);
    assert.equal(dedicated.find((agent) => agent.kind === "codex")?.enabled, true);
  });

  test("ACP adapters of the same agents are not listed twice", async () => {
    const descriptors: DedicatedDescriptor[] = DEDICATED_KINDS.map((kind) => ({
      kind,
      id: kind,
      name: kind,
      executable: `C:/fake/${kind}.exe`,
      available: true,
      enabled: kind !== "openclaw",
      origin: "dedicated",
      status: "ok",
    }));
    const found = await discoverAgents({
      manifestDir: join(tmpdir(), "missing-agents-dir-adapters"),
      entries: [
        { id: "codex-acp", name: "Codex ACP", binaries: ["codex-acp"], args: [] },
        { id: "claude-acp", name: "Claude ACP", binaries: ["claude-acp"], args: [] },
        { id: "pi-acp", name: "Pi ACP", binaries: ["pi-acp"], args: [] },
      ],
      // 适配器在 PATH 上确实存在，但不应再出现第二张卡片。
      locate: (name) => `C:/tools/${name}`,
      dshExecutable: "",
      descriptors,
    });
    for (const id of ["codex-acp", "claude-acp", "pi-acp"]) {
      assert.equal(found.agents.some((agent) => agent.id === id), false, `${id} was listed`);
    }
    assert.equal(new Set(found.agents.map((agent) => agent.id)).size, found.agents.length);
  });

  test("a second phone approving an already handled request is not an error", async () => {
    reset();
    installFake("hermes", [], []);
    useAgents([specFor("hermes")]);
    let approvals = 0;
    setDedicatedFactories({
      connectors: {
        hermes: () => ({
          ...fakeConnector("hermes", []),
          async approve() {
            approvals += 1;
            if (approvals === 1) return { taskId: "hermes:native-1", retainsLiveOwnership: true };
            throw new Error("没有待审批的请求（可能已经处理过了）");
          },
        }),
      },
    });
    const command = {
      kind: "approve" as const,
      approve: {
        taskId: "hermes:native-1",
        requestId: "req-1",
        decision: "allow" as const,
      },
    };
    const first = await executeCommand({ id: "approve-first", ...command });
    assert.equal(first.ok, true, first.error);
    const second = await executeCommand({ id: "approve-second", ...command });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.taskId, "hermes:native-1");
  });
});
