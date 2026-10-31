import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePermissionRequest,
  parseSessionUpdate,
  type AcpPermissionRequest,
} from "../../src/connectors/acp/messages.js";
import { AcpSessionState, type AcpSessionRecord } from "../../src/connectors/acp/session.js";
import { ACP_TRANSCRIPT_MAX_ENTRIES } from "../../src/connectors/acp/transcript.js";

function record(overrides: Partial<AcpSessionRecord> = {}): AcpSessionRecord {
  return {
    title: "demo",
    projectName: "demo",
    status: "completed",
    updatedAt: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

function permission(): AcpPermissionRequest {
  const request = parsePermissionRequest({
    sessionId: "s1",
    toolCall: {
      toolCallId: "c1",
      title: "npm test",
      kind: "execute",
      rawInput: { command: "npm test" },
    },
    options: [
      { optionId: "allow", name: "仅此一次", kind: "allow_once" },
      { optionId: "deny", name: "拒绝", kind: "reject_once" },
    ],
  });
  assert.ok(request);
  return request;
}

test("agent chunks merge into one segment and a turn keeps stable ids", () => {
  const state = new AcpSessionState(record({ title: "demo" }));
  state.beginTurn("hello", "2026-10-31T00:00:01.000Z");
  state.apply(parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "he" } }), "t2");
  state.apply(parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "llo" } }), "t3");
  assert.deepEqual(
    state.transcript.entries().map((message) => [message.id, message.role, message.text]),
    [
      ["1-1", "user", "hello"],
      ["1-2", "agent", "hello"],
    ],
  );

  state.beginTurn("again", "t4");
  state.apply(parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }), "t5");
  assert.deepEqual(
    state.transcript.entries().map((message) => [message.id, message.role, message.text]),
    [
      ["1-1", "user", "hello"],
      ["1-2", "agent", "hello"],
      ["2-1", "user", "again"],
      ["2-2", "agent", "ok"],
    ],
  );
});

test("an echoed user message during a turn is discarded", () => {
  const state = new AcpSessionState(record());
  state.beginTurn("hello", "t1");
  state.apply(parseSessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }), "t2");
  assert.deepEqual(
    state.transcript.entries().map((message) => message.text),
    ["hello"],
  );

  // prompt 为空（反向扩展）时，终端里的用户消息照常记录。
  const other = new AcpSessionState(record());
  other.beginTurn("", "t1");
  other.apply(parseSessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "typed" } }), "t2");
  assert.deepEqual(
    other.transcript.entries().map((message) => message.text),
    ["typed"],
  );
});

test("tool_call_update updates one row and keeps the original raw input", () => {
  const state = new AcpSessionState(record());
  state.beginTurn("run it", "t1");
  state.apply(
    parseSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "npm test",
      kind: "execute",
      rawInput: { command: "npm test" },
    }),
    "t2",
  );
  state.apply(
    parseSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      content: [{ type: "content", content: { type: "text", text: "PASS" } }],
    }),
    "t3",
  );
  const tool = state.transcript.entries().filter((message) => message.role === "tool");
  assert.equal(tool.length, 1);
  assert.equal(tool[0]!.id, "tool-c1");
  assert.equal(tool[0]!.text, "npm test");
});

test("a pending approval restores the status it interrupted", () => {
  const waiting = new AcpSessionState(record({ status: "completed" }));
  assert.equal(waiting.apply(parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }), "t0"), false);
  waiting.setPending(permission(), 900, "t1");
  assert.equal(waiting.record.status, "waitingApproval");
  assert.equal(waiting.record.pendingRequest?.id, "c1");
  assert.equal(waiting.record.pendingRequest?.kind, "command");
  assert.equal(waiting.record.pendingRequest?.summary, "npm test");
  assert.equal(waiting.record.pendingRequest?.detail, '{"command":"npm test"}');
  assert.deepEqual(waiting.record.pendingRequest?.questions?.map((question) => question.id), ["scope"]);
  waiting.clearPending("t2");
  assert.equal(waiting.record.status, "completed");
  assert.equal(waiting.record.pendingRequest, undefined);
});

test("clearing an approval during a turn goes back to running", () => {
  const state = new AcpSessionState(record());
  state.beginTurn("hello", "t1");
  state.setPending(permission(), 900, "t2");
  state.clearPending("t3");
  assert.equal(state.record.status, "running");
});

test("endTurn records the reply, or an explanation when the stop reason failed", () => {
  const completed = new AcpSessionState(record());
  completed.beginTurn("hello", "t1");
  completed.apply(parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "  done  " } }), "t2");
  completed.endTurn("end_turn", undefined, "t3");
  assert.equal(completed.record.status, "completed");
  assert.equal(completed.record.lastMessage, "done");

  const failed = new AcpSessionState(record());
  failed.beginTurn("hello", "t1");
  failed.endTurn("max_tokens", undefined, "t2");
  assert.equal(failed.record.status, "failed");
  assert.equal(failed.record.lastMessage, "回复达到了 token 上限");

  const crashed = new AcpSessionState(record());
  crashed.beginTurn("hello", "t1");
  crashed.endTurn(undefined, "agent exited", "t2");
  assert.equal(crashed.record.status, "failed");
  assert.equal(crashed.record.lastMessage, "agent exited");
});

test("a title set from the first prompt is not replaced by a later prompt", () => {
  const state = new AcpSessionState(record({ title: "demo", projectName: "demo" }));
  state.beginTurn("first prompt", "t1");
  assert.equal(state.record.title, "first prompt");
  state.beginTurn("second prompt", "t2");
  assert.equal(state.record.title, "first prompt");

  // agent 给的会话标题仍然会覆盖。
  state.apply(parseSessionUpdate({ sessionUpdate: "session_info_update", title: "Agent title" }), "t3");
  assert.equal(state.record.title, "Agent title");
  state.beginTurn("third prompt", "t4");
  assert.equal(state.record.title, "Agent title");
});

test("the transcript keeps only the latest 500 entries", () => {
  const state = new AcpSessionState(record());
  for (let index = 0; index < ACP_TRANSCRIPT_MAX_ENTRIES + 5; index += 1) {
    state.beginTurn(`p${index}`, "t");
    state.apply(parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }), "t");
  }
  const entries = state.transcript.entries();
  assert.equal(entries.length, ACP_TRANSCRIPT_MAX_ENTRIES);
  assert.equal(entries.at(-1)?.text, "a");
});
