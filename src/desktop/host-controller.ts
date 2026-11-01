import { busStore } from "../bus/store.js";
import type { ManifestProblem } from "../connectors/discover.js";
import {
  applyConnectorEnabled,
  localAgents,
  localManifestProblems,
  refreshAgents,
  type LocalAgentSummary,
} from "../connectors/runtime.js";
import { startHost, type StartedHost } from "../host/start-host.js";

export type ConnectionState = "unpaired" | "connected" | "disconnected";

export type HostStatus = {
  connection: ConnectionState;
  hostName: string;
  pendingCount: number;
  agents: LocalAgentSummary[];
  manifestProblems: ManifestProblem[];
};

export type HostStatusListener = (status: HostStatus) => void;

/**
 * 桌面托盘的本机状态门面。
 *
 * 只做三件事：起一次 Host、把连接/待处理/Agent 汇总成菜单需要的形状、
 * 承接本机开关。所有数据都来自现有 runtime 与 BusStore，不经过手机命令。
 */
export class HostController {
  private running?: StartedHost;
  private readonly listeners = new Set<HostStatusListener>();
  private timer?: NodeJS.Timeout;
  private unsubscribeBus?: () => void;
  private authRejected = false;
  private lastSignature = "";

  async start(): Promise<void> {
    this.running = await startHost({
      pairIfMissing: false,
      skipRelayHealth: true,
      onAuthRejected: () => {
        this.authRejected = true;
        this.emit();
      },
    });
    const off = busStore.subscribe(() => this.emit());
    this.unsubscribeBus = () => {
      off();
    };
    // Relay 的 authenticated 变化没有事件出口，2 秒对齐一次；需求要求 10 秒内变灰
    this.timer = setInterval(() => this.emit(), 2000);
    this.emit();
  }

  status(): HostStatus {
    return {
      connection: this.connectionState(),
      hostName: this.running?.config.hostName ?? "Agent Host",
      pendingCount: busStore.pendingRequestCount(),
      agents: localAgents(),
      manifestProblems: localManifestProblems(),
    };
  }

  subscribe(listener: HostStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  async setAgentEnabled(agent: LocalAgentSummary, enabled: boolean): Promise<string | undefined> {
    const result = await applyConnectorEnabled(agent.connector, agent.connectorId, enabled);
    this.emit();
    return result.ok ? undefined : result.error;
  }

  /** 托盘「刷新列表」：重新发现本机 Agent（装完新 Agent 后不用重启托盘） */
  async refreshAgents(): Promise<void> {
    await refreshAgents().catch(() => undefined);
    this.emit();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
    const running = this.running;
    this.running = undefined;
    await running?.stop();
  }

  private connectionState(): ConnectionState {
    if (this.authRejected) return "unpaired";
    const config = this.running?.config;
    if (!config?.hostToken) return "unpaired";
    return this.running?.client?.status().connected ? "connected" : "disconnected";
  }

  private emit() {
    const status = this.status();
    // 2 秒轮询在状态不变时不要反复重建菜单/重载图标
    const signature = JSON.stringify(status);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // 单个监听器出错不影响托盘刷新
      }
    }
  }
}
