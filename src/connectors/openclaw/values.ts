/**
 * OpenClaw 移植模块共用的值工具。
 *
 * Ported from botbus-protocol/Sources/BotBusProtocol/ProtocolJSON.swift,
 * botbus-protocol/Sources/BotBusConnectorKit/JSONValue.swift,
 * botbus-protocol/Sources/BotBusConnectorKit/SessionObserver.swift
 * (`SessionFormatting`) and the message-reader date helper in
 * Sources/BotBusConnectors/OpenClaw/OpenClawMessageReader.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 */

/** 普通对象（不含数组、null）。对应 `JSONValue.objectValue != nil`。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** `JSONValue.intValue`：只认整数（`1.0` 这种恰好是整数的也认）。 */
export function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** 协议规定的时间格式：秒精度 UTC、不带小数（`YYYY-MM-DDTHH:MM:SSZ`）。 */
export function protocolTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Gateway 的时间是毫秒数字；也接受 ISO 8601 字符串（带不带毫秒都行）。
 * 对应 `OpenClawTranscript.date`。
 */
export function dateValue(value: unknown): Date | undefined {
  if (typeof value === "number" && value > 0 && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed);
  }
  return undefined;
}

export function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/** `SessionFormatting.truncate`：先 trim 再按字符数截断，不补省略号。 */
export function truncateText(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

/** `SessionFormatting.projectName`：路径的最后一段（Windows 与 POSIX 分隔符都认）。 */
export function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** 一段文本在数组里第一个「是字符串且非空」的候选。 */
export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
