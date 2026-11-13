import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Claude Code 会把「工具追加」写进会话历史（tool_addition + tool_definition）。
 *
 * 少数会话在带 `--permission-prompt-tool stdio` 恢复时，会把这些块回放给端点；
 * Anthropic 兼容端点（例如 DeepSeek）只认 `tool_reference`，于是返回 422。
 * 检测到这种历史时，恢复改用不带权限提示通道的模式：会话还能继续，但这一轮
 * 不会把 Claude 的权限请求转给手机。
 */
const CHUNK = 256 * 1024;
const CARRY_LIMIT = 4 * CHUNK;

export function lineHasUnsupportedToolAddition(line: string): boolean {
  return line.includes('"tool_addition"') && line.includes('"tool_definition"');
}

/** 流式扫描，避免把几十 MB 的会话一次读进内存 */
export function fileHasUnsupportedToolAddition(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  const buffer = Buffer.alloc(CHUNK);
  let carry = "";
  let position = 0;
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, CHUNK, position);
      if (bytes <= 0) break;
      position += bytes;
      const lines = (carry + buffer.toString("utf8", 0, bytes)).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (lineHasUnsupportedToolAddition(line)) return true;
      }
      if (carry.length > CARRY_LIMIT) carry = carry.slice(-CHUNK);
    }
    return lineHasUnsupportedToolAddition(carry);
  } finally {
    closeSync(fd);
  }
}
