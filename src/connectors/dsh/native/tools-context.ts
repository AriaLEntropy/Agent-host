// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshToolsContext.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// `dsh web` 的 prompt 接口不能挂 MCP：任务凭据经私有 FIFO 交给 CLI，提示词里只出现管道路径。
// FIFO 的字节只在内核内存里；目录 0700、管道 0600；退出 / 停用后关闭并删除。

import {
  accessSync,
  constants as fsConstants,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ConnectorError } from "../../ported/contract.js";

/** 与 Kit 的 `AgentToolsConfiguration` 同一形状。 */
export type AgentToolsConfiguration = {
  /** 嵌在 app 里的 `botbus` CLI 绝对路径。 */
  cliPath: string;
  /** `http://127.0.0.1:<port>`，本机工具服务器。 */
  toolsURL: string;
};

export function isUsable(configuration: AgentToolsConfiguration): boolean {
  if (!configuration.toolsURL || !configuration.cliPath) return false;
  return isExecutableFile(configuration.cliPath);
}

function isExecutableFile(path: string): boolean {
  try {
    // Windows 上没有 X_OK 的意义，F_OK 即可（与上游 PlatformPath.isExecutableFile 一致）。
    accessSync(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 注入给 agent 的说明文字；各连接器共用同一份。 */
export const AgentToolsInstructions = {
  text(cliPath: string, mcp = true): string {
    const intro =
      "This task was sent from the user's phone through BotBus. The user is not at this computer: they cannot see its screen or open localhost URLs. When you build or change something visual, share it";
    const tools = mcp
      ? ` with the \`botbus\` tools (MCP server \`botbus\`, or the CLI at \`${cliPath}\`):
- \`share_preview\` with a \`port\` for a running dev server, or a \`directory\` for static files (serves \`index.html\`). In this environment background processes may be killed when your turn ends, so to run a dev server pass its \`command\` (and \`cwd\`) and BotBus will keep it running.
- \`share_file\` for screenshots, images, videos or other files; \`share_link\` for public URLs. Videos are compressed automatically.
`
      : ` by running the \`botbus\` CLI at \`${cliPath}\` from your shell (\`--help\` lists everything):
- \`preview --port <port>\` for a running dev server, or \`preview --dir <dir>\` for static files (serves \`index.html\`). Background processes may be killed when your turn ends, so to run a dev server pass \`--cmd "<command>"\` (and \`--cwd <dir>\`) and BotBus will keep it running.
- \`share <file>\` for screenshots, images, videos or other files; \`link <url>\` for public URLs. Videos are compressed automatically.
`;
    return (
      intro +
      tools +
      "\n" +
      "Prefer relative URLs or the dev server's proxy over hard-coded `http://localhost:…` API URLs so the page works through the preview tunnel. Keep your final answer short; the user reads it on a phone."
    );
  },
};

/** 一次注入的全部内容：配置 + 这条任务的 token。 */
export class AgentToolsInjection {
  static readonly mcpServerName = "botbus";
  static readonly toolsURLVariable = "BOTBUS_TOOLS_URL";
  static readonly taskTokenVariable = "BOTBUS_TASK_TOKEN";
  static readonly cliVariable = "BOTBUS_CLI";

  constructor(
    readonly configuration: AgentToolsConfiguration,
    readonly token: string,
  ) {}

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
}

/**
 * 手机下发任务的"身份证"：一次性签发的随机 token → 协议任务 id。
 *
 * 上游是 `TaskContextRegistry` actor；这里只需要 dsh 用到的 `issue` / `token` / 上限。
 */
export class TaskContextRegistry {
  static readonly maxTokens = 1000;
  static readonly tokenBytes = 32;

  private readonly taskByToken = new Map<string, string | undefined>();
  private readonly tokenByTask = new Map<string, string>();
  private readonly order: string[] = [];
  private readonly generate: () => string;

  constructor(generateToken: () => string = () => randomBytes(TaskContextRegistry.tokenBytes).toString("base64url")) {
    this.generate = generateToken;
  }

  issue(taskId?: string): string {
    if (taskId !== undefined) {
      const existing = this.tokenByTask.get(taskId);
      if (existing) return existing;
    }
    let token = this.generate();
    while (this.taskByToken.has(token)) token = this.generate();
    this.taskByToken.set(token, undefined);
    this.order.push(token);
    this.trim();
    if (taskId !== undefined) this.bind(token, taskId);
    return token;
  }

  bind(token: string, taskId: string): boolean {
    if (!this.taskByToken.has(token) || !taskId) return false;
    this.taskByToken.set(token, taskId);
    this.tokenByTask.set(taskId, token);
    return true;
  }

  token(taskId: string): string | undefined {
    return this.tokenByTask.get(taskId);
  }

  taskId(token: string): string | undefined {
    return this.taskByToken.get(token);
  }

  get tokenCount(): number {
    return this.taskByToken.size;
  }

  private trim(): void {
    while (this.order.length > TaskContextRegistry.maxTokens) {
      const victim = this.order.shift();
      if (victim === undefined) return;
      const bound = this.taskByToken.get(victim);
      this.taskByToken.delete(victim);
      if (bound !== undefined && this.tokenByTask.get(bound) === victim) this.tokenByTask.delete(bound);
    }
  }
}

/**
 * `dsh web` 续聊时把工具凭据经私有 FIFO 交给 CLI。
 *
 * 上游用 `mkfifo` + `O_RDONLY|O_NONBLOCK` + `FIONREAD` 只在管道空时补写一条记录。
 * Node 没有 ioctl：
 * - 非 Windows 平台用 `mkfifo` 命令建管道（`// PORT:`），写端非阻塞；
 * - 不做 FIONREAD 探测，改为每 250ms 尝试写一次（`// PORT:`）；写不进去（EAGAIN）就跳过；
 * - Windows 上直接抛错（与上游 `#if os(Windows)` 一致）。
 */
export class DshToolsContext {
  static readonly requestPrefix = "botbus-tools-";
  private static readonly marker = "\n\n<botbus-cli-context>\n";
  private static readonly end = "</botbus-cli-context>";

  readonly path: string;
  readonly configuration: AgentToolsConfiguration;
  readonly token: string;
  private readonly directory: string;
  private readonly reader: number;
  private readonly writer: number;
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(injection: AgentToolsInjection) {
    if (process.platform === "win32") {
      throw new ConnectorError("这个平台暂不支持 DeepSeek Harness 网页续聊的工具管道");
    }
    this.directory = mkdtempSync(join(tmpdir(), "botbus-dsh-tools-"));
    this.path = join(this.directory, "context");
    const fifo = spawnSync("mkfifo", ["-m", "600", this.path], { stdio: "ignore" });
    if (fifo.status !== 0) {
      rmSync(this.directory, { recursive: true, force: true });
      throw new ConnectorError("无法创建 DeepSeek Harness 工具管道");
    }
    const nonBlock = fsConstants.O_NONBLOCK ?? 0;
    // `// PORT:` 上游还带 O_CLOEXEC / O_NOFOLLOW；Node 在部分平台没有这两个常量，缺省为 0。
    const extraConstants = fsConstants as unknown as Record<string, number | undefined>;
    const extra = (extraConstants.O_CLOEXEC ?? 0) | (extraConstants.O_NOFOLLOW ?? 0);
    let reader = -1;
    let writer = -1;
    try {
      reader = openSync(this.path, fsConstants.O_RDONLY | nonBlock | extra);
      writer = openSync(this.path, fsConstants.O_WRONLY | nonBlock | extra);
    } catch (error) {
      if (reader >= 0) closeSync(reader);
      rmSync(this.directory, { recursive: true, force: true });
      throw new ConnectorError(
        `无法打开 DeepSeek Harness 工具管道：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.reader = reader;
    this.writer = writer;
    this.configuration = injection.configuration;
    this.token = injection.token;
    const payload = Buffer.concat([Buffer.from(JSON.stringify(injection.environment), "utf8"), Buffer.from([10])]);
    this.writeIfPossible(payload);
    this.timer = setInterval(() => this.writeIfPossible(payload), 250);
    this.timer.unref?.();
  }

  private writeIfPossible(payload: Buffer): void {
    if (this.closed) return;
    try {
      // `// PORT:` 没有 FIONREAD；先试读一次看管道里有没有未被 CLI 取走的记录。
      // 读到的旧记录直接丢弃（它只是给下一次 CLI 启动用的同一份凭据），为空才补写。
      const probe = Buffer.alloc(4096);
      let available = 0;
      try {
        available = readSync(this.reader, probe, 0, probe.length, null);
      } catch {
        available = 0;
      }
      if (available === 0) writeSync(this.writer, payload);
    } catch {
      // 非阻塞写不进去（EAGAIN）就等下个节拍。
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    try {
      closeSync(this.writer);
    } catch {
      // already closed
    }
    try {
      closeSync(this.reader);
    } catch {
      // already closed
    }
    rmSync(this.directory, { recursive: true, force: true });
  }

  prompt(text: string): string {
    const command = `BOTBUS_CONTEXT_PIPE=${quote(this.path)} ${quote(this.configuration.cliPath)}`;
    return (
      text +
      DshToolsContext.marker +
      AgentToolsInstructions.text(command, false) +
      "\n" +
      "Use that full command prefix for every BotBus CLI invocation. The task credentials are supplied by the pipe; do not read, print or copy them.\n" +
      DshToolsContext.end
    );
  }

  /** 手机只显示原来的用户消息；只有本连接器带标记的 RPC 才去掉追加的上下文。 */
  static visibleText(text: string, requestId: string | undefined): string {
    if (!requestId?.startsWith(DshToolsContext.requestPrefix)) return text;
    if (!text.endsWith(DshToolsContext.end)) return text;
    const index = text.lastIndexOf(DshToolsContext.marker);
    if (index < 0) return text;
    return text.slice(0, index);
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
