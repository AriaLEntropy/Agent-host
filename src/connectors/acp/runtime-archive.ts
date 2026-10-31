/**
 * ACP 会话存档接进 runtime：记住、忘记、启动时合并。
 *
 * 只有 BotBus 自己拉起/续聊的 ACP 任务（`origin === "watch"`）才记——与上游
 * `AcpConnector` 在 `commitTurn` / `finishTurn` 里调用 `archive.remember` 的范围
 * 一致。`session/list` 发现的桌面会话（`origin === "desktop"`）不记。
 *
 * 写盘按任务合并去抖：ACP 的流式更新会频繁 upsert，但存档只要最终元数据；
 * `flushAcpSessionArchive()` 给测试 / 退出前一个确定的落盘点。归档模块本身
 * 只留元数据（不存 `lastMessage`、审批、对话）。
 *
 * Ported intent from botbus-protocol/Sources/BotBusConnectors/Acp/AcpConnector.swift
 * (Apache-2.0).
 */
import { basename } from "node:path";
import { busStore, type BusTask } from "../../bus/store.js";
import { createLogger } from "../../platform/log.js";
import { AcpSessionArchive, type AcpSessionArchiveEntry } from "./session-archive.js";

/** 与上游 `SessionFormatting.idleAfter` 一致：超过 24 小时没有更新就降为 idle。 */
export const ACP_ARCHIVE_IDLE_AFTER_MS = 24 * 3600 * 1000;
/** 流式更新合并窗口；只是延迟写盘，不改变归档内容。 */
export const ACP_ARCHIVE_WRITE_DELAY_MS = 200;

const logger = createLogger("agent-host", "acp");

type PendingWrite = { connectorId: string; task: BusTask };

let currentArchive: AcpSessionArchive | null | undefined;
let pending = new Map<string, PendingWrite>();
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let writeChain: Promise<void> = Promise.resolve();
let hydrated = false;
let restoring = false;

/**
 * 换掉存档实例 / 位置（测试用）。`null` 表示完全停用；`undefined` 恢复默认。
 * 调用同时丢掉还没落盘的条目并允许下一次启动合并重新跑一遍。
 */
export function configureAcpSessionArchive(archive?: AcpSessionArchive | null) {
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  pending = new Map();
  writeChain = Promise.resolve();
  hydrated = false;
  restoring = false;
  currentArchive = archive;
}

/** 当前存档实例。测试进程里默认只在内存中，避免写真实用户目录。 */
export function acpSessionArchive(): AcpSessionArchive | null {
  if (currentArchive === undefined) {
    // node:test 的每个子进程都会带 NODE_TEST_CONTEXT；单元测试不该碰用户数据目录。
    currentArchive = new AcpSessionArchive(
      process.env.NODE_TEST_CONTEXT ? { path: null } : {},
    );
  }
  return currentArchive;
}

/** 把 store 的写入口接到会话存档。重复调用是幂等的。 */
export function installAcpSessionArchiveHooks() {
  busStore.setTaskHooks({
    taskUpserted: rememberAcpTask,
    taskRemoved: forgetAcpTask,
  });
}

/**
 * 任务 upsert 后记一条元数据。只在 `origin === "watch"` 的 ACP 任务上生效；
 * 「项目外」任务没有项目身份，不记。
 */
export function rememberAcpTask(task: BusTask) {
  if (restoring) return;
  if (task.source !== "acp" || task.origin !== "watch") return;
  if (task.outsideProject || !task.projectPath.trim()) return;
  const connectorId = task.connectorId?.trim();
  if (!connectorId) return;
  const key = `${connectorId}\u0000${task.id}`;
  pending.set(key, { connectorId, task: { ...task } });
  scheduleWrite();
}

/** 任务从 store 删除：取消还在排队的记录，并从归档里忘掉。 */
export function forgetAcpTask(taskId: string, task: BusTask | undefined) {
  const connectorId =
    task?.source === "acp" ? task.connectorId : parseConnectorId(taskId);
  if (!connectorId) return;
  const key = `${connectorId}\u0000${taskId}`;
  pending.delete(key);
  const target = acpSessionArchive();
  if (!target) return;
  writeChain = writeChain.then(
    () => target.forget(connectorId, [taskId]),
    () => target.forget(connectorId, [taskId]),
  ).then(
    () => undefined,
    () => {
      logger.warning("acp session archive forget failed", { count: 1 });
    },
  );
}

/** 归档只接受「在项目里」的记录（`outsideProject` 只会是 true）；项目外任务本就不记。 */
function archiveInput(task: BusTask) {
  const { outsideProject: _outside, ...rest } = task;
  return rest;
}

function scheduleWrite() {
  if (writeTimer !== undefined) return;
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    void flushAcpSessionArchive();
  }, ACP_ARCHIVE_WRITE_DELAY_MS);
  // 纯后台写盘不该把进程钉住。
  writeTimer.unref?.();
}

/** 把排队中的元数据写完；也等待之前排队的 forget。测试与退出前用。 */
export function flushAcpSessionArchive(): Promise<void> {
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  if (pending.size === 0) return writeChain;
  const entries = [...pending.values()];
  pending = new Map();
  const target = acpSessionArchive();
  if (!target) return writeChain;
  const write = async () => {
    let failed = 0;
    for (const entry of entries) {
      try {
        await target.remember(entry.connectorId, archiveInput(entry.task));
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) logger.warning("acp session archive remember failed", { count: failed });
  };
  // 上一段写失败已经记过类别；这批仍然要试。
  writeChain = writeChain.then(write, write);
  return writeChain;
}

/** `resetRuntime()` 用：下一次刷新重新从归档合并一次。存档实例与文件保留。 */
export function resetAcpArchiveHydration() {
  hydrated = false;
}

/**
 * 启动时把归档里、但 bus-state 里没有的任务补回 store。
 *
 * 只补缺失的 id：已持久化的任务（可能更新）一律不覆盖；补出来的任务只有
 * 元数据，不造消息、不挂审批。调用方传当前可用的 ACP connector id；归档里
 * 已卸载 agent 的会话不复活。
 */
export async function restoreArchivedAcpTasks(
  connectorIds: readonly string[],
): Promise<{ restored: number; skipped: number; failed: number }> {
  if (hydrated) return { restored: 0, skipped: 0, failed: 0 };
  hydrated = true;
  const target = acpSessionArchive();
  if (!target) return { restored: 0, skipped: 0, failed: 0 };
  await flushAcpSessionArchive();

  let restored = 0;
  let skipped = 0;
  let failed = 0;
  const seen = new Set<string>();
  restoring = true;
  try {
    for (const connectorId of new Set(connectorIds)) {
      if (!connectorId) continue;
      let records;
      try {
        records = await target.records(connectorId);
      } catch {
        failed += 1;
        continue;
      }
      for (const entry of records) {
        if (!entry.id || seen.has(entry.id)) continue;
        seen.add(entry.id);
        if (busStore.taskById(entry.id)) {
          skipped += 1;
          continue;
        }
        busStore.upsertTask(archivedTask(connectorId, entry), false);
        restored += 1;
      }
    }
  } finally {
    restoring = false;
  }
  if (restored > 0 || failed > 0) {
    logger.info("acp archive restore", { restored, skipped, failed });
  }
  return { restored, skipped, failed };
}

function archivedTask(connectorId: string, entry: AcpSessionArchiveEntry): BusTask {
  return {
    id: entry.id,
    agentId: busStore.agentId(),
    source: "acp",
    connectorId: entry.connectorId ?? connectorId,
    title: entry.title,
    projectPath: entry.projectPath,
    projectName: entry.projectName || basename(entry.projectPath),
    ...(entry.outsideProject ? { outsideProject: true } : {}),
    ...(entry.worktreePath ? { worktreePath: entry.worktreePath } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.effort ? { effort: entry.effort } : {}),
    status: agedStatus(entry.status, entry.updatedAt),
    origin: entry.origin ?? "watch",
    // 重启后没有活会话；标成可控会让手机发出注定失败的 followUp。
    controllable: false,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
  };
}

/** 上游 `AcpConnector.aged`：进行中的降为 interrupted，超过 24 小时降为 idle。 */
function agedStatus(status: string, updatedAt: string): string {
  const interrupted =
    status === "running" || status === "waitingApproval" || status === "waitingInput"
      ? "interrupted"
      : status;
  const updated = Date.parse(updatedAt);
  if (Number.isFinite(updated) && Date.now() - updated > ACP_ARCHIVE_IDLE_AFTER_MS) {
    return "idle";
  }
  return interrupted;
}

/** 兜底：删除时任务已经从 store 里拿不到，只能从 `acp:<connector>:<session>` 解析。 */
function parseConnectorId(taskId: string): string | undefined {
  const match = /^acp:([a-z0-9-]{1,32}):/.exec(taskId);
  return match?.[1];
}
