import { BrowserWindow, clipboard, ipcMain, nativeTheme, screen } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import qrcode from "qrcode-generator";
import type { HostController } from "./host-controller.js";

const here = dirname(fileURLToPath(import.meta.url));
const WIDTH = 360;
const HEIGHT = 520;

type PairingWindowView =
  | { mode: "relay"; theme: string; relay: string; publicRelayUrl: string; paired: boolean }
  | {
      mode: "qr";
      theme: string;
      link: string;
      qrSvg: string;
      expiresAt: number;
    }
  | { mode: "result"; theme: string; result: "wait" | "ok" | "expired" | "rejected" | "network"; error?: string };

/**
 * 配对窗口
 *
 * 一个窗口三种状态：未配置 Relay → 二维码 → 结果。
 * 关闭窗口即取消当前配对会话，不留下后台轮询
 */
export class PairingWindow {
  private win: BrowserWindow | undefined;
  private lastView: PairingWindowView | undefined;
  private generation = 0;
  private readonly theme = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");

  constructor(private readonly controller: HostController) {
    this.registerIpc();
  }

  isOpen(): boolean {
    return Boolean(this.win);
  }

  open(mode: "auto" | "relay"): void {
    if (this.win) {
      this.win.show();
      this.win.focus();
      if (mode === "relay") this.pushRelay();
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
        preload: join(here, "pairing-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;
    win.on("closed", () => {
      this.controller.cancelPairing();
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
    void win.loadFile(join(here, "pairing", "index.html"));
    win.webContents.once("did-finish-load", () => {
      if (mode === "relay" || !this.controller.status().relayConfigured) {
        this.pushRelay();
      } else {
        void this.startPairing();
      }
    });
  }

  close(): void {
    this.generation += 1;
    this.controller.cancelPairing();
    const win = this.win;
    this.win = undefined;
    this.lastView = undefined;
    if (win && !win.isDestroyed()) win.close();
  }

  private push(view: PairingWindowView): void {
    this.lastView = view;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.send("pairing:view", view);
  }

  private pushRelay(): void {
    const info = this.controller.relayInfo();
    this.push({
      mode: "relay",
      theme: this.theme(),
      relay: info.relay,
      publicRelayUrl: info.publicRelayUrl,
      paired: info.paired,
    });
  }

  private async startPairing(): Promise<void> {
    const generation = ++this.generation;
    this.controller.cancelPairing();
    try {
      const start = await this.controller.beginPairing();
      if (generation !== this.generation) {
        this.controller.cancelPairing();
        return;
      }
      const qr = qrcode(0, "M");
      qr.addData(start.link);
      qr.make();
      this.push({
        mode: "qr",
        theme: this.theme(),
        link: start.link,
        qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2 }),
        expiresAt: start.expiresAt,
      });
      const result = await start.result;
      if (generation !== this.generation) return;
      if (result.ok) {
        this.push({ mode: "result", theme: this.theme(), result: "ok" });
        setTimeout(() => {
          if (generation === this.generation) this.close();
        }, 1500);
        return;
      }
      if (result.error === "expired") {
        this.push({ mode: "result", theme: this.theme(), result: "expired" });
      } else if (String(result.error).startsWith("Pairing failed (403")) {
        this.push({ mode: "result", theme: this.theme(), result: "rejected", error: result.error });
      } else {
        this.push({ mode: "result", theme: this.theme(), result: "network", error: result.error });
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.push({
        mode: "result",
        theme: this.theme(),
        result: "network",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private registerIpc(): void {
    const fromWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      Boolean(this.win && !this.win.isDestroyed() && event.sender === this.win.webContents);

    ipcMain.on("pairing:ready", (event) => {
      if (fromWindow(event) && this.lastView) {
        this.win?.webContents.send("pairing:view", this.lastView);
      }
    });
    ipcMain.on("pairing:close", (event) => {
      if (fromWindow(event)) this.close();
    });
    ipcMain.on("pairing:regenerate", (event) => {
      if (fromWindow(event)) void this.startPairing();
    });
    ipcMain.on("pairing:copy", (event, text: unknown) => {
      if (fromWindow(event) && typeof text === "string") clipboard.writeText(text);
    });
    ipcMain.handle("pairing:test-relay", async (event, relay: unknown) => {
      if (!fromWindow(event) || typeof relay !== "string") return { ok: false, error: "invalid relay" };
      return this.controller.testRelay(relay);
    });
    ipcMain.handle(
      "pairing:save-relay",
      async (event, payload: { relay?: unknown; publicRelayUrl?: unknown } | undefined) => {
        if (!fromWindow(event)) return { ok: false, error: "window closed" };
        const relay = typeof payload?.relay === "string" ? payload.relay : "";
        const publicRelayUrl =
          typeof payload?.publicRelayUrl === "string" ? payload.publicRelayUrl : "";
        const saved = await this.controller.updateRelay(relay, publicRelayUrl);
        if (saved.ok) void this.startPairing();
        return saved;
      },
    );
  }
}
