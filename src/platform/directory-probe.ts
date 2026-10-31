/**
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/DirectoryProbe.swift and
 * Sources/BotBusConnectorKit/SystemPermissionInspection.swift (Apache-2.0).
 * Behaviour-preserving TypeScript port for Agent-host (FR-14.5.5).
 *
 * 读一次项目目录，认出「不在了」与「没权限」（协议 3.7 的 `projectMissing` /
 * `folderAccessDenied`）。agent 由 Agent-host 启动、沿用 Agent-host 的权限，
 * 所以这里读不了的目录，它起的 agent 也读不了。
 *
 * 边界（与上游一致）：
 * - 只读一次目录，失败后给结论，**不请求任何授权**、不调用 AX/辅助功能 API；
 *   系统权限弹窗只由注入的 `inspector` 观察已经出现的那个（`inspectSystemPermission`）。
 * - 判断不了就不下结论：超时、被取消、同一个目录还卡着，一律回 indeterminate。
 * - macOS 以外没有「文件与文件夹」授权这回事：显式回 `unsupported`（degraded），
 *   连目录都不碰。
 * - 任何情况下都不抛：`access` 自己抛错按「判断不了」处理。
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";

/** 一次目录读取的结论。nil（判断不了）在这里是 `null`。 */
export type DirectoryAccess = "readable" | "missing" | "denied" | "unreadable";

/** 协议 3.7 `FailureDiagnosis.folder` 的取值；开集，认不得的当 `other`。 */
export type FailureFolder =
  | "desktop"
  | "documents"
  | "downloads"
  | "iCloudDrive"
  | "removableVolume"
  | "networkVolume"
  | "other";

/** 结构上与 `ConnectorError.diagnosis` / 协议 3.7 的 `FailureDiagnosis` 兼容。 */
export type DirectoryDiagnosis = {
  kind: string;
  folder?: string;
  resetsAt?: string;
};

export type DirectoryProbeStatus = DirectoryAccess | "indeterminate" | "unsupported";

/**
 * `diagnose()` 只回诊断或 null（给连接器用）；`inspect()` 回更完整的结论，
 * 好让调用方区分「没病」「判断不了」「本平台不支持」。
 */
export type DirectoryProbeResult = {
  /** false = 本平台不做这项诊断（目前只有 macOS 做）。 */
  supported: boolean;
  status: DirectoryProbeStatus;
  /** status 为 missing / denied / unreadable 时给。 */
  diagnosis?: DirectoryDiagnosis;
  /** 只随 denied：目录算哪一类受保护位置（EPERM）；EACCES 时省略。 */
  folder?: FailureFolder;
  /** 判断不了或不支持时的一句话，进日志/诊断，不直接给手机。 */
  reason?: string;
};

export type DirectoryProbeOptions = {
  /** 测试注入；默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 默认 2 秒（上游 `defaultTimeout`）。 */
  timeoutMs?: number;
  home?: string;
  /**
   * 同步或异步读一次目录；`null` = 判断不了。可能是慢 IO，`inspect` 只在
   * 超时之前等它，超时后不再等（但登记要等它真的返回才解除）。
   */
  access?: (path: string) => DirectoryAccess | null | Promise<DirectoryAccess | null>;
  /** 被拒时这个目录算哪一类受保护位置；默认按 `home` 推断。 */
  folderFor?: (path: string) => FailureFolder;
  /** 判断 `/Volumes/<名字>` 是不是网络卷；默认读一次 statfs。 */
  isNetworkVolume?: (volume: string) => boolean;
};

/**
 * 还卡在读取里的目录，整个进程一份（上游 `InFlightPaths`）。Node 只有一条
 * 事件循环，一个 `Set` 就够；作用仍是「同一个目录卡着时不再起第二个读取」。
 */
const inFlight = new Set<string>();

export class DirectoryProbe {
  /** 上游 `DirectoryProbe.defaultTimeout`（2 秒）。 */
  static readonly defaultTimeoutMs = 2000;

  readonly platform: NodeJS.Platform;
  readonly timeoutMs: number;
  readonly home: string;

  private readonly access: (path: string) => DirectoryAccess | null | Promise<DirectoryAccess | null>;
  private readonly folderForPath: (path: string) => FailureFolder;

  constructor(options: DirectoryProbeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? DirectoryProbe.defaultTimeoutMs;
    this.home = options.home ?? homedir();
    this.access = options.access ?? (() => null);
    const isNetworkVolume = options.isNetworkVolume;
    this.folderForPath =
      options.folderFor ??
      ((path) =>
        DirectoryProbe.folderFor(path, this.home, {
          isNetworkVolume: isNetworkVolume ?? defaultIsNetworkVolume,
        }));
  }

  /** 只有 macOS 上有「文件与文件夹」授权；其他平台显式降级。 */
  get supported(): boolean {
    return this.platform === "darwin";
  }

  /**
   * 读不了就给诊断：不存在（或不是目录）→ `projectMissing`，被系统授权挡住 →
   * 带受保护位置的 `folderAccessDenied`，普通权限读不了 → 不带位置的
   * `folderAccessDenied`；读得了、判断不了、超时或本平台不支持 → null。
   */
  async diagnose(path: string, options: { signal?: AbortSignal } = {}): Promise<DirectoryDiagnosis | null> {
    const result = await this.inspect(path, options);
    return result.diagnosis ?? null;
  }

  /** 同一次读取的完整结论。永不抛；不支持时连目录都不碰。 */
  async inspect(path: string, options: { signal?: AbortSignal } = {}): Promise<DirectoryProbeResult> {
    if (!this.supported) {
      return {
        supported: false,
        status: "unsupported",
        reason: "目录授权诊断只在 macOS 上可用",
      };
    }
    if (!path || options.signal?.aborted) {
      return { supported: true, status: "indeterminate", reason: "没有要检查的目录" };
    }
    if (inFlight.has(path)) {
      return {
        supported: true,
        status: "indeterminate",
        reason: "同一个目录已经在读，不再起第二次",
      };
    }
    inFlight.add(path);

    // 登记在「读取真的返回」时才解除（超时只是不再等它），与上游一致。
    const reading: Promise<DirectoryAccess | null> = Promise.resolve()
      .then(() => this.access(path))
      .then((value) => value ?? null)
      .catch(() => null)
      .finally(() => {
        inFlight.delete(path);
      });

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timedOut = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, this.timeoutMs));
      if (options.signal) {
        onAbort = () => resolve("aborted");
        options.signal.addEventListener("abort", onAbort);
      }
    });

    let outcome: DirectoryAccess | null | "timeout" | "aborted";
    try {
      outcome = await Promise.race([reading, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }

    switch (outcome) {
      case "readable":
        return { supported: true, status: "readable" };
      case "missing":
        return { supported: true, status: "missing", diagnosis: { kind: "projectMissing" } };
      case "denied": {
        const folder = this.folderForPath(path);
        return {
          supported: true,
          status: "denied",
          folder,
          diagnosis: { kind: "folderAccessDenied", folder },
        };
      }
      case "unreadable":
        // 普通的文件权限：系统设置里的开关帮不上忙，不带受保护位置。
        return { supported: true, status: "unreadable", diagnosis: { kind: "folderAccessDenied" } };
      case "timeout":
        return {
          supported: true,
          status: "indeterminate",
          reason: `读目录超过 ${this.timeoutMs} 毫秒，不下结论`,
        };
      case "aborted":
        // 取消不是超时：别让调用方把「用户关掉了页面」当成「目录读得慢」。
        return { supported: true, status: "indeterminate", reason: "检查已取消，不下结论" };
      default:
        return { supported: true, status: "indeterminate", reason: "判断不了这个目录" };
    }
  }

  /** 真实文件系统：异步读目录，失败按错误码给结论。`access` 可用测试替身覆盖。 */
  static live(
    options: {
      home?: string;
      timeoutMs?: number;
      platform?: NodeJS.Platform;
      access?: (path: string) => DirectoryAccess | null | Promise<DirectoryAccess | null>;
    } = {},
  ): DirectoryProbe {
    return new DirectoryProbe({
      ...options,
      access:
        options.access ??
        (async (path) => {
          try {
            await readdir(path);
            return "readable";
          } catch (error) {
            return DirectoryProbe.accessFromError(error);
          }
        }),
    });
  }

  /**
   * `fs` 的错误 → 读目录的结论。Node 认 `code`（`EPERM` / `EACCES` / `ENOENT` /
   * `ENOTDIR`），也顺着 `cause` 与 `AggregateError.errors` 找。`EPERM` 是 macOS
   * 隐私授权挡住的样子，`EACCES` 是普通的文件权限；认不出给 null。
   */
  static accessFromError(error: unknown): DirectoryAccess | null {
    const codes = errorCodes(error);
    if (codes.has("EPERM")) return "denied";
    if (codes.has("EACCES")) return "unreadable";
    if (codes.has("ENOENT") || codes.has("ENOTDIR")) return "missing";
    return null;
  }

  /**
   * 目录落在哪类受保护位置（macOS「文件与文件夹」里的开关名对应的那几类）。
   * `/Volumes/<名字>` 按网络卷 / 可移除卷分，其余一律 `other`。
   */
  static folderFor(
    path: string,
    home: string,
    options: { isNetworkVolume?: (volume: string) => boolean } = {},
  ): FailureFolder {
    const target = standardizePath(path, home);
    const base = standardizePath(home);
    const under = (directory: string) => target === directory || target.startsWith(`${directory}/`);
    if (under(`${base}/Desktop`)) return "desktop";
    if (under(`${base}/Documents`)) return "documents";
    if (under(`${base}/Downloads`)) return "downloads";
    if (under(`${base}/Library/Mobile Documents`)) return "iCloudDrive";
    const parts = target.split("/").filter((part) => part.length > 0);
    if (parts.length >= 2 && parts[0] === "Volumes") {
      const volume = `/Volumes/${parts[1]}`;
      return (options.isNetworkVolume ?? (() => false))(volume)
        ? "networkVolume"
        : "removableVolume";
    }
    return "other";
  }
}

/**
 * 词法上的 `standardizingPath`：展开开头的 `~`、去掉 `.` 与多余分隔符、消掉 `..`。
 * 不解析软链接（上游的 `standardizingPath` 也不解析）。
 */
export function standardizePath(path: string, home = ""): string {
  let text = path;
  if (home && (text === "~" || text.startsWith("~/"))) text = home + text.slice(1);
  const absolute = text.startsWith("/");
  const parts: string[] = [];
  for (const part of text.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined;
}

// MARK: - 系统授权弹窗的观察（协议 2.10）

/** 授权弹窗截图的产物引用；只带识别用的字段，字节走既有的产物端点。 */
export type SystemPermissionArtifact = {
  id: string;
  kind?: string;
  title?: string;
  createdAt?: string;
  contentType?: string;
  size?: number;
};

/** 协议 2.10 `SystemPermissionNotice`。只是「发现过弹窗」的证据，不断言失败原因。 */
export type SystemPermissionNotice = {
  id: string;
  detectedAt: string;
  dialogText: string;
  screenshot?: SystemPermissionArtifact;
};

/**
 * app 提供的失败后诊断：只检查已经显示的系统授权弹窗，可返回已经上传的截图引用。
 * 返回 null / undefined 表示未发现弹窗或本机未启用诊断；**这里不请求权限、不操作弹窗**。
 */
export type SystemPermissionInspector = () =>
  | SystemPermissionNotice
  | null
  | undefined
  | Promise<SystemPermissionNotice | null | undefined>;

/**
 * 不让系统 API 或上传卡住命令回执：超时或取消先回 null，注入的检查还在跑也不等
 * （Node 没有取消 Promise，结果被丢掉）。检查抛错同样按「没发现」处理。
 */
export async function inspectSystemPermission(
  inspector: SystemPermissionInspector,
  timeoutMs: number,
  options: { signal?: AbortSignal } = {},
): Promise<SystemPermissionNotice | null> {
  if (options.signal?.aborted) return null;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<null>((resolve) => {
    const wait = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
    timer = setTimeout(() => resolve(null), wait);
    if (options.signal) {
      onAbort = () => resolve(null);
      options.signal.addEventListener("abort", onAbort);
    }
  });
  const inspection: Promise<SystemPermissionNotice | null> = Promise.resolve()
    .then(() => inspector())
    .then((notice) => notice ?? null)
    .catch(() => null);
  try {
    return await Promise.race([inspection, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * `/Volumes/<名字>` 是不是网络卷。上游读 `volumeIsLocal` 资源值；Node 的
 * `statfs` 只给一个数字文件系统类型（没有名字），各平台编码还不一样，这里
 * 不去猜——认不出就按本地卷算，与上游「读不到资源值就当本地」的保守方向一致。
 * 需要更准的分类时用 `isNetworkVolume` 注入。
 */
function defaultIsNetworkVolume(_volume: string): boolean {
  return false;
}

/** 顺着 `cause` / `AggregateError.errors` 收集错误码（最多两层，防环）。 */
function errorCodes(error: unknown): Set<string> {
  const codes = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 2 || typeof value !== "object" || value === null) return;
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string" && record.code.length > 0) codes.add(record.code);
    visit(record.cause, depth + 1);
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) visit(nested, depth + 1);
    }
  };
  visit(error, 0);
  return codes;
}
