import { busStore } from "../bus/store.js";
import type { ManifestProblem } from "../connectors/discover.js";
import {
  applyConnectorEnabled,
  localAgents,
  localManifestProblems,
  refreshAgents,
  startConnectorWatcher,
  type LocalAgentSummary,
} from "../connectors/runtime.js";
import { checkRelayHealth, loadConfig, saveConfig, type Config } from "../config.js";
import { startHost, type StartedHost } from "../host/start-host.js";
import { createPairingTicket, PairingExpiredError, type PairingTicket } from "../tunnel/pairing.js";
import { RelayClient } from "../tunnel/relay-client.js";

export type ConnectionState = "unpaired" | "connected" | "disconnected";

export type HostStatus = {
  connection: ConnectionState;
  /** Relay 地址是否已配置；未配置时不能显示成「未配对」 */
  relayConfigured: boolean;
  /** 是否已持有 hostToken */
  paired: boolean;
  hostName: string;
  pendingCount: number;
  agents: LocalAgentSummary[];
  manifestProblems: ManifestProblem[];
};

export type RelayInfo = {
  relay: string;
  publicRelayUrl: string;
  paired: boolean;
};

export type PairingStart = {
  link: string;
  expiresAt: number;
  result: Promise<{ ok: boolean; error?: string }>;
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
  private pairingTicket?: PairingTicket;

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
      relayConfigured: Boolean(this.running?.config.relay.trim()),
      paired: Boolean(this.running?.config.hostToken),
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

  relayInfo(): RelayInfo {
    const config = this.running?.config;
    return {
      relay: config?.relay ?? "",
      publicRelayUrl: config?.publicRelayUrl ?? "",
      paired: Boolean(config?.hostToken),
    };
  }

  /** 测试地址是否可达；不保存 */
  async testRelay(relay: string): Promise<{ ok: boolean; error?: string }> {
    const config = this.running?.config ?? (await loadConfig());
    try {
      await checkRelayHealth({ ...config, relay: normalizeRelay(relay) });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 保存 Relay 地址；已配对时立即重连 */
  async updateRelay(relay: string, publicRelayUrl: string): Promise<{ ok: boolean; error?: string }> {
    const current = this.running?.config ?? (await loadConfig());
    const next: Config = {
      ...current,
      relay: normalizeRelay(relay),
      publicRelayUrl: publicRelayUrl.trim() || undefined,
    };
    try {
      await saveConfig(next);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (this.running) this.running.config = next;
    if (next.hostToken) await this.reconnect(next);
    this.emit();
    return { ok: true };
  }

  /** 开一次配对会话；窗口关闭时调用 cancelPairing */
  async beginPairing(): Promise<PairingStart> {
    const config = this.running?.config;
    if (!config) throw new Error("Host 还没有启动");
    this.pairingTicket?.cancel();
    const ticket = await createPairingTicket(config);
    this.pairingTicket = ticket;
    const result = ticket
      .waitForConfirmation()
      .then(async (next) => {
        if (this.pairingTicket !== ticket) return { ok: false, error: "cancelled" };
        this.pairingTicket = undefined;
        await this.applyPairedConfig(next);
        return { ok: true };
      })
      .catch((error: unknown) => {
        if (this.pairingTicket === ticket) this.pairingTicket = undefined;
        return {
          ok: false,
          error:
            error instanceof PairingExpiredError
              ? "expired"
              : error instanceof Error
                ? error.message
                : String(error),
        };
      });
    return { link: ticket.link, expiresAt: ticket.expiresAt, result };
  }

  cancelPairing(): void {
    this.pairingTicket?.cancel();
    this.pairingTicket = undefined;
  }

  async stop(): Promise<void> {
    this.cancelPairing();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
    const running = this.running;
    this.running = undefined;
    await running?.stop();
  }

  private async reconnect(next: Config): Promise<void> {
    const client = new RelayClient(next, {
      onAuthRejected: () => {
        this.authRejected = true;
        this.emit();
      },
    });
    const previous = this.running?.client;
    if (this.running) {
      this.running.config = next;
      this.running.client = client;
    }
    previous?.stop();
    try {
      await client.start();
      await startConnectorWatcher();
      this.authRejected = false;
    } catch {
      // Relay 暂时不可达：保留 client，托盘显示连接中断
    }
    this.emit();
  }

  private async applyPairedConfig(next: Config): Promise<void> {
    await this.reconnect(next);
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

function normalizeRelay(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
