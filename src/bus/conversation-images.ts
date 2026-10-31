/**
 * 对话里的图片 → 本机产物（FR-14.5.1）。
 *
 * 读取器只负责找到图片（`ImageSource` 指向本机文件或 inline base64），这里负责：
 * 读字节、按图片内容确认类型、用稳定 id 写进产物目录，最后给出协议里的
 * `MessageAttachment`。它不碰连接器运行时，方便单测。
 *
 * id 的稳定性由 `artifact-key.ts` 的 HMAC 保证：同一会话、同一条消息、同一个来源
 * 每次算出来一样；id 里看不出原始路径。产物已存在且大小一致时不再重写。
 *
 * 这里同步写完产物再外发，所以没有上游「先发占位、传完再补图」的阶段；只有
 * 图片此刻读不到（文件被删、类型不认识）时跳过这一张，调用方再按内容判空。
 */
import { createHash } from "node:crypto";
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_ARTIFACT_BYTES,
  getArtifact,
  normalizeContentType,
  putArtifact,
} from "./artifacts.js";
import { stableArtifactId } from "./artifact-key.js";
import type { BusMessageAttachment } from "./store.js";
import type { ImageSource } from "../connectors/ported/contract.js";
import { readFileByHandle } from "../platform/file-readability.js";

/** 协议 2.9：一条消息最多 4 张图。 */
export const MAX_MESSAGE_IMAGE_ATTACHMENTS = 4;

type ResolvedImage = { bytes: Buffer; contentType: string; sourceKey: string };

function ascii(bytes: Buffer, start: number, end: number): string {
  return start >= 0 && end <= bytes.length ? bytes.toString("latin1", start, end) : "";
}

/**
 * 按文件头确认图片类型。只认手机上传允许的 4 种：产物会被原样发给手机，
 * SVG 这类可嵌入脚本的内容即使自称 `image/*` 也不收。
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes);
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  const header = ascii(data, 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

async function resolveImage(source: ImageSource): Promise<ResolvedImage | undefined> {
  if (source.type === "file") {
    let bytes: Buffer;
    try {
      bytes = await readFileByHandle(source.path, { maxBytes: MAX_ARTIFACT_BYTES });
    } catch {
      // 文件被删、被换成软链接或读不了：这张图这次不可用，读取器不替它判断。
      return undefined;
    }
    const contentType = sniffImageType(bytes);
    if (!contentType) return undefined;
    return { bytes, contentType, sourceKey: `file:${source.path}` };
  }

  const bytes = Buffer.from(source.data);
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) return undefined;
  const contentType = normalizeContentType(source.contentType);
  if (!ALLOWED_UPLOAD_TYPES.has(contentType)) return undefined;
  // inline 图片没有路径：用内容哈希当来源描述，同一张图仍然得到同一个 id。
  const digest = createHash("sha256").update(bytes).digest("base64url");
  return { bytes, contentType, sourceKey: `data:${contentType}:${digest}` };
}

/**
 * 把一条消息的图片写进产物目录，返回最多 4 个附件。
 *
 * 任何一张读不到、类型不认识或写盘失败都跳过这一张，不影响其余图片与文字；
 * 调用方在消息完全没有可见内容时再把整条丢掉。
 */
export async function imagesForMessage(
  taskId: string,
  messageId: string,
  sources: readonly ImageSource[],
): Promise<BusMessageAttachment[]> {
  const attachments: BusMessageAttachment[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (attachments.length >= MAX_MESSAGE_IMAGE_ATTACHMENTS) break;
    const image = await resolveImage(source);
    if (!image) continue;
    let artifactId: string;
    try {
      artifactId = await stableArtifactId(taskId, messageId, image.sourceKey);
    } catch {
      // 本机密钥建不出来（目录不可写等）：宁可少一张图，也不让整份对话失败。
      continue;
    }
    if (seen.has(artifactId)) continue;
    seen.add(artifactId);
    try {
      const existing = await getArtifact(artifactId);
      // 同一个 id 已经有一份大小一致的产物就复用；路径内容变了才重写。
      if (!existing || existing.size !== image.bytes.length || existing.contentType !== image.contentType) {
        await putArtifact(artifactId, image.bytes, image.contentType);
      }
    } catch {
      continue;
    }
    attachments.push({
      artifactId,
      contentType: image.contentType,
      size: image.bytes.length,
    });
  }
  return attachments;
}
