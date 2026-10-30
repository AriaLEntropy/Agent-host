import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import type { BusTask } from "../../src/bus/store.js";
import { busStore } from "../../src/bus/store.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import {
  executeCommand,
  resetRuntime,
  useAgents,
} from "../../src/connectors/runtime.js";

const agentId = "removeProjectTestHost";

const directory = mkdtempSync(join(tmpdir(), "agent-host-remove-project-"));
const dismissalsPath = join(directory, "removed-projects.json");
// 在任何 store 可见性查询之前指定临时文件，绝不碰真实 %APPDATA%。
process.env.AGENT_HOST_REMOVED_PROJECTS = dismissalsPath;

after(() => rmSync(directory, { recursive: true, force: true }));

afterEach(() => {
  resetRuntime();
  busStore.reset();
  rmSync(dismissalsPath, { force: true });
});

function spec(kind: "codex" | "claude" = "codex"): AgentSpec {
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
  };
}

function makeTask(id: string, overrides: Partial<BusTask> = {}): BusTask {
  return {
    id,
    agentId,
    source: "codex",
    title: id,
    projectPath: "C:/Work/Demo",
    projectName: "Demo",
    status: "completed",
    lastMessage: "done",
    origin: "watch",
    controllable: true,
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

let commandSeq = 0;
function removeProject(projectPath: unknown) {
  commandSeq += 1;
  return executeCommand({
    id: `remove-${commandSeq}`,
    createdAt: "2026-10-30T00:00:00.000Z",
    agentId,
    kind: "removeProject",
    removeProject: { projectPath },
  });
}

type Snapshot = {
  agents: Array<Record<string, unknown>>;
  tasks: BusTask[];
  projects: Array<Record<string, unknown>>;
};

function snapshot(): Snapshot {
  return busStore.snapshot() as unknown as Snapshot;
}

function visibleTaskIds(): string[] {
  return snapshot().tasks.map((task) => task.id).sort();
}

describe("removeProject (protocol 3.8)", { concurrency: false }, () => {
  test("the host advertises canRemoveProjects and keeps canDeleteTasks", () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    const host = snapshot().agents[0];
    assert.equal(host.canRemoveProjects, true);
    const connectors = host.connectors as Array<Record<string, unknown>>;
    assert.equal(connectors[0].canDeleteTasks, true);
  });

  test("removes a known project and all of its tasks from the visible snapshot", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    busStore.rememberProject({
      agentId,
      path: "C:/Work/Demo",
      name: "Demo",
      lastUsedAt: "2026-10-02T00:00:00.000Z",
      pinned: false,
    });
    busStore.upsertTask(makeTask("codex:demo"));
    busStore.upsertTask(makeTask("codex:other", { projectPath: "C:/Work/Other", projectName: "Other" }));

    const before = snapshot();
    assert.deepEqual(before.tasks.map((task) => task.id).sort(), ["codex:demo", "codex:other"]);
    assert.equal(before.projects.length, 1);
    assert.equal((before.agents[0].connectors as Array<Record<string, unknown>>)[0].taskCount, 2);

    // 命令里的路径写法不要求与记录完全一致。
    const result = await removeProject("C:\\Work\\Demo\\");
    assert.equal(result.ok, true);

    const after = snapshot();
    assert.deepEqual(after.tasks.map((task) => task.id), ["codex:other"]);
    assert.equal(after.projects.length, 0);
    // taskCount 只数可见任务。
    assert.equal((after.agents[0].connectors as Array<Record<string, unknown>>)[0].taskCount, 1);
    // 任务内部仍在，只是不可见。
    assert.notEqual(busStore.taskById("codex:demo"), undefined);
  });

  test("a project that only exists because of its tasks can be removed", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    busStore.upsertTask(makeTask("codex:derived"));

    const result = await removeProject("C:/Work/Demo");
    assert.equal(result.ok, true);
    assert.deepEqual(visibleTaskIds(), []);
  });

  test("an unknown project fails with the upstream message", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);

    const result = await removeProject("C:/No/Such/Project");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /本机没有这个项目/);
  });

  test("removing the same project twice succeeds", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    busStore.upsertTask(makeTask("codex:demo"));

    assert.equal((await removeProject("C:/Work/Demo")).ok, true);
    assert.equal((await removeProject("C:/Work/Demo")).ok, true);
    assert.deepEqual(visibleTaskIds(), []);
  });

  test("a task outside any project is not removable", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    busStore.upsertTask(
      makeTask("codex:outside", { projectPath: "C:/Outside", projectName: "", outsideProject: true }),
    );

    const result = await removeProject("C:/Outside");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /本机没有这个项目/);
    assert.deepEqual(visibleTaskIds(), ["codex:outside"]);
  });

  test("a missing projectPath is rejected", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);

    const result = await removeProject("");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /projectPath is missing/);
  });

  test("a new task in the project makes the project and its tasks visible again", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    busStore.rememberProject({
      agentId,
      path: "C:/Work/Demo",
      name: "Demo",
      lastUsedAt: "2026-10-02T00:00:00.000Z",
      pinned: false,
    });
    busStore.upsertTask(makeTask("codex:demo"));
    assert.equal((await removeProject("C:/Work/Demo")).ok, true);
    assert.deepEqual(visibleTaskIds(), []);
    assert.equal(snapshot().projects.length, 0);

    busStore.upsertTask(
      makeTask("codex:new", {
        status: "running",
        startedAt: "2999-01-01T00:00:00.000Z",
        updatedAt: "2999-01-01T00:00:00.000Z",
        lastMessage: "new activity",
      }),
    );

    // dismissal 被恢复：项目与同项目的旧任务都重新出现。
    assert.deepEqual(visibleTaskIds(), ["codex:demo", "codex:new"]);
    assert.equal(snapshot().projects.length, 1);
  });

  test("new activity on an existing hidden task makes it visible again", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    busStore.upsertTask(makeTask("codex:demo"));
    assert.equal((await removeProject("C:/Work/Demo")).ok, true);

    busStore.upsertTask(
      makeTask("codex:demo", {
        updatedAt: "2026-10-05T00:00:00.000Z",
        lastMessage: "a newer message",
      }),
    );

    assert.deepEqual(visibleTaskIds(), ["codex:demo"]);
  });

  test("a silent baseline upsert still publishes a snapshot when it restores a project", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    busStore.upsertTask(makeTask("codex:demo"));
    assert.equal((await removeProject("C:/Work/Demo")).ok, true);

    const events: string[] = [];
    const unsubscribe = busStore.subscribe((event) => events.push(event.kind));
    try {
      busStore.upsertTask(
        makeTask("codex:new", {
          startedAt: "2999-01-01T00:00:00.000Z",
          updatedAt: "2999-01-01T00:00:00.000Z",
        }),
        false,
      );
    } finally {
      unsubscribe();
    }
    assert.deepEqual(events, ["snapshot"]);
    assert.deepEqual(visibleTaskIds(), ["codex:demo", "codex:new"]);
  });

  test("removing a project never touches the filesystem", async () => {
    busStore.identify({ agentId, hostName: "h", platform: "windows" });
    useAgents([spec("codex")]);
    const projectDir = join(directory, "project-fixture");
    mkdirSync(projectDir, { recursive: true });
    const sentinel = join(projectDir, "keep-me.txt");
    writeFileSync(sentinel, "precious");
    busStore.upsertTask(makeTask("codex:demo", { projectPath: projectDir, projectName: "project-fixture" }));

    assert.equal((await removeProject(projectDir)).ok, true);
    assert.equal(existsSync(projectDir), true);
    assert.equal(existsSync(sentinel), true);
    assert.notEqual(busStore.taskById("codex:demo"), undefined);
  });
});
