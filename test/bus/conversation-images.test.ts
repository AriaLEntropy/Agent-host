import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  imagesForMessage,
  sniffImageType,
} from "../../src/bus/conversation-images.js";
import { setArtifactKeyPath } from "../../src/bus/artifact-key.js";
import { getArtifact, setArtifactsDir } from "../../src/bus/artifacts.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a....");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-host-conversation-images-"));
  setArtifactsDir(join(dir, "artifacts"));
  setArtifactKeyPath(join(dir, "artifact-key"));
});

afterEach(async () => {
  setArtifactsDir(undefined);
  setArtifactKeyPath(undefined);
  await rm(dir, { recursive: true, force: true });
});

test("the same conversation, message and source keep the same artifact id", async () => {
  const first = await imagesForMessage("acp:my-agent:s1", "1-2", [
    { type: "data", data: PNG, contentType: "image/png" },
  ]);
  const second = await imagesForMessage("acp:my-agent:s1", "1-2", [
    { type: "data", data: PNG, contentType: "image/png" },
  ]);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.artifactId, second[0]!.artifactId);
  assert.match(first[0]!.artifactId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(first[0]!.contentType, "image/png");
  assert.equal(first[0]!.size, PNG.length);
  // id 不暴露内容；产物里仍是完整字节。
  assert.equal(first[0]!.artifactId.includes("image"), false);
  assert.deepEqual((await getArtifact(first[0]!.artifactId))?.bytes, PNG);

  const otherMessage = await imagesForMessage("acp:my-agent:s1", "1-3", [
    { type: "data", data: PNG, contentType: "image/png" },
  ]);
  assert.notEqual(otherMessage[0]!.artifactId, first[0]!.artifactId);

  const otherTask = await imagesForMessage("acp:my-agent:s2", "1-2", [
    { type: "data", data: PNG, contentType: "image/png" },
  ]);
  assert.notEqual(otherTask[0]!.artifactId, first[0]!.artifactId);
});

test("a file image is read through the safe reader and stored", async () => {
  const imagePath = join(dir, "saved.png");
  await writeFile(imagePath, PNG);
  const attachments = await imagesForMessage("codex:thread-1", "item-1", [
    { type: "file", path: imagePath },
  ]);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!.contentType, "image/png");
  assert.deepEqual((await getArtifact(attachments[0]!.artifactId))?.bytes, PNG);

  // 同一个路径、同一条消息：再拉一次还是同一个 id。
  const again = await imagesForMessage("codex:thread-1", "item-1", [
    { type: "file", path: imagePath },
  ]);
  assert.equal(again[0]!.artifactId, attachments[0]!.artifactId);
});

test("the local HMAC key is created once, outside the artifact cache, with private permissions", async () => {
  await imagesForMessage("acp:a:s1", "1-1", [{ type: "data", data: PNG, contentType: "image/png" }]);
  const keyPath = join(dir, "artifact-key");
  const info = await stat(keyPath);
  assert.equal(info.isFile(), true);
  assert.equal((await readFile(keyPath)).length, 32);
  if (process.platform !== "win32") {
    assert.equal(info.mode & 0o777, 0o600);
  }

  // 缓存目录被清空（7 天清理）不会影响 id；密钥不在里面。
  const before = await imagesForMessage("acp:a:s1", "1-1", [
    { type: "data", data: PNG, contentType: "image/png" },
  ]);
  await rm(join(dir, "artifacts"), { recursive: true, force: true });
  const after = await imagesForMessage("acp:a:s1", "1-1", [
    { type: "data", data: PNG, contentType: "image/png" },
  ]);
  assert.equal(before[0]!.artifactId, after[0]!.artifactId);
});

test("unsupported or unreadable images are skipped without failing the message", async () => {
  const unsupported = await imagesForMessage("acp:a:s1", "1-1", [
    { type: "data", data: Buffer.from("<svg/>"), contentType: "image/svg+xml" },
    { type: "data", data: Buffer.from("text"), contentType: "text/plain" },
  ]);
  assert.deepEqual(unsupported, []);

  const missing = await imagesForMessage("codex:t1", "item-1", [
    { type: "file", path: join(dir, "missing.png") },
  ]);
  assert.deepEqual(missing, []);

  const notImage = join(dir, "notes.png");
  await writeFile(notImage, "plain text");
  const fake = await imagesForMessage("codex:t1", "item-2", [
    { type: "file", path: notImage },
  ]);
  assert.deepEqual(fake, []);
});

test("at most four images are attached to one message", async () => {
  const images = Array.from({ length: 6 }, (_, index) => ({
    type: "data" as const,
    data: Buffer.concat([PNG, Buffer.from([index])]),
    contentType: "image/png",
  }));
  const attachments = await imagesForMessage("acp:a:s1", "1-1", images);
  assert.equal(attachments.length, 4);
});

test("the magic-byte sniff only accepts the four upload types", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(GIF), "image/gif");
  assert.equal(sniffImageType(WEBP), "image/webp");
  assert.equal(sniffImageType(Buffer.from("<svg/>")), undefined);
});
