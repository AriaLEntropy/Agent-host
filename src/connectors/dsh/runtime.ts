import type { BusTask } from "../../bus/store.js";
import { busStore } from "../../bus/store.js";
import { loadBrowserSessionSecret } from "./auth.js";
import { pageToMessages, summaryToTask } from "./mapping.js";
import { dshPaths } from "./paths.js";
import { readScannedSession, scanDshSessions } from "./scanner.js";
import { DshWebClient, DshWebError, type DshWebSessionSummary } from "./web.js";

let client: DshWebClient | null = null;
let port = Number(process.env.DSH_PORT ?? 3080);
let lastAttempt = 0;
let lastError = "";
let lastLoggedError = "";

export function configureDshWeb(nextPort = Number(process.env.DSH_PORT ?? 3080)) {
  port = nextPort;
  client = null;
  lastAttempt = 0;
}

export function dshWebState() {
  return { connected: client !== null, port, lastError };
}

async function ensureClient(): Promise<DshWebClient | null> {
  if (client) return client;
  const secret = await loadBrowserSessionSecret(dshPaths());
  if (!secret) {
    lastError = "读不到 DSH 浏览器会话密钥";
    return null;
  }
  client = new DshWebClient({ port, secret });
  return client;
}

/**
 * 把 dsh web 的会话列表并进现有任务存储。
 * 正在由 ACP 持有的任务不覆盖：ACP 的实时状态和消息更准。
 */
export async function refreshDshWebTasks(agentId: string, skipTaskIds: ReadonlySet<string>): Promise<void> {
  if (!agentId) return;
  if (Date.now() - lastAttempt < 5_000) return;
  lastAttempt = Date.now();
  const web = await ensureClient();
  let sessions: DshWebSessionSummary[] = [];
  try {
    sessions = web ? await web.listSessions() : [];
    lastError = "";
  } catch (error) {
    lastError = describe(error);
    if (lastError !== lastLoggedError) {
      lastLoggedError = lastError;
      console.warn(`[dsh] web 不可用，改扫盘：${lastError}`);
    }
  }
  if (sessions.length === 0) {
    sessions = (await scanDshSessions(dshPaths())).map((item) => item.summary);
  }
  for (const summary of sessions) {
    const task = summaryToTask(summary, agentId);
    if (!task || skipTaskIds.has(task.id)) continue;
    const existing = busStore.taskById(task.id);
    busStore.upsertTask(
      existing
        ? {
            ...existing,
            ...task,
            // 本地已经有的消息和待审批不要被列表覆盖。
            lastMessage: existing.lastMessage ?? task.lastMessage,
            pendingRequest: existing.pendingRequest,
          }
        : task,
    );
  }
}

export async function fetchDshWebMessages(taskId: string): Promise<boolean> {
  if (!taskId.startsWith("dsh:")) return false;
  const task = busStore.taskById(taskId);
  if (!task) return false;
  const sessionId = taskId.slice(4);
  let events = await (async () => {
    const web = await ensureClient();
    if (!web) return undefined;
    try {
      return (await web.latestPage(sessionId, 50)).events;
    } catch {
      return undefined;
    }
  })();
  if (!events) {
    events = (await readScannedSession(dshPaths(), sessionId))?.events;
  }
  if (!events) return false;
  const mapped = pageToMessages({ events, hasMore: false });
  busStore.emitTaskMessages({
    taskId,
    agentId: task.agentId,
    messages: mapped.messages,
    hasMore: mapped.hasMore,
    fetchedAt: new Date().toISOString(),
  });
  return true;
}

export async function followUpDshWeb(taskId: string, prompt: string, requestId: string): Promise<void> {
  const web = await ensureClient();
  if (!web || !taskId.startsWith("dsh:")) throw new DshWebError("disconnected", "DSH web 不可用");
  const task = busStore.taskById(taskId);
  if (!task) throw new DshWebError("disconnected", "task not found");
  await web.prompt(taskId.slice(4), prompt, requestId);
  busStore.bumpSessionRevision(taskId);
  busStore.upsertTask({
    ...task,
    status: "running",
    pendingRequest: undefined,
    updatedAt: new Date().toISOString(),
  });
}

export async function interruptDshWeb(taskId: string): Promise<void> {
  const web = await ensureClient();
  if (!web || !taskId.startsWith("dsh:")) throw new DshWebError("disconnected", "DSH web 不可用");
  const task = busStore.taskById(taskId);
  if (!task) throw new DshWebError("disconnected", "task not found");
  await web.cancel(taskId.slice(4));
  busStore.upsertTask({
    ...task,
    status: "interrupted",
    pendingRequest: undefined,
    updatedAt: new Date().toISOString(),
  });
}

export async function adoptDshSession(taskId: string, sessionId: string, cwd: string): Promise<void> {
  const web = await ensureClient();
  if (!web) return;
  try {
    await web.adoptSession(sessionId, cwd);
  } catch {
    // 旧版 web 没有 workspace/create 时忽略；ACP 会话仍然能用。
  }
}

function describe(error: unknown): string {
  if (error instanceof DshWebError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
