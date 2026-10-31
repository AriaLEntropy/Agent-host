/**
 * 本机设置页（FR-14.7.2 的「导出诊断包」入口）。
 *
 * 桌面端还没有托盘/窗口（FR-14.6.1），所以先用一个只监听 127.0.0.1 的
 * 小页面承担设置入口：显示版本、数据目录、日志占用，并提供导出按钮。
 * 页面由 `agent-host settings` 启动，除本机回环外不对外提供任何服务。
 *
 * 安全约束：
 * - 只绑定 127.0.0.1，端口默认随机；
 * - 每次启动生成一次性 token，URL 与表单都带 token，缺失或不对一律 401；
 * - 页面与导出结果都不回显 hostToken / e2eeMasterKey 等凭据；
 * - 导出只写本机数据目录，页面不接受路径参数。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { stat, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { hostDataDir, type Config } from "../config.js";
import { connectorSettingsPath } from "../connectors/settings-store.js";
import { PLUGIN_VERSION } from "../tunnel/version.js";
import { defaultLogDirectory, exportDiagnostics } from "./log.js";

export type SettingsExport = (
  options: Parameters<typeof exportDiagnostics>[0],
) => Promise<string>;

export type SettingsServerOptions = {
  config: Config;
  logDirectory?: string;
  port?: number;
  token?: string;
  /** 测试可替换为写临时目录；生产直接调用 exportDiagnostics。 */
  exportBundle?: SettingsExport;
  now?: () => Date;
};

export type SettingsServer = {
  /** 带 token 的完整地址，交给浏览器打开。 */
  url: string;
  origin: string;
  token: string;
  port: number;
  close(): Promise<void>;
};

const TOKEN_HEADER = "x-agent-host-token";

export async function startSettingsServer(
  options: SettingsServerOptions,
): Promise<SettingsServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const logDirectory = options.logDirectory ?? defaultLogDirectory();
  const exportBundle: SettingsExport =
    options.exportBundle ??
    ((bundleOptions) => exportDiagnostics(bundleOptions));
  let server: Server | undefined;

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, {
      config: options.config,
      logDirectory,
      token,
      exportBundle,
    }).catch(() => {
      if (!response.headersSent) send(response, 500, "发生内部错误，请查看日志。");
      else response.destroy();
    });
  };

  server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(options.port ?? 0, "127.0.0.1", () => {
      server!.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("settings server did not bind a loopback port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/?token=${encodeURIComponent(token)}`,
    origin,
    token,
    port: address.port,
    close: () => closeServer(server!),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    config: Config;
    logDirectory: string;
    token: string;
    exportBundle: SettingsExport;
  },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!authorized(request, url, context.token)) {
    send(response, 401, "需要本机设置页的有效链接。请重新运行 `agent-host settings`。");
    return;
  }

  if (url.pathname === "/" && request.method === "GET") {
    const status = await logStatus(context.logDirectory);
    sendHtml(response, 200, renderPage(context, status, undefined));
    return;
  }

  if (url.pathname === "/diagnostics" && request.method === "POST") {
    // 表单没有正文；排空后立即响应，避免 keep-alive 连接卡住。
    request.resume();
    const out = await context.exportBundle({
      config: context.config,
      logDirectory: context.logDirectory,
      extraFiles: [
        { name: "connector-settings.json", path: connectorSettingsPath() },
      ],
    });
    const info = await stat(out).catch(() => undefined);
    const status = await logStatus(context.logDirectory);
    sendHtml(
      response,
      200,
      renderPage(context, status, {
        path: out,
        bytes: info?.size ?? 0,
      }),
    );
    return;
  }

  if (url.pathname === "/diagnostics" || url.pathname === "/") {
    send(response, 405, "不支持这个请求方法。");
    return;
  }
  send(response, 404, "没有这个页面。");
}

function authorized(request: IncomingMessage, url: URL, token: string): boolean {
  const header = request.headers[TOKEN_HEADER];
  const provided = typeof header === "string" ? header : url.searchParams.get("token");
  if (typeof provided !== "string" || provided.length === 0) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type LogStatus = { files: number; bytes: number };

async function logStatus(directory: string): Promise<LogStatus> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) =>
      /^agent-host-\d{4}-\d{2}-\d{2}\.log$/.test(name),
    );
  } catch {
    return { files: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += (await stat(join(directory, name))).size;
    } catch {
      // 目录刚被清理：忽略这一条。
    }
  }
  return { files: names.length, bytes };
}

function renderPage(
  context: {
    config: Config;
    logDirectory: string;
    token: string;
  },
  status: LogStatus,
  exported: { path: string; bytes: number } | undefined,
): string {
  const rows = [
    ["版本", PLUGIN_VERSION],
    ["电脑名称", context.config.hostName],
    ["Relay", context.config.relay || "未配置"],
    ["数据目录", hostDataDir()],
    ["日志目录", context.logDirectory],
    ["日志占用", `${status.files} 个文件 · ${formatBytes(status.bytes)}`],
  ]
    .map(
      ([label, value]) =>
        `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("\n");

  const result = exported
    ? `<section class="result">
      <h2>诊断包已导出</h2>
      <p>文件：<code>${escapeHtml(exported.path)}</code></p>
      <p>大小：${formatBytes(exported.bytes)}。请自行把这个文件发给需要的维护者。</p>
    </section>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-host 设置</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px; line-height: 1.6; max-width: 760px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.lead { margin: 0 0 24px; opacity: .72; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,.25); vertical-align: top; }
  th { width: 120px; font-weight: 600; opacity: .78; }
  code { word-break: break-all; }
  button { font: inherit; padding: 9px 18px; border-radius: 8px; border: 1px solid rgba(127,127,127,.45); background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  section.result { margin-top: 24px; padding: 16px 18px; border-radius: 10px; background: rgba(37,99,235,.09); }
  section.result h2 { font-size: 17px; margin: 0 0 8px; }
  footer { margin-top: 32px; opacity: .6; font-size: 13px; }
</style>
</head>
<body>
<h1>agent-host 设置</h1>
<p class="lead">只在这台电脑上可访问。关闭命令行窗口或按 Ctrl+C 结束本页。</p>
<table>${rows}</table>
<form method="post" action="/diagnostics?token=${encodeURIComponent(context.token)}">
  <button type="submit">导出诊断包</button>
</form>
<p class="lead" style="margin-top:12px">诊断包包含本机日志、去掉凭据的配置和连接器设置，不会包含对话正文。</p>
${result}
<footer>agent-host ${escapeHtml(PLUGIN_VERSION)} · 页面只监听 127.0.0.1</footer>
</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html, "utf8");
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function send(response: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${message}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * 尽力打开系统浏览器；打不开只提示，不让设置页启动失败。
 * 返回 false 表示没有可用的打开方式。
 */
export function openInBrowser(url: string): boolean {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
