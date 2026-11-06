import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Snapshot } from "../contract/protocol.js";
import { ARTIFACT_TTL_MS, putUpload, setArtifactsDir } from "../../src/bus/artifacts.js";
import { flushCommandLog, setCommandLogPath, waitForCommands } from "../../src/bus/commands.js";
import {
  isBusPath,
  PROTOCOL_VERSION,
  routeBus,
  SNAPSHOT_LONG_POLL_MS,
} from "../../src/bus/router.js";
import { openBusWebSocket } from "../../src/bus/socket.js";
import { busStore, MAX_TASKS, type BusProject, type BusTask } from "../../src/bus/store.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";

let artifactsDir: string;

before(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), "agent-host-router-artifacts-"));
  setArtifactsDir(artifactsDir);
});

after(async () => {
  setArtifactsDir(undefined);
  await rm(artifactsDir, { recursive: true, force: true });
});

test("protocol version is locked to 3.10", () => {
  assert.equal(PROTOCOL_VERSION, "3.10");
});

function resetBus() {
  busStore.reset();
  setCommandLogPath(undefined);
  busStore.identify({
    agentId,
    hostName: "Agent Host",
    hostVersion: "1.0.0",
    platform: "windows",
  });
}

describe("bus routes", { concurrency: false }, () => {
  test("GET /bus/describe identifies this process as the agent host", async () => {
    resetBus();
    const response = await routeBus({
      method: "GET",
      path: "/bus/describe",
      agentId,
      hostVersion: "1.0.0",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      protocolVersion: "3.10",
      hostVersion: "1.0.0",
      agentId,
      hostKind: "agent-host",
      forwardsDsh: false,
    });
  });

  test("GET /bus/snapshot returns one empty computer", async () => {
    resetBus();
    const response = await routeBus({
      method: "GET",
      path: "/bus/snapshot",
      agentId,
      hostVersion: "1.0.0",
      platform: "windows",
    });
    assert.equal(response.status, 200);
    assert.equal(Snapshot.safeParse(response.body).success, true);
    const agents = response.body.agents as Array<{ agentId: string; online: boolean }>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0].agentId, agentId);
    assert.equal(agents[0].online, true);
    assert.deepEqual(response.body.tasks, []);
    assert.equal(response.body.seq, 0);
  });

  test("GET /bus/snapshot?since=0 hangs then returns 304", async () => {
    resetBus();
    assert.equal(SNAPSHOT_LONG_POLL_MS, 25_000);
    const started = Date.now();
    const same = await routeBus({
      method: "GET",
      path: "/bus/snapshot?since=0",
      agentId,
      longPollMs: 30,
    });
    assert.ok(Date.now() - started >= 25);
    assert.equal(same.status, 304);
    assert.deepEqual(same.body, {});

    const olderStarted = Date.now();
    const older = await routeBus({
      method: "GET",
      path: "/bus/snapshot?since=-1",
      agentId,
      longPollMs: 5_000,
    });
    assert.ok(Date.now() - olderStarted < 1_000);
    assert.equal(older.status, 200);
    assert.equal(older.body.seq, 0);
  });

  test("a task change wakes the long poll with the new snapshot", async () => {
    resetBus();
    const pending = routeBus({
      method: "GET",
      path: "/bus/snapshot?since=0",
      agentId,
      longPollMs: 5_000,
    });
    busStore.upsertTask({
      id: "dsh:1",
      agentId,
      source: "dsh",
      title: "hello",
      projectPath: "C:/work/demo",
      projectName: "demo",
      status: "running",
      origin: "desktop",
      controllable: false,
      startedAt: "2026-10-16T00:00:00Z",
      updatedAt: "2026-10-16T00:00:01Z",
    });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(response.body.seq, 1);
    assert.equal((response.body.tasks as unknown[]).length, 1);
  });

  test("POST /bus/commands dedups by id and rejects a bad body", async () => {
    resetBus();
    const dir = await mkdtemp(join(tmpdir(), "agent-host-"));
    setCommandLogPath(join(dir, "commands.json"));
    const body = Buffer.from(
      JSON.stringify({
        id: "cmd-1",
        createdAt: "2026-10-16T00:00:00Z",
        agentId,
        kind: "interrupt",
        interrupt: { taskId: "dsh:1" },
      }),
    );
    const first = await routeBus({ method: "POST", path: "/bus/commands", agentId, body });
    const second = await routeBus({ method: "POST", path: "/bus/commands", agentId, body });
    await waitForCommands();
    await flushCommandLog();
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(busStore.currentSeq(), 1);
    const saved = JSON.parse(await readFile(join(dir, "commands.json"), "utf8")) as unknown[];
    assert.equal(saved.length, 1);
    const bad = await routeBus({
      method: "POST",
      path: "/bus/commands",
      agentId,
      body: Buffer.from("{"),
    });
    assert.equal(bad.status, 400);
  });

  test("missing artifacts are 404 and oversized uploads are 413", async () => {
    resetBus();
    assert.equal(
      (await routeBus({ method: "GET", path: "/bus/artifacts/missing", agentId })).status,
      404,
    );
    const huge = await routeBus({
      method: "PUT",
      path: "/bus/uploads/abcdefghij1234567890AB",
      agentId,
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    });
    assert.equal(huge.status, 413);
  });

  test("PUT /bus/uploads stores image bytes and GET /bus/artifacts returns them", async () => {
    resetBus();
    const id = "A".repeat(22);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const put = await routeBus({
      method: "PUT",
      path: `/bus/uploads/${id}`,
      agentId,
      body: bytes,
      contentType: "image/png",
    });
    assert.equal(put.status, 201);
    assert.deepEqual(put.body, { artifactId: id, size: bytes.length });

    const got = await routeBus({ method: "GET", path: `/bus/artifacts/${id}`, agentId });
    assert.equal(got.status, 200);
    assert.equal(got.contentType, "image/png");
    assert.deepEqual(got.bytes, bytes);
    assert.deepEqual(got.body, {});
  });

  test("upload rejects bad ids, unsupported types, and missing content-type", async () => {
    resetBus();
    const bytes = Buffer.from("abc");
    const badId = await routeBus({
      method: "PUT",
      path: "/bus/uploads/short",
      agentId,
      body: bytes,
      contentType: "image/png",
    });
    assert.equal(badId.status, 400);
    assert.deepEqual(badId.body, { error: "invalid_artifact_id" });

    const wrongType = await routeBus({
      method: "PUT",
      path: `/bus/uploads/${"B".repeat(22)}`,
      agentId,
      body: bytes,
      contentType: "text/plain",
    });
    assert.equal(wrongType.status, 415);

    const noType = await routeBus({
      method: "PUT",
      path: `/bus/uploads/${"C".repeat(22)}`,
      agentId,
      body: bytes,
    });
    assert.equal(noType.status, 415);

    const badGet = await routeBus({
      method: "GET",
      path: "/bus/artifacts/not-a-valid-artifact-id",
      agentId,
    });
    assert.equal(badGet.status, 404);
  });

  test("expired artifacts are 404 through the router", async () => {
    resetBus();
    const id = "D".repeat(22);
    await putUpload(id, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", new Date(Date.now() - ARTIFACT_TTL_MS - 1000));
    const got = await routeBus({ method: "GET", path: `/bus/artifacts/${id}`, agentId });
    assert.equal(got.status, 404);
    assert.deepEqual(got.body, { error: "not_found" });
  });

  test("a new websocket gets the snapshot and later events", () => {
    resetBus();
    const frames: Array<Record<string, unknown>> = [];
    const close = openBusWebSocket("/bus/ws?since=-1", (text) => {
      frames.push(JSON.parse(text) as Record<string, unknown>);
    });
    busStore.recordResult({
      commandId: "cmd-2",
      ok: false,
      error: "not supported",
      finishedAt: "2026-10-16T00:00:02Z",
    });
    close();
    assert.equal(frames[0].type, "snapshot");
    assert.equal(frames[1].type, "event");
  });

  test("unknown /bus paths are 404 and other paths are not bus paths", async () => {
    resetBus();
    assert.equal((await routeBus({ method: "POST", path: "/bus/describe", agentId })).status, 404);
    assert.equal((await routeBus({ method: "GET", path: "/bus/missing", agentId })).status, 404);
    assert.equal(isBusPath("/bus/describe?x=1"), true);
    assert.equal(isBusPath("/api/tasks"), false);
  });

  test("400 tasks and 60 projects stay under one websocket frame", () => {
    const frameLimit = 4 * 1024 * 1024;
    const sentence = "播放器在窄屏下被目录挤出可视区域，准备把目录改成可折叠并补一条布局测试。";
    const command = [
      "Remove-Item -Recurse -Force .\\build",
      "npm ci",
      "npm test",
      "npm run build",
    ].join("\n");
    const projects: BusProject[] = Array.from({ length: 60 }, (_, index) => ({
      agentId,
      path: `C:/Users/me/Projects/lesson-creator-${index}/apps/player`,
      name: `lesson-creator-${index}`,
      lastUsedAt: "2026-10-16T00:00:00Z",
      pinned: index % 10 === 0,
    }));
    const measure = (chars: number) => {
      const reply = sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
      const tasks: BusTask[] = Array.from({ length: MAX_TASKS }, (_, index) => {
        const project = index % 60;
        const waiting = index % 5 === 0;
        const stamp = new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString().replace(".000Z", "Z");
        return {
          id: `codex:${String(index).padStart(4, "0")}`,
          agentId,
          source: "codex",
          title: `修复课程「第 ${project + 1} 讲」在窄屏下被目录挤出画面（${index}）`,
          projectPath: `C:/Users/me/Projects/lesson-creator-${project}/apps/player`,
          projectName: `lesson-creator-${project}`,
          status: waiting ? "waitingApproval" : "running",
          lastMessage: `${reply} 任务序号 ${index}。`,
          ...(waiting
            ? {
                pendingRequest: {
                  id: `req-${index}`,
                  kind: "command",
                  summary: "删除 build 目录后重新安装依赖、测试并打包",
                  detail: command,
                },
              }
            : {}),
          artifacts: [
            {
              id: `artifact-note-${index}`,
              kind: "file",
              title: "布局改动说明",
              createdAt: stamp,
              contentType: "text/markdown",
              size: 4096,
            },
            {
              id: `artifact-shot-${index}`,
              kind: "image",
              title: "窄屏截图",
              createdAt: stamp,
              contentType: "image/png",
              size: 180000,
            },
          ],
          origin: "desktop" as const,
          controllable: false,
          startedAt: "2026-10-16T00:00:00Z",
          updatedAt: stamp,
        };
      });
      resetBus();
      busStore.replaceForMeasurement(tasks, projects);
      const body = busStore.snapshot();
      return { body, bytes: Buffer.byteLength(JSON.stringify(body)) };
    };
    let low = 0;
    let high = sentence.length;
    while (measure(high).bytes < frameLimit) high *= 2;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (measure(mid).bytes < frameLimit) low = mid;
      else high = mid;
    }
    const fullest = measure(low);
    assert.equal(Snapshot.safeParse(fullest.body).success, true);
    console.log(
      `snapshot bytes ${fullest.bytes} of ${frameLimit}; lastMessage chars ${low}`,
    );
    assert.ok(fullest.bytes < frameLimit);
    assert.ok(frameLimit - fullest.bytes < 4096);
  });
});
