// Ported from botbus-protocol/Sources/BotBusConnectorKit/AgentPaths.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// 上游 `HermesPaths` 与 `AgentBinary` 只取 Hermes 用到的部分：默认 `~/.hermes`、
// `state.db` 是否存在、按常见安装目录与 PATH 找 `hermes` 可执行文件，以及把可执行
// 文件所在目录放进子进程 PATH 最前。
//
// 路径一律由调用方注入；这里不会在模块加载时读用户的主目录。

import { accessSync, constants as fsConstants, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";

export type HermesPaths = {
  hermesHome: string;
};

export function defaultHermesHome(): string {
  return join(homedir(), ".hermes");
}

export function hermesPaths(hermesHome: string = defaultHermesHome()): HermesPaths {
  return { hermesHome };
}

/** `sessions` / `messages` 都在这一个 SQLite 里；文件不存在时返回 undefined。 */
export function stateDatabase(paths: HermesPaths): string | undefined {
  const file = join(paths.hermesHome, "state.db");
  return existsSync(file) ? file : undefined;
}

export function hasHermesHome(paths: HermesPaths): boolean {
  try {
    return statSync(paths.hermesHome).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 上游 `AgentBinary.detect("hermes")`：不走 `which`，先看常见安装目录，最后再看 PATH。
 * Windows 上还带 `.exe` / `.cmd` / `.bat` 后缀地试。
 */
export function detectHermesBinary(
  env: NodeJS.ProcessEnv = process.env,
  extraDirectories: string[] = [],
): string | undefined {
  const directories = [
    ...extraDirectories,
    ...commonDirectories(env),
    ...nvmBinDirectories(),
    ...splitSearchPath(searchPath(env)),
  ];
  const seen = new Set<string>();
  for (const directory of directories) {
    const expanded = expandTilde(directory);
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    for (const name of executableNames("hermes")) {
      const candidate = join(expanded, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 子进程环境：完整继承本进程，把可执行文件所在目录（以及它软链接指向的目录）放到 PATH 最前，
 * 再叠上 `extra`（注入的环境变量优先）。
 *
 * `Process.environment = nil` 这类坑在 Node 里等价于不传 `env`，所以这里始终给一份完整环境。
 */
export function agentBinaryEnvironment(
  executable: string,
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) environment[key] = value;
  }
  const directories = pathDirectories(executable);
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const existing = splitSearchPath(environment[pathKey] ?? "");
  const merged = [...directories, ...existing.filter((entry) => !directories.includes(entry))];
  environment[pathKey] = merged.join(delimiter);
  return { ...environment, ...extra };
}

export function pathDirectories(executable: string): string[] {
  const directories = [dirname(executable)];
  try {
    const resolved = dirname(realpathSync(executable));
    if (!directories.includes(resolved)) directories.push(resolved);
  } catch {
    // 软链接解不开（文件已删、Windows 权限不足）就用原目录。
  }
  return directories;
}

function commonDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [
      join(home, ".local", "bin"),
      join(appData, "npm"),
      join(localAppData, "Microsoft", "WinGet", "Links"),
      join(home, "scoop", "shims"),
      join(home, ".bun", "bin"),
      join(localAppData, "Volta", "bin"),
      join(localAppData, "pnpm"),
      join(programFiles, "nodejs"),
    ];
  }
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
    "/usr/bin",
  ];
}

function nvmBinDirectories(): string[] {
  if (process.platform === "win32") {
    const symlink = process.env.NVM_SYMLINK;
    return symlink ? [symlink] : [];
  }
  const root = join(homedir(), ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => join(root, version, "bin"));
  } catch {
    return [];
  }
}

function executableNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function searchPath(env: NodeJS.ProcessEnv): string | undefined {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key ? env[key] : undefined;
}

function splitSearchPath(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(delimiter).filter(Boolean);
}
