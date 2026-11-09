// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeSessionHistory.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSION_HISTORY_WINDOW_MS } from "../session-window.js";
import { ClaudeModels } from "./claude-models.js";
import { narrationText, stripInjectedBlocks } from "./claude-message-reader.js";
import {
  LAST_MESSAGE_LIMIT,
  TITLE_LIMIT,
  TitleSource,
  assistantText,
  isInterruptionMarker,
  parseISODate,
  recordValue,
  trimmed,
} from "./claude-shared.js";

export type ClaudeSessionEntry = {
  sessionID: string;
  projectPath: string;
  /** null = 什么都没取到，由连接器用项目名占位。 */
  title: string | null;
  titleSource: TitleSource;
  lastMessage: string | null;
  /** 最后一条 assistant 消息用的完整模型名。 */
  model: string | null;
  startedAt: number;
  updatedAt: number;
};

export type ClaudeTurnEnding =
  | { kind: "interrupted"; at: number }
  | { kind: "completed"; at: number };

const RECENT_WINDOW_MS = SESSION_HISTORY_WINDOW_MS;
const IDLE_AFTER_MS = 24 * 3600 * 1000;

/**
 * 启动时补回最近的 Claude Code 会话：只读 `~/.claude/projects/<目录>/<sessionId>.jsonl`。
 *
 * 只读开头 64 KB 与末尾 256 KB；跳过 `entrypoint` 为 `sdk-py` / `sdk-ts` 的脚本会话
 * （保留 `sdk-cli`）与没有 prompt 的空会话；标题优先 `custom-title`，其次 `ai-title`、
 * 首条真实 prompt（先剥 `<system-reminder>`）、`last-prompt`。
 */
export const ClaudeSessionHistory = {
  headBytes: 64 * 1024,
  tailBytes: 256 * 1024,
  excludedEntrypoints: new Set(["sdk-py", "sdk-ts"]),
  /** 会话回溯窗口；一年，列表靠条数收敛 */
  recentWindowMs: RECENT_WINDOW_MS,
  /** 超过 24 小时没动静记 idle（SessionFormatting.idleAfter）。 */
  idleAfterMs: IDLE_AFTER_MS,

  /** 窗口内被写过的会话，最新的在前，最多 `limit` 条。 */
  recentSessions(
    projectsDirectory: string,
    now: number,
    limit: number,
    windowMs = RECENT_WINDOW_MS,
  ): ClaudeSessionEntry[] {
    const since = now - windowMs;
    let directories: string[];
    try {
      directories = readdirSync(projectsDirectory);
    } catch {
      return [];
    }
    const candidates: Array<{ url: string; modifiedAt: number; size: number }> = [];
    for (const name of directories) {
      const directory = join(projectsDirectory, name);
      let files: string[];
      try {
        files = readdirSync(directory);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const url = join(directory, file);
        let stat;
        try {
          stat = statSync(url);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.mtimeMs < since) continue;
        candidates.push({ url, modifiedAt: stat.mtimeMs, size: stat.size });
      }
    }
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
    const entries: ClaudeSessionEntry[] = [];
    for (const candidate of candidates) {
      if (entries.length >= limit) break;
      const entry = ClaudeSessionHistory.summarizeFile(candidate.url, candidate.size, candidate.modifiedAt);
      if (entry) entries.push(entry);
    }
    return entries;
  },

  /** 读一个 transcript 的头尾两段。小文件整份读一次。 */
  summarizeFile(filePath: string, size: number, modifiedAt: number): ClaudeSessionEntry | null {
    const sessionID = filePath.replace(/\.[^./\\]+$/, "").split(/[\\/]/).pop() ?? "";
    if (sessionID.length === 0) return null;
    let fd: number;
    try {
      fd = openSync(filePath, "r");
    } catch {
      return null;
    }
    try {
      const headLength = Math.min(ClaudeSessionHistory.headBytes, size);
      const head = readRange(fd, 0, headLength);
      if (!head || head.length === 0) return null;
      const headText = head.toString("utf8");
      // 先便宜地挡掉 SDK 会话：不做 JSON 解析。
      const earlyEntrypoint = rawStringValue(headText, "entrypoint", false);
      if (earlyEntrypoint && ClaudeSessionHistory.excludedEntrypoints.has(earlyEntrypoint)) return null;
      let tailText: string | null = null;
      if (size > ClaudeSessionHistory.headBytes) {
        const offset = Math.max(ClaudeSessionHistory.headBytes, size - ClaudeSessionHistory.tailBytes);
        const tail = readRange(fd, offset, size - offset);
        if (tail) tailText = tail.toString("utf8");
      }
      return ClaudeSessionHistory.summarize(
        headText,
        tailText,
        size <= ClaudeSessionHistory.headBytes,
        sessionID,
        modifiedAt,
      );
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  },

  /**
   * - headText: 文件开头；headIsWholeFile 为 false 时最后一段不完整，丢掉。
   * - tailText: 文件末尾（与 head 不重叠）；第一段不完整，丢掉。
   */
  summarize(
    headText: string,
    tailText: string | null,
    headIsWholeFile: boolean,
    sessionID: string,
    modifiedAt: number,
  ): ClaudeSessionEntry | null {
    let entrypoint: string | null = null;
    let cwd: string | null = null;
    let customTitle: string | null = null;
    let aiTitle: string | null = null;
    let firstPrompt: string | null = null;
    let lastPrompt: string | null = null;
    let lastAssistant: string | null = null;
    let model: string | null = null;
    let startedAt: number | null = null;

    const headLines = lines(headText, false, !headIsWholeFile);
    const tailLines = tailText === null ? [] : lines(tailText, true, false);
    for (const line of [...headLines, ...tailLines]) {
      let object: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        object = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entrypoint === null && typeof object.entrypoint === "string") entrypoint = object.entrypoint;
      if (typeof object.cwd === "string" && object.cwd.length > 0) cwd = object.cwd;
      if (startedAt === null) {
        const date = parseISODate(object.timestamp);
        if (date) startedAt = date.getTime();
      }
      switch (object.type) {
        case "custom-title": {
          const value = titleValue(object, "customTitle");
          if (value !== null) customTitle = value;
          break;
        }
        case "ai-title": {
          const value = titleValue(object, "aiTitle");
          if (value !== null) aiTitle = value;
          break;
        }
        case "last-prompt": {
          const value = typeof object.lastPrompt === "string" ? trimmed(object.lastPrompt) : "";
          if (value.length > 0) lastPrompt = value;
          break;
        }
        case "user": {
          if (firstPrompt === null) firstPrompt = promptText(object);
          break;
        }
        case "assistant": {
          const text = assistantText(object, narrationText);
          if (text !== null) lastAssistant = text;
          const message = recordValue(object.message);
          if (typeof message.model === "string" && ClaudeModels.optionId(message.model) !== null) {
            model = message.model;
          }
          break;
        }
        default:
          break;
      }
    }

    // 首行被截断时这两个键只在截断的那段里——按原始文本再找一次。
    if (entrypoint === null) {
      entrypoint =
        rawStringValue(headText, "entrypoint", false) ??
        (tailText === null ? null : rawStringValue(tailText, "entrypoint", false));
    }
    if (cwd === null) {
      cwd =
        (tailText === null ? null : rawStringValue(tailText, "cwd", true)) ??
        rawStringValue(headText, "cwd", true);
    }
    if (entrypoint && ClaudeSessionHistory.excludedEntrypoints.has(entrypoint)) return null;
    if (!cwd || cwd.length === 0) return null;
    const title = customTitle ?? aiTitle ?? firstPrompt ?? lastPrompt;
    if (title === null && lastAssistant === null) return null;
    const titleSource =
      customTitle !== null
        ? TitleSource.named
        : aiTitle !== null
          ? TitleSource.generated
          : title !== null
            ? TitleSource.prompt
            : TitleSource.placeholder;

    return {
      sessionID,
      projectPath: cwd,
      title: title === null ? null : title.slice(0, TITLE_LIMIT),
      titleSource,
      lastMessage: lastAssistant === null ? null : lastAssistant.slice(0, LAST_MESSAGE_LIMIT),
      model,
      startedAt: Math.min(startedAt ?? modifiedAt, modifiedAt),
      updatedAt: modifiedAt,
    };
  },

  /**
   * transcript 末尾 `tailBytes` 里 Claude 起的标题：`custom-title` 优先，
   * 其次 `ai-title`。两者都会随对话反复重写到文件末尾。
   */
  appTitle(path: string): { title: string; source: TitleSource } | null {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      const offset = size > ClaudeSessionHistory.tailBytes ? size - ClaudeSessionHistory.tailBytes : 0;
      const data = readRange(fd, offset, size - offset);
      if (!data) return null;
      const text = data.toString("utf8");
      let customTitle: string | null = null;
      let aiTitle: string | null = null;
      for (const line of lines(text, offset > 0, false)) {
        if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
        let object: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          object = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (object.type) {
          case "custom-title": {
            const value = titleValue(object, "customTitle");
            if (value !== null) customTitle = value;
            break;
          }
          case "ai-title": {
            const value = titleValue(object, "aiTitle");
            if (value !== null) aiTitle = value;
            break;
          }
          default:
            break;
        }
      }
      if (customTitle !== null) return { title: customTitle.slice(0, TITLE_LIMIT), source: TitleSource.named };
      if (aiTitle !== null) return { title: aiTitle.slice(0, TITLE_LIMIT), source: TitleSource.generated };
      return null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  },

  /** 看这一轮的收尾只读末尾这么多。 */
  turnEndingBytes: 64 * 1024,

  /**
   * 末尾最后一条对话行是不是收尾标记。只看 user / assistant 行与
   * `stop_hook_summary`；元数据行跳过。
   */
  turnEnding(path: string): ClaudeTurnEnding | null {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      const offset = size > ClaudeSessionHistory.turnEndingBytes ? size - ClaudeSessionHistory.turnEndingBytes : 0;
      const data = readRange(fd, offset, size - offset);
      if (!data) return null;
      const text = data.toString("utf8");
      for (const line of lines(text, offset > 0, false).reverse()) {
        let object: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          object = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (object.type) {
          case "assistant":
            return null;
          case "user": {
            if (!isInterruptionMarker(object)) return null;
            const at = parseISODate(object.timestamp);
            if (!at) return null;
            return { kind: "interrupted", at: at.getTime() };
          }
          case "system": {
            if (object.subtype !== "stop_hook_summary") continue;
            const at = parseISODate(object.timestamp);
            return at ? { kind: "completed", at: at.getTime() } : null;
          }
          default:
            continue;
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  },

  /**
   * transcript 末尾 `tailBytes` 里有没有这个 `tool_use_id` 的 `tool_result`。
   */
  hasToolResult(toolUseID: string, path: string): boolean {
    if (toolUseID.length === 0) return false;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return false;
    }
    try {
      const size = fstatSync(fd).size;
      const offset = size > ClaudeSessionHistory.tailBytes ? size - ClaudeSessionHistory.tailBytes : 0;
      const data = readRange(fd, offset, size - offset);
      if (!data) return false;
      const text = data.toString("utf8");
      for (const line of lines(text, offset > 0, false)) {
        if (!line.includes(toolUseID)) continue;
        let object: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          object = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        if (object.type !== "user") continue;
        const message = recordValue(object.message);
        if (!Array.isArray(message.content)) continue;
        for (const rawBlock of message.content) {
          const block = recordValue(rawBlock);
          if (block.type === "tool_result" && block.tool_use_id === toolUseID) return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      closeSync(fd);
    }
  },
};

function readRange(fd: number, offset: number, length: number): Buffer | null {
  try {
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = readSync(fd, buffer, total, length - total, offset + total);
      if (read <= 0) break;
      total += read;
    }
    return total === length ? buffer : buffer.subarray(0, total);
  } catch {
    return null;
  }
}

/** 解析细节：标题值。 */
export function titleValue(object: Record<string, unknown>, key: string): string | null {
  const raw = object[key];
  if (typeof raw !== "string") return null;
  const value = trimmed(raw);
  return value.length > 0 ? value : null;
}

/**
 * 人真正敲的一条 prompt。跳过 meta 行、子代理行、只有 tool_result 的行，
 * 以及 `<command-name>` 这类斜杠命令留下的标签行。
 */
export function promptText(object: Record<string, unknown>): string | null {
  if (object.isMeta === true || object.isSidechain === true) return null;
  const message = recordValue(object.message);
  const content = message.content;
  let text: string | null = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as Array<Record<string, unknown>>)
      .filter((block) => recordValue(block).type === "text")
      .map((block) => {
        const value = recordValue(block).text;
        return typeof value === "string" ? value : "";
      })
      .join("\n");
  }
  if (text === null) return null;
  const stripped = stripInjectedBlocks(text).trim();
  if (stripped.length === 0 || stripped.startsWith("<") || stripped.startsWith("Caveat:")) return null;
  return stripped;
}

/** 按 `\n` 切行；截断的头尾段各丢掉不完整的那一截。 */
export function lines(text: string, dropFirst: boolean, dropLast: boolean): string[] {
  const parts = text.split("\n");
  if (dropFirst && parts.length > 0) parts.shift();
  if (dropLast && parts.length > 0) parts.pop();
  return parts.filter((part) => part.length > 0);
}

/**
 * 不做 JSON 解析，直接在原始文本里找 `"key":"value"`（Claude Code 写的是紧凑 JSON）。
 * 值里的转义交给 JSON 解析；找不到或解不开都是 null。
 */
export function rawStringValue(text: string, key: string, last: boolean): string | null {
  const marker = `"${key}":"`;
  const start = last ? text.lastIndexOf(marker) : text.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  let escaped = false;
  for (let index = valueStart; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      const literal = `"${text.slice(valueStart, index)}"`;
      try {
        const value: unknown = JSON.parse(literal);
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
