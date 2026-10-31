import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { platformPath } from "../../src/platform/path.js";
import {
  WorktreeResolver,
  mainRepositoryFromGitFile,
  parseWorktreeListPorcelain,
  resolveByShape,
  resolveOnDisk,
  worktreesComponentIndex,
} from "../../src/bus/worktree.js";

const roots: string[] = [];
function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `agent-host-${label}-`));
  roots.push(directory);
  return directory;
}

const gitConfigRoot = tempDir("git-config");
const gitConfig = join(gitConfigRoot, "gitconfig");
writeFileSync(gitConfig, "");

const GIT_AVAILABLE = (() => {
  try {
    const result = spawnSync("git", ["--version"], { stdio: "ignore" });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
})();

after(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Agent Host Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function makeRepo(parent: string, name: string): string {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function addWorktree(repo: string, path: string, branch: string): void {
  mkdirSync(dirname(path), { recursive: true });
  git(repo, ["worktree", "add", "-q", "-b", branch, path]);
}

function real(path: string): string {
  return platformPath.normalized(realpathSync(path));
}

function samePath(actual: string | null, expected: string): boolean {
  return actual !== null && platformPath.same(actual, expected);
}

function fakeGitDir(root: string, name: string): { worktree: string; root: string } {
  const worktree = join(root, "worktrees", name);
  const main = join(root, "repos", name);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", name)}\n`);
  return { worktree, root: main };
}

describe("worktree resolver (protocol 2.7 / 3.4)", () => {
  test("Claude worktrees are resolved by path shape alone", () => {
    const base = platformPath.platform === "win32" ? "C:\\Users\\me\\Projects\\app" : "/Users/me/Projects/app";
    const worktree = join(base, ".claude", "worktrees", "dark-mode-4f2a9c");
    assert.equal(resolveByShape(worktree), base);
    assert.equal(resolveByShape(join(worktree, "web")), platformPath.join(base, "web"));
    assert.equal(
      resolveByShape(`${join(worktree, "web")}${platformPath.separator}`),
      platformPath.join(base, "web"),
    );
    // `.claude/worktrees` itself and ordinary directories are not worktrees.
    assert.equal(resolveByShape(join(base, ".claude", "worktrees")), null);
    assert.equal(resolveByShape(base), null);
    assert.equal(resolveByShape(""), null);
    assert.equal(worktreesComponentIndex(worktree) !== null, true);
    assert.equal(worktreesComponentIndex(join(base, ".claude", "worktrees")), null);
  });

  test("Windows accepts both separator styles", () => {
    if (platformPath.platform !== "win32") return;
    assert.equal(resolveByShape("C:\\Work\\app\\.claude\\worktrees\\x"), "C:\\Work\\app");
    assert.equal(resolveByShape("C:\\Work\\app\\.claude\\worktrees\\x\\web\\api"), "C:\\Work\\app\\web\\api");
    assert.equal(resolveOnDisk("C:\\missing\\worktrees\\x"), null);
  });

  test("porcelain output is parsed into worktree entries", () => {
    const entries = parseWorktreeListPorcelain(
      [
        "worktree /Users/me/app",
        "HEAD 1111",
        "branch refs/heads/main",
        "",
        "worktree /Users/me/.codex/worktrees/a1b2/app",
        "HEAD 2222",
        "branch refs/heads/botbus/app",
        "",
      ].join("\n"),
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.path, "/Users/me/app");
    assert.equal(entries[0]?.branch, "refs/heads/main");
    assert.equal(entries[1]?.path, "/Users/me/.codex/worktrees/a1b2/app");
    assert.equal(entries[1]?.branch, "refs/heads/botbus/app");

    const bare = parseWorktreeListPorcelain("worktree C:/bare.git\nbare\n\n");
    assert.equal(bare.length, 1);
    assert.equal(bare[0]?.bare, true);
  });

  test("the injected git runner maps a linked worktree and its subdirectory", async () => {
    const fakeRoot = platformPath.platform === "win32" ? "C:\\fake\\app" : "/fake/app";
    const fakeWorktree =
      platformPath.platform === "win32"
        ? "C:\\fake\\.codex\\worktrees\\a1b2\\app"
        : "/fake/.codex/worktrees/a1b2/app";
    const porcelain = [
      `worktree ${fakeRoot.replace(/\\/g, "/")}`,
      "HEAD 1111",
      "branch refs/heads/main",
      "",
      `worktree ${fakeWorktree.replace(/\\/g, "/")}`,
      "HEAD 2222",
      "branch refs/heads/botbus/app",
      "",
    ].join("\n");
    const calls: string[][] = [];
    const resolver = new WorktreeResolver({
      git: async (args) => {
        calls.push([...args]);
        return { code: 0, stdout: porcelain, stderr: "" };
      },
    });

    const root = await resolver.projectRootAsync(fakeWorktree);
    assert.equal(samePath(root, fakeRoot), true);
    const sub = await resolver.projectRootAsync(join(fakeWorktree, "src", "api"));
    assert.equal(samePath(sub, join(fakeRoot, "src", "api")), true);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.includes("worktree"), true);
    assert.equal(calls[0]?.includes("list"), true);
    assert.equal(calls[0]?.includes("--porcelain"), true);
    const index = calls[0]?.indexOf("-C") ?? -1;
    assert.equal(calls[0]?.[index + 1], platformPath.normalized(fakeWorktree));

    // The main worktree itself is not a worktree session.
    assert.equal(await resolver.projectRootAsync(fakeRoot), null);
  });

  test("a real git worktree maps to the main repository and keeps subdirectories", async (t) => {
    if (!GIT_AVAILABLE) {
      t.skip("git is not available");
      return;
    }
    const root = tempDir("wt-git");
    const repo = makeRepo(root, "repo");
    const worktree = join(root, "worktrees", "linked-wt");
    addWorktree(repo, worktree, "botbus/linked");
    const mainReal = real(repo);
    const worktreeReal = real(worktree);

    assert.equal(samePath(resolveOnDisk(worktreeReal), mainReal), true);
    assert.equal(samePath(new WorktreeResolver().projectRoot(worktreeReal), mainReal), true);
    assert.equal(samePath(await new WorktreeResolver().projectRootAsync(worktreeReal), mainReal), true);

    const sub = join(worktreeReal, "web", "api");
    mkdirSync(sub, { recursive: true });
    assert.equal(samePath(resolveOnDisk(sub), join(mainReal, "web", "api")), true);
    assert.equal(samePath(new WorktreeResolver().projectRoot(sub), join(mainReal, "web", "api")), true);
    assert.equal(
      samePath(await new WorktreeResolver().projectRootAsync(sub), join(mainReal, "web", "api")),
      true,
    );

    // The main worktree is an ordinary project.
    assert.equal(new WorktreeResolver().projectRoot(mainReal), null);
    assert.equal(await new WorktreeResolver().projectRootAsync(mainReal), null);
  });

  test("resolved mappings survive worktree deletion and restart", async (t) => {
    if (!GIT_AVAILABLE) {
      t.skip("git is not available");
      return;
    }
    const root = tempDir("wt-persist");
    const repo = makeRepo(root, "repo");
    const worktree = join(root, "worktrees", "linked-wt");
    addWorktree(repo, worktree, "botbus/persist");
    const mainReal = real(repo);
    const worktreeReal = real(worktree);
    const archive = join(root, "support", "worktrees.json");

    const first = new WorktreeResolver({ archivePath: archive });
    assert.equal(samePath(first.projectRoot(worktreeReal), mainReal), true);
    assert.equal(existsSync(archive), true);
    const raw = JSON.parse(readFileSync(archive, "utf8")) as { version: number; worktrees: unknown[] };
    assert.equal(raw.version, 1);
    assert.equal(raw.worktrees.length, 1);

    rmSync(worktreeReal, { recursive: true, force: true });
    const restarted = new WorktreeResolver({ archivePath: archive });
    assert.equal(samePath(restarted.projectRoot(worktreeReal), mainReal), true);
    // Without the archive the deleted worktree cannot be recognized.
    assert.equal(new WorktreeResolver().projectRoot(worktreeReal), null);
  });

  test("a deleted unrecorded Codex worktree falls back to the only same-named directory", () => {
    const root = tempDir("wt-same-name");
    const plain = join(root, "Projects", "giggleland");
    mkdirSync(plain, { recursive: true });
    const gone = join(root, "codex", "worktrees", "8417", "giggleland");
    const resolver = new WorktreeResolver({ now: () => new Date("2026-10-01T00:00:00.000Z") });

    assert.equal(resolver.projectRoot(gone), null);
    assert.equal(resolver.projectRoot(plain), null);
    assert.equal(samePath(resolver.projectRoot(gone), platformPath.normalized(plain)), true);

    // Two same-named candidates: never guess.
    const second = join(root, "Archive", "giggleland");
    mkdirSync(second, { recursive: true });
    assert.equal(resolver.projectRoot(second), null);
    assert.equal(resolver.projectRoot(gone), null);
  });

  test("a miss is retried after the interval when .git appears", () => {
    const root = tempDir("wt-retry");
    let current = new Date("2026-10-01T00:00:00.000Z");
    const resolver = new WorktreeResolver({ now: () => current, missRetryIntervalMs: 1_000 });
    const worktree = join(root, "codex", "worktrees", "z9", "app");
    const main = join(root, "Projects", "app");
    mkdirSync(worktree, { recursive: true });

    assert.equal(resolver.projectRoot(worktree), null);
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "app")}\n`);
    assert.equal(resolver.projectRoot(worktree), null);

    current = new Date(current.getTime() + 1_001);
    assert.equal(samePath(resolver.projectRoot(worktree), platformPath.normalized(main)), true);
  });

  test("submodules, bare repositories and .git directories are not worktrees", () => {
    const root = tempDir("wt-invalid");
    const submodule = join(root, "a", "worktrees", "x", "lib");
    mkdirSync(submodule, { recursive: true });
    writeFileSync(
      join(submodule, ".git"),
      `gitdir: ${join(root, "app", ".git", "modules", "lib")}\n`,
    );
    const bare = join(root, "b", "worktrees", "x");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, ".git"), `gitdir: ${join(root, "app.git", "worktrees", "x")}\n`);
    const plain = join(root, "c", "worktrees", "x");
    mkdirSync(join(plain, ".git"), { recursive: true });

    assert.equal(resolveOnDisk(submodule), null);
    assert.equal(resolveOnDisk(bare), null);
    assert.equal(resolveOnDisk(plain), null);
    assert.equal(mainRepositoryFromGitFile(join(submodule, ".git")), null);
    assert.equal(mainRepositoryFromGitFile(join(bare, ".git")), null);
  });

  test("relative gitdir values are resolved against the worktree", () => {
    const root = tempDir("wt-relative");
    const worktree = join(root, "repo", "wt", "worktrees", "feature");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/feature\n");
    assert.equal(samePath(resolveOnDisk(worktree), platformPath.normalized(join(root, "repo"))), true);
  });

  test("paths without a worktrees directory are never inspected", () => {
    const root = tempDir("wt-no-marker");
    const elsewhere = join(root, "elsewhere", "feature");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(elsewhere, ".git"),
      `gitdir: ${join(root, "app", ".git", "worktrees", "feature")}\n`,
    );
    assert.equal(resolveOnDisk(elsewhere), null);
    assert.equal(new WorktreeResolver().projectRoot(elsewhere), null);
  });

  test("the archive keeps only the most recent entries", () => {
    const root = tempDir("wt-cap");
    const resolver = new WorktreeResolver({ maxArchivedEntries: 2 });
    const first = fakeGitDir(root, "a");
    const second = fakeGitDir(root, "b");
    const third = fakeGitDir(root, "c");
    resolver.projectRoot(first.worktree);
    resolver.projectRoot(second.worktree);
    resolver.projectRoot(third.worktree);
    const paths = resolver.entries().map((entry) => entry.path);
    assert.equal(paths.length, 2);
    assert.equal(platformPath.same(paths[0] ?? "", second.worktree), true);
    assert.equal(platformPath.same(paths[1] ?? "", third.worktree), true);
  });

  test("remember and forget update the mapping", () => {
    const root = tempDir("wt-remember");
    const worktree = join(root, "worktrees", "x");
    const main = join(root, "main");
    const resolver = new WorktreeResolver();
    assert.equal(resolver.remember(worktree, main), true);
    assert.equal(samePath(resolver.knownRoot(worktree), platformPath.normalized(main)), true);
    assert.equal(resolver.forget(worktree), true);
    assert.equal(resolver.knownRoot(worktree), null);
  });

  test("a corrupt archive is ignored", () => {
    const root = tempDir("wt-corrupt");
    const archive = join(root, "worktrees.json");
    writeFileSync(archive, "not json");
    const shapePath = platformPath.platform === "win32" ? "C:\\r\\.claude\\worktrees\\x" : "/r/.claude/worktrees/x";
    const shapeRoot = platformPath.platform === "win32" ? "C:\\r" : "/r";
    assert.equal(resolveByShape(shapePath), shapeRoot);
    assert.equal(new WorktreeResolver({ archivePath: archive }).size, 0);
    writeFileSync(archive, JSON.stringify({ version: 1, worktrees: "nope" }));
    assert.equal(new WorktreeResolver({ archivePath: archive }).size, 0);
  });
});
