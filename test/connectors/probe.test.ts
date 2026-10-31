import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { runAgentCheck, runAgentList } from "../../src/cli.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import {
  ProbeError,
  formatAgentLine,
  probeAcpAgent,
  type ProbeProcessHandlers,
  type ProbeProcessLike,
} from "../../src/connectors/probe.js";
import { AcpAuthRequired, AcpRejected, AcpTimeout } from "../../src/connectors/runtime.js";

type FakeCalls = Array<{ method: string; params: unknown; timeoutMs?: number }>;

type FakeProcess = ProbeProcessLike & {
  calls: FakeCalls;
  kills: number;
};

type FakeOptions = {
  start?: () => Promise<void>;
  call?: (
    method: string,
    params: unknown,
    handlers: ProbeProcessHandlers,
  ) => unknown | Promise<unknown>;
};

/** 不启动任何进程的假 transport；`createProcess` 注入用。 */
function fakeProcess(handlers: ProbeProcessHandlers, options: FakeOptions = {}): FakeProcess {
  const calls: FakeCalls = [];
  let kills = 0;
  return {
    capabilities: { loadSession: true, resume: false, image: false, listSessions: true },
    async start() {
      await options.start?.();
    },
    async call(method, params, timeoutMs) {
      calls.push({ method, params, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      return options.call?.(method, params, handlers);
    },
    respond() {},
    notify() {},
    kill() {
      kills += 1;
    },
    get calls() {
      return calls;
    },
    get kills() {
      return kills;
    },
  };
}

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: "my-agent",
    kind: "acp",
    name: "My Agent",
    executable: process.execPath,
    args: [],
    env: {},
    origin: "manifest",
    available: true,
    enabled: true,
    ...overrides,
  };
}

async function captureConsole<T>(
  channel: "log" | "error",
  body: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console[channel];
  console[channel] = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(" "));
  };
  try {
    const value = await body();
    return { value, lines };
  } finally {
    console[channel] = original;
  }
}

describe("agent list", () => {
  test("formats id / kind / name / available / enabled / status / lastError on one line", () => {
    assert.equal(
      formatAgentLine(
        makeSpec({
          id: "gemini",
          kind: "acp",
          name: "Gemini CLI",
          available: false,
          enabled: false,
          lastError: "not installed",
        }),
      ),
      "gemini\tacp\tGemini CLI\tavailable=false\tenabled=false\tstatus=degraded\tlastError=not installed",
    );
    assert.equal(
      formatAgentLine(makeSpec({ id: "dsh", kind: "dsh", name: "DeepSeek Harness" })),
      "dsh\tdsh\tDeepSeek Harness\tavailable=true\tenabled=true\tstatus=ok\tlastError=-",
    );
    assert.equal(
      formatAgentLine(
        makeSpec({
          id: "codex",
          kind: "codex",
          name: "Codex",
          available: true,
          status: "error",
          lastError: "probe failed",
        }),
      ),
      "codex\tcodex\tCodex\tavailable=true\tenabled=true\tstatus=error\tlastError=probe failed",
    );
  });

  test("prints one line per agent plus manifest problems, and exits 0", async () => {
    const { value, lines } = await captureConsole("log", () =>
      runAgentList({
        discover: async () => ({
          agents: [
            makeSpec({ id: "gemini", name: "Gemini CLI", available: true }),
            makeSpec({
              id: "broken",
              name: "Broken",
              available: false,
              lastError: "找不到 command：broken",
            }),
          ],
          problems: [{ file: "C:/agents/bad.json", reason: "文件名必须是 bad.json" }],
        }),
      }),
    );
    assert.equal(value, 0);
    assert.deepEqual(lines, [
      "gemini\tacp\tGemini CLI\tavailable=true\tenabled=true\tstatus=ok\tlastError=-",
      "broken\tacp\tBroken\tavailable=false\tenabled=true\tstatus=degraded\tlastError=找不到 command：broken",
      "✗ C:/agents/bad.json：文件名必须是 bad.json",
    ]);
  });
});

describe("agent check", () => {
  test("returns 2 and explains when the id does not exist", async () => {
    const { value, lines } = await captureConsole("error", () =>
      runAgentCheck("missing", undefined, {
        discover: async () => ({ agents: [], problems: [] }),
      }),
    );
    assert.equal(value, 2);
    assert.match(lines.join("\n"), /找不到 agent：missing/);
  });

  test("returns 2 for an unavailable agent", async () => {
    const { value, lines } = await captureConsole("error", () =>
      runAgentCheck("gone", undefined, {
        discover: async () => ({
          agents: [
            makeSpec({
              id: "gone",
              available: false,
              executable: undefined,
              lastError: "找不到 command：gone",
            }),
          ],
          problems: [],
        }),
      }),
    );
    assert.equal(value, 2);
    assert.match(lines.join("\n"), /agent gone 不可用：找不到 command：gone/);
  });

  test("returns 0 and prints the initialize/session/reply summary on success", async () => {
    const probe = async (spec: AgentSpec, prompt?: string) => ({
      spec,
      cwd: "/tmp/probe",
      protocolVersion: 1,
      capabilities: { loadSession: true, resume: false, image: false, listSessions: true },
      sessionId: "sess-1",
      prompt,
      stopReason: "end_turn",
      agentText: "OK",
      toolCalls: [{ title: "npm test" }],
    });
    const { value, lines } = await captureConsole("log", () =>
      runAgentCheck("my-agent", "hi", {
        discover: async () => ({ agents: [makeSpec()], problems: [] }),
        probe: probe as typeof probeAcpAgent,
      }),
    );
    assert.equal(value, 0);
    assert.match(lines.join("\n"), /initialize: ok/);
    assert.match(lines.join("\n"), /session\/new: ok \(sess-1\)/);
    assert.match(lines.join("\n"), /session\/prompt: stopReason=end_turn/);
    assert.match(lines.join("\n"), /agent: OK/);
  });
});

describe("probeAcpAgent", () => {
  test("runs initialize -> session/new -> session/prompt on an injected fake process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "probe-test-"));
    let fake: FakeProcess | undefined;
    try {
      const result = await probeAcpAgent(makeSpec(), "hi", {
        cwd,
        createProcess: (_spec, handlers) => {
          fake = fakeProcess(handlers, {
            call: (method) => {
              if (method === "session/new") return { sessionId: "sess-1" };
              if (method === "session/prompt") {
                handlers.onEvent({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "sess-1",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "hello" },
                    },
                  },
                });
                handlers.onEvent({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "sess-1",
                    update: { sessionUpdate: "tool_call", title: "npm test", toolCallId: "call_1" },
                  },
                });
                return { stopReason: "end_turn" };
              }
              return undefined;
            },
          });
          return fake;
        },
      });

      assert.equal(result.sessionId, "sess-1");
      assert.equal(result.protocolVersion, 1);
      assert.equal(result.stopReason, "end_turn");
      assert.equal(result.agentText, "hello");
      assert.deepEqual(result.toolCalls, [{ title: "npm test", toolCallId: "call_1" }]);
      assert.equal(result.capabilities.loadSession, true);
      assert.deepEqual(
        fake?.calls.map((call) => call.method),
        ["session/new", "session/prompt"],
      );
      assert.deepEqual(fake?.calls[0]?.params, { cwd, mcpServers: [] });
      assert.deepEqual((fake?.calls[1]?.params as { prompt: unknown }).prompt, [
        { type: "text", text: "hi" },
      ]);
      assert.equal(fake?.kills, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("skips session/prompt when no prompt is given", async () => {
    let fake: FakeProcess | undefined;
    const result = await probeAcpAgent(makeSpec(), undefined, {
      createProcess: (_spec, handlers) => {
        fake = fakeProcess(handlers, {
          call: (method) => (method === "session/new" ? { sessionId: "sess-2" } : undefined),
        });
        return fake;
      },
    });
    assert.equal(result.sessionId, "sess-2");
    assert.equal(result.stopReason, undefined);
    assert.deepEqual(
      fake?.calls.map((call) => call.method),
      ["session/new"],
    );
  });

  test("classifies initialize timeout as a readable ProbeError", async () => {
    await assert.rejects(
      probeAcpAgent(makeSpec(), "hi", {
        createProcess: (_spec, handlers) =>
          fakeProcess(handlers, {
            start: async () => {
              throw new AcpTimeout("initialize timed out");
            },
          }),
      }),
      (error: unknown) =>
        error instanceof ProbeError &&
        error.code === "timeout" &&
        /initialize 超时/.test(error.message),
    );
  });

  test("classifies auth failures as ProbeError(auth)", async () => {
    await assert.rejects(
      probeAcpAgent(makeSpec(), "hi", {
        createProcess: (_spec, handlers) =>
          fakeProcess(handlers, {
            call: (method) => {
              if (method === "session/new") throw new AcpAuthRequired("please log in");
              return undefined;
            },
          }),
      }),
      (error: unknown) =>
        error instanceof ProbeError &&
        error.code === "auth" &&
        /session\/new 需要先登录/.test(error.message),
    );
  });

  test("classifies a rejected prompt as ProbeError(rejected) and still kills the process", async () => {
    let fake: FakeProcess | undefined;
    await assert.rejects(
      probeAcpAgent(makeSpec(), "hi", {
        createProcess: (_spec, handlers) => {
          fake = fakeProcess(handlers, {
            call: (method) => {
              if (method === "session/new") return { sessionId: "sess-3" };
              if (method === "session/prompt") throw new AcpRejected("agent exited");
              return undefined;
            },
          });
          return fake;
        },
      }),
      (error: unknown) =>
        error instanceof ProbeError &&
        error.code === "rejected" &&
        /session\/prompt 被 agent 拒绝或退出/.test(error.message),
    );
    assert.equal(fake?.kills, 1);
  });

  test("works end-to-end against the fake ACP fixture process", async () => {
    const fixture = fileURLToPath(new URL("../fixtures/fake-acp.mjs", import.meta.url));
    const result = await probeAcpAgent(
      makeSpec({ executable: process.execPath, args: [fixture] }),
      "ECHO: hello",
    );
    assert.equal(result.sessionId, "sess-1");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.agentText, "hello");
  });
});
