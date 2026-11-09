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
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { hostDataDir } from "../config.js";
import { readRegularFile as readRegularFileByHandle } from "../platform/file-readability.js";

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
/**
 * 中间 `.tmp` 文件的容忍年龄：一次 PUT 正常在几秒内 rename 完，留在盘上的
 * 是崩在半路（进程被杀、磁盘满）的孤儿。比产物本身短得多，否则缓存目录会
 * 只涨不消。
 */
export const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
/** 协议：Agent 生成的 22 字符 base64url（16 随机字节）。 */
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** 手机上传的图片类型；SVG 等可执行/可嵌入脚本的类型一律拒绝。 */
export const ALLOWED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * 手机上传的普通文件类型（FR-9.1 文件附件）。
 *
 * 只收常见文档，不收可执行文件/脚本/HTML；文件交给 Agent 读取时按本地路径，
 * 最多 2 MiB（与阶段一隧道请求上限一致）。
 */
export const ALLOWED_UPLOAD_FILE_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/zip",
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

/**
 * 按字节头认图片类型；认不出返回 null。
 *
 * 手机上传的 `Content-Type` 是客户端自己写的，只按声明收等于让一个自称
 * `image/png` 的文本进缓存，等到连接器真去读图时才炸——那时已经说不清是谁的问题。
 * 所以上传要先过这一道；返回哪种图片只用于「是不是图片」，不与声明逐一对齐。
 */
export function sniffUploadType(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const magic = bytes.subarray(0, 6).toString("latin1");
    if (magic === "GIF89a" || magic === "GIF87a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export type ArtifactErrorCode = "invalid_id" | "invalid_name" | "too_large" | "unsupported_type";

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
  /** 手机上传时的原文件名；普通文件附件必填，图片可空。 */
  title?: string;
  /** 手机上传的图片 / 普通文件；本机取回的产物可省略。 */
  kind?: "image" | "file";
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
  return readRegularFileByHandle(path, MAX_ARTIFACT_BYTES);
}

async function readRecord(artifactId: string): Promise<ArtifactRecord | null> {
  if (!isValidArtifactId(artifactId)) return null;
  const bytes = await readRegularFile(metaPath(artifactId));
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<ArtifactRecord>;
    if (parsed.version !== 1 || parsed.id !== artifactId) return null;
    if (typeof parsed.contentType !== "string") return null;
    const kind = parsed.kind === "file" ? "file" : parsed.kind === "image" ? "image" : undefined;
    const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : undefined;
    // 元数据读取接受对话取回的媒体类型（图片 / 视频 / PDF）；手机上传的图片仍由
    // `resolveAttachment` 的图片名单把守。手机上传的普通文件靠 kind + title 识别，
    // contentType 可能是 docx/xlsx 这类不在 `isAllowedArtifactType` 里的文档。
    if (!isAllowedArtifactType(parsed.contentType) && !(kind === "file" && title)) return null;
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
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
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
  extra: { title?: string; kind?: "image" | "file" } = {},
): Promise<StoredUpload> {
  await ensureRoot();
  const record: ArtifactRecord = {
    version: 1,
    id: artifactId,
    contentType: mediaType,
    size: bytes.length,
    createdAt: now.toISOString(),
    ...(extra.title ? { title: extra.title } : {}),
    ...(extra.kind ? { kind: extra.kind } : {}),
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

/** 文件名只保留最后一段，去掉路径分隔符和控制字符，限 120 字。 */
export function sanitizeUploadName(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || undefined;
}

/**
 * 存一份手机上传的附件（图片 4 种，≤ 2 MiB；普通文件走文档名单，≤ 2 MiB）。
 *
 * 图片仍要过字节头嗅探；普通文件只信 Content-Type + 文件名，交给 Agent 时按
 * 本机路径读取，不当作图片内容块。
 */
export async function putUpload(
  artifactId: string,
  bytes: Buffer,
  contentType: string | undefined,
  now: Date = new Date(),
  filename?: string,
): Promise<StoredUpload> {
  if (!isValidArtifactId(artifactId)) throw new ArtifactError("invalid_id");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ArtifactError("too_large");
  const mediaType = normalizeContentType(contentType);
  const title = sanitizeUploadName(filename);
  if (ALLOWED_UPLOAD_TYPES.has(mediaType)) {
    // 声明在这四项里还不够，字节头也得真是图片：自称 `image/png` 的文本进了缓存，
    // 要等连接器读图才炸，那时已经说不清是谁的问题。空字节同样拒。
    if (sniffUploadType(bytes) === null) throw new ArtifactError("unsupported_type");
    return writeArtifact(artifactId, bytes, mediaType, now, {
      ...(title ? { title } : {}),
      kind: "image",
    });
  }
  if (!ALLOWED_UPLOAD_FILE_TYPES.has(mediaType)) throw new ArtifactError("unsupported_type");
  if (!title) throw new ArtifactError("invalid_name");
  return writeArtifact(artifactId, bytes, mediaType, now, { title, kind: "file" });
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

  await cleanupTempFiles(root, now);

  return removed;
}

/**
 * 清掉写一半就断掉的中间 `.tmp`；`cleanup` 每轮都会带上它。
 *
 * 单独导出是为了测试和手动触发。只碰这个目录里的普通文件：软链接、目录，
 * 以及名字里带 `.tmp` 但不是 `<id>.<pid>-<uuid>.tmp` 形状的东西都不删——
 * 宁可留一个孤儿文件，也不要顺着别人的文件名删到别处。
 */
export async function cleanupTempFiles(
  root: string = resolve(artifactsDir()),
  now: Date = new Date(),
): Promise<number> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  const oldestAllowed = now.getTime() - TEMP_FILE_MAX_AGE_MS;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !TEMP_FILE_NAME_PATTERN.test(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > oldestAllowed) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // 并发清理或文件已消失；幂等。
    }
  }
  return removed;
}

/** `writeArtifact` 用的中间文件名：`<22 位 id>.<pid>-<uuid>.tmp` */
const TEMP_FILE_NAME_PATTERN =
  /^[A-Za-z0-9_-]{22}\.\d+-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.tmp$/;

/**
 * 给连接器解析手机发来的附件：按 artifactId 查本机缓存，返回可读路径与
 * 类型。只暴露 API，不在这里改连接器运行时。
 */
export async function resolveAttachment(
  attachment: { artifactId?: unknown } | null | undefined,
  now: Date = new Date(),
): Promise<{ path: string; contentType: string; title?: string; kind?: "image" | "file" } | null> {
  const artifactId = attachment?.artifactId;
  if (!isValidArtifactId(artifactId)) return null;
  const record = await readRecord(artifactId);
  if (!record) return null;
  // 产物缓存现在也放视频 / PDF（`fetchFile`）；手机附件只认上传时记录的图片或文件。
  const isImage = ALLOWED_UPLOAD_TYPES.has(record.contentType);
  const isFile = record.kind === "file" && Boolean(record.title);
  if (!isImage && !isFile) return null;
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
  return {
    path,
    contentType: record.contentType,
    ...(record.title ? { title: record.title } : {}),
    kind: isFile ? "file" : "image",
  };
}
