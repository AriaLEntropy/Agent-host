// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/*
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// `src/connectors/dsh/native/` 的装配入口：与现有 `dsh/{auth,mapping,paths,runtime,scanner,web}.ts`
// 那套 `dsh web` 功能子集相互独立，只依赖 `ported/contract.ts` 与 Node 标准库。

import type { ConnectorHost, MessageReader, TaskConnector } from "../../ported/contract.js";
import { DshConnector, DshMessageReader, type DshConnectorOptions, type DshMessageReaderOptions } from "./connector.js";

export function createDshConnector(host: ConnectorHost, options?: DshConnectorOptions): TaskConnector {
  return new DshConnector(host, options);
}

export function createDshMessageReader(options?: DshMessageReaderOptions): MessageReader {
  return new DshMessageReader(options);
}

export { DshConnector, DshMessageReader };
export type { DshConnectorOptions, DshMessageReaderOptions };

export {
  AcpSessionBusyError,
  AcpTranscriptUnavailableError,
  DEFAULT_DSH_TIMING,
  NativeAcpBackend,
  webFailure,
} from "./connector.js";
export type { AcpBackend, DshHealthHandler, DshHealthStatus, DshSleeper, DshTiming } from "./connector.js";

export {
  DshInstallationProbe,
  DshPaths,
  DshVersion,
  acpArguments,
  acpSpec,
  cachedNodeVersion,
  commonDirectories,
  defaultNodeCandidates,
  defaultNpxRoot,
  detectBinary,
  detectInstallation,
  environmentFor,
  expandTilde,
  isExecutableFile,
  newestNpxPackage,
  nvmBinDirectories,
  pathDirectories,
  probeNodeVersion,
  resolveSymlinks,
  selectNode,
} from "./paths.js";
export type { DetectInstallationOptions, DshAcpSpec, DshInstallation, NpxPackage } from "./paths.js";

export { DshDesktopInstallation, desktopCliExists } from "./desktop-installation.js";

export { DshSessionScanner, DshProjectionCache, decodeSegment, isSubagentHeader } from "./session-scanner.js";
export type { DshScannerOptions, DshSessionSummary } from "./session-scanner.js";

export {
  DshSessionFiles,
  DshTranscriptDecoder,
  DshTranscriptParser,
  messageId,
  pathCandidates,
  protocolTimestamp,
  readPlain,
  toolSummary,
  zstdFrames,
} from "./transcript.js";
export type { DshSessionLog, DshTranscriptDecoderOptions } from "./transcript.js";

export {
  DshLiveState,
  DshTaskMapping,
  SessionFormatting,
  applyEvents,
  approvalWaterfallFromEvent,
  factsFromScanned,
  factsFromWeb,
  liveStateEqual,
  toolCallCommand,
} from "./task-mapping.js";
export type {
  DshPendingQuestion,
  DshPendingRequest,
  DshSessionFacts,
  DshTaskRecord,
  DshToolCall,
  TaskOrigin,
  TaskStatus,
} from "./task-mapping.js";

export {
  AgentToolsInjection,
  AgentToolsInstructions,
  DshToolsContext,
  TaskContextRegistry,
  isUsable,
} from "./tools-context.js";
export type { AgentToolsConfiguration } from "./tools-context.js";

export {
  DshWebCredentials,
  DshWebCookie,
  base64Url,
  browserSessionSecret,
  cookieHeader,
  cookieName,
  cookieValue,
  decodeBase64Url,
  loadBrowserSessionSecret,
} from "./web-auth.js";

export {
  AsyncQueue,
  DshWebClient,
  DshWebEndpoint,
  DshWebError,
  DshWebMux,
  DshWebSocketHandshakeError,
  FetchDshHTTPTransport,
  NodeWebSocketTransport,
  cursorFromPastCursorMessage,
  isEmptyAnswer,
  questionAnswerJson,
} from "./web-client.js";
export type {
  DshHTTPResponse,
  DshHTTPTransport,
  DshQuestionAnswer,
  DshWebClientOptions,
  DshWebErrorKind,
  DshWebSocketConnection,
  DshWebSocketTransport,
  DshWebStream,
} from "./web-client.js";

export {
  DshWebLocator,
  SystemDshProcessListing,
  endpointsOf,
  environmentFromBytes,
  isDesktopHost,
  isDshEntry,
  isDshWeb,
  isLoopbackOrAny,
  listeningPortsFromProcNet,
  procNetAddress,
  splitNulTerminated,
  usesHome,
} from "./web-locator.js";
export type { DshProcessInfo, DshProcessListing, DshWebInstance } from "./web-locator.js";

export {
  boolValue,
  dshDate,
  eventSourceKind,
  eventText,
  eventTitle,
  eventTurnEndReason,
  eventsFrameFromJson,
  followFrameFromJson,
  integerValue,
  isRecord,
  isReplacement,
  isSubagentHeader as isSubagentSessionHeader,
  isSubagentSummary,
  jsonPath,
  questionFromJson,
  record,
  sessionEmitFrom,
  sessionEventFromJson,
  sessionHeaderFromJson,
  stringValue,
  summaryFromJson,
  turnEndKey,
  turnEndReasonFromJson,
  turnEndStatus,
  waterfallFromJson,
} from "./web-messages.js";
export type {
  DshEventsFrame,
  DshFollowFrame,
  DshQuestion,
  DshSessionEmit,
  DshSessionEvent,
  DshSessionHeader,
  DshTurnEndReason,
  DshWaterfall,
  DshWaterfallRequest,
  DshWebSessionSummary,
} from "./web-messages.js";
