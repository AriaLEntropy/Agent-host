// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeModels.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { spawnExecutableSync } from "../ported/spawn.js";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  MAX_EFFORTS,
  MAX_EFFORT_LENGTH,
  type ModelOption,
} from "./claude-shared.js";

const families: Array<{ id: string; name: string; adjustable: boolean }> = [
  { id: "fable", name: "Fable", adjustable: true },
  { id: "opus", name: "Opus", adjustable: true },
  { id: "sonnet", name: "Sonnet", adjustable: true },
  { id: "haiku", name: "Haiku", adjustable: false },
];

/**
 * 协议 3.2：Claude Code 在手机上能选的模型。
 *
 * Claude Code 没有列模型的接口，这里报它 `--model` 认的几个别名，强度从本机
 * `claude --help` 的 `--effort` 列表读取。Haiku 不报强度。
 */
export const ClaudeModels = {
  efforts: ["low", "medium", "high", "xhigh", "max"],

  /** 没见过任何 transcript 时的初始列表——只有系列名，没有版本号。 */
  defaultOptions(): ModelOption[] {
    return ClaudeModels.options({ versions: {} });
  },

  /** 显示名带上版本号；没有版本的只显示系列名。 */
  options(input: {
    versions: Record<string, number[]>;
    efforts?: string[];
    custom?: ModelOption[];
  }): ModelOption[] {
    const efforts = input.efforts ?? ClaudeModels.efforts;
    const builtIn = families.map((family) => {
      const version = input.versions[family.id];
      const suffix = version && version.length > 0 ? ` ${version.join(".")}` : "";
      const option: ModelOption = {
        id: family.id,
        displayName: family.name + suffix,
      };
      if (family.adjustable) option.efforts = [...efforts];
      return option;
    });
    const seen = new Set(builtIn.map((option) => option.id));
    for (const option of input.custom ?? []) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      builtIn.push(option);
    }
    return builtIn;
  },

  /**
   * `settings.json` 的 env 里的自定义模型
   *
   * Claude Code 没有列模型的接口；用户把第三方端点的模型名写在
   * ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL 里时，把它们也放进选择器。
   */
  customOptions(env: Record<string, string>): ModelOption[] {
    const keys = [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ];
    const result: ModelOption[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const id = env[key]?.trim();
      if (!id || seen.has(id) || families.some((family) => family.id === id)) continue;
      seen.add(id);
      result.push({ id, displayName: id });
    }
    return result;
  },

  /** 本机 `claude --help` 里 `--effort` 列出的档位；CLI 没装、失败或没列出时 null。 */
  effortsForBinary(binary: string | null): string[] | null {
    if (!binary) return null;
    // PORT: Swift 的 Process + DispatchWorkItem 超时换成 spawnSync(timeout)。行为一致。
    const result = spawnExecutableSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 3000,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return ClaudeModels.effortsInHelp(result.stdout ?? "");
  },

  /**
   * `--effort <level>` 那一项的说明可能折到下一行（新版按 80 列排），续行一起读：
   * 续行是缩进过、又不以 `-` 开头的行。
   */
  effortsInHelp(help: string): string[] | null {
    const lines = help.split("\n");
    const start = lines.findIndex((line) => line.includes("--effort <level>"));
    if (start < 0) return null;
    let entry = lines[start];
    for (let index = start + 1; index < lines.length; index += 1) {
      const next = lines[index];
      const value = next.trim();
      const indented = next.length > 0 && /^\s/.test(next);
      if (!indented || value.length === 0 || value.startsWith("-")) break;
      entry += ` ${value}`;
    }
    const opening = entry.lastIndexOf("(");
    const closing = entry.lastIndexOf(")");
    if (opening < 0 || closing < 0 || opening >= closing) return null;
    const values = entry
      .slice(opening + 1, closing)
      .split(",")
      .map((part) => part.trim());
    if (
      values.length === 0 ||
      !values.every(isValidEffort) ||
      new Set(values).size !== values.length
    ) {
      return null;
    }
    return values.slice(0, MAX_EFFORTS);
  },

  option(id: string | null | undefined, options: ModelOption[] = ClaudeModels.defaultOptions()): ModelOption | undefined {
    if (!id) return undefined;
    return options.find((option) => option.id === id);
  },

  /** transcript 里记的完整模型名换成手机认得的别名；认不出的 null。 */
  optionId(transcriptModel: string): string | null {
    return parse(transcriptModel)?.id ?? null;
  },

  /** 完整模型名里的版本号：`claude-opus-5-5` → [5, 5]。 */
  version(transcriptModel: string): number[] | null {
    return parse(transcriptModel)?.version ?? null;
  },

  /**
   * 把见过的完整模型名记进 `versions`，只往高处改。
   * 版本有变化时返回 true。
   */
  note(transcriptModel: string, versions: Record<string, number[]>): boolean {
    const parsed = parse(transcriptModel);
    if (!parsed || !parsed.version) return false;
    const current = versions[parsed.id];
    if (current && !lexicographicallyPrecedes(current, parsed.version)) return false;
    versions[parsed.id] = parsed.version;
    return true;
  },

  /**
   * transcript 末尾最后一条 assistant 消息用的完整模型名（认得出别名的那条）。
   * 只读末尾一小段、按原始文本找 `"model":"`，不解析整份 JSONL。
   */
  lastModel(path: string, tailBytes = 64 * 1024): string | null {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      const offset = size > tailBytes ? size - tailBytes : 0;
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      if (length > 0) readSync(fd, buffer, 0, length, offset);
      const text = buffer.toString("utf8");
      let searchEnd = text.length;
      while (searchEnd > 0) {
        const index = text.lastIndexOf('"model":"', searchEnd - 1);
        if (index < 0) return null;
        searchEnd = index;
        const valueStart = index + '"model":"'.length;
        const close = text.indexOf('"', valueStart);
        if (close < 0) continue;
        const name = text.slice(valueStart, close);
        if (ClaudeModels.optionId(name) !== null) return name;
      }
      return null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  },
};

function parse(transcriptModel: string): { id: string; version: number[] | null } | null {
  let lowered = transcriptModel.toLowerCase();
  if (!lowered.startsWith("claude-")) return null;
  // `[1m]` 是上下文档位，Vertex 的名字带 `@日期`。
  const cut = lowered.search(/[[@]/);
  if (cut >= 0) lowered = lowered.slice(0, cut);
  const parts = lowered.slice("claude-".length).split("-").filter((part) => part.length > 0);
  const id = parts
    .map((part) => families.find((family) => family.id === part)?.id)
    .find((value): value is string => typeof value === "string");
  if (!id) return null;
  // 版本号是一两位的数字段；8 位的是发布日期。
  const version = parts
    .filter((part) => /^\d{1,2}$/.test(part))
    .map((part) => Number(part));
  return { id, version: version.length === 0 ? null : version };
}

function isValidEffort(effort: string): boolean {
  if (effort.length < 1 || effort.length > MAX_EFFORT_LENGTH || effort.startsWith("-")) return false;
  return /^[a-z0-9-]+$/.test(effort);
}

/** Swift 数组的 lexicographic 比较。 */
function lexicographicallyPrecedes(lhs: number[], rhs: number[]): boolean {
  const length = Math.min(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    if (lhs[index] !== rhs[index]) return lhs[index] < rhs[index];
  }
  return lhs.length < rhs.length;
}
