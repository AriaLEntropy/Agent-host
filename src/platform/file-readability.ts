/**
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/FileHandleReadability.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 上游解决的是 Linux/macOS 上"按 fd 读、读到 EOF 才收尾、别把软链接读到项目外"。
 * Node 里没有 `FileHandle.readabilityHandler`，但同样的安全边界适用：
 *
 * - 先 `lstat` 原路径：软链接、目录、设备、FIFO 一律不读；
 * - `realpath` 再 `open`，并核对打开后的 fd 与原路径是同一个文件（inode + device），
 *   挡住"校验完、读取前被换掉"的情况；
 * - 按 fd 读，边读边数字节，超过上限立刻失败，不把整份大文件读进内存。
 *
 * 只读普通文件；调用方（`fetchFile` / 产物缓存）仍然负责"路径在项目内"的判断。
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";

export type FileReadabilityErrorCode =
  | "missing"
  | "not_file"
  | "symlink"
  | "too_large"
  | "changed"
  | "unreadable";

export class FileReadabilityError extends Error {
  readonly code: FileReadabilityErrorCode;

  constructor(code: FileReadabilityErrorCode, message: string) {
    super(message);
    this.name = "FileReadabilityError";
    this.code = code;
  }
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * 按 fd 读取一个普通文件。`maxBytes` 不传时不限大小；超过上限抛 `too_large`。
 * 读取失败时抛 `FileReadabilityError`，调用方可以按 `code` 给出具体原因。
 */
export async function readFileByHandle(
  path: string,
  options: { maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  let before;
  try {
    before = await lstat(path);
  } catch {
    throw new FileReadabilityError("missing", "file is missing");
  }
  if (before.isSymbolicLink()) {
    throw new FileReadabilityError("symlink", "file is a symbolic link");
  }
  if (!before.isFile()) {
    throw new FileReadabilityError("not_file", "path is not a regular file");
  }
  if (before.size > maxBytes) {
    throw new FileReadabilityError("too_large", "file is larger than the limit");
  }

  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new FileReadabilityError("missing", "file is missing");
  }

  // POSIX 上 O_NOFOLLOW 挡住最后一段在 realpath 之后变成软链接；Windows 没有这个标志，
  // 上面的 lstat + 打开后的 inode 核对仍然是必需的。
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | noFollow;
  let handle;
  try {
    handle = await open(real, flags);
  } catch (error) {
    throw openError(error);
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new FileReadabilityError("not_file", "path is not a regular file");
    }
    if (opened.size > maxBytes) {
      throw new FileReadabilityError("too_large", "file is larger than the limit");
    }
    // inode 为 0 的平台（部分 Windows/网络盘）无法核对，交给大小与读取结果把关。
    if (
      before.ino !== 0 &&
      opened.ino !== 0 &&
      (before.ino !== opened.ino || before.dev !== opened.dev)
    ) {
      throw new FileReadabilityError("changed", "file changed while it was being read");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new FileReadabilityError("too_large", "file is larger than the limit");
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof FileReadabilityError) throw error;
    throw new FileReadabilityError("unreadable", "file could not be read");
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 读取失败一律返回 null：产物缓存与旧的 `readRegularFile` 调用方就是这样用的。 */
export async function readRegularFile(
  path: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Buffer | null> {
  try {
    return await readFileByHandle(path, { maxBytes });
  } catch {
    return null;
  }
}

function openError(error: unknown): FileReadabilityError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "ENOENT") return new FileReadabilityError("missing", "file is missing");
  if (code === "ELOOP") return new FileReadabilityError("symlink", "file is a symbolic link");
  if (code === "EISDIR") return new FileReadabilityError("not_file", "path is not a regular file");
  return new FileReadabilityError("unreadable", "file could not be opened");
}
