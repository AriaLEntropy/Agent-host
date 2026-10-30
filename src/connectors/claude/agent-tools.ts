// Ported from botbus-protocol/Sources/BotBusConnectorKit/AgentTools.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { randomUUID } from "node:crypto";
import { isExecutableFile } from "./claude-hooks.js";
import { sortedJson } from "./claude-shared.js";

/** app 给连接器的"agent 工具"配置：嵌在 app 里的 `botbus` CLI 与本机工具服务器地址。 */
export type AgentToolsConfiguration = {
  /** `botbus` CLI 的绝对路径。 */
  cliPath: string;
  /** `http://127.0.0.1:<port>`，本机工具服务器。 */
  toolsURL: string;
};

/** CLI 真的在那儿且可执行、地址非空。每次注入前现查。 */
export function isUsable(configuration: AgentToolsConfiguration | null | undefined): boolean {
  if (!configuration) return false;
  return (
    configuration.toolsURL.length > 0 &&
    configuration.cliPath.length > 0 &&
    isExecutableFile(configuration.cliPath)
  );
}

/** 注入给 agent 的说明文字。 */
export const AgentToolsInstructions = {
  /**
   * @param mcp agent 这一侧有没有接上 `botbus` MCP server；没接上的只在 shell 里调 CLI。
   */
  text(cliPath: string, mcp = true): string {
    const intro =
      "This task was sent from the user's phone through BotBus. The user is not at this computer: they cannot see its screen or open localhost URLs. When you build or change something visual, share it";
    const tools = mcp
      ? ` with the \`botbus\` tools (MCP server \`botbus\`, or the CLI at \`${cliPath}\`):
- \`share_preview\` with a \`port\` for a running dev server, or a \`directory\` for static files (serves \`index.html\`). In this environment background processes may be killed when your turn ends, so to run a dev server pass its \`command\` (and \`cwd\`) and BotBus will keep it running.
- \`share_file\` for screenshots, images, videos or other files; \`share_link\` for public URLs. Videos are compressed automatically.`
      : ` by running the \`botbus\` CLI at \`${cliPath}\` from your shell (\`--help\` lists everything):
- \`preview --port <port>\` for a running dev server, or \`preview --dir <dir>\` for static files (serves \`index.html\`). Background processes may be killed when your turn ends, so to run a dev server pass \`--cmd "<command>"\` (and \`--cwd <dir>\`) and BotBus will keep it running.
- \`share <file>\` for screenshots, images, videos or other files; \`link <url>\` for public URLs. Videos are compressed automatically.`;
    return (
      intro +
      tools +
      "\n" +
      "Prefer relative URLs or the dev server's proxy over hard-coded `http://localhost:…` API URLs so the page works through the preview tunnel. Keep your final answer short; the user reads it on a phone."
    );
  },
};

/** 签发与绑定 task token 的最小内存实现（上游 TaskContextRegistry）。 */
export class TaskContextRegistry {
  private readonly byTask = new Map<string, string>();

  async token(taskId: string): Promise<string | undefined> {
    return this.byTask.get(taskId);
  }

  async issue(): Promise<string> {
    return randomUUID();
  }

  async bind(token: string, taskId: string): Promise<void> {
    this.byTask.set(taskId, token);
  }
}

/** 一次注入的全部内容：配置 + 这条任务的 token。 */
export class AgentToolsInjection {
  static readonly mcpServerName = "botbus";
  static readonly toolsURLVariable = "BOTBUS_TOOLS_URL";
  static readonly taskTokenVariable = "BOTBUS_TASK_TOKEN";
  static readonly cliVariable = "BOTBUS_CLI";

  readonly configuration: AgentToolsConfiguration;
  readonly token: string;

  constructor(configuration: AgentToolsConfiguration, token: string) {
    this.configuration = configuration;
    this.token = token;
  }

  /** 配置可用时签发（或续聊时复用）一个 token，否则 null = 不注入。 */
  static async make(
    configuration: AgentToolsConfiguration | null | undefined,
    registry: TaskContextRegistry,
    reusing?: string,
  ): Promise<AgentToolsInjection | null> {
    if (!isUsable(configuration) || !configuration) return null;
    if (reusing) {
      const existing = await registry.token(reusing);
      if (existing) return new AgentToolsInjection(configuration, existing);
    }
    return new AgentToolsInjection(configuration, await registry.issue());
  }

  /** 三个环境变量：子进程都靠它们找到工具服务器。 */
  get environment(): Record<string, string> {
    return {
      [AgentToolsInjection.toolsURLVariable]: this.configuration.toolsURL,
      [AgentToolsInjection.taskTokenVariable]: this.token,
      [AgentToolsInjection.cliVariable]: this.configuration.cliPath,
    };
  }

  get instructions(): string {
    return AgentToolsInstructions.text(this.configuration.cliPath);
  }

  get cliOnlyInstructions(): string {
    return AgentToolsInstructions.text(this.configuration.cliPath, false);
  }

  /**
   * `claude -p` 的追加参数。必须放在 prompt 之后；`--mcp-config` /
   * `--allowedTools` 是可变参数，由调用方随后的 `--input-format` 收尾。
   */
  claudeArguments(): string[] {
    return [
      "--append-system-prompt",
      this.instructions,
      "--mcp-config",
      this.mcpConfigJSON(),
      "--allowedTools",
      `mcp__${AgentToolsInjection.mcpServerName}`,
    ];
  }

  /** Claude 的内联 MCP 配置。 */
  mcpConfigJSON(): string {
    return sortedJson({
      mcpServers: {
        [AgentToolsInjection.mcpServerName]: {
          command: this.configuration.cliPath,
          args: ["mcp"],
          env: this.environment,
        },
      },
    });
  }
}
