import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { now, base } from "./fixtures.mjs";
import { checkGate as gate, lowerPriority } from "./runtime.mjs";

const scratch = path.join(process.env.TEMP, "wink-ACCT-TRADER-S");
const output = "C:/Users/mredw/Desktop/Orbit-extras/Orbit-cards/day-1104/acct-trader/concept-s";
const require = createRequire(path.join(scratch, "package.json"));
const { chromium } = require("playwright-core");
const sharp = require("sharp");
const site = path.join(scratch, "site");
const mode = process.argv[2] || "all";
const conceptOnly = process.argv.includes("--concept-only");
let complete = false;
const priorities = [{ role: "node", ...lowerPriority() }];
await gate();
await mkdir(output, { recursive: true });
await mkdir(path.join(output, "crops"), { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    const target = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(`${site}${path.sep}`)) throw new Error("Outside fixture site");
    const data = await readFile(target);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
    response.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream" });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browserServer = await chromium.launchServer({ headless: true, args: ["--mute-audio", "--disable-background-networking", "--no-first-run"] });
priorities.push({ role: "chromium", ...lowerPriority(browserServer.process().pid) });
const browser = await chromium.connect(browserServer.wsEndpoint());
const errors = [];
const blocked = [];
const receipts = [];
const skins = ["github-dimmed", "code-review", "terminal"];
const sizes = [{ name: "phone", width: 390, height: 1280 }, { name: "desktop", width: 1280, height: 1120 }];

async function contextFor(size, video = false) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.name === "phone", hasTouch: size.name === "phone", reducedMotion: video ? "no-preference" : "reduce", ...(video ? { recordVideo: { dir: path.join(scratch, "video"), size: { width: size.width, height: size.height } } } : {}) });
  await context.route("**/*", (route) => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(({ clock }) => {
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    };
  }, { clock: now });
  return context;
}

async function inspect(page, name, concept) {
  const result = await page.evaluate(() => {
    const outside = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.includes("@")) continue;
      const element = node.parentElement;
      if (!element || element.closest("script,style,.connection-row,.today-connections")) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.visibility !== "hidden" && style.display !== "none" && rect.width && rect.height && rect.top < innerHeight && rect.bottom > 0) outside.push(node.textContent);
    }
    const overflows = [...document.querySelectorAll(".account-header span,.account-row .quota,.account-row .action,.window-list strong,.policy button,.meter")].filter((element) => element.getBoundingClientRect().width && element.scrollWidth > element.clientWidth + 1).map((element) => element.textContent);
    const smallTargets = [...document.querySelectorAll("button")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height && (rect.width < 44 || rect.height < 44);
    }).map((element) => element.textContent);
    return { outside, overflows, smallTargets, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, rows: document.querySelectorAll(".account-row").length, text: document.body.innerText };
  });
  receipts.push({ name, concept, ...result });
  assert.equal(result.outside.length, 0, `${name}: privacy`);
  if (concept) {
    assert.equal(result.horizontalOverflow, false, `${name}: page overflow`);
    assert.equal(result.overflows.length, 0, `${name}: clipped cells ${result.overflows}`);
    if (name.endsWith("-phone")) assert.deepEqual(result.smallTargets, [], `${name}: small targets`);
  }
}

async function captureAll() {
  for (const size of mode === "preview" ? [sizes[0]] : sizes) {
    const context = await contextFor(size);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    for (const skin of mode === "preview" ? [skins[0]] : skins) for (const lang of mode === "preview" ? ["en"] : ["en", "ko"]) for (const view of mode === "baseline-details" ? ["details"] : ["usage", "chat", "details"]) for (const kind of mode === "baseline-details" ? ["today"] : conceptOnly ? ["concept"] : ["concept", "today"]) {
      await gate();
      const name = `${kind}-${skin}-${lang}-${view}-${size.name}`;
      await page.goto(`${origin}/${kind === "concept" ? "index.html" : "today.html"}?skin=${skin}&lang=${lang}&view=${view}`, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(output, "crops", `${name}.png`), fullPage: view === "usage" });
      await inspect(page, name, kind === "concept");
      console.log(name);
    }
    await context.close();
  }
}

const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
function label(text, width, height = 76) {
  const parts = text.split(" / ");
  const lines = width < 600 ? [parts.slice(0, 2).join(" / "), parts.slice(2).join(" / ").replace("QUICK VIEW", "QUICK").replace("CONNECTIONS", "CONNECT")] : [text];
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#15191f"/>${lines.map((line, index) => `<text x="12" y="${31 + index * 31}" fill="#edf2f8" font-family="Segoe UI,Malgun Gothic,sans-serif" font-size="${width < 600 ? 22 : 25}" font-weight="600">${escape(line)}</text>`).join("")}</svg>`);
}

async function sheet(kind, details = false) {
  const width = details ? 1742 : 3460;
  const rowHeight = 1380;
  const header = 132;
  const layers = [{ input: label(`${kind === "concept" ? "RUNWAY" : "TODAY / ab89c492"}${details ? " / WAIT + CONNECTIONS" : " / USAGE + CHAT"}`, width, 68), left: 0, top: 0 }, { input: label("Native widths: desktop 1280 / phone 390 | EN + KO | fixture accounts only", width, 54), left: 0, top: 66 }];
  let index = 0;
  for (const skin of skins) for (const lang of ["en", "ko"]) {
    const top = header + index * rowHeight;
    let x = 24;
    for (const view of details ? ["details"] : ["usage", "chat"]) for (const size of [sizes[1], sizes[0]]) {
      const title = `${skin} / ${lang.toUpperCase()} / ${view === "usage" ? "USAGE" : view === "chat" ? kind === "concept" ? "CHAT + QUICK VIEW" : "CHAT + METER" : "WAIT + CONNECTIONS"} / ${size.width}`;
      layers.push({ input: label(title, size.width), left: x, top });
      layers.push({ input: path.join(output, "crops", `${kind}-${skin}-${lang}-${view}-${size.name}.png`), left: x, top: top + 80 });
      x += size.width + 24;
    }
    index++;
  }
  await sharp({ create: { width, height: header + 6 * rowHeight, channels: 3, background: "#15191f" } }).composite(layers).png().toFile(path.join(output, details ? `${kind === "concept" ? "states" : "today-states"}.png` : `${kind}.png`));
}

async function interactions() {
  const context = await contextFor(sizes[0]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/index.html?view=chat&lang=ko`);
  const geometry = () => page.locator(".account-row").evaluateAll((rows) => rows.map((row) => { const { x, y, width, height } = row.getBoundingClientRect(); return { x, y, width, height }; }));
  const before = await geometry();
  await page.locator('[data-use="codex-2"]').click();
  await page.waitForFunction(() => !window.runway.state().pending);
  assert.equal(await page.evaluate(() => window.runway.state().main.Codex), "codex-2");
  assert.deepEqual(await geometry(), before, "Rows moved during switch");
  await page.locator("[data-pin]").click();
  await page.evaluate(() => window.runway.auto());
  assert.match(await page.locator(".receipt").innerText(), /자동 전환 없음/);
  await page.locator("[data-pin]").click();
  await page.evaluate(() => window.runway.auto());
  assert.equal(await page.evaluate(() => window.runway.state().main.Claude), "claude-1");
  assert.match(await page.locator(".receipt").innerText(), /기본 1 유지/);
  assert.match(await page.locator(".receipt").innerText(), /15:00/);
  assert.equal(await page.locator('[data-account="claude-3"] .route-mark').innerText(), "+Lint");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".quick").isVisible(), false);
  assert.equal(await page.locator("[data-meter]").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Alt+u");
  assert.equal(await page.locator(".quick").isVisible(), true);
  assert.equal(await page.locator(".quota small[aria-label]").count(), 8);
  assert.equal(await page.locator('[data-account="claude-2"] .quota small[aria-label]').innerText(), "4d2h");
  await page.locator(".composer input").fill("Keep this draft");
  await page.evaluate(() => window.runway.tick(65.6));
  await page.waitForFunction(() => window.runway.state().value === 65.6);
  assert.equal(await page.locator('[data-account="claude-1"] .quota .num').first().innerText(), "65.6%");
  assert.equal(await page.locator(".meter .num").innerText(), "65.6%");
  assert.match(await page.locator(".forecast").innerText(), /41%/);
  assert.equal(await page.locator(".composer input").inputValue(), "Keep this draft");
  await page.goto(`${origin}/index.html?view=usage`);
  await page.locator('[data-engine="Codex"]').click();
  assert.match(await page.locator(".hero-value").innerText(), /7d left/);
  assert.doesNotMatch(await page.locator(".window-list").innerText(), /5h/);
  await page.locator('[data-engine="Grok"]').click();
  assert.equal(await page.locator("[data-live-value]").innerText(), "?");
  assert.match(await page.locator(".policy").innerText(), /Wait at limit/);
  await page.locator('[data-range="week"]').click();
  assert.equal(await page.locator('[data-range="week"]').getAttribute("aria-pressed"), "true");
  await context.close();
  console.log("Interaction checks passed");
}

async function motion() {
  await gate();
  const context = await contextFor(sizes[1], true);
  const page = await context.newPage();
  await page.goto(`${origin}/index.html?view=chat&lang=en`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.runway.tick(65.9));
  await page.waitForTimeout(1100);
  await page.locator('[data-use="codex-2"]').click();
  await page.waitForTimeout(1300);
  await page.evaluate(() => window.runway.tick(65.8));
  await page.waitForTimeout(1400);
  await page.evaluate(() => window.runway.auto());
  await page.waitForTimeout(1700);
  await page.evaluate(() => window.runway.tick(65.6));
  await page.waitForTimeout(2500);
  const video = page.video();
  await context.close();
  const videoPath = path.join(scratch, "video", "motion.webm");
  await video.saveAs(videoPath);
  await gate();
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-y", "-i", videoPath, "-t", "10", "-an", "-vf", "fps=30", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(output, "motion.mp4")], { windowsHide: true, stdio: "ignore" });
    if (ffmpeg.pid) priorities.push({ role: "ffmpeg", ...lowerPriority(ffmpeg.pid) });
    ffmpeg.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
    ffmpeg.on("error", reject);
  });
  console.log("motion.mp4 encoded");
}

try {
  if (["all", "crops", "preview", "baseline-details"].includes(mode)) await captureAll();
  if (mode === "all" || mode === "checks") await interactions();
  if (mode === "all" || mode === "sheets") { await sheet("concept"); await sheet("today"); await sheet("concept", true); await sheet("today", true); }
  if (mode === "all" || mode === "motion") await motion();
  assert.deepEqual(errors, [], "Browser errors");
  assert.deepEqual(blocked, [], "Unexpected outbound requests");
  if (conceptOnly) {
    const previous = JSON.parse(await readFile(path.join(output, "checks-all.json"), "utf8"));
    assert.equal(previous.base, base);
    assert.equal(receipts.length, 36);
    receipts.unshift(...previous.receipts.filter((receipt) => !receipt.concept));
    assert.equal(receipts.length, 72);
  }
  complete = true;
} finally {
  await writeFile(path.join(output, conceptOnly && !complete ? "checks-concept-held.json" : `checks-${mode}.json`), JSON.stringify({ base, priorities, errors, blocked, receipts }, null, 2));
  await browser.close();
  await browserServer.close();
  server.close();
}
