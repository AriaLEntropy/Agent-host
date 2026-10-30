// Hermes 连接器目录入口。
//
// 来源：botbus-protocol/Sources/BotBusConnectors/Hermes/
//   HermesConnector.swift、HermesMessageReader.swift、HermesStateReader.swift
// 以及 BotBusConnectorKit 的 AgentPaths.swift（HermesPaths / AgentBinary）。
// Apache-2.0；Behaviour-preserving TypeScript port for Agent-host。

import type { ConnectorHost, MessageReader, TaskConnector } from "../ported/contract.js";
import { HermesConnector, type HermesConnectorOptions } from "./connector.js";
import { HermesMessageReader, type HermesMessageReaderOptions } from "./message-reader.js";

export {
  HermesConnector,
  HermesSubprocessLauncher,
  HermesStreamReader,
  InMemoryTaskContextRegistry,
  agentToolsConfigurationIsUsable,
  agentToolsInstructions,
  argumentsFor,
  injectedEnvironment,
  type AgentToolsConfiguration,
  type AgentToolsInjection,
  type HermesConnectorOptions,
  type HermesLaunchRequest,
  type HermesProcessLauncher,
  type HermesRunningProcess,
  type HermesStreamResult,
  type HermesTaskContextRegistry,
} from "./connector.js";

export {
  HermesMessageReader,
  HermesToolCall,
  HermesToolCalls,
  entriesFromRow,
  type HermesMessageReaderOptions,
} from "./message-reader.js";

export {
  HermesMessageQueries,
  HermesSchemaError,
  HermesSourceUnavailable,
  HermesSQL,
  HermesStateReader,
  HermesStateSource,
  IDLE_AFTER_SECONDS,
  LAST_MESSAGE_LIMIT,
  RECENT_WINDOW_SECONDS,
  TITLE_LIMIT,
  openReadOnly,
  projectName,
  protocolTimestamp,
  singleLine,
  truncate,
  type HermesStateReaderOptions,
  type SqliteRow,
} from "./state-reader.js";

export {
  agentBinaryEnvironment,
  defaultHermesHome,
  detectHermesBinary,
  hasHermesHome,
  hermesPaths,
  stateDatabase,
  type HermesPaths,
} from "./paths.js";

/** 新建一个 Hermes 连接器；`host` 提供 store、所有权与时钟。 */
export function createHermesConnector(
  host: ConnectorHost,
  options?: HermesConnectorOptions,
): TaskConnector {
  return new HermesConnector(host, options);
}

/** 新建一个只读对话读取器；不依赖连接器进程是否在跑。 */
export function createHermesMessageReader(options?: HermesMessageReaderOptions): MessageReader {
  return new HermesMessageReader(options);
}
