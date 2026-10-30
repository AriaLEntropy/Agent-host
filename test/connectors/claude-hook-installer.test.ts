import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeHookInstaller } from "../../src/connectors/claude/claude-hook-installer.js";
import type { ClaudePaths } from "../../src/connectors/claude/claude-hooks.js";

const windows = process.platform === "win32";

function temporaryPaths(root: string): ClaudePaths {
  const claudeHome = join(root, ".claude");
  return {
    claudeHome,
    desktopSessionsDirectories: [],
    settingsFile: join(claudeHome, "settings.json"),
    backupFile: join(claudeHome, "settings.json.botbus.bak"),
    projectsDirectory: join(claudeHome, "projects"),
  };
}

function ourCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const commands: string[] = [];
  for (const matchers of Object.values(hooks ?? {})) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!matcher || typeof matcher !== "object") continue;
      const entries = (matcher as { hooks?: unknown }).hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const command = (entry as { command?: unknown }).command;
        if (typeof command === "string" && command.includes(ClaudeHookInstaller.marker)) {
          commands.push(command);
        }
      }
    }
  }
  return commands;
}

test(
  "Windows hook commands do not quote the powershell executable",
  { skip: !windows },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-host-hook-install-"));
    try {
      const paths = temporaryPaths(root);
      const support = join(root, "BotBus");
      ClaudeHookInstaller.install(paths, support);
      const settings = JSON.parse(await readFile(paths.settingsFile, "utf8")) as Record<
        string,
        unknown
      >;
      const commands = ourCommands(settings);
      assert.ok(commands.length > 0);
      const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      for (const command of commands) {
        assert.equal(command.startsWith('"'), false, command);
        assert.ok(command.startsWith(`${powershell} -NoProfile`), command);
        assert.ok(command.includes(`-File "${ClaudeHookInstaller.scriptURL(support)}"`), command);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "upgradeIfNeeded rewrites the old quoted command",
  { skip: !windows },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-host-hook-upgrade-"));
    try {
      const paths = temporaryPaths(root);
      const support = join(root, "BotBus");
      ClaudeHookInstaller.install(paths, support);
      const settings = JSON.parse(await readFile(paths.settingsFile, "utf8")) as Record<
        string,
        unknown
      >;
      const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const stale = settings.hooks as Record<string, unknown>;
      for (const matchers of Object.values(stale)) {
        if (!Array.isArray(matchers)) continue;
        for (const matcher of matchers) {
          const entries = (matcher as { hooks?: unknown }).hooks;
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (!entry || typeof entry !== "object") continue;
            const command = (entry as { command?: unknown }).command;
            if (typeof command === "string" && command.includes(ClaudeHookInstaller.marker)) {
              (entry as { command: string }).command = command.replace(
                powershell,
                `"${powershell}"`,
              );
            }
          }
        }
      }
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(paths.settingsFile, JSON.stringify(settings, null, 2)),
      );

      assert.equal(ClaudeHookInstaller.upgradeIfNeeded(paths, support), true);
      const upgraded = JSON.parse(await readFile(paths.settingsFile, "utf8")) as Record<
        string,
        unknown
      >;
      for (const command of ourCommands(upgraded)) {
        assert.equal(command.startsWith('"'), false, command);
        assert.ok(command.startsWith(`${powershell} -NoProfile`), command);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
