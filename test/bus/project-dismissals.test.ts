import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  fingerprint64,
  messageFingerprint,
  ProjectDismissals,
  removedProjectsPath,
  type DismissibleTask,
} from "../../src/bus/project-dismissals.js";
import { normalizeProjectPath } from "../../src/bus/project-path.js";

const roots: string[] = [];
function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `agent-host-${label}-`));
  roots.push(directory);
  return directory;
}

after(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

const agentId = "agent-1";

function memoryDismissals(label: string): ProjectDismissals {
  return new ProjectDismissals({ path: join(tempDir(label), "removed-projects.json") });
}

function task(overrides: Partial<DismissibleTask> = {}): DismissibleTask {
  return {
    id: "codex:a",
    agentId,
    projectPath: "C:/Work/Demo",
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    lastMessage: "hello",
    ...overrides,
  };
}

describe("project dismissals (protocol 3.8)", () => {
  test("activity fingerprint matches FNV-1a 64 and changes with the message", () => {
    assert.equal(fingerprint64(""), 14695981039346656037n);
    assert.equal(fingerprint64("hello"), 11831194018420276491n);
    assert.equal(messageFingerprint("hello"), Number(11831194018420276491n));
    assert.notEqual(messageFingerprint("hello"), messageFingerprint("hello!"));
  });

  test("dismissProject records activities and cutoff, ignoring outsideProject tasks", () => {
    const directory = tempDir("dismiss-record");
    const dismissals = new ProjectDismissals({ path: join(directory, "removed-projects.json") });
    const related = task({ id: "codex:a", updatedAt: "2026-10-03T00:00:00.000Z", lastMessage: "a" });
    const newer = task({ id: "codex:b", updatedAt: "2026-10-05T00:00:00.000Z", lastMessage: "b" });
    const outside = task({ id: "codex:out", outsideProject: true, updatedAt: "2026-10-09T00:00:00.000Z" });

    dismissals.dismissProject(agentId, "C:\\Work\\Demo\\", [related, newer, outside], "2026-10-04T00:00:00.000Z");

    const [entry] = dismissals.projects;
    assert.equal(entry.agentId, agentId);
    assert.equal(entry.path, normalizeProjectPath("C:\\Work\\Demo\\"));
    assert.deepEqual(Object.keys(entry.activities).sort(), ["codex:a", "codex:b"]);
    assert.equal(entry.activities["codex:a"].updatedAt, "2026-10-03T00:00:00.000Z");
    // cutoff = max(lastUsedAt, related.updatedAt.max)
    assert.equal(entry.cutoff, "2026-10-05T00:00:00.000Z");
    assert.equal(dismissals.hides(related), true);
    assert.equal(dismissals.hides(outside), false);
    assert.equal(dismissals.hidesProject(agentId, "c:/work/demo"), process.platform === "win32");
  });

  test("reconcile keeps unchanged tasks hidden and restores on newer or changed activity", () => {
    const unchanged = memoryDismissals("reconcile-unchanged");
    const hidden = task({ updatedAt: "2026-10-03T00:00:00.000Z", lastMessage: "one", startedAt: "2026-10-01T00:00:00.000Z" });
    unchanged.dismissProject(agentId, hidden.projectPath, [hidden], "2026-10-03T00:00:00.000Z");
    assert.equal(unchanged.reconcile([hidden]), false);
    assert.equal(unchanged.projects.length, 1);

    const sameTime = memoryDismissals("reconcile-sametime");
    sameTime.dismissProject(agentId, hidden.projectPath, [hidden], "2026-10-03T00:00:00.000Z");
    assert.equal(sameTime.reconcile([{ ...hidden, lastMessage: "two" }]), true);
    assert.equal(sameTime.projects.length, 0);

    const newer = memoryDismissals("reconcile-newer");
    newer.dismissProject(agentId, hidden.projectPath, [hidden], "2026-10-03T00:00:00.000Z");
    assert.equal(newer.reconcile([{ ...hidden, updatedAt: "2026-10-04T00:00:00.000Z" }]), true);
    assert.equal(newer.hides(hidden), false);
  });

  test("a new task only restores when startedAt and updatedAt are not older than cutoff", () => {
    const dismissals = memoryDismissals("reconcile-cutoff");
    dismissals.dismissProject(agentId, "C:/Work/Demo", [task()], "2026-10-02T00:00:00.000Z");

    const old = task({ id: "codex:old", startedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" });
    assert.equal(dismissals.reconcile([old]), false);
    assert.equal(dismissals.hides(old), true);

    const fresh = task({ id: "codex:new", startedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" });
    assert.equal(dismissals.reconcile([fresh]), true);
    assert.equal(dismissals.projects.length, 0);
  });

  test("persists and reloads the activity baseline; reset clears memory but keeps the file", () => {
    const directory = tempDir("dismiss-persist");
    const path = join(directory, "removed-projects.json");
    const first = new ProjectDismissals({ path });
    first.dismissProject(agentId, "C:/Work/Demo", [task()], "2026-10-01T00:00:00.000Z");
    assert.equal(first.save(), true);

    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(raw.version, 1);
    assert.equal((raw.projects as unknown[]).length, 1);

    const second = new ProjectDismissals({ path });
    assert.deepEqual(second.projects, first.projects);
    assert.equal(second.hidesProject(agentId, "C:/Work/Demo"), true);

    second.reset();
    assert.equal(second.projects.length, 0);
    // reset 不删文件：重新换回同一路径还能读出来。
    second.configurePath(path);
    assert.equal(second.projects.length, 1);
  });

  test("a corrupt or unknown-version file loads as empty", () => {
    const directory = tempDir("dismiss-corrupt");
    const corrupt = join(directory, "corrupt.json");
    writeFileSync(corrupt, "{ not json");
    assert.deepEqual(new ProjectDismissals({ path: corrupt }).projects, []);

    const unknown = join(directory, "unknown.json");
    writeFileSync(unknown, JSON.stringify({ version: 2, projects: [] }));
    assert.deepEqual(new ProjectDismissals({ path: unknown }).projects, []);

    const missing = new ProjectDismissals({ path: join(directory, "missing.json") });
    assert.deepEqual(missing.projects, []);
  });

  test("save reports failure without destroying the previous file", () => {
    const directory = tempDir("dismiss-savefail");
    // 目标路径是个目录：rename 一定失败。
    const target = join(directory, "target");
    mkdirSync(target);
    const dismissals = new ProjectDismissals({ path: target });
    dismissals.dismissProject(agentId, "C:/Work/Demo", [task()], "2026-10-01T00:00:00.000Z");
    assert.equal(dismissals.save(), false);
    // 内存状态仍在，调用方可以决定回滚。
    assert.equal(dismissals.projects.length, 1);
  });

  test("removedProjectsPath honours the explicit path before the environment", () => {
    const previous = process.env.AGENT_HOST_REMOVED_PROJECTS;
    process.env.AGENT_HOST_REMOVED_PROJECTS = "C:/env/removed-projects.json";
    try {
      assert.equal(removedProjectsPath(), "C:/env/removed-projects.json");
      assert.equal(removedProjectsPath("C:/explicit/x.json"), "C:/explicit/x.json");
    } finally {
      if (previous === undefined) delete process.env.AGENT_HOST_REMOVED_PROJECTS;
      else process.env.AGENT_HOST_REMOVED_PROJECTS = previous;
    }
  });
});
