/**
 * Ported from botbus-protocol/Sources/BotBusConnectors/DesktopResume.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 在电脑上接着一条会话聊下去的终端命令（Mac 菜单「在电脑上继续」用）。
 *
 * 手机任务是 Agent-host 起的无界面子进程（`claude -p`、`codex app-server`、
 * `hermes chat -q`……），各家桌面 App 未必列得出来（Claude 桌面 App 的列表不收
 * `claude -p` 起的会话），所以统一交给各自 CLI 的交互模式接上。
 *
 * 这里只拼字符串：**不执行**、不检查命令是否存在、不读真实用户目录
 * （`resolveDesktopResume` 只做与连接器相同的可执行文件定位，可以注入替身）。
 */
import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import { detectClaudeBinary } from "./claude/claude-hooks.js";
import { CodexPaths } from "./codex/paths.js";
import { detectHermesBinary } from "./hermes/paths.js";
import { locateBinary } from "./locate.js";
import { detectOpenCodeBinary, OPENCODE_CONNECTOR_ID, parseAcpTaskId } from "./opencode/session-reader.js";
import { detectPiBinary, PiSessionReader } from "./pi/session-reader.js";
import { quoteWindowsArg } from "./ported/spawn.js";

/** 能接续的一档来源 + ACP + dsh（dsh 目前拼不出来）。 */
export type DesktopResumeSource = "claude" | "codex" | "hermes" | "pi" | "openclaw" | "acp" | "dsh";

export type DesktopResumePlatform = "posix" | "win32";

/** 拼命令只需要任务里的这几个字段（对应上游 `TaskRecord` 的子集）。 */
export type DesktopResumeTask = {
  id: string;
  source: string;
  /** 主仓库路径；会话在 worktree 里时用它分组，但不在它里面续。 */
  projectPath: string;
  /** 实际工作目录；来自 `TaskRecord.workingDirectory = worktreePath ?? projectPath`。 */
  worktreePath?: string;
  /** `source = acp` 时续的是哪个 agent；目前只有 opencode 能做终端接续。 */
  connectorId?: string;
};

export type DesktopResumeCommand = {
  executable: string;
  arguments: string[];
  workingDirectory: string;
  /**
   * 只给这一条命令放到 PATH 最前的目录。Pi / OpenClaw 是 `#!/usr/bin/env node`
   * 脚本，用户 shell 里排在前面的 node（常见是 nvm 的旧版本）可能跑不动它们；
   * 和连接器一样用脚本旁边的那个。Claude / Codex 是原生可执行文件（Codex 还在
   * App 包的 Resources 里），不往 PATH 里塞。
   */
  pathDirectories: string[];
};

export type DesktopResumeOptions = {
  /** Pi 的会话记录文件（续聊只认绝对路径，见 `PiSessionReader`）。 */
  piSessionFile?: string | null;
  /** 测试注入；默认可执行文件所在目录 + 软链接指向的目录。 */
  pathDirectories?: (executable: string) => string[];
};

/**
 * 按任务来源拼命令。返回 undefined = 拼不出来（id 不带来源前缀、Pi 找不到记录
 * 文件、未适配终端接续的 ACP agent、dsh）。
 */
export function desktopResumeCommand(
  task: DesktopResumeTask,
  executable: string,
  options: DesktopResumeOptions = {},
): DesktopResumeCommand | undefined {
  if (!executable) return undefined;
  const source = task.source as DesktopResumeSource;
  const prefix = `${source}:`;
  if (!task.id.startsWith(prefix)) return undefined;

  const native = nativeSessionId(task, prefix);
  if (native === undefined) return undefined;
  if (native.trim().length === 0) return undefined;

  const directories = options.pathDirectories ?? agentBinaryPathDirectories;
  let args: string[];
  let pathDirectories: string[] = [];
  switch (source) {
    case "claude":
      args = ["--resume", native];
      break;
    case "codex":
      args = ["resume", native];
      break;
    case "hermes":
      args = ["--resume", native];
      pathDirectories = directories(executable);
      break;
    case "pi":
      // 续聊只认会话记录文件的绝对路径；没有记录文件就拼不出来。
      if (!options.piSessionFile) return undefined;
      args = ["--session", options.piSessionFile];
      pathDirectories = directories(executable);
      break;
    case "openclaw":
      // sessionKey 自己带冒号（`agent:main:x`），只切来源前缀那一刀。
      args = ["tui", "--session", native];
      pathDirectories = directories(executable);
      break;
    case "acp":
      args = ["--session", native];
      pathDirectories = directories(executable);
      break;
    case "dsh":
      // dsh（0.1.5-rc.3）没有能核实的接续方式：网页端前端没有按会话的地址，
      // `dsh --profile tui --resume` 只是帮助里的示例，随包的 profile 模板里没有
      // 交互终端。先不拼。
      return undefined;
    default:
      return undefined;
  }
  return {
    executable,
    arguments: args,
    // Claude / Codex 按当前目录找会话；worktree 会话必须回到 worktree。
    workingDirectory: task.worktreePath?.trim() || task.projectPath,
    pathDirectories,
  };
}

/** 用本机默认路径找 CLI 与 Pi 记录文件后拼命令。会读盘，别在热路径上反复调。 */
export type DesktopResumeDeps = {
  /** 找某个来源的 CLI；默认复用各连接器的探测器。 */
  detect?: (source: DesktopResumeSource) => string | null | undefined;
  /** Pi 会话记录文件；默认读 `~/.pi/agent/sessions`。 */
  piSessionFile?: (
    nativeId: string,
  ) => string | null | undefined | Promise<string | null | undefined>;
  pathDirectories?: (executable: string) => string[];
};

export async function resolveDesktopResume(
  task: DesktopResumeTask,
  deps: DesktopResumeDeps = {},
): Promise<DesktopResumeCommand | undefined> {
  const source = task.source as DesktopResumeSource;
  if (!DEFAULT_SOURCES.includes(source)) return undefined;
  if (source === "dsh") return undefined;
  if (!task.id.startsWith(`${source}:`)) return undefined;

  const executable = (deps.detect ?? detectExecutable)(source);
  if (!executable) return undefined;

  let piSessionFile: string | null | undefined;
  if (source === "pi") {
    const native = task.id.slice(`${source}:`.length);
    const read = deps.piSessionFile ?? defaultPiSessionFile;
    piSessionFile = await read(native);
  }
  return desktopResumeCommand(task, executable, {
    piSessionFile,
    pathDirectories: deps.pathDirectories,
  });
}

/**
 * 一行 shell（默认按本机平台）：POSIX 是
 * `cd '<目录>' && [PATH='<目录>':"$PATH"] '<可执行文件>' '<参数>'…`，
 * 每一段都单引号转义；PATH 前缀只作用于这一条命令，之后留给用户的 shell 不受影响。
 * Windows 是 `cd /d "<目录>" && [set "PATH=<目录>;%PATH%" && ]<命令>`，
 * 参数按 Node 自己的 Windows 引号规则转义（与 `ported/spawn.ts` 一致）。
 */
export function desktopResumeShellLine(
  command: DesktopResumeCommand,
  platform: DesktopResumePlatform = defaultPlatform(),
): string {
  if (platform === "win32") return windowsShellLine(command);
  return posixShellLine(command);
}

/** POSIX 单引号转义：`'` → `'\''`。 */
export function posixQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function posixShellLine(command: DesktopResumeCommand): string {
  const line = [command.executable, ...command.arguments].map(posixQuote).join(" ");
  const path =
    command.pathDirectories.length === 0
      ? ""
      : `PATH=${posixQuote(command.pathDirectories.join(":"))}:"$PATH" `;
  return `cd ${posixQuote(command.workingDirectory)} && ${path}${line}`;
}

/**
 * Windows 的 `cmd.exe` 一行。`cd /d` 连盘符一起切；PATH 前缀用 `set "PATH=…"`
 * 只作用于这条命令。`%` 在 cmd 里仍会被展开，这里不替调用方改写用户路径
 * （改了就与真实目录对不上），只在注释里说明这个已知限制。
 */
function windowsShellLine(command: DesktopResumeCommand): string {
  const line = [command.executable, ...command.arguments].map(quoteWindowsArg).join(" ");
  const path =
    command.pathDirectories.length === 0
      ? ""
      : `set "PATH=${command.pathDirectories.join(";")};%PATH%" && `;
  return `cd /d ${quoteWindowsArg(command.workingDirectory)} && ${path}${line}`;
}

const DEFAULT_SOURCES: readonly DesktopResumeSource[] = [
  "claude",
  "codex",
  "hermes",
  "pi",
  "openclaw",
  "acp",
  "dsh",
];

/**
 * 原生会话 id：除了 ACP 一律是「id 去掉 `<来源>:` 前缀」，只切第一刀
 * （OpenClaw 的 sessionKey 自己带冒号）。ACP 是 `acp:<connectorId>:<sessionId>`，
 * 只有 opencode 接了终端接续。
 */
function nativeSessionId(task: DesktopResumeTask, prefix: string): string | undefined {
  if (task.source === "acp") {
    if (task.connectorId !== OPENCODE_CONNECTOR_ID) return undefined;
    const parsed = parseAcpTaskId(task.id);
    if (!parsed || parsed.connectorId !== OPENCODE_CONNECTOR_ID) return undefined;
    return parsed.sessionId;
  }
  return task.id.slice(prefix.length);
}

/** 上游 `AgentBinary.pathDirectories`：可执行文件所在目录 + 软链接指向的目录。 */
function agentBinaryPathDirectories(executable: string): string[] {
  const directories = [dirname(executable)];
  try {
    const resolved = dirname(realpathSync(executable));
    if (!directories.includes(resolved)) directories.push(resolved);
  } catch {
    // 软链接解不开（文件已删、Windows 权限不足）就用原目录。
  }
  return directories;
}

function detectExecutable(source: DesktopResumeSource): string | null | undefined {
  switch (source) {
    case "claude":
      return detectClaudeBinary();
    case "codex":
      return CodexPaths.detectCodexBinary();
    case "hermes":
      return detectHermesBinary();
    case "pi":
      return detectPiBinary();
    case "openclaw":
      return locateBinary("openclaw");
    case "acp":
      return detectOpenCodeBinary();
    case "dsh":
      return undefined;
  }
}

async function defaultPiSessionFile(nativeId: string): Promise<string | null> {
  return new PiSessionReader().sessionFile(nativeId);
}

function defaultPlatform(): DesktopResumePlatform {
  return process.platform === "win32" ? "win32" : "posix";
}
