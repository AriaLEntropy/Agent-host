import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TaskStore, type BusTask } from "../../src/bus/store.js";

const root = mkdtempSync(join(tmpdir(), "agent-host-pending-"));
after(() => rmSync(root, { recursive: true, force: true }));

function task(id: string, pending: boolean): BusTask {
  return {
    id,
    agentId: "agent-1",
    source: "codex",
    title: `任务 ${id}`,
    projectPath: "C:/Work/Demo",
    projectName: "Demo",
    status: pending ? "waitingApproval" : "running",
    origin: "phone",
    controllable: true,
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...(pending
      ? {
          pendingRequest: {
            id: `req-${id}`,
            kind: "command" as const,
            summary: "请求执行命令",
          },
        }
      : {}),
  };
}

test("pendingRequestCount only counts tasks waiting for approval or reply", () => {
  const store = new TaskStore();
  store.configureProjectDismissals(join(root, "removed-projects.json"));
  store.upsertTask(task("a", true), false);
  store.upsertTask(task("b", false), false);
  store.upsertTask(task("c", true), false);
  assert.equal(store.pendingRequestCount(), 2);

  // 答复后 pendingRequest 被移除，角标跟着归零
  store.upsertTask(task("a", false), false);
  assert.equal(store.pendingRequestCount(), 1);
});
