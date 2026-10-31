import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACP_SESSION_MAX_PER_CONNECTOR,
  ACP_SESSION_RETENTION_MS,
  AcpSessionArchive,
  type AcpSessionArchiveInput,
} from "../../src/connectors/acp/session-archive.js";

const NOW = new Date("2026-10-31T12:00:00.000Z");

function session(overrides: Partial<AcpSessionArchiveInput> = {}): AcpSessionArchiveInput {
  return {
    id: "s1",
    title: "first prompt",
    projectPath: "C:\\work\\demo",
    projectName: "demo",
    status: "completed",
    startedAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T11:00:00.000Z",
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-host-acp-archive-"));
}

test("the retention window is seven days", () => {
  assert.equal(ACP_SESSION_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(ACP_SESSION_MAX_PER_CONNECTOR, 200);
});

test("remember stores metadata only and leaves no temp file behind", async () => {
  const dir = await tempDir();
  const path = join(dir, "acp-sessions.json");
  try {
    const archive = new AcpSessionArchive({ path, now: () => NOW });
    await archive.remember(
      "gemini",
      session({
        lastMessage: "secret reply text",
        pendingRequest: { summary: "rm -rf" },
        systemPermission: { title: "Allow?" },
        artifacts: [{ name: "preview.png" }],
      }),
    );

    // 原子写：目录里只剩目标文件，没有 .tmp。
    assert.deepEqual(await readdir(dir), ["acp-sessions.json"]);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("secret reply text"), false);
    assert.equal(raw.includes("lastMessage"), false);
    assert.equal(raw.includes("pendingRequest"), false);
    assert.equal(raw.includes("systemPermission"), false);
    assert.equal(raw.includes("artifacts"), false);

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(parsed.gemini, [session()]);
    assert.deepEqual(await archive.records("gemini"), [session()]);
    assert.deepEqual(await archive.records("nobody"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remember replaces the same session id and keeps the newest first", async () => {
  const dir = await tempDir();
  try {
    const archive = new AcpSessionArchive({ path: join(dir, "acp-sessions.json"), now: () => NOW });
    await archive.remember("gemini", session({ id: "a", updatedAt: "2026-10-31T09:00:00.000Z" }));
    await archive.remember("gemini", session({ id: "b", updatedAt: "2026-10-31T10:00:00.000Z" }));
    await archive.remember(
      "gemini",
      session({ id: "a", title: "renamed", updatedAt: "2026-10-31T11:00:00.000Z" }),
    );
    const records = await archive.records("gemini");
    assert.deepEqual(
      records.map((entry) => [entry.id, entry.title]),
      [
        ["a", "renamed"],
        ["b", "first prompt"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loading prunes entries older than seven days and keeps unparseable timestamps", async () => {
  const dir = await tempDir();
  const path = join(dir, "acp-sessions.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        gemini: [
          session({ id: "old", updatedAt: daysAgo(8) }),
          session({ id: "edge", updatedAt: daysAgo(7) }),
          session({ id: "fresh", updatedAt: daysAgo(6) }),
          session({ id: "broken", updatedAt: "not-a-date" }),
        ],
        stale: [session({ id: "gone", updatedAt: daysAgo(30) })],
      }),
    );
    const archive = new AcpSessionArchive({ path, now: () => NOW });
    assert.deepEqual(
      (await archive.records("gemini")).map((entry) => entry.id).sort(),
      ["broken", "edge", "fresh"],
    );
    assert.deepEqual(await archive.records("stale"), []);

    // 存盘前再剪一遍：旧条目不再写回文件。
    await archive.remember("gemini", session({ id: "newer", updatedAt: NOW.toISOString() }));
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, Array<{ id: string }>>;
    assert.deepEqual(parsed.gemini.map((entry) => entry.id).sort(), [
      "broken",
      "edge",
      "fresh",
      "newer",
    ]);
    assert.equal(parsed.stale, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forget drops the session and the empty connector key", async () => {
  const dir = await tempDir();
  const path = join(dir, "acp-sessions.json");
  try {
    const archive = new AcpSessionArchive({ path, now: () => NOW });
    await archive.remember("gemini", session({ id: "a", updatedAt: "2026-10-31T09:00:00.000Z" }));
    await archive.remember("gemini", session({ id: "b", updatedAt: "2026-10-31T10:00:00.000Z" }));

    await archive.forget("gemini", ["a"]);
    assert.deepEqual((await archive.records("gemini")).map((entry) => entry.id), ["b"]);
    let parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      (parsed.gemini as Array<{ id: string }>).map((entry) => entry.id),
      ["b"],
    );

    await archive.forget("gemini", new Set(["b"]));
    assert.deepEqual(await archive.records("gemini"), []);
    parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(parsed.gemini, undefined);

    // 不存在的 id / 连接器：不抛错、不写坏文件。
    await archive.forget("gemini", ["missing"]);
    await archive.forget("nobody", ["x"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a null path keeps everything in memory and writes nothing", async () => {
  const dir = await tempDir();
  try {
    const archive = new AcpSessionArchive({ path: null, now: () => NOW });
    await archive.remember("gemini", session());
    assert.deepEqual((await archive.records("gemini")).map((entry) => entry.id), ["s1"]);
    await archive.forget("gemini", ["s1"]);
    assert.deepEqual(await archive.records("gemini"), []);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt or misshapen archive file starts empty and is replaced on save", async () => {
  const dir = await tempDir();
  const path = join(dir, "acp-sessions.json");
  try {
    await writeFile(path, "{not json");
    const corrupt = new AcpSessionArchive({ path, now: () => NOW });
    assert.deepEqual(await corrupt.records("gemini"), []);
    await corrupt.remember("gemini", session());
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(parsed.gemini, [session()]);

    await writeFile(path, JSON.stringify([session()]));
    const misshapen = new AcpSessionArchive({ path, now: () => NOW });
    assert.deepEqual(await misshapen.records("gemini"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed input is rejected instead of writing a half-empty record", async () => {
  const dir = await tempDir();
  try {
    const archive = new AcpSessionArchive({ path: join(dir, "acp-sessions.json"), now: () => NOW });
    await assert.rejects(
      archive.remember("gemini", { ...session(), title: undefined as unknown as string }),
      TypeError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each connector keeps at most 200 sessions", async () => {
  const dir = await tempDir();
  try {
    const archive = new AcpSessionArchive({ path: join(dir, "acp-sessions.json"), now: () => NOW });
    for (let index = 0; index < ACP_SESSION_MAX_PER_CONNECTOR + 5; index += 1) {
      await archive.remember(
        "gemini",
        session({
          id: `s${index}`,
          updatedAt: new Date(NOW.getTime() - (300 - index) * 1000).toISOString(),
        }),
      );
    }
    const records = await archive.records("gemini");
    assert.equal(records.length, ACP_SESSION_MAX_PER_CONNECTOR);
    assert.equal(records[0]?.id, `s${ACP_SESSION_MAX_PER_CONNECTOR + 4}`);
    assert.equal(records.at(-1)?.id, "s5");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
