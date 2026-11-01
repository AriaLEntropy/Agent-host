import type { HostStatus } from "./host-controller.js";

export type TrayAction =
  | { type: "quit" }
  | { type: "toggle-agent"; agentId: string; enabled: boolean }
  | { type: "show-agent-error"; agentId: string }
  | { type: "copy-manifest-problems" }
  | { type: "refresh-agents" };

export type TrayMenuNode =
  | {
      kind: "item";
      label: string;
      enabled?: boolean;
      checked?: boolean;
      action?: TrayAction;
    }
  | { kind: "separator" }
  | {
      kind: "submenu";
      label: string;
      submenu: TrayMenuNode[];
    };

/**
 * 托盘菜单模板（纯数据，不依赖 Electron）。
 *
 * 第一版只有 FR-14.6.1 的原生外壳：连接状态 + 待处理数、本机 Agent、退出。
 * 配对窗口与设置窗口要等设计通过后，再把对应菜单项加进来。
 */
export function buildTrayMenu(status: HostStatus): TrayMenuNode[] {
  const nodes: TrayMenuNode[] = [
    { kind: "item", label: statusLabel(status), enabled: false },
    { kind: "separator" },
    { kind: "submenu", label: "本机 Agent", submenu: agentMenu(status) },
    { kind: "separator" },
    { kind: "item", label: "退出", action: { type: "quit" } },
  ];
  return nodes;
}

function statusLabel(status: HostStatus): string {
  if (status.connection === "unpaired") return "未配对";
  if (status.connection === "disconnected") return "连接中断";
  return status.pendingCount > 0
    ? `已连接 · 待处理 ${status.pendingCount}`
    : "已连接 · 无待处理";
}

function agentMenu(status: HostStatus): TrayMenuNode[] {
  if (status.agents.length === 0) {
    return [{ kind: "item", label: "未发现本机 Agent", enabled: false }];
  }
  const nodes: TrayMenuNode[] = [];
  for (const agent of status.agents) {
    nodes.push({
      kind: "item",
      label: `${agent.name} · ${agentStateLabel(agent)}`,
      checked: agent.enabled,
      action: { type: "toggle-agent", agentId: agent.id, enabled: !agent.enabled },
    });
  }
  const errored = status.agents.filter((agent) => Boolean(agent.lastError));
  if (errored.length > 0) {
    nodes.push({ kind: "separator" });
    for (const agent of errored) {
      nodes.push({
        kind: "item",
        label: `查看 ${agent.name} 错误…`,
        action: { type: "show-agent-error", agentId: agent.id },
      });
    }
  }
  if (status.manifestProblems.length > 0) {
    nodes.push({ kind: "separator" });
    nodes.push({
      kind: "submenu",
      label: `ACP 清单问题（${status.manifestProblems.length}）`,
      submenu: [
        ...status.manifestProblems.map(
          (problem): TrayMenuNode => ({
            kind: "item",
            label: `${problem.file} · ${problem.reason}`,
            enabled: false,
          }),
        ),
        { kind: "separator" },
        { kind: "item", label: "复制诊断信息", action: { type: "copy-manifest-problems" } },
      ],
    });
  }
  nodes.push({ kind: "separator" });
  nodes.push({ kind: "item", label: "刷新列表", action: { type: "refresh-agents" } });
  return nodes;
}

/** 状态词只取需求里的四种：未安装 / 已停用 / 出错 / 可用 */
export function agentStateLabel(agent: {
  enabled: boolean;
  available: boolean;
  lastError?: string;
  status?: "ok" | "degraded" | "error";
}): string {
  // 没装就是「未安装」：OpenClaw 默认 enabled=false，但本机没有它，
  // 先报「已停用」会让用户以为装了只是被关掉
  if (!agent.available) return "未安装";
  if (!agent.enabled) return "已停用";
  if (agent.lastError || agent.status === "error") return "出错";
  return "可用";
}

export function trayTooltip(status: HostStatus): string {
  if (status.connection === "unpaired") return "AgentBus · 未配对";
  if (status.connection === "disconnected") return "AgentBus · 连接中断";
  return status.pendingCount > 0
    ? `AgentBus · 已连接 · 待处理 ${status.pendingCount}`
    : "AgentBus · 已连接";
}

/**
 * 托盘图标文件：三态各一张；已连接且有队列时叠 1–9 / 9+ 角标。
 * 资产放在 `src/desktop/icons/`，跟菜单模板分开，方便做视觉替换。
 */
export function trayIconName(status: Pick<HostStatus, "connection" | "pendingCount">): string {
  if (status.connection === "unpaired") return "tray-unpaired.png";
  if (status.connection === "disconnected") return "tray-disconnected.png";
  if (status.pendingCount <= 0) return "tray-connected.png";
  if (status.pendingCount > 9) return "tray-connected-9plus.png";
  return `tray-connected-${status.pendingCount}.png`;
}
