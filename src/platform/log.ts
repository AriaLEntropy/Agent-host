/**
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/PlatformLog.swift
 * (Apache-2.0), extended for the Agent-host file log required by FR-14.7.2.
 *
 * 隐私语义照搬上游 `os.Logger` 的替身：
 * - `.public` 原样打印；`.private` 打成 `<private>`；
 * - 不标注时，数值与 Bool 原样打印，其余（字符串、Error、对象）一律 `<private>`。
 *
 * 日志只写本机数据目录，按天滚动，保留 7 天且总量不超过 50 MiB。
 * 「导出诊断包」把日志与去掉凭据的配置打成 tar.gz，由用户自己发送。
 * 排查问题时设 `AGENT_HOST_LOG_PRIVATE=1` 关掉脱敏（进程启动时读一次）。
 */
import { appendFile, chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { hostDataDir, type Config } from "../config.js";
import { PLUGIN_VERSION } from "../tunnel/version.js";

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "fault";

export type LogRecord = {
  timestamp: string;
  level: LogLevel;
  subsystem: string;
  category: string;
  message: string;
  fields: Record<string, unknown>;
};

export type LogSink = (record: LogRecord) => void;

export interface PlatformLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  notice(message: string, fields?: Record<string, unknown>): void;
  warning(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  fault(message: string, fields?: Record<string, unknown>): void;
}

export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_TOTAL_LIMIT_BYTES = 50 * 1024 * 1024;
export const REDACTED = "<private>";
const SUBSYSTEM = "agent-host";
const LOG_FILE_PATTERN = /^agent-host-\d{4}-\d{2}-\d{2}\.log$/;

/** 显式公开一个值；不包的值按 `auto` 规则处理（字符串默认脱敏）。 */
class PublicLogValue {
  constructor(readonly value: unknown) {}
}

export function logPublic(value: unknown): PublicLogValue {
  return new PublicLogValue(value);
}

/**
 * 默认 stderr 出口。保留上游"一行一条、前缀 subsystem:category"的形状，
 * 但加上 ISO 时间，方便与文件日志对照。
 */
function stderrSink(record: LogRecord): void {
  process.stderr.write(`${formatLine(record)}\n`);
}

let activeSink: LogSink = stderrSink;
let fileSink: LogFileSink | undefined;

export function setLogSink(sink: LogSink | undefined): void {
  activeSink = sink ?? stderrSink;
}

function revealsPrivate(): boolean {
  return process.env.AGENT_HOST_LOG_PRIVATE === "1";
}

function formatLine(record: LogRecord): string {
  const fields = formatFields(record.fields);
  const suffix = fields.length > 0 ? ` ${fields}` : "";
  return `${record.timestamp} ${record.level.toUpperCase()} [${record.subsystem}:${record.category}] ${singleLine(record.message)}${suffix}`;
}

function formatFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [rawKey, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const key = rawKey.replace(/[^\w.-]/g, "_");
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

function formatValue(value: unknown): string {
  const reveal = revealsPrivate();
  if (value instanceof PublicLogValue) return formatPlain(value.value, true);
  return formatPlain(value, reveal);
}

function formatPlain(value: unknown, isPublic: boolean): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    case "string":
      return isPublic ? JSON.stringify(singleLine(value)) : REDACTED;
    case "object": {
      if (value instanceof Error) {
        if (!isPublic) return REDACTED;
        return JSON.stringify(singleLine(`${value.name}: ${value.message}`));
      }
      if (!isPublic) return REDACTED;
      try {
        return JSON.stringify(value);
      } catch {
        return REDACTED;
      }
    }
    default:
      return isPublic ? String(value) : REDACTED;
  }
}

function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** 按 subsystem/category 缓存；调用方拿到的是无状态小对象。 */
const loggerCache = new Map<string, PlatformLogger>();

export function createLogger(
  subsystem: string = SUBSYSTEM,
  category = "app",
): PlatformLogger {
  const key = `${subsystem}\u0000${category}`;
  const cached = loggerCache.get(key);
  if (cached) return cached;
  const emit = (level: LogLevel) => (message: string, fields: Record<string, unknown> = {}) => {
    activeSink({
      timestamp: new Date().toISOString(),
      level,
      subsystem,
      category,
      message,
      fields,
    });
  };
  const logger: PlatformLogger = {
    debug: emit("debug"),
    info: emit("info"),
    notice: emit("notice"),
    warning: emit("warning"),
    error: emit("error"),
    fault: emit("fault"),
  };
  loggerCache.set(key, logger);
  return logger;
}

// MARK: - 文件日志

export function defaultLogDirectory(): string {
  const override = process.env.AGENT_HOST_LOG_DIR?.trim();
  return override || join(hostDataDir(), "logs");
}

function dayStamp(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 按天追加的日志文件。写入串行排队；维护（清理过期/超量）每分钟最多跑一次。
 * 写失败只报一次 stderr，然后停用文件出口，不让日志把主流程拖垮。
 */
export class LogFileSink {
  private readonly directory: string;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();
  private prepared: Promise<void> | undefined;
  private nextMaintenance = 0;
  private currentDay = "";
  private disabled = false;
  private warned = false;

  constructor(directory: string = defaultLogDirectory(), now: () => Date = () => new Date()) {
    this.directory = directory;
    this.now = now;
  }

  get path(): string {
    return this.directory;
  }

  async start(): Promise<void> {
    await this.prepare();
  }

  write(record: LogRecord): void {
    if (this.disabled) return;
    const line = `${formatLine(record)}\n`;
    this.queue = this.queue
      .then(() => this.append(line))
      .catch(() => {
        this.disabled = true;
        if (!this.warned) {
          this.warned = true;
          process.stderr.write(`${formatLine({
            timestamp: new Date().toISOString(),
            level: "warning",
            subsystem: SUBSYSTEM,
            category: "log",
            message: "file log disabled after a write failure",
            fields: {},
          })}\n`);
        }
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private prepare(): Promise<void> {
    this.prepared ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700).catch(() => {});
      await cleanupLogs(this.directory, this.now());
      this.nextMaintenance = this.now().getTime() + 60_000;
    })();
    return this.prepared;
  }

  private async append(line: string): Promise<void> {
    await this.prepare();
    const now = this.now();
    if (now.getTime() >= this.nextMaintenance) {
      this.nextMaintenance = now.getTime() + 60_000;
      await cleanupLogs(this.directory, now).catch(() => 0);
    }
    const day = dayStamp(now);
    if (day !== this.currentDay) this.currentDay = day;
    const path = join(this.directory, `agent-host-${day}.log`);
    await appendFile(path, line, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
  }
}

/**
 * 删除 7 天前的日志；总量超过 50 MiB 时从最旧的删起（当前这天的最后删）。
 * 返回删除的文件数；目录不存在或读不了按 0 处理。
 */
export async function cleanupLogs(
  directory: string,
  now: Date = new Date(),
  options: { retentionMs?: number; totalLimitBytes?: number } = {},
): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => LOG_FILE_PATTERN.test(name));
  } catch {
    return 0;
  }
  const retention = options.retentionMs ?? LOG_RETENTION_MS;
  const limit = options.totalLimitBytes ?? LOG_TOTAL_LIMIT_BYTES;
  const files: { path: string; size: number; mtimeMs: number; name: string }[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({ path, size: info.size, mtimeMs: info.mtimeMs, name });
    } catch {
      // 另一个进程刚删掉：跳过。
    }
  }
  let removed = 0;
  const keep: typeof files = [];
  for (const file of files) {
    if (now.getTime() - file.mtimeMs > retention) {
      await unlink(file.path).catch(() => {});
      removed += 1;
    } else {
      keep.push(file);
    }
  }
  let total = keep.reduce((sum, file) => sum + file.size, 0);
  if (total > limit) {
    const byAge = keep.slice().sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    for (const file of byAge) {
      if (total <= limit) break;
      await unlink(file.path).catch(() => {});
      total -= file.size;
      removed += 1;
    }
  }
  return removed;
}

/**
 * 启动文件日志：每次启动调用一次；重复调用返回同一个出口。
 * `stderr: false` 只给测试用，避免把测试日志混进输出。
 */
export async function initializeLogging(options: {
  directory?: string;
  stderr?: boolean;
} = {}): Promise<LogFileSink> {
  if (fileSink) return fileSink;
  const sink = new LogFileSink(options.directory ?? defaultLogDirectory());
  await sink.start();
  fileSink = sink;
  setLogSink((record) => {
    if (options.stderr !== false) stderrSink(record);
    sink.write(record);
  });
  return sink;
}

export async function shutdownLogging(): Promise<void> {
  const sink = fileSink;
  fileSink = undefined;
  setLogSink(undefined);
  if (sink) await sink.flush();
}

// MARK: - 诊断包

export type DiagnosticFile = {
  name: string;
  data: Buffer;
  /** tar 里的权限位；默认 0600（诊断包只有本人要看）。 */
  mode?: number;
};

/** 只保留可公开的配置字段；任何名字像凭据的键一律打码。 */
export function redactedConfig(config: Config): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = /token|secret|password|credential|private|masterkey|e2eekey/i.test(key)
      ? REDACTED
      : value;
  }
  return result;
}

export function diagnosticSummary(now: Date = new Date()): Record<string, unknown> {
  return {
    app: SUBSYSTEM,
    version: PLUGIN_VERSION,
    generatedAt: now.toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    logRetentionDays: 7,
    logTotalLimitBytes: LOG_TOTAL_LIMIT_BYTES,
  };
}

/**
 * 导出诊断包：日志 + 脱敏配置 + 摘要。`extraFiles` 用于连接器设置这类
 * 不含凭据的本机文件，调用方负责挑。默认落在 `数据目录/diagnostics/`。
 */
export async function exportDiagnostics(options: {
  config: Config;
  outPath?: string;
  logDirectory?: string;
  extraFiles?: { name: string; path: string }[];
  now?: Date;
}): Promise<string> {
  const now = options.now ?? new Date();
  const directory = options.logDirectory ?? defaultLogDirectory();
  const entries: DiagnosticFile[] = [
    {
      name: "summary.json",
      data: Buffer.from(`${JSON.stringify(diagnosticSummary(now), null, 2)}\n`, "utf8"),
    },
    {
      name: "config.redacted.json",
      data: Buffer.from(`${JSON.stringify(redactedConfig(options.config), null, 2)}\n`, "utf8"),
    },
  ];

  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter((name) => LOG_FILE_PATTERN.test(name)).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    try {
      entries.push({ name: `logs/${name}`, data: await readFile(join(directory, name)) });
    } catch {
      // 日志刚被清理：跳过。
    }
  }
  for (const extra of options.extraFiles ?? []) {
    try {
      entries.push({ name: sanitizeArchiveName(extra.name), data: await readFile(extra.path) });
    } catch {
      // 可选文件不存在不算失败。
    }
  }

  const outPath =
    options.outPath ??
    join(
      hostDataDir(),
      "diagnostics",
      `agent-host-diagnostics-${formatStamp(now)}.tar.gz`,
    );
  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  await writeFile(outPath, createTarGz(entries, now), { mode: 0o600 });
  return outPath;
}

function formatStamp(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return stamp;
}

function sanitizeArchiveName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\.(\/|$)/g, "_");
}

/** 极简 ustar：只写普通文件，够诊断包用；不引入打包依赖。 */
export function createTarGz(entries: readonly DiagnosticFile[], now: Date = new Date()): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const name = sanitizeArchiveName(entry.name);
    if (Buffer.byteLength(name) > 100) {
      throw new Error(`diagnostic file name is too long: ${name}`);
    }
    blocks.push(tarHeader(name, entry.data.length, now.getTime(), entry.mode ?? 0o600));
    blocks.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  const gzipped = gzipSync(Buffer.concat(blocks), { level: 9 });
  // zlib 会把编译时的 OS 写进 gzip 头（Unix 0x03 / Windows 0x0a），同一份输入
  // 在不同系统上就会得到不同字节。改成 0xff（unknown），发布包才能跨系统复现。
  if (gzipped.length > 10 && gzipped[0] === 0x1f && gzipped[1] === 0x8b) {
    gzipped[9] = 0xff;
  }
  return gzipped;
}

function tarHeader(name: string, size: number, mtimeMs: number, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(mtimeMs / 1000));
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // '0' = regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, "0").slice(0, length - 1), offset, "ascii");
  buffer[offset + length - 1] = 0;
}
