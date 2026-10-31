import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileReadabilityError,
  readFileByHandle,
  readRegularFile,
} from "../../src/platform/file-readability.js";

let root: string;

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agent-host-read-")));
});

test.afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("reads a regular file through an open descriptor", async () => {
  const path = join(root, "a.txt");
  await writeFile(path, "hello");
  assert.equal((await readFileByHandle(path)).toString("utf8"), "hello");
  assert.equal((await readFileByHandle(path, { maxBytes: 5 })).toString("utf8"), "hello");
});

test("rejects a file above the limit before reading it", async () => {
  const path = join(root, "big.bin");
  await writeFile(path, Buffer.alloc(32, 1));
  await assert.rejects(readFileByHandle(path, { maxBytes: 16 }), (error: unknown) => {
    assert.ok(error instanceof FileReadabilityError);
    assert.equal(error.code, "too_large");
    return true;
  });
});

test("rejects a missing file and a directory", async () => {
  await assert.rejects(readFileByHandle(join(root, "nope.txt")), (error: unknown) => {
    assert.equal((error as FileReadabilityError).code, "missing");
    return true;
  });
  const directory = join(root, "dir");
  await mkdir(directory);
  await assert.rejects(readFileByHandle(directory), (error: unknown) => {
    assert.equal((error as FileReadabilityError).code, "not_file");
    return true;
  });
});

test("never follows a symbolic link", async (context) => {
  const target = join(root, "target.txt");
  const link = join(root, "link.txt");
  await writeFile(target, "secret");
  try {
    await symlink(target, link, "file");
  } catch {
    context.skip("creating symlinks requires extra privileges on this host");
    return;
  }
  await assert.rejects(readFileByHandle(link), (error: unknown) => {
    assert.equal((error as FileReadabilityError).code, "symlink");
    return true;
  });
  assert.equal(await readRegularFile(link), null);
});

test("readRegularFile turns every failure into null", async () => {
  assert.equal(await readRegularFile(join(root, "nope.txt")), null);
  const path = join(root, "a.txt");
  await writeFile(path, "abc");
  assert.equal((await readRegularFile(path, 2)), null);
  assert.equal((await readRegularFile(path))?.toString("utf8"), "abc");
});
