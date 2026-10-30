import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quoteWindowsArg, spawnExecutableSync } from "../../src/connectors/ported/spawn.js";

test("quoteWindowsArg leaves safe arguments alone and quotes the rest", () => {
  assert.equal(quoteWindowsArg("abc"), "abc");
  assert.equal(quoteWindowsArg("--profile"), "--profile");
  assert.equal(quoteWindowsArg("hello world"), '"hello world"');
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArg("tail\\"), '"tail\\\\"');
});

test(
  "spawnExecutableSync runs a .cmd with spaced and special arguments intact",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-host-spawn-"));
    try {
      const script = join(dir, "echoargs.cmd");
      await writeFile(script, "@echo off\r\necho [%1] [%2]\r\n");
      const result = spawnExecutableSync(script, ["hello world", "a&b"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(String(result.stdout).trim(), '["hello world"] ["a&b"]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
