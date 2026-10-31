/**
 * FR-14.7.1（无证书部分）：把构建产物 `dist/` 和几个文档打成一个可复现的
 * `.tar.gz` 发布包，并给出 `SHA256SUMS` 行。
 *
 * - 条目只有 `dist/` 下的普通文件，加上 package.json / README.md / NOTICE
 *   （LICENSE、LICENSE.md、LICENSE.txt 存在就带上）；
 * - 条目按名字排序，mtime 固定为 `RELEASE_MTIME`，压缩只用 `node:zlib`，
 *   所以同样的输入得到同样的字节（与文件系统时间、所在目录无关）；
 * - 凭据、配置、日志、临时文件、`node_modules`、发布输出目录一律跳过；
 * - 签名、公证、自动更新不在本文件范围内，后续由外部工具基于 SHA-256 做。
 *
 * tar 写入复用 `log.ts` 的 `createTarGz`（极简 ustar，只写普通文件），
 * 不引入打包依赖，也不改动 `log.ts`。
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTarGz, type DiagnosticFile } from "./log.js";

/** 默认输出目录：`<仓库>/release/`。脚本 `scripts/package-release.ts` 用同一默认值。 */
export const DEFAULT_RELEASE_DIRECTORY = "release";

/**
 * 所有 tar 条目的固定 mtime（1970-01-01T00:00:00Z，SOURCE_DATE_EPOCH 约定）。
 * 固定时间才能让同一份输入重复打包得到同一份字节。
 */
export const RELEASE_MTIME = new Date(0);

/** 必带的仓库文档，缺任何一个都直接报错。 */
const REQUIRED_DOCUMENTS = ["README.md", "NOTICE"] as const;

/** 有就带上的许可证文件。 */
const OPTIONAL_DOCUMENTS = ["LICENSE", "LICENSE.md", "LICENSE.txt"] as const;

/** 任意层级都跳过的目录名（小写比较）。 */
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "coverage",
  "logs",
  "diagnostics",
  ".tmp",
  "tmp",
  "temp",
  "release",
  "dist-packages",
  "local",
  ".cache",
  ".idea",
  ".vscode",
]);

/** 文件名精确匹配就跳过：本机配置/凭据与系统垃圾文件。 */
const EXCLUDED_FILE_NAMES = new Set([
  "config.json",
  "config.local.json",
  "credentials.json",
  "credential.json",
  "secrets.json",
  "secret.json",
  "tokens.json",
  "token.json",
  "sha256sums",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
]);

/** 扩展名命中就跳过：密钥、证书、日志、临时文件与旧压缩包。 */
const EXCLUDED_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".p7b",
  ".p8",
  ".der",
  ".csr",
  ".cer",
  ".crt",
  ".jks",
  ".keystore",
  ".log",
  ".tmp",
  ".temp",
  ".tsbuildinfo",
  ".tgz",
  ".tar",
  ".gz",
  ".zip",
]);

export class ReleasePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleasePackageError";
  }
}

export type ReleasePackageOptions = {
  /** 仓库根目录（含 package.json、dist/）。 */
  root: string;
  /** 覆盖 package.json 里的版本号；默认读 package.json。 */
  version?: string;
  /** 覆盖 `dist/` 位置；默认 `<root>/dist`。 */
  distDir?: string;
  /** 覆盖文件名里的平台段；默认 `process.platform`。 */
  platform?: string;
  /** 覆盖文件名里的架构段；默认 `process.arch`。 */
  arch?: string;
  /** 覆盖固定 mtime；测试或 CI 一般不需要改。 */
  mtime?: Date;
};

export type ReleasePackage = {
  /** package.json 里的版本号（或显式覆盖值）。 */
  version: string;
  /** `agent-host-<version>-<platform>-<arch>.tar.gz`。 */
  fileName: string;
  /** gzip 后的归档字节。 */
  data: Buffer;
  /** 归档字节的十六进制 SHA-256。 */
  sha256: string;
  /** SHA256SUMS 里的一行：`<hex>  <fileName>`（两个空格）。 */
  checksumLine: string;
  /** 归档内的条目名，按写入顺序（已排序）。 */
  entries: string[];
};

export type WrittenReleasePackage = ReleasePackage & {
  /** 归档的落盘路径。 */
  path: string;
  /** `SHA256SUMS` 的落盘路径（与归档同目录）。 */
  checksumPath: string;
  /** `SHA256SUMS` 的完整内容（可能包含同目录其他归档的行）。 */
  checksumText: string;
};

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeToken(value: string, fallback: string): string {
  const token = value
    .trim()
    .replace(/[^0-9A-Za-z._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return token || fallback;
}

/** 发布包文件名：`agent-host-<version>-<platform>-<arch>.tar.gz`。 */
export function releaseFileName(
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `agent-host-${safeToken(version, "0.0.0")}-${safeToken(platform, "unknown")}-${safeToken(arch, "unknown")}.tar.gz`;
}

/** 十六进制（小写）SHA-256。 */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isExcludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXCLUDED_FILE_NAMES.has(lower)) return true;
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  const dot = lower.lastIndexOf(".");
  const extension = dot >= 0 ? lower.slice(dot) : "";
  return EXCLUDED_EXTENSIONS.has(extension);
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.has(name.toLowerCase());
}

async function statQuiet(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function readFileIfPresent(path: string): Promise<Buffer | undefined> {
  const info = await statQuiet(path);
  if (!info?.isFile()) return undefined;
  return readFile(path);
}

async function readRequiredFile(path: string, label: string): Promise<Buffer> {
  const data = await readFileIfPresent(path);
  if (!data) throw new ReleasePackageError(`missing required release file: ${label} (${path})`);
  return data;
}

/** `lstat` 版本：不跟随符号链接，用来确认发布内容真的是普通文件/目录。 */
async function lstatQuiet(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

/**
 * 从 package.json 找真正的入口：优先 `bin["agent-host"]`，其次 `bin` 的第一个值，
 * 再退到 `main`，最后才是旧约定 `dist/cli.js`。入口必须落在 `dist/` 里，
 * 否则打出来的包一定跑不起来。
 */
function readEntryPoint(packageBytes: Buffer, packagePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageBytes.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReleasePackageError(`package.json is not valid JSON (${packagePath}): ${detail}`);
  }
  const manifest = (parsed ?? {}) as {
    bin?: unknown;
    main?: unknown;
  };
  let candidate: unknown;
  if (typeof manifest.bin === "string") {
    candidate = manifest.bin;
  } else if (manifest.bin && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)) {
    const values = Object.values(manifest.bin as Record<string, unknown>);
    candidate = values.find((value) => typeof value === "string");
  }
  if (typeof candidate !== "string" || !candidate.trim()) candidate = manifest.main;
  const entry =
    typeof candidate === "string" && candidate.trim() ? candidate.trim() : "dist/cli.js";

  const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized.startsWith("dist/") || normalized.length <= "dist/".length) {
    throw new ReleasePackageError(
      `package entry point must be inside dist/: ${JSON.stringify(entry)}`,
    );
  }
  return normalized;
}

async function assertDist(distDir: string, entry: string): Promise<void> {
  const directory = await lstatQuiet(distDir);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) {
    throw new ReleasePackageError(
      `dist directory is missing or a symlink: ${distDir}. Run \`npm run build\` before packaging.`,
    );
  }
  const relative = entry.slice("dist/".length);
  const file = await lstatQuiet(join(distDir, relative));
  if (!file?.isFile() || file.isSymbolicLink()) {
    throw new ReleasePackageError(
      `${entry} is missing or a symlink: ${join(distDir, relative)}. Run \`npm run build\` before packaging.`,
    );
  }
}

/**
 * 递归收集 `dist/` 下的普通文件；跳过符号链接、被排除的目录与文件。
 * 入口脚本设成 0755，其余 0644，解包后可以直接运行。
 */
async function collectDistEntries(
  distDir: string,
  entry: string,
): Promise<DiagnosticFile[]> {
  const entries: DiagnosticFile[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReleasePackageError(`cannot read dist directory ${directory}: ${detail}`);
    }
    dirents.sort((left, right) => compareNames(left.name, right.name));
    for (const dirent of dirents) {
      const fullPath = join(directory, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (isExcludedDirectory(dirent.name)) continue;
        await walk(fullPath, `${prefix}${dirent.name}/`);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (isExcludedFile(dirent.name)) continue;
      const name = `${prefix}${dirent.name}`;
      entries.push({
        name,
        data: await readFile(fullPath),
        mode: name === entry ? 0o755 : 0o644,
      });
    }
  };
  await walk(distDir, "dist/");
  return entries;
}

function readVersion(packageBytes: Buffer, packagePath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageBytes.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReleasePackageError(`package.json is not valid JSON (${packagePath}): ${detail}`);
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new ReleasePackageError(`package.json must have a non-empty "version": ${packagePath}`);
  }
  return version;
}

/**
 * 组装发布包但不落盘。同样的 root/版本/平台/架构与输入内容，必得同样的字节。
 */
export async function buildReleasePackage(
  options: ReleasePackageOptions,
): Promise<ReleasePackage> {
  const root = options.root;
  if (!root) throw new ReleasePackageError("release root is required");

  const packagePath = join(root, "package.json");
  const packageBytes = await readRequiredFile(packagePath, "package.json");
  const version = options.version ?? readVersion(packageBytes, packagePath);
  const entry = readEntryPoint(packageBytes, packagePath);

  const entries: DiagnosticFile[] = [
    { name: "package.json", data: packageBytes, mode: 0o644 },
  ];
  for (const name of REQUIRED_DOCUMENTS) {
    entries.push({ name, data: await readRequiredFile(join(root, name), name), mode: 0o644 });
  }
  for (const name of OPTIONAL_DOCUMENTS) {
    const data = await readFileIfPresent(join(root, name));
    if (data) entries.push({ name, data, mode: 0o644 });
  }

  const distDir = options.distDir ?? join(root, "dist");
  await assertDist(distDir, entry);
  entries.push(...(await collectDistEntries(distDir, entry)));
  entries.sort((left, right) => compareNames(left.name, right.name));
  if (!entries.some((item) => item.name === entry)) {
    throw new ReleasePackageError(
      `${entry} was not collected (symlink or excluded file); the package would not start`,
    );
  }
  for (const item of entries) {
    if (Buffer.byteLength(item.name) > 100) {
      throw new ReleasePackageError(
        `archive entry name exceeds the ustar 100-byte limit: ${item.name}`,
      );
    }
  }

  const data = createTarGz(entries, options.mtime ?? RELEASE_MTIME);
  const sha256 = sha256Hex(data);
  const fileName = releaseFileName(version, options.platform, options.arch);
  return {
    version,
    fileName,
    data,
    sha256,
    checksumLine: `${sha256}  ${fileName}`,
    entries: entries.map((entry) => entry.name),
  };
}

/**
 * 写归档和同目录的 `SHA256SUMS`。已有 `SHA256SUMS` 里其他文件的行会保留，
 * 同一文件的行会被替换，整体按文件名排序，方便一次目录里放多个平台包。
 */
export async function writeReleasePackage(
  options: ReleasePackageOptions & { outDir?: string },
): Promise<WrittenReleasePackage> {
  const outDir = options.outDir ?? join(options.root, DEFAULT_RELEASE_DIRECTORY);
  const built = await buildReleasePackage(options);
  await mkdir(outDir, { recursive: true });

  const path = join(outDir, built.fileName);
  await writeFileAtomic(path, built.data);

  const checksumPath = join(outDir, "SHA256SUMS");
  const checksumText = await mergeChecksums(
    outDir,
    checksumPath,
    built.checksumLine,
    built.fileName,
  );
  await writeFileAtomic(checksumPath, Buffer.from(checksumText, "utf8"));

  return { ...built, path, checksumPath, checksumText };
}

/** 同目录临时文件 + rename；中途失败不会留下半截文件。 */
async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(temp, data, { mode: 0o644 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function isPlainFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

/**
 * 合并同目录的 `SHA256SUMS`：替换同名行、丢掉已不存在的文件和可疑路径、
 * 按文件名排序。多平台包放在同一目录时不会互相覆盖，也不会留下旧行。
 */
async function mergeChecksums(
  outDir: string,
  checksumPath: string,
  line: string,
  fileName: string,
): Promise<string> {
  let existing: string[] = [];
  try {
    existing = (await readFile(checksumPath, "utf8"))
      .split(/\r?\n/)
      .filter((entry) => /^[0-9a-f]{64} {2}\S/.test(entry));
  } catch {
    existing = [];
  }
  const kept: string[] = [];
  for (const entry of existing) {
    const name = entry.slice(66);
    if (name === fileName || !isPlainFileName(name)) continue;
    const info = await statQuiet(join(outDir, name));
    if (info?.isFile()) kept.push(entry);
  }
  kept.push(line);
  kept.sort((left, right) => compareNames(left.slice(66), right.slice(66)));
  return `${kept.join("\n")}\n`;
}
