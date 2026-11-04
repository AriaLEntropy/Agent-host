/**
 * 一个 ACP 会话在 BotBus 这边的状态：对话记录、这一轮攒的回复、挂起的审批，以及
 * 任务标题 / 状态 / `pendingRequest` 的推算。纯值逻辑、不碰 IO。
 *
 * 上游把整份 `TaskRecord` 放在这里；本移植只持有任务里由会话推导的那几个字段，
 * 由 runtime 写回 `TaskStore`，避免这一层依赖存储实现。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/Acp/AcpSession.swift
 * (`AcpSessionState`; Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 */
import type { BusPendingRequest } from "../../bus/store.js";
import {
  mergeToolCall,
  pendingKind,
  permissionQuestions,
  singleLine,
  stopExplanation,
  stopStatus,
  toolCallDetail,
  truncate,
  type AcpCommand,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpToolCall,
} from "./messages.js";
import type { ImageSource } from "../ported/contract.js";
import { AcpTranscript, imageSources } from "./transcript.js";

export const ACP_SUMMARY_LIMIT = 200;
export const ACP_TITLE_LIMIT = 80;
export const ACP_LAST_MESSAGE_LIMIT = 500;
export const ACP_DETAIL_LIMIT = 2000;

/** 会话推导出来的任务字段。 */
export type AcpSessionRecord = {
  title: string;
  projectName: string;
  status: string;
  updatedAt: string;
  pendingRequest?: BusPendingRequest;
  lastMessage?: string;
};

/** agent 发来的审批：JSON-RPC 请求 id 留给 runtime 回话，请求本身用来渲染卡片。 */
export type PendingPermission = { rpcId: number; request: AcpPermissionRequest };

export class AcpSessionState {
  readonly transcript = new AcpTranscript();
  readonly record: AcpSessionRecord;
  /** ACP 报给手机的命令目录；整份替换，不参与任务字段指纹 */
  commands: AcpCommand[] = [];
  running = false;
  pending?: PendingPermission;
  /** 这一轮收到的全部回复文字，轮次收尾时写进 `lastMessage`。 */
  private turnText = "";
  private readonly tools = new Map<string, AcpToolCall>();
  /** 标题定下来了（agent 给过，或者首条 prompt 已经用过）就不再改。 */
  private titleLocked: boolean;
  /**
   * 这一轮是否已经记了一条非空的用户消息。true 时再收到的 `user_message_chunk`
   * 一律当成 BotBus 自己发的 `session/prompt` 被 agent 回显，直接丢掉。
   */
  private promptRecordedThisTurn = false;
  /** `setPending` 之前的状态，`clearPending` 用它复原。 */
  private statusBeforePending = "idle";

  constructor(record: AcpSessionRecord) {
    this.record = { ...record };
    this.titleLocked = record.title !== record.projectName && record.title !== "";
  }

  beginTurn(prompt: string, at: string, images: readonly ImageSource[] = []) {
    this.transcript.startTurn();
    this.transcript.appendText("user", prompt, images, at);
    const line = singleLine(prompt);
    if (!this.titleLocked && line) {
      this.record.title = truncate(line, ACP_TITLE_LIMIT);
      this.titleLocked = true;
    }
    this.running = true;
    this.turnText = "";
    this.pending = undefined;
    this.promptRecordedThisTurn = prompt.length > 0 || images.length > 0;
    delete this.record.pendingRequest;
    this.record.status = "running";
    this.record.updatedAt = at;
  }

  /** 应用一条 `session/update`；返回任务字段是否变了（流式片段本身不算）。 */
  apply(update: AcpSessionUpdate, at: string): boolean {
    const before = this.fingerprint();
    switch (update.kind) {
      case "userMessage": {
        // 这一轮的 prompt 是 BotBus 自己发的，agent 常把它原样回显——运行中且已经记过
        // prompt 时，这条八成是回显，不是新消息。
        if (this.running && this.promptRecordedThisTurn) break;
        this.transcript.appendText("user", update.text, imageSources(update.images), at);
        break;
      }
      case "agentMessage":
        this.transcript.appendText("agent", update.text, imageSources(update.images), at);
        if (this.running) this.turnText += update.text;
        break;
      case "toolCall": {
        this.tools.set(update.call.toolCallId, update.call);
        this.transcript.tool(update.call, at);
        break;
      }
      case "toolCallUpdate": {
        const merged = this.tools.has(update.call.toolCallId)
          ? mergeToolCall(this.tools.get(update.call.toolCallId)!, update.call)
          : update.call;
        this.tools.set(update.call.toolCallId, merged);
        this.transcript.tool(merged, at);
        break;
      }
      case "sessionInfo": {
        const line = singleLine(update.title ?? "");
        if (!line) break;
        this.record.title = truncate(line, ACP_TITLE_LIMIT);
        this.titleLocked = true;
        break;
      }
      case "availableCommands":
        // ACP 的约定是整份替换（空数组表示清空），顺序保留
        this.commands = update.commands;
        break;
      case "thought":
      case "other":
        break;
    }
    return before !== this.fingerprint();
  }

  setPending(request: AcpPermissionRequest, rpcId: number, at: string): boolean {
    const base = this.tools.get(request.toolCall.toolCallId);
    const call = base ? mergeToolCall(base, request.toolCall) : request.toolCall;
    this.tools.set(call.toolCallId, call);
    // 旧审批还挂着时来了新的（runtime 会先把旧的回成取消）：保留最初那个状态。
    if (!this.pending) this.statusBeforePending = this.record.status;
    this.pending = { rpcId, request };
    this.record.status = "waitingApproval";
    const detail = toolCallDetail(call);
    const questions = permissionQuestions(request.options);
    this.record.pendingRequest = {
      id: call.toolCallId,
      kind: pendingKind(call),
      summary: truncate(singleLine(call.title ?? call.kind ?? "工具调用"), ACP_SUMMARY_LIMIT),
      ...(detail !== undefined ? { detail: truncate(detail, ACP_DETAIL_LIMIT) } : {}),
      ...(questions ? { questions } : {}),
    };
    this.record.updatedAt = at;
    return true;
  }

  /** 复原成挂起审批之前的状态：一轮还在跑就是运行中，否则退回 `setPending` 记下的状态。 */
  clearPending(at: string): boolean {
    if (!this.pending) return false;
    this.pending = undefined;
    delete this.record.pendingRequest;
    this.record.status = this.running ? "running" : this.statusBeforePending;
    this.record.updatedAt = at;
    return true;
  }

  /** 一轮结束；`error` 表示这一轮出错（JSON-RPC 报错、进程崩了）。 */
  endTurn(stopReason: AcpStopReason | undefined, error: string | undefined, at: string) {
    this.running = false;
    this.promptRecordedThisTurn = false;
    this.pending = undefined;
    delete this.record.pendingRequest;
    const reply = this.turnText.trim();
    if (error !== undefined) {
      this.record.status = "failed";
      this.record.lastMessage = truncate(reply || error, ACP_LAST_MESSAGE_LIMIT);
    } else {
      this.record.status = stopStatus(stopReason);
      if (reply) {
        this.record.lastMessage = truncate(reply, ACP_LAST_MESSAGE_LIMIT);
      } else {
        const explanation = stopExplanation(stopReason ?? "end_turn");
        if (explanation) this.record.lastMessage = explanation;
      }
    }
    this.turnText = "";
    this.record.updatedAt = at;
  }

  private fingerprint(): string {
    return JSON.stringify([
      this.record.title,
      this.record.status,
      this.record.pendingRequest ?? null,
      this.record.lastMessage ?? "",
    ]);
  }
}
