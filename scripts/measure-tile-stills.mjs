// Measures how far each animated theme tile jumps when its scene takes over from its still (1 - SSIM, 0 = same picture) on
// phone widths and a portrait window, and writes scripts/tile-stills.json, which src/components/SkinPicker.test.ts reads.
// --capture instead retakes src/scenes/tiles/<skin>-tall.jpg (.png when the canvas is see-through) from each scene's own
// first canvas, which MiniScene draws as the still; relaunch, then measure.
// Run it against a launched verify-wink root:
//   PLAYWRIGHT=<playwright package> node scripts/measure-tile-stills.mjs <verify-root> [--capture]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sharpPath } from "./check-skin-contrast.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const [verifyRoot] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const capture = process.argv.includes("--capture");
if (!verifyRoot || !process.env.PLAYWRIGHT) throw new Error("usage: PLAYWRIGHT=<playwright package> node scripts/measure-tile-stills.mjs <verify-root> [--capture]");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT);
const sharp = require(sharpPath());
const { pictureContext } = await import(pathToFileURL(join(repo, ".claude/skills/verify-wink/picture-shots.mjs")).href);
const state = JSON.parse(readFileSync(join(verifyRoot, "state.json"), "utf8"));
const tiles = join(repo, "src/scenes/tiles");
const stillFile = (skin) => [join(tiles, `${skin}-tall.jpg`), join(tiles, `${skin}-tall.png`)].find(existsSync);
const SKINS = ["samurai-ink", "night-rain", "warp", "circuit", "neon-grid", "lagoon", "lagoon-night", "snow", "snow-night"];
// Every phone width people hold, and a portrait desktop window: the still is one picture, so it must hold at all of them.
const SIZES = capture ? { 390: pictureContext(390) } : {
  ...Object.fromEntries([360, 375, 390, 393, 412, 430].map((width) => [width, pictureContext(width)])),
  "900x1000": { viewport: { width: 900, height: 1000 } },
};

async function gray(png) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// SSIM over a 7 px window with sample covariance, as scikit-image computes it.
function ssim(a, b) {
  const w = Math.min(a.w, b.w);
  const h = Math.min(a.h, b.h);
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let sum = 0;
  let n = 0;
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const p = a.data[(y + dy) * a.w + x + dx];
      const q = b.data[(y + dy) * b.w + x + dx];
      sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
    }
    const ma = sa / 49, mb = sb / 49;
    const va = ((saa / 49 - ma * ma) * 49) / 48, vb = ((sbb / 49 - mb * mb) * 49) / 48, vab = ((sab / 49 - ma * mb) * 49) / 48;
    sum += ((2 * ma * mb + c1) * (2 * vab + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
    n++;
  }
  return sum / n;
}

const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const widths = {};
try {
  for (const [size, device] of Object.entries(SIZES)) {
    const context = await browser.newContext({ ...device, locale: "en-US", reducedMotion: "no-preference", extraHTTPHeaders: { Authorization: "Bearer " + state.token } });
    await context.addInitScript(() => {
      localStorage.setItem("omb-onboarding-done", "true");
      localStorage.setItem("omb-locale", "en");
    });
    // A WebGL canvas keeps its frame only when asked to, so --capture can read it back.
    if (capture) await context.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, options) {
        return getContext.call(this, type, type === "2d" ? options : { ...options, preserveDrawingBuffer: true });
      };
    });
    const page = await context.newPage();
    const phone = !!device.isMobile;
    const act = (locator) => (phone ? locator.tap() : locator.click());
    await page.clock.install();
    await page.goto(state.url);
    await page.locator('aside[aria-label="Bots and navigation"]').waitFor({ state: "attached", timeout: 30000 });
    await page.locator("[data-sidebar-footer]").waitFor({ state: "attached", timeout: 15000 });
    if (phone) {
      const menu = page.getByRole("button", { name: /^Open bot list/ });
      if (await menu.count()) await act(menu.first());
    }
    await act(page.locator('aside[aria-label="Bots and navigation"] button[aria-label="App settings"]').first());
    const settings = page.locator('[aria-labelledby="app-settings-title"]').first();
    await settings.waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(600);
    // From here no frame runs unless the clock is stepped, so the tiles hold their stills.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 64);
    await act(settings.locator('nav button[aria-label="Themes"]').first());
    const thread = (skin) => page.locator(`[data-skin-tile="${skin}"] [data-mini-thread]`).first();
    await thread(SKINS[0]).waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(1000);
    const stills = {};
    if (!capture) for (const skin of SKINS) {
      if (await page.locator(`[data-skin-tile="${skin}"] [data-mini-scene][data-live]`).count()) throw new Error(`${size}: ${skin} went live before its still was seen`);
      stills[skin] = await gray(await thread(skin).screenshot());
    }
    // Each scene's first live frame, taken before the clock moves again.
    const first = {};
    for (let step = 0; Object.keys(first).length < SKINS.length; step++) {
      if (step > 150) throw new Error(`${size}: the scenes never all went live`);
      await page.clock.runFor(16);
      await page.waitForTimeout(100);
      for (const skin of SKINS) {
        if (first[skin] || !(await page.locator(`[data-skin-tile="${skin}"] [data-mini-scene][data-live]`).count())) continue;
        first[skin] = capture
          ? await page.locator(`[data-skin-tile="${skin}"] [data-mini-scene] canvas`).evaluate((canvas) => {
            const copy = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height }).getContext("2d");
            copy.drawImage(canvas, 0, 0);
            const alpha = copy.getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value < 255);
            return { alpha, png: canvas.toDataURL("image/png") };
          })
          : await thread(skin).screenshot();
      }
    }
    widths[size] = {};
    for (const skin of SKINS) {
      const live = first[skin];
      if (capture) {
        const png = Buffer.from(live.png.split(",")[1], "base64");
        const [ext, other] = live.alpha ? ["png", "jpg"] : ["jpg", "png"];
        const file = join(tiles, `${skin}-tall.${ext}`);
        await (live.alpha ? sharp(png).png({ compressionLevel: 9, palette: false }) : sharp(png).jpeg({ quality: 95 })).toFile(file);
        rmSync(join(tiles, `${skin}-tall.${other}`), { force: true });
        console.log("captured", file);
      } else widths[size][skin] = +(1 - ssim(stills[skin], await gray(live))).toFixed(3);
    }
    if (!capture) console.log(size, JSON.stringify(widths[size]));
    await context.close();
  }
} finally {
  await browser.close();
}
if (!capture) {
  const hash = (skin) => createHash("sha256").update(readFileSync(stillFile(skin))).digest("hex").slice(0, 16);
  const stills = Object.fromEntries(SKINS.map((skin) => [skin, hash(skin)]));
  writeFileSync(join(repo, "scripts/tile-stills.json"), JSON.stringify({ build: state.sha, stills, widths }, null, 2) + "\n");
  console.log("wrote scripts/tile-stills.json");
}
