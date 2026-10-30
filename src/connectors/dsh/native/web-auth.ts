// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshWebAuth.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export type DshAuthPaths = { credentialsFile: string };

/**
 * `dsh web` 的浏览器会话签名密钥（`~/.dsh/.credentials.yaml` 的
 * `records["client-connection/browser-session"].payload.secret`，base64url，32 字节）。
 *
 * **只读这一个键**：同一文件里还有 API key 的引用（`refs`），一概不碰、不解析。
 * 密钥只留在内存里，不打日志、不进错误文案、不写盘。
 */
export const DshWebCredentials = {
  recordKey: "client-connection/browser-session",
  secretBytes: 32,

  /** 读文件并取出密钥。文件不在、读不了、格式不对都返回 null。 */
  loadBrowserSessionSecret(paths: DshAuthPaths): Buffer | null {
    let data: string;
    try {
      data = readFileSync(paths.credentialsFile, "utf8");
    } catch {
      return null;
    }
    return DshWebCredentials.browserSessionSecret(data);
  },

  /**
   * 最小的 YAML 读法：按缩进找 `client-connection/browser-session:` → 它下面的 `payload:` →
   * 再下面的 `secret:`。块状映射、值不跨行；键名与值可以带引号。
   * 解出来必须是规范的 base64url（不带 `=`、重新编码与原文一致）且恰好 32 字节。
   */
  browserSessionSecret(yaml: string): Buffer | null {
    // 0 = 找记录；1 = 在记录里找 `payload:`；2 = 在 payload 里找 `secret:`。
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
        if (key === DshWebCredentials.recordKey && value === "") {
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
        return decoded && decoded.length === DshWebCredentials.secretBytes ? decoded : null;
      }
    }
    return null;
  },
};

/** `key: value` → (去引号的键, 去引号的值)；没有冒号的行返回 undefined。 */
function keyValue(line: string): [string, string] | undefined {
  let key: string;
  let rest: string;
  const quote = line[0];
  if (quote === '"' || quote === "'") {
    const close = line.indexOf(quote, 1);
    if (close < 0) return undefined;
    key = line.slice(1, close);
    rest = line.slice(close + 1);
    if (rest[0] !== ":") return undefined;
    rest = rest.slice(1);
  } else {
    const colon = line.indexOf(":");
    if (colon < 0) return undefined;
    key = line.slice(0, colon);
    rest = line.slice(colon + 1);
  }
  let value = rest.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1);
  }
  return [key.trim(), value];
}

/**
 * 自签 `dsh web` 的浏览器 cookie：
 * - 名字：`dsh-auth-<b64url(sha256(authority))>`；
 * - 值：`v1.<body>.<sig>`，`body = b64url(JSON{version:1, authority, issuedAt, expiresAt})`（毫秒），
 *   `sig = b64url(HMAC-SHA256(secret, body))`。
 */
const DEFAULT_COOKIE_LIFETIME_SECONDS = 3600;

export const DshWebCookie = {
  defaultLifetime: DEFAULT_COOKIE_LIFETIME_SECONDS,
  clockSkew: 5,

  name(authority: string): string {
    return "dsh-auth-" + base64Url(createHash("sha256").update(Buffer.from(authority, "utf8")).digest());
  },

  /** 签名用的明文：键序固定（dsh 只验签名，固定下来是为了测试向量稳定）。 */
  body(authority: string, issuedAtMs: number, expiresAtMs: number): string {
    const authorityJson = JSON.stringify(authority);
    const json = `{"version":1,"authority":${authorityJson},"issuedAt":${issuedAtMs},"expiresAt":${expiresAtMs}}`;
    return base64Url(Buffer.from(json, "utf8"));
  },

  value(secret: Buffer, authority: string, issuedAtMs: number, expiresAtMs: number): string {
    const body = DshWebCookie.body(authority, issuedAtMs, expiresAtMs);
    const signature = createHmac("sha256", secret).update(body).digest();
    return `v1.${body}.${base64Url(signature)}`;
  },

  /**
   * 整条 `Cookie` 请求头的值：`<name>=<value>`。默认签一小时，`issuedAt` 往前拨 5 秒防时钟抖动。
   * `lifetime` 与上游一样以**秒**计。
   */
  header(
    secret: Buffer,
    authority: string,
    now: Date = new Date(),
    lifetime: number = DEFAULT_COOKIE_LIFETIME_SECONDS,
  ): string {
    const issued = Math.floor((now.getTime() - DshWebCookie.clockSkew * 1000));
    const expires = issued + lifetime * 1000;
    return `${DshWebCookie.name(authority)}=${DshWebCookie.value(secret, authority, issued, expires)}`;
  },
};

/** 不带 `=` 的 base64url。 */
export function base64Url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** 解码只认规范写法（同 dsh 的 `decodeBase64Url`）。 */
export function decodeBase64Url(text: string): Buffer | null {
  if (!text || text.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  base64 += "=".repeat((4 - (base64.length % 4)) % 4);
  const data = Buffer.from(base64, "base64");
  return base64Url(data) === text ? data : null;
}

/** 旧的扁平 API（现有 Agent-host 的 dsh/auth.ts 风格），保持不变方便调用。 */
export function cookieName(authority: string): string {
  return DshWebCookie.name(authority);
}

export function cookieValue(secret: Buffer, authority: string, issuedAtMs: number, expiresAtMs: number): string {
  return DshWebCookie.value(secret, authority, issuedAtMs, expiresAtMs);
}

export function cookieHeader(secret: Buffer, authority: string, nowMs = Date.now(), lifetimeMs = 3_600_000): string {
  return DshWebCookie.header(secret, authority, new Date(nowMs), lifetimeMs / 1000);
}

export function loadBrowserSessionSecret(paths: DshAuthPaths): Buffer | null {
  return DshWebCredentials.loadBrowserSessionSecret(paths);
}

export function browserSessionSecret(yaml: string): Buffer | null {
  return DshWebCredentials.browserSessionSecret(yaml);
}
