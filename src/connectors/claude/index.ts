// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/*.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import type { ConnectorHost } from "../ported/contract.js";
import { ClaudeHookInstaller } from "./claude-hook-installer.js";
import { ClaudeConnector, type ClaudeConnectorOptions } from "./claude-connector.js";
import {
  createClaudeMessageReader,
} from "./claude-message-reader.js";
import { defaultSupportDirectory } from "./local-hook-server.js";

/**
 * `src/connectors/claude/` 的装配入口。
 *
 * `autoStart`（默认 true）在构造后拉起 Claude 的宿主服务：已装 hooks 才
 * `upgradeIfNeeded` 补齐新事件（没装过不安装）、起 hook server（默认支持目录 +
 * 共享密钥）、补回 7 天内的会话、开 presence sweep 与收尾检测。启动是异步的，
 * 失败记在 connector 的 `hostServicesState` / `hostServicesError` 里；
 * `whenHostServicesReady()` 可等它跑完。`autoStart:false` 保持纯被动后端。
 *
 * 返回的 connector 的 `stop()` / `dispose()` 幂等，会一并关掉 hook server 与计时器。
 */
export function createClaudeConnector(
  host: ConnectorHost,
  options?: ClaudeConnectorOptions,
): ClaudeConnector {
  const connector = new ClaudeConnector(host, options);
  if (options?.autoStart !== false) {
    void connector.startHostServices({
      supportDirectory: options?.supportDirectory ?? defaultSupportDirectory(),
      installer: options?.hookInstaller ?? ClaudeHookInstaller,
      requestedPort: options?.hookServerRequestedPort ?? null,
      portRetries: options?.hookServerPortRetries,
      logger: options?.logger,
    });
  }
  return connector;
}

export { createClaudeMessageReader };

export { ClaudeConnector } from "./claude-connector.js";
export type {
  ClaudeConnectorOptions,
  ClaudeHookInstallerLike,
  ClaudeHostServicesOptions,
  ClaudeHostServicesState,
} from "./claude-connector.js";
export { ClaudeMessageReader } from "./claude-message-reader.js";
export type { ClaudeMessageReaderOptions } from "./claude-message-reader.js";

export { ClaudeModels } from "./claude-models.js";
export { ClaudeFailure } from "./claude-failure.js";
export {
  ClaudeControlOutput,
  ClaudeControlChannel,
  allowDecision,
  denyDecision,
  parseClaudeControlRequest,
} from "./claude-control.js";
export type {
  ClaudeControlRequest,
  ClaudePermissionDecision,
} from "./claude-control.js";
export {
  ClaudeAskedQuestions,
  ClaudeHookOutput,
  claudePaths,
  detectClaudeBinary,
  hasClaudeHome,
  parseClaudeHookEvent,
  syntheticHookEvent,
  summarizeToolInput,
} from "./claude-hooks.js";
export type {
  ClaudeHookEvent,
  ClaudeHookKind,
  ClaudePaths,
  ClaudePathsOptions,
} from "./claude-hooks.js";
export {
  ClaudeSessionHistory,
  promptText,
  rawStringValue,
  titleValue,
} from "./claude-session-history.js";
export type { ClaudeSessionEntry, ClaudeTurnEnding } from "./claude-session-history.js";
export {
  ClaudeSessionPresence,
  ClaudeDesktopSessionIndex,
} from "./claude-session-presence.js";
export type { ClaudeDesktopRecord, ClaudeDesktopSessionIndex as ClaudeDesktopSessionIndexType } from "./claude-session-presence.js";
export { ClaudeHookInstaller, script } from "./claude-hook-installer.js";
export { ClaudeLateRequest } from "./claude-late-answer.js";
export {
  assistantTextInTranscript,
  buildEnvironment,
  claudeArguments,
  lastAssistantText,
  mediaType,
  resolveModelSelection,
  stdinMessage,
  stdinPayload,
} from "./claude-connector.js";
export { StreamJSONReader } from "./stream-json-reader.js";
export type { StreamJSONResult } from "./stream-json-reader.js";
export {
  LocalHookServer,
  LocalHookServerHold,
  defaultSharedSecretOptions,
  defaultSupportDirectory,
  NO_CONTENT,
  nowReply,
} from "./local-hook-server.js";
export type {
  LocalHookReply,
  LocalHookRequest,
  LocalHookResponse,
} from "./local-hook-server.js";
export {
  AgentToolsInjection,
  AgentToolsInstructions,
  TaskContextRegistry,
  isUsable,
} from "./agent-tools.js";
export type { AgentToolsConfiguration } from "./agent-tools.js";
export * from "./claude-shared.js";
