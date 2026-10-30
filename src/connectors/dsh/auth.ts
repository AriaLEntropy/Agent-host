import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DshPaths } from "./paths.js";

/**
 * `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session` 的签名密钥。
 *
 * 只读这一个键；同文件里的 API key 引用一概不碰。密钥只留在内存里，
 * 不打日志、不进错误文案。
 */
export const BROWSER_SESSION_RECORD = "client-connection/browser-session";
export const SECRET_BYTES = 32;

export async function loadBrowserSessionSecret(paths: DshPaths): Promise<Buffer | null> {
  try {
    return browserSessionSecret(await readFile(paths.credentialsFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 最小 YAML 读法，照 `DshWebAuth.swift`：
 * 按缩进找 `client-connection/browser-session:` → 它下面的 `payload:` → 再下面的 `secret:`。
 * 块状映射、值不跨行；流式 `{}`、多行值不认。
 */
export function browserSessionSecret(yaml: string): Buffer | null {
  let phase = 0;
  let recordIndent = 0;
  let payloadIndent = 0;
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const pair = keyValue(trimmed);
    if (!pair) continue;
    const [key, value] = pair;
    const indent = line.length - line.trimStart().length;
    if (phase === 2 && indent <= payloadIndent) phase = 1;
    if (phase >= 1 && indent <= recordIndent) phase = 0;
    if (phase === 0) {
      if (key === BROWSER_SESSION_RECORD && value === "") {
        recordIndent = indent;
        phase = 1;
      }
    } else if (phase === 1) {
      if (key === "payload" && value === "") {
        payloadIndent = indent;
        phase = 2;
      }
    } else if (key === "secret") {
      const decoded = decodeBase64Url(value);
      return decoded?.length === SECRET_BYTES ? decoded : null;
    }
  }
  return null;
}

function keyValue(line: string): [string, string] | null {
  let key: string;
  let rest: string;
  const quote = line[0];
  if (quote === '"' || quote === "'") {
    const close = line.indexOf(quote, 1);
    if (close < 0) return null;
    key = line.slice(1, close);
    rest = line.slice(close + 1);
    if (rest[0] !== ":") return null;
    rest = rest.slice(1);
  } else {
    const colon = line.indexOf(":");
    if (colon < 0) return null;
    key = line.slice(0, colon);
    rest = line.slice(colon + 1);
  }
  let value = rest.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1);
  }
  return [key.trim(), value];
}

/** DSH 的 cookie 名：`dsh-auth-<b64url(sha256(authority))>`。 */
export function cookieName(authority: string): string {
  return `dsh-auth-${base64Url(createHash("sha256").update(authority).digest())}`;
}

/**
 * DSH 的 cookie 值：`v1.<body>.<sig>`。
 * body = b64url(JSON{version:1, authority, issuedAt, expiresAt})，毫秒时间。
 * sig = b64url(HMAC-SHA256(secret, body))。
 */
export function cookieValue(secret: Buffer, authority: string, issuedAtMs: number, expiresAtMs: number): string {
  const body = base64Url(
    Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: issuedAtMs, expiresAt: expiresAtMs }), "utf8"),
  );
  const signature = base64Url(createHmac("sha256", secret).update(body).digest());
  return `v1.${body}.${signature}`;
}

/** 整条 `Cookie` 请求头的值；默认签一小时，issuedAt 往前拨 5 秒防时钟抖动。 */
export function cookieHeader(
  secret: Buffer,
  authority: string,
  nowMs = Date.now(),
  lifetimeMs = 3_600_000,
): string {
  const issuedAt = Math.floor(nowMs - 5_000);
  return `${cookieName(authority)}=${cookieValue(secret, authority, issuedAt, issuedAt + lifetimeMs)}`;
}

export function base64Url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(text: string): Buffer | null {
  if (!text || text.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const decoded = Buffer.from(text, "base64url");
  return base64Url(decoded) === text ? decoded : null;
}
