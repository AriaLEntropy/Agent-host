import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HostStatus } from "../../src/desktop/host-controller.js";
import {
  agentStateLabel,
  panelView,
  statusLabel,
  trayIconName,
  trayTooltip,
} from "../../src/desktop/tray-menu.js";

function status(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    connection: "connected",
    relayConfigured: true,
    paired: false,
    hostName: "DESKTOP-1",
    pendingCount: 0,
    agents: [],
    manifestProblems: [],
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "codex",
    kind: "codex" as const,
    name: "Codex",
    available: true,
    enabled: true,
    connector: "codex",
    ...overrides,
  };
}

describe("tray view", () => {
  test("status row follows connection and pending count", () => {
    assert.equal(statusLabel(status()), "已连接 · 无待处理");
    assert.equal(statusLabel(status({ pendingCount: 2 })), "已连接 · 待处理 2");
    assert.equal(statusLabel(status({ connection: "unpaired" })), "未配对");
    assert.equal(statusLabel(status({ connection: "disconnected" })), "连接中断");
    assert.equal(statusLabel(status({ relayConfigured: false })), "未配置 Relay");
  });

  test("agent state only uses the four requirement words", () => {
    assert.equal(agentStateLabel(agent() as any), "可用");
    assert.equal(agentStateLabel(agent({ enabled: false }) as any), "已停用");
    assert.equal(agentStateLabel(agent({ available: false }) as any), "未安装");
    // OpenClaw 默认关闭：没装时仍报「未安装」，不能显示成只是被停用
    assert.equal(agentStateLabel(agent({ available: false, enabled: false }) as any), "未安装");
    assert.equal(agentStateLabel(agent({ lastError: "boom" }) as any), "出错");
    assert.equal(agentStateLabel(agent({ status: "error" }) as any), "出错");
  });

  test("panel entries follow relay and pairing state", () => {
    assert.deepEqual(
      panelView(status({ relayConfigured: false })).entries.map((entry) => entry.label),
      ["配置 Relay…"],
    );
    assert.deepEqual(
      panelView(status({ paired: false })).entries.map((entry) => entry.label),
      ["配对手机…"],
    );
    assert.deepEqual(
      panelView(status({ paired: true })).entries.map((entry) => entry.label),
      ["重新配对…"],
    );
  });

  test("panel view carries rows and manifest problems without losing state", () => {
    const view = panelView(
      status({
        pendingCount: 1,
        agents: [
          agent(),
          agent({ id: "opencode", kind: "acp", name: "OpenCode", enabled: false, available: false }),
          agent({ id: "hermes", kind: "hermes", name: "Hermes", available: false }),
          agent({ id: "claude", kind: "claude", name: "Claude Code", lastError: "启动失败" }),
        ],
        manifestProblems: [{ file: "broken.json", reason: "缺少 command" }],
      }),
    );
    assert.equal(view.statusLabel, "已连接 · 待处理 1");
    assert.deepEqual(view.agents[0], {
      id: "codex",
      name: "Codex",
      state: "可用",
      enabled: true,
      available: true,
      hasError: false,
      icon: "../icons/agents/agent-codex.jpg",
    });
    assert.equal(view.agents[1].state, "未安装");
    assert.equal(view.agents[1].available, false);
    assert.equal(view.agents[1].icon, "../icons/agents/agent-default.svg");
    // 未安装的 lastError 不当作「出错」，不显示详情入口
    assert.equal(view.agents[2].hasError, false);
    // 装了但启动失败才算「出错」，并带出错误摘要
    assert.equal(view.agents[3].state, "出错");
    assert.equal(view.agents[3].hasError, true);
    assert.equal(view.agents[3].errorText, "启动失败");
    assert.deepEqual(view.problems, [{ file: "broken.json", reason: "缺少 command" }]);
  });

  test("icon and tooltip follow connection and badge count", () => {
    assert.equal(trayIconName(status({ connection: "unpaired" })), "tray-unpaired.png");
    assert.equal(trayIconName(status({ connection: "disconnected" })), "tray-disconnected.png");
    assert.equal(trayIconName(status()), "tray-connected.png");
    assert.equal(trayIconName(status({ pendingCount: 3 })), "tray-connected-3.png");
    assert.equal(trayIconName(status({ pendingCount: 12 })), "tray-connected-9plus.png");
    assert.equal(trayTooltip(status({ pendingCount: 2 })), "AgentBus · 已连接 · 待处理 2");
    assert.equal(trayTooltip(status({ connection: "unpaired" })), "AgentBus · 未配对");
    assert.equal(trayTooltip(status({ relayConfigured: false })), "AgentBus · 未配置 Relay");
  });
});
