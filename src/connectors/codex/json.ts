// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexJSON.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// 同时承载 Kit 的 `JSONValue.swift`：上游 CodexJSON 依赖它，而移植目录不允许改
// `ported/`。这里用 JS 的原生 JSON 值表示 `JSONValue`，只补回“按路径取值”和
// “键排序编码”两件上游提供的事。整数与浮点在 JS 里本来就是同一个 number，
// `JSON.stringify(1)` 仍是 `1`，不会出现 1.0，所以不需要 Swift 的 int/double 分家。

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

export function jsonObject(value: JSONValue | undefined): { [key: string]: JSONValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function jsonArray(value: JSONValue | undefined): JSONValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function jsonString(value: JSONValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function jsonBool(value: JSONValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 对应 `intValue`：只认整数（浮点恰好是整数时也算，与上游一致）。 */
export function jsonInt(value: JSONValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function jsonDouble(value: JSONValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function jsonIsNull(value: JSONValue | undefined): boolean {
  return value === null;
}

/** `value.path("turn", "status")`：中间缺一环就是 undefined，不抛错。 */
export function jsonPath(value: JSONValue | undefined, ...keys: string[]): JSONValue | undefined {
  let current: JSONValue | undefined = value;
  for (const key of keys) {
    current = jsonObject(current)?.[key];
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * 键排序、无多余空白的 JSON 编码。对应上游
 * `JSONEncoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]`。
 * 键排序保证输出稳定，测试可直接断言整行。
 */
export function encodeJSON(value: JSONValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      return "null";
  }
  if (Array.isArray(value)) return `[${value.map((item) => encodeJSON(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeJSON(value[key])}`).join(",")}}`;
}

export function parseJSON(text: string): JSONValue | undefined {
  try {
    return JSON.parse(text) as JSONValue;
  } catch {
    return undefined;
  }
}

// MARK: - CodexRequestID

/**
 * app-server 的请求 id：**可能是字符串也可能是整数**，两种都要认，回复时必须原样回去。
 * 我们自己发出去的一律用整数，但服务端发来的请求（审批）就见过字符串。
 *
 * PORT：JS 的 number 只有 53 位精度；app-server 的自增 id 远小于 2^53，字符串 id 不受影响。
 */
export type CodexRequestID =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string };

/** 字典键与对外的 `PendingRequest.id`。加前缀是为了让整数 `5` 与字符串 `"5"` 不撞车。 */
export function requestIdKey(id: CodexRequestID): string {
  return id.kind === "number" ? `#${id.value}` : `$${id.value}`;
}

export function requestIdFromKey(key: string): CodexRequestID | null {
  if (key.length === 0) return null;
  const marker = key[0];
  const rest = key.slice(1);
  if (marker === "#") {
    if (!/^-?\d+$/.test(rest)) return null;
    const value = Number(rest);
    if (!Number.isInteger(value)) return null;
    return { kind: "number", value };
  }
  if (marker === "$") return { kind: "text", value: rest };
  return null;
}

export function requestIdFromJSON(value: JSONValue | undefined): CodexRequestID | null {
  if (typeof value === "number" && Number.isInteger(value)) return { kind: "number", value };
  if (typeof value === "string") return { kind: "text", value };
  return null;
}

export function requestIdToJSON(id: CodexRequestID): JSONValue {
  return id.kind === "number" ? id.value : id.value;
}

// MARK: - CodexIncomingMessage

/**
 * 一行 NDJSON 解出来的东西。**没有 `jsonrpc` 字段**——codex app-server 的分帧就是
 * “一行一个 JSON 对象”，既没有 Content-Length 头，也不带 JSON-RPC 的版本号。
 */
export type CodexIncomingMessage =
  /** 对我们某条请求的成功应答。 */
  | { type: "response"; id: CodexRequestID; result: JSONValue }
  /** 对我们某条请求的错误应答。 */
  | { type: "failure"; id: CodexRequestID; code: number; message: string }
  /** 服务端主动发来的**请求**（审批、要用户输入）。有 id，必须回，但绝不自动回。 */
  | { type: "request"; id: CodexRequestID; method: string; params: JSONValue }
  /** 服务端通知。没有 id，不用回。 */
  | { type: "notification"; method: string; params: JSONValue };

function optionalString(object: { [key: string]: JSONValue }, key: string): string | undefined | null {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  // 类型不对：上游整个 Envelope 解码失败，这一行直接丢掉。
  return null;
}

/** 解一行。不是合法信封、或字段类型不对时返回 null（与上游 `init?(line:)` 一致）。 */
export function parseIncomingLine(line: string | Uint8Array): CodexIncomingMessage | null {
  const text = typeof line === "string" ? line : Buffer.from(line).toString("utf8");
  const parsed = parseJSON(text);
  const envelope = jsonObject(parsed);
  if (!envelope) return null;

  const method = optionalString(envelope, "method");
  if (method === null) return null;

  const rawId = envelope["id"];
  let id: CodexRequestID | null = null;
  if (rawId !== undefined && rawId !== null) {
    id = requestIdFromJSON(rawId);
    if (!id) return null;
  }

  const params = envelope["params"] ?? null;
  const result = envelope["result"] ?? null;

  if (method !== undefined) {
    if (id) return { type: "request", id, method, params };
    return { type: "notification", method, params };
  }
  if (!id) return null;

  const rawError = envelope["error"];
  if (rawError !== undefined && rawError !== null) {
    const failure = jsonObject(rawError);
    if (!failure) return null;
    const rawCode = failure["code"];
    let code = 0;
    if (rawCode !== undefined && rawCode !== null) {
      if (typeof rawCode !== "number" || !Number.isInteger(rawCode)) return null;
      code = rawCode;
    }
    const rawMessage = failure["message"];
    let message = "app-server 未说明原因";
    if (rawMessage !== undefined && rawMessage !== null) {
      if (typeof rawMessage !== "string") return null;
      message = rawMessage;
    }
    return { type: "failure", id, code, message };
  }
  return { type: "response", id, result };
}

/** 只给日志用的一句话：**只有种类、方法名与 id**，绝不带 params/result 本体。 */
export function incomingLogDescription(message: CodexIncomingMessage): string {
  switch (message.type) {
    case "response":
      return `response ${requestIdKey(message.id)}`;
    case "failure":
      return `error ${requestIdKey(message.id)} code=${message.code}`;
    case "request":
      return `request ${message.method} ${requestIdKey(message.id)}`;
    case "notification":
      return `notification ${message.method}`;
  }
}

// MARK: - CodexOutgoingMessage

/** 我们发出去的一行。同样不带 `jsonrpc`。 */
export type CodexOutgoingMessage =
  | { type: "request"; id: CodexRequestID; method: string; params?: JSONValue }
  | { type: "notification"; method: string; params?: JSONValue }
  | { type: "response"; id: CodexRequestID; result: JSONValue }
  | { type: "failure"; id: CodexRequestID; code: number; message: string };

/** 编码成一行（不含换行符）。键排序，输出稳定，测试好断言。 */
export function encodeOutgoingMessage(message: CodexOutgoingMessage): string {
  const object: { [key: string]: JSONValue } = {};
  switch (message.type) {
    case "request":
      object["id"] = requestIdToJSON(message.id);
      object["method"] = message.method;
      if (message.params !== undefined) object["params"] = message.params;
      break;
    case "notification":
      object["method"] = message.method;
      if (message.params !== undefined) object["params"] = message.params;
      break;
    case "response":
      object["id"] = requestIdToJSON(message.id);
      object["result"] = message.result;
      break;
    case "failure":
      object["id"] = requestIdToJSON(message.id);
      object["error"] = { code: message.code, message: message.message };
      break;
  }
  return encodeJSON(object);
}

export function outgoingLogDescription(message: CodexOutgoingMessage): string {
  switch (message.type) {
    case "request":
      return `request ${message.method} ${requestIdKey(message.id)}`;
    case "notification":
      return `notification ${message.method}`;
    case "response":
      return `response ${requestIdKey(message.id)}`;
    case "failure":
      return `error ${requestIdKey(message.id)} code=${message.code}`;
  }
}
