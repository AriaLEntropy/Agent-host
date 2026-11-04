/**
 * Host 侧的技能目录：从各 Agent 的 SKILL.md 读取「名称 + 描述 + 正文」
 *
 * ACP 只广播 slash command（name / description / input.hint），没有技能正文；
 * 正文只能由 Host 自己从本机技能目录读。这里不碰网络、不依赖具体连接器，
 * 只负责把已知根目录下的 SKILL.md 解析成协议里的统一形状
 *
 * 安全边界：
 * - 只扫描 skillRootsFor 给出的根目录，不接受手机传来的路径；
 * - 不跟随目录软链接（Windows 上 npx skills 默认就是复制）；
 * - SKILL.md 本身用 readFileByHandle 读：lstat + realpath + fd 核对，软链接不读；
 * - id 是根目录 + 技能目录的哈希，手机拿到的 id 不能反推出本机路径
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { BusSkill } from "../bus/store.js";
import { readFileByHandle } from "../platform/file-readability.js";

/** 一次 fetchSkills 最多返回的数量；超了置 truncated */
export const MAX_SKILLS = 100;
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
/** SKILL.md 正文上限；超过按 UTF-8 边界截断并标 truncated */
export const MAX_SKILL_BODY_BYTES = 64 * 1024;
/** 单个 SKILL.md 的硬上限；超过直接报错，不读进内存 */
const MAX_SKILL_FILE_BYTES = 1024 * 1024;

/** Host 内部多一个 path；绝不序列化给手机 */
export type ScannedSkill = BusSkill & {
  path: string;
};

/** 会话命令在前，文件技能在后；同名时保留会话命令（agent 更清楚自己的命令） */
export function mergeSessionSkills(
  session: readonly BusSkill[],
  files: readonly BusSkill[],
): BusSkill[] {
  const seen = new Set<string>();
  const merged: BusSkill[] = [];
  for (const skill of [...session, ...files]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    merged.push(skill);
  }
  return merged;
}

/** 这个连接器是否值得报 canListSkills；.agents/skills 是公共目录，所以 ACP 一律报 */
export function supportsSkillCatalog(input: SkillRootInput): boolean {
  return input.kind === "acp" || agentSkillDirs(input).length > 0;
}

export type SkillCatalog = {
  skills: ScannedSkill[];
  truncated: boolean;
  revision: string;
};

export type SkillRoot = {
  dir: string;
  source: "project" | "user";
};

export type SkillRootInput = {
  kind: string;
  connectorId?: string;
  projectPath?: string;
  /** 测试注入；默认 os.homedir() */
  home?: string;
};

/**
 * 各 Agent 的技能目录约定。没有列到的 ACP agent 只读跨客户端的 .agents/skills
 * 顺序就是优先级：项目级 agent 目录 > 项目级 .agents > 用户级 agent 目录 > 用户级 .agents
 */
function agentSkillDirs(input: SkillRootInput): string[] {
  const id = (input.connectorId ?? "").toLowerCase();
  const dirs: string[] = [];
  if (input.kind === "claude" || id.includes("claude")) dirs.push(".claude/skills");
  if (input.kind === "qwen" || id === "qwen-code" || id.includes("qwen")) dirs.push(".qwen/skills");
  if (input.kind === "codex" || id.includes("codex")) dirs.push(".codex/skills");
  if (input.kind === "opencode" || id === "opencode" || id.includes("opencode")) {
    dirs.push(".opencode/skills", ".opencode/skill");
  }
  if (input.kind === "dsh" || id === "dsh") dirs.push(".dsh/skills");
  return dirs;
}

export function skillRootsFor(input: SkillRootInput): SkillRoot[] {
  const home = resolve(input.home ?? homedir());
  const project = (input.projectPath ?? "").trim();
  const dirs = agentSkillDirs(input);
  const roots: SkillRoot[] = [];

  if (project) {
    for (const dir of dirs) roots.push({ dir: join(project, dir), source: "project" });
  }
  if (project) roots.push({ dir: join(project, ".agents", "skills"), source: "project" });
  for (const dir of dirs) roots.push({ dir: join(home, dir), source: "user" });
  roots.push({ dir: join(home, ".agents", "skills"), source: "user" });
  return roots;
}

/** 扫描全部根目录，按 name 去重（先出现的优先），按 name 排序 */
export async function scanSkills(input: SkillRootInput): Promise<SkillCatalog> {
  const seen = new Set<string>();
  const skills: ScannedSkill[] = [];
  let truncated = false;

  for (const root of skillRootsFor(input)) {
    if (truncated) break;
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (skills.length >= MAX_SKILLS) {
        truncated = true;
        break;
      }
      // 目录软链接不跟随：避免把 ~/.claude/skills 链到任意位置
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(root.dir, entry.name, "SKILL.md");
      const parsed = await readSkillDocument(path);
      if (!parsed) continue;
      const name = normalizeSkillName(parsed.name || entry.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      skills.push({
        id: skillIdFor(root.dir, entry.name),
        name,
        description: truncateText(parsed.description, MAX_SKILL_DESCRIPTION),
        kind: "skill",
        source: root.source,
        hasBody: true,
        path,
      });
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { skills, truncated, revision: revisionFor(skills) };
}

/** 按 id 重新读取正文；调用方先用 scanSkills 重建目录并确认 id 仍存在 */
export async function readSkillBody(
  skill: ScannedSkill,
): Promise<{ body: string; truncated: boolean }> {
  const bytes = await readFileByHandle(skill.path, { maxBytes: MAX_SKILL_FILE_BYTES });
  const parsed = parseSkillDocument(bytes.toString("utf8"));
  if (!parsed) return { body: "", truncated: false };
  const body = parsed.body;
  const buffer = Buffer.from(body, "utf8");
  if (buffer.length <= MAX_SKILL_BODY_BYTES) return { body, truncated: false };
  let end = MAX_SKILL_BODY_BYTES;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { body: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

/** 去掉 path，只留能进协议字段的部分 */
export function toBusSkill(skill: ScannedSkill): BusSkill {
  const { path: _path, ...wire } = skill;
  return wire;
}

export function skillIdFor(root: string, directory: string): string {
  const normalized = `${resolve(root)}${sep}${directory}`;
  return `sk_${createHash("sha256").update(normalized).digest("base64url").slice(0, 22)}`;
}

/** ACP 命令的 id：只由 connectorId + name 决定，不碰本机路径 */
export function commandSkillIdFor(connectorId: string, name: string): string {
  return `ac_${createHash("sha256")
    .update(`${connectorId}\0${name}`)
    .digest("base64url")
    .slice(0, 22)}`;
}

export function revisionFor(skills: readonly BusSkill[]): string {
  const hash = createHash("sha256");
  for (const skill of skills) {
    hash.update(
      `${skill.id}\0${skill.name}\0${skill.description}\0${skill.kind}\0${skill.source}\n`,
    );
  }
  return hash.digest("hex").slice(0, 16);
}

async function readSkillDocument(
  path: string,
): Promise<{ name: string; description: string; body: string } | null> {
  let bytes: Buffer;
  try {
    bytes = await readFileByHandle(path, { maxBytes: MAX_SKILL_FILE_BYTES });
  } catch {
    return null;
  }
  return parseSkillDocument(bytes.toString("utf8"));
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。只认 name / description / whenToUse 和
 * 简单的 `>` / `|` 块；解析不了就当没有 frontmatter，正文原样返回
 */
export function parseSkillDocument(
  text: string,
): { name: string; description: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { name: "", description: "", body: normalized };
  }
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      end = index;
      break;
    }
  }
  if (end < 0) return { name: "", description: "", body: normalized };
  const data = parseSimpleYaml(lines.slice(1, end));
  const description = data.description || data.whenToUse || "";
  return {
    name: data.name ?? "",
    description,
    body: lines.slice(end + 1).join("\n").replace(/^\n/, ""),
  };
}

function parseSimpleYaml(lines: string[]): Record<string, string> {
  const data: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (!next.trim()) {
          block.push("");
          index += 1;
          continue;
        }
        if (!/^\s/.test(next)) break;
        block.push(next.replace(/^\s+/, ""));
        index += 1;
      }
      value = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else {
      value = unquote(value);
    }
    data[key] = value;
  }
  return data;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function normalizeSkillName(raw: string): string {
  const name = raw.trim().replace(/^\/+/, "");
  if (!name || name.length > MAX_SKILL_NAME) return "";
  // slash command 名：ASCII、无空白、不以连字符开头；足够覆盖当前生态
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : "";
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}
