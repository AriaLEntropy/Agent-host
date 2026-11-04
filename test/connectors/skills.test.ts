import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  MAX_SKILL_BODY_BYTES,
  commandSkillIdFor,
  mergeSessionSkills,
  parseSkillDocument,
  readSkillBody,
  scanSkills,
  skillRootsFor,
  supportsSkillCatalog,
} from "../../src/connectors/skills.js";

let home: string;
let project: string;

async function skill(
  root: string,
  directory: string,
  name: string,
  description: string,
  body = `# ${name}\n`,
): Promise<void> {
  const dir = join(root, directory);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "agent-host-skills-"));
  home = join(base, "home");
  project = join(base, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(join(home, ".."), { recursive: true, force: true });
});

describe("parseSkillDocument", () => {
  test("reads quoted values and the body after frontmatter", () => {
    const parsed = parseSkillDocument(
      [
        "---",
        'name: "release-notes"',
        "description: 'Write release notes from commits'",
        "---",
        "# Steps",
        "",
        "Do the thing.",
      ].join("\n"),
    );
    assert.equal(parsed.name, "release-notes");
    assert.equal(parsed.description, "Write release notes from commits");
    assert.equal(parsed.body, "# Steps\n\nDo the thing.");
  });

  test("supports folded and literal block descriptions", () => {
    const folded = parseSkillDocument(
      "---\nname: folded\ndescription: >\n  first line\n  second line\n---\nbody",
    );
    assert.equal(folded.description, "first line second line");

    const literal = parseSkillDocument(
      "---\nname: literal\ndescription: |\n  first line\n  second line\n---\nbody",
    );
    assert.equal(literal.description, "first line\nsecond line");
  });

  test("falls back to the whole file when frontmatter is missing or broken", () => {
    assert.deepEqual(parseSkillDocument("# plain"), {
      name: "",
      description: "",
      body: "# plain",
    });
    assert.deepEqual(parseSkillDocument("---\nname: broken\n# no close"), {
      name: "",
      description: "",
      body: "---\nname: broken\n# no close",
    });
  });
});

describe("scanSkills", () => {
  test("project skills win over user skills with the same name", async () => {
    await skill(join(project, ".claude/skills"), "release", "release", "project release");
    await skill(join(home, ".claude/skills"), "release", "release", "user release");
    await skill(join(home, ".claude/skills"), "review", "review", "user review");

    const catalog = await scanSkills({
      kind: "claude",
      projectPath: project,
      home,
    });
    assert.deepEqual(catalog.skills.map((item) => item.name), ["release", "review"]);
    assert.equal(catalog.skills[0].description, "project release");
    assert.equal(catalog.skills[0].source, "project");
    assert.equal(catalog.skills[1].source, "user");
    assert.equal(catalog.skills[0].hasBody, true);
    assert.match(catalog.skills[0].id, /^sk_[A-Za-z0-9_-]{22}$/);
    assert.equal(catalog.truncated, false);
  });

  test("generic .agents/skills is available to every connector", async () => {
    await skill(join(project, ".agents/skills"), "shared", "shared", "shared skill");
    const catalog = await scanSkills({
      kind: "acp",
      connectorId: "gemini",
      projectPath: project,
      home,
    });
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].name, "shared");
    assert.equal(catalog.skills[0].source, "project");
  });

  test("maps known ACP agents to their own skill directories", async () => {
    await skill(join(home, ".qwen/skills"), "qwen-only", "qwen-only", "qwen skill");
    const roots = skillRootsFor({ kind: "acp", connectorId: "qwen-code", home });
    assert.ok(roots.some((root) => root.dir.endsWith(join(".qwen", "skills"))));

    const catalog = await scanSkills({ kind: "acp", connectorId: "qwen-code", home });
    assert.deepEqual(catalog.skills.map((item) => item.name), ["qwen-only"]);
  });

  test("skips hidden, symlinked and malformed skill directories", async (t) => {
    const root = join(home, ".agents/skills");
    await skill(root, "good", "good", "good skill");
    await skill(root, ".hidden", "hidden", "hidden skill");
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "broken", "SKILL.md"), "no frontmatter, no name");

    const outside = join(home, "..", "outside-skill");
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: outside\ndescription: outside skill\n---\nbody",
    );
    try {
      await symlink(outside, join(root, "linked"), "dir");
    } catch (error) {
      if ((error as { code?: string }).code === "EPERM") {
        t.skip("symlinks are not permitted on this Windows account");
        return;
      }
      throw error;
    }

    const catalog = await scanSkills({ kind: "acp", home });
    assert.deepEqual(catalog.skills.map((item) => item.name), ["good"]);
  });

  test("uses the directory name when frontmatter has no name", async () => {
    const root = join(home, ".agents/skills");
    await mkdir(join(root, "from-dir"), { recursive: true });
    await writeFile(join(root, "from-dir", "SKILL.md"), "---\ndescription: only description\n---\nbody");

    const catalog = await scanSkills({ kind: "acp", home });
    assert.deepEqual(catalog.skills.map((item) => item.name), ["from-dir"]);
  });

  test("caps the list and reports truncation", async () => {
    const root = join(home, ".agents/skills");
    for (let index = 0; index < 101; index += 1) {
      await skill(root, `skill-${String(index).padStart(3, "0")}`, `skill-${String(index).padStart(3, "0")}`, "x");
    }
    const catalog = await scanSkills({ kind: "acp", home });
    assert.equal(catalog.skills.length, 100);
    assert.equal(catalog.truncated, true);
  });
});

describe("merge and capability", () => {
  test("session commands win over file skills with the same name", () => {
    const session = [
      {
        id: commandSkillIdFor("qwen-code", "release"),
        name: "release",
        description: "session release",
        kind: "command" as const,
        source: "session" as const,
        hasBody: false,
      },
    ];
    const files = [
      {
        id: "sk_file",
        name: "release",
        description: "file release",
        kind: "skill" as const,
        source: "project" as const,
        hasBody: true,
      },
      {
        id: "sk_other",
        name: "other",
        description: "other",
        kind: "skill" as const,
        source: "project" as const,
        hasBody: true,
      },
    ];
    assert.deepEqual(mergeSessionSkills(session, files).map((skill) => skill.name), [
      "release",
      "other",
    ]);
    assert.equal(mergeSessionSkills(session, files)[0].source, "session");
  });

  test("only known agents or ACP report a skill catalog", () => {
    assert.equal(supportsSkillCatalog({ kind: "acp" }), true);
    assert.equal(supportsSkillCatalog({ kind: "claude" }), true);
    assert.equal(supportsSkillCatalog({ kind: "qwen" }), true);
    assert.equal(supportsSkillCatalog({ kind: "hermes" }), false);
  });

  test("command ids are stable and do not leak the connector name", () => {
    const first = commandSkillIdFor("qwen-code", "release");
    assert.equal(first, commandSkillIdFor("qwen-code", "release"));
    assert.notEqual(first, commandSkillIdFor("qwen-code", "review"));
    assert.match(first, /^ac_[A-Za-z0-9_-]{22}$/);
    assert.equal(first.includes("qwen"), false);
  });
});

describe("readSkillBody", () => {
  test("returns the body without frontmatter", async () => {
    const root = join(home, ".agents/skills");
    await skill(root, "body", "body", "body skill", "# Body\n\nContent.");
    const catalog = await scanSkills({ kind: "acp", home });
    const result = await readSkillBody(catalog.skills[0]);
    assert.equal(result.body, "# Body\n\nContent.");
    assert.equal(result.truncated, false);
  });

  test("truncates at a UTF-8 boundary", async () => {
    const root = join(home, ".agents/skills");
    const body = "中".repeat(MAX_SKILL_BODY_BYTES);
    await skill(root, "big", "big", "big skill", body);
    const catalog = await scanSkills({ kind: "acp", home });
    const result = await readSkillBody(catalog.skills[0]);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.body, "utf8") <= MAX_SKILL_BODY_BYTES);
    assert.equal(result.body.includes("\uFFFD"), false);
  });
});
