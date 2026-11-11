// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexAppServerMessages.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { ConnectorError, type FailureDiagnosis } from "../ported/contract.js";
import {
  jsonArray,
  jsonObject,
  jsonPath,
  jsonString,
  requestIdKey,
  type CodexRequestID,
  type JSONValue,
} from "./json.js";

/**
 * 协议里的任务状态。字符串取值与 `TaskStatus` 的 rawValue 一致；
 * 这个模块只产出 running/completed/failed/interrupted/idle 五种。
 */
export type TaskStatus = "running" | "waitingApproval" | "waitingInput" | "completed" | "failed" | "interrupted" | "idle";

/** 线程在 app-server 眼里的状态（`thread/status/changed` 的 `status.type`）。 */
export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "active" }
  | { type: "systemError" }
  | { type: "unknown"; raw: string };

export function threadStatusFromRaw(raw: string): CodexThreadStatus {
  switch (raw) {
    case "notLoaded":
      return { type: "notLoaded" };
    case "idle":
      return { type: "idle" };
    case "active":
      return { type: "active" };
    case "systemError":
      return { type: "systemError" };
    default:
      return { type: "unknown", raw };
  }
}

/** 一个轮次的终态（`turn/completed` 的 `turn.status`）。 */
export type CodexTurnStatus =
  | { type: "inProgress" }
  | { type: "completed" }
  | { type: "interrupted" }
  | { type: "failed" }
  | { type: "unknown"; raw: string };

export function turnStatusFromRaw(raw: string): CodexTurnStatus {
  switch (raw) {
    case "inProgress":
      return { type: "inProgress" };
    case "completed":
      return { type: "completed" };
    case "interrupted":
      return { type: "interrupted" };
    case "failed":
      return { type: "failed" };
    default:
      return { type: "unknown", raw };
  }
}

/**
 * `fileChange` 条目里的一处改动。`item/fileChange/requestApproval` **不带**这些，
 * 它们只出现在同 itemId 的 `item/started` 里，所以 `CodexAppServer` 要缓存着等审批来配对。
 */
export type CodexFileChange = {
  path: string;
  /** `add` / `delete` / `update`（不同版本可能加新值，原样保留）。 */
  kind: string;
  diff: string;
};

/** 从 `FileUpdateChange` 的 JSON 解出来。 */
export function fileChangeFromJSON(value: JSONValue): CodexFileChange | undefined {
  const path = jsonString(jsonPath(value, "path"));
  if (path === undefined) return undefined;
  return {
    path,
    kind: jsonString(jsonPath(value, "kind")) ?? "update",
    diff: jsonString(jsonPath(value, "diff")) ?? "",
  };
}

/** `item/started` / `item/completed` 携带的 ThreadItem。只挑用得上的字段，原始 JSON 留在 `raw` 里。 */
export type CodexItem = {
  id: string;
  /** `agentMessage` / `commandExecution` / `fileChange` / … */
  type: string;
  /** `agentMessage.text`。 */
  text?: string;
  /** `commandExecution.command`。 */
  command?: string;
  /** `fileChange.changes`。 */
  changes: CodexFileChange[];
  raw: JSONValue;
};

/** 从 `ThreadItem` 的 JSON 解出来。 */
export function itemFromJSON(value: JSONValue): CodexItem | undefined {
  const id = jsonString(jsonPath(value, "id"));
  const type = jsonString(jsonPath(value, "type"));
  if (id === undefined || type === undefined) return undefined;
  return {
    id,
    type,
    text: jsonString(jsonPath(value, "text")),
    command: jsonString(jsonPath(value, "command")),
    changes: (jsonArray(jsonPath(value, "changes")) ?? [])
      .map((change) => fileChangeFromJSON(change))
      .filter((change): change is CodexFileChange => change !== undefined),
    raw: value,
  };
}

/**
 * 服务端通知。认得的解成具体 case，认不得的原样放进 `other`——
 * app-server 每个版本都在加通知，认不得不该是错误。
 */
export type CodexNotification =
  | { type: "threadStarted"; threadId: string; thread: JSONValue }
  | { type: "threadStatusChanged"; threadId: string; status: CodexThreadStatus }
  | { type: "turnStarted"; threadId: string; turnId: string }
  /** `errorInfo`：turn 错误里的 `codexErrorInfo`（单值变体是字符串，带字段的变体是只有一个键的对象，取键名）。 */
  | {
      type: "turnCompleted";
      threadId: string;
      turnId: string;
      status: CodexTurnStatus;
      error?: string;
      errorInfo?: string;
    }
  | { type: "agentMessageDelta"; threadId: string; itemId: string; delta: string }
  | { type: "itemStarted"; threadId: string; turnId?: string; item: CodexItem }
  | { type: "itemCompleted"; threadId: string; turnId?: string; item: CodexItem }
  | { type: "serverError"; message: string; threadId?: string }
  | { type: "other"; method: string; params: JSONValue };

function errorText(value: JSONValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = jsonString(value);
  if (text !== undefined) return text;
  return jsonString(jsonPath(value, "message"));
}

/**
 * Codex app-server v2 的 `TurnError.codexErrorInfo`：`"usageLimitExceeded"`，
 * 或 `{"httpConnectionFailed": {...}}`。
 */
function errorInfo(value: JSONValue | undefined): string | undefined {
  const info = jsonPath(value, "codexErrorInfo");
  if (info === undefined || info === null) return undefined;
  const text = jsonString(info);
  if (text !== undefined) return text;
  const object = jsonObject(info);
  if (object && Object.keys(object).length === 1) return Object.keys(object)[0];
  return undefined;
}

/** 按方法名与 params 解成具体 case。认不得的落到 `other`。 */
export function codexNotification(method: string, params: JSONValue): CodexNotification {
  switch (method) {
    case "thread/started": {
      const id = jsonString(jsonPath(params, "thread", "id"));
      if (id !== undefined) {
        return { type: "threadStarted", threadId: id, thread: jsonPath(params, "thread") ?? {} };
      }
      break;
    }
    case "thread/status/changed": {
      const id = jsonString(jsonPath(params, "threadId"));
      if (id !== undefined) {
        const raw = jsonString(jsonPath(params, "status", "type")) ?? "";
        return { type: "threadStatusChanged", threadId: id, status: threadStatusFromRaw(raw) };
      }
      break;
    }
    case "turn/started": {
      const id = jsonString(jsonPath(params, "threadId"));
      if (id !== undefined) {
        return {
          type: "turnStarted",
          threadId: id,
          turnId: jsonString(jsonPath(params, "turn", "id")) ?? "",
        };
      }
      break;
    }
    case "turn/completed": {
      const id = jsonString(jsonPath(params, "threadId"));
      if (id !== undefined) {
        const turn = jsonPath(params, "turn");
        return {
          type: "turnCompleted",
          threadId: id,
          turnId: jsonString(jsonPath(turn, "id")) ?? "",
          status: turnStatusFromRaw(jsonString(jsonPath(turn, "status")) ?? ""),
          error: errorText(jsonPath(turn, "error")),
          errorInfo: errorInfo(jsonPath(turn, "error")),
        };
      }
      break;
    }
    case "item/agentMessage/delta": {
      const id = jsonString(jsonPath(params, "threadId"));
      const delta = jsonString(jsonPath(params, "delta"));
      if (id !== undefined && delta !== undefined) {
        return {
          type: "agentMessageDelta",
          threadId: id,
          itemId: jsonString(jsonPath(params, "itemId")) ?? "",
          delta,
        };
      }
      break;
    }
    case "item/started": {
      const id = jsonString(jsonPath(params, "threadId"));
      const rawItem = jsonPath(params, "item");
      const item = rawItem === undefined ? undefined : itemFromJSON(rawItem);
      if (id !== undefined && item) {
        return { type: "itemStarted", threadId: id, turnId: jsonString(jsonPath(params, "turnId")), item };
      }
      break;
    }
    case "item/completed": {
      const id = jsonString(jsonPath(params, "threadId"));
      const rawItem = jsonPath(params, "item");
      const item = rawItem === undefined ? undefined : itemFromJSON(rawItem);
      if (id !== undefined && item) {
        return { type: "itemCompleted", threadId: id, turnId: jsonString(jsonPath(params, "turnId")), item };
      }
      break;
    }
    case "error": {
      // app-server 的错误帧通常带 threadId；没有时由连接器归到当前在跑的线程。
      const threadId = jsonString(jsonPath(params, "threadId"));
      return {
        type: "serverError",
        message: jsonString(jsonPath(params, "message")) ?? "app-server 报错",
        ...(threadId === undefined ? {} : { threadId }),
      };
    }
    default:
      break;
  }
  // 认得方法名但字段对不上（版本差异、畸形帧）时也走这里：宁可少理解一条，不要丢掉它。
  return { type: "other", method, params };
}

export function notificationMethod(notification: CodexNotification): string {
  switch (notification.type) {
    case "threadStarted":
      return "thread/started";
    case "threadStatusChanged":
      return "thread/status/changed";
    case "turnStarted":
      return "turn/started";
    case "turnCompleted":
      return "turn/completed";
    case "agentMessageDelta":
      return "item/agentMessage/delta";
    case "itemStarted":
      return "item/started";
    case "itemCompleted":
      return "item/completed";
    case "serverError":
      return "error";
    case "other":
      return notification.method;
  }
}

export function notificationThreadId(notification: CodexNotification): string | undefined {
  switch (notification.type) {
    case "threadStarted":
    case "threadStatusChanged":
    case "turnStarted":
    case "turnCompleted":
    case "agentMessageDelta":
    case "itemStarted":
    case "itemCompleted":
      return notification.threadId;
    case "serverError":
      return notification.threadId;
    case "other":
      return jsonString(jsonPath(notification.params, "threadId"));
  }
}

/**
 * 这条通知意味着任务该变成什么状态；不代表状态变化的返回 undefined。
 * 映射见 spec 6.1：`turn/started` → running，`turn/completed` 看 payload，
 * `thread/status/changed` 同步。
 *
 * 只做“协议语义 → 协议状态”的翻译，不碰 store：怎么用是连接器的事。
 */
export function notificationStatusTransition(notification: CodexNotification): TaskStatus | undefined {
  switch (notification.type) {
    case "turnStarted":
      return "running";
    case "turnCompleted":
      switch (notification.status.type) {
        case "completed":
          return "completed";
        case "failed":
          return "failed";
        case "interrupted":
          return "interrupted";
        case "inProgress":
          return "running";
        default:
          return undefined;
      }
    case "threadStatusChanged":
      switch (notification.status.type) {
        case "active":
          return "running";
        case "idle":
          return "idle";
        case "systemError":
          return "failed";
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

/**
 * 服务端主动发来的请求。**永远不会被 `CodexAppServer` 自动回复**——它只挂起来、往事件流里推一条，
 * 由连接器决定变成待审批还是回一条“不支持”。
 */
export type CodexServerRequestKind = "commandExecution" | "fileChange" | "permissions" | "userInput" | "other";

export class CodexServerRequest {
  /** 原样保留的 app-server 请求 id（字符串或整数），回复时必须用它。 */
  readonly id: CodexRequestID;
  readonly method: string;
  readonly kind: CodexServerRequestKind;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly params: JSONValue;
  /** 从同 itemId 的 `item/started` 缓存补来的补丁。审批请求自己不带 diff。 */
  readonly fileChanges: CodexFileChange[];
  /** 挂起表的键，也是给 `PendingRequest.id` 用的字符串。 */
  readonly key: string;

  constructor(
    id: CodexRequestID,
    method: string,
    params: JSONValue,
    fileChanges: CodexFileChange[] = [],
  ) {
    this.id = id;
    this.method = method;
    this.kind = kindForMethod(method);
    this.threadId = jsonString(jsonPath(params, "threadId"));
    this.turnId = jsonString(jsonPath(params, "turnId"));
    this.itemId = jsonString(jsonPath(params, "itemId"));
    this.params = params;
    this.fileChanges = fileChanges;
    this.key = requestIdKey(id);
  }

  /** 四类“要用户拿主意”的请求。其余的（刷新令牌、MCP elicitation）不属于审批。 */
  get isApproval(): boolean {
    return this.kind === "commandExecution" || this.kind === "fileChange" || this.kind === "permissions";
  }

  /** 对应协议里的 `PendingRequest.kind`；不是审批也不是提问的返回 undefined。 */
  get pendingRequestKind(): "command" | "fileChange" | "permission" | "input" | undefined {
    switch (this.kind) {
      case "commandExecution":
        return "command";
      case "fileChange":
        return "fileChange";
      case "permissions":
        return "permission";
      case "userInput":
        return "input";
      default:
        return undefined;
    }
  }
}

export function kindForMethod(method: string): CodexServerRequestKind {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "commandExecution";
    case "item/fileChange/requestApproval":
      return "fileChange";
    case "item/permissions/requestApproval":
      return "permissions";
    case "item/tool/requestUserInput":
      return "userInput";
    default:
      return "other";
  }
}

/** `CodexAppServer` 往外推的一切。单订阅者。 */
export type CodexAppServerEvent =
  /** 子进程起来了（`generation` 每起一次加一；第一次是 1）。握手还没完成。 */
  | { type: "started"; generation: number }
  /** 握手完成，可以发请求了。 */
  | { type: "ready"; generation: number }
  | { type: "notification"; notification: CodexNotification }
  /** 服务端请求到了，**没有**被回复。 */
  | { type: "serverRequest"; request: CodexServerRequest }
  /** 子进程没了。`restartingIn` 非 undefined 表示多少秒后自动重启；undefined 表示不会重启（被 `stop()` 了）。 */
  | { type: "exited"; exit: CodexProcessExit; restartingIn?: number }
  /** 重启后正在对这些之前由本机控制、且当时还在跑的线程逐个 `thread/resume`。 */
  | { type: "resumingAfterRestart"; threadIds: string[] };

/** 子进程的退出情况。`reason` 取 stderr 末尾的一小段，只用于界面提示，**不进日志**。 */
export type CodexProcessExit = {
  status: number;
  reason?: string;
};

export type CodexAppServerErrorReason =
  /** 进程没起来、正在重启、或者已经 `stop()` 了。 */
  | "notRunning"
  /** 硬超时。 */
  | "timedOut"
  /** 等应答期间子进程退出了。 */
  | "processExited"
  /** 写 stdin 失败。 */
  | "transport"
  /** app-server 回了 JSON-RPC 错误。 */
  | "server"
  /** 要回复的服务端请求不在挂起表里（已被回答、已被丢弃，或者 key 是编的）。 */
  | "unknownRequest"
  /** 起子进程失败。 */
  | "launchFailed";

/** `CodexAppServer` 抛出的一切。 */
export class CodexAppServerError extends ConnectorError {
  readonly reason: CodexAppServerErrorReason;
  readonly code?: number;

  constructor(
    reason: CodexAppServerErrorReason,
    message: string,
    options: { code?: number; diagnosis?: FailureDiagnosis } = {},
  ) {
    super(message, { diagnosis: options.diagnosis });
    this.name = "CodexAppServerError";
    this.reason = reason;
    this.code = options.code;
  }

  static notRunning(detail = "Codex app-server 还没就绪", diagnosis?: FailureDiagnosis): CodexAppServerError {
    return new CodexAppServerError("notRunning", detail, { diagnosis });
  }

  static timedOut(method: string, seconds: number): CodexAppServerError {
    return new CodexAppServerError("timedOut", `Codex ${method} 等了 ${Math.trunc(seconds)} 秒没有应答`);
  }

  static processExited(method: string): CodexAppServerError {
    return new CodexAppServerError("processExited", `Codex app-server 在 ${method} 应答前退出了`);
  }
}

/** 错误的一句话。连接器日志用它，不输出错误对象里的私有载荷。 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
