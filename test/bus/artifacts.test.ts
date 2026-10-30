import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ARTIFACT_TTL_MS,
  ArtifactError,
  MAX_UPLOAD_BYTES,
  cleanup,
  getArtifact,
  putArtifact,
  putUpload,
  resolveAttachment,
  setArtifactsDir,
} from "../../src/bus/artifacts.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

let dir: string;

function artifactId(seed: string): string {
  return createHash("sha256").update(seed).digest().subarray(0, 16).toString("base64url");
}

function day(ms: number): Date {
  return new Date(Date.now() + ms * 24 * 60 * 60 * 1000);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-host-artifacts-"));
  setArtifactsDir(dir);
});

afterEach(async () => {
  setArtifactsDir(undefined);
  await rm(dir, { recursive: true, force: true });
});

test("a valid upload round-trips bytes and metadata", async () => {
  const id = artifactId("valid");
  const stored = await putUpload(id, PNG, "image/png");
  assert.equal(stored.artifactId, id);
  assert.equal(stored.size, PNG.length);
  assert.equal(Number.isNaN(Date.parse(stored.createdAt)), false);

  const artifact = await getArtifact(id);
  assert.ok(artifact);
  assert.deepEqual(artifact.bytes, PNG);
  assert.equal(artifact.contentType, "image/png");
  assert.equal(artifact.size, PNG.length);
  assert.equal(artifact.createdAt, stored.createdAt);
});

test("content type parameters are normalized and jpeg/gif/webp are accepted", async () => {
  for (const [index, type] of ["image/jpeg", "image/gif", "image/webp"].entries()) {
    const id = artifactId(`type-${index}`);
    await putUpload(id, PNG, `${type}; charset=binary`);
    assert.equal((await getArtifact(id))?.contentType, type);
  }
});

test("non-image content types are rejected", async () => {
  const id = artifactId("type-reject");
  for (const type of ["text/plain", "image/svg+xml", "application/octet-stream", ""]) {
    await assert.rejects(
      putUpload(id, PNG, type),
      (error: unknown) =>
        error instanceof ArtifactError && error.code === "unsupported_type",
    );
  }
  assert.deepEqual(await readdir(dir), []);
});

test("putArtifact stores PDF / video files but still rejects non-media types", async () => {
  const pdf = Buffer.from("%PDF-1.7");
  const pdfId = artifactId("artifact-pdf");
  assert.equal((await putArtifact(pdfId, pdf, "application/pdf")).size, pdf.length);
  assert.deepEqual((await getArtifact(pdfId))?.bytes, pdf);
  assert.equal((await getArtifact(pdfId))?.contentType, "application/pdf");

  const videoId = artifactId("artifact-video");
  await putArtifact(videoId, Buffer.from("video"), "video/mp4");
  assert.equal((await getArtifact(videoId))?.contentType, "video/mp4");

  // 协议允许的范围是 image/* | video/* | application/pdf；这里只拒绝范围外的类型。
  // （`image/svg+xml` 在协议范围内，但对话识别只会认出 png/jpeg/gif/webp/heic。）
  for (const type of ["text/plain", "application/octet-stream", "audio/mpeg", ""]) {
    await assert.rejects(
      putArtifact(artifactId(`artifact-bad-${type}`), pdf, type),
      (error: unknown) =>
        error instanceof ArtifactError && error.code === "unsupported_type",
    );
  }
  // 手机附件仍只收上传时允许的图片类型：取回的 PDF 不会被当成附件送进连接器。
  assert.equal(await resolveAttachment({ artifactId: pdfId }), null);
});

test("the 2 MiB limit is inclusive and larger uploads are rejected", async () => {
  const ok = artifactId("size-ok");
  await putUpload(ok, Buffer.alloc(MAX_UPLOAD_BYTES), "image/png");
  assert.equal((await getArtifact(ok))?.size, MAX_UPLOAD_BYTES);

  const tooBig = artifactId("size-big");
  await assert.rejects(
    putUpload(tooBig, Buffer.alloc(MAX_UPLOAD_BYTES + 1), "image/png"),
    (error: unknown) => error instanceof ArtifactError && error.code === "too_large",
  );
  assert.equal(await getArtifact(tooBig), null);
});

test("only 22-character base64url ids are accepted", async () => {
  const bad = [
    "",
    "a".repeat(21),
    "a".repeat(23),
    "a".repeat(22) + "/",
    "a".repeat(21) + "=",
    "../escape-from-cache",
    "AAAAAAAAAAAAAAAAAAAAAA/",
  ];
  for (const id of bad) {
    await assert.rejects(
      putUpload(id, PNG, "image/png"),
      (error: unknown) => error instanceof ArtifactError && error.code === "invalid_id",
    );
  }
  assert.deepEqual(await readdir(dir), []);
});

test("expired artifacts are treated as missing and removed", async () => {
  const id = artifactId("expired");
  await putUpload(id, PNG, "image/png", new Date(Date.now() - ARTIFACT_TTL_MS - 1000));
  assert.equal(await getArtifact(id), null);
  assert.deepEqual(await readdir(dir), []);
});

test("cleanup removes only artifacts older than seven days and is idempotent", async () => {
  const oldId = artifactId("cleanup-old");
  const newId = artifactId("cleanup-new");
  await putUpload(oldId, PNG, "image/png", day(-8));
  await putUpload(newId, PNG, "image/png");

  assert.equal(await cleanup(), 1);
  assert.equal(await getArtifact(oldId), null);
  assert.ok(await getArtifact(newId));
  assert.equal(await cleanup(), 0);
  assert.ok(await getArtifact(newId));
});

test("resolveAttachment returns the cached path and stored content type", async () => {
  const id = artifactId("attachment");
  await putUpload(id, PNG, "image/webp");
  const resolved = await resolveAttachment({ artifactId: id });
  assert.ok(resolved);
  assert.equal(resolved.contentType, "image/webp");
  assert.equal(resolved.path, join(dir, `${id}.bin`));
  assert.deepEqual(await readFile(resolved.path), PNG);
});

test("resolveAttachment returns null for missing, invalid, expired, or empty refs", async () => {
  assert.equal(await resolveAttachment(null), null);
  assert.equal(await resolveAttachment({}), null);
  assert.equal(await resolveAttachment({ artifactId: "../../etc/passwd" }), null);
  assert.equal(await resolveAttachment({ artifactId: artifactId("missing") }), null);

  const expired = artifactId("attachment-expired");
  await putUpload(expired, PNG, "image/png", day(-8));
  assert.equal(await resolveAttachment({ artifactId: expired }), null);
});

test("path traversal ids never touch the filesystem", async () => {
  const outside = join(dir, "..", `agent-host-outside-${process.pid}.txt`);
  await writeFile(outside, "secret");
  try {
    assert.equal(await getArtifact("../agent-host-outside.txt"), null);
    assert.equal(await getArtifact(`../${"a".repeat(20)}`), null);
    assert.equal(await resolveAttachment({ artifactId: "../secret" }), null);
    await assert.rejects(
      putUpload("../agent-host-outside.txt", PNG, "image/png"),
      (error: unknown) => error instanceof ArtifactError && error.code === "invalid_id",
    );
  } finally {
    await rm(outside, { force: true });
  }
});

test("symlinked data files are not served", async (t) => {
  const id = artifactId("symlink");
  await putUpload(id, PNG, "image/png");
  const path = join(dir, `${id}.bin`);
  const outside = join(tmpdir(), `agent-host-artifact-target-${process.pid}.bin`);
  await writeFile(outside, Buffer.from("outside"));
  await rm(path);
  try {
    await symlink(outside, path);
  } catch {
    await rm(outside, { force: true });
    t.skip("creating symlinks is not permitted on this machine");
    return;
  }
  try {
    assert.equal(await getArtifact(id), null);
    assert.equal(await resolveAttachment({ artifactId: id }), null);
  } finally {
    await rm(outside, { force: true });
  }
});

test("metadata files are ordinary files, not followed symlinks", async () => {
  const id = artifactId("meta-symlink");
  await putUpload(id, PNG, "image/png");
  const info = await lstat(join(dir, `${id}.json`));
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
});
