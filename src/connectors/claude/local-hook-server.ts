// Ported from botbus-protocol/Sources/BotBusConnectorKit/LocalHookServer.swift
// (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
//
// PORT: 上游自带一套最小 HTTP/1.1 解析并按平台实现监听（Network.framework /
// POSIX socket）。Node 的 `node:http` 在回环上提供等价的请求解析、Content-Length
// 与连接关闭语义，所以这里只复刻鉴权、挂起响应、超时与端口/密钥文件。回环监听
// 绑死 127.0.0.1；分块传输由 Node 接受（上游只认 Content-Length）。

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { OneShot } from "./claude-one-shot.js";

export type LocalHookRequest = {
  method: string;
  /** 原始请求目标，含 query。 */
  target: string;
  /** 去掉 query 的路径。 */
  path: string;
  /** 键一律小写。 */
  headers: Record<string, string>;
  body: Buffer;
};

export type LocalHookResponse = {
  status: number;
  contentType?: string;
  body?: Buffer;
};

export const NO_CONTENT: LocalHookResponse = { status: 204 };

export type LocalHookReply =
  | { kind: "now"; response: LocalHookResponse }
  | { kind: "hold"; hold: LocalHookServerHold };

export function nowReply(response: LocalHookResponse): LocalHookReply {
  return { kind: "now", response };
}

export function jsonReply(body: Buffer | string): LocalHookReply {
  return nowReply({
    status: 200,
    contentType: "application/json",
    body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
  });
}

/** 一个被挂起的响应。谁先到谁生效：answer、超时、连接断开。 */
export class LocalHookServerHold {
  readonly timeout: number;
  private readonly box = new OneShot<LocalHookResponse>();
  private readonly fallback: () => LocalHookResponse;

  constructor(timeout: number = LocalHookServer.defaultHoldTimeout, onTimeout: () => LocalHookResponse = () => NO_CONTENT) {
    this.timeout = timeout;
    this.fallback = onTimeout;
  }

  /** 第一个调用者生效返回 true；已经超时或断线过就返回 false。 */
  answer(response: LocalHookResponse): boolean {
    return this.box.resolve(response);
  }

  timedOut(): boolean {
    return this.box.resolve(this.fallback());
  }

  abandon(): boolean {
    return this.box.resolve({ status: 503 });
  }

  value(): Promise<LocalHookResponse> {
    return this.box.value();
  }
}

export type SharedSecretOptions = {
  fileName: string;
  enforcement: "required" | "whenPresent";
};

/**
 * 平台默认：macOS 带错拒绝、不带放行（兼容老脚本）；其余平台必须带。
 * 与上游 `SharedSecret.platformDefault` 一致。
 */
export function defaultSharedSecretOptions(): SharedSecretOptions {
  return {
    fileName: LocalHookServer.sharedSecret.defaultFileName,
    enforcement: process.platform === "darwin" ? "whenPresent" : "required",
  };
}

/**
 * Claude Code 的 hook 脚本 POST 进来的地方：监听绑 127.0.0.1 的随机高位端口。
 *
 * **为什么能"挂着不回"**：`PermissionRequest` 会一直阻塞在 HTTP 响应上等手机
 * 点允许或拒绝，所以 handler 可以返回一个 `Hold`。
 *
 * **鉴权**：每次 `start()` 换一个随机密钥写进只有本用户可读的文件，请求头不对
 * 就 403 空 body。
 */
export class LocalHookServer {
  /** 对齐 hook 脚本的 `curl --max-time`；30 分钟。 */
  static readonly defaultHoldTimeout = 1800;
  static readonly portFileName = "agent.json";
  static readonly defaultMaxBodyBytes = 1 << 20;

  static readonly sharedSecret = {
    headerName: "X-BotBus-Hook-Secret",
    defaultFileName: "agent-secret.curlrc",
  } as const;

  private readonly handler: (request: LocalHookRequest) => Promise<LocalHookReply>;
  readonly supportDirectory: string;
  private readonly portFileName: string | null;
  private readonly requestedPort: number | null;
  private readonly maxBodyBytes: number;
  private readonly sharedSecretOptions: SharedSecretOptions | null;
  private activeSecret: string | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port: number | null = null;

  constructor(options: {
    supportDirectory: string;
    portFileName?: string | null;
    maxBodyBytes?: number;
    requestedPort?: number | null;
    sharedSecret?: SharedSecretOptions | null;
    handler: (request: LocalHookRequest) => Promise<LocalHookReply>;
  }) {
    this.supportDirectory = options.supportDirectory;
    this.portFileName = options.portFileName === undefined ? LocalHookServer.portFileName : options.portFileName;
    this.maxBodyBytes = options.maxBodyBytes ?? LocalHookServer.defaultMaxBodyBytes;
    this.requestedPort = options.requestedPort ?? null;
    this.sharedSecretOptions = options.sharedSecret ?? null;
    this.handler = options.handler;
  }

  get portFileURL(): string | null {
    return this.portFileName === null ? null : join(this.supportDirectory, this.portFileName);
  }

  get secretFileURL(): string | null {
    return this.sharedSecretOptions
      ? join(this.supportDirectory, this.sharedSecretOptions.fileName)
      : null;
  }

  async start(): Promise<number> {
    if (this.server) throw new Error("alreadyRunning");
    this.rotateSecret();
    const server = createServer((request, response) => {
      void this.serve(request, response);
    });
    this.server = server;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.requestedPort ?? 0, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string" || address.port === 0) {
          reject(new Error("noPortAssigned"));
          return;
        }
        resolve(address.port);
      });
    });
    this.port = port;
    this.publish(port);
    return port;
  }

  /** 幂等：停监听、掐掉在跑的连接（挂着的响应会被放掉）、删端口文件与密钥文件。 */
  stop(): void {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) {
      server.close();
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    }
    const portFile = this.portFileURL;
    if (portFile) rmSync(portFile, { force: true });
    this.retractSecret();
  }

  private rotateSecret(): void {
    this.activeSecret = this.sharedSecretOptions ? randomBytes(32).toString("hex") : null;
  }

  private publish(port: number): void {
    this.writeSecretFile();
    this.writePortFile(port);
  }

  private writeSecretFile(): void {
    const path = this.secretFileURL;
    const secret = this.activeSecret;
    if (!path || !secret) return;
    try {
      mkdirSync(this.supportDirectory, { recursive: true });
      const line = `header = "${LocalHookServer.sharedSecret.headerName}: ${secret}"\n`;
      // PORT: Windows 没有 POSIX 0600 权限位；文件放在 %LOCALAPPDATA%\BotBus，
      // 依赖该目录继承的当前用户 ACL（上游用 Win32 私有 DACL）。
      writeFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // 写不出来：Windows/Linux 上的 hook 会全被 403（宁可收不到，也不放行）。
    }
  }

  private writePortFile(port: number): void {
    const path = this.portFileURL;
    if (!path) return;
    try {
      mkdirSync(this.supportDirectory, { recursive: true });
      writeFileSync(path, JSON.stringify({ port }), { encoding: "utf8", mode: 0o600 });
    } catch {
      // 写不了只是 hook 脚本找不到端口，服务本身照跑。
    }
  }

  private retractSecret(): void {
    this.activeSecret = null;
    const path = this.secretFileURL;
    if (path) rmSync(path, { force: true });
  }

  private rejection(request: IncomingMessage): LocalHookResponse | null {
    const options = this.sharedSecretOptions;
    if (!options) return null;
    const presented = request.headers[LocalHookServer.sharedSecret.headerName.toLowerCase()];
    const value = Array.isArray(presented) ? presented[0] : presented;
    if (value === undefined) {
      return options.enforcement === "required" ? { status: 403 } : null;
    }
    if (!this.activeSecret || !constantTimeEquals(value, this.activeSecret)) {
      return { status: 403 };
    }
    return null;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rejected = this.rejection(request);
    if (rejected) {
      sendJson(response, rejected);
      return;
    }
    if ((request.method ?? "").toUpperCase() !== "POST") {
      sendJson(response, { status: 405, contentType: "text/plain; charset=utf-8", body: Buffer.from("只支持 POST") });
      return;
    }
    const lengthHeader = request.headers["content-length"];
    const length = typeof lengthHeader === "string" ? Number(lengthHeader) : Number.NaN;
    if (!Number.isInteger(length) || length < 0) {
      sendJson(response, {
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: Buffer.from("缺少或非法的 Content-Length"),
      });
      return;
    }
    if (length > this.maxBodyBytes) {
      sendJson(response, {
        status: 413,
        contentType: "text/plain; charset=utf-8",
        body: Buffer.from("请求体过大"),
      });
      return;
    }
    const body = await readBody(request, this.maxBodyBytes);
    if (body === "too-large") {
      sendJson(response, {
        status: 413,
        contentType: "text/plain; charset=utf-8",
        body: Buffer.from("请求体过大"),
      });
      return;
    }
    if (body === null) {
      sendJson(response, {
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: Buffer.from("请求体不完整"),
      });
      return;
    }
    const target = request.url ?? "/";
    const headers: Record<string, string> = {};
    for (const [name, raw] of Object.entries(request.headers)) {
      if (raw === undefined) continue;
      headers[name.toLowerCase()] = Array.isArray(raw) ? raw.join(", ") : raw;
    }
    const hookRequest: LocalHookRequest = {
      method: (request.method ?? "").toUpperCase(),
      target,
      path: target.split("?", 1)[0] ?? target,
      headers,
      body,
    };

    let reply: LocalHookReply;
    try {
      reply = await this.handler(hookRequest);
    } catch {
      sendJson(response, { status: 500 });
      return;
    }
    if (reply.kind === "now") {
      sendJson(response, reply.response);
      return;
    }

    const hold = reply.hold;
    let settled = false;
    const onClose = () => {
      if (!settled) hold.abandon();
    };
    response.on("close", onClose);
    const timer = setTimeout(() => hold.timedOut(), hold.timeout * 1000);
    try {
      const result = await hold.value();
      settled = true;
      sendJson(response, result);
    } finally {
      settled = true;
      clearTimeout(timer);
      response.off("close", onClose);
    }
  }
}

function sendJson(response: ServerResponse, reply: LocalHookResponse): void {
  if (response.writableEnded) return;
  const status = reply.status;
  const headers: Record<string, string> = { Connection: "close" };
  const body = reply.body ?? Buffer.alloc(0);
  if (status !== 204) {
    if (reply.contentType) headers["Content-Type"] = reply.contentType;
    headers["Content-Length"] = String(body.length);
  }
  response.writeHead(status, headers);
  if (status !== 204) response.end(body);
  else response.end();
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null | "too-large"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(exceeded ? "too-large" : Buffer.concat(chunks)));
    request.on("error", () => resolve(null));
  });
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 支持目录：`%LOCALAPPDATA%\BotBus`（Windows），其余平台对应 Application Support / XDG。 */
export function defaultSupportDirectory(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local && local.length > 0) return join(local, "BotBus");
    return join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local", "BotBus");
  }
  if (process.platform === "darwin") {
    return join(process.env.HOME ?? process.cwd(), "Library", "Application Support", "BotBus");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "botbus");
  return join(process.env.HOME ?? process.cwd(), ".local", "share", "botbus");
}

/** 供调用方检查（测试里用临时目录）。 */
export function supportDirectoryExists(path: string): boolean {
  return existsSync(path);
}
