// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeControl.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import type { Writable } from "node:stream";
import { sortedJson } from "./claude-shared.js";

/**
 * 手机那一轮的审批：`claude -p --permission-prompt-tool stdio` 的控制协议。
 *
 * claude 需要人点头时在 stdout 写一行 `control_request`，等 stdin 回一行
 * `control_response`。
 */
export type ClaudeControlRequest =
  | {
      kind: "canUseTool";
      requestID: string;
      toolName: string;
      /** 原样的工具入参（JSON 对象）序列化后的文本；允许时整份带回 `updatedInput`。 */
      input: string;
      /** 解析后的同一份入参，用于识别 AskUserQuestion。 */
      inputObject: Record<string, unknown>;
      toolUseID: string | null;
    }
  | { kind: "cancel"; requestID: string }
  | { kind: "unsupported"; requestID: string; subtype: string };

/** 解析 stdout 的一行；不是认识的控制事件返回 null。 */
export function parseClaudeControlRequest(line: Buffer | string): ClaudeControlRequest | null {
  let object: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(typeof line === "string" ? line : line.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    object = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const requestID = typeof object.request_id === "string" ? object.request_id : "";
  if (requestID.length === 0) return null;
  switch (object.type) {
    case "control_cancel_request":
      return { kind: "cancel", requestID };
    case "control_request": {
      const request =
        object.request !== null && typeof object.request === "object" && !Array.isArray(object.request)
          ? (object.request as Record<string, unknown>)
          : {};
      const subtype = typeof request.subtype === "string" ? request.subtype : "";
      const toolName = typeof request.tool_name === "string" ? request.tool_name : "";
      if (subtype !== "can_use_tool" || toolName.length === 0) {
        return { kind: "unsupported", requestID, subtype };
      }
      const inputObject =
        request.input !== null && typeof request.input === "object" && !Array.isArray(request.input)
          ? (request.input as Record<string, unknown>)
          : {};
      const rawToolUseID = typeof request.tool_use_id === "string" ? request.tool_use_id : null;
      return {
        kind: "canUseTool",
        requestID,
        toolName,
        input: safeSortedJson(inputObject),
        inputObject,
        toolUseID: rawToolUseID && rawToolUseID.length > 0 ? rawToolUseID : null,
      };
    }
    default:
      return null;
  }
}

/**
 * 对一条审批的回答，hook 与控制协议共用。
 * `updatedInput` 是替换后的整份入参；省略 = 原样。
 */
export type ClaudePermissionDecision =
  | { kind: "allow"; updatedInput?: string }
  | { kind: "deny"; message: string };

export function allowDecision(updatedInput?: string | null): ClaudePermissionDecision {
  return updatedInput === undefined || updatedInput === null
    ? { kind: "allow" }
    : { kind: "allow", updatedInput };
}

export function denyDecision(message: string): ClaudePermissionDecision {
  return { kind: "deny", message };
}

/** 写回 claude stdin 的控制协议行，一行 JSON 加 `\n`。 */
export const ClaudeControlOutput = {
  /**
   * `allow` 总带 `updatedInput`：老版本的 schema 要求有它，没改入参就把原入参带回去。
   */
  response(requestID: string, decision: ClaudePermissionDecision, originalInput: string): Buffer {
    let body: Record<string, unknown>;
    if (decision.kind === "allow") {
      const parsed = decision.updatedInput !== undefined ? parseObject(decision.updatedInput) : parseObject(originalInput);
      body = { behavior: "allow", updatedInput: parsed ?? {} };
    } else {
      body = { behavior: "deny", message: decision.message };
    }
    return line({
      type: "control_response",
      response: { subtype: "success", request_id: requestID, response: body },
    });
  },

  error(requestID: string, message: string): Buffer {
    return line({
      type: "control_response",
      response: { subtype: "error", request_id: requestID, error: message },
    });
  },
};

function line(object: Record<string, unknown>): Buffer {
  return Buffer.from(`${sortedJson(object)}\n`, "utf8");
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeSortedJson(value: Record<string, unknown>): string {
  try {
    return sortedJson(value);
  } catch {
    return "{}";
  }
}

/**
 * 一个 `claude -p` 子进程的 stdin：先写 user 消息，这一轮里再写控制协议的回答，
 * 读到 `result` 后关掉（= EOF，claude 退出）。
 *
 * PORT: Swift 用串行队列 + F_SETNOSIGPIPE 防止 SIGPIPE。Node 的流写入失败会以
 * `error` 事件报告，这里吞掉（claude 已退出时写入只是失败，不能把宿主带走）。
 */
export class ClaudeControlChannel {
  private readonly handle: Writable;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(handle: Writable) {
    this.handle = handle;
    this.handle.on("error", () => undefined);
  }

  /** 已经关了返回 false：这一轮结束了，回答送不到。 */
  send(data: Buffer | string): boolean {
    if (this.closed) return false;
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.chain = this.chain.then(
      () =>
        new Promise<void>((resolve) => {
          try {
            this.handle.write(chunk, () => resolve());
          } catch {
            resolve();
          }
        }),
    );
    return true;
  }

  /** 幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.chain = this.chain.then(
      () =>
        new Promise<void>((resolve) => {
          try {
            this.handle.end(() => resolve());
          } catch {
            resolve();
          }
        }),
    );
  }

  get isOpen(): boolean {
    return !this.closed;
  }
}
