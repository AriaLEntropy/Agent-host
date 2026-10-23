import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Config = {
  hostId?: string;
  hostToken?: string;
  e2eeMasterKey?: string;
  agentId?: string;
  hostName: string;
  relay: string;
  publicRelayUrl?: string;
  dshPort: number;
};

function defaultPath() {
  const dir =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "agent-host")
      : join(homedir(), ".agent-host");
  return join(dir, "config.json");
}

export function configPath() {
  return process.env.AGENT_HOST_CONFIG ?? defaultPath();
}

export function hostDataDir() {
  return dirname(configPath());
}

export async function loadConfig(): Promise<Config> {
  const base = defaults();
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(await readFile(configPath(), "utf8")) as Partial<Config>;
  } catch {
    saved = {};
  }
  // Environment variables win over the saved file so a one-off run can point
  // at a different Relay without rewriting the persisted pairing config.
  const envRelay = process.env.AGENT_HOST_RELAY?.trim();
  const envPublic = process.env.PUBLIC_RELAY_URL?.trim();
  return {
    ...base,
    ...saved,
    ...(envRelay ? { relay: envRelay } : {}),
    ...(envPublic ? { publicRelayUrl: envPublic } : {}),
  };
}

export class RelayConfigError extends Error {}

/**
 * Local Relay is the only supported deployment (D04/D18): there is no public
 * fallback. Fail before any network call so the operator sees what to set.
 */
export function requireRelayConfig(config: Config, scope: "pair" | "up" | "unpair" = "up"): Config {
  const missing: string[] = [];
  if (!config.relay.trim()) {
    missing.push("AGENT_HOST_RELAY（电脑连 Relay 的地址，例如 http://127.0.0.1:8787）");
  }
  // An already-paired host can start without the QR-facing address; it is only
  // needed when a phone is about to scan a new pairing QR.
  const needsPublicUrl = scope === "pair" || (scope === "up" && !config.hostToken);
  if (needsPublicUrl && !config.publicRelayUrl?.trim()) {
    missing.push("PUBLIC_RELAY_URL（手机可达的局域网地址，例如 http://192.168.1.10:8787）");
  }
  if (missing.length > 0) {
    throw new RelayConfigError(
      [
        "缺少 Relay 配置，已停止启动：",
        ...missing.map((item) => `  - ${item}`),
        `配置方法：设置环境变量，或写入 ${configPath()}。`,
        "首次使用请先在 dsh-scan-remote/relay 启动本地 Relay（HOST=0.0.0.0 PORT=8787）。",
      ].join("\n"),
    );
  }
  if (
    needsPublicUrl &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(config.publicRelayUrl ?? "")
  ) {
    console.warn(
      "警告：PUBLIC_RELAY_URL 指向本机回环地址，手机无法访问。请改成本机的局域网 IP。",
    );
  }
  return config;
}

export async function checkRelayHealth(config: Config, timeoutMs = 3000): Promise<void> {
  const url = `${config.relay.replace(/\/$/, "")}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { ok?: unknown };
    if (body.ok !== true) throw new Error("health 返回非 ok");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RelayConfigError(
      [
        `Relay 不可达：${url}（${detail}）`,
        "请确认：1) dsh-scan-remote/relay 已启动；2) HOST=0.0.0.0 PORT=8787；3) 防火墙放行 8787。",
      ].join("\n"),
    );
  }
}

export async function saveConfig(config: Config) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export function createAgentId(): string {
  return randomBytes(16).toString("base64url");
}

export async function ensureAgentId(config: Config): Promise<Config> {
  if (config.agentId) return config;
  const next = { ...config, agentId: createAgentId() };
  await saveConfig(next);
  return next;
}

export function defaults(): Config {
  return {
    hostName:
      process.env.DSH_DEVICE_NAME ?? `${process.env.USER ?? "User"}'s Computer`,
    relay: process.env.AGENT_HOST_RELAY?.trim() ?? "",
    publicRelayUrl: process.env.PUBLIC_RELAY_URL?.trim(),
    dshPort: Number(process.env.DSH_PORT ?? 3080),
  };
}
