import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DirectoryProbe,
  inspectSystemPermission,
  standardizePath,
  type DirectoryAccess,
  type DirectoryProbeOptions,
  type SystemPermissionNotice,
} from "../../src/platform/directory-probe.js";

const HOME = "/Users/me";

function macProbe(
  access: (path: string) => DirectoryAccess | null | Promise<DirectoryAccess | null>,
  options: Partial<DirectoryProbeOptions> = {},
): DirectoryProbe {
  return new DirectoryProbe({ platform: "darwin", home: HOME, access, ...options });
}

test("non-macOS platforms degrade explicitly instead of guessing", async () => {
  for (const platform of ["linux", "win32"] as const) {
    let calls = 0;
    const probe = new DirectoryProbe({
      platform,
      access: () => {
        calls += 1;
        return "missing";
      },
    });
    assert.equal(probe.supported, false);
    const result = await probe.inspect("/work/demo");
    assert.equal(result.supported, false);
    assert.equal(result.status, "unsupported");
    assert.equal(result.diagnosis, undefined);
    assert.equal(result.reason, "目录授权诊断只在 macOS 上可用");
    assert.equal(await probe.diagnose("/work/demo"), null);
    assert.equal(calls, 0, "不支持时连目录都不碰");
  }
});

test("a readable directory yields no diagnosis", async () => {
  const probe = macProbe(() => "readable");
  const result = await probe.inspect("/work/demo");
  assert.deepEqual(result, { supported: true, status: "readable" });
  assert.equal(await probe.diagnose("/work/demo"), null);
});

test("a missing directory maps to projectMissing", async () => {
  const probe = macProbe(() => "missing");
  assert.deepEqual(await probe.diagnose("/work/gone"), { kind: "projectMissing" });
  const result = await probe.inspect("/work/gone");
  assert.equal(result.status, "missing");
  assert.deepEqual(result.diagnosis, { kind: "projectMissing" });
});

test("privacy-denied directories carry the protected folder", async () => {
  const probe = macProbe(() => "denied");
  assert.deepEqual(await probe.diagnose(`${HOME}/Desktop/demo`), {
    kind: "folderAccessDenied",
    folder: "desktop",
  });
  const result = await probe.inspect(`${HOME}/Documents/taxes`);
  assert.equal(result.status, "denied");
  assert.equal(result.folder, "documents");
  assert.deepEqual(result.diagnosis, { kind: "folderAccessDenied", folder: "documents" });
});

test("plain permission errors do not claim a protected folder", async () => {
  const probe = macProbe(() => "unreadable");
  const result = await probe.inspect("/srv/data");
  assert.equal(result.status, "unreadable");
  assert.equal(result.folder, undefined);
  assert.deepEqual(result.diagnosis, { kind: "folderAccessDenied" });
});

test("an injected folderFor wins over the home-based guess", async () => {
  const probe = macProbe(() => "denied", { folderFor: () => "networkVolume" });
  assert.deepEqual(await probe.diagnose("/mnt/share"), {
    kind: "folderAccessDenied",
    folder: "networkVolume",
  });
});

test("a throwing access probe is inconclusive, never an exception", async () => {
  const probe = macProbe(() => {
    throw new Error("boom");
  });
  const result = await probe.inspect("/work/demo");
  assert.equal(result.status, "indeterminate");
  assert.equal(result.diagnosis, undefined);
  assert.equal(await probe.diagnose("/work/demo"), null);
});

test("a slow read times out without a conclusion", async () => {
  const probe = macProbe(() => new Promise<DirectoryAccess | null>(() => {}), { timeoutMs: 25 });
  const started = Date.now();
  const result = await probe.inspect("/work/slow");
  const elapsed = Date.now() - started;
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason ?? "", /超过 25 毫秒/);
  assert.ok(elapsed >= 20 && elapsed < 1000, `timed out in ${elapsed}ms`);
});

test("a directory still being read is not read a second time", async () => {
  let calls = 0;
  let release: (value: DirectoryAccess) => void = () => {};
  const probe = macProbe(
    () => {
      calls += 1;
      if (calls > 1) return "missing";
      return new Promise<DirectoryAccess>((resolve) => {
        release = resolve;
      });
    },
    { timeoutMs: 10 },
  );
  const first = probe.inspect("/work/stuck");
  const second = await probe.inspect("/work/stuck");
  assert.equal(second.status, "indeterminate");
  assert.match(second.reason ?? "", /已经在读/);
  assert.equal(calls, 1);
  assert.equal((await first).status, "indeterminate");
  release("missing");
  // 上一次真的返回之后（登记解除），同一个目录可以再读。
  await new Promise((resolve) => setImmediate(resolve));
  const third = await probe.inspect("/work/stuck");
  assert.equal(third.status, "missing");
  assert.equal(calls, 2);
});

test("an aborted signal yields no conclusion", async () => {
  let calls = 0;
  const probe = macProbe(() => {
    calls += 1;
    return "missing";
  });
  const controller = new AbortController();
  controller.abort();
  const result = await probe.inspect("/work/demo", { signal: controller.signal });
  assert.equal(result.status, "indeterminate");
  assert.equal(calls, 0);
  const empty = await probe.inspect("", { signal: controller.signal });
  assert.equal(empty.status, "indeterminate");
  assert.equal(await probe.diagnose(""), null);
});

test("aborting an in-flight read is reported as cancelled, not timed out", async () => {
  const probe = macProbe(
    () => new Promise<DirectoryAccess>(() => undefined),
    { timeoutMs: 5000 },
  );
  const controller = new AbortController();
  const pending = probe.inspect("/work/demo", { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason ?? "", /取消/);
});

test("fs error codes map like the upstream Cocoa / POSIX pairing", () => {
  assert.equal(DirectoryProbe.accessFromError(Object.assign(new Error("x"), { code: "EPERM" })), "denied");
  assert.equal(DirectoryProbe.accessFromError(Object.assign(new Error("x"), { code: "EACCES" })), "unreadable");
  assert.equal(DirectoryProbe.accessFromError(Object.assign(new Error("x"), { code: "ENOENT" })), "missing");
  assert.equal(DirectoryProbe.accessFromError(Object.assign(new Error("x"), { code: "ENOTDIR" })), "missing");
  assert.equal(DirectoryProbe.accessFromError(Object.assign(new Error("x"), { code: "EMFILE" })), null);
  assert.equal(DirectoryProbe.accessFromError(new Error("plain")), null);
  assert.equal(DirectoryProbe.accessFromError(null), null);
  // `cause` 与 AggregateError 里的码也认。
  assert.equal(
    DirectoryProbe.accessFromError(
      Object.assign(new Error("wrapper"), { cause: Object.assign(new Error("inner"), { code: "EPERM" }) }),
    ),
    "denied",
  );
  assert.equal(
    DirectoryProbe.accessFromError(
      new AggregateError([Object.assign(new Error("a"), { code: "ENOENT" }), Object.assign(new Error("b"), { code: "EPERM" })]),
    ),
    "denied",
    "EPERM 优先于 ENOENT",
  );
});

test("protected folders follow the macOS 文件与文件夹 switches", () => {
  const folder = (path: string, isNetworkVolume?: (volume: string) => boolean) =>
    DirectoryProbe.folderFor(path, HOME, { isNetworkVolume });

  assert.equal(folder(`${HOME}/Desktop`), "desktop");
  assert.equal(folder(`${HOME}/Desktop/demo/src`), "desktop");
  assert.equal(folder(`${HOME}/Documents/a/b`), "documents");
  assert.equal(folder(`${HOME}/Downloads/x.zip`), "downloads");
  assert.equal(folder(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs`), "iCloudDrive");
  assert.equal(folder("/Volumes/USB/stick"), "removableVolume");
  assert.equal(folder("/Volumes/nfs-share/x", (volume) => volume === "/Volumes/nfs-share"), "networkVolume");
  assert.equal(folder("/Volumes/nfs-share/x", () => false), "removableVolume");
  assert.equal(folder("/opt/work"), "other");
  assert.equal(folder(`${HOME}/Desktop2/notes`), "other", "按路径组件比，不是字符串前缀");
  assert.equal(folder(`${HOME}/Desktop/../Documents/x`), "documents", "先标准化再分类");
  assert.equal(folder("~/Desktop/x"), "desktop", "开头的 ~ 按传入的主目录展开");
});

test("standardizePath is lexical and does not touch the disk", () => {
  assert.equal(standardizePath("/a//b/./c/../d/"), "/a/b/d");
  assert.equal(standardizePath("/", HOME), "/");
  assert.equal(standardizePath("~/x", HOME), "/Users/me/x");
  assert.equal(standardizePath("../x", HOME), "../x");
});

test("live probes read a temp directory only", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-host-directory-probe-"));
  const project = join(root, "project");
  mkdirSync(project);

  const probe = DirectoryProbe.live({ home: root, platform: "darwin", timeoutMs: 1000 });
  assert.deepEqual(await probe.inspect(project), { supported: true, status: "readable" });
  assert.deepEqual(await probe.diagnose(join(root, "not-there")), { kind: "projectMissing" });

  const windows = DirectoryProbe.live({ home: root, platform: "win32" });
  const degraded = await windows.inspect(project);
  assert.equal(degraded.supported, false);
  assert.equal(degraded.status, "unsupported");
});

test("a system permission inspection returns what the app already saw", async () => {
  const notice: SystemPermissionNotice = {
    id: "notice-1",
    detectedAt: "2026-10-01T00:00:00Z",
    dialogText: "“Claude”想访问您的“桌面”文件夹。",
  };
  let calls = 0;
  const result = await inspectSystemPermission(async () => {
    calls += 1;
    return notice;
  }, 1000);
  assert.deepEqual(result, notice);
  assert.equal(calls, 1);

  assert.equal(await inspectSystemPermission(() => null, 1000), null);
  assert.equal(await inspectSystemPermission(() => undefined, 1000), null);
});

test("a slow or throwing permission inspection never blocks the receipt", async () => {
  const started = Date.now();
  const timedOut = await inspectSystemPermission(() => new Promise<never>(() => {}), 20);
  const elapsed = Date.now() - started;
  assert.equal(timedOut, null);
  assert.ok(elapsed >= 15 && elapsed < 1000, `timed out in ${elapsed}ms`);

  assert.equal(
    await inspectSystemPermission(() => {
      throw new Error("no UI");
    }, 1000),
    null,
  );
  assert.equal(
    await inspectSystemPermission(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    }, 1000),
    null,
  );
});

test("an aborted permission inspection does not call the inspector", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await inspectSystemPermission(
    () => {
      calls += 1;
      return null;
    },
    1000,
    { signal: controller.signal },
  );
  assert.equal(result, null);
  assert.equal(calls, 0);
});
