import { agentIconFile } from "./agent-icons.js";
import type { HostStatus } from "./host-controller.js";

export function statusLabel(status: HostStatus): string {
  if (!status.relayConfigured) return "未配置 Relay";
  if (status.connection === "unpaired") return "未配对";
  if (status.connection === "disconnected") return "连接中断";
  return status.pendingCount > 0
    ? `已连接 · 待处理 ${status.pendingCount}`
    : "已连接 · 无待处理";
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
  if (!status.relayConfigured) return "AgentBus · 未配置 Relay";
  if (status.connection === "unpaired") return "AgentBus · 未配对";
  if (status.connection === "disconnected") return "AgentBus · 连接中断";
  return status.pendingCount > 0
    ? `AgentBus · 已连接 · 待处理 ${status.pendingCount}`
    : "AgentBus · 已连接";
}

/**
 * 托盘图标文件：三态各一张；已连接且有队列时叠 1–9 / 9+ 角标
 * 资产放在 `src/desktop/icons/`，跟弹层内容分开，方便做视觉替换
 */
export function trayIconName(status: Pick<HostStatus, "connection" | "pendingCount">): string {
  if (status.connection === "unpaired") return "tray-unpaired.png";
  if (status.connection === "disconnected") return "tray-disconnected.png";
  if (status.pendingCount <= 0) return "tray-connected.png";
  if (status.pendingCount > 9) return "tray-connected-9plus.png";
  return `tray-connected-${status.pendingCount}.png`;
}

export type PanelAgent = {
  id: string;
  name: string;
  state: string;
  enabled: boolean;
  available: boolean;
  hasError: boolean;
  icon: string;
  errorText?: string;
};

export type PanelEntry = {
  id: "configure-relay" | "pair" | "settings";
  label: string;
};

export type PanelView = {
  connection: HostStatus["connection"];
  statusLabel: string;
  hostName: string;
  pendingCount: number;
  agents: PanelAgent[];
  problems: { file: string; reason: string }[];
  entries: PanelEntry[];
};

/**
 * 自绘弹层的数据形状：文案和状态在这一层算好，HTML 只负责画
 * 这样菜单/弹层/以后别的入口共用同一套状态判定
 */
export function panelView(status: HostStatus): PanelView {
  return {
    connection: status.connection,
    statusLabel: statusLabel(status),
    hostName: status.hostName,
    pendingCount: status.pendingCount,
    agents: status.agents.map((agent) => {
      const state = agentStateLabel(agent);
      return {
        id: agent.id,
        name: agent.name,
        state,
        enabled: agent.enabled,
        available: agent.available,
        // 只有「装了但出错」才给详情入口；未安装/已停用不制造多余行
        hasError: state === "出错",
        icon: `../icons/agents/${agentIconFile(agent.kind, agent.connectorId)}`,
        // 未安装的原因也展示出来，用户能直接看到是没装还是装坏了
        ...(agent.lastError ? { errorText: agent.lastError } : {}),
      };
    }),
    problems: status.manifestProblems.map((problem) => ({
      file: problem.file,
      reason: problem.reason,
    })),
    entries: panelEntries(status),
  };
}

function panelEntries(status: HostStatus): PanelEntry[] {
  if (!status.relayConfigured) {
    return [{ id: "configure-relay", label: "配置 Relay…" }];
  }
  return [{ id: "pair", label: status.paired ? "重新配对…" : "配对手机…" }];
}
