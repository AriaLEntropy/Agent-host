// Ported from botbus-protocol/Sources/BotBusConnectors/ConnectorDescriptors.swift
// (Apache-2.0). Behaviour-preserving TypeScript probe for Agent-host.
//
// 一档（专属）连接器的本机探测：只看"装没装、能不能动手、看得见看不见"，
// 不启动任何 agent，也不碰 dsh 的现有探测。路径规则一律复用各连接器自己的
// `paths.ts` / `config.ts` / `session-reader.ts`，这里不重新发明。
import { statSync } from "node:fs";
import { ClaudeHookInstaller } from "./claude/claude-hook-installer.js";
import { claudePaths, detectClaudeBinary, hasClaudeHome } from "./claude/claude-hooks.js";
import { defaultSupportDirectory } from "./claude/local-hook-server.js";
import { CodexPaths } from "./codex/paths.js";
import { detectHermesBinary, hermesPaths, stateDatabase } from "./hermes/paths.js";
import { locateBinary } from "./locate.js";
import { openClawPaths } from "./openclaw/config.js";
import { detectPiBinary, piPaths } from "./pi/session-reader.js";

/** 协议里的一档 ConnectorKind（ACP / DSH 不在这里，它们是运行时发现的）。 */
export const DEDICATED_KINDS = ["codex", "claude", "hermes", "pi", "openclaw"] as const;
export type DedicatedKind = (typeof DEDICATED_KINDS)[number];

/**
 * 探测结果。`available` 对应上游 `ConnectorProbe.available`（"检测到了"），
 * `status` 对应上游的 ok / degraded：可用但缺一半能力时仍是 available，
 * 只是 degraded 并带一句 lastError，不能显示成 ok。
 */
export type DedicatedDescriptor = {
  kind: DedicatedKind;
  id: DedicatedKind;
  name: string;
  executable?: string;
  available: boolean;
  enabled: boolean;
  lastError?: string;
  origin: "dedicated";
  status: "ok" | "degraded";
};

export function isDedicatedKind(value: unknown): value is DedicatedKind {
  return typeof value === "string" && (DEDICATED_KINDS as readonly string[]).includes(value);
}

/** 本机的全部一档连接器，顺序即协议里的 `ConnectorKind.allCases`。 */
export function dedicatedDescriptors(): DedicatedDescriptor[] {
  return [
    codexDescriptor(),
    claudeDescriptor(),
    hermesDescriptor(),
    piDescriptor(),
    openClawDescriptor(),
  ];
}

/**
 * Codex：可执行文件与 `~/.codex` 下的 state / thread_history 库任一存在即算
 * "检测到"；两者齐全才是 ok。
 */
export function codexDescriptor(): DedicatedDescriptor {
  const home = new CodexPaths();
  const executable = CodexPaths.detectCodexBinary();
  const hasDatabases = home.stateDatabase !== undefined && home.historyDatabase !== undefined;
  if (executable && hasDatabases) {
    return descriptor("codex", "Codex", { executable, status: "ok" });
  }
  if (executable) {
    return descriptor("codex", "Codex", {
      executable,
      status: "degraded",
      lastError: `未找到 Codex 数据库：${home.codexHome}`,
    });
  }
  if (hasDatabases) {
    return descriptor("codex", "Codex", {
      status: "degraded",
      lastError: "未找到 codex 可执行文件，只能只读展示",
    });
  }
  return descriptor("codex", "Codex", {
    available: false,
    status: "degraded",
    lastError: `本机未检测到 Codex：${home.codexHome}`,
  });
}

/**
 * Claude Code：可执行文件与 `~/.claude` 任一存在即算"检测到"，但 hooks 没装
 * 就只是可用而不健康——没有 hooks 看不见电脑上正在跑的会话。只读检测，
 * 绝不写用户的 settings.json。
 */
export function claudeDescriptor(): DedicatedDescriptor {
  const paths = claudePaths();
  const binary = detectClaudeBinary();
  const executable = binary ?? undefined;
  const hasBinary = executable !== undefined;
  if (!hasBinary && !hasClaudeHome(paths)) {
    return descriptor("claude", "Claude Code", {
      available: false,
      status: "degraded",
      lastError: "本机未检测到 Claude Code",
    });
  }
  const hooksInstalled = claudeHooksInstalled(paths);
  if (hasBinary && hooksInstalled) {
    return descriptor("claude", "Claude Code", { executable, status: "ok" });
  }
  if (hasBinary) {
    return descriptor("claude", "Claude Code", {
      executable,
      status: "degraded",
      lastError: "还没安装 hooks，看不到电脑上的 Claude 会话（设置里可一键安装）",
    });
  }
  return descriptor("claude", "Claude Code", {
    status: "degraded",
    lastError: "未找到 claude 可执行文件，只能看不能发起新任务",
  });
}

/** Hermes：`~/.hermes/state.db` 负责"看见"，`hermes` 可执行文件负责"动手"。 */
export function hermesDescriptor(): DedicatedDescriptor {
  const paths = hermesPaths();
  const executable = detectHermesBinary();
  const hasDatabase = stateDatabase(paths) !== undefined;
  if (executable && hasDatabase) {
    return descriptor("hermes", "Hermes", { executable, status: "ok" });
  }
  if (executable) {
    return descriptor("hermes", "Hermes", {
      executable,
      status: "degraded",
      lastError: `还没有 Hermes 会话记录：${paths.hermesHome}`,
    });
  }
  if (hasDatabase) {
    return descriptor("hermes", "Hermes", {
      status: "degraded",
      lastError: "未找到 hermes 可执行文件，只能只读展示",
    });
  }
  return descriptor("hermes", "Hermes", {
    available: false,
    status: "degraded",
    lastError: "本机未检测到 Hermes",
  });
}

/** Pi：会话 JSONL 负责"看见"，`pi` 可执行文件负责"动手"；有二进制就算 ok。 */
export function piDescriptor(): DedicatedDescriptor {
  const paths = piPaths();
  const executable = detectPiBinary();
  if (executable) {
    return descriptor("pi", "Pi", { executable, status: "ok" });
  }
  if (isDirectory(paths.agentDirectory)) {
    return descriptor("pi", "Pi", {
      status: "degraded",
      lastError: "未找到 pi 可执行文件，只能只读展示",
    });
  }
  return descriptor("pi", "Pi", {
    available: false,
    status: "degraded",
    lastError: "本机未检测到 Pi",
  });
}

/**
 * OpenClaw：一切经本机 Gateway，探测只看装没装；Gateway 连不连得上由连接器
 * 运行时回报。**默认关闭**：会话里是私人对话，用户没表态时不该同步到手机。
 */
export function openClawDescriptor(): DedicatedDescriptor {
  const paths = openClawPaths();
  const executable = locateBinary("openclaw");
  const hasStateDirectory = isDirectory(paths.stateDirectory);
  if (!executable && !hasStateDirectory) {
    return descriptor("openclaw", "OpenClaw", {
      available: false,
      enabled: false,
      status: "degraded",
      lastError: "本机未检测到 OpenClaw",
    });
  }
  if (!isFile(paths.configFile)) {
    return descriptor("openclaw", "OpenClaw", {
      executable,
      enabled: false,
      status: "degraded",
      lastError: `未找到 OpenClaw 配置：${paths.configFile}`,
    });
  }
  return descriptor("openclaw", "OpenClaw", { executable, enabled: false, status: "ok" });
}

function claudeHooksInstalled(paths: ReturnType<typeof claudePaths>): boolean {
  try {
    return ClaudeHookInstaller.isInstalled(paths, defaultSupportDirectory());
  } catch {
    // 只读检测失败（settings.json 坏了、权限不足）按"没装"处理。
    return false;
  }
}

function descriptor(
  kind: DedicatedKind,
  name: string,
  options: {
    executable?: string;
    available?: boolean;
    enabled?: boolean;
    status: "ok" | "degraded";
    lastError?: string;
  },
): DedicatedDescriptor {
  return {
    kind,
    id: kind,
    name,
    ...(options.executable ? { executable: options.executable } : {}),
    available: options.available ?? true,
    enabled: options.enabled ?? true,
    ...(options.lastError ? { lastError: options.lastError } : {}),
    origin: "dedicated",
    status: options.status,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
