import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { busStore } from "../../src/bus/store.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import type {
  ConnectorOutcome,
  MessageReader,
  TaskConnector,
} from "../../src/connectors/ported/contract.js";
import {
  executeCommand,
  resetRuntime,
  setDedicatedFactories,
  useAgents,
} from "../../src/connectors/runtime.js";

const agentId = "deleteTaskTestHost";

type Kind = "codex" | "claude" | "hermes" | "pi" | "openclaw";

function spec(kind: Kind, overrides: Partial<AgentSpec> = {}): AgentSpec {
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

function fakeConnector(
  kind: Kind,
  onDelete?: (taskId: string) => void,
  withDelete = true,
): TaskConnector {
  const outcome: ConnectorOutcome = { taskId: `${kind}:native`, retainsLiveOwnership: true };
  const connector: TaskConnector = {
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
  if (withDelete) {
    connector.deleteTask = async (taskId: string) => {
      onDelete?.(taskId);
    };
  }
  return connector;
}

function fakeReader(kind: Kind): MessageReader {
  return {
    kind,
    async entries() {
      return { entries: [], hasMore: false };
    },
  };
}

function install(kind: Kind, connector: TaskConnector) {
  setDedicatedFactories({
    connectors: { [kind]: () => connector },
    readers: { [kind]: () => fakeReader(kind) },
  });
}

function task(taskId: string, kind: string, status: string) {
  return {
    id: taskId,
    agentId,
    source: kind,
    title: "t",
    projectPath: "C:/work",
    projectName: "work",
    status,
    origin: "watch",
    controllable: true,
    startedAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
  };
}

afterEach(() => {
  resetRuntime();
  busStore.reset();
});

describe("deleteTask capability and command", () => {
  test("reports canDeleteTasks only for codex and claude, and canRestartConnectors", () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex"), spec("claude"), spec("hermes"), spec("pi"), spec("openclaw")]);
    const host = (busStore.snapshot().agents as Array<Record<string, unknown>>)[0];
    const connectors = host.connectors as Array<Record<string, unknown>>;
    const byKind = new Map(connectors.map((item) => [item.kind, item]));
    assert.equal(byKind.get("codex")?.canDeleteTasks, true);
    assert.equal(byKind.get("claude")?.canDeleteTasks, true);
    assert.equal(byKind.get("hermes")?.canDeleteTasks, undefined);
    assert.equal(byKind.get("pi")?.canDeleteTasks, undefined);
    assert.equal(byKind.get("openclaw")?.canDeleteTasks, undefined);
    assert.equal(host.canRestartConnectors, true);
  });

  test("deletes a stopped task and removes it from the store", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    let deleted: string | undefined;
    install("codex", fakeConnector("codex", (taskId) => (deleted = taskId)));
    useAgents([spec("codex")]);
    busStore.upsertTask(task("codex:abc", "codex", "completed") as never);

    const result = await executeCommand({
      id: "delete-1",
      createdAt: "2026-10-30T00:00:00Z",
      agentId,
      kind: "deleteTask",
      deleteTask: { taskId: "codex:abc" },
    });
    assert.equal(result.ok, true);
    assert.equal(deleted, "codex:abc");
    assert.equal(busStore.taskById("codex:abc"), undefined);
  });

  test("rejects deleting a running task without calling the connector", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    let called = false;
    install("claude", fakeConnector("claude", () => (called = true)));
    useAgents([spec("claude")]);
    busStore.upsertTask(task("claude:def", "claude", "running") as never);

    const result = await executeCommand({
      id: "delete-2",
      createdAt: "2026-10-30T00:00:00Z",
      agentId,
      kind: "deleteTask",
      deleteTask: { taskId: "claude:def" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /还在进行中/);
    assert.equal(called, false);
    assert.notEqual(busStore.taskById("claude:def"), undefined);
  });

  test("a connector without deleteTask reports not supported", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    install("hermes", fakeConnector("hermes", undefined, false));
    useAgents([spec("hermes")]);
    busStore.upsertTask(task("hermes:ghi", "hermes", "completed") as never);

    const result = await executeCommand({
      id: "delete-3",
      createdAt: "2026-10-30T00:00:00Z",
      agentId,
      kind: "deleteTask",
      deleteTask: { taskId: "hermes:ghi" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not supported/);
  });
});
