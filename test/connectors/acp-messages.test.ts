import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowOptions,
  mergeToolCall,
  optionIdFor,
  parseAvailableCommands,
  parsePermissionOptions,
  parsePermissionRequest,
  parseSessionUpdate,
  parseToolCall,
  permissionQuestions,
  singleLine,
  stopExplanation,
  stopStatus,
  truncate,
} from "../../src/connectors/acp/messages.js";

test("session updates parse text, tool calls and unknown types without throwing", () => {
  assert.deepEqual(
    parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
    { kind: "agentMessage", text: "hi", images: [] },
  );
  assert.deepEqual(
    parseSessionUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "me" } }),
    { kind: "userMessage", text: "me", images: [] },
  );
  // 图片块：文字为空、图片带上 base64 与类型；缺字段的坏块当空。
  assert.deepEqual(
    parseSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AAEC", mimeType: "image/png" },
    }),
    { kind: "agentMessage", text: "", images: [{ base64: "AAEC", mimeType: "image/png" }] },
  );
  assert.deepEqual(
    parseSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }),
    { kind: "agentMessage", text: "", images: [] },
  );
  assert.deepEqual(parseSessionUpdate({ sessionUpdate: "agent_thought_chunk" }), { kind: "thought" });
  assert.deepEqual(parseSessionUpdate({ sessionUpdate: "plan" }), { kind: "other", type: "plan" });
  assert.deepEqual(parseSessionUpdate({ sessionUpdate: "session_info_update", title: " T " }), {
    kind: "sessionInfo",
    title: " T ",
  });
  const tool = parseSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "npm test",
    kind: "execute",
    rawInput: { command: "npm test" },
  });
  assert.equal(tool.kind, "toolCall");
  assert.equal(tool.kind === "toolCall" ? tool.call.rawInput : "", '{"command":"npm test"}');
});

test("available_commands_update becomes a command list and skips bad items", () => {
  const parsed = parseSessionUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "/release", description: " Write release notes ", input: { hint: " version " } },
      { name: "bad name", description: "skipped" },
      { name: "", description: "skipped" },
      { name: "review", description: 42 },
    ],
  });
  assert.deepEqual(parsed, {
    kind: "availableCommands",
    commands: [
      { name: "release", description: "Write release notes", hint: "version" },
      { name: "review", description: "" },
    ],
  });
  assert.deepEqual(parseAvailableCommands(undefined), []);
});

test("a tool call keeps rawInput when an update only carries explanation text", () => {
  const base = parseToolCall({
    toolCallId: "c1",
    title: "run",
    kind: "execute",
    rawInput: { command: "npm test" },
  });
  assert.ok(base);
  const update = parseToolCall({
    toolCallId: "c1",
    content: [{ type: "content", content: { type: "text", text: "done" } }],
  });
  assert.ok(update);
  const merged = mergeToolCall(base, update);
  assert.equal(merged.title, "run");
  assert.equal(merged.rawInput, '{"command":"npm test"}');
  assert.equal(merged.contentText, "done");
  assert.equal(parseToolCall({ title: "no id" }), undefined);
});

test("permission options prefer one-shot, and answers can pick a wider scope", () => {
  const options = parsePermissionOptions([
    { optionId: "allow-always", name: "始终允许", kind: "allow_always" },
    { optionId: "allow-once", name: "仅此一次", kind: "allow_once" },
    { optionId: "deny-once", name: "拒绝", kind: "reject_once" },
    { optionId: "deny-always", name: "始终拒绝", kind: "reject_always" },
  ]);
  assert.deepEqual(allowOptions(options).map((option) => option.optionId), [
    "allow-once",
    "allow-always",
  ]);
  assert.equal(optionIdFor(options, "allow"), "allow-once");
  assert.equal(optionIdFor(options, "deny"), "deny-once");
  assert.equal(optionIdFor(options, "allow", { scope: ["始终允许"] }), "allow-always");
  assert.equal(optionIdFor(options, "allow", { scope: ["不存在"] }), "allow-once");
  assert.equal(optionIdFor(options, "allow", { scope: ["始终允许", "仅此一次"] }), "allow-once");
  assert.deepEqual(permissionQuestions(options), [
    {
      id: "scope",
      question: "允许范围",
      options: [{ label: "仅此一次" }, { label: "始终允许" }],
    },
  ]);
  assert.equal(permissionQuestions([{ optionId: "no", name: "拒绝", kind: "reject_once" }]), undefined);
});

test("permission requests need a session and a tool call", () => {
  const request = parsePermissionRequest({
    sessionId: "s1",
    toolCall: { toolCallId: "c1", title: "edit", kind: "edit" },
    options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
  });
  assert.equal(request?.sessionId, "s1");
  assert.equal(request?.toolCall.kind, "edit");
  assert.equal(parsePermissionRequest({ toolCall: { toolCallId: "c1" } }), undefined);
  assert.equal(parsePermissionRequest({ sessionId: "s1" }), undefined);
});

test("stop reasons map to task status and explanations", () => {
  assert.equal(stopStatus("end_turn"), "completed");
  assert.equal(stopStatus("cancelled"), "interrupted");
  assert.equal(stopStatus("refusal"), "failed");
  assert.equal(stopStatus("max_tokens"), "failed");
  assert.equal(stopStatus("max_turn_requests"), "failed");
  assert.equal(stopStatus(undefined), "completed");
  assert.equal(stopExplanation("max_tokens"), "回复达到了 token 上限");
  assert.equal(stopExplanation("cancelled"), undefined);
});

test("text helpers keep one line and do not split surrogate pairs", () => {
  assert.equal(singleLine("a\nb\r\nc"), "a b c");
  assert.equal(truncate("😀😀😀", 2), "😀😀");
  assert.equal(truncate("abc", 5), "abc");
});
