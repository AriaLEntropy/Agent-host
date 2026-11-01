import { app, clipboard, dialog, Menu, nativeImage, Tray } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostController, type HostStatus } from "./host-controller.js";
import {
  agentStateLabel,
  buildTrayMenu,
  trayIconName,
  trayTooltip,
  type TrayAction,
  type TrayMenuNode,
} from "./tray-menu.js";

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = join(here, "icons");

let controller: HostController | undefined;
let tray: Tray | undefined;
let shuttingDown = false;
let currentIconName = "";

function iconFor(status: HostStatus) {
  return nativeImage.createFromPath(join(iconDir, trayIconName(status)));
}

function menuFor(nodes: TrayMenuNode[]): Electron.MenuItemConstructorOptions[] {
  return nodes.map((node) => {
    if (node.kind === "separator") return { type: "separator" };
    if (node.kind === "submenu") {
      return { label: node.label, submenu: menuFor(node.submenu) };
    }
    const action = node.action;
    return {
      label: node.label,
      enabled: node.enabled ?? true,
      ...(node.checked === undefined ? {} : { type: "checkbox" as const, checked: node.checked }),
      click: action ? () => void runAction(action) : undefined,
    };
  });
}

function render(status: HostStatus) {
  if (!tray) return;
  const iconName = trayIconName(status);
  if (iconName !== currentIconName) {
    tray.setImage(iconFor(status));
    currentIconName = iconName;
  }
  tray.setToolTip(trayTooltip(status));
  tray.setContextMenu(Menu.buildFromTemplate(menuFor(buildTrayMenu(status))));
}

async function runAction(action: TrayAction): Promise<void> {
  if (!controller) return;
  switch (action.type) {
    case "quit":
      app.quit();
      return;
    case "refresh-agents":
      await controller.refreshAgents();
      return;
    case "copy-manifest-problems": {
      const text = controller
        .status()
        .manifestProblems.map((problem) => `${problem.file} · ${problem.reason}`)
        .join("\n");
      clipboard.writeText(text);
      return;
    }
    case "toggle-agent": {
      const agent = controller.status().agents.find((item) => item.id === action.agentId);
      if (!agent) return;
      const error = await controller.setAgentEnabled(agent, action.enabled);
      if (error) await showAgentError(agent.id, error);
      return;
    }
    case "show-agent-error":
      await showAgentError(action.agentId);
      return;
  }
}

async function showAgentError(agentId: string, detail?: string): Promise<void> {
  const agent = controller?.status().agents.find((item) => item.id === agentId);
  if (!agent) return;
  const message = detail ?? agent.lastError ?? "未知错误";
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: `${agent.name} ${agentStateLabel(agent) === "出错" ? "出错" : "启动失败"}`,
    message,
    buttons: ["复制诊断信息", "关闭"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    clipboard.writeText(`${agent.name}\n${message}`);
  }
}

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setName("AgentBus");
  app.setAppUserModelId("com.agentbus.host");
  app.dock?.hide();

  controller = new HostController();
  try {
    await controller.start();
  } catch (error) {
    dialog.showErrorBox(
      "AgentBus 启动失败",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  const status = controller.status();
  tray = new Tray(iconFor(status));
  currentIconName = trayIconName(status);
  tray.setToolTip(trayTooltip(status));
  // Windows 习惯：左键也展开菜单；右键由 setContextMenu 处理
  tray.on("click", () => tray?.popUpContextMenu());
  controller.subscribe(render);
  render(status);
}

app.whenReady().then(bootstrap).catch((error) => {
  dialog.showErrorBox("AgentBus 启动失败", error instanceof Error ? error.message : String(error));
  app.quit();
});

// 没有窗口，托盘常驻；订阅该事件即不触发默认的「关窗退出」
app.on("window-all-closed", () => {
  // 保持托盘进程
});

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void controller?.stop().finally(() => app.quit());
});
