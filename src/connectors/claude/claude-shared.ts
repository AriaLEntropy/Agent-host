// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeConnector.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// Shared Claude domain types and the pure fillers/text helpers that the Swift
// implementation keeps as static members of `ClaudeConnector`. They live here
// so `claude-session-history.ts` and `claude-message-reader.ts` can use them
// without an ESM import cycle. All behaviour is copied from ClaudeConnector.swift.

export type TaskStatus =
  | "running"
  | "waitingApproval"
  | "waitingInput"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle";

export type TaskOrigin = "watch" | "desktop";

/**
 * 标题从哪来。排后面的顶掉排前面的；Claude 起的名字同级也会被新值顶掉。
 * Mirrors `ClaudeConnector.TitleSource` (Int ordering).
 */
export enum TitleSource {
  /** 项目名或「图片」占位——第一条带字的 prompt 来了要换掉。 */
  placeholder = 0,
  /** 第一条 prompt 截断。 */
  prompt = 1,
  /** Claude Code 自己生成的 `ai-title`。 */
  generated = 2,
  /** 桌面 app 侧栏上的标题（`custom-title`）。 */
  named = 3,
}

/** prompt 同级不换：标题是"这个会话在干什么"，不是"最后一句话"。 */
export function titleSourceReplaces(source: TitleSource, current: TitleSource): boolean {
  return source > current || (source === current && source >= TitleSource.generated);
}

export type PendingOption = {
  label: string;
  description?: string;
};

export type PendingQuestion = {
  id: string;
  question: string;
  header?: string;
  multiSelect?: true;
  options: PendingOption[];
};

/**
 * 协议 2.14 的挂起请求。`BusPendingRequest` 还没有 `question` / `questions`，
 * 这里保留上游完整形状，赋值给 `BusTask.pendingRequest` 时按结构兼容处理。
 */
export type ClaudePendingRequest = {
  id: string;
  kind: "command" | "fileChange" | "permission" | "input";
  summary: string;
  detail?: string;
  question?: string;
  questions?: PendingQuestion[];
};

export type ClaudeFailureDiagnosis = {
  kind: string;
  folder?: string;
  resetsAt?: string;
};

export type ModelOption = {
  id: string;
  displayName: string;
  efforts?: string[];
  defaultEffort?: string;
};

/** 协议上限（同 PendingQuestion.maxQuestions / maxOptions）。 */
export const MAX_QUESTIONS = 8;
export const MAX_OPTIONS = 16;
export const MAX_EFFORTS = 8;
export const MAX_EFFORT_LENGTH = 16;

/** `ClaudeConnector.titleLimit`。 */
export const TITLE_LIMIT = 80;
/** `ClaudeConnector.lastMessageLimit`。 */
export const LAST_MESSAGE_LIMIT = 500;
/** `ClaudeConnector.detailLimit`。 */
export const DETAIL_LIMIT = 2000;
/** `ClaudeConnector.imageOnlyTitle`。 */
export const IMAGE_ONLY_TITLE = "图片";

/** 协议时间：秒精度 UTC、不带小数（`YYYY-MM-DDTHH:MM:SSZ`）。 */
export function protocolTimestamp(date: Date = new Date()): string {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "1970-01-01T00:00:00Z";
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** transcript 的时间戳带毫秒，两种都认；读不出是 null。 */
export function parseISODate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Swift `trimmingCharacters(in: .whitespacesAndNewlines)`。 */
export function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** 只按 `/` 与 `\` 切最后一段，等价于 Windows 上的 `NSString.lastPathComponent`。 */
export function lastPathComponent(value: string): string {
  const parts = value.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length === 0 ? "" : parts[parts.length - 1];
}

/** `SessionFormatting.projectName` / `ClaudeConnector.projectName`。 */
export function projectName(path: string): string {
  const trimmedPath = path.endsWith("/") ? path.slice(0, -1) : path;
  return lastPathComponent(trimmedPath);
}

/** Swift `JSONSerialization` 的 `.sortedKeys` 文本（用于稳定比较与回写）。 */
export function sortedJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** `.prettyPrinted, .sortedKeys`。 */
export function sortedJsonPretty(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) result[key] = sortValue(source[key]);
    return result;
  }
  return value;
}

/** 只由文字块组成的内容拼成一段；含图片、工具结果等其他块时是 nil。 */
export function plainText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const blocks = content as Array<Record<string, unknown>>;
  if (!blocks.every((block) => recordValue(block).type === "text")) return null;
  return blocks.map((block) => (typeof recordValue(block).text === "string" ? (recordValue(block).text as string) : "")).join("\n");
}

export const interruptionMarkers = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

/** 中断时以 user 身份写的那一行。 */
export function isInterruptionMarker(object: Record<string, unknown>): boolean {
  if (object.type !== "user") return false;
  const message = recordValue(object.message);
  const text = plainText(message.content);
  return text !== null && interruptionMarkers.has(text.trim());
}

/**
 * Claude Code 自己往 transcript 里补的填充行：isMeta、中断标记、无 isApiErrorMessage 的
 * `<synthetic>`（resume 的 "No response requested."）。
 */
export function isFiller(object: Record<string, unknown>): boolean {
  if (object.isMeta === true) return true;
  if (isInterruptionMarker(object)) return true;
  const message = recordValue(object.message);
  return message.model === "<synthetic>" && object.isApiErrorMessage !== true;
}

/** transcript 一行里的 assistant 文本（含过程说明）；不是 assistant 或没有文字就是 nil。 */
export function assistantText(object: Record<string, unknown>, narration?: (block: Record<string, unknown>) => string | null): string | null {
  const role = typeof object.type === "string" ? object.type : object.role;
  if (role !== "assistant" || isFiller(object)) return null;
  const message = recordValue(object.message);
  const content = message.content ?? object.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text.length === 0 ? null : text;
  }
  if (!Array.isArray(content)) return null;
  const blocks = content as Array<Record<string, unknown>>;
  const text = blocks
    .map((block) => {
      const value = recordValue(block);
      if (typeof value.text === "string") return value.text;
      return narration ? narration(value) : null;
    })
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
  return text.length === 0 ? null : text;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 供读取器补路径候选用的小工具；不依赖 ClaudeConnector。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
