// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshTaskMapping.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// DeepSeek Harness（协议 3.1）的纯映射：web 列表 / 扫盘结果 / follow 流 / waterfall → TaskRecord。
// 不碰 IO，`DshConnector` 的对账与实时发布都走这里。

import type { BusPendingRequest, BusProject, BusTask } from "../../../bus/store.js";
import type { DshSessionSummary } from "./session-scanner.js";
import {
  eventSourceKind,
  eventText,
  eventTurnEndReason,
  isReplacement,
  isSubagentSummary,
  jsonPath,
  record,
  stringValue,
  turnEndKey,
  turnEndStatus,
  type DshQuestion,
  type DshSessionEvent,
  type DshTurnEndReason,
  type DshWaterfall,
  type DshWebSessionSummary,
} from "./web-messages.js";
import type { DshQuestionAnswer } from "./web-client.js";

export type TaskStatus = "running" | "waitingApproval" | "waitingInput" | "completed" | "failed" | "interrupted" | "idle";
export type TaskOrigin = "watch" | "desktop";

export type DshPendingQuestion = {
  id: string;
  question: string;
  header?: string;
  multiSelect?: true;
  options: { label: string; description?: string }[];
};

/** 协议 2.14 的 `questions` 与旧的纯文字 `question`（`BusPendingRequest` 只有前者）。 */
export type DshPendingRequest = Omit<BusPendingRequest, "questions"> & {
  question?: string;
  questions?: DshPendingQuestion[];
};

export type DshTaskRecord = Omit<BusTask, "pendingRequest"> & { pendingRequest?: DshPendingRequest };

/** 协议规定的时间格式：秒精度 UTC、不带小数（`YYYY-MM-DDTHH:MM:SSZ`）。 */
export function protocolTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const SessionFormatting = {
  recentWindow: 7 * 24 * 3600 * 1000,
  idleAfter: 24 * 3600 * 1000,
  titleLimit: 80,
  lastMessageLimit: 500,
  detailLimit: 2000,

  projectName(path: string): string {
    let trimmed = path;
    while (trimmed.length > 1 && /[\\/]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
    const parts = trimmed.split(/[\\/]/);
    return parts.at(-1) ?? trimmed;
  },

  truncate(text: string, limit: number): string {
    const trimmed = text.trim();
    return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
  },

  singleLine(text: string): string {
    return text.split(/\r?\n/).join(" ").trim();
  },

  /** 按每条会话的最近活动时间聚合出项目列表，最近的在前。 */
  projects(tasks: readonly BusTask[], agentId: string): BusProject[] {
    const latest = new Map<string, string>();
    for (const task of tasks) {
      if (!task.projectPath) continue;
      const existing = latest.get(task.projectPath);
      if (existing !== undefined && existing >= task.updatedAt) continue;
      latest.set(task.projectPath, task.updatedAt);
    }
    return [...latest.entries()]
      .sort((left, right) => (left[1] < right[1] ? 1 : left[1] > right[1] ? -1 : 0))
      .map(([path, lastUsedAt]) => ({
        agentId,
        path,
        name: SessionFormatting.projectName(path),
        lastUsedAt,
        pinned: false,
      }));
  },
};

/** 一个会话在列表里（web 的 `session/list` 或扫盘）的样子，拼任务记录用。 */
export type DshSessionFacts = {
  sessionId: string;
  cwd: string;
  title?: string;
  createdAt?: Date;
  updatedAt: Date;
  /** web 说它正在跑（`running` 或 `api-session/status true`）。 */
  webRunning: boolean;
  /** 扫盘看到"开了一轮还没收尾"，而且日志刚刚还在写。 */
  openTurnRecent: boolean;
};

/** web 列表的一项。空白会话、subagent、没有 cwd 或时间的不要。 */
export function factsFromWeb(summary: DshWebSessionSummary): DshSessionFacts | undefined {
  if (summary.blank || isSubagentSummary(summary)) return undefined;
  const cwd = summary.cwd;
  const updatedAt = summary.updatedAt;
  if (!cwd || cwd.length === 0 || !updatedAt) return undefined;
  return {
    sessionId: summary.sessionId,
    cwd,
    title: summary.title,
    createdAt: undefined,
    updatedAt,
    webRunning: summary.running,
    openTurnRecent: false,
  };
}

/** 扫盘的一项（扫描器已经滤掉了空白与 subagent）。`openTurnWindow` 内还在写日志的未收尾轮次算在跑。 */
export function factsFromScanned(
  summary: DshSessionSummary,
  now: Date,
  openTurnWindow: number = DshTaskMapping.openTurnWindow,
): DshSessionFacts {
  return {
    sessionId: summary.sessionId,
    cwd: summary.cwd,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    webRunning: false,
    openTurnRecent: summary.hasOpenTurn && now.getTime() - summary.updatedAt.getTime() <= openTurnWindow,
  };
}

/** 一次工具调用（`tool/call`）：审批卡片要拿它的参数显示要跑的命令。 */
export type DshToolCall = {
  name: string;
  /** 原样的参数 JSON 字符串。 */
  arguments?: string;
};

/** 参数里的 `command`（bash 一类工具）。 */
export function toolCallCommand(call: DshToolCall): string | undefined {
  if (!call.arguments) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(call.arguments);
  } catch {
    return undefined;
  }
  const command = stringValue(record(json).command);
  if (command === undefined) return undefined;
  return command.trim().length === 0 ? undefined : command;
}

/** follow 流（`session/follow` 的 snapshot 与之后的 event）累积出来的实时状态。 */
export class DshLiveState {
  static readonly maxTools = 64;

  running = false;
  lastMessage?: string;
  turnEnd?: DshTurnEndReason;
  title?: string;
  updatedAt?: Date;
  readonly tools = new Map<string, DshToolCall>();
  /** `approval/asked` 的 id → callId（`approval/decided` 只带 id）。 */
  readonly approvals = new Map<string, string>();
  private repliedThisTurn = false;
  private readonly toolOrder: string[] = [];

  clone(): DshLiveState {
    const copy = new DshLiveState();
    copy.running = this.running;
    copy.lastMessage = this.lastMessage;
    copy.turnEnd = this.turnEnd;
    copy.title = this.title;
    copy.updatedAt = this.updatedAt;
    for (const [key, value] of this.tools) copy.tools.set(key, value);
    for (const [key, value] of this.approvals) copy.approvals.set(key, value);
    copy.repliedThisTurn = this.repliedThisTurn;
    copy.toolOrder.push(...this.toolOrder);
    return copy;
  }

  /**
   * 喂一条事件。返回这条事件让哪次审批落了定（`approval/decided` 对应的 callId），
   * 好让连接器清掉挂着的请求。
   */
  apply(event: DshSessionEvent): string | undefined {
    if (isReplacement(event)) return undefined;
    switch (event.type) {
      case "turn/start":
        this.running = true;
        this.turnEnd = undefined;
        this.repliedThisTurn = false;
        this.touch(event.time);
        break;
      case "turn/end": {
        this.running = false;
        const reason = eventTurnEndReason(event);
        this.turnEnd = reason;
        if (!this.repliedThisTurn && reason?.kind === "error" && reason.message?.trim()) {
          this.lastMessage = SessionFormatting.truncate(reason.message, SessionFormatting.lastMessageLimit);
        }
        this.touch(event.time);
        break;
      }
      case "assistant/message": {
        const text = eventText(event)?.trim();
        if (text) {
          this.lastMessage = SessionFormatting.truncate(text, SessionFormatting.lastMessageLimit);
          this.repliedThisTurn = true;
        }
        this.touch(event.time);
        break;
      }
      case "user/message":
        if (eventSourceKind(event) === "user") this.touch(event.time);
        break;
      case "session/title": {
        const title = stringValue(record(event.data).title)?.trim();
        if (title) this.title = title;
        break;
      }
      case "tool/call": {
        const callId = stringValue(record(event.data).callId);
        if (!callId) return undefined;
        if (!this.tools.has(callId)) this.toolOrder.push(callId);
        this.tools.set(callId, {
          name: stringValue(record(event.data).name) ?? "tool",
          arguments: stringValue(record(event.data).arguments),
        });
        if (this.toolOrder.length > DshLiveState.maxTools) {
          const oldest = this.toolOrder.shift();
          if (oldest !== undefined) this.tools.delete(oldest);
        }
        break;
      }
      case "approval/asked": {
        const id = stringValue(record(event.data).id);
        const callId = stringValue(record(event.data).callId);
        if (id !== undefined && callId !== undefined) this.approvals.set(id, callId);
        break;
      }
      case "approval/decided": {
        const id = stringValue(record(event.data).id);
        if (id === undefined) return undefined;
        const callId = this.approvals.get(id);
        this.approvals.delete(id);
        return callId;
      }
      default:
        break;
    }
    return undefined;
  }

  private touch(time: Date | undefined): void {
    if (!time) return;
    if (this.updatedAt === undefined || time.getTime() > this.updatedAt.getTime()) this.updatedAt = time;
  }
}

export function liveStateEqual(left: DshLiveState, right: DshLiveState): boolean {
  if (left.running !== right.running) return false;
  if (left.lastMessage !== right.lastMessage) return false;
  if (turnEndKey(left.turnEnd) !== turnEndKey(right.turnEnd)) return false;
  if (left.title !== right.title) return false;
  if ((left.updatedAt?.getTime() ?? 0) !== (right.updatedAt?.getTime() ?? 0)) return false;
  if (left.tools.size !== right.tools.size) return false;
  for (const [key, value] of left.tools) {
    const other = right.tools.get(key);
    if (!other || other.name !== value.name || other.arguments !== value.arguments) return false;
  }
  if (left.approvals.size !== right.approvals.size) return false;
  for (const [key, value] of left.approvals) if (right.approvals.get(key) !== value) return false;
  return true;
}

export const DshTaskMapping = {
  identity: {
    taskId(sessionId: string): string {
      return `dsh:${sessionId}`;
    },
    /** 任务 id → 会话 id；不属于 dsh（前缀不对、会话 id 为空）返回 undefined。 */
    sessionId(taskId: string): string | undefined {
      const prefix = "dsh:";
      if (!taskId.startsWith(prefix)) return undefined;
      const sessionId = taskId.slice(prefix.length);
      return sessionId.length > 0 ? sessionId : undefined;
    },
  },

  /** 扫盘时"开着的一轮"只在日志这么久之内还在写时才算在跑。 */
  openTurnWindow: 5 * 60 * 1000,
  summaryLimit: 200,

  /**
   * `.dsh` 的全量对账列表：
   * - 底子是 web 列表（连着时）或扫盘结果，只要 7 天窗口里的；
   * - 同一个会话在 `acp` 里也有时，来源与标题以它为准，状态与最后一条消息取两边更新的那一份；
   * - `controllable` 统一按"现在有没有路可走"。
   */
  merged(input: {
    base: readonly DshSessionFacts[];
    acp: readonly BusTask[];
    live: ReadonlyMap<string, DshLiveState>;
    controllable: boolean;
    now: Date;
  }): DshTaskRecord[] {
    const { base, acp, live, controllable, now } = input;
    const acpById = new Map<string, BusTask>();
    for (const item of acp) if (item.source === "dsh") acpById.set(item.id, item);
    const result = new Map<string, DshTaskRecord>();
    for (const facts of base) {
      if (now.getTime() - facts.updatedAt.getTime() > SessionFormatting.recentWindow) continue;
      const taskId = DshTaskMapping.identity.taskId(facts.sessionId);
      result.set(
        taskId,
        DshTaskMapping.record({
          facts,
          live: live.get(facts.sessionId),
          pending: undefined,
          acp: acpById.get(taskId),
          controllable,
          now,
        }),
      );
    }
    for (const [id, task] of acpById) {
      if (result.has(id)) continue;
      const updated = DshTaskMapping.date(task.updatedAt);
      if (!updated || now.getTime() - updated.getTime() > SessionFormatting.recentWindow) continue;
      result.set(id, { ...task, controllable });
    }
    return [...result.values()].sort((left, right) => {
      const leftTime = DshTaskMapping.date(left.updatedAt)?.getTime() ?? 0;
      const rightTime = DshTaskMapping.date(right.updatedAt)?.getTime() ?? 0;
      return rightTime - leftTime;
    });
  },

  /**
   * 一个会话的任务记录。状态：挂着 waterfall → 待审批 / 待回答；web 在跑或 follow 看到开着的一轮 → 运行中；
   * 否则最后一次 `turn/end` 的原因；都不知道就按时间（24 小时内 completed，之外 idle）。
   */
  record(input: {
    facts: DshSessionFacts;
    live?: DshLiveState;
    pending?: DshWaterfall;
    acp?: BusTask;
    controllable: boolean;
    now: Date;
  }): DshTaskRecord {
    const { facts, live, pending, acp, controllable, now } = input;
    const distantPast = -8640000000000;
    const updatedMs = Math.max(facts.updatedAt.getTime(), live?.updatedAt?.getTime() ?? distantPast);
    const updated = new Date(updatedMs);
    const title = live?.title ?? facts.title;
    const projectName = SessionFormatting.projectName(facts.cwd);
    const trimmedTitle = SessionFormatting.truncate(
      SessionFormatting.singleLine(title ?? ""),
      SessionFormatting.titleLimit,
    );
    const recordTask: DshTaskRecord = {
      id: DshTaskMapping.identity.taskId(facts.sessionId),
      agentId: "",
      source: "dsh",
      title: trimmedTitle.length > 0 ? trimmedTitle : projectName.length > 0 ? projectName : facts.sessionId,
      projectPath: facts.cwd,
      projectName,
      status: "idle",
      origin: "desktop",
      controllable,
      startedAt: protocolTimestamp(new Date(Math.min(facts.createdAt?.getTime() ?? updatedMs, updatedMs))),
      updatedAt: protocolTimestamp(updated),
    };
    recordTask.lastMessage = live?.lastMessage;
    const mapped = pending ? DshTaskMapping.pendingRequest(pending, live) : undefined;
    const running = facts.webRunning || live?.running === true;
    if (mapped) {
      recordTask.status = mapped.status;
      recordTask.pendingRequest = mapped.request;
    } else if (running) {
      recordTask.status = "running";
    } else if (facts.openTurnRecent && facts.updatedAt.getTime() > (live?.updatedAt?.getTime() ?? distantPast)) {
      // 我们上次跟到的收尾之后日志又动了：别的 dsh 进程在接着跑。
      recordTask.status = "running";
    } else if (live?.turnEnd) {
      recordTask.status = DshTaskMapping.aged(turnEndStatus(live.turnEnd), updated, now);
    } else {
      recordTask.status = DshTaskMapping.aged("completed", updated, now);
    }
    if (!acp) return recordTask;
    if (recordTask.lastMessage === undefined) recordTask.lastMessage = acp.lastMessage;
    // BotBus 自己跑过的更新：它知道得更清楚。在跑、挂着请求的以实时数据为准。
    const acpUpdated = DshTaskMapping.date(acp.updatedAt);
    const recordUpdated = DshTaskMapping.date(recordTask.updatedAt);
    if (
      !mapped &&
      !running &&
      !facts.openTurnRecent &&
      (acpUpdated?.getTime() ?? 0) >= (recordUpdated?.getTime() ?? 0)
    ) {
      recordTask.status = acp.status as TaskStatus;
      recordTask.lastMessage = acp.lastMessage ?? recordTask.lastMessage;
      recordTask.pendingRequest = acp.pendingRequest as DshPendingRequest | undefined;
      recordTask.updatedAt = acp.updatedAt;
    }
    recordTask.origin = acp.origin as TaskOrigin;
    if (!DshTaskMapping.isPlaceholderTitle(acp)) recordTask.title = acp.title;
    const acpStarted = DshTaskMapping.date(acp.startedAt)?.getTime() ?? 0;
    const recordStarted = DshTaskMapping.date(recordTask.startedAt)?.getTime() ?? 0;
    if (acpStarted < recordStarted) recordTask.startedAt = acp.startedAt;
    return recordTask;
  },

  /** `newRecord` 没有标题时填的是项目名或会话 id：那不算"BotBus 给的标题"。 */
  isPlaceholderTitle(recordTask: BusTask): boolean {
    const native = DshTaskMapping.identity.sessionId(recordTask.id) ?? "";
    return (
      recordTask.title.length === 0 ||
      recordTask.title === recordTask.projectName ||
      recordTask.title === native
    );
  },

  /** 已结束的状态放了 24 小时以上算 idle。 */
  aged(status: TaskStatus, updated: Date, now: Date): TaskStatus {
    if (!["completed", "failed", "interrupted", "idle"].includes(status)) return status;
    return now.getTime() - updated.getTime() > SessionFormatting.idleAfter ? "idle" : status;
  },

  // MARK: - waterfall → PendingRequest

  /**
   * 审批与提问（协议 2.14 的 `questions`）。`PendingRequest.id` 用 waterfall 的 `eventId`——回答就靠它。
   */
  pendingRequest(
    waterfall: DshWaterfall,
    live?: DshLiveState,
  ): { status: "waitingApproval" | "waitingInput"; request: DshPendingRequest } | undefined {
    switch (waterfall.request.type) {
      case "approval": {
        const request = waterfall.request;
        const call = request.callId !== undefined ? live?.tools.get(request.callId) : undefined;
        const tool = request.toolName ?? call?.name;
        const reasonLine = request.reason !== undefined ? SessionFormatting.singleLine(request.reason) : undefined;
        const command = call ? toolCallCommand(call) : undefined;
        if (DshTaskMapping.isCommandTool(tool) && command !== undefined) {
          return {
            status: "waitingApproval",
            request: {
              id: waterfall.eventId,
              kind: "command",
              summary: SessionFormatting.truncate(
                `执行命令：${SessionFormatting.singleLine(command)}`,
                DshTaskMapping.summaryLimit,
              ),
              detail: request.reason !== undefined
                ? SessionFormatting.truncate(request.reason, SessionFormatting.detailLimit)
                : undefined,
            },
          };
        }
        const summary = reasonLine && reasonLine.length > 0 ? reasonLine : `${tool ?? "工具"} 请求授权`;
        const detailText = call?.arguments ?? request.reason;
        return {
          status: "waitingApproval",
          request: {
            id: waterfall.eventId,
            kind: "permission",
            summary: SessionFormatting.truncate(summary, DshTaskMapping.summaryLimit),
            detail: detailText !== undefined
              ? SessionFormatting.truncate(detailText, SessionFormatting.detailLimit)
              : undefined,
          },
        };
      }
      case "questions": {
        const mapped = DshTaskMapping.pendingQuestions(waterfall.request.questions);
        if (!mapped || mapped.length === 0) return undefined;
        const first = mapped[0];
        const line = SessionFormatting.singleLine(first.header ?? first.question);
        return {
          status: "waitingInput",
          request: {
            id: waterfall.eventId,
            kind: "input",
            summary: SessionFormatting.truncate(
              line.length === 0 ? "DeepSeek Harness 在等你回答" : line,
              DshTaskMapping.summaryLimit,
            ),
            question: DshTaskMapping.plainText(mapped),
            questions: mapped,
          },
        };
      }
      default:
        return undefined;
    }
  },

  isCommandTool(name: string | undefined): boolean {
    if (name === undefined) return false;
    const lower = name.toLowerCase();
    return lower.startsWith("bash") || lower.startsWith("pwsh") || lower === "shell" || lower === "terminal";
  },

  pendingQuestions(questions: readonly DshQuestion[]): DshPendingQuestion[] | undefined {
    const mapped = questions.slice(0, 8).flatMap((item) => {
      const detail = item.detail?.trim() ?? "";
      const text = [item.question.trim(), detail].filter((part) => part.length > 0).join("\n");
      if (!text) return [];
      const header = item.header !== undefined && item.header.trim().length > 0 ? item.header : undefined;
      return [{
        id: item.id,
        question: SessionFormatting.truncate(text, SessionFormatting.detailLimit),
        header,
        multiSelect: item.multiSelect ? (true as const) : undefined,
        options: item.options.slice(0, 16).map((label) => ({ label })),
      }];
    });
    return mapped.length === 0 ? undefined : mapped;
  },

  plainText(questions: readonly DshPendingQuestion[]): string {
    const blocks = questions.map((question) => {
      const lines = [question.question + (question.multiSelect ? "（可多选）" : "")];
      question.options.forEach((option, index) => lines.push(`${index + 1}. ${option.label}`));
      return lines.join("\n");
    });
    return SessionFormatting.truncate(blocks.join("\n\n"), SessionFormatting.detailLimit);
  },

  // MARK: - 手机的回答 → dsh 的回答

  /**
   * `approve(allow, answers:)`：每道题取手机给的值，是选项名的进 `selected`，不是的拼进 `custom`；
   * 单选题有 `custom` 时 `selected` 留空（dsh：`custom` 盖过选项），只取第一个选项。
   */
  answers(questions: readonly DshQuestion[], fromPhone: Readonly<Record<string, string[]>>): DshQuestionAnswer[] {
    return questions.map((question) => {
      const picked = (fromPhone[question.id] ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
      const selected = picked.filter((value) => question.options.includes(value));
      const typed = picked.filter((value) => !question.options.includes(value));
      const custom = typed.length > 0 ? typed.join(", ") : undefined;
      if (question.multiSelect) return { id: question.id, selected, custom };
      if (custom !== undefined) return { id: question.id, selected: [], custom };
      return { id: question.id, selected: selected.slice(0, 1) };
    });
  },

  /** 挂着提问时手机直接发了一句话（`followUp`）：所有题都用这句话作答。 */
  answersText(questions: readonly DshQuestion[], text: string): DshQuestionAnswer[] {
    return questions.map((question) => ({ id: question.id, selected: [], custom: text }));
  },

  /** 「跳过」：每道题都不选，dsh 把它当作用户跳过了这些问题，这一轮接着跑。 */
  skipped(questions: readonly DshQuestion[]): DshQuestionAnswer[] {
    return questions.map((question) => ({ id: question.id, selected: [] }));
  },

  date(timestamp: string): Date | undefined {
    const value = Date.parse(timestamp);
    return Number.isFinite(value) ? new Date(value) : undefined;
  },
};

/** `DshSessionEvent` 的批处理工具（follow snapshot 用）。 */
export function applyEvents(state: DshLiveState, events: readonly DshSessionEvent[]): string[] {
  const decided: string[] = [];
  for (const event of events) {
    const call = state.apply(event);
    if (call !== undefined) decided.push(call);
  }
  return decided;
}

export { jsonPath };
