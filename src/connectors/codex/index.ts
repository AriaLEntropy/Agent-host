/**
 * Codex 专属连接器的装配入口。
 *
 * 这里不承载行为：每个 `*.ts` 与上游 `Codex/*.swift` 一一对应，index 只负责
 * 选 launcher、拼 options，并保持 README 约定的两个工厂名。
 */
import type { ConnectorHost, MessageReader, TaskConnector } from "../ported/contract.js";
import {
  CodexAppServer,
  codexAppServerConfiguration,
  type CodexAppServerConfiguration,
  type CodexProcessLauncher,
  type CodexSleeper,
} from "./app-server.js";
import { CodexConnector, detectedCodexLauncher, type CodexConnectorOptions } from "./connector.js";
import { CodexMessageReader, createCodexMessageReader as createReader } from "./message-reader.js";
import type { CodexPaths } from "./paths.js";
import { CodexSubprocessLauncher } from "./subprocess.js";

export type CreateCodexConnectorOptions = CodexConnectorOptions & {
  /** 注入协议层（测试用假子进程）；不提供时按 launcher / executablePath 新建。 */
  server?: CodexAppServer;
  /** 注入进程启动器（测试用假 handle）。 */
  launcher?: CodexProcessLauncher;
  executablePath?: string;
  args?: string[];
  environment?: NodeJS.ProcessEnv;
  currentDirectory?: string;
  configuration?: Partial<CodexAppServerConfiguration>;
  /** 时间的注入缝：测试里不要真的等 3 秒 / 60 秒。 */
  sleeper?: CodexSleeper;
};

/**
 * 建 Codex 连接器。launcher 的优先级：注入的 server > 注入的 launcher >
 * 显式 executablePath > 自动探测 > 明确失败的 launcher（不会静默变成空壳）。
 */
export function createCodexConnector(
  host: ConnectorHost,
  options: CreateCodexConnectorOptions = {},
): TaskConnector {
  const server =
    options.server ??
    new CodexAppServer(
      options.launcher ??
        (options.executablePath === undefined
          ? (CodexSubprocessLauncher.detected() ?? detectedCodexLauncher())
          : new CodexSubprocessLauncher(
              options.executablePath,
              options.args ?? ["app-server"],
              options.environment,
              options.currentDirectory,
            )),
      codexAppServerConfiguration(options.configuration),
      options.sleeper,
    );
  return new CodexConnector(host, server, options);
}

export function createCodexMessageReader(
  options: { paths?: CodexPaths | (() => CodexPaths) } = {},
): MessageReader {
  return createReader(options);
}

export { CodexConnector, CodexAppServer, CodexMessageReader, CodexSubprocessLauncher };
export type { CodexConnectorOptions, CodexAppServerConfiguration };
