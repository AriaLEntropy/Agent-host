// Ported from botbus-protocol/Sources/BotBusConnectors/Dsh/DshDesktopInstallation.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DshVersion } from "./paths.js";

/** 桌面版随包分发的 CLI 与桌面日志版本一致；不要用 npx 缓存里的旧版本打开它的会话。 */
export const DshDesktopInstallation = {
  /** 只认 macOS 的 `.app`；Windows / Linux 没有桌面宿主（上游 `#else return []`）。 */
  defaultBundles(): string[] {
    if (process.platform !== "darwin") return [];
    return [
      "/Applications/DeepSeek Harness.app",
      join(homedir(), "Applications", "DeepSeek Harness.app"),
    ];
  },

  /**
   * 在候选 bundle 里找版本最高、且标识为本产品的一份。
   *
   * `// PORT:` 上游用 `PropertyListSerialization`（XML 与二进制 plist 都能读）。
   * 这里只解析 XML plist；二进制 plist 直接跳过（只有 macOS 会走到这里）。
   */
  detect(
    bundles: readonly string[],
    node: string | null,
  ): { kind: "binary"; executable: string; leadingArguments: string[]; version: string; node: string | null } | null {
    let best: { installation: ReturnType<typeof makeInstallation>; version: DshVersion } | undefined;
    for (const bundle of bundles) {
      const contents = join(bundle, "Contents");
      const cli = join(contents, "Resources", "runtime", "cli", "bin", "dsh");
      if (!isExecutableFile(cli)) continue;
      let info: { identifier?: string; version?: string };
      try {
        info = parseXmlPlist(readFileSync(join(contents, "Info.plist"), "utf8"));
      } catch {
        continue;
      }
      if (info.identifier !== "com.deepseek.dsh") continue;
      const text = info.version;
      if (!text) continue;
      const version = DshVersion.parse(text);
      if (!version) continue;
      if (!best || version.compare(best.version) > 0) {
        best = { installation: makeInstallation(cli, text, node), version };
      }
    }
    return best?.installation ?? null;
  },
};

function makeInstallation(executable: string, version: string, node: string | null) {
  return { kind: "binary" as const, executable, leadingArguments: [] as string[], version, node };
}

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function parseXmlPlist(text: string): { identifier?: string; version?: string } {
  return {
    identifier: stringAfterKey(text, "CFBundleIdentifier"),
    version: stringAfterKey(text, "CFBundleShortVersionString"),
  };
}

function stringAfterKey(text: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<key>\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</key>\\s*<string>([^<]*)</string>`,
  );
  const match = pattern.exec(text);
  return match ? match[1] : undefined;
}

/** 测试与探测共用：bundle 里的 CLI 是否存在。 */
export function desktopCliExists(bundle: string): boolean {
  return existsSync(join(bundle, "Contents", "Resources", "runtime", "cli", "bin", "dsh"));
}
