# 一档专属连接器移植（Swift → TypeScript）

本目录存放从上游 Swift 参考实现移植过来的共享契约与移植规则。各连接器在
`src/connectors/<name>/` 下自成目录，只依赖 `contract.ts` 与 Node 标准库。

## 来源与许可

- 上游仓库：`botbus-protocol`（公开名 `botbus-io/botbus-protocol`），Apache-2.0。
- 连接器源码：`botbus-protocol/Sources/BotBusConnectors/<Name>/`。
- 公共契约：`botbus-protocol/Sources/BotBusConnectorKit/` 中的
  `TaskConnector.swift`、`MessageReader.swift`、`TranscriptEntry.swift`、
  `MessageReader` 窗口规则等。
- 行为说明：`botbus-protocol/docs/connectors.md`、`docs/connector-kit.md`。
- 需求依据：`原始需求提取.txt` E14.1、FR-14.10.3（Codex/Claude，P1）、
  FR-14.10.4（Hermes/Pi/OpenClaw，P2）。

按 FR-14.2.2，**每个移植文件头部必须注明来源文件与许可**：

```ts
// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexConnector.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
```

## 目录与命名

| 上游 Swift | 本文 TypeScript |
|---|---|
| `CodexConnector.swift` | `src/connectors/codex/connector.ts` |
| `CodexAppServer.swift` | `src/connectors/codex/app-server.ts` |
| `ClaudeHooks.swift` | `src/connectors/claude/hooks.ts` |
| `HermesStateReader.swift` | `src/connectors/hermes/state-reader.ts` |
| `PiSessionReader.swift` | `src/connectors/pi/session-reader.ts` |
| `OpenClawGateway.swift` | `src/connectors/openclaw/gateway.ts` |

规则：

- 一个 Swift 文件对应一个 TS 文件；不合并、不拆散，便于逐文件核对。
- 文件名用 kebab-case；类型与函数保留上游名字（去掉模块前缀后仍可辨认）。
- 只允许新增自己目录下的文件；**不要改** `src/connectors/runtime.ts`、
  `discover.ts`、`registry.ts`、`bus/store.ts` 或别人的目录。
- 每个连接器目录导出一个 `index.ts`，至少提供：
  - `create<Name>Connector(host: ConnectorHost, options?): TaskConnector`
  - `create<Name>MessageReader(options?): MessageReader`

## 接口

见 `contract.ts`。它对应上游 `TaskConnector` / `MessageReader` /
`TranscriptEntry` / `ConnectorOutcome` / `ConnectorError`，并保留：

- `start` / `followUp` 在“后端已接受命令”时返回，不等任务跑完；
- `retainsLiveOwnership` 与 `host.claimLive` / `releaseLive` 的所有权语义；
- 任务 id 一律 `<kind>:<原生 id>`；
- 读对话不依赖连接器进程是否在跑。

## 平台策略

上游大量使用 macOS 专属能力。移植时按下面的顺序处理：

1. **能跨平台的照抄**：子进程、stdio JSON-RPC、HTTP/WebSocket、JSONL、
   SQLite、文件监听（用轮询替代 FSEvents）。
2. **有 Node 等价物的换实现**：`node:sqlite`（Node ≥ 22.5，读取用
   `readOnly: true`）、`node:child_process`、`node:dgram`/`node:net`、
   `AbortSignal.timeout`。
3. **没有等价物的明确降级**：libproc 找进程用 `ps`/`/proc` 探测，
   Keychain 用环境变量或本用户可读文件替代，Unix socket 在 Windows 上
   用命名管道或直接禁用。降级处写 `// PORT:` 注释，并在报告里列出。

禁止为了“看起来完整”写空实现冒充成功：做不到的能力要抛
`ConnectorError` 或返回明确失败。

## 验收

在 `Agent-host/` 下：

```powershell
npx tsc -p tsconfig.json --noEmit
```

要求：自己目录下的文件零类型错误。全项目其他目录的既有错误可以忽略，
但不能由你的改动引入。至少为每个连接器写一个不依赖真实 agent 的冒烟测试
（`src/connectors/<name>/*.test.ts` 或 `test/connectors/<name>.test.ts`），
用假的子进程 / 假 HTTP / 假数据库覆盖解析与映射的纯逻辑。
