import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tsc 只编代码不搬资源；托盘图标在运行时从 dist/desktop/icons 读取

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../src/desktop/icons");
const target = join(here, "../dist/desktop/icons");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
