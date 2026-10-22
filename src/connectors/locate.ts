import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

const EXTENSIONS =
  process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
const SHIM_LIMIT = 64 * 1024;

function canRun(path: string) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable by name on PATH. Absolute paths are used as given. */
export function locateBinary(name: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  if (name.includes("/") || name.includes("\\")) return canRun(name) ? name : undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of EXTENSIONS) {
      const candidate = join(dir, name + ext);
      if (canRun(candidate)) return candidate;
    }
  }
  return undefined;
}

/** npm-distributed agents must resolve inside node_modules/<package>/. */
export function belongsToNpmPackage(located: string, npmPackage: string): boolean {
  const marker = `node_modules/${npmPackage}/`.replaceAll("\\", "/").toLowerCase();
  const mentions = (text: string) => text.replaceAll("\\", "/").toLowerCase().includes(marker);
  try {
    if (mentions(realpathSync(located))) return true;
  } catch {
    if (mentions(located)) return true;
  }
  const ext = located.slice(located.lastIndexOf(".")).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return false;
  try {
    if (statSync(located).size > SHIM_LIMIT) return false;
    return mentions(readFileSync(located, "utf8"));
  } catch {
    return false;
  }
}
