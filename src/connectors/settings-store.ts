import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostDataDir } from "../config.js";
import { normalizeProjectPath } from "../bus/project-path.js";

// 保持既有导出面：调用方仍然可以从 settings-store 拿 normalizeProjectPath。
export { normalizeProjectPath } from "../bus/project-path.js";

/**
 * 本机连接器设置：项目级自动批准（协议 3.3）与连接器启停（协议 3.9）。
 *
 * 文件默认落在 `hostDataDir()/connector-settings.json`，可用
 * `AGENT_HOST_CONNECTOR_SETTINGS` 或 `options.path` 覆盖（测试用）。
 * 内容只有本机路径、agentId、连接器 kind 与布尔开关，不含任何凭据。
 * 读取整段容错：文件不在、JSON 坏了、版本不认识都当作空设置，绝不让
 * Agent 起不来。
 */

export type ConnectorSettingsAutoApproveEntry = {
  agentId: string;
  projectPath: string;
  enabled: boolean;
};

export type ConnectorSettingsConnectorEntry = {
  kind: string;
  connectorId?: string;
  enabled: boolean;
};

export type ConnectorSettingsState = {
  version: 1;
  autoApprove: ConnectorSettingsAutoApproveEntry[];
  connectors: ConnectorSettingsConnectorEntry[];
};

const SETTINGS_VERSION = 1;

export function connectorSettingsPath(path?: string): string {
  const explicit = path?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.AGENT_HOST_CONNECTOR_SETTINGS?.trim();
  if (fromEnv) return fromEnv;
  return join(hostDataDir(), "connector-settings.json");
}

function emptyState(): ConnectorSettingsState {
  return { version: SETTINGS_VERSION, autoApprove: [], connectors: [] };
}

function copyState(state: ConnectorSettingsState): ConnectorSettingsState {
  return {
    version: SETTINGS_VERSION,
    autoApprove: state.autoApprove
      .map((entry) => ({ ...entry }))
      .sort((left, right) =>
        left.agentId.localeCompare(right.agentId) || left.projectPath.localeCompare(right.projectPath),
      ),
    connectors: state.connectors
      .map((entry) => ({ ...entry }))
      .sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        (left.connectorId ?? "").localeCompare(right.connectorId ?? ""),
      ),
  };
}

type SettingsProblem = "read" | "corrupt" | "version";
type SettingsRead = { state: ConnectorSettingsState; problem?: SettingsProblem };

function sanitizeState(raw: Record<string, unknown>): ConnectorSettingsState {
  const autoApprove = new Map<string, ConnectorSettingsAutoApproveEntry>();
  for (const item of Array.isArray(raw.autoApprove) ? raw.autoApprove : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.agentId !== "string" || !entry.agentId.trim()) continue;
    if (typeof entry.projectPath !== "string") continue;
    if (typeof entry.enabled !== "boolean") continue;
    const projectPath = normalizeProjectPath(entry.projectPath);
    if (!projectPath) continue;
    const agentId = entry.agentId.trim();
    autoApprove.set(`${agentId}\u0000${projectPath}`, { agentId, projectPath, enabled: entry.enabled });
  }

  const connectors = new Map<string, ConnectorSettingsConnectorEntry>();
  for (const item of Array.isArray(raw.connectors) ? raw.connectors : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.kind !== "string" || !entry.kind.trim()) continue;
    if (typeof entry.enabled !== "boolean") continue;
    const kind = entry.kind.trim();
    const connectorId =
      typeof entry.connectorId === "string" && entry.connectorId.trim()
        ? entry.connectorId.trim()
        : undefined;
    const connector: ConnectorSettingsConnectorEntry = {
      kind,
      ...(connectorId ? { connectorId } : {}),
      enabled: entry.enabled,
    };
    connectors.set(`${kind}\u0000${connectorId ?? ""}`, connector);
  }

  return copyState({
    version: SETTINGS_VERSION,
    autoApprove: [...autoApprove.values()],
    connectors: [...connectors.values()],
  });
}

async function readSettings(path: string): Promise<SettingsRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // 文件不存在是正常状态；其它读取失败（权限等）也按空设置继续。
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { state: emptyState() };
    }
    return { state: emptyState(), problem: "read" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptyState(), problem: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: emptyState(), problem: "corrupt" };
  }
  if ((parsed as Record<string, unknown>).version !== SETTINGS_VERSION) {
    return { state: emptyState(), problem: "version" };
  }
  return { state: sanitizeState(parsed as Record<string, unknown>) };
}

/**
 * 读设置文件；不存在 / 损坏 / 版本不认识都返回空状态，不抛错。
 * 只看调用约定里的 `path`（或环境变量 / 默认路径），不打印文件内容。
 */
export async function loadConnectorSettings(path?: string): Promise<ConnectorSettingsState> {
  return (await readSettings(connectorSettingsPath(path))).state;
}

/**
 * 原子写：mkdir 0700 → 临时文件 0600 → rename，尽力 chmod 0600。
 * 失败返回 false，旧文件保持不变；不把错误抛给调用方。
 */
export async function saveConnectorSettings(
  state: ConnectorSettingsState,
  path?: string,
): Promise<boolean> {
  const target = connectorSettingsPath(path);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(copyState(state), null, 2)}\n`;
    await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(temp, 0o600);
    } catch {
      // Windows 上 chmod 基本无效；尽力而为，不影响写入结果。
    }
    await rename(temp, target);
    return true;
  } catch {
    try {
      await unlink(temp);
    } catch {
      // 临时文件可能根本没建出来；清理失败也不该抛。
    }
    return false;
  }
}

export type ConnectorSettingsOptions = {
  /** 设置文件的显式路径；省略时看 `AGENT_HOST_CONNECTOR_SETTINGS` / 默认目录。 */
  path?: string;
  /** 写入 debounce，默认 150ms；0 = 每次改动立即写。 */
  debounceMs?: number;
  /** 只接收失败类别，不接收文件内容。 */
  logger?: (message: string) => void;
};

const PROBLEM_TEXT: Record<SettingsProblem, string> = {
  read: "file could not be read",
  corrupt: "file is not valid JSON",
  version: "file has an unsupported version",
};

/**
 * 内存中的设置视图 + 延迟落盘。运行时持有一个单例；`flush()` 可等待最后
 * 一次写入完成。写入失败只在内存里保留改动并记录一次日志。
 */
export class ConnectorSettings {
  private readonly path: string;
  private readonly debounceMs: number;
  private readonly logger: (message: string) => void;
  private state: ConnectorSettingsState;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<boolean> = Promise.resolve(true);
  private saveFailureLogged = false;

  private constructor(
    state: ConnectorSettingsState,
    path: string,
    debounceMs: number,
    logger: (message: string) => void,
  ) {
    this.state = copyState(state);
    this.path = path;
    this.debounceMs = debounceMs;
    this.logger = logger;
  }

  static async load(options: ConnectorSettingsOptions = {}): Promise<ConnectorSettings> {
    const path = connectorSettingsPath(options.path);
    const logger = options.logger ?? (() => undefined);
    const result = await readSettings(path);
    if (result.problem) {
      // 只记类别，不带文件内容；损坏时继续使用空设置。
      logger(`connector settings: ${PROBLEM_TEXT[result.problem]}; using defaults`);
    }
    const debounceMs =
      typeof options.debounceMs === "number" && Number.isFinite(options.debounceMs)
        ? Math.max(0, Math.trunc(options.debounceMs))
        : 150;
    return new ConnectorSettings(result.state, path, debounceMs, logger);
  }

  /** 记录一个项目的自动批准开关；值没变返回 false。 */
  setAutoApprove(agentId: string, projectPath: string, enabled: boolean): boolean {
    const id = agentId.trim();
    const normalized = normalizeProjectPath(projectPath);
    if (!id || !normalized) return false;
    const index = this.state.autoApprove.findIndex(
      (entry) => entry.agentId === id && entry.projectPath === normalized,
    );
    if (index >= 0) {
      if (this.state.autoApprove[index].enabled === enabled) return false;
      this.state.autoApprove[index] = { agentId: id, projectPath: normalized, enabled };
    } else {
      // 默认就是关；没开过的项目不必写一条 false。
      if (!enabled) return false;
      this.state.autoApprove.push({ agentId: id, projectPath: normalized, enabled });
    }
    this.scheduleSave();
    return true;
  }

  /** 记录连接器开关；对一档 / dsh 不传 connectorId，ACP 传 agent id。 */
  setEnabled(kind: string, connectorId: string | undefined, enabled: boolean): boolean {
    const normalizedKind = kind.trim();
    if (!normalizedKind) return false;
    const id = connectorId?.trim() || undefined;
    const index = this.state.connectors.findIndex(
      (entry) => entry.kind === normalizedKind && (entry.connectorId ?? undefined) === id,
    );
    if (index >= 0) {
      if (this.state.connectors[index].enabled === enabled) return false;
      this.state.connectors[index] = {
        kind: normalizedKind,
        ...(id ? { connectorId: id } : {}),
        enabled,
      };
    } else {
      this.state.connectors.push({
        kind: normalizedKind,
        ...(id ? { connectorId: id } : {}),
        enabled,
      });
    }
    this.scheduleSave();
    return true;
  }

  /** 这个项目是否开了自动批准；没有记录 = false。 */
  autoApproveFor(agentId: string, projectPath: string): boolean {
    const id = agentId.trim();
    const normalized = normalizeProjectPath(projectPath);
    if (!id || !normalized) return false;
    return (
      this.state.autoApprove.find(
        (entry) => entry.agentId === id && entry.projectPath === normalized,
      )?.enabled === true
    );
  }

  /** 持久化的开关值；没有记录返回 undefined（调用方回落到 descriptor 默认值）。 */
  enabledOverride(kind: string, connectorId: string | undefined): boolean | undefined {
    const normalizedKind = kind.trim();
    if (!normalizedKind) return undefined;
    const id = connectorId?.trim() || undefined;
    return this.state.connectors.find(
      (entry) => entry.kind === normalizedKind && (entry.connectorId ?? undefined) === id,
    )?.enabled;
  }

  snapshot(): ConnectorSettingsState {
    return copyState(this.state);
  }

  /** 立即落盘并等待完成；会取消尚未触发的 debounce。 */
  async flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.persist();
  }

  private scheduleSave() {
    if (this.timer) clearTimeout(this.timer);
    if (this.debounceMs <= 0) {
      this.timer = undefined;
      void this.persist();
      return;
    }
    const timer = setTimeout(() => {
      this.timer = undefined;
      void this.persist();
    }, this.debounceMs);
    // 不拖住进程退出；需要保证落盘时调用 flush()。
    timer.unref?.();
    this.timer = timer;
  }

  private persist(): Promise<boolean> {
    const snapshot = this.snapshot();
    this.chain = this.chain.then(async () => {
      const ok = await saveConnectorSettings(snapshot, this.path);
      if (!ok) {
        if (!this.saveFailureLogged) {
          this.saveFailureLogged = true;
          this.logger("connector settings: could not be saved; keeping changes in memory");
        }
      } else {
        this.saveFailureLogged = false;
      }
      return ok;
    });
    return this.chain;
  }
}
