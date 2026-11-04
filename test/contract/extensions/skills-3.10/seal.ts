import { createHash, webcrypto } from "node:crypto";

// 只给夹具用的密封工具，规则与上游 `scripts/seal-fixtures.mjs` 一致：
// HKDF-SHA256 派生 AES-GCM 密钥；nonce = SHA256(AAD) 前 12 字节；输出 0x01 ‖ nonce ‖ ct ‖ tag。
// 生产环境的 nonce 必须随机，这里是确定性 nonce，只为了同一份明文每次得到同一份密文。

const { subtle } = webcrypto;

/** 组根密钥 K：0x00 … 0x1f，与 Swift `SealingFixtures` / 上游 TS 测试一致 */
export const FIXTURE_ROOT_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

const CONTENT_INFO = "botbus/v1/content";

function sha256(bytes: Uint8Array) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** HKDF-SHA256，salt 为空，32 字节 */
export async function deriveFixtureKey(info: string = CONTENT_INFO): Promise<Uint8Array> {
  const ikm = await subtle.importKey("raw", FIXTURE_ROOT_KEY, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

function fixtureNonce(aad: string): Uint8Array {
  return sha256(new TextEncoder().encode(aad)).slice(0, 12);
}

/** 与 Swift `ProtocolJSON` 一致的规范 JSON：键排序、无空白 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function commandAad(agentId: string, commandId: string): string {
  return `command:${agentId}:${commandId}`;
}

export async function sealJson(key: Uint8Array, value: unknown, aad: string): Promise<string> {
  const nonce = fixtureNonce(aad);
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(canonical(value));
  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
      k,
      plaintext,
    ),
  );
  const out = new Uint8Array(1 + nonce.length + ciphertext.length);
  out[0] = 0x01;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + nonce.length);
  return encodeBase64Url(out);
}

export async function openSealedJson(key: Uint8Array, text: string, aad: string): Promise<unknown> {
  const bytes = decodeBase64Url(text);
  if (bytes[0] !== 0x01) throw new Error(`unsupported sealed format ${bytes[0]}`);
  const nonce = bytes.slice(1, 13);
  const k = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
    k,
    bytes.slice(13),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
