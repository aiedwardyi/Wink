import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";

import { app, BrowserWindow, session } from "electron";
import { attach } from "../electron/verify-cdp.mjs";
import { runVerify } from "../electron/verify-run.mjs";
import { siteRevision, startSiteServer } from "../electron/verify-site-server.mjs";

const scratch = resolve(process.env.TEMP, "wink-lv0-engine");
const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const names = arg("--sites", "flash,grok,luna,muse").split(",");
const samples = Number(arg("--samples", "3"));
const fixtures = resolve(arg("--fixtures", join(scratch, "sites")));
if (fixtures !== scratch && !fixtures.startsWith(scratch + sep)) throw new Error("Fixtures must be scratch copies");
if (!Number.isInteger(samples) || samples < 1 || samples > 3 || names.some(n => !["flash", "grok", "luna", "muse", "marker"].includes(n))) throw new Error("Invalid probe arguments");

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("uncaughtException", error => { if (error.code !== "EPIPE") process.stderr.write(String(error.message) + "\n"); app.exit(1); });
process.on("unhandledRejection", error => { process.stderr.write(String(error?.message ?? error) + "\n"); app.exit(1); });
console.log(JSON.stringify({ phase: "entry", pid: process.pid }));
app.setPath("userData", join(scratch, "probe-user-data"));
app.setPath("sessionData", join(scratch, "probe-session-data"));
app.commandLine.appendSwitch("mute-audio");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication,MediaRouter");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
console.log(JSON.stringify({ phase: "ready", pid: process.pid }));
const deny = createServer(socket => socket.destroy());
await new Promise(resolve => deny.listen(0, "127.0.0.1", resolve));
const output = [];

async function one(name, sample) {
  console.log(JSON.stringify({ phase: "site-start", name, sample }));
  const root = await realpath(join(fixtures, name));
  if (!root.startsWith(await realpath(scratch) + sep)) throw new Error("Escaped scratch fixture");
  const site = await startSiteServer({ root, entry: "index.html", revision: await siteRevision({ root, entry: "index.html" }) });
  const windows = [], sessions = [], blocked = new Set(), requests = [], events = [], timing = {};
  const runId = randomUUID(), pages = {};
  let rendering = "hidden", handle;
  try {
    for (const tile of ["desktop", "phone"]) {
      const ses = session.fromPartition(`verify:${runId}:${tile}`, { cache: false });
      sessions.push(ses);
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
      ses.setDevicePermissionHandler(() => false);
      ses.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: false });
      ses.on("select-hid-device", (event, _details, cb) => { event.preventDefault(); cb(""); });
      ses.on("select-serial-port", (event, _ports, _wc, cb) => { event.preventDefault(); cb(""); });
      ses.on("will-download", event => event.preventDefault());
      await ses.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${deny.address().port}`, proxyBypassRules: `<-loopback>;${site.origin}` });
      ses.webRequest.onBeforeRequest((details, cb) => {
        const url = new URL(details.url), allowed = url.origin === site.origin && ["GET", "HEAD"].includes(details.method);
        requests.push({ tile, url: details.url, method: details.method, allowed });
        if (!allowed) blocked.add(details.url);
        cb({ cancel: !allowed });
      });
      ses.webRequest.onBeforeSendHeaders((details, cb) => {
        const headers = { ...details.requestHeaders };
        for (const key of Object.keys(headers)) if (/^(?:cookie|authorization|proxy-authorization|referer)$/i.test(key)) delete headers[key];
        cb({ requestHeaders: headers });
      });
      ses.webRequest.onHeadersReceived((details, cb) => {
        const headers = { ...details.responseHeaders };
        for (const key of Object.keys(headers)) if (/^set-cookie$/i.test(key)) delete headers[key];
        cb({ responseHeaders: headers });
      });
      const window = new BrowserWindow({
        show: false, opacity: 0, x: -32000, y: -32000, width: 1280, height: 900, skipTaskbar: true, focusable: false,
        webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, spellcheck: false, devTools: false, backgroundThrottling: false },
      });
      windows.push(window);
      const wc = pages[tile] = window.webContents;
      wc.setAudioMuted(true);
      wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("select-bluetooth-device", (event, _devices, cb) => { event.preventDefault(); cb(""); });
      const navigation = (event, url) => { if (new URL(url).origin !== site.origin) event.preventDefault(); };
      wc.on("will-navigate", navigation);
      wc.on("will-frame-navigate", event => { if (new URL(event.url).origin !== site.origin) event.preventDefault(); });
      wc.on("will-redirect", navigation);
      wc.on("will-prevent-unload", event => event.preventDefault());
      let timer;
      const renders = await Promise.race([
        wc.executeJavaScript("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"),
        new Promise(r => timer = setTimeout(() => r(false), 500)),
      ]);
      clearTimeout(timer);
      if (!renders) { rendering = "inactive"; window.showInactive(); }
    }
    handle = runVerify({
      runId, site: name, url: site.url, pages, scale: tile => tile === "desktop" ? 0.65 : 0.585,
      emit: event => events.push(event), progress: () => {}, blockedUrls: () => [...blocked],
      revisionUnchanged: site.revisionUnchanged, signal: new AbortController().signal,
      onTiming: (marker, epochMs) => {
        timing[marker] = epochMs;
        console.log(JSON.stringify({ phase: marker, name, sample, epochMs }));
      },
    });
    const result = await handle.done;
    const metrics = {};
    for (const tile of ["desktop", "phone"]) {
      const cdp = attach(pages[tile]);
      try { metrics[tile] = await cdp.ev('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, meta: !!document.querySelector("meta[name=viewport]") })'); }
      finally { cdp.close(); }
    }
    const score = events.find(e => e.kind === "load")?.score;
    const coverage = {};
    for (const h of score?.hops ?? []) if (!h.live) {
      const row = coverage[h.checker] ??= { checks: 0, issues: 0 };
      row.checks += h.n; row.issues += h.src.filter(e => e.result === "issue").length;
    }
    for (const event of events.filter(e => e.kind === "result" && ["ok", "issue"].includes(e.ev.result))) {
      const row = coverage[event.ev.checker] ??= { checks: 0, issues: 0 };
      row.checks++; row.issues += Number(event.ev.result === "issue");
    }
    const entry = await readFile(join(root, "index.html"));
    const out = { name, sample, rendering, sha256: createHash("sha256").update(entry).digest("hex"), ua: pages.desktop.getUserAgent(), metrics, timing, firstCheckMs: timing["first-check"] - timing["run-start"], coverage, blocked: [...blocked], requests, result };
    output.push(out);
    await writeFile(join(scratch, `probe-${name}-${sample}-events.json`), J(events));
    await writeFile(join(scratch, "probe-results.json"), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(out));
  } finally {
    for (const window of windows) if (!window.isDestroyed()) { window.webContents.close({ waitForBeforeUnload: false }); window.destroy(); }
    for (const ses of sessions) {
      await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache(); await ses.closeAllConnections();
    }
    await site.close();
  }
}
const J = JSON.stringify;
try {
  await mkdir(scratch, { recursive: true });
  for (const name of names) for (let sample = 1; sample <= samples; sample++) await one(name, sample);
} finally {
  await new Promise(resolve => deny.close(resolve));
  app.quit();
}
}).catch(error => { process.stderr.write(String(error?.stack ?? error) + "\n"); app.exit(1); });
