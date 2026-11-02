// Fake API responses keep this proof off the real tailnet.
// Headless, faked API and virtual routing; no server or ports.
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const ownedBrowsers = new Set();
process.on("uncaughtException", (e) => { console.error("uncaught", e?.message ?? e); void Promise.allSettled([...ownedBrowsers].map(b=>b.close())).finally(()=>process.exit(1)); });
process.stdout.on("error", () => {});
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.WINK_PLAYWRIGHT ?? "playwright");
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = process.env.WINK_DEVICE_PROOF_ROOT ?? join(tmpdir(), "wink-SAFE-B");
const baseDeviceWindow = require(join(ROOT, "base-device-window.cjs"));
const deviceWindow = require(join(repo, "electron/device-window.cjs"));

const OUT = process.env.OUT ?? join(ROOT, "evidence");
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
process.env.TEMP = ROOT;
process.env.TMP = ROOT;
const BASE = "http://wink.test";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".webp": "image/webp" };

const now = Date.now();
const caps = { effortLevels: ["low", "medium", "high", "max"], queueing: true, askApproval: true, images: true };
const instances = [{
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: true, billing: "subscription" },
  models: { default: "claude-sonnet-5-5", options: [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5" }] },
  capabilities: caps, install: { kind: "cli", login: { args: ["auth", "login"] }, signInCommand: "claude auth login" },
}];
const config = {
  profile: { name: "Alex", email: "you@example.com" },
  composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 10 }, localVm: { mode: "shared", maxInstances: 1 },
  features: { skillRecorder: false, showToolCalls: false, detailedReplies: false, browser: false, terminalHost: false },
  tts: { configured: false, ready: false, voice: "" },
};
const hello = [
  { id: "m1", role: "user", kind: "text", text: "Can I use you from my phone?", at: now - 60_000 },
  { id: "m2", role: "bot", kind: "text", text: "Yes. Open Settings and follow the steps there.", at: now - 50_000, parentId: "m1" },
];
const bots = [{
  id: "rando", threadId: "rando-thread", name: "Rando", title: "", description: "", color: "blue",
  notifications: false, unread: false, busy: false, activity: "idle", hidden: false, pinned: false,
  autoApprove: true, browser: false, modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5", effort: "high" },
  messages: hello, activeLeafId: "m2",
}];

const HOST = "home.tail1234.ts.net";
const READY = { url: `https://${HOST}/remote?key=${"7c".repeat(32)}`, setup: { state: "ready" } };
const SERVE = { url: null, setup: { state: "serve-disabled", enableUrl: "https://login.tailscale.com/f/serve?node=n1a2b3c4CNTRL" } };
const IPHONE = [{ id: "p1", kind: "iphone", lastSeen: now - 30_000 }];
const ONE = [{ deviceId: "home", name: "Home", host: HOST, current: true, offline: false }];
const TWO = [...ONE, { deviceId: "laptop", name: "Laptop", host: "laptop.tail1234.ts.net", current: false, offline: false, laptop: true }];
const MENU = [...ONE, { deviceId: "laptop", name: "Laptop", host: "laptop.tail1234.ts.net", current: false, offline: true, laptop: true }, { deviceId: "work", name: "Work", host: "work.tail1234.ts.net", current: false, offline: false }];

// kind: settings | menu | page (device window) ; wink clicks counted from app start
const account = "you@example.com";
const setup = (state, backendState, extra={}) => ({ url: state === "ready" ? READY.url : null, setup: {state, backendState, account: backendState === "Running" ? account : undefined, ...extra} });
const STATES = [
  { key:"missing", link:setup("missing") },
  { key:"needs-login", link:setup("not-running","NeedsLogin") },
  { key:"login-opened", link:setup("not-running","NeedsLogin"), openLogin:true },
  { key:"needs-machine-auth", link:setup("not-running","NeedsMachineAuth") },
  { key:"running-no-https", link:setup("serve-disabled","Running",{https:false,enableUrl:SERVE.setup.enableUrl}) },
  { key:"allow-opened", link:setup("serve-disabled","Running",{https:false,enableUrl:SERVE.setup.enableUrl}), openAllow:true },
  { key:"ready", link:setup("ready","Running",{https:true}) },
  { key:"phone-joined", link:setup("ready","Running",{https:true,phoneJoined:true}) },
  { key:"phone-opened", link:{...setup("ready","Running",{https:true,phoneJoined:true}),phones:IPHONE} },
  { key:"other-pc-wait", link:setup("ready","Running",{https:true}), tab:"pc" },
  { key:"other-pc-online", link:{...setup("ready","Running",{https:true}),pcs:[{name:"Laptop",host:"laptop.tail1234.ts.net"}]},tab:"pc",devices:TWO },
  { key:"stopped", link:setup("not-running","Stopped") },
  { key:"error", link:setup("error","Running") },
];
const SCENES = STATES.flatMap(s => ["today","new"].map(v => ({...s,v,id:v+"-"+s.key,kind:"settings"})));
for (const v of ["today","new"]) {
  SCENES.push({id:v+"-menu",v,kind:"menu",devices:MENU});
  SCENES.push({id:v+"-phone-menu",v,kind:"phone-menu",devices:MENU});
  SCENES.push({id:v+"-paste",v,kind:"page",page:"paste"});
  SCENES.push({id:v+"-unreachable",v,kind:"page",page:"unreach"});
}
SCENES.push({id:"new-phone-devices",v:"new",kind:"phone-settings",link:setup("ready","Running",{https:true}),devices:TWO});
SCENES.push({id:"new-phone-connected",v:"new",kind:"phone-settings",link:{...setup("ready","Running",{https:true,phoneJoined:true}),phones:IPHONE},devices:TWO});
const SKINS = [{ id: "precision", title: "Precision" }, { id: "wink-day", title: "Wink Day" }];

const PAGE_TEXT = {
  en: {
    pasteToday: "On that PC, copy the phone link from Settings and paste it here. You only need to do this once.",
    pasteA: "On Laptop, open Settings > Devices and click Copy Link. Paste it here once.",
    submit: "Open", invalid: "That is not this PC's phone link.",
    unreachToday: "Can't reach Laptop right now", unreachB: "Can't reach Laptop", unreachBHelp: "Check that it's on and Tailscale is connected.", retry: "Retry",
  },
  ko: {
    pasteToday: "해당 PC의 설정에서 휴대폰 링크를 복사해 여기에 붙여넣으세요. 한 번만 하면 됩니다.",
    pasteA: "Laptop에서 설정 > 기기를 열고 링크 복사를 누르세요. 여기에 한 번만 붙여넣으면 됩니다.",
    submit: "열기", invalid: "이 PC의 휴대폰 링크가 아닙니다.",
    unreachToday: "지금은 Laptop에 연결할 수 없습니다", unreachB: "Laptop에 연결할 수 없습니다", unreachBHelp: "켜져 있고 Tailscale이 연결되어 있는지 확인하세요.", retry: "다시 시도",
  },
};

const json = (data) => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
async function boot(page, { v, skin, locale, phone, link, devices }) {
  await page.addInitScript(({ skin, locale, phone }) => {
    localStorage.clear();
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem("omb-locale", locale);
    localStorage.setItem("omb-skin", skin);
    localStorage.setItem("omb-shape", "soft");
    
    if (!phone) window.ogb = { platform: "win32", deviceWindow: { open: async () => true }, openExternal: async () => true };
    window.EventSource = class {
      constructor() {
        this.t = setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" });
        }, 40);
      }
      close() { clearTimeout(this.t); }
    };
  }, { v, skin, locale, phone });
  const dist = resolve(join(ROOT, v === "today" ? "dist-today" : "dist-new"));
  await page.route("**/*", async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    let file = resolve(join(dist, path));
    if (!file.startsWith(dist + sep) && file !== dist) return route.abort();
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    await route.fulfill({ status:200, contentType:MIME[extname(file)] ?? "application/octet-stream", body:readFileSync(file) });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/devices/sign-in") return route.fulfill(json({url:"https://login.tailscale.com/a/fixture"}));
    if (path === "/api/phone-relay/status") return route.fulfill(json({configured:false,available:true}));
    let body = {};
    if (path === "/api/bots") body = { bots, groups: [], computerControl: {} };
    else if (path === "/api/instances") body = { instances };
    else if (path === "/api/config") body = config;
    else if (path === "/api/devices") body = { devices: devices ?? ONE };
    else if (path === "/api/routines") body = { routines: [], runs: [] };
    else if (path === "/api/webhooks") body = { webhooks: [], attempts: [], ingress: null };
    else if (path === "/api/remote-link") body = link ?? { url: null, setup: { state: "missing" } };
    else if (path === "/api/phone/devices") body = { phones: [] };
    else if (path.includes("/messages")) body = { messages: path.includes("rando") ? hello : [], hasMore: false };
    else if (path.endsWith("/terminal")) body = { state: "no-terminal", panes: [] };
    else if (path.startsWith("/api/cli-candidates")) body = { candidates: [] };
    await route.fulfill(json(body));
  });
  page.setDefaultTimeout(10_000);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator("textarea[data-orbit-composer]").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const pause = (page, ms = 450) => page.waitForTimeout(ms);
const SECTION = /^(Phone|Devices|휴대폰|기기)$/;
async function openDrawer(page) {
  const menu = page.locator("[data-phone-menu]").first();
  if (await menu.isVisible().catch(() => false)) { await menu.click(); await pause(page); return; }
  const btn = page.locator('button[aria-label="Open bot list"], button[aria-label="봇 목록 열기"]').first();
  if (await btn.isVisible().catch(() => false)) { await btn.click(); await pause(page); }
}
async function openSettings(page, scene, phone, locale) {
  let clicks = 0;
  if (phone) await openDrawer(page);
  await page.getByRole("button", { name: locale === "ko" ? "앱 설정" : "App settings", exact: true }).first().click();
  clicks++;
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
  await dialog.waitFor({ state: "visible" });
  await pause(page, 500);
  await dialog.getByRole("button", { name: SECTION }).first().click();
  clicks++;
  await pause(page, 600);
  if (scene.tab === "pc" && scene.v !== "today") { await dialog.getByRole("radio", { name: "PC" }).click(); clicks++; await pause(page, 400); }
  if (scene.v === "new" && scene.openLogin) { await dialog.getByRole("button",{name:locale==="ko"?"로그인":"Sign In",exact:true}).click(); await pause(page,100); }
  if (scene.v === "new" && scene.openAllow) { await dialog.getByRole("link",{name:locale==="ko"?"허용":"Allow",exact:true}).click(); await pause(page,100); }
  return { dialog, clicks };
}

async function shoot(browser, scene, skin, locale) {
  const tag = `${scene.id}-${skin}${locale === "ko" ? "-ko" : ""}`;
  const file = join(SHOTS, `${tag}.png`);
  const phone = scene.kind.startsWith("phone");
  const tall = false;
  const opts = phone
    ? { viewport: { width: 390, height: tall ? 1500 : 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : scene.kind === "page" ? { viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 }
    : { viewport: { width: 1440, height: tall ? 1700 : 900 }, deviceScaleFactor: 1 };
  const ctx = await browser.newContext({ ...opts, serviceWorkers: "block", reducedMotion: "reduce", locale: locale === "ko" ? "ko-KR" : "en-US" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let clicks = 0;
  let measured;
  try {
    if (scene.kind === "page") {
      const s = PAGE_TEXT[locale];
      const host = "laptop.tail1234.ts.net";
      const title = deviceWindow.deviceWindowTitle("Laptop", host);
      const pages = scene.v === "today" ? baseDeviceWindow : deviceWindow;
      const url = scene.page === "paste"
        ? pages.deviceLinkPage({ host, title, heading: title, help: scene.v === "new" ? s.pasteA : s.pasteToday, placeholder: `https://${host}/remote?key=...`, submit: s.submit, invalid: s.invalid })
        : pages.deviceUnreachablePage({ host, title, heading: scene.v === "new" ? s.unreachB : s.unreachToday, help: scene.v === "new" ? s.unreachBHelp : undefined, retry: s.retry });
      await page.goto(url);
      await pause(page, 300);
      if (scene.v === "new") measured = await page.locator("body").evaluate(body => {
        const issues = [];
        const walker = document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()) {
          const node=walker.currentNode;
          if(!node.textContent.trim() || node.parentElement.closest("script,style")) continue;
          const range=document.createRange(); range.selectNodeContents(node);
          const parent=node.parentElement.getBoundingClientRect();
          for(const rect of range.getClientRects()) if(rect.left<parent.left-1 || rect.right>parent.right+1 || rect.bottom>innerHeight+1) issues.push("clipped: "+node.textContent);
          for(const match of node.textContent.matchAll(/[a-zA-Z0-9@._+-]{2,}|[가-힣]+/g)) {
            range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);
            if(new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size>1) issues.push("mid-word wrap: "+match[0]);
          }
        }
        return {width:innerWidth,height:innerHeight,issues};
      });
      await page.screenshot({ path: file });
    } else {
      await boot(page, { v: scene.v, skin, locale, phone, link: scene.link, devices: scene.devices });
      if (scene.kind === "settings" || scene.kind === "phone-settings") {
        const { dialog, clicks: c } = await openSettings(page, scene, phone, locale);
        clicks = c;
        if (scene.v === "today" && await dialog.locator("[data-devices-settings]").count()) throw new Error("Baseline sources were not applied");
        if (!phone) await page.mouse.move(2, 2);
        if (scene.v === "new") measured = await page.locator("[data-devices-settings]").evaluate(card => {
          const issues = [];
          const addNumbers = [...card.querySelectorAll(':scope > ol:last-child [data-device-step]')].map(row=>Number(row.dataset.deviceStep));
          if(addNumbers.join(',') !== '1,2') issues.push('Add a Device numbering '+addNumbers.join(','));
                const pane = card.parentElement.parentElement;
          const bounds = card.getBoundingClientRect();
          const paneBounds = pane.getBoundingClientRect();
          if (innerWidth === 1440 && pane.scrollHeight > pane.clientHeight + 1) issues.push(`scroll ${pane.scrollHeight}/${pane.clientHeight}`);
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent.trim() || node.parentElement.closest("svg")) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            for (const r of range.getClientRects()) {
              if (r.left < bounds.left - 1 || r.right > bounds.right + 1) issues.push("clipped: "+node.textContent);
              if (innerWidth === 1440 && r.bottom > paneBounds.bottom + 1) issues.push("below viewport: "+node.textContent);
            }
            for (const match of node.textContent.matchAll(/[a-zA-Z0-9@._+-]{2,}|[가-힣]+/g)) {
              range.setStart(node,match.index); range.setEnd(node,match.index+match[0].length);
              if (new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size > 1) issues.push("mid-word wrap: "+match[0]);
            }
          }
          return {width:innerWidth,height:innerHeight,cardHeight:bounds.height,paneHeight:pane.clientHeight,scrollHeight:pane.scrollHeight,addNumbers,issues};
        });
        await page.screenshot({path:file.replace(/\.png$/, "-view.png")});
        if (phone) await page.screenshot({path:file});
        else await dialog.screenshot({path:file});
      } else if (scene.kind === "menu" || scene.kind === "phone-menu") {
        if (phone) await openDrawer(page);
        await page.locator("[data-device-switcher] > button").first().click();
        clicks = 1;
        await page.locator("[data-device-id]").first().waitFor({ state: "visible" });
        await pause(page, 400);
        if (scene.v === "new") measured = await page.locator("[data-connect-device]").evaluate(connect => {
          const list=connect.closest("ul");const bounds=list.getBoundingClientRect();const issues=[];
          if(bounds.left<0 || bounds.right>innerWidth || bounds.top<0 || bounds.bottom>innerHeight) issues.push("menu outside viewport");
          const walker=document.createTreeWalker(list,NodeFilter.SHOW_TEXT);
          while(walker.nextNode()) {
            const node=walker.currentNode;
            if(!node.textContent.trim() || node.parentElement.closest("svg")) continue;
            const range=document.createRange();range.selectNodeContents(node);
            const parent=node.parentElement.getBoundingClientRect();
            for(const rect of range.getClientRects()) if(rect.left<parent.left-1 || rect.right>parent.right+1) issues.push("clipped: "+node.textContent);
            for(const match of node.textContent.matchAll(/[a-zA-Z0-9@._+-]{2,}|[가-힣]+/g)) {
              range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);
              if(new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size>1) issues.push("mid-word wrap: "+match[0]);
            }
          }
          return {width:innerWidth,height:innerHeight,issues};
        });
        if (phone) await page.screenshot({ path: file });
        else {
          const ul = await page.locator("[data-device-id]").first().evaluateHandle((el) => el.closest("ul"));
          const box = await ul.boundingBox();
          const btn = await page.locator("[data-device-switcher] > button").first().boundingBox();
          const x = Math.max(0, Math.min(box.x, btn.x) - 24), y = Math.max(0, btn.y - 16);
          await page.screenshot({ path: file, clip: { x, y, width: Math.max(box.x + box.width, btn.x + btn.width) - x + 24, height: box.y + box.height - y + 24 } });
        }
      }
    }
    return { file, clicks, errors, measured };
  } catch (e) {
    await page.screenshot({ path: join(SHOTS, `ERR-${tag}.png`) }).catch(() => {});
    return { file: null, clicks, errors: [...errors, String(e?.message ?? e).split("\n")[0]] };
  } finally {
    await ctx.close();
  }
}

const only = process.env.ONLY?.split(",");
const BUDGET_MS = Number(process.env.BUDGET ?? 420) * 1000;
const POOL = 4;
const result = { cells: {}, errors: [], skipped: [] };
const t0 = Date.now();
const jobs = [];
for (const scene of SCENES.filter((s) => !only || only.includes(s.id))) {
  const skins = scene.kind === "page" ? ["precision"] : scene.kind.startsWith("phone") ? ["precision"] : SKINS.map((s) => s.id);
  const locales = scene.v !== "today" || scene.kind === "page" ? ["en", "ko"] : ["en"];
  for (const skin of skins) {
    for (const locale of locales) {
  
      if (scene.kind === "page" && scene.v === "today" && locale === "ko") continue;
      jobs.push({ scene, skin, locale, key: `${scene.id}/${skin}/${locale}` });
    }
  }
}
if(new Set(jobs.map(job=>job.key)).size !== jobs.length) throw new Error("Duplicate screenshot keys");
const browser = await chromium.launch({ headless: true });
ownedBrowsers.add(browser);
try {
  let next = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (Date.now() - t0 > BUDGET_MS) { result.skipped.push(job.key); continue; }
      const r = await shoot(browser, job.scene, job.skin, job.locale);
      result.cells[job.key] = r;
      for (const e of r.errors) result.errors.push(`${job.key}: ${e}`);
    }
  }));
} catch (e) {
  result.errors.push(`fatal: ${String(e?.stack ?? e)}`);
} finally {
  await browser.close();

}
result.seconds = Math.round((Date.now() - t0) / 1000);
writeFileSync(join(OUT, "shots.json"), JSON.stringify(result, null, 1));
console.log(`cells ${Object.keys(result.cells).length}/${jobs.length} skipped ${result.skipped.length} errors ${result.errors.length} in ${result.seconds}s`);
if(Object.keys(result.cells).length !== jobs.length) result.errors.push("Missing unique screenshot cells");
for (const e of result.errors.slice(0, 25)) console.log(e);

const sheetBrowser = await chromium.launch({headless:true});
ownedBrowsers.add(sheetBrowser);
const page = await sheetBrowser.newPage({viewport:{width:1900,height:1000}});
const rows = [];
const img = key => {
  const cell = result.cells[key];
  if (!cell?.file) return `<p>Missing ${key}</p>`;
  return `<img src="data:image/png;base64,${readFileSync(cell.file).toString("base64")}">`;
};
for (const skin of SKINS.map(s=>s.id)) {
  for (const state of STATES) rows.push(`<tr><th>${skin}<br>${state.key}</th><td>${img(`today-${state.key}/${skin}/en`)}</td><td>${img(`new-${state.key}/${skin}/en`)}</td><td>${img(`new-${state.key}/${skin}/ko`)}</td></tr>`);
}
for (const [kind,skin] of [["menu","precision"],["menu","wink-day"],["phone-menu","precision"],["paste","precision"],["unreachable","precision"]]) rows.push(`<tr><th>${kind}<br>${skin}</th><td>${img(`today-${kind}/${skin}/en`)}</td><td>${img(`new-${kind}/${skin}/en`)}</td><td>${img(`new-${kind}/${skin}/ko`)}</td></tr>`);
for (const kind of ["phone-devices","phone-connected"]) rows.push(`<tr><th>${kind}<br>390 x 844</th><td></td><td>${img(`new-${kind}/precision/en`)}</td><td>${img(`new-${kind}/precision/ko`)}</td></tr>`);
await page.setContent(`<style>body{margin:0;padding:24px;background:#eee;font:14px system-ui}table{border-spacing:12px}th{width:140px;text-align:left;vertical-align:top}td{width:440px;vertical-align:top}img{max-width:440px;height:auto;border:1px solid #bbb;border-radius:8px}h1{font-size:24px}</style><div id="sheet"><h1>Devices setup: Today / New</h1><p>1440 x 900, Precision and Wink Day. New in English and Korean. Phone: 390 x 844. Real controls, faked API, no Tailscale changes.</p><table><thead><tr><th>State</th><th>Today (655e28f2)</th><th>New, English</th><th>New, Korean</th></tr></thead>${rows.join("")}</table></div>`);
await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
await page.locator("#sheet").screenshot({path:join(OUT,"sheet.png"),timeout:60000});
const problems=Object.entries(result.cells).flatMap(([key,cell])=>(cell.measured?.issues??[]).map(issue=>key+": "+issue));
writeFileSync(join(OUT,"measurements.json"),JSON.stringify({problems,cells:Object.fromEntries(Object.entries(result.cells).filter(([,c])=>c.measured).map(([k,c])=>[k,c.measured]))},null,2));
console.log("measured problems "+problems.length);
for(const problem of problems.slice(0,20)) console.log(problem);
await page.context().browser().close();
if(result.errors.length || result.skipped.length || problems.length) process.exitCode=1;
