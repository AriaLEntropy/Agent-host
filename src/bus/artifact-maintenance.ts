/**
 * 产物缓存的定期维护。
 *
 * `cleanup()` 早就写好了，但生产代码里一直没人调它，所以 7 天保留期只是读取时
 * 挡一下，磁盘上的字节永远不消。这里把它挂到主机生命周期上：开机跑一次，
 * 之后每 6 小时一次；崩溃留下的中间 `.tmp` 由同一轮一起收掉。
 */
import { createLogger } from "../platform/log.js";
import { cleanup } from "./artifacts.js";

const log = createLogger("agent-host", "artifacts");

/** 产物保留 7 天，清理不需要更勤；常量放在这里，测试与日志都按它算 */
export const ARTIFACT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | undefined;

/** 跑一轮清理，任何失败都只记日志：缓存维护不能把主机带崩 */
export async function sweepArtifacts(now: Date = new Date()): Promise<number> {
  try {
    return await cleanup(now);
  } catch (error) {
    log.warning("artifact sweep failed", { reason: String(error) });
    return 0;
  }
}

/** 幂等：重复调用只保留一个定时器；unref 免得为了扫缓存把进程留住 */
export function startArtifactMaintenance(): void {
  if (timer) return;
  void sweepArtifacts();
  timer = setInterval(() => void sweepArtifacts(), ARTIFACT_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopArtifactMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
