// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshPaths.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DshDesktopInstallation } from "./desktop-installation.js";

/**
 * DeepSeek Harness（`@deepseek-ai/dsh`，协议 3.1）的本机目录与可执行文件。
 *
 * 主目录固定 `~/.dsh`：同 `AgentBinary`，GUI 进程读不到用户 shell 里的 `DSH_HOME`，所以不认它
 * （测试注入 `home`）。子进程一律显式带上 `DSH_HOME = home`，不让继承来的环境变量把 dsh 指到别处。
 */
export class DshPaths {
  static readonly agentId = "dsh";
  static readonly displayName = "DeepSeek Harness";
  static readonly npmPackage = "@deepseek-ai/dsh";
  /** 解 transcript 要 `zlib.zstdDecompressSync`：Node 22.15 / 23.8 起才有。 */
  static get minimumNodeVersion(): DshVersion {
    return new DshVersion(22, 15, 0);
  }

  readonly home: string;

  constructor(home: string = DshPaths.defaultHome()) {
    this.home = home;
  }

  static defaultHome(): string {
    return join(homedir(), ".dsh");
  }

  get sessionsDirectory(): string {
    return join(this.home, "sessions");
  }

  get projectionCacheDirectory(): string {
    return join(this.home, "storages", "session_projcache", "sessions");
  }

  get credentialsFile(): string {
    return join(this.home, ".credentials.yaml");
  }

  projectionCacheFile(sessionId: string): string {
    return join(this.projectionCacheDirectory, `${sessionId}.json`);
  }

  hasSessionsDirectory(): boolean {
    try {
      return statSync(this.sessionsDirectory).isDirectory();
    } catch {
      return false;
    }
  }

  /** 算"装了"：找得到可执行文件，或者 `sessions/` 在（只读也能看）。 */
  isInstalled(installation: DshInstallation | null): boolean {
    return installation !== null || this.hasSessionsDirectory();
  }

  /** 子进程环境里要叠上的：只有 `DSH_HOME`。 */
  get environment(): Record<string, string> {
    return { DSH_HOME: this.home };
  }
}

/** 找到的 dsh 怎么起。 */
export type DshInstallation = {
  /** PATH 类目录里的 dsh，或只在 npx 缓存里。 */
  kind: "binary" | "npxCache";
  /** 要执行的文件：`.binary` 是 dsh 本身，`.npxCache` 是 node。 */
  executable: string;
  /** 放在子命令之前的参数。 */
  leadingArguments: string[];
  /** npx 包或桌面 app 的版本；普通 PATH 包装器不读。 */
  version: string | null;
  /** 跑内嵌 node 脚本（解 transcript）用的 node。 */
  node: string | null;
};

/** `dsh --profile acp` 的完整参数。 */
export function acpArguments(installation: DshInstallation): string[] {
  return [...installation.leadingArguments, "--profile", "acp"];
}

/** 给内置 ACP 后端用的 spec（id `dsh`）。 */
export type DshAcpSpec = {
  id: string;
  name: string;
  executable: string | null;
  arguments: string[];
  environment: Record<string, string>;
  origin: "builtin" | "manifest" | "registry";
  defaultEnabled: boolean;
};

export function acpSpec(installation: DshInstallation | null, paths: DshPaths): DshAcpSpec {
  if (!installation) {
    return {
      id: DshPaths.agentId,
      name: DshPaths.displayName,
      executable: null,
      arguments: [],
      environment: paths.environment,
      origin: "manifest",
      defaultEnabled: true,
    };
  }
  return {
    id: DshPaths.agentId,
    name: DshPaths.displayName,
    executable: installation.executable,
    arguments: acpArguments(installation),
    environment: paths.environment,
    origin: "manifest",
    defaultEnabled: true,
  };
}

export type DetectInstallationOptions = {
  /** 找 PATH 类目录里的可执行文件（测试注入）。 */
  locate?: (name: string) => string | undefined;
  npxRoot?: string;
  desktopBundles?: string[];
  nodeCandidates?: string[];
  nodeVersion?: (node: string) => DshVersion | null;
};

/**
 * 本机的 dsh：优先桌面版随包 CLI，再 PATH 类目录，最后 npx 缓存。
 * 会读盘，`.binary` 时还可能跑几次 `node --version`（挑 node）。
 */
export function detectInstallation(options: DetectInstallationOptions = {}): DshInstallation | null {
  const locate = options.locate ?? ((name: string) => detectBinary(name));
  const npxRoot = options.npxRoot ?? defaultNpxRoot();
  const desktopBundles = options.desktopBundles ?? DshDesktopInstallation.defaultBundles();
  const nodeCandidates = options.nodeCandidates ?? defaultNodeCandidates();
  const nodeVersion = options.nodeVersion ?? cachedNodeVersion;

  if (desktopBundles.length > 0) {
    const desktop = DshDesktopInstallation.detect(
      desktopBundles,
      selectNode(nodeCandidates, nodeVersion),
    );
    if (desktop) return desktop;
  }
  const binary = locate("dsh");
  if (binary) {
    // 脚本旁边的 node 优先（npm 全局装时几乎总在同一个 bin 目录），再按常见位置找。
    const beside = pathDirectories(binary).map((directory) => join(directory, "node"));
    const node = selectNode([...beside, ...nodeCandidates], nodeVersion);
    return { kind: "binary", executable: binary, leadingArguments: [], version: null, node };
  }
  const package_ = newestNpxPackage(npxRoot);
  if (!package_) return null;
  const node = selectNode(nodeCandidates, nodeVersion);
  if (!node) return null;
  return {
    kind: "npxCache",
    executable: node,
    leadingArguments: [join(package_.directory, "lib", "bin.js")],
    version: package_.version.toString(),
    node,
  };
}

export function defaultNpxRoot(): string {
  return join(homedir(), ".npm", "_npx");
}

export type NpxPackage = { directory: string; version: DshVersion };

/** `<npxRoot>/*\/node_modules/@deepseek-ai/dsh/package.json` 里版本最高、且 `lib/bin.js` 在的那份。 */
export function newestNpxPackage(npxRoot: string): NpxPackage | null {
  let hashes: string[];
  try {
    hashes = readdirSync(npxRoot).sort();
  } catch {
    return null;
  }
  let best: NpxPackage | undefined;
  for (const hash of hashes) {
    const directory = join(npxRoot, hash, "node_modules", "@deepseek-ai", "dsh");
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(manifest)) continue;
    if (manifest.name !== DshPaths.npmPackage) continue;
    if (typeof manifest.version !== "string") continue;
    const version = DshVersion.parse(manifest.version);
    if (!version) continue;
    if (!existsSync(join(directory, "lib", "bin.js"))) continue;
    if (!best || version.compare(best.version) > 0) best = { directory, version };
  }
  return best ?? null;
}

/** 候选 node：与 `AgentBinary.detect` 同一组目录（常见 bin 目录在前，nvm 新版本在前）。 */
export function defaultNodeCandidates(): string[] {
  return [...commonDirectories(), ...nvmBinDirectories()].map((directory) => join(expandTilde(directory), "node"));
}

/** 按顺序挑第一个可执行、版本 ≥ `minimumNodeVersion` 的 node。 */
export function selectNode(candidates: readonly string[], version: (node: string) => DshVersion | null): string | null {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate)) continue;
    const resolved = resolveSymlinks(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const found = version(candidate);
    if (found && found.compare(DshPaths.minimumNodeVersion) >= 0) return candidate;
  }
  return null;
}

const nodeVersionMemo = new Map<string, DshVersion | null>();

/** 同 `probeNodeVersion`，按"解开软链接后的路径 + 修改时间"记住结果。 */
export function cachedNodeVersion(node: string): DshVersion | null {
  const resolved = resolveSymlinks(node);
  let modified = 0;
  try {
    modified = statSync(resolved).mtimeMs;
  } catch {
    modified = 0;
  }
  const key = `${resolved}|${modified}`;
  if (nodeVersionMemo.has(key)) return nodeVersionMemo.get(key) ?? null;
  const version = probeNodeVersion(node);
  nodeVersionMemo.set(key, version);
  return version;
}

/** 跑 `<node> --version`（`v24.1.0`），3 秒超时。失败返回 null。 */
export function probeNodeVersion(node: string): DshVersion | null {
  const result = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  if (result.status !== 0) return null;
  const text = String(result.stdout ?? "").trim();
  return DshVersion.parse(text.startsWith("v") ? text.slice(1) : text);
}

/** 本机 dsh 装在哪的缓存。 */
export class DshInstallationProbe {
  static readonly shared = new DshInstallationProbe();

  private cached: DshInstallation | null | undefined;
  private readonly detect: () => DshInstallation | null;

  constructor(detect: () => DshInstallation | null = () => detectInstallation()) {
    this.detect = detect;
  }

  current(): DshInstallation | null {
    if (this.cached !== undefined) return this.cached;
    return this.refresh();
  }

  refresh(): DshInstallation | null {
    const found = this.detect();
    this.cached = found;
    return found;
  }
}

/** semver 版本号（`0.1.5-rc.3`）。 */
export class DshVersion {
  constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
    readonly prerelease: string[] = [],
  ) {}

  static parse(text: string): DshVersion | null {
    const withoutBuild = text.split("+")[0] ?? "";
    const parts = withoutBuild.split("-");
    const core = (parts[0] ?? "").split(".");
    if (core.length !== 3) return null;
    const [major, minor, patch] = core.map((value) => (/^\d+$/.test(value) ? Number(value) : NaN));
    if (![major, minor, patch].every((value) => Number.isInteger(value) && value >= 0)) return null;
    let prerelease: string[] = [];
    if (parts.length > 1) {
      prerelease = parts.slice(1).join("-").split(".");
      if (prerelease.some((part) => part === "")) return null;
    }
    return new DshVersion(major, minor, patch, prerelease);
  }

  toString(): string {
    return `${this.major}.${this.minor}.${this.patch}${this.prerelease.length ? `-${this.prerelease.join(".")}` : ""}`;
  }

  compare(other: DshVersion): number {
    if (this.major !== other.major) return this.major < other.major ? -1 : 1;
    if (this.minor !== other.minor) return this.minor < other.minor ? -1 : 1;
    if (this.patch !== other.patch) return this.patch < other.patch ? -1 : 1;
    if (this.prerelease.length === 0 && other.prerelease.length === 0) return 0;
    if (this.prerelease.length === 0) return 1;
    if (other.prerelease.length === 0) return -1;
    const length = Math.max(this.prerelease.length, other.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      const left = this.prerelease[index];
      const right = other.prerelease[index];
      if (left === undefined) return -1;
      if (right === undefined) return 1;
      if (left === right) continue;
      const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
      const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
      if (leftNumber !== null && rightNumber !== null) return leftNumber < rightNumber ? -1 : 1;
      if (leftNumber !== null) return -1;
      if (rightNumber !== null) return 1;
      return left < right ? -1 : 1;
    }
    return 0;
  }
}

// MARK: - AgentBinary（Kit）

/** 常见的全局安装目录（Windows / Unix 各一套，照 `AgentBinary.commonDirectories`）。 */
export function commonDirectories(): string[] {
  if (process.platform === "win32") {
    const home = homedir();
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
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
    "~/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.npm-global/bin",
    "~/.bun/bin",
    "~/.volta/bin",
    "~/Library/pnpm",
    "/usr/bin",
  ];
}

export function nvmBinDirectories(): string[] {
  if (process.platform === "win32") {
    const symlink = process.env.NVM_SYMLINK;
    return symlink ? [symlink] : [];
  }
  const root = expandTilde("~/.nvm/versions/node");
  let versions: string[];
  try {
    versions = readdirSync(root).sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
    );
  } catch {
    return [];
  }
  return versions.reverse().map((version) => join(root, version, "bin"));
}

/** 按候选目录找一个可执行文件（Windows 带 `.exe` / `.cmd` / `.bat` 后缀地试）。 */
export function detectBinary(
  name: string,
  options: { extra?: string[]; pathEnv?: string } = {},
): string | undefined {
  const extra = options.extra ?? [];
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const directories =
    process.platform === "win32"
      ? [...extra, ...commonDirectories(), ...nvmBinDirectories(), ...pathEnv.split(delimiter).filter(Boolean)]
      : [...extra, ...commonDirectories(), ...nvmBinDirectories()];
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(expandTilde(directory), name + extension);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 子进程环境：把可执行文件所在目录（以及软链接指向的目录）放到 PATH 最前，再叠上 `extra`。 */
export function environmentFor(
  executable: string,
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) environment[key] = value;
  const directories = pathDirectories(executable);
  const existing = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  environment.PATH = [...directories, ...existing.filter((directory) => !directories.includes(directory))].join(delimiter);
  return { ...environment, ...extra };
}

/** 要放到 PATH 最前的目录：可执行文件所在目录，以及它软链接指向的目录。 */
export function pathDirectories(executable: string): string[] {
  const directories = [dirname(executable)];
  const resolved = resolveSymlinks(executable);
  const resolvedDirectory = dirname(resolved);
  if (!directories.includes(resolvedDirectory)) directories.push(resolvedDirectory);
  return directories;
}

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
}

export function resolveSymlinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 临时目录（测试与工具上下文用）。 */
export function dshTempRoot(): string {
  return tmpdir();
}
