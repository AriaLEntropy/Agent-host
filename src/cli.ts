#!/usr/bin/env node
import { Command } from "commander";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCommandLog, setCommandLogPath } from "./bus/commands.js";
import { loadBusState } from "./bus/persistence.js";
import { busStore, hostPlatform } from "./bus/store.js";
import { discoverAgents, type AgentSpec, type ManifestProblem } from "./connectors/discover.js";
import {
  DEFAULT_CHECK_PROMPT,
  ProbeError,
  formatAgentLine,
  formatAgentProblem,
  probeAcpAgent,
  probeErrorLabel,
  probeExitCode,
} from "./connectors/probe.js";
import {
  flushConnectorSettings,
  refreshAgents,
  startConnectorWatcher,
  stopConnectorWatcher,
} from "./connectors/runtime.js";
import { connectorSettingsPath } from "./connectors/settings-store.js";
import {
  checkRelayHealth,
  ensureAgentId,
  hostDataDir,
  loadConfig,
  requireRelayConfig,
  saveConfig,
} from "./config.js";
import {
  createLogger,
  defaultLogDirectory,
  exportDiagnostics,
  initializeLogging,
  logPublic,
  shutdownLogging,
} from "./platform/log.js";
import { pair } from "./tunnel/pairing.js";
import { RelayClient } from "./tunnel/relay-client.js";
import { PLUGIN_VERSION } from "./tunnel/version.js";

async function prepare() {
  // 日志初始化失败不能挡住启动：文件出口失败时退回 stderr。
  await initializeLogging().catch(() => undefined);
  setCommandLogPath(join(hostDataDir(), "commands.json"));
  await loadCommandLog();
  const config = await ensureAgentId(await loadConfig());
  const statePath = join(hostDataDir(), "bus-state.json");
  busStore.configurePersistence(statePath);
  const state = await loadBusState(statePath);
  if (state) busStore.hydrate(state, config.agentId ?? "");
  busStore.identify({
    agentId: config.agentId ?? "",
    hostName: config.hostName,
    hostVersion: PLUGIN_VERSION,
    platform: hostPlatform(),
  });
  const found = await refreshAgents().catch(() => undefined);
  createLogger("agent-host", "lifecycle").info("host prepared", {
    version: logPublic(PLUGIN_VERSION),
    platform: process.platform,
    agents: found?.agents.length ?? 0,
  });
  return config;
}

export type AgentDiscoveryResult = {
  agents: AgentSpec[];
  problems: ManifestProblem[];
};

export type AgentDiscover = () => Promise<AgentDiscoveryResult>;

export type AgentCheckDeps = {
  discover?: AgentDiscover;
  probe?: typeof probeAcpAgent;
};

/**
 * `agent list`：只读发现结果，不起进程。
 *
 * 逐行输出 id / kind / name / available / lastError；清单问题也打印成
 * `✗ 文件：原因`。按上游约定，列表命令本身总是退出 0（发现异常也只提示）。
 */
export async function runAgentList(deps: { discover?: AgentDiscover } = {}): Promise<number> {
  const discover = deps.discover ?? discoverAgents;
  try {
    const found = await discover();
    for (const agent of found.agents) console.log(formatAgentLine(agent));
    for (const problem of found.problems) console.log(formatAgentProblem(problem));
  } catch (error) {
    console.error(`检测 agent 失败：${messageOf(error)}`);
  }
  return 0;
}

/**
 * `agent check <id> [--prompt <text>]`：启动 ACP agent 跑一轮自查。
 *
 * 退出码：0 成功；1 自查失败（超时 / 拒绝 / 非 end_turn）；2 用法或不可用
 * （id 不存在、不是 ACP、没有可执行文件）；3 需要登录。
 */
export async function runAgentCheck(
  id: string,
  prompt?: string,
  deps: AgentCheckDeps = {},
): Promise<number> {
  const discover = deps.discover ?? discoverAgents;
  const probe = deps.probe ?? probeAcpAgent;

  let found: AgentDiscoveryResult;
  try {
    found = await discover();
  } catch (error) {
    console.error(`检测 agent 失败：${messageOf(error)}`);
    return 1;
  }

  const spec = found.agents.find((agent) => agent.id === id);
  if (!spec) {
    console.error(`找不到 agent：${id}（用 agent list 查看可用项）`);
    return 2;
  }
  if (spec.kind !== "acp" && spec.kind !== "dsh") {
    console.error(`agent ${id} 的类型是 ${spec.kind}，只有 ACP/dsh agent 支持 check`);
    return 2;
  }
  if (!spec.available || !spec.executable) {
    console.error(`agent ${id} 不可用：${spec.lastError ?? "找不到可执行文件"}`);
    return 2;
  }

  const text = prompt ?? DEFAULT_CHECK_PROMPT;
  console.log(`agent: ${spec.id} (${spec.name})`);
  console.log(`command: ${[spec.executable, ...spec.args].join(" ").trim()}`);

  try {
    const result = await probe(spec, text);
    console.log(`initialize: ok（protocolVersion=${result.protocolVersion}）`);
    console.log(
      `capabilities: loadSession=${result.capabilities.loadSession} resume=${result.capabilities.resume} image=${result.capabilities.image} session/list=${result.capabilities.listSessions}`,
    );
    console.log(`session/new: ok (${result.sessionId})`);
    console.log(`session/prompt: stopReason=${result.stopReason ?? "unknown"}`);
    for (const tool of result.toolCalls) console.log(`tool: ${tool.title || "(未命名)"}`);
    console.log(`agent: ${result.agentText || "(空)"}`);
    return result.stopReason === "end_turn" ? 0 : 1;
  } catch (error) {
    if (error instanceof ProbeError) {
      console.error(`${probeErrorLabel(error)}: ${error.message}`);
      return probeExitCode(error);
    }
    console.error(messageOf(error));
    return 1;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const program = new Command()
  .name("agent-host")
  .description("Pair a phone with this computer over the sealed tunnel")
  .version(PLUGIN_VERSION);

program
  .command("pair")
  .description("Print a pairing QR and wait for the phone")
  .action(async () => {
    const config = requireRelayConfig(await prepare(), "pair");
    await checkRelayHealth(config);
    await pair(config);
  });

program
  .command("up")
  .description("Run in the foreground and connect to Relay")
  .action(async () => {
    let config = requireRelayConfig(await prepare(), "up");
    await checkRelayHealth(config);
    if (!config.hostToken) config = await pair(config);
    const client = new RelayClient(config, {
      onAuthRejected: (detail) => {
        console.error(
          `This computer is no longer paired (${detail}). Run "npm run dev -- pair" (or "npm start -- pair") and scan the QR again.`,
        );
        process.exit(1);
      },
    });
    await client.start();
    // 清单增删改后自动重新发现 agent；失败只记日志，不影响隧道。
    await startConnectorWatcher();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        stopConnectorWatcher();
        await flushConnectorSettings();
        await busStore.flushPersistence();
        await shutdownLogging();
      } finally {
        client.stop();
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  });

program
  .command("unpair")
  .description("Revoke this computer and delete the local device credential")
  .action(async () => {
    const config = requireRelayConfig(await prepare(), "unpair");
    if (config.hostId && config.hostToken) {
      const response = await fetch(
        `${config.relay}/host-management/${encodeURIComponent(config.hostId)}/unbind`,
        {
          method: "POST",
          headers: { authorization: `Host ${config.hostToken}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new Error(`Relay rejected unpair (${response.status})`);
    }
    await saveConfig({
      hostName: config.hostName,
      relay: config.relay,
      publicRelayUrl: config.publicRelayUrl,
      dshPort: config.dshPort,
      agentId: config.agentId,
    });
    console.log("Pairing removed");
  });

const logsCommand = program
  .command("logs")
  .description("Inspect or export the local log files");

logsCommand
  .command("path")
  .description("Print the local log directory")
  .action(() => {
    console.log(defaultLogDirectory());
  });

logsCommand
  .command("export")
  .description("Write a diagnostic bundle (logs + config without credentials)")
  .option("--out <path>", "write the tar.gz to this path instead of the data directory")
  .action(async (options: { out?: string }) => {
    const config = await prepare();
    const out = await exportDiagnostics({
      config,
      outPath: options.out ? resolve(options.out) : undefined,
      extraFiles: [{ name: "connector-settings.json", path: connectorSettingsPath() }],
    });
    await shutdownLogging();
    console.log(`Diagnostics written to ${out}`);
  });

const agentCommand = program
  .command("agent")
  .description("Inspect local agents and run an ACP self-check");

agentCommand
  .command("list")
  .description("List discovered agents (id, kind, name, available, lastError)")
  .action(async () => {
    process.exitCode = await runAgentList();
  });

agentCommand
  .command("check <id>")
  .description("Start an ACP agent and run initialize + prompt")
  .option("--prompt <text>", "prompt sent to the agent", DEFAULT_CHECK_PROMPT)
  .action(async (id: string, options: { prompt?: string }) => {
    process.exitCode = await runAgentCheck(id, options.prompt);
  });

// 只在作为入口脚本运行时解析参数；测试可以直接 import runAgentList / runAgentCheck。
const isEntryPoint = (() => {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(script)).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  program.parseAsync().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
