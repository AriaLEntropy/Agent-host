import { BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostStatus } from "./host-controller.js";
import { panelView } from "./tray-menu.js";

const here = dirname(fileURLToPath(import.meta.url));
const PANEL_WIDTH = 272;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 580;
const EDGE_GAP = 8;

export type PanelAnchor = { x: number; y: number; width: number; height: number };

export type PanelActions = {
  status: () => HostStatus;
  subscribe: (listener: (status: HostStatus) => void) => () => void;
  toggleAgent: (agentId: string, enabled: boolean) => Promise<void>;
  showAgentError: (agentId: string) => Promise<void>;
  copyProblems: () => void;
  refresh: () => Promise<void>;
  openEntry: (id: string) => void;
  quit: () => void;
};

/**
 * 自绘托盘弹层
 *
 * 原生 Windows 菜单点任意项都会关闭，没法连续开关 Agent；
 * 这里用一个无边框透明窗口承载同一份内容，点开关只更新数据，
 * 点窗口外（blur）或 Esc 才关闭
 */
export class TrayPanel {
  private win: BrowserWindow | undefined;
  private unsubscribe: (() => void) | undefined;
  private anchor: PanelAnchor | undefined;
  private dialogOpen = false;
  private height = 360;
  private shown = false;
  private shownAt = 0;

  constructor(private readonly actions: PanelActions) {
    this.registerIpc();
  }

  isOpen(): boolean {
    return Boolean(this.win);
  }

  toggle(anchor: PanelAnchor | undefined): void {
    if (this.win) {
      this.close();
      return;
    }
    this.open(anchor);
  }

  close(): void {
    const win = this.win;
    if (!win) return;
    this.win = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (!win.isDestroyed()) win.close();
  }

  private open(anchor: PanelAnchor | undefined): void {
    this.anchor = anchor;
    this.shown = false;
    const win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;
    win.setMenuBarVisibility(false);
    win.setAlwaysOnTop(true, "pop-up-menu");
    win.on("blur", () => {
      // 从托盘溢出层弹出时，系统收起飞出层会先抢一次焦点；
      // 300ms 内的 blur 不算「点了面板外」
      if (this.dialogOpen || Date.now() - this.shownAt < 300) return;
      this.close();
    });
    win.on("closed", () => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.win === win) this.win = undefined;
    });
    this.unsubscribe = this.actions.subscribe(() => this.pushView());
    void win.loadFile(join(here, "panel", "index.html"));
    // 先等页面量完真实高度再显示，避免出现后突然变高、位置往下跳
    win.once("ready-to-show", () => {
      setTimeout(() => this.showWhenReady(), 300);
    });
  }

  private pushView(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(
      "panel:view",
      panelView(this.actions.status()),
      nativeTheme.shouldUseDarkColors ? "dark" : "light",
    );
  }

  private showWhenReady(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || this.shown) return;
    this.shown = true;
    this.shownAt = Date.now();
    this.applyBounds();
    win.show();
    win.focus();
  }

  private applyBounds(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.setBounds(this.boundsFor(this.height));
  }

  private boundsFor(height: number) {
    const anchor = this.resolvedAnchor();
    const point = {
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2),
    };
    const work = screen.getDisplayNearestPoint(point).workArea;
    const width = PANEL_WIDTH;
    const maxX = work.x + work.width - width - EDGE_GAP;
    // 面板贴着托盘图标左侧，避免盖住 Windows 的托盘溢出层
    const leftOfAnchor = Math.round(anchor.x - width - 10);
    const centered = Math.round(anchor.x + anchor.width / 2 - width / 2);
    const x = Math.min(Math.max(leftOfAnchor >= work.x + EDGE_GAP ? leftOfAnchor : centered, work.x + EDGE_GAP), maxX);
    // 任务栏在底部时固定贴着工作区底边，不再依赖托盘图标上报的坐标
    const display = screen.getDisplayNearestPoint(point);
    const taskbarAtBottom = work.y + work.height < display.bounds.y + display.bounds.height;
    const taskbarAtTop = work.y > display.bounds.y;
    const above = point.y > work.y + work.height / 2;
    let y: number;
    if (taskbarAtBottom) {
      y = work.y + work.height - height - 6;
    } else if (taskbarAtTop) {
      y = work.y + 6;
    } else {
      y = above ? anchor.y - height - 4 : anchor.y + anchor.height + 4;
    }
    const maxY = work.y + work.height - height - EDGE_GAP;
    y = Math.min(Math.max(y, work.y + EDGE_GAP), maxY);
    return { x, y, width, height };
  }

  private resolvedAnchor(): PanelAnchor {
    if (this.anchor && (this.anchor.width > 0 || this.anchor.height > 0)) return this.anchor;
    const cursor = screen.getCursorScreenPoint();
    return { x: cursor.x, y: cursor.y, width: 1, height: 1 };
  }

  private registerIpc(): void {
    const fromPanel = (event: Electron.IpcMainEvent) =>
      Boolean(this.win && !this.win.isDestroyed() && event.sender === this.win.webContents);

    ipcMain.on("panel:ready", (event) => {
      if (fromPanel(event)) this.pushView();
    });
    ipcMain.on("panel:resize", (event, value: unknown) => {
      if (!fromPanel(event) || typeof value !== "number" || !Number.isFinite(value)) return;
      const next = Math.round(Math.min(Math.max(value, MIN_HEIGHT), MAX_HEIGHT));
      if (next !== this.height) {
        this.height = next;
        this.applyBounds();
      }
      this.showWhenReady();
    });
    ipcMain.on("panel:toggle", (event, payload: unknown) => {
      if (!fromPanel(event)) return;
      const data = payload as { agentId?: unknown; enabled?: unknown };
      if (typeof data?.agentId !== "string" || typeof data?.enabled !== "boolean") return;
      void this.actions.toggleAgent(data.agentId, data.enabled);
    });
    ipcMain.on("panel:error", (event, agentId: unknown) => {
      if (!fromPanel(event) || typeof agentId !== "string") return;
      this.dialogOpen = true;
      void this.actions.showAgentError(agentId).finally(() => {
        this.dialogOpen = false;
      });
    });
    ipcMain.on("panel:copy-problems", (event) => {
      if (fromPanel(event)) this.actions.copyProblems();
    });
    ipcMain.on("panel:refresh", (event) => {
      if (fromPanel(event)) void this.actions.refresh();
    });
    ipcMain.on("panel:entry", (event, id: unknown) => {
      if (fromPanel(event) && typeof id === "string") this.actions.openEntry(id);
    });
    ipcMain.on("panel:close", (event) => {
      if (fromPanel(event)) this.close();
    });
    ipcMain.on("panel:quit", (event) => {
      if (fromPanel(event)) this.actions.quit();
    });
  }
}
