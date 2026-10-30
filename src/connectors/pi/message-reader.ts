/**
 * Ported from botbus-protocol/Sources/BotBusConnectors/Pi/PiMessageReader.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 从 `~/.pi/agent/sessions/*\/<时间戳>_<sessionId>.jsonl` 读对话记录。
 *
 * 只取**当前分支**（最后一条沿 `parentId` 回溯）：`/tree` 分叉后被丢下的那一支不是这个会话的现状，
 * 混进来会让一问两答看起来像模型自相矛盾。映射：
 * - user 文本与图片 → `.user`（纯图片的也算一条）；assistant 文本 → `.agent`（thinking 不进）；
 * - assistant 的每个 toolCall → 一行 `.tool` 摘要；toolResult 跳过（正文往往是整个文件）；
 * - bashExecution（用户在 pi 里敲的 `!命令`）→ `.tool` 的 `$ 命令`。
 *
 * id 用 entry 的 id，同一条 entry 里的工具调用加 `#n`，重复拉取时保持稳定。
 */
import { readFile } from "node:fs/promises";
import type { BusMessage } from "../../bus/store.js";
import type { ConnectorKind, ImageSource, MessageReader, TranscriptEntry } from "../ported/contract.js";
import {
  ConnectorError,
  imageFromBase64,
  latestWindow,
  nativeTaskId,
  transcriptEntry,
  withPathCandidates,
} from "../ported/contract.js";
import type { PiPaths, PiSessionEntry } from "./session-reader.js";
import { PiSessionFile, PiSessionReader, isoFromMs, singleLine } from "./session-reader.js";

export type PiMessageReaderOptions = {
  paths?: PiPaths;
  reader?: PiSessionReader;
};

export function createPiMessageReader(options: PiMessageReaderOptions = {}): MessageReader {
  return new PiMessageReader(options);
}

export class PiMessageReader implements MessageReader {
  readonly kind: ConnectorKind = "pi";

  private readonly reader: PiSessionReader;

  constructor(options: PiMessageReaderOptions = {}) {
    this.reader = options.reader ?? new PiSessionReader({ paths: options.paths });
  }

  async entries(
    taskId: string,
    limit: number,
  ): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const sessionID = nativeTaskId(taskId, this.kind);
    const file = await this.reader.sessionFile(sessionID);
    if (!file) throw new ConnectorError("没找到这个 Pi 会话的记录文件");

    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new ConnectorError("读不到会话记录文件");
    }
    const parsed = PiSessionFile.parse(data);
    if (!parsed) throw new ConnectorError("Pi 会话记录的格式认不出来");

    // 路径候选只给窗口里的回复认：先不认路径整理全部，截完再按 id 找回那几条回复的原文。
    const branch = parsed.branch;
    const all = entriesIn(branch, parsed.header.timestamp);
    const { entries: window, hasMore } = latestWindow(all, limit);

    const wanted = new Set(
      window.filter((entry) => entry.message.role === "agent").map((entry) => entry.message.id),
    );
    const rawReplies = new Map<string, string>();
    branch.forEach((entry, ordinal) => {
      if (entry.kind.type !== "message" || entry.kind.message.role !== "assistant") return;
      const id = messageId(entry, ordinal);
      if (wanted.has(id)) rawReplies.set(id, entry.kind.message.text);
    });

    return { entries: addingPathCandidates(window, rawReplies), hasMore };
  }
}

/** entry 没有 id（更早的线性格式）时退回行序；树格式下 id 必在。 */
function messageId(entry: PiSessionEntry, ordinal: number): string {
  return entry.id ?? `entry-${ordinal}`;
}

/** 当前分支上的全部消息，升序，**不带路径候选**（由调用方只给窗口补）。 */
function entriesIn(
  branch: PiSessionEntry[],
  headerTimestamp: number | undefined,
): TranscriptEntry[] {
  const fallback = headerTimestamp ?? 0;
  const result: TranscriptEntry[] = [];
  branch.forEach((entry, ordinal) => {
    if (entry.kind.type !== "message") return;
    const message = entry.kind.message;
    const id = messageId(entry, ordinal);
    const createdAt = isoFromMs(message.timestamp ?? entry.timestamp ?? fallback);

    const append = (
      entryID: string,
      role: BusMessage["role"],
      text: string,
      images: ImageSource[] = [],
    ) => {
      // 截断与判空交给 `transcriptEntry`：只有空白的正文不出气泡，但带图的照留。
      const item = transcriptEntry({ id: entryID, role, text, images, createdAt });
      if (item) result.push(item);
    };

    switch (message.role) {
      case "user": {
        const images: ImageSource[] = [];
        for (const block of message.imageBlocks) {
          const image = imageFromBase64(block.data, block.mimeType);
          if (image) images.push(image);
        }
        append(id, "user", message.text, images);
        break;
      }
      case "assistant":
        append(id, "agent", message.text);
        message.toolCalls.forEach((summary, index) => {
          append(`${id}#${index + 1}`, "tool", summary);
        });
        break;
      case "bashExecution":
        if (message.command !== undefined) {
          append(id, "tool", `$ ${singleLine(message.command)}`);
        }
        break;
      case "toolResult":
      case "other":
        break;
    }
  });
  return result;
}

function addingPathCandidates(
  window: TranscriptEntry[],
  rawReplies: Map<string, string>,
): TranscriptEntry[] {
  return window.map((entry) => {
    if (entry.message.role !== "agent") return entry;
    const raw = rawReplies.get(entry.message.id);
    if (raw === undefined) return entry;
    return withPathCandidates(entry, raw);
  });
}

// MARK: - 回复里的本机文件路径

/**
 * 兼容旧导出：识别逻辑已统一到 `ported/transcript-file-refs.ts`
 * （上游 `TranscriptFileRefs.candidates(in:)`）。
 */
export { candidatesIn as transcriptFileRefCandidates } from "../ported/transcript-file-refs.js";
