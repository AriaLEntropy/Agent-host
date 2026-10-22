import {
  busStore,
  MAX_RECENT_RESULTS,
  MAX_TASKS,
  type BusProject,
  type BusTask,
  type ListedAgent,
} from "../src/bus/store.js";

const AGENT_ID = "hV3nQ7pLxK2mR8sTfW4bZQ";
const FRAME_LIMIT = 4 * 1024 * 1024;
const CHANGED_LIMIT = 512 * 1024;

const taskCount = Math.min(MAX_TASKS, numberFromEnv("TASKS", MAX_TASKS));
const projectCount = numberFromEnv("PROJECTS", 60);
const connectorCount = numberFromEnv("CONNECTORS", 16);
const resultCount = Math.min(
  MAX_RECENT_RESULTS,
  numberFromEnv("RECENT_RESULTS", MAX_RECENT_RESULTS),
);
const lastMessageChars = numberFromEnv("LAST_MESSAGE_CHARS", 500);
const titleChars = numberFromEnv("TITLE_CHARS", 80);
const lastErrorChars = numberFromEnv("LAST_ERROR_CHARS", 200);

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function textOf(chars: number, seed: string) {
  if (chars === 0) return "";
  return seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);
}

function killobytes(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function bytesOf(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

busStore.reset();
busStore.identify({
  agentId: AGENT_ID,
  hostName: "Agent Host",
  hostVersion: "1.0.0",
  platform: "windows",
});

const connectors: ListedAgent[] = Array.from(
  { length: connectorCount },
  (_, index) => ({
    id: `acp-${index}`,
    kind: "acp",
    name: `ACP Agent ${index}`,
    available: true,
    enabled: true,
    lastError: textOf(lastErrorChars, "权限被拒绝，请检查工作区设置。"),
  }),
);
busStore.setAgents(connectors);

const projects: BusProject[] = Array.from(
  { length: projectCount },
  (_, index) => ({
    agentId: AGENT_ID,
    path: `C:/Users/me/Projects/lesson-creator-${index}`,
    name: `lesson-creator-${index}`,
    lastUsedAt: new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString(),
    pinned: index % 10 === 0,
  }),
);

const lastMessageSeed =
  "播放器在窄屏下被目录挤出可视区域，准备把目录改成可折叠并补一条布局测试。";
const titleSeed = "修复课程播放器在窄屏下被目录挤出画面的问题";

const tasks: BusTask[] = Array.from({ length: taskCount }, (_, index) => {
  const project = projects[index % Math.max(1, projectCount)];
  const connector = connectors[index % Math.max(1, connectorCount)];
  const waiting = index % 5 === 0;
  const stamp = new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString();
  return {
    id: `acp:${connector?.id ?? "acp"}:session-${index}`,
    agentId: AGENT_ID,
    source: "acp",
    connectorId: connector?.id,
    title: textOf(titleChars, titleSeed),
    projectPath: project?.path ?? "C:/Users/me/Projects/demo",
    projectName: project?.name ?? "demo",
    status: waiting ? "waitingApproval" : "running",
    lastMessage: textOf(lastMessageChars, lastMessageSeed),
    ...(waiting
      ? {
          pendingRequest: {
            id: `req-${index}`,
            kind: "command" as const,
            summary: "删除 build 目录后重新安装依赖、测试并打包",
            detail: textOf(500, "npm ci\nnpm test\nnpm run build"),
          },
        }
      : {}),
    origin: "desktop",
    controllable: false,
    startedAt: stamp,
    updatedAt: stamp,
  };
});

busStore.replaceForMeasurement(tasks, projects);
for (let index = 0; index < resultCount; index += 1) {
  busStore.recordResult({
    commandId: `cmd-${index}`,
    ok: index % 2 === 0,
    ...(index % 2 === 0
      ? { taskId: tasks[index % Math.max(1, tasks.length)]?.id }
      : { error: textOf(200, "命令执行失败，请检查连接器状态。") }),
    finishedAt: new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString(),
  });
}

const snapshot = busStore.snapshot();
const total = bytesOf(snapshot);
const agent = (snapshot.agents as Array<Record<string, unknown>> | undefined)?.[0];
const tasksBytes = bytesOf(snapshot.tasks);
const projectsBytes = bytesOf(snapshot.projects);
const agentsBytes = bytesOf(snapshot.agents);
const connectorsBytes = bytesOf(agent?.connectors ?? []);
const resultsBytes = bytesOf(snapshot.recentResults);

console.log("Snapshot size");
console.log(
  `  tasks=${taskCount} projects=${projectCount} agents=1 connectors=${connectorCount} recentResults=${resultCount}`,
);
console.log(
  `  lastMessage=${lastMessageChars} chars title=${titleChars} chars lastError=${lastErrorChars} chars`,
);
console.log("");
console.log(`  total       ${total} bytes (${killobytes(total)}, ${megabytes(total)})`);
console.log(`  tasks       ${tasksBytes} bytes (${killobytes(tasksBytes)})`);
console.log(`  projects    ${projectsBytes} bytes (${killobytes(projectsBytes)})`);
console.log(`  agents      ${agentsBytes} bytes (${killobytes(agentsBytes)})`);
console.log(`  connectors  ${connectorsBytes} bytes (${killobytes(connectorsBytes)})`);
console.log(`  results     ${resultsBytes} bytes (${killobytes(resultsBytes)})`);
console.log("");
console.log(
  `  4 MiB frame limit: ${FRAME_LIMIT - total} bytes left (${megabytes(FRAME_LIMIT - total)})`,
);
const changedDelta = total - CHANGED_LIMIT;
console.log(
  `  512 KiB changed line: ${
    changedDelta > 0
      ? `${changedDelta} bytes over (${megabytes(changedDelta)})`
      : `${-changedDelta} bytes under (${megabytes(-changedDelta)})`
  }`,
);

if (total >= FRAME_LIMIT) {
  console.error("snapshot exceeds the 4 MiB websocket frame limit");
  process.exitCode = 1;
}
