import assert from "node:assert/strict";
import { test } from "node:test";
import { agentIconFile } from "../../src/desktop/agent-icons.js";

test("agent icon mapping prefers connectorId and covers official marks", () => {
  assert.equal(agentIconFile("acp", "opencode"), "agent-opencode.svg");
  assert.equal(agentIconFile("acp", "claude-code"), "agent-claude.jpg");
  assert.equal(agentIconFile("acp", "gemini"), "agent-default.svg");
  assert.equal(agentIconFile("codex"), "agent-codex.jpg");
  assert.equal(agentIconFile("dsh"), "agent-deepseek.png");
  assert.equal(agentIconFile("hermes"), "agent-hermes.svg");
  assert.equal(agentIconFile("pi"), "agent-pi.svg");
  assert.equal(agentIconFile("openclaw"), "agent-openclaw.svg");
  assert.equal(agentIconFile("unknown"), "agent-default.svg");
});
