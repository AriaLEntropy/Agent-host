/**
 * `ConnectorHost` 的 Agent-host 实现：把移植连接器接到现有的 `busStore`。
 *
 * 上游对应 `BotBusConnectorKit` 的 `TaskStore`。这里刻意不直接改
 * `bus/store.ts`：移植连接器只认 `contract.ts` 的接口，集成时再逐步补齐
 * store 缺的能力。
 */
import { busStore, type BusTask } from "../../bus/store.js";
import type { ConnectorHost } from "./contract.js";

/**
 * 实时所有权。对应上游 `TaskStore.claimLive` / `releaseLive`：
 * 被认领的任务由实时数据驱动，只读观察无权改写。
 *
 * 用进程内集合而不是写进 `BusTask`，是因为协议里没有这个字段，
 * 手机不该看见它。
 */
const live = new Set<string>();

/** 与现有 `runtime.ts` 保持一致：ISO 8601，带毫秒。 */
function nowIso(): string {
  return new Date().toISOString();
}

export function createBusHost(): ConnectorHost {
  return {
    get agentId() {
      return busStore.agentId();
    },

    now: nowIso,

    task(taskId) {
      return busStore.taskById(taskId);
    },

    tasks() {
      // busStore 没有单独暴露任务数组；snapshot() 是唯一的只读入口。
      return busStore.snapshot().tasks as BusTask[];
    },

    upsert(task) {
      busStore.upsertTask(task);
    },

    remove(taskId) {
      live.delete(taskId);
      busStore.removeTask(taskId);
    },

    rememberProject(project) {
      busStore.rememberProject(project);
    },

    rememberSession(taskId, nativeSessionId, catalog) {
      busStore.rememberSession(taskId, nativeSessionId, catalog);
    },

    emitMessages(messages) {
      busStore.emitTaskMessages(messages);
    },

    claimLive(taskId) {
      live.add(taskId);
    },

    releaseLive(taskId) {
      live.delete(taskId);
    },

    isLive(taskId) {
      return live.has(taskId);
    },
  };
}

export const busHost: ConnectorHost = createBusHost();
