/**
 * Small, dependency-free JSON helpers for local metadata archives.
 *
 * The archives under `bus/` are read once at startup and written whenever a
 * mapping changes, so the helpers stay synchronous like `ProjectDismissals`.
 * Writes go through a same-directory temp file and `rename`, leaving the
 * previous file untouched when anything fails. Errors never carry paths: a
 * boolean is all callers get, and callers decide whether to log a generic
 * message (no conversation text, paths or tokens).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Parse a JSON file; missing, unreadable or malformed files yield `undefined`. */
export function readJsonFile(path: string | null | undefined): unknown {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Write JSON atomically with owner-only permissions.
 *
 * `mkdir -p` (0700) → temp file (0600) → `rename`. On failure the temp file is
 * removed and `false` is returned; the existing target keeps its old contents.
 * On Windows `chmod` is mostly a no-op, so it is best effort.
 */
export function writeJsonFileAtomic(path: string, value: unknown): boolean {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Windows: best effort only.
    }
    renameSync(temp, path);
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may not have been created at all.
    }
    return false;
  }
}
