// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexPaths.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/** `PlatformPath.isExecutableFile` 的等价物：Windows 只认可执行后缀，其余平台看 X_OK。 */
export function isExecutableFile(path: string): boolean {
  try {
    if (process.platform === "win32") {
      const info = statSync(path);
      if (!info.isFile()) return false;
      const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      return ["exe", "cmd", "bat", "com"].includes(extension);
    }
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveSymlinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

/** 定位 ~/.codex 下的数据库与 codex 可执行文件。 */
export class CodexPaths {
  readonly codexHome: string;

  constructor(codexHome: string = join(homedir(), ".codex")) {
    this.codexHome = codexHome;
  }

  /**
   * Codex 的库文件名带 schema 版本号（state_5.sqlite、thread_history_1.sqlite），取号最大的那个。
   */
  latestDatabase(prefix: string): string | undefined {
    let names: string[];
    try {
      names = readdirSync(this.codexHome);
    } catch {
      return undefined;
    }
    let best: { version: number; name: string } | undefined;
    for (const name of names) {
      if (!name.startsWith(`${prefix}_`) || !name.endsWith(".sqlite")) continue;
      const middle = name.slice(prefix.length + 1, name.length - ".sqlite".length);
      if (!/^\d+$/.test(middle)) continue;
      const version = Number(middle);
      if (!best || version > best.version) best = { version, name };
    }
    return best ? join(this.codexHome, best.name) : undefined;
  }

  get stateDatabase(): string | undefined {
    return this.latestDatabase("state");
  }

  get historyDatabase(): string | undefined {
    return this.latestDatabase("thread_history");
  }

  /**
   * ChatGPT.app 0.158 起将 CLI 移到 `Resources/codex-cli/bin/codex`；旧版仍用
   * `Resources/codex`。Codex.app 也可能使用新布局，因此两个 bundle 都检查两种路径。
   */
  static readonly knownBinaries = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];

  /**
   * 在指定的桌面 app 副本中查找 CLI。桥接重启必须用正在运行的那份 app，
   * 因为系统里可能存在多个同 bundle ID 的副本。
   */
  static detectCodexBinaryInBundle(appBundleURL: string): string | undefined {
    const resources = join(appBundleURL, "Contents", "Resources");
    const candidates = [join(resources, "codex-cli", "bin", "codex"), join(resources, "codex")];
    return candidates.find((candidate) => isExecutableFile(candidate));
  }

  static detectCodexBinary(): string | undefined {
    if (process.platform === "win32") return CodexPaths.detectWindowsCodexBinary();
    // 桌面 app 自带的那份优先（与桌面端同版本、同登录）；没有桌面 app 时（Linux 一直如此）找 npm / Homebrew 装的。
    const bundled = CodexPaths.knownBinaries.find((candidate) => isExecutableFile(candidate));
    return bundled ?? CodexPaths.detectInstalledCLI();
  }

  /**
   * 常见全局目录、nvm 与 PATH 里的 `codex`。npm 全局装的是 `bin/codex.js`（node 脚本），它只是去起
   * 按平台装进来的原生程序：找得到那个原生程序就直接用它（不依赖 GUI 进程的 PATH 里有 node，结束进程也干净），
   * 找不到才用脚本本身（`CodexSubprocessLauncher` 会把它旁边的 node 放到 PATH 最前）。Homebrew 装的就是原生程序。
   */
  static detectInstalledCLI(): string | undefined {
    const binary = AgentBinary.detect("codex");
    if (!binary) return undefined;
    const resolved = resolveSymlinks(binary);
    if (!resolved.endsWith(CodexPaths.npmScriptSuffix)) return binary;
    const packageDirectory = resolved.slice(0, resolved.length - (CodexPaths.npmScriptSuffix.length - "/@openai/codex".length));
    return CodexPaths.npmNativeBinary(packageDirectory) ?? binary;
  }

  static readonly npmScriptSuffix = "/@openai/codex/bin/codex.js";

  /**
   * `@openai/codex` 包里的原生程序：平台包（`@openai/codex-darwin-arm64` 等，optionalDependencies）装在包自己的
   * `node_modules` 下，或被提升成它的兄弟目录；更早的版本直接放在包里的 `vendor/`。
   */
  static npmNativeBinary(packageDirectory: string): string | undefined {
    const scope = packageDirectory.slice(0, Math.max(packageDirectory.lastIndexOf("/"), packageDirectory.lastIndexOf("\\")));
    for (const [platform, triple] of CodexPaths.nativePlatforms) {
      const inside = join("vendor", triple, "codex", "codex");
      const candidates = [
        join(packageDirectory, "node_modules", "@openai", `codex-${platform}`, inside),
        join(scope, `codex-${platform}`, inside),
        join(packageDirectory, inside),
      ];
      const found = candidates.find((candidate) => isExecutableFile(candidate));
      if (found) return found;
    }
    return undefined;
  }

  /** 本机能跑的平台包名与 Rust target triple，优先原生架构（Apple 芯片上 x64 的那份也能经 Rosetta 跑）。 */
  static get nativePlatforms(): Array<[string, string]> {
    if (process.platform === "darwin") {
      return process.arch === "arm64"
        ? [
            ["darwin-arm64", "aarch64-apple-darwin"],
            ["darwin-x64", "x86_64-apple-darwin"],
          ]
        : [["darwin-x64", "x86_64-apple-darwin"]];
    }
    return process.arch === "arm64"
      ? [["linux-arm64", "aarch64-unknown-linux-musl"]]
      : [["linux-x64", "x86_64-unknown-linux-musl"]];
  }

  /**
   * Windows 上的 Codex CLI 多半是 npm 全局装的（`@openai/codex`）：`codex.cmd` → node → 包里自带的 `codex.exe`。
   * 能找到包里的原生 `codex.exe` 就直接用它（少两层进程，结束进程树也干净），否则退回 `codex.cmd` / winget / PATH，
   * 都没有再用 Codex 桌面 app（Microsoft Store 包 `OpenAI.Codex`）解出来的那份。
   */
  static detectWindowsCodexBinary(): string | undefined {
    const environment = process.env;
    const home = homedir();
    const appData = environment["APPDATA"] || join(home, "AppData", "Roaming");
    const localAppData = environment["LOCALAPPDATA"] || join(home, "AppData", "Local");
    const vendor = join(appData, "npm", "node_modules", "@openai", "codex", "vendor");
    const triples = process.arch === "arm64"
      ? ["aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc"]
      : ["x86_64-pc-windows-msvc"];
    for (const triple of triples) {
      const candidate = join(vendor, triple, "codex", "codex.exe");
      if (isExecutableFile(candidate)) return candidate;
    }
    const installed = AgentBinary.detect("codex");
    if (installed) return installed;
    return CodexPaths.newestBinary(join(localAppData, "OpenAI", "Codex", "bin"), "codex.exe");
  }

  /**
   * Codex 桌面 app 把 CLI 解到 `%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe`，目录名是哈希不是版本号，
   * 更新后旧目录可能还留着（别的哈希目录里也可能只有 `rg.exe`），所以挑修改时间最新、带 `executable` 的那个。
   * 它与桌面 app 共用 `~/.codex`，登录态也是同一份。
   */
  static newestBinary(root: string, executable: string): string | undefined {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return undefined;
    }
    let best: { path: string; modified: number } | undefined;
    for (const name of names) {
      const candidate = join(root, name, executable);
      if (!isExecutableFile(candidate)) continue;
      let modified = Number.NEGATIVE_INFINITY;
      try {
        modified = statSync(candidate).mtimeMs;
      } catch {
        modified = Number.NEGATIVE_INFINITY;
      }
      // Swift 的 `max { ($0.modified, $0.path) < ($1.modified, $1.path) }`：同时间取字典序大的。
      if (!best || modified > best.modified || (modified === best.modified && candidate > best.path)) {
        best = { path: candidate, modified };
      }
    }
    return best?.path;
  }
}

/**
 * Kit `AgentPaths.swift` 里 `AgentBinary` 的最小移植：找常见全局目录与 PATH 里的可执行文件。
 * CodexPaths 只用到 `detect`，这里不展开其它 agent 的目录。
 */
export const AgentBinary = {
  commonDirectories(): string[] {
    const home = homedir();
    if (process.platform === "win32") {
      const environment = process.env;
      const appData = environment["APPDATA"] || join(home, "AppData", "Roaming");
      const localAppData = environment["LOCALAPPDATA"] || join(home, "AppData", "Local");
      const programFiles = environment["ProgramFiles"] || "C:\\Program Files";
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
    return ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "~/.npm-global/bin", "~/.bun/bin", "~/.volta/bin", "~/Library/pnpm", "/usr/bin"];
  },

  nvmBinDirectories(): string[] {
    if (process.platform === "win32") {
      const symlink = process.env["NVM_SYMLINK"];
      return symlink ? [symlink] : [];
    }
    const root = expandTilde("~/.nvm/versions/node");
    try {
      return readdirSync(root)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .map((version) => join(root, version, "bin"));
    } catch {
      return [];
    }
  },

  executableFileNames(name: string): string[] {
    if (process.platform !== "win32") return [name];
    if (name.includes(".")) return [name];
    return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
  },

  findExecutable(name: string, directories: string[]): string | undefined {
    for (const directory of directories) {
      for (const file of AgentBinary.executableFileNames(name)) {
        const candidate = join(directory, file);
        if (isExecutableFile(candidate)) return candidate;
      }
    }
    return undefined;
  },

  pathDirectories(): string[] {
    const environment = process.env;
    const key = Object.keys(environment).find((name) => name.toLowerCase() === "path") ?? "PATH";
    const value = environment[key] ?? (process.platform === "win32" ? "" : "/usr/bin:/bin:/usr/sbin:/sbin");
    const separator = process.platform === "win32" ? ";" : ":";
    return value.split(separator).filter((entry) => entry.length > 0);
  },

  /**
   * `extra` 排在最前，PATH 里的目录排在最后（Windows 拿得到用户 PATH；POSIX 上游不使用 PATH，
   * 这里为了行为一致同样把 PATH 放到最后，正常不会命中）。
   */
  detect(name: string, extra: string[] = []): string | undefined {
    const directories = [
      ...extra.map(expandTilde),
      ...AgentBinary.commonDirectories().map(expandTilde),
      ...AgentBinary.nvmBinDirectories(),
      ...(process.platform === "win32" ? AgentBinary.pathDirectories() : []),
    ];
    return AgentBinary.findExecutable(name, directories);
  },

  /** 子进程环境：把可执行文件所在目录（以及软链接指向的目录）放到 PATH 最前。 */
  environmentFor(executable: string): NodeJS.ProcessEnv {
    const directories: string[] = [];
    const add = (directory: string) => {
      if (directory && !directories.includes(directory)) directories.push(directory);
    };
    add(executable.slice(0, Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\"))));
    const resolved = resolveSymlinks(executable);
    add(resolved.slice(0, Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\"))));
    const separator = process.platform === "win32" ? ";" : ":";
    const existing = AgentBinary.pathDirectories();
    const merged = [...directories, ...existing.filter((entry) => !directories.includes(entry))];
    return { ...process.env, PATH: merged.join(separator) };
  },
};

/** 供测试与本模块使用：文件存在与否（不 follow 到目录）。 */
export function fileExists(path: string): boolean {
  return existsSync(path) && isFile(path);
}
