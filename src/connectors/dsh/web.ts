import { randomUUID } from "node:crypto";
import { cookieHeader } from "./auth.js";

/** DSH 的 web 地址。cookie 按 authority 签，所以一律用 127.0.0.1:<port>。 */
export class DshWebEndpoint {
  constructor(readonly port: number) {}

  get authority() {
    return `127.0.0.1:${this.port}`;
  }

  get baseUrl() {
    return `http://${this.authority}`;
  }

  methodUrl(method: string) {
    return `${this.baseUrl}/api/${method}`;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type DshWebClientOptions = {
  port: number;
  secret: Buffer;
  fetchImpl?: FetchLike;
  now?: () => number;
};

export type DshWebSessionSummary = {
  sessionId: string;
  updatedAt?: Date;
  running: boolean;
  blank: boolean;
  cwd?: string;
  parentSessionId?: string;
  origin?: string;
  title?: string;
  asOfSeq?: number;
};

export type DshSessionEvent = {
  type: string;
  seq: number;
  time?: Date;
  data: unknown;
  surfaceOp?: unknown;
};

export type DshPage = {
  events: DshSessionEvent[];
  hasMore: boolean;
};

export class DshWebError extends Error {
  constructor(
    readonly kind: "unauthorized" | "http" | "malformed" | "remote" | "disconnected",
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DshWebError";
  }
}

/**
 * `dsh web` 的一元调用。无状态、可并发；每次请求现签一张 cookie。
 *
 * 请求体：`{type:"client-request", rpcId, method, payload:{args:{...}}}`。
 * 参数名：`session/list` 是 `_request`，`$events/result` 直接是结果，其余是 `request`。
 * 回应：`{type:"server-response", rpcId, result:{ok, value | error}}`。
 */
export class DshWebClient {
  readonly endpoint: DshWebEndpoint;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly secret: Buffer;

  constructor(options: DshWebClientOptions) {
    this.endpoint = new DshWebEndpoint(options.port);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.secret = options.secret;
  }

  cookieHeader() {
    return cookieHeader(this.secret, this.endpoint.authority, this.now());
  }

  async call(method: string, argument: unknown): Promise<unknown> {
    const args =
      method === "$events/result"
        ? argument
        : method === "session/list"
          ? { _request: argument }
          : { request: argument };
    const envelope = {
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args },
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint.methodUrl(method), {
        method: "POST",
        headers: {
          Cookie: this.cookieHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
    } catch (error) {
      throw new DshWebError(
        "disconnected",
        `和 DeepSeek Harness 网页端的连接断开了：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new DshWebError("unauthorized", "DeepSeek Harness 网页端拒绝了登录", response.status);
    }
    if (!response.ok) {
      throw new DshWebError(
        "http",
        `DeepSeek Harness 网页端返回 HTTP ${response.status}：${method}`,
        response.status,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new DshWebError("malformed", `看不懂 DeepSeek Harness 网页端的回应：${method}`);
    }
    const result = record(record(parsed).result);
    if (typeof result.ok !== "boolean") {
      throw new DshWebError("malformed", `看不懂 DeepSeek Harness 网页端的回应：${method}`);
    }
    if (!result.ok) {
      const error = record(result.error);
      throw new DshWebError(
        "remote",
        typeof error.message === "string" ? error.message : "DeepSeek Harness 报错",
        undefined,
        typeof error.code === "string" ? error.code : undefined,
      );
    }
    return result.value ?? null;
  }

  /** `session/list`：每次都重读持久层；子 agent、空会话由调用方过滤。 */
  async listSessions(): Promise<DshWebSessionSummary[]> {
    const value = await this.call("session/list", {});
    const items = record(value).items;
    if (!Array.isArray(items)) {
      throw new DshWebError("malformed", "看不懂 DeepSeek Harness 网页端的回应：session/list");
    }
    return items.flatMap((item) => {
      const summary = summaryFromJson(item);
      return summary ? [summary] : [];
    });
  }

  /** 取一页历史，不激活会话。`throughSeq` 是这页最后一条。 */
  async page(sessionId: string, throughSeq: number, beforeSeq?: number, maxMessages = 50): Promise<DshPage> {
    const request: Record<string, unknown> = {
      address: { kind: "session", sessionId },
      throughSeq,
      maxMessages,
    };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    const value = await this.call("session/page", request);
    const body = record(value);
    if (!Array.isArray(body.records)) {
      throw new DshWebError("malformed", "看不懂 DeepSeek Harness 网页端的回应：session/page");
    }
    return {
      events: body.records.flatMap((item) => {
        const event = eventFromJson(item);
        return event ? [event] : [];
      }),
      hasMore: body.hasMore === true,
    };
  }

  /**
   * 最近一页历史。先用一个一定越界的 throughSeq 问一次，从 dsh 的
   * `past cursor N` 错误里取真实游标，再取一次。不激活会话。
   */
  async latestPage(sessionId: string, maxMessages = 50): Promise<DshPage> {
    try {
      return await this.page(sessionId, PROBE_SEQ, undefined, maxMessages);
    } catch (error) {
      if (!(error instanceof DshWebError) || error.kind !== "remote" || error.code !== "gateway/bad-request") {
        throw error;
      }
      const cursor = cursorFromPastCursorMessage(error.message);
      if (cursor === null) throw error;
      if (cursor < 0) return { events: [], hasMore: false };
      return this.page(sessionId, cursor, undefined, maxMessages);
    }
  }

  /** 续聊；`mode: "queue"`，这一轮在跑就排后面。 */
  async prompt(sessionId: string, text: string, requestId = `agent-host-${randomUUID()}`): Promise<boolean> {
    const value = await this.call("session/prompt", {
      requestId,
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
    return record(value).accepted !== false;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call("session/cancel", { sessionId });
  }

  /**
   * 让 dsh web 的目录接住一个外部 ACP 会话。参考实现这样用：
   * `workspace/create` 拿 workspaceId，再 `session/create` 用原 sessionId 接入。
   * 不创建新的会话身份。
   */
  async adoptSession(sessionId: string, cwd: string): Promise<void> {
    const workspace = await this.call("workspace/create", { path: cwd });
    const workspaceId = stringAt(record(workspace), ["workspace", "workspaceId"]);
    if (!workspaceId) {
      throw new DshWebError("malformed", "看不懂 DeepSeek Harness 网页端的回应：workspace/create");
    }
    const session = await this.call("session/create", { sessionId, workspaceId });
    if (stringAt(record(session), ["sessionId"]) !== sessionId) {
      throw new DshWebError("malformed", "DeepSeek Harness 没有接住这个会话：session/create");
    }
  }
}

export const PROBE_SEQ = Number.MAX_SAFE_INTEGER;

export function cursorFromPastCursorMessage(message: string): number | null {
  const match = /past cursor (-?\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

export function summaryFromJson(value: unknown): DshWebSessionSummary | null {
  const json = record(value);
  if (typeof json.sessionId !== "string" || !json.sessionId) return null;
  return {
    sessionId: json.sessionId,
    updatedAt: dateAt(json.updatedAt),
    running: json.running === true,
    blank: json.blank === true,
    cwd: nonEmptyString(json.cwd),
    parentSessionId: nonEmptyString(json.parentSessionId),
    origin: nonEmptyString(json.origin),
    title: stringAt(json, ["projections", "values", "title"]),
    asOfSeq: numberAt(json, ["projections", "asOfSeq"]),
  };
}

export function eventFromJson(value: unknown): DshSessionEvent | null {
  let body = record(value);
  if (body.type === "event" && isRecord(body.event)) body = body.event;
  if (typeof body.type !== "string" || body.type === "session" || body.type === "event") return null;
  if (typeof body.seq !== "number") return null;
  return {
    type: body.type,
    seq: body.seq,
    time: dateAt(body.time),
    data: body.data ?? null,
    surfaceOp: body.surfaceOp,
  };
}

export function eventText(event: DshSessionEvent): string | undefined {
  if (event.type === "user/message") return textBlocks(record(event.data).content);
  if (event.type === "assistant/message") return textBlocks(record(record(event.data).message).content);
  return undefined;
}

export function eventTitle(event: DshSessionEvent): string | undefined {
  if (event.type !== "session/title") return undefined;
  const title = record(event.data).title;
  return typeof title === "string" ? title : undefined;
}

export function eventSourceKind(event: DshSessionEvent): string | undefined {
  if (event.type !== "user/message") return undefined;
  return stringAt(record(event.data), ["source", "kind"]);
}

function textBlocks(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((block) => {
      const item = record(block);
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
  return text || undefined;
}

function dateAt(value: unknown): Date | undefined {
  return typeof value === "number" ? new Date(value) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberAt(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const key of path) current = record(current)[key];
  return typeof current === "number" ? current : undefined;
}

function stringAt(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) current = record(current)[key];
  return nonEmptyString(current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
