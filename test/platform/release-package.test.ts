import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ReleasePackageError,
  buildReleasePackage,
  releaseFileName,
  writeReleasePackage,
} from "../../src/platform/release-package.js";


const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "agent-host",
    version: "1.2.3",
    main: "dist/cli.js",
    bin: { "agent-host": "dist/cli.js" },
  },
  null,
  2,
)}\n`;

const FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "README.md": "# Agent-host fixture\n",
  "NOTICE": "fixture notice\n",
  "LICENSE": "MIT fixture\n",
  "dist/cli.js": "#!/usr/bin/env node\nconsole.log('fixture');\n",
  "dist/platform/log.js": "export const marker = 'platform-log';\n",
  "dist/nested/deep/mod.js": "export const deep = true;\n",
};

const DECOYS: Record<string, string> = {
  "dist/node_modules/dep/index.js": "module.exports = 1;\n",
  "dist/config.json": '{"hostToken":"HOST-SECRET"}\n',
  "dist/credentials.json": '{"token":"CREDENTIAL-SECRET"}\n',
  "dist/.env": "AGENT_HOST_RELAY=http://127.0.0.1:8787\n",
  "dist/state/host.key": "PRIVATE KEY MATERIAL\n",
  "dist/state/client.pem": "PEM MATERIAL\n",
  "dist/debug.log": "log line\n",
  "dist/scratch.tmp": "temp\n",
  "dist/.tmp/leftover.js": "leftover\n",
  "dist/release/agent-host-old.tar.gz": "old\n",
  "dist/old-package.tgz": "old\n",
  "dist/SHA256SUMS": "deadbeef  old.tar.gz\n",
  "dist/id_rsa": "PRIVATE KEY\n",
  "dist/store.jks": "KEYSTORE\n",
  "dist/.DS_Store": "x\n",
};

const EXPECTED_ENTRIES = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "dist/cli.js",
  "dist/nested/deep/mod.js",
  "dist/platform/log.js",
  "package.json",
];

let root: string;

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agent-host-release-")));
});

test.afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeFixtures(files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function fixtureRoot(): Promise<string> {
  await writeFixtures({ ...FILES, ...DECOYS });
  return root;
}

test("the archive carries exactly the release files in stable sorted order", async () => {
  const built = await buildReleasePackage({ root: await fixtureRoot() });
  const archive = gunzipSync(built.data);
  const entries = readTar(archive);

  assert.equal(built.version, "1.2.3");
  assert.deepEqual([...entries.keys()], EXPECTED_ENTRIES);
  assert.deepEqual(built.entries, EXPECTED_ENTRIES);
  assert.equal(entries.get("package.json")!.toString("utf8"), PACKAGE_JSON);
  assert.equal(entries.get("README.md")!.toString("utf8"), "# Agent-host fixture\n");
  assert.equal(entries.get("NOTICE")!.toString("utf8"), "fixture notice\n");
  assert.equal(entries.get("LICENSE")!.toString("utf8"), "MIT fixture\n");
  assert.match(entries.get("dist/cli.js")!.toString("utf8"), /console\.log\('fixture'\)/);
  assert.match(entries.get("dist/platform/log.js")!.toString("utf8"), /platform-log/);
  // tar writer pads to 512-byte blocks and ends with two zero blocks.
  assert.equal(archive.length % 512, 0);
  // 入口可执行，文档/普通模块只读；gzip OS 字节固定为 unknown，跨系统可复现。
  assert.equal(tarMode(archive, "dist/cli.js"), 0o755);
  assert.equal(tarMode(archive, "package.json"), 0o644);
  assert.equal(tarMode(archive, "README.md"), 0o644);
  assert.equal(built.data[9], 0xff);
});

test("the same inputs produce byte-identical archives regardless of file mtimes", async () => {
  const fixture = await fixtureRoot();
  const first = await buildReleasePackage({ root: fixture });

  const stamp = new Date("2031-07-08T09:10:11Z");
  await utimes(join(fixture, "dist/cli.js"), stamp, stamp);
  await utimes(join(fixture, "README.md"), new Date("2019-01-02T03:04:05Z"), stamp);
  await utimes(join(fixture, "package.json"), stamp, new Date("2018-05-06T07:08:09Z"));

  const second = await buildReleasePackage({ root: fixture });
  assert.deepEqual(second.data, first.data);
  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(second.entries, first.entries);

  // A different platform/arch only renames the archive, not its contents.
  const cross = await buildReleasePackage({ root: fixture, platform: "linux", arch: "arm64" });
  assert.deepEqual(cross.data, first.data);
  assert.equal(cross.fileName, "agent-host-1.2.3-linux-arm64.tar.gz");
  assert.equal(
    releaseFileName("1.2.3", "win32", "x64"),
    "agent-host-1.2.3-win32-x64.tar.gz",
  );
});

test("SHA256SUMS matches the written archive and its file name", async () => {
  const fixture = await fixtureRoot();
  const outDir = join(fixture, "out");
  const written = await writeReleasePackage({ root: fixture, outDir });

  const archive = await readFile(written.path);
  const expectedHash = createHash("sha256").update(archive).digest("hex");

  assert.equal(written.path, join(outDir, written.fileName));
  assert.match(
    written.fileName,
    new RegExp(`^agent-host-1\\.2\\.3-${process.platform}-${process.arch}\\.tar\\.gz$`),
  );
  assert.equal(written.sha256, expectedHash);
  assert.equal(written.checksumLine, `${expectedHash}  ${written.fileName}`);
  assert.match(written.checksumLine, /^[0-9a-f]{64} {2}\S+$/);
  assert.deepEqual(archive, written.data);

  const checksums = await readFile(written.checksumPath, "utf8");
  assert.equal(written.checksumPath, join(outDir, "SHA256SUMS"));
  assert.equal(checksums, `${written.checksumLine}\n`);
});

test("credentials, config, logs, node_modules, temp files and earlier output stay out", async () => {
  const fixture = await fixtureRoot();
  // First run writes release/ inside the repository; the second run must not pick it up.
  await writeReleasePackage({ root: fixture });
  const built = await buildReleasePackage({ root: fixture });

  for (const forbidden of [
    "dist/config.json",
    "dist/credentials.json",
    "dist/.env",
    "dist/state/host.key",
    "dist/state/client.pem",
    "dist/debug.log",
    "dist/scratch.tmp",
    "dist/.tmp/leftover.js",
    "dist/old-package.tgz",
    "dist/SHA256SUMS",
    "dist/id_rsa",
    "dist/store.jks",
    "dist/.DS_Store",
  ]) {
    assert.ok(!built.entries.includes(forbidden), `${forbidden} must not be archived`);
  }
  for (const name of built.entries) {
    assert.doesNotMatch(
      name,
      /node_modules|\/release\/|\.log$|\.key$|\.pem$|\.tmp$|\.jks$|id_rsa$/,
      name,
    );
  }
  assert.ok(
    !built.entries.some((name) => name.endsWith(built.fileName)),
    "the release output itself must not be archived",
  );

  const text = gunzipSync(built.data).toString("latin1");
  assert.doesNotMatch(text, /HOST-SECRET|CREDENTIAL-SECRET|PRIVATE KEY MATERIAL/);
});

test("a missing dist/cli.js fails with a clear build hint", async () => {
  await writeFixtures(FILES);
  await rm(join(root, "dist/cli.js"));
  await assert.rejects(
    () => buildReleasePackage({ root }),
    (error: unknown) => {
      assert.ok(error instanceof ReleasePackageError);
      assert.match(error.message, /dist[\\/]cli\.js is missing/);
      assert.match(error.message, /npm run build/);
      return true;
    },
  );
});

test("a missing dist directory fails with a clear build hint", async () => {
  await writeFixtures(FILES);
  await rm(join(root, "dist"), { recursive: true, force: true });
  await assert.rejects(
    () => buildReleasePackage({ root }),
    (error: unknown) => {
      assert.ok(error instanceof ReleasePackageError);
      assert.match(error.message, /dist directory is missing/);
      assert.match(error.message, /npm run build/);
      return true;
    },
  );
});

test("LICENSE is optional while README.md and NOTICE are required", async () => {
  const fixture = await fixtureRoot();
  await rm(join(fixture, "LICENSE"));
  const built = await buildReleasePackage({ root: fixture });
  assert.ok(!built.entries.includes("LICENSE"));
  assert.ok(built.entries.includes("README.md"));
  assert.ok(built.entries.includes("NOTICE"));

  await rm(join(fixture, "NOTICE"));
  await assert.rejects(
    () => buildReleasePackage({ root: fixture }),
    (error: unknown) => {
      assert.ok(error instanceof ReleasePackageError);
      assert.match(error.message, /missing required release file: NOTICE/);
      return true;
    },
  );
});

test("a symlinked entry point is rejected instead of silently omitted", async (t) => {
  await writeFixtures(FILES);
  const link = join(root, "dist", "cli.js");
  const target = join(root, "dist", "real-cli.js");
  await writeFile(target, FILES["dist/cli.js"]!);
  await rm(link);
  try {
    await symlink(target, link);
  } catch {
    t.skip("symlinks are not permitted on this platform");
    return;
  }
  await assert.rejects(
    () => buildReleasePackage({ root }),
    /dist\/cli\.js is missing or a symlink/,
  );
});

test("the entry point follows package.json bin instead of assuming dist/cli.js", async () => {
  const manifest = {
    name: "agent-host",
    version: "2.0.0",
    main: "dist/main.js",
    bin: { "agent-host": "dist/main.js" },
  };
  await writeFixtures({
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "README.md": "# Agent-host fixture\n",
    "NOTICE": "fixture notice\n",
    "dist/main.js": "#!/usr/bin/env node\nconsole.log('main');\n",
    "dist/cli.js": "console.log('not the entry');\n",
  });
  const built = await buildReleasePackage({ root });
  const archive = gunzipSync(built.data);
  assert.equal(built.fileName, releaseFileName("2.0.0"));
  assert.ok(built.entries.includes("dist/main.js"));
  assert.ok(built.entries.includes("dist/cli.js"));
  assert.equal(tarMode(archive, "dist/main.js"), 0o755);
  assert.equal(tarMode(archive, "dist/cli.js"), 0o644);
});

test("SHA256SUMS keeps other archives, drops stale rows, and leaves no temp file", async () => {
  const fixture = await fixtureRoot();
  const outDir = join(fixture, "out");
  const first = await writeReleasePackage({ root: fixture, outDir, platform: "linux", arch: "x64" });
  const second = await writeReleasePackage({ root: fixture, outDir, platform: "win32", arch: "x64" });
  const initial = await readFile(join(outDir, "SHA256SUMS"), "utf8");
  const lines = initial.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines.some((line) => line.endsWith(first.fileName)));
  assert.ok(lines.some((line) => line.endsWith(second.fileName)));

  await writeFile(
    join(outDir, "SHA256SUMS"),
    `${"a".repeat(64)}  gone.tar.gz\n${initial}`,
  );
  const third = await writeReleasePackage({ root: fixture, outDir, platform: "darwin", arch: "arm64" });
  const merged = await readFile(join(outDir, "SHA256SUMS"), "utf8");
  assert.doesNotMatch(merged, /gone\.tar\.gz/);
  assert.equal(merged.trim().split("\n").length, 3);
  assert.ok(merged.includes(third.checksumLine));
  assert.ok(!(await readdir(outDir)).some((name) => name.endsWith(".tmp")));
});

test("an entry name over the ustar limit fails with a clear error", async () => {
  const fixture = await fixtureRoot();
  const folder = "d".repeat(60);
  const file = "f".repeat(60);
  await mkdir(join(fixture, "dist", folder), { recursive: true });
  await writeFile(join(fixture, "dist", folder, `${file}.js`), "x\n");
  await assert.rejects(
    () => buildReleasePackage({ root: fixture }),
    /100-byte limit/,
  );
});

/** 读某个 tar 条目的权限位；找不到就失败。 */
function tarMode(archive: Buffer, target: string): number {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0",
      8,
    );
    if (name === target) {
      return Number.parseInt(
        header.subarray(100, 108).toString("ascii").replace(/\0.*$/, "").trim() || "0",
        8,
      );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.fail(`tar entry not found: ${target}`);
}

/** Walk a ustar archive, validating each header's checksum. */
function readTar(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const stored = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
    let actual = 0;
    for (let index = 0; index < 512; index += 1) {
      actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
    }
    assert.equal(actual, stored, "tar header checksum");

    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0",
      8,
    );
    const dataStart = offset + 512;
    entries.set(name, archive.subarray(dataStart, dataStart + size));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}
