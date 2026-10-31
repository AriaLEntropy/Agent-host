import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { busStore, type BusTask } from "../../src/bus/store.js";
import {
  configureAcpSessionArchive,
  flushAcpSessionArchive,
  installAcpSessionArchiveHooks,
  resetAcpArchiveHydration,
  restoreArchivedAcpTasks,
} from "../../src/connectors/acp/runtime-archive.js";
import { AcpSessionArchive } from "../../src/connectors/acp/session-archive.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";
const NOW = new Date();
const roots: string[] = [];

function isoAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3600 * 1000).toISOString();
}

function task(id: string, overrides: Partial<BusTask> = {}): BusTask {
  return {
    id,
    agentId,
    source: "acp",
    connectorId: "gemini",
    title: "demo task",
    projectPath: "C:/work/demo",
    projectName: "demo",
    status: "completed",
    origin: "watch",
    controllable: true,
    startedAt: isoAgo(2),
    updatedAt: isoAgo(1),
    ...overrides,
  };
}

async function freshArchive(): Promise<{ directory: string; archive: AcpSessionArchive }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-runtime-archive-"));
  roots.push(directory);
  const archive = new AcpSessionArchive({ path: join(directory, "acp-sessions.json"), now: () => NOW });
  configureAcpSessionArchive(archive);
  resetAcpArchiveHydration();
  installAcpSessionArchiveHooks();
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
  return { directory, archive };
}

beforeEach(() => {
  stopArchiveState();
});

afterEach(async () => {
  await flushAcpSessionArchive();
  stopArchiveState();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

function stopArchiveState() {
  configureAcpSessionArchive(null);
  busStore.reset();
}

describe("ACP session archive runtime wiring", { concurrency: false }, () => {
  test("only watch-origin ACP tasks are remembered, and conversation fields are stripped", async () => {
    const { archive } = await freshArchive();

    busStore.upsertTask(
      task("acp:gemini:watch-1", {
        lastMessage: "secret reply",
        pendingRequest: { id: "r1", kind: "command", summary: "rm -rf" },
      }),
    );
    busStore.upsertTask(task("acp:gemini:desktop-1", { origin: "desktop" }));
    busStore.upsertTask(task("codex:native-1", { source: "codex", connectorId: undefined }));
    await flushAcpSessionArchive();

    const records = await archive.records("gemini");
    assert.deepEqual(records.map((entry) => entry.id), ["acp:gemini:watch-1"]);
    const record = records[0]!;
    assert.equal(record.title, "demo task");
    assert.equal("lastMessage" in record, false);
    assert.equal("pendingRequest" in record, false);
  });

  test("deleting a task forgets it, including a remember that was still queued", async () => {
    const { archive } = await freshArchive();

    // 先落一条，再制造一条还在去抖窗口里的 remember。
    busStore.upsertTask(task("acp:gemini:old"));
    await flushAcpSessionArchive();
    busStore.upsertTask(task("acp:gemini:pending"));
    busStore.removeTask("acp:gemini:pending");
    busStore.removeTask("acp:gemini:old");
    await flushAcpSessionArchive();

    assert.deepEqual(await archive.records("gemini"), []);
  });

  test("startup merge restores only missing tasks and never invents messages", async () => {
    const { archive } = await freshArchive();
    const projectPath = "C:/work/demo";
    const base = {
      projectPath,
      projectName: "demo",
      startedAt: isoAgo(3),
      agentId,
      source: "acp",
      origin: "watch",
      controllable: true,
    };
    await archive.remember("gemini", {
      ...base,
      id: "acp:gemini:persisted",
      title: "archived title",
      status: "completed",
      updatedAt: isoAgo(1),
    });
    await archive.remember("gemini", {
      ...base,
      id: "acp:gemini:interrupted",
      title: "approval was open",
      status: "waitingApproval",
      updatedAt: isoAgo(1),
    });
    await archive.remember("gemini", {
      ...base,
      id: "acp:gemini:stale",
      title: "old task",
      status: "completed",
      updatedAt: isoAgo(48),
    });

    // bus-state 里已有的同 id 任务：更新、且不能被归档覆盖。
    busStore.upsertTask(
      task("acp:gemini:persisted", {
        origin: "desktop",
        title: "persisted title",
        status: "completed",
        updatedAt: isoAgo(0.5),
      }),
    );

    const result = await restoreArchivedAcpTasks(["gemini"]);
    assert.equal(result.restored, 2);
    assert.equal(result.skipped, 1);

    assert.equal(busStore.taskById("acp:gemini:persisted")?.title, "persisted title");
    const interrupted = busStore.taskById("acp:gemini:interrupted");
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(interrupted?.controllable, false);
    assert.equal(interrupted?.lastMessage, undefined);
    assert.equal(interrupted?.pendingRequest, undefined);
    assert.equal(busStore.messagesFor("acp:gemini:interrupted"), undefined);

    assert.equal(busStore.taskById("acp:gemini:stale")?.status, "idle");
    assert.equal(busStore.messagesFor("acp:gemini:stale"), undefined);

    // 再调一次：启动合并只跑一次，不会把已删除的任务重新复活。
    busStore.removeTask("acp:gemini:interrupted");
    const again = await restoreArchivedAcpTasks(["gemini"]);
    assert.deepEqual(again, { restored: 0, skipped: 0, failed: 0 });
    assert.equal(busStore.taskById("acp:gemini:interrupted"), undefined);
  });

  test("archived tasks for connectors that are no longer discovered stay out", async () => {
    const { archive } = await freshArchive();
    await archive.remember("retired", {
      id: "acp:retired:s1",
      title: "old agent",
      projectPath: "C:/work/demo",
      projectName: "demo",
      status: "completed",
      startedAt: isoAgo(2),
      updatedAt: isoAgo(1),
    });

    const result = await restoreArchivedAcpTasks([]);
    assert.deepEqual(result, { restored: 0, skipped: 0, failed: 0 });
    assert.equal(busStore.taskById("acp:retired:s1"), undefined);
  });
});
