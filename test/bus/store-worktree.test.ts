import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { busStore, type BusTask } from "../../src/bus/store.js";
import { WorktreeResolver } from "../../src/bus/worktree.js";
import { platformPath } from "../../src/platform/path.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";

function task(overrides: Partial<BusTask> = {}): BusTask {
  return {
    id: "codex:one",
    agentId,
    source: "codex",
    title: "demo",
    projectPath: "C:/work/plain",
    projectName: "plain",
    status: "completed",
    origin: "watch",
    controllable: true,
    startedAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T11:00:00.000Z",
    ...overrides,
  };
}

const WINDOWS = platformPath.platform === "win32";
const worktreePath = WINDOWS
  ? "C:/Repo/.claude/worktrees/feature"
  : "/repo/.claude/worktrees/feature";
const repositoryPath = WINDOWS ? "C:\\Repo" : "/repo";
const canonicalWorktree = WINDOWS
  ? "C:\\Repo\\.claude\\worktrees\\feature"
  : "/repo/.claude/worktrees/feature";

beforeEach(() => {
  busStore.reset();
  busStore.identify({ agentId, hostName: "Agent Host", hostVersion: "1.0.0", platform: "windows" });
});

describe("store worktree stamping (protocol 2.7)", { concurrency: false }, () => {
  test("a task inside a worktree is grouped under the main repository and keeps the real cwd", () => {
    busStore.configureWorktreeResolver(new WorktreeResolver({ archivePath: null }));
    busStore.upsertTask(task({ projectPath: worktreePath, projectName: "feature" }));

    const stamped = busStore.taskById("codex:one")!;
    assert.equal(stamped.projectPath, repositoryPath);
    assert.equal(stamped.projectName, "Repo");
    assert.equal(stamped.worktreePath, canonicalWorktree);
  });

  test("stamping is idempotent when the already-stamped task is upserted again", () => {
    busStore.configureWorktreeResolver(new WorktreeResolver({ archivePath: null }));
    busStore.upsertTask(task({ projectPath: worktreePath, projectName: "feature" }));
    const first = busStore.taskById("codex:one")!;

    busStore.upsertTask({ ...first, status: "running" });
    const second = busStore.taskById("codex:one")!;
    assert.equal(second.projectPath, first.projectPath);
    assert.equal(second.projectName, first.projectName);
    assert.equal(second.worktreePath, first.worktreePath);
    assert.equal(second.status, "running");
  });

  test("ordinary project paths never reach the resolver", () => {
    let calls = 0;
    busStore.configureWorktreeResolver({
      projectRoot() {
        calls += 1;
        return null;
      },
    });
    busStore.upsertTask(task());
    assert.equal(calls, 0);
    assert.equal(busStore.taskById("codex:one")?.worktreePath, undefined);
  });

  test("configureWorktreeResolver(null) disables the rewrite", () => {
    busStore.configureWorktreeResolver(null);
    busStore.upsertTask(task({ projectPath: worktreePath, projectName: "feature" }));
    const untouched = busStore.taskById("codex:one")!;
    assert.equal(untouched.projectPath, worktreePath);
    assert.equal(untouched.worktreePath, undefined);
  });

  test("Windows accepts both separators and a worktree subdirectory", (t) => {
    if (!WINDOWS) {
      t.skip("Windows-only path spelling");
      return;
    }
    busStore.configureWorktreeResolver(new WorktreeResolver({ archivePath: null }));
    busStore.upsertTask(
      task({
        id: "codex:two",
        projectPath: "C:\\Repo/.claude\\worktrees/feature/web",
        projectName: "feature",
      }),
    );
    const stamped = busStore.taskById("codex:two")!;
    assert.equal(stamped.projectPath, "C:\\Repo\\web");
    assert.equal(stamped.worktreePath, "C:\\Repo\\.claude\\worktrees\\feature\\web");
  });
});
