/**
 * Ported from botbus-protocol/Sources/BotBusConnectorKit/WorktreeResolver.swift
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * A session opened inside a git worktree belongs to the main repository
 * (protocol 2.7/3.4): the snapshot groups it under the repository path while the
 * real cwd stays in `worktreePath`. Resolution is intentionally cheap and
 * privacy-conscious:
 * - `<repo>/.claude/worktrees/<name>` (Claude app) and its subdirectories are
 *   mapped back by path shape alone; nothing is read from disk.
 * - Other paths are only inspected when one of their parent directories is
 *   named `worktrees`. The async resolver asks `git worktree list --porcelain`
 *   (execFile, no shell, per-invocation config only); the sync resolver reads
 *   the worktree's `.git` file (`gitdir: <repo>/.git/worktrees/<name>`).
 * - A cwd inside a subdirectory of a worktree maps to the same subdirectory of
 *   the main repository (`<wt>/web` -> `<repo>/web`).
 * - Paths without a `worktrees` directory are never inspected; manually added
 *   worktrees elsewhere stay ordinary projects. Submodules, bare repositories
 *   and `.git` directories are not worktrees.
 *
 * Recognized mappings are persisted in `worktrees.json` so a deleted Codex
 * worktree can still be grouped after a restart. A deleted worktree that was
 * never recorded falls back to the only known project/repository with the same
 * directory name (Codex names worktrees after the repository); ambiguity is
 * never guessed. Misses are retried after 60 seconds because the directory or
 * its `.git` file may appear shortly after the first observation.
 *
 * This module is read-only with respect to git: it never writes refs, deletes
 * worktrees, or changes the user's git configuration. `mergeWorktree` execution
 * is deliberately left to the caller.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createLogger } from "../platform/log.js";
import { platformPath } from "../platform/path.js";
import { readJsonFile, writeJsonFileAtomic } from "./atomic-json.js";
import { hostDataDir } from "../config.js";

export const WORKTREE_MISS_RETRY_MS = 60_000;
export const MAX_ARCHIVED_WORKTREES = 1_000;
export const CLAUDE_WORKTREES_MARKER = "/.claude/worktrees/";

const WINDOWS_CLAUDE_MARKER = "\\.claude\\worktrees\\";
const ARCHIVE_VERSION = 1;

const log = createLogger("agent-host", "worktrees");

export type GitRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * Runs git without a shell. The default runner is `execFile("git", args)` and
 * only ever runs read-only commands; tests inject their own runner.
 */
export type GitRunner = (args: readonly string[]) => Promise<GitRunResult>;

export type GitWorktreeInfo = {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  locked?: string;
  prunable?: string;
};

export type GitWorktreeResolution =
  | { status: "resolved"; root: string }
  | { status: "not-worktree" }
  | { status: "unavailable" };

export type WorktreeEntry = {
  path: string;
  root: string;
};

export type WorktreeResolverOptions = {
  /**
   * `worktrees.json` location. Omitted/null keeps mappings in memory only, which
   * is the test default; the app passes `defaultWorktreeArchivePath()`.
   */
  archivePath?: string | null;
  now?: () => Date;
  git?: GitRunner;
  maxArchivedEntries?: number;
  missRetryIntervalMs?: number;
};

/** App data location for the mapping archive (`…/agent-host/worktrees.json`). */
export function defaultWorktreeArchivePath(): string {
  return join(hostDataDir(), "worktrees.json");
}

/** Trim whitespace and trailing separators; on Windows both separator styles are accepted. */
export function normalizeWorktreePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return platformPath.normalized(trimmed);
}

/**
 * Claude app layout only: `<repo>/.claude/worktrees/<name>[/sub]` -> `<repo>[/sub]`.
 * Purely lexical; the directory may already be deleted.
 */
export function resolveByShape(rawPath: string): string | null {
  const path = normalizeWorktreePath(rawPath);
  if (!path) return null;
  let position = path.lastIndexOf(CLAUDE_WORKTREES_MARKER);
  let marker = CLAUDE_WORKTREES_MARKER;
  if (platformPath.platform === "win32") {
    const windowsPosition = path.lastIndexOf(WINDOWS_CLAUDE_MARKER);
    if (windowsPosition > position) {
      position = windowsPosition;
      marker = WINDOWS_CLAUDE_MARKER;
    }
  }
  if (position <= 0) return null;
  const repository = path.slice(0, position);
  if (!repository || platformPath.isRoot(repository)) return null;
  const rest = path.slice(position + marker.length);
  if (!rest) return null;
  const separatorPattern = platformPath.platform === "win32" ? /[\\/]/ : /\//;
  const separatorIndex = rest.search(separatorPattern);
  if (separatorIndex < 0) return repository;
  const separator = rest[separatorIndex] ?? platformPath.separator;
  const subpath = normalizeWorktreePath(rest.slice(separatorIndex + 1));
  if (!subpath || subpath === "/" || subpath === "\\" || platformPath.isRoot(subpath)) {
    return repository;
  }
  return repoJoin(repository, separator, subpath);
}

/**
 * Index (into `platformPath.components`) of the last `worktrees` component that
 * is a *parent* of `path`. The path itself being `…/worktrees` does not count.
 */
export function worktreesComponentIndex(rawPath: string): number | null {
  const path = normalizeWorktreePath(rawPath);
  if (!path) return null;
  const parts = platformPath.components(path);
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] === "worktrees") return index;
  }
  return null;
}

/**
 * Read a worktree's `.git` file:
 * `gitdir: <repo>/.git/worktrees/<name>` (git may write relative paths).
 * Returns the main repository directory, or null for submodules, bare
 * repositories and non-worktree shapes.
 */
export function mainRepositoryFromGitFile(dotGitFile: string): string | null {
  let content: string;
  try {
    content = readFileSync(dotGitFile, "utf8");
  } catch {
    return null;
  }
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith("gitdir:"));
  if (!line) return null;
  const value = line.slice("gitdir:".length).trim();
  if (!value) return null;
  const base = dirname(dotGitFile);
  const absolute = platformPath.isAbsolute(value) ? value : platformPath.join(base, value);
  const gitdir = platformPath.normalized(resolvePath(absolute));
  if (!gitdir) return null;
  const worktreesDirectory = dirname(gitdir);
  const commonDirectory = dirname(worktreesDirectory);
  if (lastComponent(worktreesDirectory) !== "worktrees") return null;
  if (lastComponent(commonDirectory) !== ".git") return null;
  const root = platformPath.normalized(dirname(commonDirectory));
  if (!root || platformPath.isRoot(root)) return null;
  return root;
}

/**
 * Synchronous, disk-light resolution: climb from `path` toward (but not past)
 * the nearest `worktrees` parent and inspect the first `.git`.
 *
 * A `.git` directory, a submodule gitdir (`…/.git/modules/…`) or a bare
 * repository shape is not a worktree. When `path` is a subdirectory of the
 * worktree the result is the same subdirectory under the main repository.
 */
export function resolveOnDisk(rawPath: string): string | null {
  const path = normalizeWorktreePath(rawPath);
  if (!path) return null;
  const markerIndex = worktreesComponentIndex(path);
  if (markerIndex === null) return null;
  const parts = platformPath.components(path);
  let directory = path;
  const climbed: string[] = [];
  const steps = parts.length - markerIndex - 1;
  for (let step = 0; step < steps; step += 1) {
    const dotGit = platformPath.join(directory, ".git");
    let gitIsFile = false;
    try {
      gitIsFile = statSync(dotGit).isFile();
    } catch {
      gitIsFile = false;
    }
    if (gitIsFile) {
      const root = mainRepositoryFromGitFile(dotGit);
      if (!root) return null;
      if (climbed.length === 0) return root;
      return platformPath.join(root, climbed.slice().reverse().join(platformPath.separator));
    }
    if (existsSync(dotGit)) return null;
    climbed.push(lastComponent(directory));
    directory = dirname(directory);
  }
  return null;
}

/** Git global flags: read-only, no optional lock, no external fsmonitor, no prompts. */
export function gitWorktreeListArgs(path: string): string[] {
  return [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    path,
    "worktree",
    "list",
    "--porcelain",
  ];
}

/** `execFile`-based runner; never uses a shell and never writes git config. */
export function createGitRunner(): GitRunner {
  return (args) =>
    new Promise<GitRunResult>((settle) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      };
      // `-C` must decide the repository; inherited repository selectors would
      // silently point git at a different checkout.
      for (const key of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      ]) {
        delete env[key];
      }
      execFile(
        "git",
        [...args],
        {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          env,
        },
        (error, stdout, stderr) => {
          const failure = error as (Error & { code?: number | string }) | null;
          const code = failure ? (typeof failure.code === "number" ? failure.code : 1) : 0;
          settle({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
}

export const defaultGitRunner: GitRunner = createGitRunner();

/** Parse `git worktree list --porcelain` output. */
export function parseWorktreeListPorcelain(output: string): GitWorktreeInfo[] {
  const entries: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine === "") {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const space = rawLine.indexOf(" ");
    const key = space < 0 ? rawLine : rawLine.slice(0, space);
    const value = space < 0 ? "" : rawLine.slice(space + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value };
      continue;
    }
    if (!current) continue;
    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      case "locked":
        current.locked = value;
        break;
      case "prunable":
        current.prunable = value;
        break;
      default:
        break;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Resolve a worktree path using `git worktree list --porcelain`.
 *
 * The first entry is the main worktree; linked worktrees follow it. The result
 * carries the main repository plus the subdirectory of the queried worktree.
 * `unavailable` means git could not answer (missing binary, not a repository,
 * timeout) and the caller may fall back to `resolveOnDisk`.
 */
export async function resolveWorktreeWithGit(
  rawPath: string,
  run: GitRunner = defaultGitRunner,
): Promise<GitWorktreeResolution> {
  const path = normalizeWorktreePath(rawPath);
  if (!path) return { status: "not-worktree" };
  let result: GitRunResult;
  try {
    result = await run(gitWorktreeListArgs(path));
  } catch {
    return { status: "unavailable" };
  }
  if (!result || result.code !== 0) return { status: "unavailable" };
  const entries = parseWorktreeListPorcelain(result.stdout).filter((entry) => entry.path.length > 0);
  if (entries.length === 0) return { status: "not-worktree" };

  const target = platformPath.canonical(path);
  let matchedIndex = -1;
  let matchedLength = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const root = platformPath.canonical(normalizeWorktreePath(entry.path));
    if (!root) continue;
    const inside = platformPath.relativePathOf(target, root) !== null;
    if (!inside && !platformPath.same(target, root)) continue;
    if (root.length > matchedLength) {
      matchedIndex = index;
      matchedLength = root.length;
    }
  }
  if (matchedIndex < 0) return { status: "not-worktree" };
  const main = entries[0];
  const matched = entries[matchedIndex];
  if (!main || !matched || main.bare || matched.bare) return { status: "not-worktree" };
  // The main worktree itself is not a worktree session.
  if (matchedIndex === 0) return { status: "not-worktree" };

  const mainRoot = platformPath.canonical(normalizeWorktreePath(main.path));
  const matchedRoot = platformPath.canonical(normalizeWorktreePath(matched.path));
  if (!mainRoot || !matchedRoot) return { status: "not-worktree" };
  if (platformPath.isRoot(mainRoot) || platformPath.isRoot(matchedRoot)) {
    return { status: "not-worktree" };
  }
  const relative = platformPath.relativePathOf(target, matchedRoot) ?? "";
  const root = relative ? platformPath.join(mainRoot, relative) : mainRoot;
  return { status: "resolved", root };
}

/**
 * Worktree → main repository resolver with a path cache, retryable misses,
 * same-name fallback and optional `worktrees.json` persistence.
 *
 * `projectRoot()` is the synchronous upstream-compatible path (`.git` file
 * inspection). `projectRootAsync()` prefers `git worktree list --porcelain` and
 * falls back to the synchronous path when git is unavailable. Callers that only
 * stamp tasks can use the sync method; callers that can await should use the
 * async method.
 */
export class WorktreeResolver {
  private readonly known = new Map<string, string>();
  private readonly misses = new Map<string, { retryAt: number; exists: boolean }>();
  /** Directory name -> identity key -> the path spelling first seen. */
  private readonly candidates = new Map<string, Map<string, string>>();
  private readonly archivePath: string | null;
  private readonly now: () => Date;
  private readonly git: GitRunner;
  private readonly maxArchivedEntries: number;
  private readonly missRetryIntervalMs: number;

  constructor(options: WorktreeResolverOptions = {}) {
    const archive = options.archivePath?.trim();
    this.archivePath = archive ? archive : null;
    this.now = options.now ?? (() => new Date());
    this.git = options.git ?? defaultGitRunner;
    this.maxArchivedEntries = Math.max(0, options.maxArchivedEntries ?? MAX_ARCHIVED_WORKTREES);
    this.missRetryIntervalMs = Math.max(0, options.missRetryIntervalMs ?? WORKTREE_MISS_RETRY_MS);
    this.loadArchive();
  }

  get path(): string | null {
    return this.archivePath;
  }

  get size(): number {
    return this.known.size;
  }

  /** Persisted mappings in recognition order (oldest first). */
  entries(): WorktreeEntry[] {
    return [...this.known].map(([path, root]) => ({ path, root }));
  }

  knownRoot(rawPath: string): string | null {
    return this.known.get(normalizeWorktreePath(rawPath)) ?? null;
  }

  /** Bind a worktree (for example a newly created one) to its main repository and persist it. */
  remember(worktreePath: string, root: string): boolean {
    const path = normalizeWorktreePath(worktreePath);
    const repository = normalizeWorktreePath(root);
    if (!path || !repository) return false;
    this.misses.delete(path);
    this.record(path, repository);
    return true;
  }

  /** Drop one stored mapping (memory and, when configured, disk). */
  forget(worktreePath: string): boolean {
    const path = normalizeWorktreePath(worktreePath);
    if (!path || !this.known.delete(path)) return false;
    this.save();
    return true;
  }

  /** Test/reset hook: clear memory only; the archive file is kept. */
  reset(): void {
    this.known.clear();
    this.misses.clear();
    this.candidates.clear();
  }

  /** Re-read `worktrees.json` into memory. */
  reload(): void {
    this.known.clear();
    this.misses.clear();
    this.candidates.clear();
    this.loadArchive();
  }

  /**
   * Synchronous resolution. Returns null for ordinary projects and paths
   * without a `worktrees` directory; such paths are remembered as same-name
   * fallback candidates.
   */
  projectRoot(rawPath: string): string | null {
    const path = normalizeWorktreePath(rawPath);
    if (!path) return null;
    const shape = resolveByShape(path);
    if (shape) {
      this.noteCandidate(shape);
      return shape;
    }
    if (worktreesComponentIndex(path) === null) {
      this.noteCandidate(path);
      return null;
    }
    const known = this.known.get(path);
    if (known !== undefined) return known;
    const miss = this.misses.get(path);
    const now = this.now().getTime();
    if (miss && now < miss.retryAt) {
      return miss.exists ? null : this.sameNamedRoot(path);
    }
    const root = resolveOnDisk(path);
    if (!root) {
      const exists = existsSync(path);
      this.misses.set(path, { retryAt: now + this.missRetryIntervalMs, exists });
      return exists ? null : this.sameNamedRoot(path);
    }
    this.misses.delete(path);
    this.record(path, root);
    return root;
  }

  /**
   * Git-backed resolution (read-only). Known mappings win to keep repeated
   * stamping cheap; pass `{ refresh: true }` to ask git again.
   */
  async projectRootAsync(
    rawPath: string,
    options: { refresh?: boolean } = {},
  ): Promise<string | null> {
    const path = normalizeWorktreePath(rawPath);
    if (!path) return null;
    const shape = resolveByShape(path);
    if (shape) {
      this.noteCandidate(shape);
      return shape;
    }
    if (worktreesComponentIndex(path) === null) {
      this.noteCandidate(path);
      return null;
    }
    if (!options.refresh) {
      const known = this.known.get(path);
      if (known !== undefined) return known;
      const miss = this.misses.get(path);
      const now = this.now().getTime();
      if (miss && now < miss.retryAt) {
        return miss.exists ? null : this.sameNamedRoot(path);
      }
    }
    const result = await resolveWorktreeWithGit(path, this.git);
    if (result.status === "resolved") {
      this.misses.delete(path);
      this.record(path, result.root);
      return result.root;
    }
    // Git missing, not a repository, or a spelling git does not echo back
    // (symlinked ancestor, Windows short name, mapped drive): the `.git`
    // file path still works for Codex-style worktrees. The sync resolver
    // already had this fallback; keep both entry points consistent.
    const root = resolveOnDisk(path);
    if (root) {
      this.misses.delete(path);
      this.record(path, root);
      return root;
    }
    const exists = existsSync(path);
    this.misses.set(path, { retryAt: this.now().getTime() + this.missRetryIntervalMs, exists });
    return exists ? null : this.sameNamedRoot(path);
  }

  /** Write the current mappings; returns false when the previous file could not be replaced. */
  save(): boolean {
    if (!this.archivePath) return true;
    const entries = this.entries();
    const saved = writeJsonFileAtomic(this.archivePath, {
      version: ARCHIVE_VERSION,
      worktrees: entries,
    });
    if (!saved) log.warning("worktrees archive write failed");
    return saved;
  }

  private loadArchive(): void {
    const parsed = readJsonFile(this.archivePath);
    if (parsed === undefined) return;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log.warning("worktrees archive is not an object");
      return;
    }
    const raw = parsed as Record<string, unknown>;
    if (typeof raw.version !== "number" || !Array.isArray(raw.worktrees)) {
      log.warning("worktrees archive has an unexpected shape");
      return;
    }
    for (const item of raw.worktrees) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.path !== "string" || typeof entry.root !== "string") continue;
      const path = normalizeWorktreePath(entry.path);
      const root = normalizeWorktreePath(entry.root);
      if (!path || !root || this.known.has(path)) continue;
      this.known.set(path, root);
      this.noteCandidate(root);
    }
    this.trimArchive();
  }

  private record(path: string, root: string): void {
    this.known.set(path, root);
    this.noteCandidate(root);
    this.trimArchive();
    this.save();
  }

  private trimArchive(): void {
    while (this.known.size > this.maxArchivedEntries) {
      const oldest = this.known.keys().next().value;
      if (oldest === undefined) return;
      this.known.delete(oldest);
    }
  }

  private noteCandidate(rawPath: string): void {
    const path = normalizeWorktreePath(rawPath);
    if (!path || platformPath.isRoot(path)) return;
    const name = lastComponent(path);
    if (!name) return;
    const bucketKey = platformPath.platform === "win32" ? name.toLowerCase() : name;
    let bucket = this.candidates.get(bucketKey);
    if (!bucket) {
      bucket = new Map();
      this.candidates.set(bucketKey, bucket);
    }
    const identity = platformPath.canonical(path);
    bucket.set(platformPath.platform === "win32" ? identity.toLowerCase() : identity, path);
  }

  /** A deleted, unrecorded worktree: only a single same-named known directory qualifies. */
  private sameNamedRoot(rawPath: string): string | null {
    const path = normalizeWorktreePath(rawPath);
    const name = lastComponent(path);
    if (!name) return null;
    const bucketKey = platformPath.platform === "win32" ? name.toLowerCase() : name;
    const bucket = this.candidates.get(bucketKey);
    if (!bucket) return null;
    const matches = [...bucket.values()].filter((candidate) => !platformPath.same(candidate, path));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
}

function lastComponent(path: string): string {
  const parts = platformPath.components(path);
  return parts[parts.length - 1] ?? "";
}

/** Join without touching the provider's separators twice (used by shape resolution). */
function repoJoin(repository: string, separator: string, subpath: string): string {
  if (platformPath.platform === "win32") {
    return `${repository}${separator}${subpath.replace(/\//g, "\\")}`;
  }
  return `${repository}${separator}${subpath}`;
}
