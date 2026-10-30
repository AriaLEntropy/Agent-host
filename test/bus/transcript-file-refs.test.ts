// Tests for the disk-checking half of the TranscriptFileRefs port
// (`resolve` / `validate`, upstream Apache-2.0). Everything runs in a temporary
// directory; no real user files are touched.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  MAX_FILES_PER_MESSAGE,
  isAcceptableProjectRoot,
  projectRoot,
  resolve,
  validate,
} from "../../src/connectors/ported/transcript-file-refs.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);

let root: string;
let project: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agent-host-refs-")));
  project = join(root, "project");
  await mkdir(project);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function file(relative: string, bytes: Buffer = PNG): Promise<string> {
  const path = join(project, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return realpath(path);
}

describe("transcript file refs: resolve", { concurrency: false }, () => {
  test("resolves existing media files under the project with metadata", async () => {
    const png = await file("out/demo.png");
    const pdf = await file("docs/spec.pdf", Buffer.from("%PDF-1.4"));
    const refs = await resolve(["out/demo.png", pdf], project);
    assert.deepEqual(refs, [
      { path: png, name: "demo.png", contentType: "image/png", size: PNG.length },
      { path: pdf, name: "spec.pdf", contentType: "application/pdf", size: 8 },
    ]);
  });

  test("caps a message at four files and dedupes by real path", async () => {
    const paths = await Promise.all(
      Array.from({ length: 6 }, (_, index) => file(`out/f${index}.png`)),
    );
    const refs = await resolve([paths[0]!, paths[0]!, ...paths.slice(1)], project);
    assert.equal(MAX_FILES_PER_MESSAGE, 4);
    assert.equal(refs.length, 4);
    assert.deepEqual(
      refs.map((ref) => ref.path),
      paths.slice(0, 4),
    );
  });

  test("skips missing, unsupported, dot-directory and escaping paths", async () => {
    await file("notes.txt");
    await file(".hidden/secret.png");
    const outside = join(root, "outside.png");
    await writeFile(outside, PNG);
    const refs = await resolve(
      [
        join(project, "missing.png"),
        join(project, "notes.txt"),
        join(project, ".hidden", "secret.png"),
        join("..", "outside.png"),
        outside,
      ],
      project,
    );
    assert.deepEqual(refs, []);
  });

  test("rejects a directory even when it has a media extension", async () => {
    await mkdir(join(project, "folder.png"));
    assert.deepEqual(await resolve(["folder.png"], project), []);
  });

  test("follows symlinks inside the project but rejects ones escaping it", async (t) => {
    const inside = await file("real/a.png");
    const outsideDir = join(root, "outside");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "escape.png"), PNG);
    const link = join(project, "link");
    try {
      await symlink(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("creating symlinks is not permitted on this machine");
      return;
    }
    const escaped = await resolve([join("link", "escape.png")], project);
    assert.deepEqual(escaped, []);
    // 项目内的真实文件仍然可用。
    assert.deepEqual((await resolve([inside], project)).map((ref) => ref.path), [inside]);
  });

  test("returns nothing when the project directory is broad or missing", async () => {
    const png = await file("out/demo.png");
    assert.deepEqual(await resolve([png], homedir()), []);
    assert.deepEqual(await resolve([png], join(root, "no-such-project")), []);
    assert.deepEqual(await resolve([png], "relative/project"), []);
    assert.equal(await projectRoot(homedir()), null);
  });
});

describe("transcript file refs: validate", { concurrency: false }, () => {
  test("returns the real path for a valid media file", async () => {
    const png = await file("a/b.png");
    const result = await validate(png, project);
    assert.ok(result);
    assert.equal(result.path, png);
    assert.equal(result.name, "b.png");
    assert.equal(result.contentType, "image/png");
    assert.equal(result.size, PNG.length);
  });

  test("accepts relative paths but rejects every escaping / invalid form", async () => {
    const png = await file("out/a.mp4", Buffer.from("video"));
    assert.equal((await validate("out/a.mp4", project))?.path, png);

    await file("notes.txt");
    await file(".git/config.pdf");
    const outside = join(root, "outside.pdf");
    await writeFile(outside, Buffer.from("%PDF"));

    for (const candidate of [
      "",
      "out/a.exe",
      "notes.txt",
      ".git/config.pdf",
      join("..", "outside.pdf"),
      outside,
      "out/a.mp4\0.png",
      `~${process.platform === "win32" ? "other" : "other"}/x.png`,
    ]) {
      assert.equal(await validate(candidate, project), null, `accepted ${JSON.stringify(candidate)}`);
    }
  });

  test("refuses an oversized-looking path and a project root that is a drive root", async () => {
    assert.equal(await validate("x".repeat(1025), project), null);
    const driveRoot = process.platform === "win32" ? "C:\\" : "/";
    assert.equal(await projectRoot(driveRoot), null);
    assert.equal(isAcceptableProjectRoot(process.platform === "win32" ? "C:\\" : "/", homedir()), false);
  });
});
