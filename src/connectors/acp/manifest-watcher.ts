/**
 * 监视清单目录（spec「发现」）：目录里文件增删、改名、原地重写都去抖后回调一次，
 * 调用方据此重新 `discoverAgents()`。目录不存在时先建出来——它是 BotBus 自己的目录。
 *
 * PORT: 上游 macOS 用 FSEvents、Linux 用 inotify、Windows 用目录变更通知；这里统一退回
 * 轮询——每 `pollIntervalMs` 比一次目录里各文件的 mtime / 大小 / inode。轮询按路径取快照，
 * 所以「原地重写」（编辑器保存、安装器 `cp new.json x.json`）和「目录被删掉再重建」
 * （`rm -rf agents` 再装回来）都能认出来，代价只是目录里几十个清单文件的一次 readdir。
 *
 * 注册表（`registry.ts`）是编译进进程的快照，没有磁盘位置可监视；运行时只有清单目录会变。
 * 清单只看 `.json`：`discover.ts` 也只读这些，临时文件（`x.json.tmp`）不触发重新发现。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/Acp/AcpManifestWatcher.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../../platform/log.js";
import { agentsDir } from "../discover.js";

/** 轮询间隔：上游 `AcpManifestWatcher.pollInterval`（2 秒）。 */
export const ACP_MANIFEST_POLL_INTERVAL_MS = 2000;
/** 去抖窗口：上游默认 0.5 秒。 */
export const ACP_MANIFEST_DEBOUNCE_MS = 500;

/** 一次去抖窗口里攒下来的变化；文件名相对监视目录，按字典序排好。 */
export type AcpManifestChange = {
  added: string[];
  changed: string[];
  removed: string[];
};

export type AcpManifestWatcherOptions = {
  /** 监视目录；默认 `discover.ts` 用的清单目录（数据目录下的 `agents/`）。 */
  directory?: string;
  /** 去抖窗口（毫秒）。 */
  debounceMs?: number;
  /** 轮询间隔（毫秒）。 */
  pollIntervalMs?: number;
  /** 哪些文件算清单；默认 `.json`。 */
  include?: (name: string) => boolean;
  /** 去抖后回调一次；回调里同步调用 `start()` / `stop()` 是安全的。 */
  onChange: (change: AcpManifestChange) => void;
};

type ManifestStamp = {
  mtimeNs: bigint;
  size: bigint;
  ino: bigint;
};

type ChangeKind = "added" | "changed" | "removed";

const logger = createLogger("agent-host", "acp");

export class AcpManifestWatcher {
  readonly directory: string;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly include: (name: string) => boolean;
  private readonly onChange: (change: AcpManifestChange) => void;

  /** 上一次轮询看到的目录内容。只在比较时读写，`stop()` 清空。 */
  private snapshot = new Map<string, ManifestStamp>();
  /** 还没到去抖窗口、等着回调的净变化。 */
  private pending = new Map<string, ChangeKind>();
  /** 串行化快照比较，避免 `scan()` 与定时轮询互相踩。 */
  private comparison: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private polling = false;
  /** `stop()` / 重新 `start()` 之后，丢弃还在路上的异步轮询结果。 */
  private generation = 0;

  constructor(options: AcpManifestWatcherOptions) {
    if (!options || typeof options.onChange !== "function") {
      throw new TypeError("AcpManifestWatcher needs an onChange callback");
    }
    const debounceMs = options.debounceMs ?? ACP_MANIFEST_DEBOUNCE_MS;
    const pollIntervalMs = options.pollIntervalMs ?? ACP_MANIFEST_POLL_INTERVAL_MS;
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
      throw new RangeError("debounceMs must be a non-negative number");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new RangeError("pollIntervalMs must be a positive number");
    }
    this.directory = options.directory ?? agentsDir();
    this.debounceMs = debounceMs;
    this.pollIntervalMs = pollIntervalMs;
    this.include = options.include ?? ((name) => name.endsWith(".json"));
    this.onChange = options.onChange;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 起轮询：先把目录建出来（上游 FSEvents 起流时也这么做），记一份基线快照，
   * 然后每 `pollIntervalMs` 比一次。重复调用是空操作。
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    await this.ensureDirectory();
    if (!this.running) return;
    // 启动时只取基线，不把目录里已有的清单当成「新增」播一遍。
    await this.compare();
    if (!this.running) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    // 纯监视器不该单独把进程钉住；测试里 `--test-force-exit` 也依赖这一点。
    this.timer.unref?.();
  }

  /** 停轮询、取消没发出去的回调、忘掉基线（再 `start()` 会重新取）。 */
  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pending.clear();
    this.snapshot.clear();
  }

  /**
   * 立刻比一次快照并更新基线，返回这次的变化。没在轮询时只返回、不回调
   * （给测试和启动基线用）；正在轮询时把变化并进同一个去抖窗口，避免
   * 手动 scan 把定时轮询本该上报的变化悄悄吃掉。
   */
  async scan(): Promise<AcpManifestChange> {
    const change = await this.compare();
    if (this.running && this.merge(change)) this.scheduleFlush();
    return change;
  }

  private compare(): Promise<AcpManifestChange> {
    const run = this.comparison.then(
      () => this.takeAndDiff(),
      () => this.takeAndDiff(),
    );
    this.comparison = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async takeAndDiff(): Promise<AcpManifestChange> {
    const current = await this.takeSnapshot();
    const previous = this.snapshot;
    this.snapshot = current;
    const change: AcpManifestChange = { added: [], changed: [], removed: [] };
    for (const [name, stamp] of current) {
      const before = previous.get(name);
      if (before === undefined) change.added.push(name);
      else if (!sameStamp(before, stamp)) change.changed.push(name);
    }
    for (const name of previous.keys()) {
      if (!current.has(name)) change.removed.push(name);
    }
    change.added.sort();
    change.changed.sort();
    change.removed.sort();
    return change;
  }

  /**
   * 目录里每个清单的 mtime / 大小 / inode。目录没了就先建回来（与上游 root changed
   * 的处理一致），当成空目录——于是里面的清单按「删掉」上报，重建后再按「新增」。
   */
  private async takeSnapshot(): Promise<Map<string, ManifestStamp>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      await this.ensureDirectory();
      return new Map();
    }
    const stats = await Promise.all(
      names
        .filter((name) => this.include(name))
        .map(async (name) => {
          try {
            const info = await stat(join(this.directory, name), { bigint: true });
            if (!info.isFile()) return undefined;
            return [name, { mtimeNs: info.mtimeNs, size: info.size, ino: info.ino }] as const;
          } catch {
            // 刚被删掉或改名：这一轮跳过，下一轮快照自然收敛。
            return undefined;
          }
        }),
    );
    const result = new Map<string, ManifestStamp>();
    for (const entry of stats) {
      if (entry) result.set(entry[0], entry[1]);
    }
    return result;
  }

  private async poll(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    const generation = this.generation;
    try {
      const change = await this.compare();
      if (!this.running || generation !== this.generation) return;
      if (this.merge(change)) this.scheduleFlush();
    } catch (error) {
      // 轮询失败不致命：下一轮再来。
      logger.debug("acp manifest poll failed", { error });
    } finally {
      this.polling = false;
    }
  }

  /**
   * 把这一轮的变化并进待发集合，算净效果：先加后删等于没发生，先删后加等于「改过」。
   * 返回是否攒出了新东西。
   */
  private merge(change: AcpManifestChange): boolean {
    if (!change.added.length && !change.changed.length && !change.removed.length) return false;
    for (const name of change.added) this.record(name, "added");
    for (const name of change.changed) this.record(name, "changed");
    for (const name of change.removed) this.record(name, "removed");
    return true;
  }

  private record(name: string, kind: ChangeKind): void {
    const previous = this.pending.get(name);
    if (previous === undefined) {
      this.pending.set(name, kind);
      return;
    }
    if (kind === "removed") {
      if (previous === "added") this.pending.delete(name);
      else this.pending.set(name, "removed");
      return;
    }
    // 已经待发的 added / changed 遇到再次新增或修改：保留最初那一档（新增仍是新增）。
    if (previous === "removed") this.pending.set(name, "changed");
  }

  /** 每来一轮新变化就重置窗口：安静 `debounceMs` 之后才回调一次。 */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (!this.running || this.pending.size === 0) return;
    const change: AcpManifestChange = { added: [], changed: [], removed: [] };
    for (const [name, kind] of this.pending) change[kind].push(name);
    this.pending.clear();
    change.added.sort();
    change.changed.sort();
    change.removed.sort();
    try {
      this.onChange(change);
    } catch (error) {
      // 回调抛错不该把轮询定时器带崩；记一行（Error 默认打码，不含路径）。
      logger.error("acp manifest change handler failed", { error });
    }
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
    } catch {
      // 建不出来（权限、盘不在）：按空目录继续，等它恢复。
    }
  }
}

function sameStamp(left: ManifestStamp, right: ManifestStamp): boolean {
  return left.mtimeNs === right.mtimeNs && left.size === right.size && left.ino === right.ino;
}
