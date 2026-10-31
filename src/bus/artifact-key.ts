/**
 * 对话图片产物的本机密钥（FR-14.5.1）。
 *
 * 图片 id 不能用随机数：同一份对话每次拉取都要得到同一个 `artifactId`，手机才能
 * 按 id 缓存、去重。这里用一枚只在本机保存的随机密钥对「会话 + 消息 + 图片来源」
 * 做 HMAC-SHA256，取前 16 字节转成协议要求的 22 字符 base64url。id 与原始路径
 * 没有可逆关系，换一台机器或重新生成密钥后旧 id 也不会对上。
 *
 * 密钥落在 `hostDataDir()/artifact-key`（%APPDATA%\agent-host 下，不进公共目录），
 * 权限 0600；测试用 `setArtifactKeyPath` 指到临时目录，绝不碰真实用户目录。
 */
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hostDataDir } from "../config.js";

const KEY_BYTES = 32;

let keyPathOverride: string | undefined;
let cachedKey: Buffer | undefined;
let loading: Promise<Buffer> | undefined;

/** 测试注入点。传 `undefined` 恢复 `hostDataDir()/artifact-key` 并丢掉内存缓存。 */
export function setArtifactKeyPath(path: string | undefined) {
  keyPathOverride = path === undefined ? undefined : resolve(path);
  cachedKey = undefined;
  loading = undefined;
}

export function artifactKeyPath(): string {
  return keyPathOverride ?? join(hostDataDir(), "artifact-key");
}

async function readKey(): Promise<Buffer | undefined> {
  try {
    const bytes = await readFile(artifactKeyPath());
    return bytes.length === KEY_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 先写临时文件再 rename：读取方要么看到没有密钥，要么看到完整 32 字节，
 * 不会用半份密钥算出对不上的 id。两个进程同时首次生成时后到的覆盖前者，
 * 只会让早先算出的 id 失效——本机单进程运行时不会发生。
 */
async function createKey(): Promise<Buffer> {
  const path = artifactKeyPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const temp = `${path}.${process.pid}-${randomBytes(6).toString("base64url")}.tmp`;
  try {
    await writeFile(temp, key, { mode: 0o600 });
    try {
      await chmod(temp, 0o600);
    } catch {
      // 不是所有文件系统都支持 chmod；父目录已按用户隔离。
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    const existing = await readKey();
    if (existing) return existing;
    throw error;
  }
  return key;
}

/** 读本机密钥，没有就生成一份。并发调用共用同一次加载。 */
export async function artifactKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  if (!loading) {
    loading = (async () => {
      const key = (await readKey()) ?? (await createKey());
      cachedKey = key;
      loading = undefined;
      return key;
    })();
  }
  return loading;
}

/**
 * 一张图的稳定产物 id。`sourceKey` 是来源的稳定描述：本机文件用路径，
 * inline 图片用内容哈希（见 `conversation-images.ts`）。
 */
export async function stableArtifactId(
  taskId: string,
  messageId: string,
  sourceKey: string,
): Promise<string> {
  const key = await artifactKey();
  const digest = createHmac("sha256", key)
    .update(`${taskId}\0${messageId}\0${sourceKey}`)
    .digest();
  return digest.subarray(0, 16).toString("base64url");
}
