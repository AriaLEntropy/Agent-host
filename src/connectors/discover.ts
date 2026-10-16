import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hostDataDir } from "../config.js";
import { belongsToNpmPackage, locateBinary } from "./locate.js";
import { registryEntries, type RegistryEntry } from "./registry.js";

export const MAX_ACP_AGENTS = 10;
export const RESERVED_IDS = new Set([
  "codex",
  "claude",
  "hermes",
  "pi",
  "openclaw",
  "dsh",
  "acp",
  "claude-acp",
  "codex-acp",
  "pi-acp",
]);

const ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export type AgentSpec = {
  id: string;
  kind: "acp" | "dsh";
  name: string;
  executable?: string;
  args: string[];
  env: Record<string, string>;
  origin: "manifest" | "registry" | "dsh";
  available: boolean;
  enabled: boolean;
  lastError?: string;
};

export type ManifestProblem = { file: string; reason: string };

export type DiscoverInput = {
  manifestDir?: string;
  entries?: RegistryEntry[];
  locate?: (name: string) => string | undefined;
  hiddenRegistryIds?: ReadonlySet<string>;
  dshExecutable?: string;
};

export function agentsDir() {
  return join(hostDataDir(), "agents");
}

export async function discoverAgents(input: DiscoverInput = {}): Promise<{
  agents: AgentSpec[];
  problems: ManifestProblem[];
}> {
  const locate = input.locate ?? ((name: string) => locateBinary(name));
  const hidden = input.hiddenRegistryIds ?? new Set<string>();
  const problems: ManifestProblem[] = [];
  const byId = new Map<string, AgentSpec>();

  let files: string[] = [];
  const manifestDir = input.manifestDir ?? agentsDir();
  try {
    files = (await readdir(manifestDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    files = [];
  }
  for (const fileName of files) {
    const file = join(manifestDir, fileName);
    const loaded = await loadManifest(file, fileName, locate);
    if ("problem" in loaded) {
      problems.push(loaded.problem);
      continue;
    }
    if (RESERVED_IDS.has(loaded.spec.id)) {
      problems.push({ file, reason: `id「${loaded.spec.id}」已被占用，换一个` });
      continue;
    }
    byId.set(loaded.spec.id, loaded.spec);
  }

  for (const entry of input.entries ?? registryEntries) {
    if (byId.has(entry.id) || hidden.has(entry.id)) continue;
    const executable = locateEntry(entry, locate);
    if (!executable) continue;
    byId.set(entry.id, {
      id: entry.id,
      kind: "acp",
      name: entry.name,
      executable,
      args: entry.args,
      env: {},
      origin: "registry",
      available: true,
      enabled: true,
    });
  }

  const acp = [...byId.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, MAX_ACP_AGENTS);
  const dshPath = input.dshExecutable === undefined ? locate("dsh") : input.dshExecutable || undefined;
  const dsh: AgentSpec = {
    id: "dsh",
    kind: "dsh",
    name: "DeepSeek Harness",
    executable: dshPath,
    args: ["--profile", "acp"],
    env: {},
    origin: "dsh",
    available: Boolean(dshPath),
    enabled: true,
    lastError: dshPath ? undefined : "dsh is not installed",
  };
  return { agents: [...acp, dsh], problems };
}

function locateEntry(entry: RegistryEntry, locate: (name: string) => string | undefined) {
  if (!entry.npmPackage) return entry.binaries.map(locate).find(Boolean);
  for (const name of entry.binaries) {
    const located = locate(name);
    if (located && belongsToNpmPackage(located, entry.npmPackage)) return located;
  }
  return undefined;
}

async function loadManifest(
  file: string,
  fileName: string,
  locate: (name: string) => string | undefined,
): Promise<{ spec: AgentSpec } | { problem: ManifestProblem }> {
  const problem = (reason: string) => ({ problem: { file, reason } });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return problem("不是合法的清单 JSON（至少要有 id 和 name）");
  }
  const id = parsed.id;
  const name = parsed.name;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return problem("id 只能用小写字母、数字和 -，1 到 32 个字符");
  }
  if (`${id}.json` !== fileName) return problem(`文件名必须是 ${id}.json`);
  if (typeof name !== "string" || !name.trim()) return problem("name 不能为空");
  const command = parsed.command;
  const args = parsed.args;
  const env = parsed.env;
  if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== "string"))) {
    return problem("args 必须是字符串数组");
  }
  if (env !== undefined && !stringRecord(env)) return problem("env 必须是字符串到字符串");
  const displayName = name.trim().slice(0, 40);
  if (command === undefined) {
    return {
      spec: {
        id,
        kind: "acp",
        name: displayName,
        args: (args as string[]) ?? [],
        env: (env as Record<string, string>) ?? {},
        origin: "manifest",
        available: false,
        enabled: true,
        lastError: "没有 command，只能经反向扩展接入，这一期不做",
      },
    };
  }
  if (typeof command !== "string" || !command) return problem("command 必须是字符串");
  const executable = locate(command);
  return {
    spec: {
      id,
      kind: "acp",
      name: displayName,
      executable,
      args: (args as string[]) ?? [],
      env: (env as Record<string, string>) ?? {},
      origin: "manifest",
      available: Boolean(executable),
      enabled: true,
      lastError: executable ? undefined : `找不到 command：${command}`,
    },
  };
}

function stringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}
