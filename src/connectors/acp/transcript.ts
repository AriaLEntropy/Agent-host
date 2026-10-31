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
import type { ImageSource, TranscriptEntry } from "../ported/contract.js";
import { mergeToolCall, truncate, type AcpImage, type AcpToolCall } from "./messages.js";

/** 上游 `AcpTranscript.maxEntries`：内存里最多留这么多条，超出的从最早的丢。 */
export const ACP_TRANSCRIPT_MAX_ENTRIES = 500;

/** 工具行正文上限（上游 `maxToolTextLength`）。 */
export const MAX_TOOL_TEXT_LENGTH = 200;

type Item = {
  id: string;
  role: BusMessage["role"];
  text: string;
  images: ImageSource[];
  createdAt: string;
};

/**
 * ACP 的图片块 → 读取器认的 `ImageSource`。类型必须是 `image/*` 且 base64
 * 解得出非空字节；其余当没有这张图，不占位也不让整条消息失败。
 */
export function imageSources(images: readonly AcpImage[]): ImageSource[] {
  const result: ImageSource[] = [];
  for (const image of images) {
    const contentType = image.mimeType.trim().toLowerCase();
    if (!contentType.startsWith("image/") || contentType.length <= "image/".length) continue;
    if (!image.base64.trim()) continue;
    const data = Buffer.from(image.base64, "base64");
    if (data.length === 0) continue;
    result.push({ type: "data", data, contentType });
  }
  return result;
}

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

  appendText(
    role: "user" | "agent",
    text: string,
    images: readonly ImageSource[],
    createdAt: string,
  ) {
    if (!text && images.length === 0) return;
    const last = this.items.at(-1);
    if (last && last.role === role && !this.pendingNewTurn) {
      last.text += text;
      last.images.push(...images);
      return;
    }
    if (role === "user" || this.pendingNewTurn) {
      this.turn += 1;
      this.segment = 0;
    }
    this.segment += 1;
    this.pendingNewTurn = false;
    this.items.push({ id: `${this.turn}-${this.segment}`, role, text, images: [...images], createdAt });
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
    this.items.push({ id, role: "tool", text, images: [], createdAt });
    this.trim();
  }

  /** 合并一条工具更新：先与内存里的同 id 调用合并，再原地更新这一行。 */
  toolUpdate(update: AcpToolCall, base: AcpToolCall | undefined, createdAt: string) {
    this.tool(base ? mergeToolCall(base, update) : update, createdAt);
  }

  /** 只要消息的调用方（测试、旧接口）：图片被丢掉，`Message.attachments` 也不会有。 */
  entries(): BusMessage[] {
    return this.transcriptEntries().map((entry) => entry.message);
  }

  /** 外发用：消息加上图片（FR-14.5.1），由 runtime 落进产物目录再填 `attachments`。 */
  transcriptEntries(): TranscriptEntry[] {
    return this.items.map((item) => ({
      message: {
        id: item.id,
        role: item.role,
        text: item.role === "tool" ? truncate(item.text, MAX_TOOL_TEXT_LENGTH) : item.text.trim(),
        createdAt: item.createdAt,
      },
      images: item.images,
      pathCandidates: [],
    }));
  }

  private trim() {
    if (this.items.length > ACP_TRANSCRIPT_MAX_ENTRIES) {
      this.items.splice(0, this.items.length - ACP_TRANSCRIPT_MAX_ENTRIES);
    }
  }
}
