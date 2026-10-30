// Ported from botbus-protocol/Sources/BotBusConnectorKit/TranscriptFileRefs.swift
// (`candidates(in:)`; Apache-2.0). Tests for the read-only TypeScript port.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { candidatesIn } from "../../src/connectors/ported/transcript-file-refs.js";

describe("transcript file refs", { concurrency: false }, () => {
  test("recognises bare, backticked and Markdown-link targets in order", () => {
    const text = [
      "image: out/a.png.",
      "code: `src/shot.webp`",
      "link: [shot](<my shots/b final.jpg>)",
      'titled: [doc](docs/spec.pdf "title")',
      "![pic](/tmp/pic.gif)",
    ].join("\n");
    assert.deepEqual(candidatesIn(text), [
      "out/a.png",
      "src/shot.webp",
      "my shots/b final.jpg",
      "docs/spec.pdf",
      "/tmp/pic.gif",
    ]);
  });

  test("only accepts image, video and PDF extensions", () => {
    assert.deepEqual(
      candidatesIn("notes.txt archive.env clip.webm photo.PNG video.mp4 doc.pdf"),
      ["photo.PNG", "video.mp4", "doc.pdf"],
    );
    assert.deepEqual(candidatesIn(".env .git/config README"), []);
    assert.deepEqual(candidatesIn(".png a."), []);
  });

  test("rejects URLs and anything with a scheme", () => {
    assert.deepEqual(
      candidatesIn("https://x/y.png file:///tmp/z.jpg http://example.com/a.gif"),
      [],
    );
    assert.deepEqual(candidatesIn("[remote](https://x/y.png) ![x](file:///tmp/a.jpg)"), []);
  });

  test("treats a scheme-looking prefix as a URL", () => {
    assert.deepEqual(candidatesIn("attachment:out/a.png"), []);
  });

  test("deduplicates by exact value, keeping first appearance", () => {
    assert.deepEqual(
      candidatesIn("out/a.png out/a.png `out/a.png` [x](out/a.png) out/b.png"),
      ["out/a.png", "out/b.png"],
    );
  });

  test("caps each message at 32 candidates", () => {
    const text = Array.from({ length: 40 }, (_, index) => `out/f${index}.png`).join(" ");
    const result = candidatesIn(text);
    assert.equal(result.length, 32);
    assert.equal(result[0], "out/f0.png");
    assert.equal(result[31], "out/f31.png");
  });

  test("re-scans a backticked path containing spaces (upstream leaves it unclaimed)", () => {
    // 带空格的整段不占区间，里面的路径按裸路径再认一遍；多出来的 `b.png` 会在
    // resolve 时因文件不存在被丢掉（与上游一致）。
    assert.deepEqual(candidatesIn("`my shots/a b.png`"), ["my shots/a b.png", "b.png"]);
  });

  test("re-scans a backtick command for embedded bare paths", () => {
    // 带空格的整段可能是命令，不占区间；里面的路径按裸路径再认一遍（与上游一致）。
    assert.deepEqual(candidatesIn("`open out/a.png`"), ["open out/a.png", "out/a.png"]);
  });

  test("rejects over-long candidates", () => {
    const longName = `${"a".repeat(1030)}.png`;
    assert.deepEqual(candidatesIn(longName), []);
  });

  test("empty text yields no candidates", () => {
    assert.deepEqual(candidatesIn(""), []);
  });
});
