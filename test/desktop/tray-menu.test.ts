import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HostStatus } from "../../src/desktop/host-controller.js";
import {
  agentStateLabel,
  buildTrayMenu,
  trayIconName,
  trayTooltip,
  type TrayMenuNode,
} from "../../src/desktop/tray-menu.js";

function status(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    connection: "connected",
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

function findSubmenu(nodes: TrayMenuNode[], label: string): TrayMenuNode[] {
  const node = nodes.find((item) => item.kind === "submenu" && item.label === label);
  assert.ok(node && node.kind === "submenu", `missing submenu ${label}`);
  return node.submenu;
}

describe("tray menu", () => {
  test("status row follows connection and pending count", () => {
    assert.equal((buildTrayMenu(status())[0] as any).label, "已连接 · 无待处理");
    assert.equal(
      (buildTrayMenu(status({ pendingCount: 2 }))[0] as any).label,
      "已连接 · 待处理 2",
    );
    assert.equal(
      (buildTrayMenu(status({ connection: "unpaired" }))[0] as any).label,
      "未配对",
    );
    assert.equal(
      (buildTrayMenu(status({ connection: "disconnected" }))[0] as any).label,
      "连接中断",
    );
  });

  test("agent rows are checkboxes that flip the current state", () => {
    const menu = buildTrayMenu(
      status({
        agents: [
          agent(),
          agent({ id: "opencode", kind: "acp", name: "OpenCode", enabled: false, available: false }),
        ],
      }),
    );
    const agents = findSubmenu(menu, "本机 Agent");
    const codex = agents.find((node) => node.kind === "item" && node.label.startsWith("Codex"));
    assert.deepEqual(codex, {
      kind: "item",
      label: "Codex · 可用",
      checked: true,
      action: { type: "toggle-agent", agentId: "codex", enabled: false },
    });
    const opencode = agents.find((node) =>
      node.kind === "item" && node.label.startsWith("OpenCode"),
    ) as any;
    assert.equal(opencode.checked, false);
    assert.deepEqual(opencode.action, {
      type: "toggle-agent",
      agentId: "opencode",
      enabled: true,
    });
  });

  test("errored agents expose a detail action and manifest problems are nested", () => {
    const menu = buildTrayMenu(
      status({
        agents: [agent({ lastError: "找不到 claude 可执行文件" })],
        manifestProblems: [{ file: "broken.json", reason: "缺少 command" }],
      }),
    );
    const agents = findSubmenu(menu, "本机 Agent");
    const detail = agents.find((node) =>
      node.kind === "item" && node.label === "查看 Codex 错误…",
    );
    assert.deepEqual(detail, {
      kind: "item",
      label: "查看 Codex 错误…",
      action: { type: "show-agent-error", agentId: "codex" },
    });
    const problems = findSubmenu(agents, "ACP 清单问题（1）");
    assert.deepEqual(problems[0], {
      kind: "item",
      label: "broken.json · 缺少 command",
      enabled: false,
    });
    assert.deepEqual(problems.at(-1), {
      kind: "item",
      label: "复制诊断信息",
      action: { type: "copy-manifest-problems" },
    });
  });

  test("empty agent list stays explicit and quit is always present", () => {
    const menu = buildTrayMenu(status());
    const agents = findSubmenu(menu, "本机 Agent");
    assert.deepEqual(agents[0], { kind: "item", label: "未发现本机 Agent", enabled: false });
    assert.deepEqual(menu.at(-1), { kind: "item", label: "退出", action: { type: "quit" } });
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

  test("icon and tooltip follow connection and badge count", () => {
    assert.equal(trayIconName(status({ connection: "unpaired" })), "tray-unpaired.png");
    assert.equal(trayIconName(status({ connection: "disconnected" })), "tray-disconnected.png");
    assert.equal(trayIconName(status()), "tray-connected.png");
    assert.equal(trayIconName(status({ pendingCount: 3 })), "tray-connected-3.png");
    assert.equal(trayIconName(status({ pendingCount: 12 })), "tray-connected-9plus.png");
    assert.equal(trayTooltip(status({ pendingCount: 2 })), "AgentBus · 已连接 · 待处理 2");
    assert.equal(trayTooltip(status({ connection: "unpaired" })), "AgentBus · 未配对");
  });
});
