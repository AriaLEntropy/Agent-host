import assert from "node:assert/strict";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACP_MANIFEST_DEBOUNCE_MS,
  ACP_MANIFEST_POLL_INTERVAL_MS,
  AcpManifestWatcher,
  type AcpManifestChange,
} from "../../src/connectors/acp/manifest-watcher.js";

/** 收集回调：既有 `next()` 等着下一次，也记着没人等时攒下的事件。 */
function collector() {
  const events: AcpManifestChange[] = [];
  const waiters: ((change: AcpManifestChange) => void)[] = [];
  return {
    onChange(change: AcpManifestChange) {
      const waiter = waiters.shift();
      if (waiter) waiter(change);
      else events.push(change);
    },
    next(timeoutMs = 5000): Promise<AcpManifestChange> {
      const queued = events.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no manifest change callback")), timeoutMs);
        waiters.push((change) => {
          clearTimeout(timer);
          resolve(change);
        });
      });
    },
    count(): number {
      return events.length;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("defaults match the upstream poll interval and debounce", () => {
  assert.equal(ACP_MANIFEST_POLL_INTERVAL_MS, 2000);
  assert.equal(ACP_MANIFEST_DEBOUNCE_MS, 500);
});

test("scan reports added, changed and removed manifests without firing the callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-acp-watch-"));
  try {
    const seen = collector();
    const watcher = new AcpManifestWatcher({ directory: dir, onChange: seen.onChange });
    await writeFile(join(dir, "a.json"), '{"id":"a"}');
    await writeFile(join(dir, "b.json"), '{"id":"b"}');
    // 不是清单：不参与快照。
    await writeFile(join(dir, "notes.txt"), "ignored");
    await writeFile(join(dir, ".a.json.tmp"), "half-written");

    assert.deepEqual(await watcher.scan(), {
      added: ["a.json", "b.json"],
      changed: [],
      removed: [],
    });
    assert.deepEqual(await watcher.scan(), { added: [], changed: [], removed: [] });

    // 原地重写（大小变了）：只算改过。
    await writeFile(join(dir, "a.json"), '{"id":"a","name":"A longer name"}');
    assert.deepEqual(await watcher.scan(), { added: [], changed: ["a.json"], removed: [] });

    await unlink(join(dir, "b.json"));
    assert.deepEqual(await watcher.scan(), { added: [], changed: [], removed: ["b.json"] });
    assert.equal(seen.count(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a manual scan while polling joins the debounce window instead of swallowing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-acp-watch-"));
  const seen = collector();
  const watcher = new AcpManifestWatcher({
    directory: dir,
    pollIntervalMs: 60_000,
    debounceMs: 30,
    onChange: seen.onChange,
  });
  try {
    await watcher.start();
    await writeFile(join(dir, "c.json"), '{"id":"c"}');
    assert.deepEqual(await watcher.scan(), {
      added: ["c.json"],
      changed: [],
      removed: [],
    });
    const change = await seen.next(1000);
    assert.deepEqual(change.added, ["c.json"]);
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("start creates the directory and coalesces new manifests into one callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-acp-watch-"));
  const dir = join(root, "agents");
  const seen = collector();
  const watched = new AcpManifestWatcher({
    directory: dir,
    pollIntervalMs: 10,
    debounceMs: 150,
    onChange: seen.onChange,
  });
  try {
    await watched.start();
    assert.equal((await stat(dir)).isDirectory(), true);

    await writeFile(join(dir, "a.json"), '{"id":"a"}');
    await writeFile(join(dir, "b.json"), '{"id":"b"}');
    const added = await seen.next();
    assert.deepEqual(added, { added: ["a.json", "b.json"], changed: [], removed: [] });

    // 连续三次原地重写：安静 debounceMs 之后只回调一次。
    await writeFile(join(dir, "a.json"), '{"id":"a","v":1}');
    await writeFile(join(dir, "a.json"), '{"id":"a","v":22}');
    await writeFile(join(dir, "a.json"), '{"id":"a","v":333}');
    const changed = await seen.next();
    assert.deepEqual(changed, { added: [], changed: ["a.json"], removed: [] });
    await delay(400);
    assert.equal(seen.count(), 0);
  } finally {
    watched.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted directory is recreated and its manifests report removal, then addition", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-acp-watch-"));
  const dir = join(root, "agents");
  const seen = collector();
  const watcher = new AcpManifestWatcher({
    directory: dir,
    pollIntervalMs: 10,
    debounceMs: 40,
    onChange: seen.onChange,
  });
  try {
    await watcher.start();
    await writeFile(join(dir, "keep.json"), '{"id":"keep"}');
    assert.deepEqual((await seen.next()).added, ["keep.json"]);

    // `rm -rf agents`：轮询把目录建回来，清单按删掉上报。
    await rm(dir, { recursive: true, force: true });
    const removed = await seen.next();
    assert.deepEqual(removed, { added: [], changed: [], removed: ["keep.json"] });
    assert.equal((await stat(dir)).isDirectory(), true);

    // 安装器再写回来：按新增上报。
    await writeFile(join(dir, "keep.json"), '{"id":"keep","v":2}');
    const readded = await seen.next();
    assert.deepEqual(readded, { added: ["keep.json"], changed: [], removed: [] });
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop stops polling and pending callbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-acp-watch-"));
  const seen = collector();
  const watcher = new AcpManifestWatcher({
    directory: dir,
    pollIntervalMs: 10,
    debounceMs: 40,
    onChange: seen.onChange,
  });
  try {
    await watcher.start();
    watcher.stop();
    assert.equal(watcher.isRunning, false);
    await writeFile(join(dir, "late.json"), '{"id":"late"}');
    await delay(250);
    assert.equal(seen.count(), 0);
    // 基线也清掉了：再比一次全是新增，但仍然不回调。
    assert.deepEqual(await watcher.scan(), { added: ["late.json"], changed: [], removed: [] });
    assert.equal(seen.count(), 0);
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-manifest files never trigger a callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-acp-watch-"));
  const seen = collector();
  const watcher = new AcpManifestWatcher({
    directory: dir,
    pollIntervalMs: 10,
    debounceMs: 30,
    onChange: seen.onChange,
  });
  try {
    await watcher.start();
    await writeFile(join(dir, "notes.txt"), "not a manifest");
    await writeFile(join(dir, "x.json.tmp"), '{"id":"x"}');
    await delay(250);
    assert.equal(seen.count(), 0);
  } finally {
    watcher.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
