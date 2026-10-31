import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec, ManifestProblem } from "./discover.js";
import {
  AcpAuthRequired,
  AcpProcess,
  AcpRejected,
  AcpTimeout,
  IDLE_MS,
} from "./runtime.js";

/** `agent check` 不给 `--prompt` 时用的提示词，与 `scripts/acp-probe.ts` 一致。 */
export const DEFAULT_CHECK_PROMPT = "Reply with exactly: OK";
/** `session/new` 的等待上限。 */
export const SESSION_TIMEOUT_MS = 60_000;
/** 上游自查文档：一轮 prompt 最多等 5 分钟。 */
export const PROMPT_TIMEOUT_MS = 5 * 60_000;

export type ProbeCapabilities = {
  loadSession: boolean;
  resume: boolean;
  image: boolean;
  listSessions: boolean;
};

export type ProbeToolCall = {
  title: string;
  toolCallId?: string;
};

export type ProbeResult = {
  spec: AgentSpec;
  /** 本轮 `session/new` / `session/prompt` 使用的临时目录。 */
  cwd: string;
  protocolVersion: number;
  capabilities: ProbeCapabilities;
  sessionId: string;
  prompt?: string;
  /** 没给 prompt 时不做 `session/prompt`，这里为 undefined。 */
  stopReason?: string;
  /** 本轮收到的 `agent_message_chunk` 拼接结果（已 trim）。 */
  agentText: string;
  toolCalls: ProbeToolCall[];
};

export type ProbeErrorCode = "unavailable" | "timeout" | "auth" | "rejected" | "failed";

/** 自查失败分类：CLI 据此选择退出码与标签。 */
export class ProbeError extends Error {
  constructor(
    readonly code: ProbeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProbeError";
  }
}

/** `AcpProcess` 里自查需要的部分；测试可以注入同形状的假进程。 */
export type ProbeProcessLike = {
  readonly capabilities: ProbeCapabilities;
  start(): Promise<void>;
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  respond(id: number, result: unknown): void;
  notify(method: string, params: unknown): void;
  kill(): void;
};

export type ProbeProcessHandlers = {
  /** agent 主动发来的通知 / 请求（`session/update`、`session/request_permission` 等）。 */
  onEvent: (message: Record<string, unknown>) => void;
  /** 子进程退出。 */
  onExit: () => void;
};

export type ProbeOptions = {
  /** 指定工作目录；不提供时创建临时目录并在结束时删掉。 */
  cwd?: string;
  /** 结束后保留临时目录（调试用）。 */
  keepCwd?: boolean;
  sessionTimeoutMs?: number;
  promptTimeoutMs?: number;
  idleMs?: number;
  /** 测试注入缝：不提供时启动真实的 `AcpProcess`。 */
  createProcess?: (spec: AgentSpec, handlers: ProbeProcessHandlers) => ProbeProcessLike;
};

const ERROR_LABELS: Record<ProbeErrorCode, string> = {
  unavailable: "UNAVAILABLE",
  timeout: "TIMEOUT",
  auth: "AUTH_REQUIRED",
  rejected: "REJECTED",
  failed: "FAILED",
};

export function probeErrorLabel(error: ProbeError): string {
  return ERROR_LABELS[error.code];
}

/** auth=3 与脚本历史一致；unavailable=2 与用法错误同档；其余失败为 1。 */
export function probeExitCode(error: ProbeError): number {
  switch (error.code) {
    case "auth":
      return 3;
    case "unavailable":
      return 2;
    default:
      return 1;
  }
}

/**
 * 对一个 ACP agent 做自查：
 *
 * 1. 启动进程并完成 `initialize`（`AcpProcess.start()` 里会校验协议版本）；
 * 2. 在临时目录里 `session/new`；
 * 3. 给了 prompt 就在同一会话里跑 `session/prompt`，收集 agent 文本与工具调用。
 *
 * 审批请求一律回 `cancelled`（与上游 `agent check` 一致），不注入任何 MCP。
 * 结束时一定杀掉进程并清理临时目录；超时 / 鉴权 / 被拒绝分别抛
 * `ProbeError`（code = timeout / auth / rejected），其他错误归为 failed。
 */
export async function probeAcpAgent(
  spec: AgentSpec,
  prompt?: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  if (!spec.available) {
    throw new ProbeError(
      "unavailable",
      `agent ${spec.id} 不可用：${spec.lastError ?? "未知原因"}`,
    );
  }
  if (!spec.executable) {
    throw new ProbeError("unavailable", `agent ${spec.id} 没有可执行文件，无法自查`);
  }

  const ownedCwd = options.cwd === undefined;
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "acp-probe-")));
  const sessionTimeoutMs = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  const promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
  const idleMs = options.idleMs ?? Math.max(IDLE_MS, promptTimeoutMs);

  const chunks: string[] = [];
  const toolCalls: ProbeToolCall[] = [];
  let process: ProbeProcessLike | undefined;

  const handlers: ProbeProcessHandlers = {
    onEvent: (message) => {
      if (message.method === "session/update") {
        const update = record(record(message.params).update);
        if (update.sessionUpdate === "agent_message_chunk") {
          const text = record(update.content).text;
          if (typeof text === "string") chunks.push(text);
        } else if (update.sessionUpdate === "tool_call") {
          const toolCallId = update.toolCallId;
          toolCalls.push({
            title: typeof update.title === "string" ? update.title : "",
            ...(typeof toolCallId === "string" ? { toolCallId } : {}),
          });
        }
        return;
      }
      if (message.method === "session/request_permission" && typeof message.id === "number") {
        // 自查不替用户做决定：与上游一样一律取消。
        process?.respond(message.id, { outcome: { outcome: "cancelled" } });
      }
    },
    onExit: () => undefined,
  };

  const createProcess =
    options.createProcess ??
    ((target: AgentSpec, targetHandlers: ProbeProcessHandlers) =>
      new AcpProcess(
        target.executable!,
        target.args,
        target.env,
        targetHandlers.onEvent,
        targetHandlers.onExit,
        idleMs,
      ));
  process = createProcess(spec, handlers);

  let phase = "initialize";
  try {
    await process.start();

    phase = "session/new";
    const created = record(
      await process.call("session/new", { cwd, mcpServers: [] }, sessionTimeoutMs),
    );
    const sessionId = typeof created.sessionId === "string" ? created.sessionId.trim() : "";
    if (!sessionId) throw new ProbeError("rejected", "session/new 没有返回 sessionId");

    let stopReason: string | undefined;
    if (prompt !== undefined) {
      phase = "session/prompt";
      const result = record(
        await process.call(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text: prompt }] },
          promptTimeoutMs,
        ),
      );
      stopReason = typeof result.stopReason === "string" ? result.stopReason : "unknown";
    }

    return {
      spec,
      cwd,
      protocolVersion: 1,
      capabilities: { ...process.capabilities },
      sessionId,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
      agentText: chunks.join("").trim(),
      toolCalls,
    };
  } catch (error) {
    throw toProbeError(error, phase);
  } finally {
    process.kill();
    if (ownedCwd && !options.keepCwd) {
      try {
        await rm(cwd, { recursive: true, force: true });
      } catch {
        // Windows 上 agent 退出后可能短暂锁住工作目录；清理失败不影响结果。
      }
    }
  }
}

function toProbeError(error: unknown, phase: string): ProbeError {
  if (error instanceof ProbeError) return error;
  if (error instanceof AcpAuthRequired) {
    return new ProbeError("auth", `${phase} 需要先登录：${error.message}`, { cause: error });
  }
  if (error instanceof AcpTimeout) {
    return new ProbeError("timeout", `${phase} 超时：${error.message}`, { cause: error });
  }
  if (error instanceof AcpRejected) {
    return new ProbeError("rejected", `${phase} 被 agent 拒绝或退出：${error.message}`, {
      cause: error,
    });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ProbeError("failed", `${phase} 失败：${detail}`, { cause: error });
}

/** `agent list` 的一行：id、kind、name、available、enabled、status、lastError。 */
export function formatAgentLine(agent: AgentSpec): string {
  const status =
    agent.status ??
    (agent.lastError && agent.available ? "error" : agent.available ? "ok" : "degraded");
  return [
    agent.id,
    agent.kind,
    agent.name,
    `available=${agent.available}`,
    `enabled=${agent.enabled}`,
    `status=${status}`,
    `lastError=${agent.lastError ?? "-"}`,
  ].join("\t");
}

/** 清单没生效时的可读提示，与上游 `agent list` 的 `✗` 行一致。 */
export function formatAgentProblem(problem: ManifestProblem): string {
  return `✗ ${problem.file}：${problem.reason}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
