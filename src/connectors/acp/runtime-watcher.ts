/**
 * 清单热监视接进 runtime：去抖后的变化触发一轮 `refreshAgents()`。
 *
 * 监视器本身（`manifest-watcher.ts`）负责轮询、去抖与串行比较；这里再加两层：
 * - 刷新互斥：上一轮 `refreshAgents()` 没结束时，后续变化只记一个「还要再跑一次」，
 *   绝不让两轮发现重叠；
 * - 可注入：测试可以换掉 watcher 工厂与 refresh 回调，不扫真实目录、不等 2 秒。
 *
 * 日志只有数量（agents / problems / added / changed / removed），不带路径或标题。
 */
import { createLogger } from "../../platform/log.js";
import {
  AcpManifestWatcher,
  type AcpManifestChange,
  type AcpManifestWatcherOptions,
} from "./manifest-watcher.js";

const logger = createLogger("agent-host", "acp");

/** 监视器需要的最小接口；测试的假 watcher 只要实现这两个方法。 */
export type ConnectorManifestWatcher = {
  start(): Promise<void>;
  stop(): void;
};

export type ConnectorWatcherRefreshResult = {
  agents?: readonly unknown[];
  problems?: readonly unknown[];
};

export type ConnectorWatcherRefresh = () => Promise<ConnectorWatcherRefreshResult | void>;

export type ConnectorWatcherOptions = {
  /** 默认由 runtime 传入 `refreshAgents`。 */
  refresh?: ConnectorWatcherRefresh;
  /** 测试注入：换掉真实的 `AcpManifestWatcher`。 */
  createWatcher?: (options: AcpManifestWatcherOptions) => ConnectorManifestWatcher;
  /** 监视目录；默认清单目录（数据目录下的 `agents/`）。 */
  directory?: string;
  debounceMs?: number;
  pollIntervalMs?: number;
};

export class ConnectorWatcherController {
  private watcher: ConnectorManifestWatcher | undefined;
  private starting: Promise<void> | undefined;
  private running = false;
  private generation = 0;
  /** 刷新互斥：同一时刻最多一轮 refreshAgents。 */
  private refreshing = false;
  private refreshQueued = false;
  private readonly options: ConnectorWatcherOptions;

  constructor(options: ConnectorWatcherOptions) {
    if (typeof options.refresh !== "function") {
      throw new TypeError("ConnectorWatcherController needs a refresh callback");
    }
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 幂等：已经在跑时返回同一次启动的 Promise。 */
  start(): Promise<void> {
    if (this.running) return this.starting ?? Promise.resolve();
    this.running = true;
    this.generation += 1;
    const generation = this.generation;
    const create =
      this.options.createWatcher ?? ((options) => new AcpManifestWatcher(options));
    const watcher = create({
      ...(this.options.directory !== undefined ? { directory: this.options.directory } : {}),
      ...(this.options.debounceMs !== undefined ? { debounceMs: this.options.debounceMs } : {}),
      ...(this.options.pollIntervalMs !== undefined
        ? { pollIntervalMs: this.options.pollIntervalMs }
        : {}),
      onChange: (change) => this.handleChange(generation, change),
    });
    this.watcher = watcher;
    this.starting = watcher.start().catch(() => {
      // 监视失败不致命：把状态退回未运行，下一次 start 可以重试。
      if (generation === this.generation) {
        this.running = false;
        this.watcher = undefined;
      }
      logger.warning("manifest watcher start failed");
    });
    return this.starting;
  }

  /** 幂等：没在跑时什么都不做；丢掉没发出去的变化与排队中的刷新。 */
  stop(): void {
    if (!this.running && !this.watcher) return;
    this.running = false;
    this.generation += 1;
    this.refreshQueued = false;
    this.watcher?.stop();
    this.watcher = undefined;
    this.starting = undefined;
  }

  private handleChange(generation: number, change: AcpManifestChange) {
    if (!this.running || generation !== this.generation) return;
    logger.info("manifest changed", {
      added: change.added.length,
      changed: change.changed.length,
      removed: change.removed.length,
    });
    void this.refresh();
  }

  /**
   * 串行刷新。已经有刷新在跑时只置一次 pending；那一轮结束后恰好再跑一轮，
   * 中间的变化全部合并，避免多个 `refreshAgents()` 互相覆盖。
   */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshQueued = false;
        const generation = this.generation;
        try {
          const found = await this.options.refresh!();
          if (generation !== this.generation) return;
          logger.info("manifest refresh", {
            agents: found?.agents?.length ?? 0,
            problems: found?.problems?.length ?? 0,
          });
        } catch {
          // 只有类别，不带 agent 输出或路径。
          logger.warning("manifest refresh failed");
        }
      } while (this.refreshQueued && this.running);
    } finally {
      this.refreshing = false;
      // 变化若恰好落在「循环条件」与「清 refreshing」之间，这里补跑一次。
      if (this.refreshQueued && this.running) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }
}
