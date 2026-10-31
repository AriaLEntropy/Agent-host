/**
 * OpenClaw 专属连接器（协议一档）的公开入口。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/OpenClaw/
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 文件对应：
 * - `OpenClawConfig.swift`       → `config.ts`（JSON5 解析在 `json5.ts`）
 * - `OpenClawGateway.swift`      → `gateway.ts`
 * - `OpenClawConnector.swift`    → `connector.ts`
 * - `OpenClawMessageReader.swift`→ `message-reader.ts`
 */
import type { ConnectorHost } from "../ported/contract.js";
import { OpenClawConnector, type OpenClawConnectorOptions } from "./connector.js";
import {
  OpenClawMessageReader,
  type OpenClawMessageReaderOptions,
} from "./message-reader.js";

export function createOpenClawConnector(
  host: ConnectorHost,
  options: OpenClawConnectorOptions = {},
): OpenClawConnector {
  const connector = new OpenClawConnector(host, options);
  if (options.autoStart !== false) connector.start();
  return connector;
}

export function createOpenClawMessageReader(
  options: OpenClawMessageReaderOptions = {},
): OpenClawMessageReader {
  return OpenClawMessageReader.create(options);
}

export { OpenClawConnector } from "./connector.js";
export type {
  OpenClawApproval,
  OpenClawConnectorOptions,
  OpenClawHealthStatus,
  OpenClawPendingOption,
  OpenClawPendingQuestion,
  OpenClawRunStatus,
  OpenClawSession,
  OpenClawTiming,
} from "./connector.js";
export {
  DEFAULT_OPENCLAW_TIMING,
  OPENCLAW_ALLOW_ALWAYS_LABEL,
  OPENCLAW_ALLOW_ONCE_LABEL,
  OPENCLAW_SCOPE_QUESTION_ID,
  openClawApprovalFrom,
  openClawGatewayDecision,
  openClawRunStatus,
  openClawScopeQuestion,
  openClawSessionFromRow,
  openClawSessionKey,
  openClawTaskId,
} from "./connector.js";
export { OpenClawMessageReader } from "./message-reader.js";
export type { OpenClawFetch, OpenClawMessageReaderOptions } from "./message-reader.js";
export {
  OpenClawConfig,
  defaultWorkspaceDirectory,
  openClawPaths,
  portValue,
  secret,
} from "./config.js";
export type { OpenClawPaths } from "./config.js";
export {
  NodeWebSocketConnection,
  OpenClawGateway,
  OpenClawGatewayError,
  OpenClawWebSocketTransport,
  WebSocketClosed,
  defaultClientVersion,
  openClawGatewayConfiguration,
} from "./gateway.js";
export type {
  OpenClawGatewayConfiguration,
  OpenClawGatewayErrorKind,
  OpenClawGatewayEvent,
  WebSocketConnection,
  WebSocketTransport,
} from "./gateway.js";
export { parseJson5, Json5Error } from "./json5.js";
