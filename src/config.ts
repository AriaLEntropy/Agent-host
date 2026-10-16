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
  try {
    return {
      ...defaults(),
      ...JSON.parse(await readFile(configPath(), "utf8")),
    };
  } catch {
    return defaults();
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
    relay: process.env.AGENT_HOST_RELAY ?? "https://relay.dshmobile.online",
    publicRelayUrl: process.env.PUBLIC_RELAY_URL,
    dshPort: Number(process.env.DSH_PORT ?? 3080),
  };
}
