// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexBridgeRouter.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { encodeJSON, jsonObject, jsonPath, jsonString, type JSONValue } from "./json.js";

/** One app-server connection belongs to the desktop. The Agent is an optional second client. */
export type CodexBridgeDelivery =
  | { type: "upstream"; message: JSONValue }
  | { type: "desktop"; message: JSONValue }
  | { type: "agent"; session: string; message: JSONValue };

export type CodexBridgeFailureKind =
  | "notReady"
  | "staleSession"
  | "forbiddenMethod"
  | "unknownApproval"
  | "tooManyRequests";

export class CodexBridgeFailure extends Error {
  constructor(readonly kind: CodexBridgeFailureKind, message?: string) {
    super(message ?? kind);
    this.name = "CodexBridgeFailure";
  }
}

type Origin = {
  session?: string;
  originalID: JSONValue;
  method: string;
};

type ServerRequest = {
  method: string;
  threadId?: string;
  turnId?: string;
  message: JSONValue;
};

const phoneApprovalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);

const agentMethods = new Set([
  "thread/start", "thread/resume", "thread/read", "thread/loaded/list",
  "turn/start", "turn/steer", "turn/interrupt",
  // 协议 3.4：手机「合并并结束」后归档线程（`CodexConnector.discard`）。
  "thread/archive", "thread/delete",
]);

const requestLimit = 1024;
const serverRequestLimit = 128;

function idKey(value: JSONValue | undefined): string | undefined {
  return value === undefined ? undefined : encodeJSON(value);
}

function canPhoneAnswer(request: ServerRequest): boolean {
  return phoneApprovalMethods.has(request.method);
}

/**
 * All mutations are serialized by the host actor; this value holds only protocol bookkeeping.
 * PORT：JS 单线程 + 宿主串行调用，无需锁；状态仍全部封在这个实例里。
 */
export class CodexBridgeRouter {
  private nextID = 1;
  private outbound = new Map<string, Origin>();
  private serverRequests = new Map<string, ServerRequest>();
  private serverRequestOrder: string[] = [];
  private activeTurns = new Map<string, JSONValue>();
  initializeResult: JSONValue | undefined;
  agentSession: string | undefined;

  /**
   * Current desktop clients start sending requests after the initialize response
   * without sending an `initialized` notification. If one is sent, it is forwarded
   * unchanged, but it must not gate attachment to an already initialized upstream.
   */
  get ready(): boolean {
    return this.initializeResult !== undefined;
  }

  attach(session: string): JSONValue[] {
    this.agentSession = session;
    this.dropSessionOutbound();
    const running = [...this.activeTurns.keys()]
      .sort()
      .map((threadId) => this.activeTurns.get(threadId))
      .filter((message): message is JSONValue => message !== undefined);
    const approvals: JSONValue[] = [];
    for (const key of this.serverRequestOrder) {
      const request = this.serverRequests.get(key);
      if (request && canPhoneAnswer(request)) approvals.push(request.message);
    }
    return [...running, ...approvals];
  }

  detach(): void {
    this.agentSession = undefined;
    this.dropSessionOutbound();
  }

  /** Desktop requests keep their full params but receive private upstream IDs. */
  desktop(message: JSONValue): CodexBridgeDelivery[] {
    const object = jsonObject(message);
    const method = jsonString(jsonPath(message, "method"));
    if (method !== undefined) {
      const hasID = object !== undefined && Object.prototype.hasOwnProperty.call(object, "id");
      if (hasID) {
        const originalID = object?.["id"] as JSONValue;
        if (this.outbound.size >= requestLimit) {
          return [
            {
              type: "desktop",
              message: {
                id: originalID,
                error: { code: -32000, message: "Codex bridge request limit exceeded" },
              },
            },
          ];
        }
        const upstreamID = this.nextRequestID();
        this.outbound.set(encodeJSON(upstreamID), { originalID, method });
        return [{ type: "upstream", message: this.replacingID(message, upstreamID) }];
      }
      return [{ type: "upstream", message }];
    }

    const id = jsonPath(message, "id");
    const key = idKey(id);
    const request = key === undefined ? undefined : this.serverRequests.get(key);
    if (key === undefined || !request) {
      // late duplicate, including one already answered from phone
      return [];
    }
    this.serverRequests.delete(key);
    this.serverRequestOrder = this.serverRequestOrder.filter((item) => item !== key);
    const deliveries: CodexBridgeDelivery[] = [{ type: "upstream", message }];
    if (canPhoneAnswer(request) && this.agentSession !== undefined) {
      deliveries.push({ type: "agent", session: this.agentSession, message: this.resolved(id as JSONValue, request) });
    }
    return deliveries;
  }

  agent(message: JSONValue, session: string): CodexBridgeDelivery[] {
    if (!this.ready) throw new CodexBridgeFailure("notReady");
    if (this.agentSession !== session) throw new CodexBridgeFailure("staleSession");
    const object = jsonObject(message);
    const method = jsonString(jsonPath(message, "method"));
    if (method !== undefined) {
      if (!agentMethods.has(method)) throw new CodexBridgeFailure("forbiddenMethod");
      if (object === undefined || !Object.prototype.hasOwnProperty.call(object, "id")) {
        throw new CodexBridgeFailure("forbiddenMethod");
      }
      if (this.outbound.size >= requestLimit) throw new CodexBridgeFailure("tooManyRequests");
      const originalID = object["id"] as JSONValue;
      const upstreamID = this.nextRequestID();
      this.outbound.set(encodeJSON(upstreamID), { session, originalID, method });
      return [{ type: "upstream", message: this.replacingID(message, upstreamID) }];
    }

    const id = jsonPath(message, "id");
    const key = idKey(id);
    const request = key === undefined ? undefined : this.serverRequests.get(key);
    if (key === undefined || !request || !canPhoneAnswer(request)) {
      throw new CodexBridgeFailure("unknownApproval");
    }
    this.serverRequests.delete(key);
    this.serverRequestOrder = this.serverRequestOrder.filter((item) => item !== key);
    return [
      { type: "upstream", message },
      { type: "desktop", message: this.resolved(id as JSONValue, request) },
    ];
  }

  upstream(message: JSONValue): CodexBridgeDelivery[] {
    const method = jsonString(jsonPath(message, "method"));
    const id = jsonPath(message, "id");
    const key = idKey(id);
    if (key !== undefined && method === undefined) {
      const origin = this.outbound.get(key);
      if (!origin) return [];
      this.outbound.delete(key);
      const restored = this.replacingID(message, origin.originalID);
      if (origin.method === "initialize" && origin.session === undefined) {
        const result = jsonPath(message, "result");
        if (result !== undefined) this.initializeResult = result;
      }
      if (origin.session !== undefined) {
        return origin.session === this.agentSession ? [{ type: "agent", session: origin.session, message: restored }] : [];
      }
      return [{ type: "desktop", message: restored }];
    }

    if (method !== undefined) {
      const object = jsonObject(message);
      if (object && Object.prototype.hasOwnProperty.call(object, "id")) {
        const params = jsonPath(message, "params");
        const request: ServerRequest = {
          method,
          threadId: jsonString(jsonPath(params, "threadId")),
          turnId: jsonString(jsonPath(params, "turnId")),
          message,
        };
        const serverKey = key as string;
        this.serverRequests.set(serverKey, request);
        this.serverRequestOrder.push(serverKey);
        while (this.serverRequestOrder.length > serverRequestLimit) {
          const oldest = this.serverRequestOrder.shift();
          if (oldest === undefined) break;
          this.serverRequests.delete(oldest);
        }
        const deliveries: CodexBridgeDelivery[] = [{ type: "desktop", message }];
        if (canPhoneAnswer(request) && this.agentSession !== undefined) {
          deliveries.push({ type: "agent", session: this.agentSession, message });
        }
        return deliveries;
      }

      if (method === "turn/started") {
        const threadId = jsonString(jsonPath(jsonPath(message, "params"), "threadId"));
        if (threadId !== undefined) this.activeTurns.set(threadId, message);
      } else if (method === "turn/completed") {
        const params = jsonPath(message, "params");
        const threadId = jsonString(jsonPath(params, "threadId"));
        if (threadId !== undefined) this.activeTurns.delete(threadId);
        const turnId = jsonString(jsonPath(params, "turn", "id"));
        for (const key of this.serverRequestOrder) {
          const request = this.serverRequests.get(key);
          if (
            request !== undefined &&
            request.threadId === threadId &&
            (turnId === undefined || request.turnId === undefined || request.turnId === turnId)
          ) {
            this.serverRequests.delete(key);
          }
        }
        this.serverRequestOrder = this.serverRequestOrder.filter((item) => this.serverRequests.has(item));
      } else if (method === "serverRequest/resolved") {
        const resolvedID = jsonPath(paramsOf(message), "requestId");
        const resolvedKey = idKey(resolvedID);
        if (resolvedKey !== undefined) {
          this.serverRequests.delete(resolvedKey);
          this.serverRequestOrder = this.serverRequestOrder.filter((item) => item !== resolvedKey);
        }
      }

      const deliveries: CodexBridgeDelivery[] = [{ type: "desktop", message }];
      if (this.agentSession !== undefined) {
        deliveries.push({ type: "agent", session: this.agentSession, message });
      }
      return deliveries;
    }

    return [{ type: "desktop", message }];
  }

  private dropSessionOutbound(): void {
    for (const [key, origin] of [...this.outbound]) {
      if (origin.session !== undefined) this.outbound.delete(key);
    }
  }

  private nextRequestID(): string {
    const value = `botbus-${this.nextID}`;
    this.nextID += 1;
    return value;
  }

  private replacingID(message: JSONValue, id: JSONValue): JSONValue {
    const object = jsonObject(message) ?? {};
    return { ...object, id };
  }

  private resolved(id: JSONValue, request: ServerRequest): JSONValue {
    return {
      method: "serverRequest/resolved",
      params: {
        requestId: id,
        threadId: request.threadId ?? "",
      },
    };
  }
}

function paramsOf(message: JSONValue): JSONValue | undefined {
  return jsonPath(message, "params");
}
