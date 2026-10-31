import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  HIDDEN_TASK_LIMIT,
  HiddenTaskArchive,
  PHONE_TASK_LIMIT,
  PhoneTaskArchive,
  TASK_ARCHIVE_RETENTION_MS,
  hiddenTasksPath,
  loadHiddenTasks,
  loadPhoneTasks,
  phoneTasksPath,
  saveHiddenTasks,
  savePhoneTasks,
  trimHiddenTasks,
  trimPhoneTasks,
  trimTaskArchive,
} from "../../src/bus/task-archive.js";

const roots: string[] = [];
function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `agent-host-${label}-`));
  roots.push(directory);
  return directory;
}

after(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

const CLOCK = new Date("2026-10-01T12:00:00.000Z");

describe("hidden task archive (protocol 3.4 / FR-8.3)", () => {
  test("hide persists an ISO timestamp and reloads it", () => {
    const path = join(tempDir("hidden-roundtrip"), "nested", "hidden-tasks.json");
    const archive = new HiddenTaskArchive({ path, now: () => CLOCK });
    assert.equal(archive.hide("claude:a"), true);
    assert.equal(archive.timestamp("claude:a"), CLOCK.toISOString());

    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      tasks: { taskId: string; hiddenAt: string }[];
    };
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.tasks, [{ taskId: "claude:a", hiddenAt: CLOCK.toISOString() }]);

    const restarted = new HiddenTaskArchive({ path });
    assert.equal(restarted.has("claude:a"), true);
    assert.equal(restarted.timestamp("claude:a"), CLOCK.toISOString());
  });

  test("a corrupt or unexpected file loads as empty and can be replaced", () => {
    const directory = tempDir("hidden-corrupt");
    const path = join(directory, "hidden-tasks.json");
    writeFileSync(path, "{ not json");
    const archive = new HiddenTaskArchive({ path });
    assert.equal(archive.size, 0);
    assert.equal(archive.hide("claude:a"), true);

    writeFileSync(path, JSON.stringify({ version: "1", tasks: [] }));
    assert.equal(new HiddenTaskArchive({ path }).size, 0);

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        tasks: [
          { taskId: "", hiddenAt: "x" },
          { taskId: "claude:ok", hiddenAt: "2026-10-01T00:00:00.000Z" },
          { taskId: "claude:missing-time" },
        ],
      }),
    );
    const loaded = new HiddenTaskArchive({ path });
    assert.deepEqual(loaded.ids(), ["claude:ok"]);
  });

  test("save failures leave memory usable and do not damage the target", () => {
    const root = tempDir("hidden-savefail");
    const target = join(root, "target");
    mkdirSync(target);
    const archive = new HiddenTaskArchive({ path: target });
    assert.equal(archive.hide("claude:a"), false);
    assert.equal(archive.has("claude:a"), true);
    assert.deepEqual(readdirSync(root), ["target"]);
  });

  test("memory-only archives do not touch disk", () => {
    const archive = new HiddenTaskArchive({ path: null });
    assert.equal(archive.archivePath, null);
    assert.equal(archive.hide("claude:a"), true);
    assert.equal(archive.has("claude:a"), true);
  });

  test("upstream helpers round-trip and trim oldest first", () => {
    const path = join(tempDir("hidden-helpers"), "hidden-tasks.json");
    const tasks = { "claude:old": "2026-09-01T00:00:00.000Z", "claude:new": "2026-09-20T00:00:00.000Z" };
    assert.equal(saveHiddenTasks(tasks, path), true);
    assert.deepEqual(loadHiddenTasks(path), tasks);
    assert.deepEqual(
      trimHiddenTasks(
        {
          "claude:old": "2026-09-01T00:00:00.000Z",
          "claude:mid": "2026-09-10T00:00:00.000Z",
          "claude:new": "2026-09-20T00:00:00.000Z",
        },
        { limit: 2 },
      ),
      { "claude:mid": "2026-09-10T00:00:00.000Z", "claude:new": "2026-09-20T00:00:00.000Z" },
    );
  });
});

describe("phone task archive (FR-3.4)", () => {
  test("remember keeps the first timestamp across later reports", () => {
    const path = join(tempDir("phone-roundtrip"), "phone-tasks.json");
    let current = CLOCK;
    const archive = new PhoneTaskArchive({ path, now: () => current });
    assert.equal(archive.remember("claude:a"), true);
    assert.equal(archive.timestamp("claude:a"), CLOCK.toISOString());

    current = new Date("2026-10-05T12:00:00.000Z");
    assert.equal(archive.remember("claude:a"), true);
    assert.equal(archive.timestamp("claude:a"), CLOCK.toISOString());
    assert.equal(archive.remember("claude:b"), true);

    const restarted = new PhoneTaskArchive({ path });
    assert.deepEqual(restarted.snapshot(), {
      "claude:a": CLOCK.toISOString(),
      "claude:b": current.toISOString(),
    });
    assert.equal(restarted.remember("claude:b"), true);
    assert.equal(restarted.timestamp("claude:b"), current.toISOString());
  });

  test("helpers persist, load and trim by first-seen time", () => {
    const path = join(tempDir("phone-helpers"), "phone-tasks.json");
    const tasks = { "claude:x": "2026-09-26T03:00:00.000Z", "claude:y": "2026-09-26T01:00:00.000Z" };
    assert.equal(savePhoneTasks(tasks, path), true);
    assert.deepEqual(loadPhoneTasks(path), tasks);
    assert.deepEqual(trimPhoneTasks(tasks, { limit: 1 }), { "claude:x": "2026-09-26T03:00:00.000Z" });
  });

  test("a corrupt phone archive is ignored", () => {
    const path = join(tempDir("phone-corrupt"), "phone-tasks.json");
    writeFileSync(path, "not json");
    assert.equal(new PhoneTaskArchive({ path }).size, 0);
  });
});

describe("archive retention", () => {
  test("upstream caps are exposed", () => {
    assert.equal(HIDDEN_TASK_LIMIT, 2_000);
    assert.equal(PHONE_TASK_LIMIT, 500);
  });

  test("equal timestamps drop the lexicographically smaller id deterministically", () => {
    const tasks = { b: "2026-10-01T00:00:00.000Z", a: "2026-10-01T00:00:00.000Z" };
    assert.deepEqual(trimTaskArchive(tasks, { limit: 1 }), { b: "2026-10-01T00:00:00.000Z" });
  });

  test("an optional seven-day cutoff drops older entries but keeps the boundary and invalid times", () => {
    const now = new Date("2026-10-10T00:00:00.000Z");
    const tasks = {
      old: "2026-10-01T00:00:00.000Z",
      boundary: "2026-10-03T00:00:00.000Z",
      recent: "2026-10-08T00:00:00.000Z",
      invalid: "not-a-date",
    };
    const trimmed = trimPhoneTasks(tasks, {
      limit: 10,
      now,
      retentionMs: TASK_ARCHIVE_RETENTION_MS,
    });
    assert.deepEqual(Object.keys(trimmed).sort(), ["boundary", "invalid", "recent"]);
  });
});

describe("archive paths", () => {
  test("explicit paths win over environment overrides", () => {
    const previousHidden = process.env.AGENT_HOST_HIDDEN_TASKS;
    const previousPhone = process.env.AGENT_HOST_PHONE_TASKS;
    process.env.AGENT_HOST_HIDDEN_TASKS = "C:/env/hidden-tasks.json";
    process.env.AGENT_HOST_PHONE_TASKS = "C:/env/phone-tasks.json";
    try {
      assert.equal(hiddenTasksPath("C:/explicit/hidden.json"), "C:/explicit/hidden.json");
      assert.equal(hiddenTasksPath(), "C:/env/hidden-tasks.json");
      assert.equal(phoneTasksPath("C:/explicit/phone.json"), "C:/explicit/phone.json");
      assert.equal(phoneTasksPath(), "C:/env/phone-tasks.json");
    } finally {
      if (previousHidden === undefined) delete process.env.AGENT_HOST_HIDDEN_TASKS;
      else process.env.AGENT_HOST_HIDDEN_TASKS = previousHidden;
      if (previousPhone === undefined) delete process.env.AGENT_HOST_PHONE_TASKS;
      else process.env.AGENT_HOST_PHONE_TASKS = previousPhone;
    }
  });
});
