import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 托盘图标生成器：用本机 Chrome 无头模式把 32×32 HTML 截成透明 PNG。
// 运行：npm run icons:tray

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = join(here, "../src/desktop/icons");
const workDir = join(tmpdir(), "agentbus-tray-icons");
const SIZE = 32;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);

const STATUS_DOTS = {
  unpaired: "#8E8E93",
  connected: "#557A63",
  disconnected: "#C98A2E",
};
const BADGE_FILL = "#E5484D";

function html(bird, badge) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
  .tile{position:relative;width:${SIZE}px;height:${SIZE}px;border-radius:8px;background:#1D1B20;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .bird{width:22px;height:22px;display:flex;align-items:center;justify-content:center}
  .bird svg{width:100%;height:100%;display:block}
  .dot{position:absolute;right:1px;bottom:1px;width:9px;height:9px;border-radius:50%;border:1.5px solid #1D1B20;box-sizing:border-box}
  .count{position:absolute;right:-1px;bottom:-1px;min-width:14px;height:14px;padding:0 2px;box-sizing:border-box;border-radius:7px;border:1.5px solid #1D1B20;background:${BADGE_FILL};color:#fff;font:700 9px/11px "Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
  </style></head><body><div class="tile"><div class="bird">${bird}</div>${badge}</div></body></html>`;
}

function chromePath() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("找不到 Chrome；设置 CHROME_PATH 后重试");
}

async function render(chrome, name, page) {
  const pagePath = join(workDir, `${name}.html`);
  const outPath = join(iconDir, name);
  await writeFile(pagePath, page, "utf8");
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      `--user-data-dir=${join(workDir, "profile")}`,
      "--force-device-scale-factor=1",
      `--window-size=${SIZE},${SIZE}`,
      "--default-background-color=00000000",
      `--screenshot=${outPath}`,
      pathToFileURL(pagePath).href,
    ],
    { stdio: "ignore" },
  );
}

async function main() {
  await mkdir(iconDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const chrome = chromePath();
  const bird = (await readFile(join(iconDir, "bird.svg"), "utf8")).replace(
    /fill="#000000"/g,
    'fill="#FFFFFF"',
  );
  const dot = (color) => `<div class="dot" style="background:${color}"></div>`;

  await render(chrome, "tray-unpaired.png", html(bird, dot(STATUS_DOTS.unpaired)));
  await render(chrome, "tray-connected.png", html(bird, dot(STATUS_DOTS.connected)));
  await render(chrome, "tray-disconnected.png", html(bird, dot(STATUS_DOTS.disconnected)));
  for (let count = 1; count <= 9; count += 1) {
    await render(chrome, `tray-connected-${count}.png`, html(bird, `<div class="count">${count}</div>`));
  }
  await render(chrome, "tray-connected-9plus.png", html(bird, `<div class="count">9+</div>`));
}

main().then(
  () => console.log(`tray icons written to ${iconDir}`),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
