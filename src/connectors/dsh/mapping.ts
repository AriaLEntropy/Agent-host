import { basename } from "node:path";
import type { BusMessage, BusTask } from "../../bus/store.js";
import { SESSION_HISTORY_WINDOW_MS } from "../session-window.js";
import type { DshPage, DshSessionEvent, DshWebSessionSummary } from "./web.js";
import { eventSourceKind, eventText, eventTitle } from "./web.js";

const RECENT_WINDOW_MS = SESSION_HISTORY_WINDOW_MS;
const IDLE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_TASK_TITLE = 80;

/** `session/list` 的一项 → 统一任务。空白、subagent、没有 cwd/updatedAt 的不列。 */
export function summaryToTask(
  summary: DshWebSessionSummary,
  agentId: string,
  now = Date.now(),
): BusTask | null {
  if (summary.blank || summary.origin === "subagent" || !summary.cwd || !summary.updatedAt) return null;
  if (now - summary.updatedAt.getTime() > RECENT_WINDOW_MS) return null;
  const updatedAt = summary.updatedAt.toISOString();
  return {
    id: `dsh:${summary.sessionId}`,
    agentId,
    source: "dsh",
    title: truncate(summary.title?.trim() || summary.sessionId, MAX_TASK_TITLE),
    projectPath: summary.cwd,
    projectName: basename(summary.cwd) || summary.cwd,
    status: summary.running ? "running" : aged("completed", summary.updatedAt, now),
    origin: "watch",
    controllable: true,
    startedAt: updatedAt,
    updatedAt,
  };
}

/** 一页事件 → BusMessage。跳过压缩替换副本和非用户来源的 user/message。 */
export function pageToMessages(page: DshPage): { messages: BusMessage[]; hasMore: boolean } {
  const messages: BusMessage[] = [];
  for (const event of sortedEvents(page.events)) {
    if (isReplacement(event)) continue;
    if (event.type === "user/message") {
      if (eventSourceKind(event) !== "user") continue;
      const text = eventText(event);
      if (text) messages.push(toMessage(event, "user", text));
      continue;
    }
    if (event.type === "assistant/message") {
      const text = eventText(event);
      if (text) messages.push(toMessage(event, "agent", text));
      continue;
    }
    if (event.type === "tool/call") {
      const data = record(event.data);
      const name = typeof data.name === "string" ? data.name : "tool";
      const callId = typeof data.callId === "string" ? data.callId : String(event.seq);
      messages.push(toMessage(event, "tool", name, `tool:${callId}`));
      continue;
    }
    if (event.type === "tool/result") {
      const data = record(event.data);
      const callId = typeof data.callId === "string" ? data.callId : String(event.seq);
      messages.push(toMessage(event, "tool", "result", `tool:${callId}`));
    }
  }
  return { messages, hasMore: page.hasMore };
}

/** 标题优先取 session/title；没有就用第一条真实用户消息。 */
export function titleFromEvents(events: DshSessionEvent[], fallback: string): string {
  for (const event of sortedEvents(events)) {
    const title = eventTitle(event);
    if (title?.trim()) return truncate(title.trim(), MAX_TASK_TITLE);
  }
  for (const event of sortedEvents(events)) {
    if (event.type !== "user/message" || eventSourceKind(event) !== "user") continue;
    const text = eventText(event)?.trim();
    if (text) return truncate(text, MAX_TASK_TITLE);
  }
  return truncate(fallback, MAX_TASK_TITLE);
}

function toMessage(event: DshSessionEvent, role: BusMessage["role"], text: string, idPrefix?: string): BusMessage {
  return {
    id: idPrefix ? `${idPrefix}:${event.seq}` : `${role}:${event.seq}`,
    role,
    text,
    createdAt: (event.time ?? new Date(0)).toISOString(),
  };
}

function sortedEvents(events: DshSessionEvent[]) {
  return [...events].sort((left, right) => left.seq - right.seq);
}

function isReplacement(event: DshSessionEvent) {
  const op = record(event.surfaceOp).op;
  return typeof op === "string" && op !== "append";
}

function aged(status: string, updated: Date, now: number) {
  return now - updated.getTime() > IDLE_AFTER_MS ? "idle" : status;
}

function truncate(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit) : text;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
