import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BusProject, BusTask, BusTaskMessages } from "../../src/bus/store.js";
import { latestWindow, transcriptEntry, type TranscriptEntry } from "../../src/connectors/ported/contract.js";
import {
  ClaudeAskedQuestions,
  ClaudeConnector,
  ClaudeDesktopSessionIndex,
  ClaudeFailure,
  ClaudeHookInstaller,
  ClaudeHookOutput,
  ClaudeMessageReader,
  ClaudeModels,
  ClaudeSessionHistory,
  ClaudeSessionPresence,
  buildEnvironment,
  claudeArguments,
  claudePaths,
  createClaudeConnector,
  createClaudeMessageReader,
  parseClaudeHookEvent,
  protocolTimestamp,
  resolveModelSelection,
  stdinPayload,
  type ClaudeConnectorOptions,
  type LocalHookReply,
  type LocalHookRequest,
} from "../../src/connectors/claude/index.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");

class FakeHost {
  readonly agentId = "agent-1";
  readonly tasksById = new Map<string, BusTask>();
  readonly projects: BusProject[] = [];
  readonly live = new Set<string>();
  readonly messages: BusTaskMessages[] = [];

  now(): string {
    return protocolTimestamp(new Date(NOW));
  }

  task(taskId: string): BusTask | undefined {
    return this.tasksById.get(taskId);
  }

  tasks(): readonly BusTask[] {
    return [...this.tasksById.values()];
  }

  upsert(task: BusTask): void {
    this.tasksById.set(task.id, task);
  }

  remove(taskId: string): void {
    this.tasksById.delete(taskId);
  }

  rememberProject(project: BusProject): void {
    const index = this.projects.findIndex((item) => item.path === project.path);
    if (index >= 0) this.projects[index] = project;
    else this.projects.push(project);
  }

  rememberSession(): void {}

  emitMessages(messages: BusTaskMessages): void {
    this.messages.push(messages);
  }

  claimLive(taskId: string): void {
    this.live.add(taskId);
  }

  releaseLive(taskId: string): void {
    this.live.delete(taskId);
  }

  isLive(taskId: string): boolean {
    return this.live.has(taskId);
  }
}

function connector(
  host: FakeHost,
  home: string,
  extra: Partial<ClaudeConnectorOptions> = {},
): ClaudeConnector {
  return createClaudeConnector(host, {
    // 这些用例只测连接器行为：不碰真实 ~/.claude、不占回环端口。
    autoStart: false,
    paths: claudePaths({ claudeHome: home, desktopSessionsDirectories: [] }),
    binary: () => null,
    now: () => new Date(NOW),
    titleRetryDelays: [],
    turnEndCheckInterval: 3600,
    presenceSweepInterval: 3600,
    ...extra,
  });
}

function hookRequest(body: unknown): LocalHookRequest {
  return {
    method: "POST",
    target: "/hooks/claude",
    path: "/hooks/claude",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function expectNow(reply: LocalHookReply): void {
  assert.equal(reply.kind, "now");
}

function temporary(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeTranscript(
  projectsDirectory: string,
  sessionID: string,
  lines: Array<Record<string, unknown>>,
  mtimeMs = NOW - 60 * 60 * 1000,
): string {
  const directory = join(projectsDirectory, "-E-work-demo");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${sessionID}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

// ---------------------------------------------------------------------------
// 模型别名
// ---------------------------------------------------------------------------

describe("claude models", () => {
  test("maps transcript model names to aliases and versions", () => {
    assert.equal(ClaudeModels.optionId("claude-opus-5-5"), "opus");
    assert.deepEqual(ClaudeModels.version("claude-opus-5-5"), [5, 5]);
    assert.equal(ClaudeModels.optionId("claude-haiku-4-5-20251001"), "haiku");
    assert.deepEqual(ClaudeModels.version("claude-haiku-4-5-20251001"), [4, 5]);
    assert.equal(ClaudeModels.optionId("claude-sonnet-5[1m]"), "sonnet");
    assert.deepEqual(ClaudeModels.version("claude-sonnet-5[1m]"), [5]);
    assert.equal(ClaudeModels.optionId("claude-3-5-sonnet-20241022"), "sonnet");
    assert.deepEqual(ClaudeModels.version("claude-3-5-sonnet-20241022"), [3, 5]);
    assert.equal(ClaudeModels.optionId("<synthetic>"), null);
    assert.equal(ClaudeModels.optionId("gpt-5"), null);
  });

  test("display names carry versions and haiku has no efforts", () => {
    const options = ClaudeModels.options({ versions: { opus: [5, 5] }, efforts: ["low", "high"] });
    assert.equal(options.find((option) => option.id === "opus")?.displayName, "Opus 5.5");
    assert.deepEqual(options.find((option) => option.id === "opus")?.efforts, ["low", "high"]);
    assert.equal(options.find((option) => option.id === "haiku")?.efforts, undefined);
  });

  test("parses wrapped --effort help text and only raises versions", () => {
    const help = [
      "  --effort <level>  Set effort level (low, medium,",
      "        high, xhigh, max)",
      "",
    ].join("\n");
    assert.deepEqual(ClaudeModels.effortsInHelp(help), ["low", "medium", "high", "xhigh", "max"]);
    const versions: Record<string, number[]> = {};
    assert.equal(ClaudeModels.note("claude-opus-5-5", versions), true);
    assert.equal(ClaudeModels.note("claude-opus-4-5", versions), false);
    assert.deepEqual(versions.opus, [5, 5]);
  });

  test("reads the last recognized model from the transcript tail", () => {
    const home = temporary("agent-host-claude-last-model-");
    try {
      const path = join(home, "session.jsonl");
      writeFileSync(
        path,
        [
          JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-5", content: "old" } }),
          JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5[1m]", content: "new" } }),
          JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: "filler" } }),
        ].join("\n"),
        "utf8",
      );
      assert.equal(ClaudeModels.lastModel(path), "claude-sonnet-5[1m]");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resolveModelSelection validates model, effort and haiku", () => {
    const options = ClaudeModels.options({ versions: {}, efforts: ["low", "high"] });
    assert.deepEqual(resolveModelSelection({ model: "opus", effort: "high" }, undefined, options), {
      model: "opus",
      effort: "high",
    });
    assert.throws(
      () => resolveModelSelection({ model: "haiku", effort: "high" }, undefined, options),
      /这个模型不能调思考强度/,
    );
    assert.throws(() => resolveModelSelection({ model: "nope" }, undefined, options), /没有「nope」/);
    const session = { chosenModel: "opus", chosenEffort: "high" } as never;
    assert.deepEqual(resolveModelSelection({}, session, options), { model: "opus", effort: "high" });
  });
});

// ---------------------------------------------------------------------------
// 失败诊断
// ---------------------------------------------------------------------------

describe("claude failure diagnosis", () => {
  test("maps structured StopFailure categories", () => {
    assert.deepEqual(
      ClaudeFailure.diagnosisFromCategory("rate_limit", "Claude AI usage limit reached|1791043200"),
      { kind: "usageLimit", resetsAt: new Date(1791043200 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") },
    );
    assert.deepEqual(ClaudeFailure.diagnosisFromCategory("billing_error", null), { kind: "usageLimit" });
    assert.deepEqual(ClaudeFailure.diagnosisFromCategory("authentication_failed", "oauth token has expired"), {
      kind: "signInExpired",
    });
    assert.deepEqual(ClaudeFailure.diagnosisFromCategory("authentication_failed", null), {
      kind: "notSignedIn",
    });
    assert.equal(ClaudeFailure.diagnosisFromCategory("server_error", "boom"), null);
  });

  test("only classifies error text, not agent prose", () => {
    assert.deepEqual(ClaudeFailure.diagnosis("Not logged in · Please run /login"), {
      kind: "notSignedIn",
    });
    assert.deepEqual(ClaudeFailure.diagnosis("failed to authenticate: revocation"), {
      kind: "signInExpired",
    });
    assert.equal(ClaudeFailure.diagnosis("I fixed the parser"), null);
    assert.equal(ClaudeFailure.resetTime("limit reached|123"), null);
  });
});

// ---------------------------------------------------------------------------
// hook 负载与 AskUserQuestion
// ---------------------------------------------------------------------------

describe("claude hook payloads", () => {
  test("accepts candidate key spellings and summarizes tool_input", () => {
    const event = parseClaudeHookEvent(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        cwd: "E:/work/demo",
        user_prompt: "fix the parser",
      }),
    );
    assert.ok(event);
    assert.equal(event.prompt, "fix the parser");

    const permission = parseClaudeHookEvent({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: { command: "npm test" },
    });
    assert.ok(permission);
    assert.equal(permission.toolInput, "npm test");
  });

  test("decodes AskUserQuestion and maps answers back by question text", () => {
    const input = {
      questions: [
        {
          question: "Deploy?",
          header: "Deploy",
          multiSelect: true,
          options: [
            { label: "Yes", description: "ship it" },
            { label: "No" },
          ],
        },
        { question: "Which environment:", options: [{ label: "staging" }] },
      ],
    };
    const asked = ClaudeAskedQuestions.from("AskUserQuestion", input);
    assert.ok(asked);
    assert.equal(asked.questions.length, 2);
    assert.equal(asked.summary, "Deploy");
    assert.equal(asked.questions[0]?.multiSelect, true);
    assert.match(asked.plainText, /1\. Yes — ship it/);
    assert.deepEqual(asked.claudeAnswers({ "0": ["Yes", "No"] }), { "Deploy?": "Yes, No" });
    const answered = JSON.parse(asked.answeredInput({ "Deploy?": "Yes" }));
    assert.deepEqual(answered.answers, { "Deploy?": "Yes" });
    assert.deepEqual(answered.questions, input.questions);
    assert.deepEqual(asked.claudeAnswersFromText("lgtm"), {
      "Deploy?": "lgtm",
      "Which environment:": "lgtm",
    });

    const event = parseClaudeHookEvent({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "AskUserQuestion",
      tool_use_id: "q1",
      tool_input: input,
    });
    assert.ok(event?.askedQuestions);
  });

  test("encodes hook permission output for allow / deny / answered", () => {
    const allow = JSON.parse(ClaudeHookOutput.permission(true, "").toString("utf8"));
    assert.deepEqual(allow, {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    const deny = JSON.parse(ClaudeHookOutput.permission(false, "no").toString("utf8"));
    assert.deepEqual(deny.hookSpecificOutput.decision, { behavior: "deny", message: "no" });
    const asked = ClaudeAskedQuestions.from("AskUserQuestion", {
      questions: [{ question: "Deploy?", options: [{ label: "Yes" }] }],
    });
    assert.ok(asked);
    const answered = JSON.parse(ClaudeHookOutput.answer(asked, { "Deploy?": "Yes" }).toString("utf8"));
    assert.equal(answered.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(answered.hookSpecificOutput.decision.updatedInput.answers, { "Deploy?": "Yes" });
  });
});

// ---------------------------------------------------------------------------
// 设置合并
// ---------------------------------------------------------------------------

describe("claude settings merge", () => {
  const userSettings = {
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }],
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "old botbus-claude-hook path" }] },
      ],
    },
  };

  test("only touches marked hooks and is idempotent", () => {
    const first = ClaudeHookInstaller.merged(userSettings, "C:\\tmp\\botbus-claude-hook.ps1");
    assert.deepEqual(first.hooks?.PreToolUse, userSettings.hooks.PreToolUse);
    const sessionStart = (first.hooks as Record<string, unknown>).SessionStart as Array<
      Record<string, unknown>
    >;
    assert.equal(sessionStart.length, 1);
    assert.equal(
      (sessionStart[0].hooks as Array<Record<string, unknown>>)[0].command,
      (process.env.SystemRoot ?? "C:\\Windows") +
        '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\tmp\\botbus-claude-hook.ps1"',
    );
    for (const event of ClaudeHookInstaller.events) {
      assert.ok(Array.isArray((first.hooks as Record<string, unknown>)[event]));
    }
    const permission = ((first.hooks as Record<string, unknown>).PermissionRequest as Array<
      Record<string, unknown>
    >)[0].hooks as Array<Record<string, unknown>>;
    assert.equal(permission[0].timeout, ClaudeHookInstaller.permissionTimeoutSeconds);
    assert.equal(ClaudeHookInstaller.isInstalled(first, "C:\\tmp\\botbus-claude-hook.ps1"), true);

    const second = ClaudeHookInstaller.merged(first, "C:\\tmp\\botbus-claude-hook.ps1");
    assert.deepEqual(second, first);
  });

  test("removed() strips only our entries and drops empty shells", () => {
    const installed = ClaudeHookInstaller.merged(userSettings, "C:\\tmp\\botbus-claude-hook.ps1");
    const cleaned = ClaudeHookInstaller.removed(installed);
    assert.deepEqual(cleaned, {
      model: "opus",
      hooks: { PreToolUse: userSettings.hooks.PreToolUse },
    });
  });

  test("install / uninstall operate only on the injected temp paths", () => {
    const home = temporary("agent-host-claude-settings-");
    const support = temporary("agent-host-claude-support-");
    try {
      const paths = claudePaths({ claudeHome: home, desktopSessionsDirectories: [] });
      mkdirSync(home, { recursive: true });
      writeFileSync(paths.settingsFile, JSON.stringify(userSettings), "utf8");
      ClaudeHookInstaller.install(paths, support);
      assert.ok(statSync(paths.backupFile).isFile());
      const installed = JSON.parse(readFileSync(paths.settingsFile, "utf8"));
      assert.deepEqual(installed.hooks.PreToolUse, userSettings.hooks.PreToolUse);
      assert.ok(statSync(ClaudeHookInstaller.scriptURL(support)).isFile());
      assert.equal(ClaudeHookInstaller.upgradeIfNeeded(paths, support), false);
      ClaudeHookInstaller.uninstall(paths, support);
      const cleaned = JSON.parse(readFileSync(paths.settingsFile, "utf8"));
      assert.deepEqual(cleaned.hooks, { PreToolUse: userSettings.hooks.PreToolUse });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(support, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 窗口规则
// ---------------------------------------------------------------------------

describe("transcript window", () => {
  let seq = 0;
  function entry(role: "user" | "agent" | "tool"): TranscriptEntry {
    return transcriptEntry({
      id: `${role}-${seq++}`,
      role,
      text: `${role} message`,
      createdAt: "2026-10-30T00:00:00Z",
    }) as TranscriptEntry;
  }

  test("keeps tool rows outside the conversation quota", () => {
    const entries = [entry("tool"), entry("user"), entry("tool"), entry("agent"), entry("tool")];
    const window = latestWindow(entries, 1);
    assert.equal(window.hasMore, true);
    assert.deepEqual(
      window.entries.map((item) => item.message.role),
      ["tool", "agent", "tool"],
    );
  });

  test("drops the oldest tool rows beyond 160", () => {
    const entries = [...Array.from({ length: 170 }, () => entry("tool")), entry("user")];
    const window = latestWindow(entries, 40);
    assert.equal(window.entries.filter((item) => item.message.role === "tool").length, 160);
    assert.equal(window.entries[window.entries.length - 1].message.role, "user");
  });
});

// ---------------------------------------------------------------------------
// transcript 解析
// ---------------------------------------------------------------------------

describe("claude message reader", () => {
  test("maps text, images, tool calls, narration and filters fillers", async () => {
    const home = temporary("agent-host-claude-reader-");
    const sessionID = "11111111-2222-3333-4444-555555555555";
    try {
      const projects = join(home, "projects");
      writeTranscript(projects, sessionID, [
        {
          type: "user",
          uuid: "u1",
          timestamp: "2026-10-30T10:00:00.123Z",
          message: {
            content: [
              {
                type: "text",
                text: "hello <system-reminder>hidden</system-reminder>world",
              },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
              },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-10-30T10:00:01.000Z",
          message: {
            content: [
              { type: "text", text: "saved out/a.png" },
              { type: "tool_use", name: "Bash", input: { command: "npm   test" } },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "a2",
          timestamp: "2026-10-30T10:00:02.000Z",
          message: {
            content: [{ type: "thinking", thinking: "working on it", signature: narrationSignature() }],
          },
        },
        {
          type: "user",
          uuid: "meta",
          isMeta: true,
          timestamp: "2026-10-30T10:00:03.000Z",
          message: { content: "ignored meta" },
        },
        {
          type: "user",
          uuid: "intr",
          timestamp: "2026-10-30T10:00:04.000Z",
          message: { content: "[Request interrupted by user]" },
        },
      ]);
      const reader = createClaudeMessageReader({
        paths: claudePaths({ claudeHome: home, desktopSessionsDirectories: [] }),
      });
      const result = await reader.entries(`claude:${sessionID}`, 40);
      const summary = result.entries.map((item) => `${item.message.role}:${item.message.text}`);
      assert.deepEqual(summary, [
        "user:hello world",
        "agent:saved out/a.png",
        "tool:$ npm test",
        "agent:working on it",
      ]);
      const user = result.entries[0];
      assert.equal(user.images.length, 1);
      assert.equal(user.images[0]?.type, "data");
      assert.equal(result.entries[0]?.message.createdAt, "2026-10-30T10:00:00Z");
      const agent = result.entries[1];
      assert.deepEqual(agent.pathCandidates, ["out/a.png"]);
      assert.equal(result.hasMore, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("applies the conversation window and reports hasMore", async () => {
    const home = temporary("agent-host-claude-window-");
    const sessionID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    try {
      const lines: Array<Record<string, unknown>> = [];
      for (let index = 0; index < 3; index += 1) {
        lines.push({
          type: "user",
          uuid: `u${index}`,
          timestamp: `2026-10-30T10:00:0${index}.000Z`,
          message: { content: `message ${index}` },
        });
      }
      writeTranscript(join(home, "projects"), sessionID, lines);
      const reader = new ClaudeMessageReader(claudePaths({ claudeHome: home, desktopSessionsDirectories: [] }));
      const result = await reader.entries(`claude:${sessionID}`, 1);
      assert.deepEqual(result.entries.map((item) => item.message.text), ["message 2"]);
      assert.equal(result.hasMore, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function narrationSignature(): string {
  function varint(value: number): Buffer {
    const bytes: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
      bytes.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(rest);
    return Buffer.from(bytes);
  }
  function field(number: number, payload: Buffer): Buffer {
    return Buffer.concat([varint((number << 3) | 2), varint(payload.length), payload]);
  }
  const header = field(8, Buffer.from("narration", "utf8"));
  const envelope = field(1, header);
  return field(2, envelope).toString("base64");
}

// ---------------------------------------------------------------------------
// 历史 / 收尾 / 标题来源
// ---------------------------------------------------------------------------

describe("claude session history", () => {
  test("restores recent sessions with title priority and skips SDK/empty sessions", () => {
    const home = temporary("agent-host-claude-history-");
    try {
      const projects = join(home, "projects");
      writeTranscript(projects, "s1", [
        { type: "ai-title", aiTitle: "Generated name" },
        { type: "custom-title", customTitle: "Custom name" },
        {
          type: "user",
          cwd: "E:/work/demo",
          entrypoint: "sdk-cli",
          timestamp: "2026-10-30T09:00:00.000Z",
          message: { content: "first prompt" },
        },
        {
          type: "assistant",
          timestamp: "2026-10-30T09:01:00.000Z",
          message: { model: "claude-opus-5-5", content: [{ type: "text", text: "done" }] },
        },
      ], NOW - 60 * 60 * 1000);
      writeTranscript(projects, "sdk-py", [
        { type: "user", cwd: "E:/work/demo", entrypoint: "sdk-py", message: { content: "automation" } },
      ], NOW - 2 * 60 * 60 * 1000);
      writeTranscript(projects, "empty", [
        { type: "meta", cwd: "E:/work/demo" },
      ], NOW - 3 * 60 * 60 * 1000);
      writeTranscript(projects, "old", [
        { type: "user", cwd: "E:/work/demo", entrypoint: "sdk-cli", message: { content: "too old" } },
      ], NOW - 400 * 24 * 60 * 60 * 1000);

      const entries = ClaudeSessionHistory.recentSessions(projects, NOW, 200);
      assert.deepEqual(entries.map((entry) => entry.sessionID), ["s1"]);
      assert.equal(entries[0]?.title, "Custom name");
      assert.equal(entries[0]?.titleSource, 3);
      assert.equal(entries[0]?.projectPath, "E:/work/demo");
      assert.equal(entries[0]?.model, "claude-opus-5-5");
      assert.equal(entries[0]?.lastMessage, "done");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("detects the turn-ending marker and stop_hook_summary", () => {
    const home = temporary("agent-host-claude-ending-");
    try {
      const interruption = writeTranscript(join(home, "projects"), "i1", [
        { type: "user", timestamp: "2026-10-30T10:00:00.000Z", message: { content: "go" } },
        {
          type: "user",
          timestamp: "2026-10-30T10:00:05.000Z",
          message: { content: "[Request interrupted by user for tool use]" },
        },
      ]);
      assert.deepEqual(ClaudeSessionHistory.turnEnding(interruption), {
        kind: "interrupted",
        at: Date.parse("2026-10-30T10:00:05.000Z"),
      });
      const completed = writeTranscript(join(home, "projects"), "c1", [
        { type: "assistant", timestamp: "2026-10-30T10:00:00.000Z", message: { content: "done" } },
        { type: "system", subtype: "stop_hook_summary", timestamp: "2026-10-30T10:00:06.000Z" },
      ]);
      assert.deepEqual(ClaudeSessionHistory.turnEnding(completed), {
        kind: "completed",
        at: Date.parse("2026-10-30T10:00:06.000Z"),
      });
      const running = writeTranscript(join(home, "projects"), "r1", [
        { type: "assistant", timestamp: "2026-10-30T10:00:00.000Z", message: { content: "still working" } },
      ]);
      assert.equal(ClaudeSessionHistory.turnEnding(running), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("restoreRecentSessions adopts completed / idle sessions silently", async () => {
    const home = temporary("agent-host-claude-restore-");
    const host = new FakeHost();
    const instance = connector(host, home);
    try {
      const projects = join(home, "projects");
      writeTranscript(projects, "s1", [
        { type: "custom-title", customTitle: "Recent" },
        {
          type: "user",
          cwd: "E:/work/demo",
          entrypoint: "sdk-cli",
          timestamp: "2026-10-30T09:00:00.000Z",
          message: { content: "prompt" },
        },
      ], NOW - 60 * 60 * 1000);
      writeTranscript(projects, "s2", [
        { type: "custom-title", customTitle: "Stale" },
        {
          type: "user",
          cwd: "E:/work/other",
          entrypoint: "sdk-cli",
          timestamp: "2026-10-29T09:00:00.000Z",
          message: { content: "prompt" },
        },
      ], NOW - 25 * 60 * 60 * 1000);
      await instance.restoreRecentSessions();
      assert.equal(host.tasksById.get("claude:s1")?.status, "completed");
      assert.equal(host.tasksById.get("claude:s1")?.title, "Recent");
      assert.equal(host.tasksById.get("claude:s2")?.status, "idle");
      assert.deepEqual(host.projects.map((project) => project.path).sort(), ["E:/work/demo", "E:/work/other"]);
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 连接器 hook 映射 / 审批
// ---------------------------------------------------------------------------

describe("claude connector hooks", () => {
  test("maps status transitions and StopFailure diagnosis", async () => {
    const home = temporary("agent-host-claude-connector-");
    const host = new FakeHost();
    const instance = connector(host, home);
    try {
      expectNow(
        await instance.handleHook(
          hookRequest({
            hook_event_name: "UserPromptSubmit",
            session_id: "s1",
            cwd: "E:/work/demo",
            prompt: "fix the login",
          }),
        ),
      );
      assert.equal(host.tasksById.get("claude:s1")?.status, "running");
      assert.equal(host.tasksById.get("claude:s1")?.title, "fix the login");
      assert.equal(host.tasksById.get("claude:s1")?.projectName, "demo");
      assert.equal(host.live.has("claude:s1"), true);

      expectNow(
        await instance.handleHook(
          hookRequest({
            hook_event_name: "Notification",
            session_id: "s1",
            notification_type: "idle_prompt",
          }),
        ),
      );
      assert.equal(host.tasksById.get("claude:s1")?.status, "waitingInput");

      expectNow(
        await instance.handleHook(
          hookRequest({
            hook_event_name: "Stop",
            session_id: "s1",
            last_assistant_message: "done",
          }),
        ),
      );
      assert.equal(host.tasksById.get("claude:s1")?.status, "completed");
      assert.equal(host.tasksById.get("claude:s1")?.lastMessage, "done");

      expectNow(
        await instance.handleHook(
          hookRequest({
            hook_event_name: "UserPromptSubmit",
            session_id: "s2",
            cwd: "E:/work/demo",
            prompt: "do it again",
          }),
        ),
      );
      expectNow(
        await instance.handleHook(
          hookRequest({
            hook_event_name: "StopFailure",
            session_id: "s2",
            error: "rate_limit",
            error_details: "Claude AI usage limit reached|1791043200",
          }),
        ),
      );
      const failed = host.tasksById.get("claude:s2") as BusTask & {
        diagnosis?: { kind: string; resetsAt?: string };
      };
      assert.equal(failed.status, "failed");
      assert.equal(failed.diagnosis?.kind, "usageLimit");
      assert.equal(failed.diagnosis?.resetsAt, new Date(1791043200 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("holds PermissionRequest and answers AskUserQuestion with full updatedInput", async () => {
    const home = temporary("agent-host-claude-ask-");
    const host = new FakeHost();
    const instance = connector(host, home);
    try {
      const reply = await instance.handleHook(
        hookRequest({
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          cwd: "E:/work/demo",
          tool_name: "AskUserQuestion",
          tool_use_id: "q1",
          tool_input: {
            questions: [
              {
                question: "Deploy?",
                header: "Deploy",
                options: [{ label: "Yes" }, { label: "No" }],
              },
            ],
          },
        }),
      );
      assert.equal(reply.kind, "hold");
      if (reply.kind !== "hold") throw new Error("expected hold");
      const task = host.tasksById.get("claude:s1");
      assert.equal(task?.status, "waitingInput");
      assert.equal(task?.pendingRequest?.kind, "input");
      assert.equal((task?.pendingRequest as { questions?: unknown[] })?.questions?.length, 1);

      const outcome = await instance.approve("claude:s1", "q1", "allow", { "0": ["Yes"] });
      assert.equal(outcome.taskId, "s1");
      const response = await reply.hold.value();
      assert.equal(response.status, 200);
      const body = JSON.parse((response.body ?? Buffer.alloc(0)).toString("utf8"));
      assert.equal(body.hookSpecificOutput.decision.behavior, "allow");
      assert.deepEqual(body.hookSpecificOutput.decision.updatedInput.answers, { "Deploy?": "Yes" });
      assert.ok(Array.isArray(body.hookSpecificOutput.decision.updatedInput.questions));
      assert.equal(host.tasksById.get("claude:s1")?.status, "running");
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("maps a plain permission hook allow without updatedInput", async () => {
    const home = temporary("agent-host-claude-perm-");
    const host = new FakeHost();
    const instance = connector(host, home);
    try {
      const reply = await instance.handleHook(
        hookRequest({
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          cwd: "E:/work/demo",
          tool_name: "Bash",
          tool_use_id: "p1",
          tool_input: { command: "npm test" },
        }),
      );
      assert.equal(reply.kind, "hold");
      if (reply.kind !== "hold") throw new Error("expected hold");
      assert.equal(host.tasksById.get("claude:s1")?.status, "waitingApproval");
      assert.equal(host.tasksById.get("claude:s1")?.pendingRequest?.detail, "npm test");
      await instance.approve("claude:s1", "p1", "allow");
      const body = JSON.parse(((await reply.hold.value()).body ?? Buffer.alloc(0)).toString("utf8"));
      assert.deepEqual(body.hookSpecificOutput.decision, { behavior: "allow" });
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("serves hooks over fake loopback HTTP and holds the response", async () => {
    const home = temporary("agent-host-claude-http-");
    const support = temporary("agent-host-claude-http-support-");
    const host = new FakeHost();
    const instance = connector(host, home);
    try {
      const port = await instance.startHookServer({
        supportDirectory: support,
        requestedPort: 0,
        sharedSecret: null,
      });
      const base = `http://127.0.0.1:${port}/hooks/claude`;
      const promptResponse = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "http-1",
          cwd: "E:/work/http",
          prompt: "over http",
        }),
      });
      assert.equal(promptResponse.status, 204);
      assert.equal((await promptResponse.text()).length, 0);
      assert.equal(host.tasksById.get("claude:http-1")?.status, "running");

      const pending = fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "PermissionRequest",
          session_id: "http-1",
          cwd: "E:/work/http",
          tool_name: "Bash",
          tool_use_id: "http-tool",
          tool_input: { command: "ls" },
        }),
      });
      let pendingTask = host.tasksById.get("claude:http-1");
      for (let attempt = 0; attempt < 200 && pendingTask?.pendingRequest?.id !== "http-tool"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pendingTask = host.tasksById.get("claude:http-1");
      }
      assert.equal(pendingTask?.pendingRequest?.id, "http-tool");
      await instance.approve("claude:http-1", "http-tool", "deny");
      const permissionResponse = await pending;
      assert.equal(permissionResponse.status, 200);
      const body = JSON.parse(await permissionResponse.text());
      assert.deepEqual(body.hookSpecificOutput.decision, {
        behavior: "deny",
        message: "用户在手机上拒绝了",
      });
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(support, { recursive: true, force: true });
    }
  });

  test("SessionEnd interrupts a mid-turn session and leaves queued work out", async () => {
    const home = temporary("agent-host-claude-end-");
    const host = new FakeHost();
    const instance = connector(host, home);
    try {
      await instance.handleHook(
        hookRequest({
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          cwd: "E:/work/demo",
          prompt: "long task",
        }),
      );
      expectNow(
        await instance.handleHook(
          hookRequest({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "E:/work/demo" }),
        ),
      );
      assert.equal(host.tasksById.get("claude:s1")?.status, "interrupted");
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("checkTurnEndings picks up a computer-side interruption marker", async () => {
    const home = temporary("agent-host-claude-turnend-");
    const host = new FakeHost();
    const instance = connector(host, home);
    try {
      const path = writeTranscript(join(home, "projects"), "te1", [
        {
          type: "assistant",
          timestamp: "2026-10-30T11:59:59.000Z",
          message: { content: "working" },
        },
        {
          type: "user",
          timestamp: "2026-10-30T12:00:00.000Z",
          message: { content: "[Request interrupted by user]" },
        },
      ]);
      await instance.handleHook(
        hookRequest({
          hook_event_name: "UserPromptSubmit",
          session_id: "te1",
          cwd: "E:/work/demo",
          transcript_path: path,
          prompt: "run",
        }),
      );
      assert.equal(host.tasksById.get("claude:te1")?.status, "running");
      await instance.checkTurnEndingsNow();
      assert.equal(host.tasksById.get("claude:te1")?.status, "interrupted");
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 电脑上删掉 / 归档的会话
// ---------------------------------------------------------------------------

describe("claude session presence", () => {
  test("indexes desktop records and transcript ids", () => {
    const home = temporary("agent-host-claude-presence-");
    try {
      const account = join(home, "sessions", "org", "account");
      mkdirSync(account, { recursive: true });
      writeFileSync(join(account, "local_a.json"), JSON.stringify({ cliSessionId: "s1" }), "utf8");
      writeFileSync(
        join(account, "local_b.json"),
        JSON.stringify({ cliSessionId: "s2", isArchived: true }),
        "utf8",
      );
      writeFileSync(join(account, "local_c.json"), JSON.stringify({}), "utf8");
      const cache = new Map();
      const index = ClaudeDesktopSessionIndex.read([join(home, "sessions")], cache);
      assert.ok(index);
      assert.equal(index.recorded.get("s1"), account);
      assert.equal(index.recorded.has("c"), false);
      assert.equal(index.archived.has("s2"), true);
      assert.equal(index.accounts.has(account), true);
      assert.equal(cache.size, 3);

      const projects = join(home, "projects");
      mkdirSync(join(projects, "-E-work-demo"), { recursive: true });
      writeFileSync(join(projects, "-E-work-demo", "s1.jsonl"), "", "utf8");
      writeFileSync(join(projects, "-E-work-demo", "s3.jsonl"), "", "utf8");
      writeFileSync(join(projects, "-E-work-demo", "notes.txt"), "", "utf8");
      const ids = ClaudeSessionPresence.transcriptIDs(projects);
      assert.deepEqual([...(ids ?? [])].sort(), ["s1", "s3"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 子进程参数 / 环境 / stdin
// ---------------------------------------------------------------------------

describe("claude subprocess helpers", () => {
  test("passes the complete environment plus injected variables", () => {
    const environment = buildEnvironment({ BOTBUS_TEST: "1" });
    assert.equal(environment.BOTBUS_TEST, "1");
    if (process.env.PATH !== undefined) assert.equal(environment.PATH, process.env.PATH);
    const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
    if (process.env[homeKey] !== undefined) assert.equal(environment[homeKey], process.env[homeKey]);
  });

  test("orders claude arguments and ends optional variadics with --input-format", () => {
    const args = claudeArguments({
      resuming: "s1",
      injection: null,
      model: "opus",
      effort: "high",
      name: "-leading dash",
    });
    assert.deepEqual(args.slice(0, 7), ["-p", "--resume", "s1", "--model", "opus", "--effort", "high"]);
    assert.equal(args[7], "--name=-leading dash");
    assert.deepEqual(args.slice(8), [
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  test("writes an image before the text block and stays on one line", () => {
    const payload = stdinPayload("hello", [
      { data: Buffer.from("abc"), contentType: "image/png" },
    ]).toString("utf8");
    assert.equal(payload.endsWith("\n"), true);
    assert.equal(payload.split("\n").length, 2);
    const parsed = JSON.parse(payload);
    assert.equal(parsed.message.role, "user");
    assert.equal(parsed.message.content[0].type, "image");
    assert.equal(parsed.message.content[0].source.data, Buffer.from("abc").toString("base64"));
    assert.deepEqual(parsed.message.content[1], { type: "text", text: "hello" });
  });
});
