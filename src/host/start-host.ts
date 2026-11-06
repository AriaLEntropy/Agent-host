import { join } from "node:path";
import {
  startArtifactMaintenance,
  stopArtifactMaintenance,
} from "../bus/artifact-maintenance.js";
import { loadCommandLog, setCommandLogPath } from "../bus/commands.js";
import { loadBusState } from "../bus/persistence.js";
import { busStore, hostPlatform } from "../bus/store.js";
import {
  applyHostSettings,
  flushConnectorSettings,
  refreshAgents,
  startConnectorWatcher,
  stopConnectorWatcher,
} from "../connectors/runtime.js";
import {
  checkRelayHealth,
  ensureAgentId,
  hostDataDir,
  loadConfig,
  requireRelayConfig,
  type Config,
} from "../config.js";
import {
  createLogger,
  initializeLogging,
  logPublic,
  shutdownLogging,
} from "../platform/log.js";
import { pair } from "../tunnel/pairing.js";
import { RelayClient } from "../tunnel/relay-client.js";
import { PLUGIN_VERSION } from "../tunnel/version.js";

/**
 * 启动前的本机准备：日志、命令日志、快照持久化、身份与 Agent 发现。
 *
 * CLI 的 `up` 和各条检查命令都走这里，桌面托盘也复用同一份，
 * 避免“CLI 能列 Agent、托盘列不出来”的两套启动逻辑。
 */
export async function prepareHost(): Promise<Config> {
  // 日志初始化失败不能挡住启动：文件出口失败时退回 stderr
  await initializeLogging().catch(() => undefined);
  setCommandLogPath(join(hostDataDir(), "commands.json"));
  await loadCommandLog();
  const config = await ensureAgentId(await loadConfig());
  applyHostSettings({
    projectsRoot: config.projectsRoot,
    allowMobileNewProjects: config.allowMobileNewProjects,
  });
  const statePath = join(hostDataDir(), "bus-state.json");
  busStore.configurePersistence(statePath);
  const state = await loadBusState(statePath);
  if (state) busStore.hydrate(state, config.agentId ?? "");
  busStore.identify({
    agentId: config.agentId ?? "",
    hostName: config.hostName,
    hostVersion: PLUGIN_VERSION,
    platform: hostPlatform(),
  });
  const found = await refreshAgents().catch(() => undefined);
  createLogger("agent-host", "lifecycle").info("host prepared", {
    version: logPublic(PLUGIN_VERSION),
    platform: process.platform,
    agents: found?.agents.length ?? 0,
  });
  return config;
}

export type StartHostOptions = {
  /** CLI `up` 为 true：未配对时直接进入扫码；桌面托盘为 false，先显示「未配对」 */
  pairIfMissing?: boolean;
  /** 桌面托盘跳过启动前探活：Relay 暂时不可达也要起托盘，让连接自己重试 */
  skipRelayHealth?: boolean;
  /** 主机凭据被 Relay 拒绝时通知调用方（CLI 退出，桌面转「未配对」） */
  onAuthRejected?: (detail: string) => void;
};

export type StartedHost = {
  config: Config;
  /** 未配对时没有 Relay 连接 */
  client?: RelayClient;
  stop: () => Promise<void>;
};

/**
 * 启动 Relay 连接与 ACP 清单热监视。
 *
 * 只做一次「起进程」这件事；状态展示、开关和菜单都交给调用方。
 */
export async function startHost(options: StartHostOptions = {}): Promise<StartedHost> {
  const prepared = await prepareHost();
  // 桌面首次启动：未配对也别因为缺 PUBLIC_RELAY_URL 直接崩，托盘先显示「未配对」
  if (!prepared.hostToken && !options.pairIfMissing) {
    return { config: prepared, stop: makeStop(undefined) };
  }
  let config = requireRelayConfig(prepared, "up");
  if (!options.skipRelayHealth) await checkRelayHealth(config);

  let client: RelayClient | undefined;
  if (!config.hostToken) {
    config = await pair(config);
  }

  client = new RelayClient(config, {
    onAuthRejected: (detail) => options.onAuthRejected?.(detail),
  });
  await client.start();
  // 清单增删改后自动重新发现 agent；失败只记日志，不影响隧道
  await startConnectorWatcher();
  // 产物 7 天保留期要有真的执行者，否则磁盘只涨不消
  startArtifactMaintenance();
  return { config, client, stop: makeStop(client) };
}

function makeStop(client: RelayClient | undefined): () => Promise<void> {
  let stopping = false;
  return async () => {
    if (stopping) return;
    stopping = true;
    try {
      stopArtifactMaintenance();
      stopConnectorWatcher();
      await flushConnectorSettings();
      await busStore.flushPersistence();
      await shutdownLogging();
    } finally {
      client?.stop();
    }
  };
}
