import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pageToMessages, summaryToTask, titleFromEvents } from "../../src/connectors/dsh/mapping.js";
import type { DshSessionEvent, DshWebSessionSummary } from "../../src/connectors/dsh/web.js";

const now = Date.parse("2026-10-30T12:00:00Z");

function summary(overrides: Partial<DshWebSessionSummary> = {}): DshWebSessionSummary {
  return {
    sessionId: "s1",
    updatedAt: new Date(now - 60_000),
    running: false,
    blank: false,
    cwd: "E:/work/demo",
    title: "Fix login",
    ...overrides,
  };
}

function event(overrides: Partial<DshSessionEvent> & { type: string; seq: number }): DshSessionEvent {
  return {
    data: {},
    time: new Date(now - 60_000),
    ...overrides,
  };
}

describe("dsh task mapping", () => {
  test("maps a web summary to a dsh task", () => {
    const task = summaryToTask(summary(), "agent-1", now);
    assert.ok(task);
    assert.equal(task.id, "dsh:s1");
    assert.equal(task.source, "dsh");
    assert.equal(task.projectName, "demo");
    assert.equal(task.status, "completed");
    assert.equal(task.controllable, true);
  });

  test("skips blank, subagent, missing cwd and old sessions", () => {
    assert.equal(summaryToTask(summary({ blank: true }), "a", now), null);
    assert.equal(summaryToTask(summary({ origin: "subagent" }), "a", now), null);
    assert.equal(summaryToTask(summary({ cwd: undefined }), "a", now), null);
    assert.equal(
      summaryToTask(summary({ updatedAt: new Date(now - 400 * 24 * 60 * 60 * 1000) }), "a", now),
      null,
    );
  });

  test("marks running and ages completed sessions to idle", () => {
    assert.equal(summaryToTask(summary({ running: true }), "a", now)?.status, "running");
    assert.equal(
      summaryToTask(summary({ updatedAt: new Date(now - 25 * 60 * 60 * 1000) }), "a", now)?.status,
      "idle",
    );
  });

  test("maps events and filters plugin user messages and replacements", () => {
    const page = pageToMessages({
      hasMore: true,
      events: [
        event({
          type: "user/message",
          seq: 1,
          data: { content: [{ type: "text", text: "hello" }], source: { kind: "user" } },
        }),
        event({
          type: "user/message",
          seq: 2,
          data: { content: [{ type: "text", text: "plugin context" }], source: { kind: "plugin" } },
        }),
        event({
          type: "assistant/message",
          seq: 3,
          data: { message: { content: [{ type: "text", text: "hi" }] } },
        }),
        event({
          type: "assistant/message",
          seq: 4,
          surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 },
          data: { message: { content: [{ type: "text", text: "replacement" }] } },
        }),
        event({ type: "tool/call", seq: 5, data: { name: "bash", callId: "c1" } }),
      ],
    });
    assert.equal(page.hasMore, true);
    assert.deepEqual(
      page.messages.map((message) => `${message.role}:${message.text}`),
      ["user:hello", "agent:hi", "tool:bash"],
    );
    assert.equal(page.messages[2]?.id, "tool:c1:5");
  });

  test("prefers session title, then first real user message", () => {
    const events = [
      event({ type: "session/title", seq: 2, data: { title: "Named" } }),
      event({
        type: "user/message",
        seq: 1,
        data: { content: [{ type: "text", text: "first prompt" }], source: { kind: "user" } },
      }),
    ];
    assert.equal(titleFromEvents(events, "Named"), "Named");
    assert.equal(
      titleFromEvents(
        [event({ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "first prompt" }], source: { kind: "user" } } })],
        "fallback",
      ),
      "first prompt",
    );
  });
});
