// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshWebLocator.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DshWebEndpoint } from "./web-client.js";

/** 本机一个进程的命令行与环境变量（只收同一用户的进程）。 */
export type DshProcessInfo = {
  pid: number;
  arguments: string[];
  environment: Record<string, string>;
};

/** 枚举进程与监听端口。测试注入假的；生产用 `SystemDshProcessListing`。 */
export interface DshProcessListing {
  /** 本用户的全部进程（读不到命令行的跳过）。 */
  processes(): DshProcessInfo[];
  /** 这个进程在回环（或全部）地址上监听的 TCP 端口，升序去重。 */
  listeningPorts(pid: number): number[];
}

/** 找到的一个 `dsh web`。 */
export type DshWebInstance = {
  pid: number;
  ports: number[];
  isDesktopHost: boolean;
};

export function endpointsOf(instance: DshWebInstance): DshWebEndpoint[] {
  return instance.ports.map((port) => new DshWebEndpoint(port));
}

/**
 * 找本机正在跑的 `dsh web` 或 Electron 的 `dsh-desktop-host/lib/index.js`（同一套已鉴权 web API）：
 * 命令行里有 dsh 入口、子命令是 `web`（或 `--profile web`）；环境里的 `DSH_HOME` 没设、或与我们用的主目录相同；
 * 再读它在回环地址上监听的端口。桌面优先，同类按 pid 升序。
 */
export const DshWebLocator = {
  locate(
    paths: { home: string },
    listing: DshProcessListing = new SystemDshProcessListing(),
  ): DshWebInstance[] {
    return listing
      .processes()
      .filter((process_) => isDshWeb(process_.arguments) && usesHome(process_.environment, paths))
      .sort((left, right) => {
        const leftDesktop = isDesktopHost(left.arguments);
        const rightDesktop = isDesktopHost(right.arguments);
        if (leftDesktop !== rightDesktop) return leftDesktop ? -1 : 1;
        return left.pid - right.pid;
      })
      .flatMap((process_) => {
        const ports = listing.listeningPorts(process_.pid);
        if (ports.length === 0) return [];
        return [{ pid: process_.pid, ports, isDesktopHost: isDesktopHost(process_.arguments) }];
      });
  },

  /** 命令行是不是 `dsh web`。 */
  isDshWeb,
  usesHome,
  isDesktopHost,
  isDshEntry,
};

/**
 * 命令行是不是 `dsh web`。入口之后的参数里：`--profile web` / `--profile=web`，
 * 或者第一个不以 `-` 开头的参数是 `web`。`npm exec @deepseek-ai/dsh web` 这种包名参数不算入口。
 */
export function isDshWeb(arguments_: readonly string[]): boolean {
  if (isDesktopHost(arguments_)) return true;
  const entry = arguments_.findIndex(isDshEntry);
  if (entry < 0) return false;
  const rest = arguments_.slice(entry + 1);
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--profile=web") return true;
    if (rest[index] === "--profile" && index + 1 < rest.length && rest[index + 1] === "web") return true;
  }
  let skipNext = false;
  for (const argument of rest) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (argument === "--profile") {
      skipNext = true;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument === "web";
  }
  return false;
}

export function isDesktopHost(arguments_: readonly string[]): boolean {
  return arguments_.some((argument) => argument.endsWith("/@deepseek-ai/dsh-desktop-host/lib/index.js"));
}

export function isDshEntry(argument: string): boolean {
  if (argument.endsWith("/@deepseek-ai/dsh/lib/bin.js")) return true;
  if (argument.startsWith("@")) return false;
  return basename(argument) === "dsh";
}

/**
 * 这个进程用的主目录就是我们的：`DSH_HOME` 设了就看它（展开 `~`、规范化之后比），
 * 没设就是它自己 `HOME` 下的 `.dsh`（环境里没有 `HOME` 时按本用户的主目录算）。
 */
export function usesHome(
  environment: Readonly<Record<string, string>>,
  paths: { home: string },
): boolean {
  let effective: string;
  const configured = environment.DSH_HOME;
  if (configured !== undefined && configured.length > 0) {
    effective = configured;
  } else {
    const home = environment.HOME && environment.HOME.length > 0 ? environment.HOME : homedir();
    effective = joinPath(home, ".dsh");
  }
  return normalizedPath(effective) === normalizedPath(paths.home);
}

function normalizedPath(path: string): string {
  let text = adjustTilde(path);
  try {
    text = realpathSync(text);
  } catch {
    text = resolve(text);
  }
  while (text.length > 1 && (text.endsWith("/") || text.endsWith("\\"))) text = text.slice(0, -1);
  if (process.platform === "win32") text = text.toLowerCase();
  return text;
}

function adjustTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return joinPath(homedir(), path.slice(2));
  return path;
}

function joinPath(directory: string, name: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return directory.endsWith("/") || directory.endsWith("\\") ? directory + name : directory + separator + name;
}

/**
 * 枚举本机进程与监听端口。
 *
 * `// PORT:` 上游 macOS 用 libproc + `KERN_PROCARGS2`，Linux 读 `/proc`。这里：
 * - Linux：照上游读 `/proc/<pid>/cmdline`、`/proc/<pid>/environ`、fd 的 socket inode 与 `/proc/<pid>/net/tcp{,6}`；
 * - macOS：没有 libproc 绑定，用 `ps` 取 pid/uid/命令行（拿不到环境变量，按"没设 DSH_HOME"处理），
 *   监听端口用 `lsof -iTCP -sTCP:LISTEN`；`lsof` 不在时返回空数组（明确降级，不伪装）；
 * - Windows：明确降级，返回空列表（`// PORT:`）。Windows 上没有与 libproc 对等的 Node 标准库能力。
 */
export class SystemDshProcessListing implements DshProcessListing {
  processes(): DshProcessInfo[] {
    if (process.platform === "linux") return this.linuxProcesses();
    if (process.platform === "darwin") return this.macProcesses();
    // `// PORT:` Windows 降级：不枚举进程，`DshWebLocator` 因此找不到 web（退回扫盘）。
    return [];
  }

  listeningPorts(pid: number): number[] {
    if (process.platform === "linux") return this.linuxListeningPorts(pid);
    if (process.platform === "darwin") return this.macListeningPorts(pid);
    // `// PORT:` Windows 降级。
    return [];
  }

  private linuxProcesses(): DshProcessInfo[] {
    const uid = process.getuid?.();
    if (uid === undefined) return [];
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return [];
    }
    const result: DshProcessInfo[] = [];
    for (const name of entries) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      let owner: number;
      try {
        owner = statSync(`/proc/${pid}`).uid;
      } catch {
        continue;
      }
      if (owner !== uid) continue;
      let cmdline: Buffer;
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`);
      } catch {
        continue;
      }
      const arguments_ = splitNulTerminated(cmdline);
      if (arguments_.length === 0) continue;
      let environ: Buffer = Buffer.alloc(0);
      try {
        environ = readFileSync(`/proc/${pid}/environ`);
      } catch {
        environ = Buffer.alloc(0);
      }
      result.push({ pid, arguments: arguments_, environment: environmentFromBytes(environ) });
    }
    return result.sort((left, right) => left.pid - right.pid);
  }

  private macProcesses(): DshProcessInfo[] {
    const result = spawnSync("ps", ["-axo", "pid=,uid=,command="], { encoding: "utf8", timeout: 5000 });
    if (result.status !== 0) return [];
    const uid = process.getuid?.();
    const processes: DshProcessInfo[] = [];
    for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (uid !== undefined && Number(match[2]) !== uid) continue;
      processes.push({
        pid,
        arguments: splitCommandLine(match[3]),
        // `// PORT:` `ps` 不带环境变量；按未设置 DSH_HOME 处理（默认主目录）。
        environment: {},
      });
    }
    return processes.sort((left, right) => left.pid - right.pid);
  }

  private macListeningPorts(pid: number): number[] {
    // `// PORT:` libproc `PROC_PIDLISTFDS` / `PROC_PIDFDSOCKETINFO` → `lsof`。
    const result = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0) return [];
    const ports = new Set<number>();
    for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
      if (!line.startsWith("n")) continue;
      const address = line.slice(1);
      const match = /(?:\*|0\.0\.0\.0|127\.\d+\.\d+\.\d+|\[::1?\]|\[::\]):(\d+)$/.exec(address);
      if (!match) continue;
      const port = Number(match[1]);
      if (port > 0) ports.add(port);
    }
    return [...ports].sort((left, right) => left - right);
  }

  private linuxListeningPorts(pid: number): number[] {
    const directory = `/proc/${pid}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(directory);
    } catch {
      return [];
    }
    const inodes = new Set<string>();
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`${directory}/${fd}`);
      } catch {
        continue;
      }
      if (!target.startsWith("socket:[") || !target.endsWith("]")) continue;
      inodes.add(target.slice("socket:[".length, -1));
    }
    if (inodes.size === 0) return [];
    const ports = new Set<number>();
    for (const table of ["tcp", "tcp6"]) {
      let text: string;
      try {
        text = readFileSync(`/proc/${pid}/net/${table}`, "utf8");
      } catch {
        continue;
      }
      for (const port of listeningPortsFromProcNet(text, inodes)) ports.add(port);
    }
    return [...ports].sort((left, right) => left - right);
  }
}

/** 拆 `/proc/net/tcp` 或 `tcp6` 的内容：状态 LISTEN、inode 在 `inodes` 里、本地地址是回环或全零的那些行。 */
export function listeningPortsFromProcNet(text: string, inodes: ReadonlySet<string>): number[] {
  const ports = new Set<number>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    const fields = line.split(/\s+/).filter((field) => field.length > 0);
    if (fields.length < 10) continue;
    if (fields[3] !== "0A" || !inodes.has(fields[9])) continue;
    const local = fields[1].split(":");
    if (local.length !== 2) continue;
    const port = Number.parseInt(local[1], 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    const address = procNetAddress(local[0]);
    if (!address || !isLoopbackOrAny(address)) continue;
    ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/** `0100007F` → [127, 0, 0, 1]；tcp6 的 32 位十六进制同理，每 8 位一个小端的 32 位字。 */
export function procNetAddress(hex: string): number[] | undefined {
  if (hex.length !== 8 && hex.length !== 32) return undefined;
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 8) {
    const word = Number.parseInt(hex.slice(index, index + 8), 16);
    if (!Number.isInteger(word)) return undefined;
    bytes.push(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff);
  }
  return bytes;
}

/** 127.0.0.0/8、::1、0.0.0.0、::、::ffff:127.x.x.x。 */
export function isLoopbackOrAny(raw: readonly number[]): boolean {
  if (raw.length === 4) return raw.every((byte) => byte === 0) || raw[0] === 127;
  const any = raw.every((byte) => byte === 0);
  const loopback = raw.slice(0, -1).every((byte) => byte === 0) && raw.at(-1) === 1;
  const mapped =
    raw.slice(0, 10).every((byte) => byte === 0) && raw[10] === 0xff && raw[11] === 0xff && raw[12] === 127;
  return any || loopback || mapped;
}

/** `\0` 结尾的一串串（`/proc/<pid>/cmdline`、`environ`）。 */
export function splitNulTerminated(bytes: Buffer): string[] {
  const parts = bytes.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** 环境变量里没有 `=` 的项跳过。 */
export function environmentFromBytes(bytes: Buffer): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of splitNulTerminated(bytes)) {
    if (!entry) continue;
    const equals = entry.indexOf("=");
    if (equals < 0) continue;
    environment[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return environment;
}

/** 极简 shell 分词（macOS `ps` 的 command 列只是给人看的）。 */
function splitCommandLine(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}
