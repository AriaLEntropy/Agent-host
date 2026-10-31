import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopResumeCommand,
  desktopResumeShellLine,
  posixQuote,
  resolveDesktopResume,
  type DesktopResumeCommand,
  type DesktopResumeTask,
} from "../../src/connectors/desktop-resume.js";

function task(id: string, source: string, extra: Partial<DesktopResumeTask> = {}): DesktopResumeTask {
  return { id, source, projectPath: "/Users/me/proj", ...extra };
}

function fixedDirectories(...directories: string[]): (executable: string) => string[] {
  return () => directories;
}

test("Claude resumes with --resume and no PATH prefix", () => {
  const command = desktopResumeCommand(task("claude:s1", "claude"), "/bin/claude");
  assert.deepEqual(command, {
    executable: "/bin/claude",
    arguments: ["--resume", "s1"],
    workingDirectory: "/Users/me/proj",
    pathDirectories: [],
  });
});

test("Codex resumes with the resume subcommand", () => {
  const command = desktopResumeCommand(task("codex:t1", "codex"), "/c/codex");
  assert.deepEqual(command?.arguments, ["resume", "t1"]);
  assert.deepEqual(command?.pathDirectories, [], "不把 App 包的 Resources 塞进 PATH");
});

test("worktree sessions resume in the worktree, not the main repository", () => {
  const command = desktopResumeCommand(
    task("claude:s1", "claude", {
      projectPath: "/Users/me/main",
      worktreePath: "/Users/me/main/.claude/worktrees/feature",
    }),
    "/bin/claude",
  );
  assert.equal(command?.workingDirectory, "/Users/me/main/.claude/worktrees/feature");
  // 空白的 worktreePath 退回主仓库，不生成空目录。
  const fallback = desktopResumeCommand(
    task("claude:s2", "claude", { projectPath: "/Users/me/main", worktreePath: "  " }),
    "/bin/claude",
  );
  assert.equal(fallback?.workingDirectory, "/Users/me/main");
});

test("Hermes, Pi and OpenClaw keep their node next to the script on PATH", () => {
  const hermes = desktopResumeCommand(
    task("hermes:h1", "hermes"),
    "/opt/homebrew/bin/hermes",
    { pathDirectories: fixedDirectories("/opt/homebrew/bin") },
  );
  assert.deepEqual(hermes?.arguments, ["--resume", "h1"]);
  assert.deepEqual(hermes?.pathDirectories, ["/opt/homebrew/bin"]);

  const pi = desktopResumeCommand(task("pi:p1", "pi"), "/opt/homebrew/bin/pi", {
    piSessionFile: "/s/x_p1.jsonl",
    pathDirectories: fixedDirectories("/opt/homebrew/bin"),
  });
  assert.deepEqual(pi?.arguments, ["--session", "/s/x_p1.jsonl"]);
  assert.deepEqual(pi?.pathDirectories, ["/opt/homebrew/bin"]);

  const openclaw = desktopResumeCommand(task("openclaw:agent:main:x", "openclaw"), "/o/openclaw", {
    pathDirectories: fixedDirectories("/o"),
  });
  assert.deepEqual(openclaw?.arguments, ["tui", "--session", "agent:main:x"], "sessionKey 自己带冒号");
  assert.deepEqual(openclaw?.pathDirectories, ["/o"]);
});

test("Pi without a session record file cannot be resumed", () => {
  assert.equal(desktopResumeCommand(task("pi:p1", "pi"), "/bin/pi"), undefined);
  assert.equal(
    desktopResumeCommand(task("pi:p1", "pi"), "/bin/pi", { piSessionFile: "" }),
    undefined,
  );
});

test("OpenCode is the only ACP agent with a terminal resume", () => {
  const opencode = desktopResumeCommand(
    task("acp:opencode:ses_1", "acp", { connectorId: "opencode" }),
    "/bin/opencode",
    { pathDirectories: fixedDirectories("/bin") },
  );
  assert.deepEqual(opencode?.arguments, ["--session", "ses_1"]);
  assert.deepEqual(opencode?.pathDirectories, ["/bin"]);

  assert.equal(
    desktopResumeCommand(
      task("acp:opencode:ses_1", "acp", { connectorId: "gemini" }),
      "/bin/whatever",
    ),
    undefined,
    "connectorId 不是 opencode",
  );
  assert.equal(
    desktopResumeCommand(task("acp:gemini:ses_1", "acp", { connectorId: "opencode" }), "/bin/whatever"),
    undefined,
    "id 与 connectorId 不一致",
  );
});

test("ids without a usable native id are rejected", () => {
  assert.equal(desktopResumeCommand(task("claude-1", "claude"), "/bin/claude"), undefined);
  assert.equal(desktopResumeCommand(task("claude:   ", "claude"), "/bin/claude"), undefined);
  assert.equal(desktopResumeCommand(task("claude:s1", "claude"), ""), undefined);
  assert.equal(desktopResumeCommand(task("dsh:abc", "dsh"), "/bin/dsh"), undefined, "dsh 先不拼");
  assert.equal(desktopResumeCommand(task("gemini:x", "gemini"), "/bin/gemini"), undefined);
});

test("POSIX shell lines quote every segment and scope PATH to one command", () => {
  const command: DesktopResumeCommand = {
    executable: "/Users/me/.local/bin/claude",
    arguments: ["--resume", "abc"],
    workingDirectory: "/Users/me/it's here",
    pathDirectories: [],
  };
  assert.equal(
    desktopResumeShellLine(command, "posix"),
    "cd '/Users/me/it'\\''s here' && '/Users/me/.local/bin/claude' '--resume' 'abc'",
  );

  const pi = desktopResumeCommand(task("pi:p1", "pi"), "/opt/homebrew/bin/pi", {
    piSessionFile: "/s/x_p1.jsonl",
    pathDirectories: fixedDirectories("/opt/homebrew/bin"),
  });
  assert.ok(pi);
  assert.equal(
    desktopResumeShellLine(pi, "posix"),
    "cd '/Users/me/proj' && PATH='/opt/homebrew/bin':\"$PATH\" '/opt/homebrew/bin/pi' '--session' '/s/x_p1.jsonl'",
  );
});

test("Windows shell lines quote with the Node cmd rules", () => {
  const command = desktopResumeCommand(
    task("claude:s 1", "claude", { projectPath: "C:\\Users\\me\\My Project" }),
    "C:\\Program Files\\claude\\claude.exe",
  );
  assert.ok(command);
  assert.equal(
    desktopResumeShellLine(command, "win32"),
    'cd /d "C:\\Users\\me\\My Project" && "C:\\Program Files\\claude\\claude.exe" --resume "s 1"',
  );

  const pi = desktopResumeCommand(
    task("pi:p1", "pi", { projectPath: "C:\\work\\demo" }),
    "C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd",
    {
      piSessionFile: "C:\\Users\\me\\.pi\\agent\\sessions\\--x--\\1_u.jsonl",
      pathDirectories: fixedDirectories("C:\\Users\\me\\AppData\\Roaming\\npm"),
    },
  );
  assert.ok(pi);
  assert.equal(
    desktopResumeShellLine(pi, "win32"),
    'cd /d "C:\\work\\demo" && set "PATH=C:\\Users\\me\\AppData\\Roaming\\npm;%PATH%" && ' +
      '"C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd" --session "C:\\Users\\me\\.pi\\agent\\sessions\\--x--\\1_u.jsonl"',
  );
  assert.equal(desktopResumeShellLine(pi, "win32").includes("'"), false, "Windows 不用单引号");
});

test("posixQuote keeps embedded quotes literal", () => {
  assert.equal(posixQuote("plain"), "'plain'");
  assert.equal(posixQuote("it's"), "'it'\\''s'");
  assert.equal(posixQuote(""), "''");
});

test("resolve uses injected detectors and never touches the real home", async () => {
  const detected = new Map<string, string>([
    ["claude", "/bin/claude"],
    ["codex", "/bin/codex"],
    ["pi", "/bin/pi"],
  ]);
  const command = await resolveDesktopResume(task("claude:s1", "claude"), {
    detect: (source) => detected.get(source),
    piSessionFile: () => {
      throw new Error("not a pi task");
    },
  });
  assert.deepEqual(command?.arguments, ["--resume", "s1"]);
  assert.equal(command?.executable, "/bin/claude");

  const pi = await resolveDesktopResume(task("pi:p1", "pi"), {
    detect: (source) => detected.get(source),
    piSessionFile: async (native) => `/s/x_${native}.jsonl`,
    pathDirectories: fixedDirectories("/bin"),
  });
  assert.deepEqual(pi?.arguments, ["--session", "/s/x_p1.jsonl"]);
  assert.deepEqual(pi?.pathDirectories, ["/bin"]);

  // Pi 找不到记录文件 → 拼不出来。
  assert.equal(
    await resolveDesktopResume(task("pi:p1", "pi"), {
      detect: (source) => detected.get(source),
      piSessionFile: () => null,
    }),
    undefined,
  );

  // 找不到 CLI → 拼不出来。
  assert.equal(await resolveDesktopResume(task("codex:t1", "codex"), { detect: () => undefined }), undefined);

  // dsh 不探测、不拼。
  let asked = 0;
  assert.equal(
    await resolveDesktopResume(task("dsh:abc", "dsh"), {
      detect: () => {
        asked += 1;
        return "/bin/dsh";
      },
    }),
    undefined,
  );
  assert.equal(asked, 0);
});

test("the shell line defaults to the current platform without running anything", () => {
  const command = desktopResumeCommand(task("claude:s1", "claude"), "/bin/claude");
  assert.ok(command);
  const line = desktopResumeShellLine(command);
  assert.ok(line.startsWith("cd "));
  assert.equal(line.includes("--resume"), true);
});
