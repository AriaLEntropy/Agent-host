import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tsc 只编代码不搬资源；托盘图标在运行时从 dist/desktop/icons 读取

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../src/desktop/icons");
const target = join(here, "../dist/desktop/icons");
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await cp(join(here, "../src/desktop/panel"), join(here, "../dist/desktop/panel"), {
  recursive: true,
});
await cp(join(here, "../src/desktop/pairing"), join(here, "../dist/desktop/pairing"), {
  recursive: true,
});
await cp(
  join(here, "../src/desktop/pairing-preload.cjs"),
  join(here, "../dist/desktop/pairing-preload.cjs"),
);
await cp(join(here, "../src/desktop/preload.cjs"), join(here, "../dist/desktop/preload.cjs"));
