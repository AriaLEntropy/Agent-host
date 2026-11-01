/**
 * 本机 Agent → 官方图标资产（桌面弹层用）
 *
 * 与手机端同一套匹配规则：connectorId 优先于 kind，
 * acp 只有 connectorId 能区分 opencode / claude-code；未知来源回退默认图标
 */
export function agentIconFile(kind: string, connectorId?: string): string {
  return `${normalize(connectorId)}${normalize(kind)}`
    ? match(`${normalize(connectorId)} ${normalize(kind)}`)
    : "agent-default.svg";
}

function match(id: string): string {
  if (id.includes("opencode")) return "agent-opencode.svg";
  if (id.includes("openclaw")) return "agent-openclaw.svg";
  if (id.includes("deepseek") || id.includes("dsh")) return "agent-deepseek.png";
  if (id.includes("claude") || id.includes("anthropic")) return "agent-claude.jpg";
  if (id.includes("codex")) return "agent-codex.jpg";
  if (id.includes("hermes")) return "agent-hermes.svg";
  if (/(^|\s)pi(\s|$)/.test(id)) return "agent-pi.svg";
  return "agent-default.svg";
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
