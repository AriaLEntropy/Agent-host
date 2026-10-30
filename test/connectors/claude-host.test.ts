import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { BusProject, BusTask, BusTaskMessages } from "../../src/bus/store.js";
import {
  ClaudeHookInstaller,
  LocalHookServer,
  claudePaths,
  createClaudeConnector,
  protocolTimestamp,
  type ClaudeConnectorOptions,
  type ClaudeHookInstallerLike,
} from "../../src/connectors/claude/index.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");

class FakeHost {
  readonly agentId = "agent-1";
  readonly tasksById = new Map<string, BusTask>();
  readonly projects: BusProject[] = [];
  readonly live = new Set<string>();

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

  emitMessages(_messages: BusTaskMessages): void {}

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

type InstallerCalls = {
  isInstalled: number;
  upgrade: number;
  supports: string[];
};

function fakeInstaller(installed: boolean, calls: InstallerCalls): ClaudeHookInstallerLike {
  return {
    isInstalled(paths, supportDirectory) {
      calls.isInstalled += 1;
      calls.supports.push(supportDirectory);
      assert.ok(paths.settingsFile.length > 0);
      return installed;
    },
    upgradeIfNeeded(_paths, supportDirectory) {
      calls.upgrade += 1;
      calls.supports.push(supportDirectory);
      return true;
    },
  };
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

function options(
  home: string,
  supportDirectory: string,
  extra: Partial<ClaudeConnectorOptions> = {},
): ClaudeConnectorOptions {
  return {
    autoStart: true,
    paths: claudePaths({ claudeHome: home, desktopSessionsDirectories: [] }),
    binary: () => null,
    now: () => new Date(NOW),
    titleRetryDelays: [],
    turnEndCheckInterval: 3600,
    presenceSweepInterval: 3600,
    supportDirectory,
    logger: () => {},
    ...extra,
  };
}

function secretHeader(supportDirectory: string): string {
  const line = readFileSync(join(supportDirectory, LocalHookServer.sharedSecret.defaultFileName), "utf8");
  const match = new RegExp(`${LocalHookServer.sharedSecret.headerName}:\\s*([^\\s"]+)`).exec(line);
  assert.ok(match, "共享密钥文件里应有 header 行");
  return match[1];
}

function hookBody(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

describe("claude host services", () => {
  test("autoStart:false starts nothing", async () => {
    const home = temporary("agent-host-claude-host-off-");
    const support = join(home, "support");
    const host = new FakeHost();
    const calls: InstallerCalls = { isInstalled: 0, upgrade: 0, supports: [] };
    const instance = createClaudeConnector(host, {
      ...options(home, support),
      autoStart: false,
      hookInstaller: fakeInstaller(true, calls),
    });
    try {
      await instance.whenHostServicesReady();
      assert.equal(instance.hostServicesState, "idle");
      assert.equal(instance.hostServicesError, null);
      assert.equal(instance.hookServerPort, null);
      assert.equal(instance.isSweepingPresence, false);
      assert.equal(instance.isCheckingTurnEndings, false);
      assert.equal(calls.isInstalled, 0);
      assert.equal(calls.upgrade, 0);
      assert.equal(existsSync(support), false);
      assert.equal(host.tasksById.size, 0);
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("autoStart upgrades installed hooks, restores history, serves hooks and cleans up", async () => {
    const home = temporary("agent-host-claude-host-on-");
    const support = temporary("agent-host-claude-host-support-");
    const host = new FakeHost();
    const calls: InstallerCalls = { isInstalled: 0, upgrade: 0, supports: [] };
    writeTranscript(
      join(home, "projects"),
      "hist1",
      [
        { type: "custom-title", customTitle: "From disk" },
        {
          type: "user",
          cwd: "E:/work/history",
          entrypoint: "sdk-cli",
          timestamp: "2026-10-30T11:00:00.000Z",
          message: { content: "restored prompt" },
        },
      ],
      NOW - 60 * 60 * 1000,
    );

    const instance = createClaudeConnector(host, {
      ...options(home, support),
      hookInstaller: fakeInstaller(true, calls),
    });
    try {
      await instance.whenHostServicesReady();
      assert.equal(instance.hostServicesState, "running");
      assert.equal(instance.hostServicesError, null);
      assert.deepEqual(instance.hostServicesWarnings, []);
      assert.equal(calls.isInstalled, 1);
      assert.equal(calls.upgrade, 1);
      assert.deepEqual(calls.supports, [support, support]);

      // 补历史在 autoStart 里跑过：磁盘上的会话静默进了任务表。
      assert.equal(host.tasksById.get("claude:hist1")?.status, "completed");
      assert.equal(host.tasksById.get("claude:hist1")?.title, "From disk");
      assert.equal(instance.isSweepingPresence, true);

      // hook server 用临时目录里的实际端口与共享密钥。
      const port = instance.hookServerPort;
      assert.ok(port !== null && port > 0);
      const published = JSON.parse(
        readFileSync(join(support, LocalHookServer.portFileName), "utf8"),
      ) as { port: number };
      assert.equal(published.port, port);

      const transcript = writeTranscript(join(home, "projects"), "live1", [
        {
          type: "assistant",
          timestamp: "2026-10-30T11:59:59.000Z",
          message: { content: "working" },
        },
      ]);
      const base = `http://127.0.0.1:${port}/hooks/claude`;
      const response = await fetch(base, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LocalHookServer.sharedSecret.headerName]: secretHeader(support),
        },
        body: hookBody({
          hook_event_name: "UserPromptSubmit",
          session_id: "live1",
          cwd: "E:/work/demo",
          transcript_path: transcript,
          prompt: "over the hook server",
        }),
      });
      assert.equal(response.status, 204);
      assert.equal((await response.text()).length, 0);
      assert.equal(host.tasksById.get("claude:live1")?.status, "running");
      // 这一轮是 running 且有 transcript：收尾检测循环应被 autoStart 起起来。
      assert.equal(instance.isCheckingTurnEndings, true);

      // stop 幂等：计时器、hook server、端口/密钥文件都清掉。
      instance.stop();
      instance.dispose();
      assert.equal(instance.hostServicesState, "stopped");
      assert.equal(instance.isSweepingPresence, false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(instance.isCheckingTurnEndings, false);
      assert.equal(existsSync(join(support, LocalHookServer.portFileName)), false);
      assert.equal(
        existsSync(join(support, LocalHookServer.sharedSecret.defaultFileName)),
        false,
      );
      await assert.rejects(
        fetch(base, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LocalHookServer.sharedSecret.headerName]: "stale",
          },
          body: hookBody({ hook_event_name: "Stop", session_id: "live1" }),
          signal: AbortSignal.timeout(2000),
        }),
      );
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(support, { recursive: true, force: true });
    }
  });

  test("does not install hooks when they were never installed", async () => {
    const home = temporary("agent-host-claude-host-uninstalled-");
    const support = temporary("agent-host-claude-host-uninstalled-support-");
    const host = new FakeHost();
    const calls: InstallerCalls = { isInstalled: 0, upgrade: 0, supports: [] };
    // 不传 autoStart：默认就该启动（这里验证默认值，而不是显式 true）。
    const { autoStart: _autoStart, ...defaultOptions } = options(home, support);
    const instance = createClaudeConnector(host, {
      ...defaultOptions,
      hookInstaller: fakeInstaller(false, calls),
    });
    try {
      await instance.whenHostServicesReady();
      assert.equal(instance.hostServicesState, "running");
      assert.equal(calls.isInstalled, 1);
      assert.equal(calls.upgrade, 0);
      // 假安装器什么都没写；真实用户目录也绝不能被碰。
      assert.equal(existsSync(join(home, "settings.json")), false);
      assert.equal(existsSync(ClaudeHookInstaller.scriptURL(support)), false);
    } finally {
      instance.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(support, { recursive: true, force: true });
    }
  });

  test("reports a failed hook server instead of pretending it runs", async () => {
    const home = temporary("agent-host-claude-host-conflict-");
    const support = temporary("agent-host-claude-host-conflict-support-");
    const host = new FakeHost();
    const blocker = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        if (!address || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
    const instance = createClaudeConnector(host, {
      ...options(home, support),
      hookInstaller: fakeInstaller(false, { isInstalled: 0, upgrade: 0, supports: [] }),
      hookServerRequestedPort: port,
      hookServerPortRetries: 1,
    });
    try {
      await instance.whenHostServicesReady();
      assert.equal(instance.hostServicesState, "failed");
      assert.ok(instance.hostServicesError !== null);
      assert.equal(instance.hookServerPort, null);
      assert.equal(instance.isSweepingPresence, false);
    } finally {
      instance.stop();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
      rmSync(support, { recursive: true, force: true });
    }
  });
});
