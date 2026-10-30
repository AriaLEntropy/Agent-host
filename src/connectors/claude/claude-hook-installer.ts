// Ported from botbus-protocol/Sources/BotBusConnectors/Claude/ClaudeHookInstaller.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ClaudePaths } from "./claude-hooks.js";
import { claudeHookKinds, type ClaudeHookKind } from "./claude-hooks.js";
import { LocalHookServer } from "./local-hook-server.js";
import { sortedJsonPretty } from "./claude-shared.js";

type Settings = Record<string, unknown>;

/**
 * 把 BotBus 的 hook 条目并进 `settings.json`，以及原样撤回。
 *
 * 三条纪律：写之前整份备份；只认领带 `marker` 的条目；幂等。
 * 安装器只操作传入的 `ClaudePaths` / `supportDirectory`，绝不隐式改用户
 * 真实的 `~/.claude/settings.json`。
 */
export const ClaudeHookInstaller = {
  /** 认领自己条目的唯一凭据。 */
  marker: "botbus-claude-hook",
  /** Windows 上是 PowerShell 脚本，其余平台是 sh。 */
  scriptName: process.platform === "win32" ? "botbus-claude-hook.ps1" : "botbus-claude-hook.sh",
  /** 要挂的事件。`matcher` 一律为空串——过滤放在 Agent 侧做。 */
  events: [...claudeHookKinds] as ClaudeHookKind[],
  /** `PermissionRequest` 的超时比脚本的 `--max-time` 宽一点：30 分钟 + 10 秒。 */
  permissionTimeoutSeconds: 1810,
  /** 脚本模板版本，写在脚本第二行。 */
  scriptVersion: 2,

  // MARK: - 纯函数：合并与撤回

  merged(into: Settings, scriptPath: string): Settings {
    const result: Settings = { ...into };
    const hooks: Settings = isRecord(into.hooks) ? { ...(into.hooks as Settings) } : {};
    for (const event of ClaudeHookInstaller.events) {
      const existing = hooks[event];
      let matchers: Settings[] = Array.isArray(existing)
        ? existing.filter(isRecord).map((matcher) => stripOurs(matcher)).filter(isPresent)
        : [];
      matchers = matchers.map((matcher) => ({ ...matcher }));
      matchers.push({ matcher: "", hooks: [ourEntry(event, scriptPath)] });
      hooks[event] = matchers;
    }
    result.hooks = hooks;
    return result;
  },

  /** 把本工具的条目撤掉，别人的原样留下；空掉的 matcher 与事件键一并删除。 */
  removed(from: Settings): Settings {
    const result: Settings = { ...from };
    if (!isRecord(from.hooks)) return result;
    const hooks: Settings = { ...(from.hooks as Settings) };
    for (const [event, value] of Object.entries(hooks)) {
      if (!Array.isArray(value)) continue;
      const kept = value
        .filter(isRecord)
        .map((matcher) => stripOurs(matcher))
        .filter(isPresent);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0) delete result.hooks;
    else result.hooks = hooks;
    return result;
  },

  /**
   * 上游有两个同名重载：`isInstalled(in:scriptPath:)` 与
   * `isInstalled(paths:supportDirectory:)`。这里按第一个参数是否带
   * `settingsFile` 区分，两种调用都保留。
   */
  isInstalled(first: Settings | ClaudePaths, second: string): boolean {
    if (isClaudePaths(first)) return ClaudeHookInstaller.isInstalledForPaths(first, second);
    return isInstalledInSettings(first, second);
  },

  // MARK: - 文件读写

  /** 读 settings.json。文件不存在当成空对象。 */
  loadSettings(url: string): Settings {
    if (!existsSync(url)) return {};
    const data = readFileSync(url, "utf8");
    if (data.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`${url} 不是一个 JSON 对象，没敢改它`);
    }
    if (!isRecord(parsed)) throw new Error(`${url} 不是一个 JSON 对象，没敢改它`);
    return parsed;
  },

  /** 原子写回；键排序让每次写出的字节稳定。 */
  writeSettings(settings: Settings, url: string): void {
    mkdirSync(dirname(url), { recursive: true });
    const data = sortedJsonPretty(settings);
    const temporary = `${url}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, data, "utf8");
      renameSync(temporary, url);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  },

  /** 装 hook：写脚本 → 备份 settings → 合并写回。 */
  install(paths: ClaudePaths, supportDirectory: string): void {
    const scriptPath = ClaudeHookInstaller.writeScript(supportDirectory);
    const settings = ClaudeHookInstaller.loadSettings(paths.settingsFile);
    if (existsSync(paths.settingsFile) && !existsSync(paths.backupFile)) {
      try {
        copyFileSync(paths.settingsFile, paths.backupFile);
      } catch {
        // 备份是后路；失败不阻止安装（上游是 try?）。
      }
    }
    ClaudeHookInstaller.writeSettings(ClaudeHookInstaller.merged(settings, scriptPath), paths.settingsFile);
  },

  /** 卸载：精确撤回我们的条目，脚本文件一并删掉。 */
  uninstall(paths: ClaudePaths, supportDirectory: string): void {
    const settings = ClaudeHookInstaller.loadSettings(paths.settingsFile);
    ClaudeHookInstaller.writeSettings(ClaudeHookInstaller.removed(settings), paths.settingsFile);
    rmSync(ClaudeHookInstaller.scriptURL(supportDirectory), { force: true });
  },

  /**
   * 用户装过才升级；没装过的不碰。返回是否改了东西。
   */
  upgradeIfNeeded(paths: ClaudePaths, supportDirectory: string): boolean {
    const settings = ClaudeHookInstaller.loadSettings(paths.settingsFile);
    if (!hasAnyOfOurs(settings)) return false;
    const scriptPath = ClaudeHookInstaller.scriptURL(supportDirectory);
    if (
      !ClaudeHookInstaller.isInstalled(settings, scriptPath) ||
      !hasCurrentPermissionTimeout(settings) ||
      !hasCurrentCommand(settings, scriptPath)
    ) {
      ClaudeHookInstaller.install(paths, supportDirectory);
      return true;
    }
    if (ClaudeHookInstaller.isScriptCurrent(supportDirectory)) return false;
    ClaudeHookInstaller.writeScript(supportDirectory);
    return true;
  },

  /** 支持目录里的脚本和当前版本逐字节相同？ */
  isScriptCurrent(supportDirectory: string): boolean {
    try {
      return readFileSync(ClaudeHookInstaller.scriptURL(supportDirectory), "utf8") === script;
    } catch {
      return false;
    }
  },

  isInstalledForPaths(paths: ClaudePaths, supportDirectory: string): boolean {
    try {
      const settings = ClaudeHookInstaller.loadSettings(paths.settingsFile);
      return ClaudeHookInstaller.isInstalled(settings, ClaudeHookInstaller.scriptURL(supportDirectory));
    } catch {
      return false;
    }
  },

  scriptURL(supportDirectory: string): string {
    return join(supportDirectory, ClaudeHookInstaller.scriptName);
  },

  writeScript(supportDirectory: string): string {
    const url = ClaudeHookInstaller.scriptURL(supportDirectory);
    mkdirSync(supportDirectory, { recursive: true });
    writeFileSync(url, script, { encoding: "utf8", mode: 0o755 });
    return url;
  },
};

function isRecord(value: unknown): value is Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isClaudePaths(value: Settings | ClaudePaths): value is ClaudePaths {
  return typeof (value as ClaudePaths).settingsFile === "string";
}

/** 这份 settings 里已经装好了指向 `scriptPath` 的全套条目？ */
function isInstalledInSettings(settings: Settings, scriptPath: string): boolean {
  if (!isRecord(settings.hooks)) return false;
  const hooks = settings.hooks as Settings;
  return ClaudeHookInstaller.events.every((event) => {
    const matchers = hooks[event];
    if (!Array.isArray(matchers)) return false;
    return matchers.some(
      (matcher) =>
        isRecord(matcher) &&
        Array.isArray(matcher.hooks) &&
        (matcher.hooks as unknown[]).some(
          (entry) =>
            isOurs(entry) &&
            isRecord(entry) &&
            typeof entry.command === "string" &&
            samePathReference(entry.command, scriptPath),
        ),
    );
  });
}

/**
 * 命令里引用的脚本路径是不是这一份。斜杠方向与大小写不敏感：
 * 旧版本安装器写的是 `C:/...`，`scriptURL()` 在 Windows 上给 `C:\...`，
 * 精确比较会让 `isInstalled` 永远为 false，旧命令也就永远不会被升级。
 */
function samePathReference(command: string, scriptPath: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  return normalize(command).includes(normalize(scriptPath));
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/** 从一个 matcher 里摘掉我们的 hook。摘完没剩下任何 hook 的 matcher 整条丢弃。 */
function stripOurs(matcher: Settings): Settings | null {
  const entries = matcher.hooks;
  if (!Array.isArray(entries)) return matcher;
  const kept = entries.filter((entry) => !isOurs(entry));
  if (kept.length === 0) return null;
  return { ...matcher, hooks: kept };
}

function isOurs(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  return typeof entry.command === "string" && entry.command.includes(ClaudeHookInstaller.marker);
}

function ourEntry(event: ClaudeHookKind, scriptPath: string): Settings {
  const entry: Settings = { type: "command", command: command(scriptPath) };
  if (event === "PermissionRequest") entry.timeout = ClaudeHookInstaller.permissionTimeoutSeconds;
  return entry;
}

/**
 * 支持目录里有空格（`Application Support`），脚本路径必须带引号。
 *
 * Windows：命令可能经 cmd，也可能经 PowerShell `-Command` 执行。后者会把
 * 开头的 `"C:\...\powershell.exe"` 拆坏（报 `-NoProfile` 无法识别），所以
 * `powershell.exe` 绝对路径不加引号（System32 路径本身没有空格），
 * 只给脚本路径加引号；两种 runner 下都验证过。
 */
function command(scriptPath: string): string {
  if (process.platform === "win32") {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = `${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return `${powershell} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
  }
  return `'${scriptPath.replaceAll("'", "'\\''")}'`;
}

/** 我们所有 hook 条目的命令是不是当前生成器产出的那条。 */
function hasCurrentCommand(settings: Settings, scriptPath: string): boolean {
  if (!isRecord(settings.hooks)) return false;
  const expected = command(scriptPath);
  let ours = 0;
  for (const event of ClaudeHookInstaller.events) {
    const matchers = (settings.hooks as Settings)[event];
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) continue;
      for (const entry of matcher.hooks) {
        if (!isOurs(entry)) continue;
        ours += 1;
        if (!isRecord(entry) || entry.command !== expected) return false;
      }
    }
  }
  return ours > 0;
}

/** 我们的 `PermissionRequest` 条目带的是不是当前的超时。 */
function hasCurrentPermissionTimeout(settings: Settings): boolean {
  if (!isRecord(settings.hooks)) return false;
  const matchers = (settings.hooks as Settings).PermissionRequest;
  if (!Array.isArray(matchers)) return false;
  const ours = matchers
    .filter(isRecord)
    .flatMap((matcher) => (Array.isArray(matcher.hooks) ? matcher.hooks : []))
    .filter(isOurs);
  return (
    ours.length > 0 &&
    ours.every(
      (entry) => isRecord(entry) && entry.timeout === ClaudeHookInstaller.permissionTimeoutSeconds,
    )
  );
}

/** 这份 settings 里有没有任何一条本工具的 hook。 */
function hasAnyOfOurs(settings: Settings): boolean {
  if (!isRecord(settings.hooks)) return false;
  return Object.values(settings.hooks as Settings).some(
    (value) =>
      Array.isArray(value) &&
      value.some(
        (matcher) =>
          isRecord(matcher) &&
          Array.isArray(matcher.hooks) &&
          (matcher.hooks as unknown[]).some(isOurs),
      ),
  );
}

const portFileName = LocalHookServer.portFileName;
const secretFileName = LocalHookServer.sharedSecret.defaultFileName;
const secretHeaderName = LocalHookServer.sharedSecret.headerName;
const permissionEvent = "PermissionRequest";

/**
 * 转发脚本。三条硬要求：永远 exit 0、Agent 不在就安静退出、除了
 * `PermissionRequest` 都只等 3 秒。
 */
const shellScript = String.raw`#!/bin/sh
# BotBus 的 Claude Code hook（脚本版本 ${ClaudeHookInstaller.scriptVersion}）。由 app 写入，可以整份删掉。
# 把 hook 负载原样转给本机 Agent，再把 Agent 的回答原样吐回给 Claude Code。
# 无论如何都 exit 0：这个脚本挂在 Claude Code 的主流程上，我们没资格让它失败。
set -u

DIR=$(dirname "$0")
PORT_FILE="$DIR/${portFileName}"
[ -f "$PORT_FILE" ] || exit 0
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$PORT_FILE")
[ -n "$PORT" ] || exit 0

# Agent 每次启动换一个随机密钥，只有本用户读得到。
SECRET_FILE="$DIR/${secretFileName}"
if [ -r "$SECRET_FILE" ]; then set -- --config "$SECRET_FILE"; else set --; fi

PAYLOAD=$(cat)
# 只有"等人点头"那条值得久等（30 分钟）；其余 3 秒足够，超了就当 Agent 不在。
case "$PAYLOAD" in
  *'"${permissionEvent}"'*) TIMEOUT=1800 ;;
  *) TIMEOUT=3 ;;
esac

RESPONSE=$(printf '%s' "$PAYLOAD" | curl -sS -f --noproxy '*' --max-time "$TIMEOUT" "$@" \
  -H 'content-type: application/json' --data-binary @- \
  "http://127.0.0.1:$PORT/hooks/claude" 2>/dev/null) || exit 0
# 空回答 = 没有意见，Claude Code 回落到它自己的权限弹窗。
[ -n "$RESPONSE" ] && printf '%s' "$RESPONSE"
exit 0
`;

const windowsScript = String.raw`# BotBus Claude Code hook (script version ${ClaudeHookInstaller.scriptVersion}). Written by BotBus; safe to delete.
# Forwards the hook payload to the local BotBus agent and prints its answer back to Claude Code.
# Always exits 0: this runs inside Claude Code's main loop and must never make it fail.
$ErrorActionPreference = 'Stop'
try {
    $dir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $portFile = Join-Path $dir '${portFileName}'
    if (-not (Test-Path -LiteralPath $portFile)) { exit 0 }
    $port = [int]((Get-Content -LiteralPath $portFile -Raw | ConvertFrom-Json).port)
    if ($port -le 0) { exit 0 }

    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stdin.CopyTo($buffer)
    $payload = $buffer.ToArray()
    $text = [System.Text.Encoding]::UTF8.GetString($payload)
    # Only the "wait for the phone" hook is worth waiting for (30 minutes); 3 seconds for the rest.
    $timeout = 3
    if ($text.Contains('"${permissionEvent}"')) { $timeout = 1800 }

    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/hooks/claude")
    $request.Method = 'POST'
    $request.ContentType = 'application/json'
    $request.Proxy = $null
    $request.Timeout = $timeout * 1000
    $request.ReadWriteTimeout = $timeout * 1000
    $secretFile = Join-Path $dir '${secretFileName}'
    if (Test-Path -LiteralPath $secretFile) {
        $line = Get-Content -LiteralPath $secretFile -Raw
        if ($line -match '${secretHeaderName}:\s+([^"\s]+)') {
            $request.Headers.Add('${secretHeaderName}', $Matches[1])
        }
    }
    $request.ContentLength = $payload.Length
    $body = $request.GetRequestStream()
    $body.Write($payload, 0, $payload.Length)
    $body.Close()

    $response = $request.GetResponse()
    $answer = New-Object System.IO.MemoryStream
    $response.GetResponseStream().CopyTo($answer)
    $response.Close()
    # An empty answer means "no opinion": Claude Code falls back to its own permission prompt.
    if ($answer.Length -gt 0) {
        $out = [Console]::OpenStandardOutput()
        $out.Write($answer.ToArray(), 0, [int]$answer.Length)
        $out.Flush()
    }
} catch {
}
exit 0
`;

/** 当前平台该写的脚本内容。非 Windows 用 shell 模板，Windows 用 PowerShell。 */
export const script = process.platform === "win32" ? windowsScript : shellScript;
