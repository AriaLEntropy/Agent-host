/**
 * 一档专属连接器的共享契约。
 *
 * 移植自 botbus-protocol/Sources/BotBusConnectorKit 的
 * `TaskConnector.swift`、`MessageReader.swift`、`TranscriptEntry.swift`，
 * 只保留 Agent-host 侧真正需要的部分；上游 Apache-2.0。
 *
 * 目的：Codex / Claude / Hermes / Pi / OpenClaw 五个移植模块共用同一组
 * 类型，彼此不 import。真正的 store 适配与命令分发在 `runtime` 侧完成，
 * 移植模块只依赖这里。
 */
import type { BusMessage, BusProject, BusTask, BusTaskMessages } from "../../bus/store.js";
import { candidatesIn } from "./transcript-file-refs.js";

/** 协议 `TaskSource` / `ConnectorKind` 的闭集；ACP 用 connectorId 区分具体 agent。 */
export type ConnectorKind =
  | "codex"
  | "claude"
  | "hermes"
  | "pi"
  | "openclaw"
  | "acp"
  | "dsh";

/** 协议 3.7 的失败诊断。kind 是开集，手机只认识其中几个。 */
export type FailureDiagnosis = {
  kind: string;
  folder?: string;
  resetsAt?: string;
};

/**
 * 连接器报错的通用载体。
 *
 * `containsPrivateDetail`：消息里带了不该进公开日志的内容（agent 的 stderr
 * 尾巴、第三方 agent 自己回的错误文本）。照样原样回给手机，只是记录时
 * 按私有处理。
 */
export class ConnectorError extends Error {
  readonly diagnosis?: FailureDiagnosis;
  readonly containsPrivateDetail: boolean;

  constructor(
    message: string,
    options: { diagnosis?: FailureDiagnosis; containsPrivateDetail?: boolean } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
    this.diagnosis = options.diagnosis;
    this.containsPrivateDetail = options.containsPrivateDetail ?? false;
  }
}

/**
 * 一条命令执行完之后，连接器对分发器的交代。
 *
 * 比“返回 taskId”多出的那半句是 `retainsLiveOwnership`：命令返回不等于任务
 * 结束——`approve` 之后轮次还要接着跑。这段时间任务仍由实时数据驱动，
 * 连接器自己在任务真正结束时调 `host.releaseLive`。
 */
export type ConnectorOutcome = {
  /** 可以是协议里的完整 id（`codex:<threadId>`），也可以是原生 id。 */
  taskId: string;
  retainsLiveOwnership?: boolean;
  /** 这一轮进程是不是 Agent-host 起的；和 `TaskConnector.runsUnderBotBus` 同时为 true 才算。 */
  runsUnderBotBus?: boolean;
};

/** 协议 3.2：新建任务或续聊时要用的模型与思考强度。两样都缺省 = 不换。 */
export type ModelSelection = {
  model?: string;
  effort?: string;
};

/** 对话里一张图的来源。读取器只负责找到它，读字节、压缩、上传在外面做。 */
export type ImageSource =
  | { type: "file"; path: string }
  | { type: "data"; data: Uint8Array; contentType: string };

/** 读取器的中间结果：协议里的 Message，加上待处理的图片与路径候选。 */
export type TranscriptEntry = {
  message: BusMessage;
  images: ImageSource[];
  /** Agent 回复里原样出现的路径文本（未校验）。只有 agent 消息才有。 */
  pathCandidates: string[];
};

/**
 * 一个能真正执行命令的后端（Codex app-server、Claude hooks + CLI 等）。
 *
 * 方法应在“命令已被后端接受”时返回，而不是等任务跑完；进展靠
 * `host.upsert` 产生的 task 事件表达。
 */
export interface TaskConnector {
  readonly kind: ConnectorKind;

  /** agent 进程是不是 Agent-host 自己起的。共用进程时为 false。 */
  readonly runsUnderBotBus: boolean;

  start(
    projectPath: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome>;

  followUp(
    taskId: string,
    prompt: string,
    images: ImageSource[],
    selection?: ModelSelection,
  ): Promise<ConnectorOutcome>;

  approve(
    taskId: string,
    requestId: string,
    decision: "allow" | "deny",
    answers?: Record<string, string[]>,
  ): Promise<ConnectorOutcome>;

  interrupt(taskId: string): Promise<ConnectorOutcome>;

  /** 协议 3.4：会话被“合并并结束”后给后端收尾的机会。尽力而为。 */
  deleteTask?(taskId: string): Promise<void>;

  discard?(taskId: string): Promise<void>;
}

/**
 * 读一个任务的对话记录。
 *
 * 故意不挂在 `TaskConnector` 上：看聊天记录必须在连接器没跑的时候也能用。
 * 返回按时间升序（最旧在前）；`hasMore` 表示更早的对话被截掉了。
 */
export interface MessageReader {
  readonly kind: ConnectorKind;
  entries(
    taskId: string,
    limit: number,
  ): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }>;
}

/**
 * 连接器需要的宿主能力。由 Agent-host 的 store 适配实现；移植模块只认这个接口，
 * 这样五个连接器可以独立编译、独立测试。
 */
export interface ConnectorHost {
  readonly agentId: string;
  /** ISO 8601 UTC，秒精度（`YYYY-MM-DDTHH:MM:SSZ`）。 */
  now(): string;

  task(taskId: string): BusTask | undefined;
  tasks(): readonly BusTask[];
  upsert(task: BusTask): void;
  remove(taskId: string): void;

  rememberProject(project: BusProject): void;
  rememberSession(
    taskId: string,
    nativeSessionId: string,
    catalog: "acp" | "dsh-acp",
  ): void;
  emitMessages(messages: BusTaskMessages): void;

  /**
   * 实时所有权：只读观察无权改写被认领的任务；连接器在任务真正结束时交还。
   * 对应上游 `TaskStore.claimLive` / `releaseLive`。
   */
  claimLive(taskId: string): void;
  releaseLive(taskId: string): void;
  isLive(taskId: string): boolean;
}

/** 协议上限：一次拉取最多 40 条对话消息。 */
export const MAX_USER_MESSAGES = 40;
/** 工具行不占对话名额，另有 160 条上限，超了丢最旧的。 */
export const MAX_TOOL_MESSAGES = 160;
/** 工具行正文上限。 */
export const MAX_TOOL_TEXT_LENGTH = 200;

/** 把原生 id 从协议 id（`codex:<threadId>`）里剥出来。 */
export function nativeTaskId(taskId: string, kind: ConnectorKind): string {
  const prefix = `${kind}:`;
  if (!taskId.startsWith(prefix)) {
    throw new ConnectorError(`任务 id 不属于 ${kind}：${taskId}`);
  }
  const native = taskId.slice(prefix.length);
  if (!native) throw new ConnectorError(`任务 id 不合法：${taskId}`);
  return native;
}

/** 把后端的原生 id 拼成协议里的 Task.id。 */
export function taskIdFor(native: string, kind: ConnectorKind): string {
  return `${kind}:${native}`;
}

/** 截断并补省略号；上游 `truncateMessage`。 */
export function truncateMessage(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/**
 * 五家读取器共用的收尾：工具行截断到 200 字，用户与 Agent 消息保留全文（只 trim），
 * 再判空。判空必须在 trim 之后；有图就要留（纯图片消息也是一条对话）。
 *
 * 对应上游 `transcriptEntry(...)`。传了 `rawText` 且这条是 Agent 回复时，顺手从
 * **未截断原文**里认出 `pathCandidates`；用户消息与工具行永远不填。不传 `rawText`
 * 的调用方行为不变（路径候选留空）。"整份解析再截尾"的读取器应省略 `rawText`，
 * 截出窗口后再用 `withPathCandidates` 只给窗口里的回复补。
 */
export function transcriptEntry(input: {
  id: string;
  role: BusMessage["role"];
  text: string | null | undefined;
  images?: ImageSource[];
  createdAt: string;
  /** 这条消息截断前的原文；只有 Agent 回复会用来认路径候选。 */
  rawText?: string | null;
}): TranscriptEntry | null {
  const raw = input.text ?? "";
  const text =
    input.role === "tool" ? truncateMessage(raw, MAX_TOOL_TEXT_LENGTH) : raw.trim();
  const images = input.images ?? [];
  if (!text && images.length === 0) return null;
  const pathCandidates =
    input.role === "agent" && input.rawText !== undefined && input.rawText !== null
      ? candidatesIn(input.rawText)
      : [];
  return {
    message: { id: input.id, role: input.role, text, createdAt: input.createdAt },
    images,
    pathCandidates,
  };
}

/**
 * 给一条已有的 Agent 回复补路径候选。对应上游 `addingPathCandidates(to:rawText:)`：
 * `rawText` 取这条回复截断前的原文；非 Agent 回复原样返回。
 *
 * 不做 I/O，只跑纯文字识别；返回新对象，不改入参。
 */
export function withPathCandidates(
  entry: TranscriptEntry,
  rawText: string | null | undefined,
): TranscriptEntry {
  if (entry.message.role !== "agent" || rawText === null || rawText === undefined) return entry;
  return { ...entry, pathCandidates: candidatesIn(rawText) };
}

/**
 * 取窗口：最近 `limit` 条对话（role != tool），外加夹在它们之间、以及最旧那条
 * 之前紧挨着的工具行。工具行不占对话名额。
 *
 * 对应上游 `TranscriptWindow.latest`。
 */
export function latestWindow(
  ascending: TranscriptEntry[],
  limit: number,
): { entries: TranscriptEntry[]; hasMore: boolean } {
  const capped = Math.min(Math.max(limit, 1), MAX_USER_MESSAGES);
  let start = 0;
  let conversation = 0;
  let hasMore = false;
  for (let index = ascending.length - 1; index >= 0; index -= 1) {
    if (ascending[index].message.role === "tool") continue;
    if (conversation === capped) {
      start = index + 1;
      hasMore = true;
      break;
    }
    conversation += 1;
  }
  const window = ascending.slice(start);
  let excess =
    window.filter((entry) => entry.message.role === "tool").length - MAX_TOOL_MESSAGES;
  if (excess <= 0) return { entries: window, hasMore };
  const trimmed = window.filter((entry) => {
    if (entry.message.role === "tool" && excess > 0) {
      excess -= 1;
      return false;
    }
    return true;
  });
  return { entries: trimmed, hasMore };
}

/** 解析 `data:<mime>;base64,<…>`；只认 base64 编码的 image/*。 */
export function imageFromDataUrl(value: string): ImageSource | null {
  const trimmed = value.trim();
  if (trimmed.length <= 5 || trimmed.slice(0, 5).toLowerCase() !== "data:") return null;
  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;
  const parts = trimmed
    .slice(5, comma)
    .split(";")
    .map((part) => part.trim().toLowerCase());
  const mime = parts[0];
  if (!mime || !parts.slice(1).includes("base64")) return null;
  return imageFromBase64(trimmed.slice(comma + 1), mime);
}

/** 裸 base64 加类型；类型不是 image/*、解不出来或为空都返回 null。 */
export function imageFromBase64(value: string, contentType: string): ImageSource | null {
  const type = contentType.trim().toLowerCase();
  if (!type.startsWith("image/") || type.length <= "image/".length) return null;
  const compact = value.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const data = Buffer.from(compact, "base64");
  if (data.length === 0) return null;
  return { type: "data", data, contentType: type };
}

/** 移植模块的统一默认实现：带了模型选择就报错，不悄悄用原模型跑。 */
export function rejectSelection(selection: ModelSelection | undefined, verb: string): void {
  if (!selection) return;
  if (selection.model !== undefined || selection.effort !== undefined) {
    throw new ConnectorError(`这个 agent 不能从手机${verb}`);
  }
}
