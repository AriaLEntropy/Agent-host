// Ported from botbus-protocol/Sources/BotBusConnectors/Codex/CodexBridgeInvocation.swift (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.

/**
 * Finds the Codex subcommand after global options. The desktop currently passes
 * `-c <override>` before `app-server`, so inspecting the first argument misses it.
 */
export const CodexBridgeInvocation = {
  /**
   * Helper settings also reach desktop tools. Their app-servers must not publish
   * a descriptor or replace the connection owned by the main desktop app.
   */
  shouldBridge(args: readonly string[], parentBundleIdentifier: string | undefined): boolean {
    return parentBundleIdentifier === "com.openai.codex" && CodexBridgeInvocation.isAppServer(args);
  },

  valueOptions: new Set([
    "-c", "--config", "--enable", "--disable", "--remote",
    "--remote-auth-token-env", "-i", "--image", "-m", "--model",
    "--local-provider", "-p", "--profile", "-s", "--sandbox",
    "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
  ]),

  flagOptions: new Set([
    "--strict-config", "--oss", "--approve-for-me",
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
    "--worktree", "--search", "--no-alt-screen", "--no-daemon",
  ]),

  isAppServer(args: readonly string[]): boolean {
    let index = 0;
    while (index < args.length) {
      const argument = args[index];
      if (argument === "--") return false;
      if (CodexBridgeInvocation.valueOptions.has(argument)) {
        index += 2;
        continue;
      }
      if (
        argument.startsWith("--") &&
        argument.includes("=") &&
        CodexBridgeInvocation.valueOptions.has(argument.split("=", 1)[0])
      ) {
        index += 1;
        continue;
      }
      if (argument.startsWith("-c") && argument !== "-c" && !argument.startsWith("--")) {
        index += 1;
        continue;
      }
      if (CodexBridgeInvocation.flagOptions.has(argument)) {
        index += 1;
        continue;
      }
      return argument === "app-server";
    }
    return false;
  },
};
