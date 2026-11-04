// Shared by render.mjs (stills) and clip.mjs (motion): an in-process Vite dev server for the
// real app at this checkout, the concept swapped in by path, and fixture pages with a faked /api.
// No server/index.ts, no ~/.orbit, no sign-in files. Run under guard.cjs (hidden, below normal).
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { answer, initScript } from "./fake.mjs";
import { NOW } from "../fixtures.ts";

export const slash = (p) => p.replace(/\\/g, "/");
const HERE = dirname(fileURLToPath(import.meta.url));
export const DESIGN = slash(dirname(HERE));
export const WT = slash(join(DESIGN, "..", ".."));
export const SCRATCH = process.env.DESK_SCRATCH ?? join(process.env.TEMP ?? os.tmpdir(), "wink-ACCT-TRADER-O");
export const LOCK = "C:/Users/mredw/Desktop/Orbit-extras/Orbit-cards/HEAVY.lock";
export { NOW };

// Shots skip HEAVY.lock (teacher's rule, 11-04 22:45): hold only while its line names a timing
// gate (GO-, PERF-, SPEED- or "gate"). Never create or remove the lock.
const GATE = /\b(?:GO|PERF|SPEED)-|\bgate/i;
export function gateHeld() {
  try {
    const line = readFileSync(LOCK, "utf8").trim();
    return GATE.test(line) ? line : null;
  } catch {
    return null;
  }
}

/** Spawn a child (hidden, BelowNormal via guard.cjs) and wait for it. */
export function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${file} exited ${code}: ${err.slice(-600)}`))));
  });
}

export function ram(where) {
  const free = os.freemem() / 2 ** 30;
  if (free < 6) throw new Error(`free RAM ${free.toFixed(1)} GB under 6 GB at ${where}`);
  return Number(free.toFixed(1));
}

const fromWt = (spec) => import(pathToFileURL(join(WT, "node_modules", spec)).href);

// The concept replaces four components by path; everything else is the app at ab89c492.
const SWAPS = ["ChatPlanMeters", "UsageSection", "TermStatusLine", "AccountConnections"];

function plugins(variant) {
  const swaps = {
    name: "desk-swaps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (variant !== "new" || !importer || slash(importer).includes("/design/")) return null;
      if (!SWAPS.some((name) => source.endsWith(`/${name}`) || source.endsWith(`/${name}.tsx`))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const file = resolved && slash(resolved.id.split("?")[0]);
      const name = SWAPS.find((each) => file?.endsWith(`/src/components/${each}.tsx`));
      return name ? `${DESIGN}/swaps/${name}.tsx` : null;
    },
  };
  // The wait card lives inside ChatView (ErrorRow); the concept takes over its waiting state only.
  const waitCard = {
    name: "desk-wait-card",
    enforce: "pre",
    transform(code, id) {
      if (variant !== "new" || !slash(id).endsWith("/src/components/ChatView.tsx")) return null;
      const hook = /( {2}const now = useNow\(\);\r?\n)( {2}if \(folder\) return <FolderFix)/;
      if (!hook.test(code)) throw new Error("ErrorRow hook point moved");
      const card = '  if (usageLimit && usageWait && usageWait.state === "waiting") return <DeskWaitCard wait={usageWait} raw={message} />;\n';
      return `${code.replace(hook, `$1${card}$2`)}\nimport { DeskWaitCard } from "${DESIGN}/WaitCard.tsx";\n`;
    },
  };
  // Desktop Usage gets room for its chart: the Settings card grows to 704 tall on every pane, so
  // switching panes never jumps. Its max-h-full still hands short windows to the scrolling pane.
  const settingsHeight = {
    name: "desk-settings-height",
    enforce: "pre",
    transform(code, id) {
      if (variant !== "new" || !slash(id).endsWith("/src/components/SettingsModal.tsx")) return null;
      if (!code.includes('"h-[560px]",')) throw new Error("Settings height class moved");
      return code.replace('"h-[560px]",', 'phone ? "h-[560px]" : "h-[704px]",');
    },
  };
  return [swaps, waitCard, settingsHeight];
}

export async function startApp(variant) {
  const { createServer } = await fromWt("vite/dist/node/index.js");
  const react = (await fromWt("@vitejs/plugin-react/dist/index.js")).default;
  const tailwind = (await fromWt("@tailwindcss/vite/dist/index.mjs")).default;
  const { chromium } = await import(pathToFileURL("C:/Users/mredw/AppData/Roaming/npm/node_modules/playwright/index.mjs").href);
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const server = await createServer({
    configFile: false,
    root: WT,
    cacheDir: join(SCRATCH, `vite-${variant}`),
    logLevel: "error",
    plugins: [...plugins(variant), react(), tailwind()],
    resolve: { alias: { "@": `${WT}/src` } },
    server: {
      host: "127.0.0.1", port, strictPort: true, hmr: false, fs: { allow: [WT] },
      watch: { ignored: ["**/node_modules/**", "**/release/**", "**/build/**", "**/dist/**", "**/electron/**", "**/server/**", "**/.git/**"] },
    },
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true, args: ["--mute-audio"] });
  return {
    base: `http://127.0.0.1:${port}`,
    browser,
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

// Same list as LIGHT_SKIN_IDS in src/lib/skins.ts.
const LIGHT = new Set(["atelier", "lagoon", "ledger", "notebook", "messenger", "community-light", "code-review", "blueprint", "wink-day", "paper-tape"]);

/** A fresh context + page on the fixture app. Close the context after each shot. */
export async function openPage(app, { width, phone, locale, skin, reduced = true, extra }) {
  const context = await app.browser.newContext({
    viewport: { width, height: phone ? 844 : 800 }, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone,
    locale: locale === "ko" ? "ko-KR" : "en-US", timezoneId: "Asia/Seoul", colorScheme: LIGHT.has(skin) ? "light" : "dark",
    reducedMotion: reduced ? "reduce" : "no-preference", serviceWorkers: "block",
  });
  await context.addInitScript(initScript, { phone, locale, skin, now: NOW });
  if (extra) await context.addInitScript(extra);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== app.base) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer(url.pathname)) });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(app.base, { waitUntil: "domcontentloaded" });
  await page.locator("textarea[data-orbit-composer]").first().waitFor({ timeout: 90_000 });
  return { context, page };
}

export const L = {
  en: { settings: "App settings", list: "Open bot list", usage: "Usage", connections: "Connections" },
  ko: { settings: "앱 설정", list: "봇 목록 열기", usage: "사용량", connections: "연결" },
};

export async function openList(page, locale) {
  const menu = page.locator("[data-phone-menu]").first();
  if (await menu.isVisible().catch(() => false)) await menu.tap();
  else await page.getByRole("button", { name: L[locale].list, exact: true }).first().tap();
}

export async function openSettings(page, { phone, locale }, section) {
  if (phone) await openList(page, locale);
  await page.locator(`button[aria-label="${L[locale].settings}"]`).first().click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
  await dialog.getByRole("button", { name: L[locale][section], exact: true }).first().click();
}

/** Every visible "@" in the shot: text, titles and labels. Connections rows are the one allowed place. */
export const scan = (page) => page.evaluate(() => {
  const hits = [];
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.opacity !== "0" && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    const el = node.parentElement;
    if (!node.textContent.includes("@") || !el || !seen(el)) continue;
    hits.push({ kind: "text", text: node.textContent.trim().slice(0, 80), conn: Boolean(el.closest("[data-engine-row]")) });
  }
  for (const el of document.querySelectorAll("[title*='@'], [aria-label*='@']")) {
    if (!seen(el)) continue;
    hits.push({ kind: "attr", text: (el.getAttribute("title") || el.getAttribute("aria-label")).slice(0, 80), conn: Boolean(el.closest("[data-engine-row]")) });
  }
  return hits;
});
