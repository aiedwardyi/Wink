// Measures what the phone header icons sit over on every scene skin and writes scripts/phone-backdrops.json,
// which scripts/check-skin-contrast.mjs reads. Run it against a launched verify-wink root:
//   PLAYWRIGHT=<playwright package> node scripts/measure-phone-backdrops.mjs <verify-root>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSceneStills, sharpPath } from "./check-skin-contrast.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const [verifyRoot] = process.argv.slice(2);
if (!verifyRoot || !process.env.PLAYWRIGHT) throw new Error("usage: PLAYWRIGHT=<playwright package> node scripts/measure-phone-backdrops.mjs <verify-root>");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT);
const sharp = require(sharpPath());
const { pictureContext } = await import(pathToFileURL(join(repo, ".claude/skills/verify-wink/picture-shots.mjs")).href);
const state = JSON.parse(readFileSync(join(verifyRoot, "state.json"), "utf8"));
const skins = [...parseSceneStills(readFileSync(join(repo, "src/scenes/scenes.css"), "utf8")).keys()].sort();
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = (p) => "#" + p.map((v) => v.toString(16).padStart(2, "0")).join("");

const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
const out = {};
for (const skin of skins) for (const side of ["left", "right"]) for (const width of [360, 390]) {
  const context = await browser.newContext({ ...pictureContext(width), locale: "en-US", extraHTTPHeaders: { Authorization: "Bearer " + state.token } });
  await context.addInitScript(([s, sd]) => {
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem("omb-locale", "en");
    localStorage.setItem("omb-skin", s);
    localStorage.setItem("openmausbot.sidebarSide", sd);
  }, [skin, side]);
  const page = await context.newPage();
  await page.goto(state.url);
  await page.locator("[data-phone-menu]").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("main[data-scene]").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(3500);
  const boxes = await page.evaluate(() => {
    const rect = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { menu: rect("[data-phone-menu]"), toggle: rect("[data-show-pane-button]") };
  });
  await page.addStyleTag({ content: "[data-phone-menu],[data-show-pane-button]{visibility:hidden !important}" });
  await page.waitForTimeout(300);
  const spots = {};
  for (const [name, clip] of Object.entries(boxes)) {
    const { data, info } = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = Array.from({ length: info.width * info.height }, (_, i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]).sort((a, b) => lum(a) - lum(b));
    spots[name] = hex(pixels[Math.floor((pixels.length - 1) / 2)]);
  }
  ((out[skin] ??= {})[side] ??= {})[width] = spots;
  await context.close();
}
await browser.close();
writeFileSync(join(repo, "scripts/phone-backdrops.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote scripts/phone-backdrops.json for", skins.length, "skins");
