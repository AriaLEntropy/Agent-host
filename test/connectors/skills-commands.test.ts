import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { busStore, type BusEvent } from "../../src/bus/store.js";
import type { AgentSpec } from "../../src/connectors/discover.js";
import {
  executeCommand,
  resetRuntime,
  setSkillsHomeForTests,
  useAgents,
} from "../../src/connectors/runtime.js";

const agentId = "hV3nQ7pLxK2mR8sTfW4bZQ";

let base: string;
let home: string;
let project: string;
let events: BusEvent[];
let unsubscribe: (() => boolean) | undefined;

function specFor(kind: string, id = kind): AgentSpec {
  return {
    id,
    kind: kind as AgentSpec["kind"],
    name: kind,
    executable: `C:/fake/${kind}.exe`,
    args: [],
    env: {},
    origin: "dedicated",
    available: true,
    enabled: true,
    status: "ok",
  };
}

async function writeSkill(root: string, name: string, description: string, body: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agent-host-skill-commands-"));
  home = join(base, "home");
  project = join(base, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  resetRuntime();
  setSkillsHomeForTests(home);
  busStore.reset();
  busStore.identify({
    agentId,
    hostName: "Agent Host",
    hostVersion: "1.0.0",
    platform: "windows",
  });
  useAgents([specFor("claude")], true);
  busStore.rememberProject({
    agentId,
    path: project,
    name: "project",
    lastUsedAt: "2026-11-03T00:00:00.000Z",
    pinned: false,
  });
  events = [];
  unsubscribe = busStore.subscribe((event) => events.push(event));
});

afterEach(async () => {
  unsubscribe?.();
  resetRuntime();
  setSkillsHomeForTests(undefined);
  busStore.reset();
  await rm(base, { recursive: true, force: true });
});

describe("fetchSkills / readSkill", () => {
  test("returns project and user skills and advertises the capability", async () => {
    await writeSkill(join(project, ".claude/skills"), "release", "project release", "# Release\n\nShip it.");
    await writeSkill(join(home, ".claude/skills"), "review", "user review", "# Review\n\nRead it.");

    const result = await executeCommand({
      id: "cmd-skills",
      kind: "fetchSkills",
      fetchSkills: { connector: "claude", projectPath: project },
    });
    assert.equal(result.ok, true);

    const list = events.find((event) => event.kind === "skillList")?.skillList;
    assert.ok(list);
    assert.equal(list.commandId, "cmd-skills");
    assert.equal(list.connector, "claude");
    assert.equal(list.projectPath, project);
    assert.deepEqual(list.skills.map((skill) => [skill.name, skill.source, skill.hasBody]), [
      ["release", "project", true],
      ["review", "user", true],
    ]);
    assert.equal(list.truncated, false);
    assert.match(list.revision, /^[0-9a-f]{16}$/);

    const connector = (busStore.snapshot().agents as Array<Record<string, unknown>>)[0]
      ?.connectors as Array<Record<string, unknown>>;
    assert.equal(connector[0]?.canListSkills, true);
  });

  test("readSkill returns the markdown body without frontmatter", async () => {
    await writeSkill(join(project, ".claude/skills"), "release", "project release", "# Release\n\nShip it.");
    await executeCommand({
      id: "cmd-list",
      kind: "fetchSkills",
      fetchSkills: { connector: "claude", projectPath: project },
    });
    const skill = events.find((event) => event.kind === "skillList")?.skillList?.skills[0];
    assert.ok(skill);

    const result = await executeCommand({
      id: "cmd-read",
      kind: "readSkill",
      readSkill: { connector: "claude", projectPath: project, skillId: skill.id },
    });
    assert.equal(result.ok, true);
    const content = events.find((event) => event.kind === "skillContent")?.skillContent;
    assert.ok(content);
    assert.equal(content.skillId, skill.id);
    assert.equal(content.name, "release");
    assert.equal(content.contentType, "text/markdown");
    assert.equal(content.body, "# Release\n\nShip it.");
    assert.equal(content.truncated, false);
  });

  test("rejects unknown projects and stale skill ids", async () => {
    await writeSkill(join(project, ".claude/skills"), "release", "project release", "body");

    const unknownProject = await executeCommand({
      id: "cmd-unknown-project",
      kind: "fetchSkills",
      fetchSkills: { connector: "claude", projectPath: join(base, "other") },
    });
    assert.equal(unknownProject.ok, false);
    assert.equal(unknownProject.error, "project not found");

    const stale = await executeCommand({
      id: "cmd-stale",
      kind: "readSkill",
      readSkill: { connector: "claude", projectPath: project, skillId: "sk_missing" },
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "skill not found");
  });

  test("a connector without a skill catalog does not advertise canListSkills", async () => {
    useAgents([specFor("hermes")], true);
    const connector = (busStore.snapshot().agents as Array<Record<string, unknown>>)[0]
      ?.connectors as Array<Record<string, unknown>>;
    assert.equal(connector[0]?.canListSkills, undefined);
  });
});
