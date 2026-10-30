/**
 * 从 `openclaw.json` 读出连 Gateway 需要的三样东西：端口、共享密钥、默认工作区。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/OpenClaw/OpenClawConfig.swift
 * and the OpenClawPaths section of
 * botbus-protocol/Sources/BotBusConnectorKit/AgentPaths.swift (Apache-2.0).
 * Behaviour-preserving TypeScript port for Agent-host.
 *
 * 规则照 OpenClaw 自己的解析：
 * - 端口：环境变量 `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 18789；
 * - 密钥：`gateway.auth.token` / `gateway.auth.password`，缺了再看
 *   `OPENCLAW_GATEWAY_TOKEN` / `_PASSWORD`；两个都有就都带上；
 *   SecretRef（对象形式）解不了，当作没有；
 * - 工作区：`agents.defaults.workspace`，缺省 `<状态目录>/workspace`。
 *
 * 密钥绝不进日志：`toString()` 把它们打码。
 *
 * PORT: 上游默认状态目录是 `~/.openclaw`。路径可以注入（`OpenClawConfig.load({ paths })`），
 * 测试只用临时目录；不传时才读用户的真实目录，与桌面 app 的行为一致。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseJson5 } from "./json5.js";
import { isRecord, trimmedNonEmpty } from "./values.js";

export const OPENCLAW_DEFAULT_GATEWAY_PORT = 18789;

export type OpenClawPaths = {
  stateDirectory: string;
  configFile: string;
};

export function openClawPaths(
  stateDirectory: string = process.env.AGENT_HOST_OPENCLAW_HOME?.trim() || join(homedir(), ".openclaw"),
): OpenClawPaths {
  return {
    stateDirectory,
    configFile: join(stateDirectory, "openclaw.json"),
  };
}

export function defaultWorkspaceDirectory(stateDirectory: string): string {
  return join(stateDirectory, "workspace");
}

export type OpenClawConfigInit = {
  port?: number;
  token?: string;
  password?: string;
  workspaceDirectory?: string;
};

export type OpenClawLoadOptions = {
  paths?: OpenClawPaths;
  stateDirectory?: string;
  environment?: Record<string, string | undefined>;
};

export type OpenClawParseOptions = {
  stateDirectory?: string;
  environment?: Record<string, string | undefined>;
};

export class OpenClawConfig {
  port: number;
  token?: string;
  password?: string;
  /** 会话没报工作目录时拿它当项目路径。 */
  workspaceDirectory: string;

  constructor(init: OpenClawConfigInit = {}) {
    this.port = init.port ?? OPENCLAW_DEFAULT_GATEWAY_PORT;
    this.token = init.token;
    this.password = init.password;
    this.workspaceDirectory =
      init.workspaceDirectory ?? defaultWorkspaceDirectory(openClawPaths().stateDirectory);
  }

  /**
   * 只连回环：Gateway 对「本机 + 共享密钥 + backend 客户端」免设备签名，
   * 换成局域网地址就不成立了。
   */
  get gatewayURL(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get displayAddress(): string {
    return `127.0.0.1:${this.port}`;
  }

  static defaultWorkspace(stateDirectory: string): string {
    return defaultWorkspaceDirectory(stateDirectory);
  }

  /** 读配置文件；文件不存在或解析不了都给默认值。 */
  static load(options: OpenClawLoadOptions = {}): OpenClawConfig {
    const paths = options.paths ?? openClawPaths(options.stateDirectory);
    let text = "";
    try {
      text = readFileSync(paths.configFile, "utf8");
    } catch {
      text = "";
    }
    return OpenClawConfig.parse(text, {
      stateDirectory: paths.stateDirectory,
      environment: options.environment ?? process.env,
    });
  }

  /** 纯函数版本，测试直接喂文本。 */
  static parse(text: string, options: OpenClawParseOptions = {}): OpenClawConfig {
    const stateDirectory = options.stateDirectory ?? openClawPaths().stateDirectory;
    const environment = options.environment ?? {};
    const config = new OpenClawConfig({
      workspaceDirectory: defaultWorkspaceDirectory(stateDirectory),
    });
    const root = parseObject(text);
    const gateway = asRecord(root?.["gateway"]);
    const auth = asRecord(gateway?.["auth"]);

    const environmentPort = portValue(environment["OPENCLAW_GATEWAY_PORT"]);
    const configPort = portValue(gateway?.["port"]);
    if (environmentPort !== undefined) config.port = environmentPort;
    else if (configPort !== undefined) config.port = configPort;

    config.token =
      secret(auth?.["token"], environment) ?? nonEmpty(environment["OPENCLAW_GATEWAY_TOKEN"]);
    config.password =
      secret(auth?.["password"], environment) ??
      nonEmpty(environment["OPENCLAW_GATEWAY_PASSWORD"]);

    const defaults = asRecord(asRecord(root?.["agents"])?.["defaults"]);
    const workspace = nonEmpty(defaults?.["workspace"]);
    if (workspace !== undefined) config.workspaceDirectory = expandTilde(workspace);
    return config;
  }

  /** 打码：密钥只报「有没有」，别让一句日志把 token 写出去。 */
  toString(): string {
    const token = this.token === undefined ? "nil" : "<redacted>";
    const password = this.password === undefined ? "nil" : "<redacted>";
    return `OpenClawConfig(port: ${this.port}, token: ${token}, password: ${password}, workspace: ${this.workspaceDirectory})`;
  }
}

/**
 * 端口可能写成数字，也可能写成字符串（环境变量总是字符串）；超出 1...65535 的不认。
 * 对应 `OpenClawConfig.portValue`。
 */
export function portValue(raw: unknown): number | undefined {
  let number: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    number = Math.trunc(raw);
  } else if (typeof raw === "string") {
    const text = raw.trim();
    if (/^[+-]?\d+$/.test(text)) number = Number.parseInt(text, 10);
  }
  if (number === undefined || number < 1 || number > 65535) return undefined;
  return number;
}

/**
 * 密钥只认字符串。整串是 `${NAME}` 的按 OpenClaw 的环境变量替换规则展开；
 * SecretRef 对象解不了，给 undefined。
 */
export function secret(
  raw: unknown,
  environment: Record<string, string | undefined> = {},
): string | undefined {
  const text = nonEmpty(raw);
  if (text === undefined) return undefined;
  if (text.startsWith("${") && text.endsWith("}") && text.length > 3) {
    const name = text.slice(2, -1);
    return nonEmpty(environment[name]);
  }
  return text;
}

export function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return trimmedNonEmpty(value);
}

/** `NSString.expandingTildeInPath` 的常用部分：`~` 与 `~/` / `~\`。 */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const value = parseJson5(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
