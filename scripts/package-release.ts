/**
 * `npm run package:release [-- --out <dir>]`
 *
 * 从已构建的 `dist/` 打一个可复现的发布包，附同目录 `SHA256SUMS`。
 * 默认输出到 `release/`（可用 `--out` 指定，CI 里通常指到临时目录）。
 *
 * 这里刻意不调用 `npx tsc`：打包前请自己跑 `npm run build`。
 * 若 `dist/cli.js` 不存在，脚本给出明确报错并退出 1。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RELEASE_DIRECTORY,
  writeReleasePackage,
} from "../src/platform/release-package.js";

const USAGE = `Usage: npm run package:release -- [--out <dir>]

Builds a deterministic release archive from the built dist/ plus
package.json, README.md, NOTICE and LICENSE (when present).

The script never runs a nested build: run \`npm run build\` first.
It fails clearly when dist/cli.js is missing.

Default output directory: <repo>/${DEFAULT_RELEASE_DIRECTORY}/
  agent-host-<version>-<platform>-<arch>.tar.gz
  SHA256SUMS   ("<sha256>  <file name>" lines, one per archive)

Options:
  --out <dir>   write the archive and SHA256SUMS to <dir>
  -h, --help    show this help
`;

type CliOptions = {
  outDir?: string;
  help: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--out requires a directory");
      }
      options.outDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);
      if (!value) throw new Error("--out requires a directory");
      options.outDir = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}\n\n${USAGE}`);
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const written = await writeReleasePackage({
    root,
    ...(options.outDir ? { outDir: resolve(options.outDir) } : {}),
  });

  process.stdout.write(`release package: ${written.path}\n`);
  process.stdout.write(`version: ${written.version}\n`);
  process.stdout.write(`size: ${written.data.length} bytes\n`);
  process.stdout.write(`sha256: ${written.sha256}\n`);
  process.stdout.write(`checksums: ${written.checksumPath}\n`);
  process.stdout.write(`entries: ${written.entries.length}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`package-release: ${message}\n`);
    process.exitCode = 1;
  },
);
