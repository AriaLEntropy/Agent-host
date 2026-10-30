// OpenCode 连接器目录入口。
//
// 来源：botbus-protocol/Sources/BotBusConnectors/OpenCode/OpenCodeSessionReader.swift
// 以及 BotBusConnectorKit 的 AgentPaths.swift（AgentBinary.detect）。
// Apache-2.0；Behaviour-preserving TypeScript port for Agent-host。
//
// OpenCode 是 ACP 驱动的 agent（`kind = acp`、`connectorId = opencode`）。这里只读
// `~/.local/share/opencode/opencode.db`，不提供 start / followUp / approve / interrupt
// ——那些命令走现有 ACP 主干。
//
// `createOpenCodeSessionReader` 返回 `MessageReader`，接口没有 host，所以
// `BusTask.agentId` 默认是空串；对账侧要用真实 agent id 时，把 `options.agentId`
// 传给 `OpenCodeSessionReader` / `scanOpenCodeSessions`，或合并前自行替换。

export {
  IDLE_AFTER_MS,
  LAST_MESSAGE_LIMIT,
  MAX_SESSIONS,
  OPENCODE_CONNECTOR_ID,
  OpenCodeSessionReader,
  RECENT_WINDOW_MS,
  RUNNING_WINDOW_MS,
  TITLE_LIMIT,
  createOpenCodeSessionReader,
  defaultOpenCodeDatabasePath,
  detectOpenCodeBinary,
  entriesFromMessage,
  isEnough,
  openCodeTaskId,
  openReadOnly,
  parseAcpTaskId,
  projectName,
  scanOpenCodeSessions,
  singleLine,
  timestampFromMilliseconds,
  truncate,
  type OpenCodeScan,
  type OpenCodeSessionReaderOptions,
} from "./session-reader.js";
