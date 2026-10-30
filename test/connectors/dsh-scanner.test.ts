import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { dshPaths } from "../../src/connectors/dsh/paths.js";
import { decodeSegment, decodeZstdFrames, scanDshSessions, zstdFrames } from "../../src/connectors/dsh/scanner.js";

describe("dsh scanner", () => {
  test("decodes dsh's ~XXXX session directory names", () => {
    assert.equal(decodeSegment("--E-dsh-docs--"), "--E-dsh-docs--");
    assert.equal(decodeSegment("~0041bc"), "Abc");
  });

  test("splits and decodes concatenated zstd frames", () => {
    const first = zstdCompressSync(Buffer.from("first\n"));
    const second = zstdCompressSync(Buffer.from("second\n"));
    const joined = Buffer.concat([first, second]);
    assert.equal(zstdFrames(joined).length, 2);
    assert.equal(decodeZstdFrames(joined).toString("utf8"), "first\nsecond\n");
  });

  test("scans a plain session and maps its summary", async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-host-dsh-scan-"));
    try {
      const directory = join(home, "sessions", "--E-work-demo--", "session-1");
      await mkdir(directory, { recursive: true });
      const lines = [
        { type: "session", version: 4, id: "session-1", createdAt: 1_790_000_000_000, cwd: "E:/work/demo", isSeeded: false },
        { type: "turn/start", seq: 1, time: 1_790_000_000_000, data: {} },
        { type: "user/message", seq: 2, time: 1_790_000_001_000, data: { content: [{ type: "text", text: "fix it" }], source: { kind: "user" } } },
        { type: "assistant/message", seq: 3, time: 1_790_000_002_000, data: { message: { content: [{ type: "text", text: "done" }] } } },
        { type: "turn/end", seq: 4, time: 1_790_000_003_000, data: { reason: { kind: "completed" } } },
      ];
      await writeFile(join(directory, "session.v4.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      const sessions = await scanDshSessions(dshPaths(home), Date.parse("2026-10-30T12:00:00Z"));
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.summary.sessionId, "session-1");
      assert.equal(sessions[0]?.summary.cwd, "E:/work/demo");
      assert.equal(sessions[0]?.summary.title, "fix it");
      assert.equal(sessions[0]?.summary.running, false);
      assert.equal(sessions[0]?.events.length, 4);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
