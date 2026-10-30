/**
 * Pi 专属连接器的入口。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/Pi/ (PiConnector.swift,
 * PiMessageReader.swift, PiSessionReader.swift). (Apache-2.0).
 * Behaviour-preserving TypeScript port for Agent-host.
 */
export {
  createPiConnector,
  agentToolsInstructions,
  piArguments,
  piEnvironment,
  PiJSONStreamReader,
  PiSubprocess,
  PiSubprocessLauncher,
  PI_RELEASE_RETRY_DELAY_MS,
  PI_SESSION_ID_TIMEOUT_MS,
} from "./connector.js";
export type {
  PiConnector,
  PiConnectorOptions,
  PiJSONStreamResult,
  PiLaunchRequest,
  PiProcessHandle,
  PiProcessLauncher,
  PiToolsConfiguration,
  PiToolsInjection,
} from "./connector.js";

export { createPiMessageReader, PiMessageReader, transcriptFileRefCandidates } from "./message-reader.js";
export type { PiMessageReaderOptions } from "./message-reader.js";

export {
  PiSessionFile,
  PiSessionReader,
  PiSessionSource,
  SessionSourceUnavailable,
  defaultPiAgentDirectory,
  detectPiBinary,
  isoFromMs,
  parsePiMessage,
  piPaths,
  piSessionsDirectory,
  piTimestamp,
  projectName,
  projectsFromTasks,
  singleLine,
  toolSummary,
  truncate,
  PI_IDLE_AFTER_MS,
  PI_LAST_MESSAGE_LIMIT,
  PI_MAX_TASKS,
  PI_RECENT_WINDOW_MS,
  PI_RUNNING_WINDOW_MS,
  PI_TITLE_LIMIT,
} from "./session-reader.js";
export type {
  PiEntryKind,
  PiFileInfo,
  PiImageBlock,
  PiMessage,
  PiMessageRole,
  PiPaths,
  PiSessionEntry,
  PiSessionHeader,
  PiSessionReaderOptions,
  PiSessionSourceOptions,
  PiSessionSummary,
  PiSummarize,
  PiTail,
} from "./session-reader.js";
