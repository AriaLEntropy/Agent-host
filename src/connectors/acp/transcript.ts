/**
 * 一个 ACP 会话的对话记录，由 `session/update` 一条条拼出来（ACP 没有"读历史"的调用，
 * 只能靠 `session/load` 重放）。
 *
 * 消息 id 按"第几轮-第几段"编：用户消息开启新的一轮。同一段历史重放时编出来的 id 一样，
 * 手机据此去重（协议要求同一条消息重复拉取时 id 稳定）。工具行用 `tool-<toolCallId>`。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/Acp/AcpSession.swift
 * (`AcpTranscript`; Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 */
import type { BusMessage } from "../../bus/store.js";
import { mergeToolCall, truncate, type AcpToolCall } from "./messages.js";

/** 上游 `AcpTranscript.maxEntries`：内存里最多留这么多条，超出的从最早的丢。 */
export const ACP_TRANSCRIPT_MAX_ENTRIES = 500;

/** 工具行正文上限（上游 `maxToolTextLength`）。 */
export const MAX_TOOL_TEXT_LENGTH = 200;

type Item = { id: string; role: BusMessage["role"]; text: string; createdAt: string };

export class AcpTranscript {
  private items: Item[] = [];
  private turn = 0;
  private segment = 0;
  /**
   * `startTurn()` 打的标记：下一条真正落地的内容（不管角色）都要另起一轮，不能跟上一轮的
   * 最后一条合并。只有真正落地一条新 item 才清掉；空 prompt 不消费它。重放（`session/load`
   * 之后逐条 `apply`）从不调用 `startTurn`，所以重放出来的 id 与之前完全一样。
   */
  private pendingNewTurn = false;

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  reset() {
    this.items = [];
    this.turn = 0;
    this.segment = 0;
    this.pendingNewTurn = false;
  }

  /** 标记"下一条内容要另起一轮"，防止被打断的上一轮尾巴和这一轮的第一句粘在一起。 */
  startTurn() {
    this.pendingNewTurn = true;
  }

  appendText(role: "user" | "agent", text: string, createdAt: string) {
    if (!text) return;
    const last = this.items.at(-1);
    if (last && last.role === role && !this.pendingNewTurn) {
      last.text += text;
      return;
    }
    if (role === "user" || this.pendingNewTurn) {
      this.turn += 1;
      this.segment = 0;
    }
    this.segment += 1;
    this.pendingNewTurn = false;
    this.items.push({ id: `${this.turn}-${this.segment}`, role, text, createdAt });
    this.trim();
  }

  /** 同一条工具调用按 `tool-<toolCallId>` 原地更新，不追加新行。 */
  tool(call: AcpToolCall, createdAt: string) {
    const id = `tool-${call.toolCallId}`;
    const text = call.title ?? call.kind ?? "tool";
    const existing = this.items.map((item) => item.id).lastIndexOf(id);
    if (existing >= 0) {
      this.items[existing]!.text = text;
      return;
    }
    this.items.push({ id, role: "tool", text, createdAt });
    this.trim();
  }

  /** 合并一条工具更新：先与内存里的同 id 调用合并，再原地更新这一行。 */
  toolUpdate(update: AcpToolCall, base: AcpToolCall | undefined, createdAt: string) {
    this.tool(base ? mergeToolCall(base, update) : update, createdAt);
  }

  entries(): BusMessage[] {
    return this.items.map((item) => ({
      id: item.id,
      role: item.role,
      text: item.role === "tool" ? truncate(item.text, MAX_TOOL_TEXT_LENGTH) : item.text.trim(),
      createdAt: item.createdAt,
    }));
  }

  private trim() {
    if (this.items.length > ACP_TRANSCRIPT_MAX_ENTRIES) {
      this.items.splice(0, this.items.length - ACP_TRANSCRIPT_MAX_ENTRIES);
    }
  }
}
