/**
 * 由任务变化生成协议「七、通知」的 `notify`。
 *
 * 判定只放在 `TaskStore.upsertTask` 这一个入口：六个连接器（ACP、Claude、Codex、
 * OpenCode、Hermes、DSH）都往那里写任务，各自记着发通知迟早会漏一家。
 * 需要的前后信息都在任务本身与上一份值里，所以这里是纯函数，能直接测。
 */
import type { BusNotify, BusPendingRequest, BusTask } from "./store.js";

/**
 * 正文长度上限（码点）。
 *
 * 系统通知与 App 内横幅都放不下长文本，`lastMessage` 可能是一整段回复；
 * 协议没规定上限，这里自己钉一个，超出用省略号收口
 */
export const NOTIFY_BODY_LIMIT = 200;

/** 还在跑的状态：从这些状态进入终态才算「完成 / 失败」，翻历史时不会误报 */
const ACTIVE_STATUSES = new Set(["running", "waitingApproval", "waitingInput", "idle"]);

const CATEGORY_LABELS: Record<BusNotify["category"], string> = {
  TASK_APPROVAL: "需要审批",
  TASK_INPUT: "在等你回复",
  TASK_DONE: "已完成",
  TASK_FAILED: "失败",
};

/**
 * 这次 upsert 要不要发通知、发哪一类。
 *
 * 三条防刷屏规矩：①任务第一次进 store 只当基线，不通知（ACP 对账和 watch 扫到的
 * 历史会话会一次冒出几十条）；②`pendingRequest` 的 id 没变就不重发（同一次审批
 * 会被反复 upsert）；③终态必须是从「还在跑」过来的，status 没动也不发。
 */
export function notifyForTaskChange(
  previous: BusTask | undefined,
  next: BusTask,
  agentName: string,
): BusNotify | null {
  if (!previous) return null;

  const request = next.pendingRequest;
  if (request && request.id !== previous.pendingRequest?.id) {
    const category: BusNotify["category"] = request.kind === "input" ? "TASK_INPUT" : "TASK_APPROVAL";
    return build(next, category, agentName, notifyRequestBody(request), {
      // 协议：`requestId` 只在 TASK_APPROVAL 必填，其余类别省略整个键
      ...(category === "TASK_APPROVAL" ? { requestId: request.id } : {}),
    });
  }

  if (previous.status === next.status) return null;
  if (!ACTIVE_STATUSES.has(previous.status)) return null;
  if (next.status === "completed") {
    return build(next, "TASK_DONE", agentName, truncate(next.lastMessage) ?? "任务已完成");
  }
  if (next.status === "failed") {
    return build(next, "TASK_FAILED", agentName, truncate(next.lastMessage) ?? "任务失败");
  }
  return null;
}

function build(
  task: BusTask,
  category: BusNotify["category"],
  agentName: string,
  body: string,
  extra: Partial<BusNotify> = {},
): BusNotify {
  return {
    taskId: task.id,
    category,
    title: `${notifySubject(task)} ${CATEGORY_LABELS[category]}`,
    body,
    agentName,
    ...extra,
  };
}

/** 任务标题、项目名、来源，按可用性退；三样都没有也得让人认出是哪一台的哪件事 */
function notifySubject(task: BusTask): string {
  return task.title.trim() || task.projectName.trim() || `${task.source} 会话`;
}

function notifyRequestBody(request: BusPendingRequest): string {
  if (request.kind === "input") {
    const question = truncate(request.questions?.[0]?.question);
    if (question) return question;
  }
  return truncate(request.summary) ?? "电脑上有一个请求在等你处理";
}

/** 按码点截断，超出补省略号；空串返回 null 让调用方用默认正文 */
function truncate(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const characters = Array.from(text);
  if (characters.length <= NOTIFY_BODY_LIMIT) return text;
  return `${characters.slice(0, NOTIFY_BODY_LIMIT).join("")}…`;
}
