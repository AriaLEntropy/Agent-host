import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BusProject, BusTask, BusTaskMessages } from "./store.js";

/**
 * Agent Host 侧会话目录的持久化。
 *
 * 任务、项目、消息和 native session 映射都落在本机；ACP 只负责执行。
 * 这样 Host 重启后手机仍能浏览任务与历史，不依赖 DSH Web 常驻。
 */
export type PersistedSession = {
  taskId: string;
  nativeSessionId: string;
  catalog: "acp" | "dsh-acp";
  owner: "agent-host";
  revision: number;
};

export type PersistedBusState = {
  version: 1;
  tasks: BusTask[];
  projects: BusProject[];
  messages: BusTaskMessages[];
  sessions: PersistedSession[];
};

export async function loadBusState(path: string): Promise<PersistedBusState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PersistedBusState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return null;
    return {
      version: 1,
      tasks: parsed.tasks.filter((task) => task && typeof task.id === "string"),
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return null;
  }
}

export async function saveBusState(path: string, state: PersistedBusState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, path);
}
