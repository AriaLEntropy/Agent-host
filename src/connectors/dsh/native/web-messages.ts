// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshWebMessages.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// dsh 0.1.5-rc.3 会话日志与 `dsh web` 内部接口的消息形状。都是内部格式，升级可能改；
// 解析一律宽松：缺必需字段的整条当"不认识"（返回 undefined 或 other），不抛错。
// 时间在 dsh 里都是毫秒整数。

import { DshToolsContext } from "./tools-context.js";

export type Json = unknown;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function jsonPath(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) current = record(current)[key];
  return current;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** `.int` 或恰好是整数的 `.double`。 */
export function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** 毫秒时间戳 → Date。 */
export function dshDate(value: unknown): Date | undefined {
  const ms = numberValue(value);
  return ms === undefined ? undefined : new Date(ms);
}

// MARK: - 会话头

/** 会话头：JSONL 首行（`{type:"session", …}`）或 follow 流 snapshot 的 `header`（不带 `type`）。 */
export type DshSessionHeader = {
  id: string;
  createdAt?: Date;
  cwd?: string;
  /** 直接上级会话：subagent 与 fork 出来的会话都有。 */
  parentSession?: string;
  /** `"subagent"` = 子 agent 的会话（与父会话同目录）；fork 没有这个字段。 */
  origin?: string;
  delegationDepth: number;
  isSeeded: boolean;
};

export function sessionHeaderFromJson(value: unknown): DshSessionHeader | undefined {
  const json = record(value);
  const type = stringValue(json.type);
  if (type !== undefined && type !== "session") return undefined;
  const id = stringValue(json.id);
  if (!id) return undefined;
  return {
    id,
    createdAt: dshDate(json.createdAt),
    cwd: nonEmptyString(json.cwd),
    parentSession: stringValue(json.parentSession),
    origin: stringValue(json.origin),
    delegationDepth: integerValue(json.delegationDepth) ?? 0,
    isSeeded: boolValue(json.isSeeded) ?? false,
  };
}

/** 子 agent 的会话：不当任务列出来。只看 `origin` 与委派深度，fork 照常列。 */
export function isSubagentHeader(header: DshSessionHeader): boolean {
  return header.origin === "subagent" || header.delegationDepth > 0;
}

// MARK: - 事件

/** 会话日志里的一个事件 `{type, seq, time, data}`。JSONL 的行与 follow 流都解成它。 */
export type DshSessionEvent = {
  type: string;
  seq: number;
  time?: Date;
  data: unknown;
  /** `"append"` 或压缩上下文时的替换 `{op:"replace",…}`；非消息事件没有。 */
  surfaceOp?: unknown;
};

export function sessionEventFromJson(value: unknown): DshSessionEvent | undefined {
  let body = record(value);
  if (body.type === "event" && isRecord(body.event)) body = body.event;
  const type = stringValue(body.type);
  if (type === undefined || type === "session" || type === "event") return undefined;
  const seq = integerValue(body.seq);
  if (seq === undefined) return undefined;
  return {
    type,
    seq,
    time: dshDate(body.time),
    data: body.data ?? null,
    surfaceOp: body.surfaceOp,
  };
}

/** 压缩上下文时写的替换副本（`surfaceOp` 是 `{op:"replace",…}` 而不是 `"append"`）。 */
export function isReplacement(event: DshSessionEvent): boolean {
  if (event.surfaceOp === undefined || event.surfaceOp === null) return false;
  return event.surfaceOp !== "append";
}

/** `user/message` 的来源：`user` 才是人发的提示词；运行时上下文是 `plugin`，技能目录是 `skill-catalog`。 */
export function eventSourceKind(event: DshSessionEvent): string | undefined {
  if (event.type !== "user/message") return undefined;
  return stringValue(jsonPath(event.data, "source", "kind"));
}

/** `user/message` / `assistant/message` 的文字（只拼 `text` 段）。 */
export function eventText(event: DshSessionEvent): string | undefined {
  if (event.type === "user/message") {
    const text = texts(jsonPath(event.data, "content"));
    if (text === undefined) return undefined;
    return DshToolsContext.visibleText(text, stringValue(jsonPath(event.data, "source", "rpcId")));
  }
  if (event.type === "assistant/message") return texts(jsonPath(event.data, "message", "content"));
  return undefined;
}

function texts(content: unknown): string | undefined {
  const blocks = arrayValue(content);
  if (!blocks) return undefined;
  return blocks
    .flatMap((block) => {
      const item = record(block);
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
}

/** `session/title` 的标题。 */
export function eventTitle(event: DshSessionEvent): string | undefined {
  if (event.type !== "session/title") return undefined;
  return stringValue(record(event.data).title);
}

// MARK: - turn/end

/** `turn/end.reason.kind`：`completed | aborted | interrupted | error | blocked | max-tokens`。 */
export type DshTurnEndReason =
  | { kind: "completed" }
  | { kind: "aborted" }
  | { kind: "interrupted" }
  /** 带 dsh 给的错误文本（模型报错等）：可能含请求细节，只给界面，不进公开日志。 */
  | { kind: "error"; message?: string }
  | { kind: "blocked" }
  | { kind: "maxTokens" }
  | { kind: "other"; raw: string };

export function turnEndReasonFromJson(value: unknown): DshTurnEndReason {
  const kind = stringValue(record(value).kind) ?? "";
  switch (kind) {
    case "completed":
      return { kind: "completed" };
    case "aborted":
      return { kind: "aborted" };
    case "interrupted":
      return { kind: "interrupted" };
    case "error":
      return { kind: "error", message: stringValue(jsonPath(value, "error", "message")) };
    case "blocked":
      return { kind: "blocked" };
    case "max-tokens":
      return { kind: "maxTokens" };
    default:
      return { kind: "other", raw: kind };
  }
}

export function eventTurnEndReason(event: DshSessionEvent): DshTurnEndReason | undefined {
  if (event.type !== "turn/end") return undefined;
  return turnEndReasonFromJson(record(event.data).reason ?? null);
}

/** completed → completed；aborted / interrupted → interrupted；其余 → failed。 */
export function turnEndStatus(reason: DshTurnEndReason): "completed" | "interrupted" | "failed" {
  switch (reason.kind) {
    case "completed":
      return "completed";
    case "aborted":
    case "interrupted":
      return "interrupted";
    default:
      return "failed";
  }
}

/** 值相等（DshLiveState 比较用）。 */
export function turnEndKey(reason: DshTurnEndReason | undefined): string {
  if (!reason) return "";
  return reason.kind === "error"
    ? `error:${reason.message ?? ""}`
    : reason.kind === "other"
      ? `other:${reason.raw}`
      : reason.kind;
}

// MARK: - web 列表

/** `session/list` 的一项，也是 `$events` 里 `api-session/added` 的参数。 */
export type DshWebSessionSummary = {
  sessionId: string;
  /** web 算的是 `max(createdAt, lastPromptAt)`，不是文件修改时间。 */
  updatedAt?: Date;
  running: boolean;
  /** 从没开过一轮（`turn/start`）的空会话。 */
  blank: boolean;
  cwd?: string;
  parentSessionId?: string;
  origin?: string;
  title?: string;
  /** 投影缓存算到的那条事件的 seq。**可能过时**，不能拿来当 `session/page` 的游标。 */
  asOfSeq?: number;
};

export function summaryFromJson(value: unknown): DshWebSessionSummary | undefined {
  const json = record(value);
  const id = nonEmptyString(json.sessionId);
  if (!id) return undefined;
  return {
    sessionId: id,
    updatedAt: dshDate(json.updatedAt),
    running: boolValue(json.running) ?? false,
    blank: boolValue(json.blank) ?? false,
    cwd: nonEmptyString(json.cwd),
    parentSessionId: stringValue(json.parentSessionId),
    origin: stringValue(json.origin),
    title: stringValue(jsonPath(json, "projections", "values", "title")),
    asOfSeq: integerValue(jsonPath(json, "projections", "asOfSeq")),
  };
}

export function isSubagentSummary(summary: DshWebSessionSummary): boolean {
  return summary.origin === "subagent";
}

// MARK: - $events

export type DshSessionEmit =
  | { type: "added"; summary: DshWebSessionSummary }
  | { type: "removed"; sessionId: string }
  | { type: "status"; sessionId: string; running: boolean }
  | { type: "activity"; sessionId: string; at?: Date }
  | { type: "error"; sessionId: string; message?: string }
  | { type: "other"; event: string };

export function sessionEmitFrom(event: string, args: readonly unknown[]): DshSessionEmit {
  const first = args[0];
  const sessionId = stringValue(first);
  switch (event) {
    case "api-session/added": {
      const summary = summaryFromJson(first);
      return summary ? { type: "added", summary } : { type: "other", event };
    }
    case "api-session/removed":
      return sessionId !== undefined ? { type: "removed", sessionId } : { type: "other", event };
    case "api-session/status": {
      const running = boolValue(args[1]);
      if (sessionId === undefined || running === undefined) return { type: "other", event };
      return { type: "status", sessionId, running };
    }
    case "api-session/activity":
      return sessionId !== undefined
        ? { type: "activity", sessionId, at: dshDate(args[1]) }
        : { type: "other", event };
    case "api-session/error":
      return sessionId !== undefined
        ? { type: "error", sessionId, message: stringValue(args[1]) }
        : { type: "other", event };
    default:
      return { type: "other", event };
  }
}

/** `ask_user_question` 的一道题。 */
export type DshQuestion = {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options: string[];
  multiSelect: boolean;
};

export function questionFromJson(value: unknown): DshQuestion | undefined {
  const json = record(value);
  const id = nonEmptyString(json.id);
  if (!id) return undefined;
  return {
    id,
    question: stringValue(json.question) ?? "",
    header: stringValue(json.header),
    detail: stringValue(json.detail),
    options: arrayValue(json.options)?.flatMap((item) => {
      const label = stringValue(record(item).label);
      return label !== undefined ? [label] : [];
    }) ?? [],
    multiSelect: boolValue(json.multiSelect) ?? false,
  };
}

/** 一条 waterfall：`approval/request` 或 `user-questions/request`。`agentId` 就是会话 id。 */
export type DshWaterfallRequest =
  | { type: "approval"; toolName?: string; callId?: string; reason?: string }
  | { type: "questions"; questions: DshQuestion[] }
  | { type: "other"; event: string };

export type DshWaterfall = {
  eventId: string;
  sessionId: string;
  request: DshWaterfallRequest;
};

export function waterfallFromJson(value: unknown): DshWaterfall | undefined {
  const json = record(value);
  const eventId = nonEmptyString(json.eventId);
  const sessionId = nonEmptyString(json.agentId);
  if (!eventId || !sessionId) return undefined;
  const request = record(json.request ?? null);
  const event = stringValue(json.event) ?? "";
  switch (event) {
    case "approval/request":
      return {
        eventId,
        sessionId,
        request: {
          type: "approval",
          toolName: stringValue(request.toolName),
          callId: stringValue(request.callId),
          reason: stringValue(request.reason),
        },
      };
    case "user-questions/request": {
      const questions = (arrayValue(request.questions) ?? []).flatMap((item) => {
        const question = questionFromJson(item);
        return question ? [question] : [];
      });
      return { eventId, sessionId, request: { type: "questions", questions } };
    }
    default:
      return { eventId, sessionId, request: { type: "other", event } };
  }
}

/** `$events` 流里的一项（`item.value`）。 */
export type DshEventsFrame =
  | { type: "ready"; clientId: string; home?: string }
  | { type: "emit"; emit: DshSessionEmit }
  | { type: "waterfall"; waterfall: DshWaterfall }
  | { type: "cancel"; eventId: string }
  | { type: "other"; raw: string };

export function eventsFrameFromJson(value: unknown): DshEventsFrame {
  const json = record(value);
  switch (stringValue(json.type) ?? "") {
    case "ready": {
      const clientId = nonEmptyString(json.clientId);
      return clientId !== undefined
        ? { type: "ready", clientId, home: stringValue(jsonPath(json, "host", "home")) }
        : { type: "other", raw: "ready" };
    }
    case "emit":
      return {
        type: "emit",
        emit: sessionEmitFrom(stringValue(json.event) ?? "", arrayValue(json.args) ?? []),
      };
    case "waterfall": {
      const waterfall = waterfallFromJson(json);
      return waterfall ? { type: "waterfall", waterfall } : { type: "other", raw: "waterfall" };
    }
    case "cancel": {
      const eventId = stringValue(json.eventId);
      return eventId !== undefined ? { type: "cancel", eventId } : { type: "other", raw: "cancel" };
    }
    default:
      return { type: "other", raw: stringValue(json.type) ?? "" };
  }
}

/** `session/follow` 流里的一项。 */
export type DshFollowFrame =
  | {
      type: "snapshot";
      header?: DshSessionHeader;
      cursor?: number;
      events: DshSessionEvent[];
      hasMore: boolean;
    }
  | { type: "event"; event: DshSessionEvent }
  | { type: "other"; raw: string };

export function followFrameFromJson(value: unknown): DshFollowFrame {
  const json = record(value);
  switch (stringValue(json.type) ?? "") {
    case "snapshot":
      return {
        type: "snapshot",
        header: sessionHeaderFromJson(json.header),
        cursor: integerValue(json.cursor),
        events: (arrayValue(json.records) ?? []).flatMap((item) => {
          const event = sessionEventFromJson(item);
          return event ? [event] : [];
        }),
        hasMore: boolValue(json.hasMore) ?? false,
      };
    case "event": {
      const event = sessionEventFromJson(json);
      return event ? { type: "event", event } : { type: "other", raw: "event" };
    }
    default:
      return { type: "other", raw: stringValue(json.type) ?? "" };
  }
}
