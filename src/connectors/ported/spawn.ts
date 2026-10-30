/**
 * Windows 上启动 `.cmd` / `.bat` 包装器。
 *
 * Node 的 `spawn` 直接执行 npm 生成的 `.cmd` 会得到 `EINVAL`
 * （CVE-2024-27980 之后的行为）。现有 ACP 主干用 `shell: true` 绕开，
 * 但 `shell: true` 不会给参数加引号：prompt、`--append-system-prompt`
 * 里的空格会被 cmd 拆开。这里统一走 `cmd.exe /d /s /c`，逐参数按
 * Node 自己的 Windows 引号规则转义。
 *
 * 非 Windows 或非脚本可执行文件保持原样。
 */
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

const WINDOWS_SCRIPT = /\.(cmd|bat)$/i;

export function isWindowsScript(executable: string): boolean {
  return process.platform === "win32" && WINDOWS_SCRIPT.test(executable);
}

/** 与 `spawn` 同签名；Windows 脚本自动经 `cmd.exe`。 */
export function spawnExecutable(
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (!isWindowsScript(executable)) return spawn(executable, [...args], options);
  const line = [executable, ...args].map(quoteWindowsArg).join(" ");
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsHide: options.windowsHide ?? true,
    windowsVerbatimArguments: true,
  });
}

/** 与 `spawnSync` 同签名；Windows 脚本自动经 `cmd.exe`。 */
export function spawnExecutableSync(
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnExecutableSync(
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<Buffer>;
export function spawnExecutableSync(
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;
export function spawnExecutableSync(
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  if (!isWindowsScript(executable)) return spawnSync(executable, [...args], options);
  const line = [executable, ...args].map(quoteWindowsArg).join(" ");
  return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsHide: options.windowsHide ?? true,
    windowsVerbatimArguments: true,
  });
}

/**
 * 逐参数加引号。移植 Node `lib/internal/child_process.js` 的
 * `escapeArgument`（不含 `doubleEscapeMetaChars`）：安全字符原样，
 * 其余包双引号，并处理参数内部的引号与结尾反斜杠。
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[^\w@%+=:,./-]/i.test(arg)) return arg;
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}
