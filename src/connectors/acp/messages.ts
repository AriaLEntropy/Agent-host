/**
 * ACP（Agent Client Protocol）里 BotBus 用到的那一小部分：消息解析、工具调用合并、
 * 审批选项与「允许范围」提问。字段名以 ACP v1 schema 为准，解析一律宽松：认不出的
 * 字段跳过，缺必需字段的整条当"不认识"，一条坏消息不能让整个会话停摆。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/Acp/AcpMessages.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 */
import type { BusPendingQuestion } from "../../bus/store.js";

/** `session/prompt` 的 `stopReason`。 */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type AcpImage = { base64: string; mimeType: string };

/** 一次工具调用（`tool_call` / `tool_call_update` / 审批请求里的 `toolCall`）。 */
export type AcpToolCall = {
  toolCallId: string;
  title?: string;
  /** `read | edit | delete | move | search | execute | think | fetch | switch_mode | other` */
  kind?: string;
  /** `pending | in_progress | completed | failed` */
  status?: string;
  /**
   * 原始参数（比如要执行的命令）。与 `contentText` 分开存：同一个 `toolCallId` 后续的
   * `tool_call_update`（含审批请求里的 `toolCall`）常常只带一句面向人的说明文字，
   * 合并时不能让这句话把原始命令顶掉，否则手机上的审批卡片就看不到真正要跑的命令了。
   */
  rawInput?: string;
  /** 没有 `rawInput` 时从 `content` 里拼出来的文本。 */
  contentText?: string;
};

export function toolCallDetail(call: AcpToolCall): string | undefined {
  return call.rawInput ?? call.contentText;
}

/** 协议里的 `PendingRequest.kind`。 */
export function pendingKind(call: AcpToolCall): "command" | "fileChange" | "permission" {
  switch (call.kind) {
    case "execute":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "fileChange";
    default:
      return "permission";
  }
}

export type AcpPermissionOption = { optionId: string; name: string; kind: string };

/** agent 发来的 `session/request_permission`（已经解析过）。 */
export type AcpPermissionRequest = {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
};

export type AcpSessionUpdate =
  | { kind: "userMessage"; text: string; images: AcpImage[] }
  | { kind: "agentMessage"; text: string; images: AcpImage[] }
  | { kind: "thought" }
  | { kind: "toolCall"; call: AcpToolCall }
  | { kind: "toolCallUpdate"; call: AcpToolCall }
  | { kind: "sessionInfo"; title?: string }
  | { kind: "other"; type: string };

/** `session/update` 里 BotBus 关心的几种；认不出的返回 `other`。 */
export function parseSessionUpdate(update: Record<string, unknown>): AcpSessionUpdate {
  const type = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  switch (type) {
    case "user_message_chunk": {
      const content = contentOf(update.content);
      return { kind: "userMessage", text: content.text, images: content.images };
    }
    case "agent_message_chunk": {
      const content = contentOf(update.content);
      return { kind: "agentMessage", text: content.text, images: content.images };
    }
    case "agent_thought_chunk":
      return { kind: "thought" };
    case "tool_call": {
      const call = parseToolCall(update);
      return call ? { kind: "toolCall", call } : { kind: "other", type };
    }
    case "tool_call_update": {
      const call = parseToolCall(update);
      return call ? { kind: "toolCallUpdate", call } : { kind: "other", type };
    }
    case "session_info_update":
      return {
        kind: "sessionInfo",
        ...(typeof update.title === "string" ? { title: update.title } : {}),
      };
    default:
      return { kind: "other", type };
  }
}

export function parseToolCall(value: unknown): AcpToolCall | undefined {
  const json = record(value);
  const id = typeof json.toolCallId === "string" ? json.toolCallId : "";
  if (!id) return undefined;
  const call: AcpToolCall = { toolCallId: id };
  if (typeof json.title === "string") call.title = json.title;
  if (typeof json.kind === "string") call.kind = json.kind;
  if (typeof json.status === "string") call.status = json.status;
  const raw = rawInputText(json.rawInput);
  if (raw !== undefined) call.rawInput = raw;
  const text = contentText(json.content);
  if (text !== undefined) call.contentText = text;
  return call;
}

/**
 * 合并一条 `tool_call_update`：它只带变了的字段，`rawInput` 与 `contentText`
 * 各自独立合并——一条只有说明文字、没有 `rawInput` 的更新不能覆盖掉之前记住的原始命令。
 */
export function mergeToolCall(base: AcpToolCall, update: AcpToolCall): AcpToolCall {
  const merged: AcpToolCall = { toolCallId: base.toolCallId };
  const title = update.title ?? base.title;
  if (title !== undefined) merged.title = title;
  const kind = update.kind ?? base.kind;
  if (kind !== undefined) merged.kind = kind;
  const status = update.status ?? base.status;
  if (status !== undefined) merged.status = status;
  const rawInput = update.rawInput ?? base.rawInput;
  if (rawInput !== undefined) merged.rawInput = rawInput;
  const contentText = update.contentText ?? base.contentText;
  if (contentText !== undefined) merged.contentText = contentText;
  return merged;
}

/** 解析 `session/request_permission` 的 params；缺 sessionId 或 toolCall 返回 undefined。 */
export function parsePermissionRequest(params: Record<string, unknown>): AcpPermissionRequest | undefined {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  const toolCall = parseToolCall(params.toolCall);
  if (!sessionId || !toolCall) return undefined;
  return { sessionId, toolCall, options: parsePermissionOptions(params.options) };
}

export function parsePermissionOptions(value: unknown): AcpPermissionOption[] {
  if (!Array.isArray(value)) return [];
  const options: AcpPermissionOption[] = [];
  for (const item of value) {
    const json = record(item);
    const optionId = typeof json.optionId === "string" ? json.optionId : "";
    const kind = typeof json.kind === "string" ? json.kind : "";
    if (!optionId || !kind) continue;
    options.push({
      optionId,
      name: typeof json.name === "string" ? json.name : optionId,
      kind,
    });
  }
  return options;
}

/**
 * 协议 2.14：审批上的「允许范围」。`allow_*` 选项按 once 在前、always 在后列成一道单选，
 * 第一个就是 `optionIdFor(.allow)` 会挑的那个——手机默认选它，旧手机不带 `answers` 效果不变。
 * 拒绝类选项不列（那是「拒绝」按钮）。同名的只留第一个：手机回的是 `label`。
 */
export const PERMISSION_SCOPE_QUESTION_ID = "scope";

export function allowOptions(options: readonly AcpPermissionOption[]): AcpPermissionOption[] {
  const seen = new Set<string>();
  const result: AcpPermissionOption[] = [];
  for (const kind of ["allow_once", "allow_always"]) {
    for (const option of options) {
      if (option.kind !== kind || seen.has(option.name)) continue;
      seen.add(option.name);
      result.push(option);
    }
  }
  return result;
}

export function permissionQuestions(
  options: readonly AcpPermissionOption[],
): BusPendingQuestion[] | undefined {
  const allow = allowOptions(options);
  if (allow.length === 0) return undefined;
  return [
    {
      id: PERMISSION_SCOPE_QUESTION_ID,
      question: "允许范围",
      options: allow.map((option) => ({ label: option.name })),
    },
  ];
}

/** 手机上的允许 / 拒绝挑哪个选项：先挑"一次性"的，没有才退到"总是"。 */
export function optionIdFor(
  options: readonly AcpPermissionOption[],
  decision: "allow" | "deny",
  answers?: Record<string, string[]>,
): string | undefined {
  if (decision === "allow") {
    const picked = answers?.[PERMISSION_SCOPE_QUESTION_ID];
    if (picked?.length === 1) {
      const hit = allowOptions(options).find((option) => option.name === picked[0]);
      if (hit) return hit.optionId;
    }
  }
  const order = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const hit = options.find((option) => option.kind === kind);
    if (hit) return hit.optionId;
  }
  return undefined;
}

/** 一轮结束后的任务状态；认不出的停止原因按 `end_turn` 处理（与上游一致）。 */
export function stopStatus(
  reason: AcpStopReason | undefined,
): "completed" | "interrupted" | "failed" {
  switch (reason) {
    case "cancelled":
      return "interrupted";
    case "refusal":
    case "max_tokens":
    case "max_turn_requests":
      return "failed";
    default:
      return "completed";
  }
}

/** 没有回复文字时给手机看的说明。 */
export function stopExplanation(reason: AcpStopReason): string | undefined {
  switch (reason) {
    case "refusal":
      return "agent 拒绝继续这次请求";
    case "max_tokens":
      return "回复达到了 token 上限";
    case "max_turn_requests":
      return "这一轮的模型请求次数超过了上限";
    default:
      return undefined;
  }
}

export function singleLine(text: string): string {
  return text
    .split(/\r\n|[\r\n\u2028\u2029]/u)
    .join(" ")
    .trim();
}

/** 按 Unicode 码点截断，避免把代理对切成半个字符。 */
export function truncate(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * `content` 是单个 ContentBlock：text 块给文字，image 块给图（base64 + mimeType）。
 * 其余类型（resource、audio 等）一律当空，不影响同一轮里的其他片段。
 */
function contentOf(value: unknown): { text: string; images: AcpImage[] } {
  const block = record(value);
  if (block.type === "text") {
    return { text: typeof block.text === "string" ? block.text : "", images: [] };
  }
  if (
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0 &&
    typeof block.mimeType === "string"
  ) {
    return { text: "", images: [{ base64: block.data, mimeType: block.mimeType }] };
  }
  return { text: "", images: [] };
}

function rawInputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** 数组形式的 `content`：每段取 `content.text` 或 `text`，拼成一行一段。 */
function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts: string[] = [];
  for (const item of value) {
    const block = record(item);
    const nested = record(block.content);
    const text = typeof nested.text === "string" ? nested.text : block.text;
    if (typeof text === "string") texts.push(text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}
