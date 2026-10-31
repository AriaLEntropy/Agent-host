/**
 * 从 Agent 回复的**未截断原文**里认出可以让手机取回的本机媒体文件路径
 * （协议 2.9 的 `Message.files`，spec §3.5）。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/TranscriptFileRefs.swift
 * (`candidates(in:)`, `resolve(_:projectPath:)`, `validate(path:projectPath:)`;
 * Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 分两步：`candidatesIn` 只看文字、不碰磁盘（读取器里调用）；`resolve` / `validate`
 * 才去查文件（分发器在发消息 / 取文件那一刻调用），因为读取器不知道任务的项目目录，
 * 而且"文件还在不在"要在发消息那一刻判断。
 *
 * 规则收得很紧（与上游一致）：
 * - 只认图片、视频、PDF 扩展名；
 * - 带 scheme（`https:`、`file:`）或 `://` 的一律不是本机路径；
 * - 三种来源：Markdown 链接目标（含 `<…>`）、反引号里的整段内容、裸路径；
 * - 每条回复最多 32 个候选，按出现顺序、原样去重。
 * - `resolve` / `validate`：realpath 后必须仍在项目目录内、项目内路径不能有点目录、
 *   真实文件扩展名必须是媒体类型，且必须是普通文件。
 */
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { platformPath } from "../../platform/path.js";

/** 上游 `TranscriptFileRefs.extensions`。 */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "mp4",
  "mov",
  "m4v",
  "pdf",
]);

/** 比 `PATH_MAX` 还长的不可能是本机路径（上游 `maxCandidateLength`）。 */
export const MAX_CANDIDATE_LENGTH = 1024;

/** 每条回复最多给这么多候选（上游 `maxCandidates`）。 */
export const MAX_CANDIDATES = 32;

/** 协议 2.9：单条消息最多 4 个文件卡片（上游 `maxFilesPerMessage`）。 */
export const MAX_FILES_PER_MESSAGE = 4;

/**
 * 媒体扩展名 → MIME。只覆盖 `MEDIA_EXTENSIONS`，取值与上游 `MediaType.portableTypes`
 * 在 macOS 上的答案逐字相同。
 */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  pdf: "application/pdf",
};

/** `resolve` 返回的文件卡片元数据；`artifactId` 由分发器按取回状态另外补。 */
export type ResolvedFileRef = {
  path: string;
  name: string;
  contentType: string;
  size: number;
};

/** Markdown 链接的目标：`](path)`、`](<带 空格 的路径>)`，允许带 `"标题"`。图片链接 `![…](…)` 同样命中。 */
const LINK_PATTERN =
  /\]\(\s*(?:<([^<>\n]+)>|([^\s()<>]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gu;

/** 行内代码。内容里可以有空格——带空格的路径只有放进反引号或尖括号才认。 */
const CODE_PATTERN = /`([^`\n]+)`/gu;

/**
 * 裸路径：一段连续的"路径字符"。中日韩文字与全角标点也当分隔——中文句子里路径常常
 * 紧贴着字写（"保存在out/a.png了"），代价是带中文名的文件要写在反引号里才认得出。
 */
const BARE_PATTERN =
  /[^\s"'`<>()\[\]{}|,;*“”‘’…　-〿＀-￯\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** `https:`、`file:` 这类带 scheme 的都不是本机路径。 */
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.\-]*:/u;

type FoundCandidate = { location: number; value: string };
type Range = [start: number, end: number];

/**
 * 回复里看起来像媒体文件路径的文本，按出现顺序、去重，最多 `MAX_CANDIDATES` 个。
 * **不查磁盘**，结果未经校验（与上游 `TranscriptFileRefs.candidates(in:)` 一致）。
 *
 * 三种来源：Markdown 链接目标、反引号里的整段内容、裸路径（绝对、`~/` 开头或相对）。
 * 反引号里整段不像路径、或带空格时（例如 `` `open a.png` ``），里面的内容按裸路径再扫一遍。
 */
export function candidatesIn(text: string): string[] {
  if (text.length === 0) return [];
  const found: FoundCandidate[] = [];
  // 已经按链接或代码认过的区间，裸路径扫描跳过它们：不然 `](<a b.png>)` 会再被拆出一个
  // `b.png`，`](https://x/y.png)` 会冒出一个 `//x/y.png`。
  const claimed: Range[] = [];

  for (const match of text.matchAll(LINK_PATTERN)) {
    const location = match.index ?? 0;
    claimed.push([location, location + match[0].length]);
    const target = match[1] ?? match[2];
    if (target === undefined) continue;
    const value = acceptCandidate(target);
    if (value !== null) found.push({ location, value });
  }

  for (const match of text.matchAll(CODE_PATTERN)) {
    const location = match.index ?? 0;
    const range: Range = [location, location + match[0].length];
    if (overlaps(range, claimed)) continue;
    const value = acceptCandidate(match[1] ?? "");
    if (value === null) continue;
    found.push({ location, value });
    // 带空格的整段可能是一条命令（`` `open out/a.png` ``），不占区间，里面的路径照样按裸路径再认一遍；
    // 多出来的候选（`my shots/a b.png` 里的 `b.png`）不存在就会在 resolve 时被丢掉。
    if (!/\s/u.test(value)) claimed.push(range);
  }

  for (const match of text.matchAll(BARE_PATTERN)) {
    const location = match.index ?? 0;
    const range: Range = [location, location + match[0].length];
    if (overlaps(range, claimed)) continue;
    const value = acceptCandidate(trimTrailingPunctuation(match[0]));
    if (value !== null) found.push({ location, value });
  }

  found.sort((left, right) => left.location - right.location);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of found) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    result.push(item.value);
    if (result.length >= MAX_CANDIDATES) break;
  }
  return result;
}

/** 一段文本能不能当候选：单行、不带 scheme、扩展名是媒体类型、扩展名前面有文件名。 */
function acceptCandidate(raw: string): string | null {
  const value = raw.trim();
  if (
    value.length === 0 ||
    value.length > MAX_CANDIDATE_LENGTH ||
    /[\r\n]/u.test(value) ||
    value.includes("://") ||
    SCHEME_PATTERN.test(value)
  ) {
    return null;
  }
  const name = lastPathComponent(value);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) return null;
  return value;
}

/** 句末的英文标点不算路径（"见 out/a.png." 里的点）。开头不用处理：扫描本来就从分隔符之后开始。 */
function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && ".:!?".includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

/** 上游 `NSString.lastPathComponent`；Windows 上两种分隔符都认。 */
function lastPathComponent(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function overlaps(range: Range, ranges: readonly Range[]): boolean {
  return ranges.some((other) => Math.min(range[1], other[1]) > Math.max(range[0], other[0]));
}

// MARK: - 校验（查磁盘）

/**
 * 把候选变成文件卡片：逐个校验，按真实路径去重，最多 `MAX_FILES_PER_MESSAGE` 个。
 * 项目目录为空、不存在或是"太宽"的目录（home、`/Users`、盘符根）时一个都不给。
 *
 * 只读：不跟随项目外的软链接、不读文件内容，只 `lstat` 取大小。
 */
export async function resolve(
  candidates: readonly string[],
  projectPath: string,
): Promise<ResolvedFileRef[]> {
  if (candidates.length === 0) return [];
  const root = await projectRoot(projectPath);
  if (root === null) return [];
  const refs: ResolvedFileRef[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (refs.length >= MAX_FILES_PER_MESSAGE) break;
    const ref = await validateUnder(candidate, root);
    if (ref === null || seen.has(ref.path)) continue;
    seen.add(ref.path);
    refs.push(ref);
  }
  return refs;
}

/**
 * 单个路径的完整校验，`resolve` 与 `fetchFile` 共用。通过时返回解析掉软链接后的
 * 真实路径与元数据，否则 null。
 *
 * 相对路径按项目目录解析；`~/` 展开成本机 home（`~user` 这种别人的 home 不认）。
 */
export async function validate(
  path: string,
  projectPath: string,
): Promise<ResolvedFileRef | null> {
  const root = await projectRoot(projectPath);
  if (root === null) return null;
  return validateUnder(path, root);
}

/**
 * 项目目录的真实路径。必须是绝对路径、存在的目录，且不能太宽
 * （见 `isAcceptableProjectRoot`）。返回 null 表示这个项目不能取文件。
 */
export async function projectRoot(projectPath: string): Promise<string | null> {
  const trimmed = projectPath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  let real: string;
  try {
    real = await realpath(trimmed);
  } catch {
    return null;
  }
  if (!isAcceptableProjectRoot(real, await currentHome())) return null;
  try {
    const info = await stat(real);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * 等于或包含这些目录的"项目"一律不认：在 home、`/Users` 里开的会话，项目根就成了
 * 整个用户目录，`~/Documents/合同.pdf`、`~/Desktop/证件.jpg` 全都"在项目里"。
 * 与上游 `broadRoots` 对齐；Windows 上额外挡掉系统盘上装所有人数据的几处。
 */
function broadRoots(): string[] {
  if (process.platform === "win32") {
    const environment = process.env;
    const drive = environment.SystemDrive ?? "C:";
    const roots = [
      `${drive}\\Users`,
      `${drive}\\Windows`,
      `${drive}\\Program Files`,
      `${drive}\\Program Files (x86)`,
      `${drive}\\ProgramData`,
    ];
    for (const key of ["TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) {
      const value = environment[key];
      if (value) roots.push(value);
    }
    return roots;
  }
  return [
    "/",
    "/Users",
    "/System",
    "/System/Volumes/Data",
    "/System/Volumes/Data/Users",
    "/Volumes",
    "/private",
    "/private/var",
    "/private/tmp",
    "/tmp",
    "/var",
    "/Library",
    "/Applications",
    "/opt",
    "/usr",
  ];
}

/** 当前用户 home 的真实路径。realpath 失败（几乎不会）就用原样，照样挡得住。 */
async function currentHome(): Promise<string> {
  const path = homedir();
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * `realRoot`（已 realpath）等于或是 home / `broadRoots` 里任一路径的祖先时拒绝。
 * **只拦本身与祖先，不拦后代**：home 下的子目录、临时目录、`/Volumes/盘/项目`
 * 都照常可用。按路径组件比，`/Users/alice2` 不是 `/Users/alice` 的祖先。
 */
export function isAcceptableProjectRoot(realRoot: string, home: string): boolean {
  if (!isAbsolute(realRoot)) return false;
  if (platformPath.isRoot(realRoot)) return false;
  return ![...broadRoots(), home].some(
    (forbidden) => platformPath.same(forbidden, realRoot) || platformPath.isInside(forbidden, realRoot),
  );
}

/**
 * 在已 realpath 的项目根下校验单个路径。所有判断都在读文件之前完成：
 * `realpath` 同时挡住 `../`、指向项目外的软链接和不存在的文件；前缀按路径组件比。
 */
async function validateUnder(raw: string, root: string): Promise<ResolvedFileRef | null> {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  let absolute: string;
  if (trimmed.startsWith("~/")) {
    absolute = join(homedir(), trimmed.slice(2));
  } else if (trimmed.startsWith("~")) {
    return null;
  } else if (isAbsolute(trimmed)) {
    absolute = trimmed;
  } else {
    absolute = resolvePath(root, trimmed);
  }

  // realpath 同时挡住三种逃逸：`../`、指向项目外的软链接、以及不存在的文件（抛错）。
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return null;
  }
  const rel = relative(root, real);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  // 只看项目根以下的各段：项目本身放在 `~/.work/` 之类的点目录里是用户的选择。
  if (rel.split(sep).some((component) => component.startsWith("."))) return null;

  // 扩展名按真实文件判断：项目里一个叫 `a.png` 的软链接指向 `notes.txt` 也不认。
  const extension = extname(real).slice(1).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) return null;
  const contentType = MEDIA_CONTENT_TYPES[extension];
  if (contentType === undefined) return null;

  try {
    const info = await lstat(real);
    // realpath 之后再 lstat：普通文件、不是软链接（目录、设备、FIFO 一律不认）。
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return { path: real, name: basename(real), contentType, size: info.size };
  } catch {
    return null;
  }
}

function normalizeForCompare(value: string): string {
  return value.replace(/[\\/]+$/u, "");
}

function isSamePath(left: string, right: string): boolean {
  return platformPath.same(normalizeForCompare(left), normalizeForCompare(right));
}

/** `child` 是否在 `root` 里面（按路径组件，不按字符串前缀）。 */
function isInside(child: string, root: string): boolean {
  return platformPath.isInside(normalizeForCompare(child), normalizeForCompare(root));
}

function isRootPath(value: string): boolean {
  return platformPath.isRoot(value);
}
