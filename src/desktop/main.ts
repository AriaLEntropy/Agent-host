import { app, clipboard, dialog, nativeImage, Tray } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostController, type HostStatus } from "./host-controller.js";
import { TrayPanel } from "./panel-window.js";
import { agentStateLabel, trayIconName, trayTooltip } from "./tray-menu.js";

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = join(here, "icons");

let controller: HostController | undefined;
let tray: Tray | undefined;
let panel: TrayPanel | undefined;
let shuttingDown = false;
let currentIconName = "";

function iconFor(status: HostStatus) {
  return nativeImage.createFromPath(join(iconDir, trayIconName(status)));
}

function renderTray(status: HostStatus) {
  if (!tray) return;
  const iconName = trayIconName(status);
  if (iconName !== currentIconName) {
    tray.setImage(iconFor(status));
    currentIconName = iconName;
  }
  tray.setToolTip(trayTooltip(status));
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

function togglePanel(): void {
  panel?.toggle(tray?.getBounds());
}

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setName("AgentBus");
  app.setAppUserModelId("com.agentbus.host");
  app.dock?.hide();

  const host = new HostController();
  controller = host;
  try {
    await host.start();
  } catch (error) {
    dialog.showErrorBox(
      "AgentBus 启动失败",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
    return;
  }

  panel = new TrayPanel({
    status: () => host.status(),
    subscribe: (listener) => host.subscribe(listener),
    toggleAgent: async (agentId, enabled) => {
      const agent = host.status().agents.find((item) => item.id === agentId);
      if (!agent) return;
      const error = await host.setAgentEnabled(agent, enabled);
      if (error) await showAgentError(agentId, error);
    },
    showAgentError: (agentId) => showAgentError(agentId),
    copyProblems: () => {
      const text = host
        .status()
        .manifestProblems.map((problem) => `${problem.file} · ${problem.reason}`)
        .join("\n");
      clipboard.writeText(text);
    },
    refresh: () => host.refreshAgents(),
    quit: () => app.quit(),
  });

  const status = host.status();
  tray = new Tray(iconFor(status));
  currentIconName = trayIconName(status);
  tray.setToolTip(trayTooltip(status));
  // 左键和右键都打开自绘弹层；再点一次托盘收起
  tray.on("click", togglePanel);
  tray.on("right-click", togglePanel);
  host.subscribe(renderTray);
  renderTray(status);
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
  panel?.close();
  void controller?.stop().finally(() => app.quit());
});
