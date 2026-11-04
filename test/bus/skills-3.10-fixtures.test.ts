import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Command as VendoredCommand, Event as VendoredEvent } from "../contract/protocol.js";
import { SkillCommand, SkillEvent } from "../contract/extensions/skills-3.10/schema.js";
import {
  commandAad,
  deriveFixtureKey,
  openSealedJson,
  sealJson,
} from "../contract/extensions/skills-3.10/seal.js";

// 3.10 是本仓库的私有扩展，样本不放进 protocol-fixtures/plain（同步上游时会被整份覆盖）。
const root = fileURLToPath(new URL("../contract/extensions/skills-3.10", import.meta.url));
const plainDir = join(root, "plain");
const invalidDir = join(plainDir, "invalid");
const sealedDir = join(root, "sealed");

async function jsonFiles(dir: string, prefix: string): Promise<string[]> {
  const names = (await readdir(dir)).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".json"),
  );
  return names.sort();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("every 3.10 command fixture matches the local extension schema", async () => {
  const files = await jsonFiles(plainDir, "command-");
  assert.ok(files.length >= 2, `expected at least 2 command fixtures, got ${files.length}`);
  for (const file of files) {
    const parsed = SkillCommand.safeParse(await readJson(join(plainDir, file)));
    assert.equal(parsed.success, true, `${file} should be accepted`);
  }
});

test("every 3.10 event fixture matches the local extension schema", async () => {
  const files = await jsonFiles(plainDir, "event-");
  assert.ok(files.length >= 2, `expected at least 2 event fixtures, got ${files.length}`);
  for (const file of files) {
    const parsed = SkillEvent.safeParse(await readJson(join(plainDir, file)));
    assert.equal(parsed.success, true, `${file} should be accepted`);
  }
});

test("every invalid 3.10 fixture is rejected", async () => {
  const files = (await readdir(invalidDir)).filter((name) => name.endsWith(".json")).sort();
  assert.ok(files.length >= 6, `expected at least 6 invalid fixtures, got ${files.length}`);
  for (const file of files) {
    const raw = await readJson(join(invalidDir, file));
    const schema = file.startsWith("command-") ? SkillCommand : SkillEvent;
    assert.equal(schema.safeParse(raw).success, false, `${file} should be rejected`);
  }
});

test("sealed 3.10 commands open to their plain fixture and reseal byte for byte", async () => {
  const key = await deriveFixtureKey();
  const files = await jsonFiles(sealedDir, "command-");
  assert.ok(files.length >= 2, `expected at least 2 sealed fixtures, got ${files.length}`);
  for (const file of files) {
    const sealed = (await readJson(join(sealedDir, file))) as {
      id: string;
      agentId: string;
      sealed: string;
    };
    const plain = await readJson(join(plainDir, file));
    const aad = commandAad(sealed.agentId, sealed.id);
    assert.deepEqual(await openSealedJson(key, sealed.sealed, aad), plain, `${file} opened wrong`);
    assert.equal(await sealJson(key, plain, aad), sealed.sealed, `${file} does not reseal identically`);
  }
});

test("3.10 fixtures are still outside the vendored 3.9 contract", async () => {
  // 上游一旦自己发布技能命令，这条会失败：说明该把本地扩展并回去或改号了。
  for (const file of await jsonFiles(plainDir, "command-")) {
    const raw = await readJson(join(plainDir, file));
    assert.equal(VendoredCommand.safeParse(raw).success, false, `${file} is already accepted by 3.9`);
  }
  for (const file of await jsonFiles(plainDir, "event-")) {
    const raw = await readJson(join(plainDir, file));
    assert.equal(VendoredEvent.safeParse(raw).success, false, `${file} is already accepted by 3.9`);
  }
});
