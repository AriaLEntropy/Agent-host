import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildEnvironment,
  claudeSettingsEnvironment,
} from "../../src/connectors/claude/claude-connector.js";

test("claudeSettingsEnvironment reads string values from settings.json env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-claude-settings-"));
  try {
    const settings = join(dir, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "token-value",
          ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
          IGNORED_NUMBER: 42,
        },
        other: { env: { NOPE: "x" } },
      }),
    );
    assert.deepEqual(claudeSettingsEnvironment(settings), {
      ANTHROPIC_AUTH_TOKEN: "token-value",
      ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
    });
    assert.deepEqual(claudeSettingsEnvironment(join(dir, "missing.json")), {});
    await writeFile(settings, "{not json");
    assert.deepEqual(claudeSettingsEnvironment(settings), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildEnvironment lets injected env win over the base env", () => {
  assert.deepEqual(buildEnvironment({ A: "3", C: "4" }, { A: "1", B: "2" }), {
    A: "3",
    B: "2",
    C: "4",
  });
});
