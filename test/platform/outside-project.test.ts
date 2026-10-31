import test from "node:test";
import assert from "node:assert/strict";
import { createPlatformPath } from "../../src/platform/path.js";
import { OutsideProjectRule } from "../../src/platform/outside-project.js";

const win = createPlatformPath("win32");
const posix = createPlatformPath("posix");

function windowsRule(): OutsideProjectRule {
  return new OutsideProjectRule({
    homeDirectory: "C:\\Users\\alice",
    paths: win,
    agentWorkspaces: { openclaw: "C:\\Users\\alice\\.openclaw\\workspace" },
    projectsRoot: "C:\\Users\\alice\\Projects",
  });
}

function posixRule(): OutsideProjectRule {
  return new OutsideProjectRule({
    homeDirectory: "/home/alice",
    paths: posix,
    agentWorkspaces: { openclaw: "/home/alice/.openclaw/workspace" },
    projectsRoot: "/home/alice/Projects",
  });
}

test("an empty path is never a project", () => {
  assert.equal(windowsRule().contains(""), true);
  assert.equal(windowsRule().contains("   "), true);
  assert.equal(posixRule().contains(""), true);
});

test("the home directory and its common subdirectories are not projects", () => {
  const rule = windowsRule();
  assert.equal(rule.contains("C:\\Users\\alice"), true);
  assert.equal(rule.contains("c:\\users\\ALICE\\desktop"), true);
  assert.equal(rule.contains("C:\\Users\\alice\\Downloads"), true);
  assert.equal(rule.contains("C:\\Users\\alice\\Documents"), true);
  assert.equal(rule.contains("C:\\Users\\alice\\Desktop\\app"), false);
  assert.equal(rule.contains("C:\\Users\\alice\\code\\demo"), false);

  const unix = posixRule();
  assert.equal(unix.contains("/home/alice"), true);
  assert.equal(unix.contains("/home/alice/Desktop"), true);
  assert.equal(unix.contains("/home/alice/Documents/notes"), false);
});

test("projectsRoot itself is not a project but its children are", () => {
  assert.equal(windowsRule().contains("C:\\Users\\alice\\Projects"), true);
  assert.equal(windowsRule().contains("C:\\Users\\alice\\Projects\\demo"), false);
  assert.equal(posixRule().contains("/home/alice/Projects"), true);
  assert.equal(posixRule().contains("/home/alice/Projects/demo"), false);
});

test("agent default workspaces count as outside a project", () => {
  assert.equal(windowsRule().contains("C:\\Users\\alice\\.openclaw\\workspace"), true);
  assert.equal(windowsRule().contains("C:\\Users\\alice\\.openclaw\\workspace\\demo"), false);
  assert.equal(posixRule().contains("/home/alice/.openclaw/workspace"), true);
});

test("system directories are excluded", () => {
  const rule = windowsRule();
  for (const directory of rule.systemDirectories()) {
    assert.equal(rule.contains(directory), true, directory);
  }
  const unix = posixRule();
  for (const directory of unix.systemDirectories()) {
    assert.equal(unix.contains(directory), true, directory);
  }
  assert.equal(unix.contains("/tmp/work"), false);
});

test("a leading ~ expands against the rule's home, not the process environment", () => {
  assert.equal(windowsRule().contains("~"), true);
  assert.equal(windowsRule().contains("~\\Desktop"), true);
  assert.equal(windowsRule().contains("~\\code"), false);
  assert.equal(posixRule().contains("~"), true);
  assert.equal(posixRule().contains("~/Downloads"), true);
  assert.equal(posixRule().contains("~/code"), false);
});

test("a home directory that is not set leaves the home rules out", () => {
  const rule = new OutsideProjectRule({ homeDirectory: "", paths: posix });
  assert.equal(rule.contains("/home/alice"), false);
  assert.equal(rule.contains("/home/alice/Desktop"), false);
  assert.equal(rule.contains("/"), true);
});
