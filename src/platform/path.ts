/**
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/PlatformPath.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 路径形状的平台差异集中在一处：绝对路径怎么认、"在某目录里"怎么比、分隔符、
 * `PATH` 的键与分隔符、可执行文件的后缀。macOS / Linux 上每个函数与原来的写法
 * （`startsWith("/")`、`root + "/"`、`split(":")`）等价；Windows 上认盘符与 UNC、
 * `\` 与 `/` 都当分隔符、比较不分大小写（NTFS 默认如此）。
 *
 * 这里只做字符串/磁盘元数据判断，不读写用户文件内容。
 */
import { accessSync, constants, statSync } from "node:fs";

export type PathPlatform = "win32" | "posix";

export type PlatformPathApi = ReturnType<typeof createPlatformPath>;

export function createPlatformPath(platform: PathPlatform = currentPlatform()) {
  const windows = platform === "win32";
  const separator = windows ? "\\" : "/";
  const listSeparator = windows ? ";" : ":";

  /** POSIX：以 `/` 开头。Windows：`C:\…` / `C:/…`，或 `\\server\share` 这种 UNC。 */
  function isAbsolute(path: string): boolean {
    if (!windows) return path.startsWith("/");
    const drive = path.slice(0, 3);
    if (
      drive.length === 3 &&
      ((drive.charCodeAt(0) >= 0x41 && drive.charCodeAt(0) <= 0x5a) ||
        (drive.charCodeAt(0) >= 0x61 && drive.charCodeAt(0) <= 0x7a)) &&
      drive[1] === ":" &&
      (drive[2] === "\\" || drive[2] === "/")
    ) {
      return true;
    }
    return path.startsWith("\\\\") || path.startsWith("//");
  }

  /** 统一分隔符（Windows 把 `/` 换成 `\`），去掉结尾多余的分隔符（根目录本身除外）。 */
  function normalized(path: string): string {
    if (!windows) {
      let text = path;
      while (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1);
      return text;
    }
    let text = path.replace(/\//g, "\\");
    while (text.length > 3 && text.endsWith("\\")) text = text.slice(0, -1);
    return text;
  }

  /** 两个路径是不是同一个（Windows 不分大小写、不管分隔符写法）。 */
  function same(left: string, right: string): boolean {
    if (!windows) return left === right;
    return normalized(left).toLowerCase() === normalized(right).toLowerCase();
  }

  /**
   * 当身份用的写法。Windows 上同一个目录会以 `C:/…` 与 `C:\…` 两种样子进来，
   * 这里统一成 `normalized` 的 `\` 写法、盘符大写；不是 Windows 绝对路径的
   * （空串、相对路径）与 POSIX 上一律原样返回。
   */
  function canonical(path: string): string {
    if (!windows) return path;
    if (!isAbsolute(path)) return path;
    let text = normalized(path);
    const first = text[0];
    if (first !== undefined && /[A-Za-z]/.test(first) && text.slice(1).startsWith(":")) {
      text = first.toUpperCase() + text.slice(1);
    }
    return text;
  }

  /** `path` 严格在 `root` 之下（按路径组件比，`/proj` 不包含 `/proj2/x`）。等于 `root` 不算。 */
  function isInside(path: string, root: string): boolean {
    return relativePathOf(path, root) !== null;
  }

  /** `path` 相对 `root` 的部分；不在 `root` 之下（或就是 `root`）返回 null。 */
  function relativePathOf(path: string, root: string): string | null {
    if (windows) {
      const base = normalized(root);
      const full = normalized(path);
      const prefix = base.endsWith("\\") ? base : `${base}\\`;
      if (full.length <= prefix.length) return null;
      if (full.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
      return full.slice(prefix.length);
    }
    const prefix = root === "/" ? "/" : `${root}/`;
    if (!path.startsWith(prefix) || path.length <= prefix.length) return null;
    return path.slice(prefix.length);
  }

  /** 路径的各段（空段丢掉）。Windows 上 `\` 与 `/` 都算分隔符，盘符 `C:` 是第一段。 */
  function components(path: string): string[] {
    return windows
      ? path.split(/[\\/]/).filter((part) => part.length > 0)
      : path.split("/").filter((part) => part.length > 0);
  }

  /** `root` 下接一段相对路径。 */
  function join(root: string, relative: string): string {
    const trimmed = root.endsWith(separator) ? root.slice(0, -1) : root;
    return windows
      ? `${trimmed}\\${relative.replace(/\//g, "\\")}`
      : `${trimmed}/${relative}`;
  }

  /** 根目录本身（`/`，或 Windows 的 `C:\`、`\\server\share`）。 */
  function isRoot(path: string): boolean {
    if (!windows) return path === "/";
    const text = normalized(path);
    if (text.length <= 3 && text.slice(1).startsWith(":")) return true;
    return text.startsWith("\\\\") && components(text).length <= 2;
  }

  // MARK: - 环境变量

  /** 环境变量表里 `PATH` 实际用的键。Windows 的环境变量不分大小写。 */
  function pathKey(environment: Record<string, string | undefined>): string {
    if (!windows) return "PATH";
    return Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "Path";
  }

  function searchPath(environment: Record<string, string | undefined>): string | undefined {
    return environment[pathKey(environment)];
  }

  function splitSearchPath(value: string): string[] {
    return value
      .split(listSeparator)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  function joinSearchPath(directories: readonly string[]): string {
    return directories.join(listSeparator);
  }

  /** 把 `PATH` 设成 `value`：Windows 上先去掉别的大小写写法的同名键，免得子进程拿到两份。 */
  function setSearchPath(
    value: string,
    environment: Record<string, string | undefined>,
  ): void {
    const key = pathKey(environment);
    if (windows) {
      for (const other of Object.keys(environment)) {
        if (other !== key && other.toLowerCase() === "path") delete environment[other];
      }
    }
    environment[key] = value;
  }

  // MARK: - 可执行文件

  /**
   * 找可执行文件时一个名字要试的文件名。POSIX 就是它自己；Windows 上没写扩展名时
   * 按 `.exe`、`.cmd`、`.bat` 依次试（npm 全局装的命令是 `.cmd` 包装），最后才试原名。
   */
  function executableFileNames(name: string): string[] {
    if (!windows) return [name];
    const base = name.replace(/[\\/]+$/, "");
    const lastPart = base.slice(Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\")) + 1);
    if (lastPart.includes(".")) return [name];
    return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
  }

  /**
   * Windows 上"存在即算可执行"太宽，这里只认可执行的后缀与普通文件；
   * POSIX 用 `access(X_OK)`。
   */
  function isExecutableFile(path: string): boolean {
    try {
      const info = statSync(path);
      if (!info.isFile()) return false;
      if (!windows) {
        accessSync(path, constants.X_OK);
        return true;
      }
      const dot = path.lastIndexOf(".");
      const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
      return ["exe", "cmd", "bat", "com"].includes(extension);
    } catch {
      return false;
    }
  }

  /** 在一组目录里找可执行文件（Windows 上带后缀地试）。 */
  function findExecutable(name: string, directories: readonly string[]): string | null {
    for (const directory of directories) {
      for (const file of executableFileNames(name)) {
        const candidate = join(directory, file);
        if (isExecutableFile(candidate)) return candidate;
      }
    }
    return null;
  }

  return {
    platform,
    separator,
    listSeparator,
    isAbsolute,
    normalized,
    same,
    canonical,
    isInside,
    relativePathOf,
    components,
    join,
    isRoot,
    pathKey,
    searchPath,
    splitSearchPath,
    joinSearchPath,
    setSearchPath,
    executableFileNames,
    isExecutableFile,
    findExecutable,
  };
}

function currentPlatform(): PathPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

export const platformPath = createPlatformPath();
