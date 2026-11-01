import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorSettingsPath } from "../connectors/settings-store.js";
import { defaultLogDirectory, exportDiagnostics } from "../platform/log.js";
import { hostDataDir } from "../config.js";
import type { HostController, SettingsInfo } from "./host-controller.js";

const here = dirname(fileURLToPath(import.meta.url));
const WIDTH = 720;
const HEIGHT = 560;

type SettingsView = SettingsInfo & {
  theme: "light" | "dark";
  startupEnabled: boolean;
  startupSupported: boolean;
};

/**
 * 设置窗口：连接 / 本机 Agent / 项目 / 通用 / 诊断
 *
 * 窗口固定 720×560，左侧导航不滚，只有右侧内容区滚动；关闭只是隐藏状态，不退出 Host
 */
export class SettingsWindow {
  private win: BrowserWindow | undefined;
  private unsubscribe?: () => void;

  constructor(
    private readonly controller: HostController,
    private readonly actions: {
      showAgentError: (agentId: string) => Promise<void>;
      repair: () => void;
    },
  ) {
    this.registerIpc();
  }

  isOpen(): boolean {
    return Boolean(this.win);
  }

  open(): void {
    if (this.win) {
      this.win.show();
      this.win.focus();
      this.push();
      return;
    }
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        preload: join(here, "settings-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;
    win.on("closed", () => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.win === win) this.win = undefined;
    });
    win.once("ready-to-show", () => {
      const work = screen.getPrimaryDisplay().workArea;
      win.setBounds({
        x: Math.round(work.x + (work.width - WIDTH) / 2),
        y: Math.round(work.y + (work.height - HEIGHT) / 2),
        width: WIDTH,
        height: HEIGHT,
      });
      win.show();
      win.focus();
    });
    this.unsubscribe = this.controller.subscribe(() => this.push());
    void win.loadFile(join(here, "settings", "index.html"));
    win.webContents.once("did-finish-load", () => this.push());
  }

  close(): void {
    const win = this.win;
    this.win = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (win && !win.isDestroyed()) win.close();
  }

  private push(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const info = this.controller.settingsInfo();
    const view: SettingsView = {
      ...info,
      theme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      startupEnabled: app.getLoginItemSettings().openAtLogin,
      startupSupported: process.platform === "win32" || process.platform === "darwin",
    };
    win.webContents.send("settings:view", view);
  }

  private registerIpc(): void {
    const fromWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      Boolean(this.win && !this.win.isDestroyed() && event.sender === this.win.webContents);

    ipcMain.on("settings:ready", (event) => {
      if (fromWindow(event)) this.push();
    });
    ipcMain.on("settings:close", (event) => {
      if (fromWindow(event)) this.close();
    });
    ipcMain.handle("settings:test-relay", async (event, relay: unknown) => {
      if (!fromWindow(event) || typeof relay !== "string") return { ok: false, error: "invalid relay" };
      return this.controller.testRelay(relay);
    });
    ipcMain.handle("settings:probe-relay", async (event, relay: unknown) => {
      if (!fromWindow(event) || typeof relay !== "string") return { ok: false, error: "invalid relay" };
      return this.controller.probeRelay(relay);
    });
    ipcMain.handle("settings:detect-relay", async (event) => {
      if (!fromWindow(event)) return { ok: false, error: "window closed" };
      return this.controller.detectLocalRelay();
    });
    ipcMain.handle(
      "settings:save-relay",
      async (event, payload: { relay?: unknown; publicRelayUrl?: unknown } | undefined) => {
        if (!fromWindow(event)) return { ok: false, error: "window closed" };
        const relay = typeof payload?.relay === "string" ? payload.relay : "";
        const publicRelayUrl =
          typeof payload?.publicRelayUrl === "string" ? payload.publicRelayUrl : "";
        const result = await this.controller.updateRelay(relay, publicRelayUrl);
        this.push();
        return result;
      },
    );
    ipcMain.on(
      "settings:toggle-agent",
      (event, payload: { agentId?: unknown; enabled?: unknown } | undefined) => {
        if (!fromWindow(event)) return;
        if (typeof payload?.agentId !== "string" || typeof payload?.enabled !== "boolean") return;
        const agent = this.controller.status().agents.find((item) => item.id === payload.agentId);
        if (!agent) return;
        void this.controller.setAgentEnabled(agent, payload.enabled).then(() => this.push());
      },
    );
    ipcMain.on("settings:show-agent-error", (event, agentId: unknown) => {
      if (fromWindow(event) && typeof agentId === "string") {
        void this.actions.showAgentError(agentId);
      }
    });
    ipcMain.on("settings:refresh-agents", (event) => {
      if (!fromWindow(event)) return;
      void this.controller.refreshAgents().then(() => this.push());
    });
    ipcMain.on("settings:copy-problems", (event) => {
      if (!fromWindow(event)) return;
      clipboard.writeText(
        this.controller
          .status()
          .manifestProblems.map((problem) => `${problem.file} · ${problem.reason}`)
          .join("\n"),
      );
    });
    ipcMain.on("settings:repair", (event) => {
      if (fromWindow(event)) this.actions.repair();
    });
    ipcMain.handle("settings:unpair", async (event) => {
      if (!fromWindow(event) || !this.win) return { ok: false, error: "window closed" };
      const { response } = await dialog.showMessageBox(this.win, {
        type: "warning",
        title: "解除与这台手机的配对？",
        message: "只断开这台手机，不清除本机缓存与 Agent 配置。",
        buttons: ["取消", "解除"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return { ok: false, canceled: true };
      const result = await this.controller.unpair();
      this.push();
      return result;
    });
    ipcMain.handle("settings:choose-project-root", async (event) => {
      if (!fromWindow(event) || !this.win) return { ok: false, error: "window closed" };
      const picked = await dialog.showOpenDialog(this.win, {
        title: "选择项目存放目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
      const info = this.controller.settingsInfo();
      const result = await this.controller.updateProjects(
        picked.filePaths[0],
        info.allowMobileNewProjects,
      );
      this.push();
      return result;
    });
    ipcMain.handle("settings:set-allow-projects", async (event, allow: unknown) => {
      if (!fromWindow(event) || typeof allow !== "boolean") return { ok: false, error: "invalid" };
      const info = this.controller.settingsInfo();
      const result = await this.controller.updateProjects(info.projectsRoot, allow);
      this.push();
      return result;
    });
    ipcMain.handle("settings:set-startup", async (event, enabled: unknown) => {
      if (!fromWindow(event) || typeof enabled !== "boolean") return { ok: false, error: "invalid" };
      const supported = process.platform === "win32" || process.platform === "darwin";
      if (!supported) return { ok: false, error: "当前平台暂不支持开机启动" };
      app.setLoginItemSettings({ openAtLogin: enabled });
      this.push();
      return { ok: true };
    });
    ipcMain.on("settings:open-logs", (event) => {
      if (fromWindow(event)) void shell.openPath(defaultLogDirectory());
    });
    ipcMain.handle("settings:export-diagnostics", async (event) => {
      if (!fromWindow(event) || !this.win) return { ok: false, error: "window closed" };
      const config = this.controller.configSnapshot();
      if (!config) return { ok: false, error: "Host 还没有启动" };
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
      const picked = await dialog.showSaveDialog(this.win, {
        title: "导出诊断包",
        defaultPath: join(hostDataDir(), "diagnostics", `agent-host-diagnostics-${stamp}.tar.gz`),
        filters: [{ name: "tar.gz", extensions: ["gz"] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      try {
        const path = await exportDiagnostics({
          config,
          outPath: picked.filePath,
          extraFiles: [{ name: "connector-settings.json", path: connectorSettingsPath() }],
        });
        return { ok: true, path };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.on("settings:copy-diagnostics", (event) => {
      if (!fromWindow(event)) return;
      const info = this.controller.settingsInfo();
      clipboard.writeText(
        [
          `host: ${info.hostName}`,
          `version: ${info.version}`,
          `relay: ${info.relay || "(未配置)"}`,
          `connection: ${info.connection}`,
          `paired: ${info.paired}`,
          ...info.agents.map((agent) => `${agent.name}: ${agent.available ? (agent.enabled ? "可用" : "已停用") : "未安装"}`),
          `logs: ${defaultLogDirectory()}`,
        ].join("\n"),
      );
    });
  }
}
