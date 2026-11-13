import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fileHasUnsupportedToolAddition,
  lineHasUnsupportedToolAddition,
} from "../../src/connectors/claude/claude-compat.js";

test("line with tool_addition and tool_definition is detected", () => {
  assert.equal(
    lineHasUnsupportedToolAddition(
      '{"type":"api-request-blob","message":{"content":[{"type":"tool_addition","tool":{"type":"tool_definition"}}]}}',
    ),
    true,
  );
});

test("error text alone is not a tool addition block", () => {
  assert.equal(
    lineHasUnsupportedToolAddition(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"unknown variant `tool_definition`"}]}}',
    ),
    false,
  );
});

test("file scan finds the block among other lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-compat-"));
  const file = join(directory, "session.jsonl");
  try {
    await writeFile(
      file,
      [
        '{"type":"user","message":{"role":"user","content":"hi"}}',
        '{"type":"api-request-blob","message":{"content":[{"type":"tool_addition","tool":{"type":"tool_definition"}}]}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
        "",
      ].join("\n"),
    );
    assert.equal(fileHasUnsupportedToolAddition(file), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file without the block is not flagged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-compat-"));
  const file = join(directory, "session.jsonl");
  try {
    await writeFile(
      file,
      [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"unknown variant tool_definition"}]}}',
        "",
      ].join("\n"),
    );
    assert.equal(fileHasUnsupportedToolAddition(file), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
