/**
 * 本机产物与手机上传图片的缓存。
 *
 * 这是 Agent-host 自己的 Windows 实现，不移植上游 Swift 代码，所以不使用
 * Apache 许可证头。字节落在 `hostDataDir()/artifacts`（Windows 下就是当前
 * 用户的 `%APPDATA%\agent-host\artifacts`，不进公共目录），每个产物一份
 * `<artifactId>.bin` + `<artifactId>.json` 元数据，默认保留 7 天。
 *
 * 安全边界：artifactId 只能是协议规定的 22 字符 base64url；任何拼路径之前
 * 都先校验。读取时用 lstat 确认是普通文件，不跟随软链接。
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { hostDataDir } from "../config.js";

/** 协议 2.3：单个产物上限 2 MiB（Host 侧缓存，不是 Relay 的 10 MiB）。 */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/**
 * `fetchFile` 取回的本机媒体文件上限：协议给产物的上限是 10 MiB，这里沿用同一个
 * 数字而不是放大到 Relay 的限额。音频之外的类型都不能是 SVG 这类可嵌入脚本的
 * 内容；超过这个大小的文件直接报错，不把整份内容读进内存。
 */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
/** 产物保留 7 天，与 Relay 的 `ARTIFACT_TTL_MS` 对齐。 */
export const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 协议：Agent 生成的 22 字符 base64url（16 随机字节）。 */
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** 手机上传只收图片；SVG 等可执行/可嵌入脚本的类型一律拒绝。 */
export const ALLOWED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * 本机取回的文件只可能是协议允许的媒体类型：`image/* | video/* | application/pdf`
 * （对话里认出的扩展名只有这几种）。读取产物元数据时按这张范围校验；手机上传
 * 仍由 `ALLOWED_UPLOAD_TYPES` 收得更紧。
 */
export function isAllowedArtifactType(value: string): boolean {
  return (
    value === "application/pdf" ||
    value.startsWith("image/") ||
    value.startsWith("video/")
  );
}

export type ArtifactErrorCode = "invalid_id" | "too_large" | "unsupported_type";

export class ArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode) {
    super(code);
    this.name = "ArtifactError";
  }
}

export type ArtifactMeta = {
  contentType: string;
  size: number;
  createdAt: string;
};

export type StoredArtifact = ArtifactMeta & { bytes: Buffer };

export type StoredUpload = {
  artifactId: string;
  size: number;
  createdAt: string;
};

type ArtifactRecord = ArtifactMeta & {
  version: 1;
  id: string;
};

let artifactsDirOverride: string | undefined;

/**
 * 测试注入点。传 `undefined` 恢复默认的 `hostDataDir()/artifacts`。
 * 默认目录在调用时解析，这样 `AGENT_HOST_CONFIG` 在启动后设置也能生效。
 */
export function setArtifactsDir(dir: string | undefined) {
  artifactsDirOverride = dir === undefined ? undefined : resolve(dir);
}

export function artifactsDir(): string {
  return artifactsDirOverride ?? resolve(hostDataDir(), "artifacts");
}

export function isValidArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID_PATTERN.test(value);
}

/** 去掉 `; charset=…` 之类的参数并统一小写。 */
export function normalizeContentType(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.split(";")[0].trim().toLowerCase();
}

function ensureInsideRoot(name: string): string {
  const root = resolve(artifactsDir());
  const target = resolve(root, name);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new ArtifactError("invalid_id");
  }
  return target;
}

function dataPath(artifactId: string): string {
  return ensureInsideRoot(`${artifactId}.bin`);
}

function metaPath(artifactId: string): string {
  return ensureInsideRoot(`${artifactId}.json`);
}

async function ensureRoot(): Promise<void> {
  const root = resolve(artifactsDir());
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Windows 上 mode 基本被忽略，但父目录 `%APPDATA%\agent-host` 本来就按用户
  // 隔离；Unix 上再收紧一次，避免同一台机器的其他用户读到产物。
  try {
    await chmod(root, 0o700);
  } catch {
    // 不是所有文件系统都支持 chmod，权限继承已经够用。
  }
}

async function readRegularFile(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

async function readRecord(artifactId: string): Promise<ArtifactRecord | null> {
  if (!isValidArtifactId(artifactId)) return null;
  const bytes = await readRegularFile(metaPath(artifactId));
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ArtifactRecord>;
    if (parsed.version !== 1 || parsed.id !== artifactId) return null;
    if (typeof parsed.contentType !== "string") return null;
    // 元数据读取接受对话取回的媒体类型（图片 / 视频 / PDF）；手机上传的更严格
    // 限制在 `resolveAttachment` 里单独把守。
    if (!isAllowedArtifactType(parsed.contentType)) return null;
    if (!Number.isInteger(parsed.size) || (parsed.size as number) < 0) return null;
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return null;
    }
    return {
      version: 1,
      id: artifactId,
      contentType: parsed.contentType,
      size: parsed.size as number,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function isExpired(createdAt: string, now: Date): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return true;
  return now.getTime() - created > ARTIFACT_TTL_MS;
}

async function removeArtifact(artifactId: string): Promise<void> {
  if (!isValidArtifactId(artifactId)) return;
  await Promise.allSettled([unlink(dataPath(artifactId)), unlink(metaPath(artifactId))]);
}

/**
 * 先写临时文件再 rename，避免读到半份内容；元数据最后落盘，读取方看到元数据时
 * 字节一定已经就位。`putUpload` 与 `putArtifact` 共用。
 */
async function writeArtifact(
  artifactId: string,
  bytes: Buffer,
  mediaType: string,
  now: Date,
): Promise<StoredUpload> {
  await ensureRoot();
  const record: ArtifactRecord = {
    version: 1,
    id: artifactId,
    contentType: mediaType,
    size: bytes.length,
    createdAt: now.toISOString(),
  };
  const tempSuffix = `${process.pid}-${randomUUID()}`;
  const tempData = `${dataPath(artifactId)}.${tempSuffix}.tmp`;
  const tempMeta = `${metaPath(artifactId)}.${tempSuffix}.tmp`;
  try {
    await writeFile(tempData, bytes, { mode: 0o600 });
    await writeFile(tempMeta, JSON.stringify(record), { mode: 0o600 });
    await rename(tempData, dataPath(artifactId));
    await rename(tempMeta, metaPath(artifactId));
  } catch (error) {
    await Promise.allSettled([unlink(tempData), unlink(tempMeta)]);
    throw error;
  }
  return { artifactId, size: bytes.length, createdAt: record.createdAt };
}

/** 存一份手机上传的图（只收 4 种常见图片，≤ 2 MiB）。 */
export async function putUpload(
  artifactId: string,
  bytes: Buffer,
  contentType: string | undefined,
  now: Date = new Date(),
): Promise<StoredUpload> {
  if (!isValidArtifactId(artifactId)) throw new ArtifactError("invalid_id");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ArtifactError("too_large");
  const mediaType = normalizeContentType(contentType);
  if (!ALLOWED_UPLOAD_TYPES.has(mediaType)) throw new ArtifactError("unsupported_type");
  return writeArtifact(artifactId, bytes, mediaType, now);
}

/**
 * 存一份本机取回的文件（`fetchFile`）：图片 / 视频 / PDF，≤ 10 MiB。
 *
 * 与手机上传分开是因为后者只收图片且限制 2 MiB；PDF、视频都要能按原样取回。
 * 产物不进 `Task.artifacts`，读取复用 `getArtifact` 的过期与软链接防护。
 */
export async function putArtifact(
  artifactId: string,
  bytes: Buffer,
  contentType: string | undefined,
  now: Date = new Date(),
): Promise<StoredUpload> {
  if (!isValidArtifactId(artifactId)) throw new ArtifactError("invalid_id");
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new ArtifactError("too_large");
  const mediaType = normalizeContentType(contentType);
  if (!isAllowedArtifactType(mediaType)) throw new ArtifactError("unsupported_type");
  return writeArtifact(artifactId, bytes, mediaType, now);
}

/** 读一份产物；不存在、已过期、损坏或路径不安全都返回 null，并顺手清理过期项。 */
export async function getArtifact(
  artifactId: string,
  now: Date = new Date(),
): Promise<StoredArtifact | null> {
  if (!isValidArtifactId(artifactId)) return null;
  const record = await readRecord(artifactId);
  if (!record) return null;
  if (isExpired(record.createdAt, now)) {
    await removeArtifact(artifactId);
    return null;
  }
  const bytes = await readRegularFile(dataPath(artifactId));
  if (!bytes || bytes.length !== record.size) {
    await removeArtifact(artifactId);
    return null;
  }
  return {
    bytes,
    contentType: record.contentType,
    size: record.size,
    createdAt: record.createdAt,
  };
}

/**
 * 删除 7 天前的产物；幂等。孤儿 `.bin`（元数据丢了）按文件 mtime 一起清掉。
 * 软链接与目录不碰，避免顺着链接删到缓存目录外。
 */
export async function cleanup(now: Date = new Date()): Promise<number> {
  const root = resolve(artifactsDir());
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  const cutoff = now.getTime() - ARTIFACT_TTL_MS;
  const keep = new Set<string>();
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const artifactId = entry.name.slice(0, -".json".length);
    if (!isValidArtifactId(artifactId)) continue;
    const record = await readRecord(artifactId);
    if (!record || isExpired(record.createdAt, now)) {
      await removeArtifact(artifactId);
      removed += 1;
    } else {
      keep.add(artifactId);
    }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;
    const artifactId = entry.name.slice(0, -".bin".length);
    if (!isValidArtifactId(artifactId) || keep.has(artifactId)) continue;
    try {
      const info = await lstat(join(root, entry.name));
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue;
      await unlink(join(root, entry.name));
    } catch {
      // 并发清理或文件已消失；幂等。
    }
  }

  return removed;
}

/**
 * 给连接器解析手机发来的附件：按 artifactId 查本机缓存，返回可读路径与
 * 类型。只暴露 API，不在这里改连接器运行时。
 */
export async function resolveAttachment(
  attachment: { artifactId?: unknown } | null | undefined,
  now: Date = new Date(),
): Promise<{ path: string; contentType: string } | null> {
  const artifactId = attachment?.artifactId;
  if (!isValidArtifactId(artifactId)) return null;
  const record = await readRecord(artifactId);
  if (!record) return null;
  // 产物缓存现在也放视频 / PDF（`fetchFile`），但手机附件仍然只收上传时允许的图片类型。
  if (!ALLOWED_UPLOAD_TYPES.has(record.contentType)) return null;
  if (isExpired(record.createdAt, now)) {
    await removeArtifact(artifactId);
    return null;
  }
  const path = dataPath(artifactId);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== record.size) return null;
  } catch {
    return null;
  }
  return { path, contentType: record.contentType };
}
