import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  ConnectorSettings,
  loadConnectorSettings,
  normalizeProjectPath,
  saveConnectorSettings,
  type ConnectorSettingsState,
} from "../../src/connectors/settings-store.js";

const roots: string[] = [];

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `agent-host-${label}-`));
  roots.push(directory);
  return directory;
}

after(async () => {
  for (const directory of roots) await rm(directory, { recursive: true, force: true });
});

function emptyState(): ConnectorSettingsState {
  return { version: 1, autoApprove: [], connectors: [] };
}

describe("connector settings store", { concurrency: false }, () => {
  test("a missing, corrupt, or unknown-version file loads as empty without throwing", async () => {
    const directory = await tempDir("settings-empty");
    const missing = join(directory, "missing.json");
    assert.deepEqual(await loadConnectorSettings(missing), emptyState());

    const corrupt = join(directory, "corrupt.json");
    await writeFile(corrupt, "{ not json");
    assert.deepEqual(await loadConnectorSettings(corrupt), emptyState());

    const unknown = join(directory, "unknown.json");
    await writeFile(unknown, JSON.stringify({ version: 2, autoApprove: [], connectors: [] }));
    assert.deepEqual(await loadConnectorSettings(unknown), emptyState());

    const notObject = join(directory, "array.json");
    await writeFile(notObject, JSON.stringify([1, 2, 3]));
    assert.deepEqual(await loadConnectorSettings(notObject), emptyState());
  });

  test("a version 1 file with malformed entries keeps only valid ones", async () => {
    const directory = await tempDir("settings-sanitize");
    const path = join(directory, "connector-settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        autoApprove: [
          { agentId: "agent-1", projectPath: "C:\\Work\\Demo\\", enabled: true },
          { agentId: "", projectPath: "C:/skip", enabled: true },
          { agentId: "agent-1", projectPath: "C:/other", enabled: "yes" },
        ],
        connectors: [
          { kind: "openclaw", enabled: true },
          { kind: "acp", connectorId: "my-agent", enabled: false },
          { kind: "", enabled: true },
        ],
      }),
    );
    const state = await loadConnectorSettings(path);
    assert.deepEqual(state.autoApprove, [
      {
        agentId: "agent-1",
        projectPath: normalizeProjectPath("C:\\Work\\Demo\\"),
        enabled: true,
      },
    ]);
    assert.deepEqual(state.connectors, [
      { kind: "acp", connectorId: "my-agent", enabled: false },
      { kind: "openclaw", enabled: true },
    ]);
  });

  test("round-trips auto approve and connector switches", async () => {
    const directory = await tempDir("settings-roundtrip");
    const path = join(directory, "nested", "connector-settings.json");
    const state: ConnectorSettingsState = {
      version: 1,
      autoApprove: [
        { agentId: "agent-1", projectPath: normalizeProjectPath("C:/work/demo"), enabled: true },
      ],
      connectors: [
        { kind: "acp", connectorId: "my-agent", enabled: true },
        { kind: "codex", enabled: false },
      ],
    };
    assert.equal(await saveConnectorSettings(state, path), true);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("token"), false);
    assert.deepEqual(await loadConnectorSettings(path), state);
  });

  test("paths are normalized like the runtime: slashes unified, trailing separators removed, Windows lowercased", async () => {
    const directory = await tempDir("settings-path");
    const path = join(directory, "connector-settings.json");
    const settings = await ConnectorSettings.load({ path, debounceMs: 0 });
    settings.setAutoApprove("agent-1", "C:\\Work\\Demo\\", true);
    const canonical = normalizeProjectPath("C:\\Work\\Demo\\");
    assert.equal(canonical.includes("\\"), false);
    assert.equal(canonical.endsWith("/"), false);
    assert.equal(settings.autoApproveFor("agent-1", canonical), true);
    assert.equal(settings.autoApproveFor("agent-1", `${canonical}/`), true);
    // 同一项目换一种写法（反斜杠）也应命中。
    assert.equal(settings.autoApproveFor("agent-1", canonical.replace(/\//g, "\\")), true);
    if (process.platform === "win32") {
      assert.equal(settings.autoApproveFor("agent-1", "c:/work/demo"), true);
    }
    assert.equal(settings.autoApproveFor("agent-1", "C:/work/other"), false);
    await settings.flush();
    const reloaded = await ConnectorSettings.load({ path, debounceMs: 0 });
    assert.equal(reloaded.autoApproveFor("agent-1", canonical), true);
    assert.equal(reloaded.snapshot().autoApprove[0].projectPath, canonical);
  });

  test("enabled overrides distinguish connector id and fall back to undefined", async () => {
    const directory = await tempDir("settings-enabled");
    const path = join(directory, "connector-settings.json");
    const settings = await ConnectorSettings.load({ path, debounceMs: 0 });
    assert.equal(settings.enabledOverride("openclaw", undefined), undefined);
    assert.equal(settings.setEnabled("openclaw", undefined, true), true);
    assert.equal(settings.setEnabled("openclaw", undefined, true), false);
    assert.equal(settings.setEnabled("acp", "agent-a", false), true);
    assert.equal(settings.enabledOverride("openclaw", undefined), true);
    assert.equal(settings.enabledOverride("acp", "agent-a"), false);
    assert.equal(settings.enabledOverride("acp", "agent-b"), undefined);
    await settings.flush();
  });

  test("debounced writes coalesce and flush persists the latest state", async () => {
    const directory = await tempDir("settings-debounce");
    const path = join(directory, "connector-settings.json");
    const settings = await ConnectorSettings.load({ path, debounceMs: 40 });
    settings.setAutoApprove("agent-1", "C:/work/demo", true);
    // 同一拍内连改三次，只应落盘最后一次。
    settings.setEnabled("codex", undefined, false);
    settings.setEnabled("codex", undefined, true);
    settings.setEnabled("codex", undefined, false);
    assert.equal(existsSync(path), false, "debounce should not write immediately");
    await settings.flush();
    assert.equal(existsSync(path), true);
    const state = await loadConnectorSettings(path);
    assert.deepEqual(state.autoApprove, [
      { agentId: "agent-1", projectPath: normalizeProjectPath("C:/work/demo"), enabled: true },
    ]);
    assert.deepEqual(state.connectors, [{ kind: "codex", enabled: false }]);
  });

  test("a scheduled write fires after the debounce window", async () => {
    const directory = await tempDir("settings-timer");
    const path = join(directory, "connector-settings.json");
    const settings = await ConnectorSettings.load({ path, debounceMs: 20 });
    settings.setEnabled("pi", undefined, true);
    assert.equal(existsSync(path), false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const state = await loadConnectorSettings(path);
    assert.deepEqual(state.connectors, [{ kind: "pi", enabled: true }]);
  });

  test("a write failure returns false instead of throwing and leaves no temp file", async () => {
    const directory = await tempDir("settings-failure");
    const blocker = join(directory, "blocker");
    await writeFile(blocker, "not a directory");
    const path = join(blocker, "connector-settings.json");
    assert.equal(
      await saveConnectorSettings(
        {
          version: 1,
          autoApprove: [{ agentId: "a", projectPath: "C:/x", enabled: true }],
          connectors: [],
        },
        path,
      ),
      false,
    );
    assert.equal(existsSync(path), false);
  });

  test("ConnectorSettings.load reports a corrupt file once without leaking contents", async () => {
    const directory = await tempDir("settings-warning");
    const path = join(directory, "connector-settings.json");
    await writeFile(path, '{"secret":"do-not-print"');
    const warnings: string[] = [];
    const settings = await ConnectorSettings.load({
      path,
      logger: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not valid JSON/);
    assert.equal(warnings[0].includes("do-not-print"), false);
    assert.deepEqual(settings.snapshot(), emptyState());
  });

  test("setAutoApprove without a project path is ignored", async () => {
    const directory = await tempDir("settings-empty-path");
    const path = join(directory, "connector-settings.json");
    const settings = await ConnectorSettings.load({ path, debounceMs: 0 });
    assert.equal(settings.setAutoApprove("agent-1", "   ", true), false);
    assert.equal(settings.setAutoApprove("", "C:/work", true), false);
    await settings.flush();
  });

  test("a settings directory that cannot be created is tolerated", async () => {
    const directory = await tempDir("settings-mkdir");
    const path = join(directory, "absent", "connector-settings.json");
    await mkdir(directory, { recursive: true });
    // 正常路径应能建出目录并写入。
    assert.equal(
      await saveConnectorSettings(
        { version: 1, autoApprove: [], connectors: [{ kind: "dsh", enabled: false }] },
        path,
      ),
      true,
    );
    assert.deepEqual((await loadConnectorSettings(path)).connectors, [
      { kind: "dsh", enabled: false },
    ]);
  });
});
