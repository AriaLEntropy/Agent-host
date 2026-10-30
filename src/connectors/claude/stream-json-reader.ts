// Ported from botbus-protocol/Sources/BotBusConnectorKit/StreamJSONReader.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import type { Readable } from "node:stream";
import { recordValue } from "./claude-shared.js";

export type StreamJSONResult = {
  sessionID: string | null;
  lastText: string | null;
  /** `result` 行报了错，或者根本没等到 `result`。 */
  failed: boolean;
  /** 报错的 `result` 行自带的原文（协议 3.7 只看它）。 */
  errorText: string | null;
};

/**
 * 读 `claude -p --output-format stream-json --verbose` 的 stdout。
 *
 * 只关心三件事：`system/init` 的 session id、assistant 的最后一段文本、`result`
 * 行的成败。`control_request` / `control_cancel_request` 原样交给 `onControl`。
 * 其余类型一律忽略；解析全程容错。
 */
export class StreamJSONReader {
  private readonly handle: Readable;
  private buffer: Buffer = Buffer.alloc(0);
  private sessionID: string | null = null;
  private lastText: string | null = null;
  private errorText: string | null = null;
  private sawResult = false;
  private failed = false;
  private finished = false;
  private started = false;

  onSessionID?: (sessionID: string) => void;
  onFinished?: (result: StreamJSONResult) => void;
  onControl?: (line: Buffer, sessionID: string | null) => void;
  onResult?: () => void;

  constructor(handle: Readable) {
    this.handle = handle;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.handle.on("data", (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (data.length === 0) {
        this.finish();
        return;
      }
      this.consume(data);
    });
    this.handle.on("end", () => this.finish());
    this.handle.on("close", () => this.finish());
    this.handle.on("error", () => this.finish());
  }

  /** 幂等：进程退出与读到 EOF 会各调一次，只有第一次作数。 */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const result: StreamJSONResult = {
      sessionID: this.sessionID,
      lastText: this.lastText,
      failed: this.failed || !this.sawResult,
      errorText: this.errorText,
    };
    this.onFinished?.(result);
  }

  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const lines: Buffer[] = [];
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      lines.push(this.buffer.subarray(0, newline));
      this.buffer = this.buffer.subarray(newline + 1);
      newline = this.buffer.indexOf(0x0a);
    }
    // 上限只是防一个坏掉的流把内存吃光。
    if (this.buffer.length > 1 << 20) this.buffer = Buffer.alloc(0);

    let newSessionID: string | null = null;
    const controls: Array<{ line: Buffer; sessionID: string | null }> = [];
    let sawResultLine = false;

    for (const line of lines) {
      let object: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line.toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        object = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (object.type) {
        case "system": {
          // 只认 init：`--resume` 时 SessionStart hook 的临时 id 排在它前面。
          if (
            this.sessionID === null &&
            object.subtype === "init" &&
            typeof object.session_id === "string" &&
            object.session_id.length > 0
          ) {
            this.sessionID = object.session_id;
            newSessionID = object.session_id;
          }
          break;
        }
        case "assistant": {
          const text = textIn(object);
          if (text !== null && text.length > 0) this.lastText = text;
          break;
        }
        case "result": {
          this.sawResult = true;
          const isError = object.is_error === true;
          const subtype = typeof object.subtype === "string" ? object.subtype : "success";
          if (isError || subtype !== "success") this.failed = true;
          if (typeof object.result === "string" && object.result.length > 0) {
            this.lastText = object.result;
            if (isError) this.errorText = object.result;
          }
          sawResultLine = true;
          break;
        }
        case "control_request":
        case "control_cancel_request":
          controls.push({ line: Buffer.from(line), sessionID: this.sessionID });
          break;
        default:
          break;
      }
    }

    if (newSessionID !== null) this.onSessionID?.(newSessionID);
    for (const control of controls) this.onControl?.(control.line, control.sessionID);
    if (sawResultLine) this.onResult?.();
  }
}

/** `{"message":{"content":[{"type":"text","text":…}]}}` 里的文本，拼起来。 */
function textIn(object: Record<string, unknown>): string | null {
  const message = recordValue(object.message);
  const content = message.content ?? object.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return null;
  return (content as Array<Record<string, unknown>>)
    .map((block) => (typeof recordValue(block).text === "string" ? (recordValue(block).text as string) : ""))
    .join("\n")
    .trim();
}
