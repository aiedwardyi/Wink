import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { freemem, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { runHiddenVerify } from "../electron/verify-hidden.mjs";
import { startSiteServer } from "../electron/verify-site-server.mjs";
import { menuOpens, request, writePhoneMenuFixture } from "./sim-phone-menu-fixture.mjs";

const scratch = process.env.ORBIT_SCRATCH;
const playwright = process.env.PLAYWRIGHT;
if (!scratch || !playwright || freemem() < 3 * 1024 ** 3) throw new Error("The isolated proof needs ORBIT_SCRATCH, PLAYWRIGHT and 3 GiB free RAM");
const root = mkdtempSync(join(resolve(scratch), "sim-phone-menu-"));
const project = join(root, "primary", "library");
const other = join(root, "unrelated", "library");
const data = join(root, "data");
const home = join(root, "home");
const system = process.env.SystemRoot ?? "C:\\Windows";
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA, "ms-playwright");
for (const dir of [data, home, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
const kept = /^(?:SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|OS|PROCESSOR_\w+|NUMBER_OF_PROCESSORS|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES(?:\(X86\))?|PUBLIC|COMPUTERNAME|USERNAME)$/i;
for (const name of Object.keys(process.env)) if (!kept.test(name)) delete process.env[name];
Object.assign(process.env, {
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  TEMP: join(root, "tmp"),
  TMP: join(root, "tmp"),
  PATH: [join(system, "System32"), system, join(system, "System32", "Wbem")].join(";"),
  PLAYWRIGHT_BROWSERS_PATH: browsers,
  OMB_DATA_DIR: data,
  OMB_DOWNLOADS_DIR: join(home, "Downloads"),
  OMB_SKILLS_DIR: resolve("skills"),
  OMB_STATIC_DIR: join(root, "ui"),
  OMB_THREAD_SYNC_V2: "0",
  ORBIT_NO_WSL: "1",
  ORBIT_REMOTE_AUTO: "0",
  ORBIT_RELAY: "0",
  OMB_COMMS_TOKEN: randomUUID(),
});
assert.equal(homedir(), home);
writePhoneMenuFixture(project, false);
writePhoneMenuFixture(other, false);

const [{ Store }, { createBoard }, { createForumLessons }, { createVerifySite }, { CommsCallers }, { turnRegistry }, profile] = await Promise.all([
  import("../server/store.ts"), import("../server/board.ts"), import("../server/forum-lessons.ts"), import("../server/verify-site.ts"),
  import("../server/comms-caller.ts"), import("../server/turn-registry.ts"), import("../server/profile-sync.ts"),
]);
const device = profile.loadProfileSyncSettings(data);
profile.saveProfileSyncSettings(data, device);
const pcId = () => device.deviceId;
const model = "gpt-6.2-sol";
const store = new Store(() => ({ instanceId: "codex", model }));
const bot = store.createBot({ name: "Library Fixer", cwd: project }, { seedMessages: false });
const threadId = bot.threadId;
const callers = new CommsCallers();
const token = callers.token(bot.id, threadId);
turnRegistry.start("sim-fixture-turn", { botId: bot.id, threadId, owner: "user", depth: 0, model });
const board = createBoard({ dir: join(data, "board"), pcId, author: () => ({ name: bot.name, model, color: "", mascot_style: "" }) });
const lessons = createForumLessons(board, pcId);

const { build } = await import("vite");
await build({ configLoader: "runner", cacheDir: join(root, "cache"), logLevel: "warn", build: { outDir: process.env.OMB_STATIC_DIR } });
const { chromium } = createRequire(import.meta.url)(playwright);
const browser = await chromium.launch({ headless: true, proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" } });

const events = ["Runtime.executionContextsCleared", "Runtime.exceptionThrown", "Page.frameNavigated", "Network.requestWillBeSent", "Network.webSocketCreated", "Network.responseReceived", "Network.loadingFailed", "Page.javascriptDialogOpening", "Page.fileChooserOpened"];
async function webContents(context) {
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const bus = new EventEmitter();
  for (const name of events) session.on(name, params => bus.emit("message", null, name, params));
  return Object.assign(new EventEmitter(), {
    debugger: Object.assign(bus, { attach() {}, sendCommand: (name, params) => session.send(name, params), detach() {} }),
    loadURL: url => page.goto(url, { waitUntil: "load" }),
  });
}

const bridge = {
  async start(run, _watch, signal) {
    if (state) assert.equal(board.list()[0]?.lesson?.outcome, "pending");
    const website = await startSiteServer(run);
    const context = await browser.newContext();
    try {
      const desktop = await webContents(context);
      const phone = await webContents(context);
      const result = await runHiddenVerify({
        ...run, url: website.url, revisionUnchanged: website.revisionUnchanged, pages: { desktop, phone }, signal,
        emit() {}, progress() {}, blockedUrls: () => [],
      }).done;
      const small = await browser.newContext({ viewport: { width: 392, height: 800 } });
      try { opens.push(await menuOpens(await small.newPage(), website.url)); } finally { await small.close(); }
      state = { runId: run.runId, revision: 1, state: "completed", counts: result.counts, result };
      return "started";
    } finally {
      await context.close();
      await website.close();
    }
  },
  async poll() { return state; },
  async watch() { return false; },
  async cancel() {},
};
let state;
const opens = [];
const verify = createVerifySite({
  store, lessons, lessonBinding: () => ({ project, model }), bridge: () => bridge,
  resolveCommsCaller: header => callers.resolve(header), botOutputRoots: () => [project],
  autoVerdict: () => undefined, isUnattended: () => false, broadcastPatch() {}, logDecision() {},
  deviceId: pcId, appToken: () => false, remoteClient: () => false,
});
const tool = createServer((req, res) => void verify.handleTool(req, res).catch(error => {
  res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
}));
await new Promise(ready => tool.listen(0, "127.0.0.1", ready));
const toolUrl = `http://127.0.0.1:${tool.address().port}`;
const run = entry => fetch(toolUrl, {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ entry }),
}).then(res => res.json());

try {
  const before = await run("index.html");
  assert.equal(before.result?.checks?.["NAV/phone"], "missed", JSON.stringify(before));
  writePhoneMenuFixture(project, true);
  const prediction = { beforeRunId: before.runId, check: "NAV/phone", problem: "Hours and Contact disappear at 392 px.", change: "Add a Menu disclosure with both links.", why: "Keep navigation reachable at phone widths.", expected: "The Menu opens at 392 px, revealing Hours and Contact." };
  const after = await run(`index.html\n${JSON.stringify(prediction)}`);
  assert.equal(after.result?.checks?.["NAV/phone"], "passed", JSON.stringify(after));
  assert.deepEqual(opens, [false, true]);
  const [post] = board.list();
  assert.equal(post.lesson?.outcome, "fixed");
  assert.ok(post.lesson.predictedAt <= post.lesson.endedAt);
  const fresh = { botId: "fixture-fresh", project, model, text: request, room: false };
  assert.equal(lessons.take({ ...fresh, project: other }), undefined);
  const offer = lessons.take(fresh);
  assert.ok(offer?.text.includes(post.id));
  offer.accept();
  assert.equal(lessons.take(fresh), undefined);
  writeFileSync(join(root, "capture.json"), JSON.stringify({ before, after, opens, post }, null, 2));
  await new Promise(done => tool.close(done));

  const reserve = createServer();
  await new Promise(ready => reserve.listen(0, "127.0.0.1", ready));
  process.env.OMB_PORT = String(reserve.address().port);
  await new Promise(done => reserve.close(done));
  const app = `http://127.0.0.1:${process.env.OMB_PORT}`;
  await import("../server/index.ts");
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, locale: "en-US",
    reducedMotion: "reduce",
    extraHTTPHeaders: { Authorization: `Bearer ${process.env.OMB_COMMS_TOKEN}` },
  });
  await context.addInitScript(() => {
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem("omb-locale", "en");
    localStorage.setItem("omb-skin", "precision");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  for (let tries = 0; tries < 60; tries++) {
    try { if ((await fetch(`${app}/api/health`)).ok) break; } catch {}
    await delay(250);
  }
  const loaded = page.waitForResponse(response => response.ok() && new URL(response.url()).pathname === "/api/bots");
  await page.goto(app);
  await loaded;
  await page.locator('[data-sidebar-row-kind="bot"]').filter({ hasText: bot.name }).waitFor();
  await page.locator("[data-board-button]").first().click();
  await page.locator(`[data-board-list] [data-board-post="${post.id}"] > button`).click();
  const article = page.locator(`article[data-board-post="${post.id}"]`);
  await article.getByText("Expected", { exact: true }).waitFor();
  await article.getByText("What happened", { exact: true }).waitFor();
  await article.getByText("Fixed · Live Verify passed the check", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("data-skin"), "precision");
  const picture = join(root, "forum-precision.png");
  await page.screenshot({ path: picture, animations: "disabled" });
  const evidence = article.getByRole("button", { name: "Open Live Verify evidence" });
  await evidence.click();
  await page.locator("[data-verify-card] .verify-card-title").filter({ hasText: "index.html" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ root, picture, postId: post.id, before: before.runId, after: after.runId, opens }));
  await browser.close();
  process.exit(0);
} catch (error) {
  console.error(root, error);
  await browser.close();
  process.exit(1);
}
