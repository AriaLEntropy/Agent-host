import test from "node:test";
import assert from "node:assert/strict";
import { createPlatformPath, platformPath } from "../../src/platform/path.js";
import { normalizeProjectPath } from "../../src/bus/project-path.js";

const win = createPlatformPath("win32");
const posix = createPlatformPath("posix");

test("absolute paths follow the platform shape", () => {
  assert.equal(win.isAbsolute("C:\\work"), true);
  assert.equal(win.isAbsolute("c:/work"), true);
  assert.equal(win.isAbsolute("\\\\server\\share\\x"), true);
  assert.equal(win.isAbsolute("C:work"), false);
  assert.equal(win.isAbsolute("/work"), false);

  assert.equal(posix.isAbsolute("/work"), true);
  assert.equal(posix.isAbsolute("C:\\work"), false);
  assert.equal(posix.isAbsolute("work/x"), false);
});

test("normalized trims trailing separators but keeps the root", () => {
  assert.equal(win.normalized("C:/work/demo/"), "C:\\work\\demo");
  assert.equal(win.normalized("C:\\"), "C:\\");
  assert.equal(win.normalized("\\\\server\\share\\"), "\\\\server\\share");

  assert.equal(posix.normalized("/work/demo///"), "/work/demo");
  assert.equal(posix.normalized("/"), "/");
});

test("same ignores case and separator style on Windows only", () => {
  assert.equal(win.same("C:/Work/Demo", "c:\\work\\demo\\"), true);
  assert.equal(win.same("C:/work", "C:/work2"), false);
  assert.equal(posix.same("/work/Demo", "/work/demo"), false);
  assert.equal(posix.same("/work/", "/work"), false);
});

test("canonical stabilises the identity spelling on Windows", () => {
  assert.equal(win.canonical("c:/work/demo/"), "C:\\work\\demo");
  assert.equal(win.canonical("relative/dir"), "relative/dir");
  assert.equal(win.canonical(""), "");
  assert.equal(posix.canonical("/work/demo/"), "/work/demo/");
});

test("isInside compares path components, not string prefixes", () => {
  assert.equal(win.isInside("C:\\proj\\src\\a.ts", "C:\\proj"), true);
  assert.equal(win.isInside("c:\\PROJ\\src", "C:\\proj\\"), true);
  assert.equal(win.isInside("C:\\proj2\\a.ts", "C:\\proj"), false);
  assert.equal(win.isInside("C:\\proj", "C:\\proj"), false);
  assert.deepEqual(win.components("C:\\proj\\src\\a.ts"), ["C:", "proj", "src", "a.ts"]);

  assert.equal(posix.isInside("/proj/src/a.ts", "/proj"), true);
  assert.equal(posix.isInside("/proj2/a.ts", "/proj"), false);
  assert.equal(posix.isInside("/proj", "/proj"), false);
  assert.equal(posix.isInside("/a/b", "/"), true);
  assert.deepEqual(posix.components("/proj/src"), ["proj", "src"]);
});

test("relativePathOf and join keep the platform separator", () => {
  assert.equal(win.relativePathOf("C:\\proj\\src\\a.ts", "C:\\proj"), "src\\a.ts");
  assert.equal(posix.relativePathOf("/proj/src/a.ts", "/proj"), "src/a.ts");
  assert.equal(win.join("C:\\proj\\", "src/a.ts"), "C:\\proj\\src\\a.ts");
  assert.equal(posix.join("/proj/", "src/a.ts"), "/proj/src/a.ts");
});

test("isRoot recognises drive roots and UNC shares", () => {
  assert.equal(win.isRoot("C:\\"), true);
  assert.equal(win.isRoot("c:"), true);
  assert.equal(win.isRoot("\\\\server\\share"), true);
  assert.equal(win.isRoot("C:\\work"), false);
  assert.equal(posix.isRoot("/"), true);
  assert.equal(posix.isRoot("/work"), false);
});

test("PATH lookup is case-insensitive on Windows", () => {
  assert.equal(win.pathKey({ Path: "x" }), "Path");
  assert.equal(win.searchPath({ Path: "C:\\bin" }), "C:\\bin");
  const environment: Record<string, string | undefined> = { Path: "old", PATH: "older" };
  win.setSearchPath("new", environment);
  assert.deepEqual(environment, { Path: "new" });

  assert.equal(posix.pathKey({ PATH: "x" }), "PATH");
  assert.deepEqual(posix.splitSearchPath("/a::/b:"), ["/a", "/b"]);
  assert.equal(posix.joinSearchPath(["/a", "/b"]), "/a:/b");
});

test("executable names gain Windows suffixes only when missing", () => {
  assert.deepEqual(win.executableFileNames("codex"), ["codex.exe", "codex.cmd", "codex.bat", "codex"]);
  assert.deepEqual(win.executableFileNames("codex.exe"), ["codex.exe"]);
  assert.deepEqual(posix.executableFileNames("codex"), ["codex"]);
});

test("normalizeProjectPath keeps the protocol spelling stable", () => {
  if (process.platform === "win32") {
    assert.equal(normalizeProjectPath("C:\\Work\\Demo\\"), "c:/work/demo");
    assert.equal(normalizeProjectPath("c:/work/demo/"), "c:/work/demo");
    assert.equal(normalizeProjectPath("  C:\\  "), "c:/");
  } else {
    assert.equal(normalizeProjectPath("/Work/Demo/"), "/Work/Demo");
    assert.equal(normalizeProjectPath("/"), "/");
  }
  assert.equal(normalizeProjectPath("   "), "");
  assert.equal(normalizeProjectPath("relative/dir/"), "relative/dir");
  assert.equal(platformPath.platform, process.platform === "win32" ? "win32" : "posix");
});
