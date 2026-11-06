import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ARTIFACT_TTL_MS,
  getArtifact,
  putUpload,
  setArtifactsDir,
} from "../../src/bus/artifacts.js";
import {
  ARTIFACT_SWEEP_INTERVAL_MS,
  startArtifactMaintenance,
  stopArtifactMaintenance,
  sweepArtifacts,
} from "../../src/bus/artifact-maintenance.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

let dir: string;

function artifactId(seed: string): string {
  return createHash("sha256").update(seed).digest().subarray(0, 16).toString("base64url");
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * 等清理真的跑完。
 *
 * 假定时器只改了 interval 的触发节奏，清理本身还是多跳真异步（readdir → 读元数据
 * → unlink），猜一帧会 flaky，所以轮询到条件成立或超时
 */
async function waitUntilStoredIds(expected: string[]): Promise<void> {
  const want = [...expected].sort();
  const deadline = Date.now() + 2_000;
  for (;;) {
    const have = (await storedIds()).sort();
    if (JSON.stringify(have) === JSON.stringify(want)) return;
    if (Date.now() > deadline) return assert.deepEqual(have, want);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function storedIds(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".bin")).map((name) => name.slice(0, -4));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-host-artifact-maintenance-"));
  setArtifactsDir(dir);
});

afterEach(async () => {
  stopArtifactMaintenance();
  setArtifactsDir(undefined);
  await rm(dir, { recursive: true, force: true });
});

test("sweeping a cache directory that does not exist is a no-op", async () => {
  setArtifactsDir(join(dir, "never-created"));
  assert.equal(await sweepArtifacts(), 0);
});

test("the sweep is far coarser than the retention it enforces", () => {
  assert.equal(ARTIFACT_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(ARTIFACT_SWEEP_INTERVAL_MS < ARTIFACT_TTL_MS, true);
});

test("starting sweeps once at boot and again on the interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const first = artifactId("sweep-first");
  await putUpload(first, PNG, "image/png", daysAgo(8));
  assert.deepEqual(await storedIds(), [first]);

  // Node 22 的 MockTimers 只有 tick / runAll（没有 runFor），且仍是实验特性
  startArtifactMaintenance();
  await waitUntilStoredIds([]);

  const second = artifactId("sweep-second");
  await putUpload(second, PNG, "image/png", daysAgo(8));
  assert.deepEqual(await storedIds(), [second]);

  t.mock.timers.tick(ARTIFACT_SWEEP_INTERVAL_MS);
  await waitUntilStoredIds([]);

  // 停掉之后不再有下一次：关机路径漏了 stop，托盘退出后会被一个 unref 定时器拖着
  const third = artifactId("sweep-third");
  stopArtifactMaintenance();
  await putUpload(third, PNG, "image/png", daysAgo(8));
  t.mock.timers.tick(ARTIFACT_SWEEP_INTERVAL_MS * 3);
  await waitUntilStoredIds([third]);
  assert.equal(await getArtifact(third), null);
});
