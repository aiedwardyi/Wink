import { app, BaseWindow, dialog, session, WebContentsView } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareVerifyProbe } from "../electron/verify-probe-bootstrap.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = path.join(os.tmpdir(), "wink-lv0-host");
fs.mkdirSync(scratch, { recursive: true });
const probe = prepareVerifyProbe({ app, root: fs.mkdtempSync(path.join(scratch, "render-")) });
const output = path.join(probe.root, "render.json");
const report = { versions: process.versions, root: probe.root, cases: [], pick: null, errors: [] };
const checkS11 = process.argv.includes("--s11");
const nonce = randomUUID().replaceAll("-", "");
let canaryPort = 0;
const canaryHits = [];
let finishing = false;
const owned = new Set();

function writeReport() {
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
}

function phase(value) {
  report.phase = value;
  writeReport();
}

function fatal(error) {
  report.errors.push(String(error?.stack ?? error));
  try { writeReport(); } catch {}
  if (!finishing) {
    finishing = true;
    void cleanup().finally(() => app.exit(1));
  }
}

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.stdout.on("error", (error) => { if (error.code !== "EPIPE") fatal(error); });
process.stderr.on("error", (error) => { if (error.code !== "EPIPE") fatal(error); });
dialog.showErrorBox = (_title, content) => fatal(new Error(content));
for (const name of ["showOpenDialog", "showSaveDialog", "showMessageBox"]) {
  dialog[name] = async () => { throw new Error("Native dialog refused by verify probe"); };
}
for (const name of ["showOpenDialogSync", "showSaveDialogSync", "showMessageBoxSync"]) {
  dialog[name] = () => { throw new Error("Native dialog refused by verify probe"); };
}
app.commandLine.appendSwitch("mute-audio");
app.on("window-all-closed", () => {});

function bounded(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Verify gate timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function cleanup() {
  for (const close of [...owned].reverse()) {
    try { await bounded(close()); } catch (error) { report.errors.push(String(error)); }
    owned.delete(close);
  }
}

async function fixtureServer() {
  const root = fs.realpathSync.native(fileURLToPath(new URL("./fixtures/verify-host/", import.meta.url)));
  const mime = { "render.html": "text/html", "render.js": "text/javascript", "render.css": "text/css", "pixel.svg": "image/svg+xml", "s11.html": "text/html", "s11.js": "text/javascript" };
  const files = new Map(Object.keys(mime).map((name) => {
    const full = path.join(root, name);
    const bytes = fs.readFileSync(full);
    return ["/" + name, { full, bytes, hash: createHash("sha256").update(bytes).digest("hex"), type: mime[name] }];
  }));
  let port;
  const sockets = new Set();
  const server = createServer((req, res) => {
    try {
      const file = files.get(req.url);
      if (req.headers.host !== `127.0.0.1:${port}` || !["GET", "HEAD"].includes(req.method) || !file) {
        res.writeHead(403).end();
        return;
      }
      if (fs.realpathSync.native(file.full) !== file.full || createHash("sha256").update(fs.readFileSync(file.full)).digest("hex") !== file.hash) {
        res.writeHead(409).end();
        return;
      }
      res.writeHead(200, {
        "content-type": file.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-dns-prefetch-control": "off",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      });
      const bytes = req.url === "/s11.html" ? file.bytes.toString().replaceAll("__NONCE__", nonce).replaceAll("__PORT__", String(canaryPort)) : file.bytes;
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      res.writeHead(500).end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  port = await listen(server);
  owned.add(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${port}`;
}

async function guards(ses, contents, origin) {
  phase("guards:deny-proxy");
  const blocked = [];
  const deny = createTcpServer((socket) => { socket.on("error", () => {}); socket.destroy(); });
  const denyPort = await listen(deny);
  const closeDeny = () => new Promise((resolve) => deny.close(resolve));
  owned.add(closeDeny);
  const local = (raw) => {
    try { return new URL(raw).origin === origin && !new URL(raw).username && !new URL(raw).password; } catch { return false; }
  };
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: false });
  const cancelDevice = (event, _details, callback) => { event.preventDefault(); callback(); };
  ses.on("select-hid-device", cancelDevice);
  ses.on("select-serial-port", cancelDevice);
  contents.on("select-bluetooth-device", (event, _devices, callback) => { event.preventDefault(); callback(""); });
  ses.on("will-download", (event) => event.preventDefault());
  ses.on("login", (event, _details, _info, callback) => { event.preventDefault(); callback(); });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
    contents.on(name, (event, target) => { if (!local(typeof target === "string" ? target : target?.url ?? event.url)) event.preventDefault(); });
  }
  contents.on("will-prevent-unload", (event) => event.preventDefault());
  contents.on("unresponsive", () => fatal(new Error("Verify page hung")));
  contents.on("render-process-gone", (_event, details) => fatal(new Error(`Verify renderer gone: ${details.reason}`)));
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const allow = local(details.url) && ["GET", "HEAD"].includes(details.method);
    if (!allow && blocked.length < 2000) blocked.push(details.url);
    callback({ cancel: !allow });
  });
  ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).filter(([key]) => !["cookie", "authorization", "proxy-authorization", "referer"].includes(key.toLowerCase())));
    callback({ requestHeaders: headers });
  });
  ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
    const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([key]) => key.toLowerCase() !== "set-cookie"));
    callback({ responseHeaders: headers });
  });
  phase("guards:protocol");
  await bounded(Promise.resolve(ses.protocol.handle("https", () => new Response(null, { status: 403 }))));
  phase("guards:set-proxy");
  await bounded(ses.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${denyPort}`, proxyBypassRules: `<-loopback>;${origin}` }));
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setAudioMuted(true);
  contents.setZoomFactor(1);
  if (ses.getPreloadScripts().length) throw new Error("Unexpected verify session preload");
  const proxy = {};
  for (const url of [origin, "http://127.0.0.1:9", "http://169.254.169.254", "https://fixture.invalid", "ws://fixture.invalid"]) {
    proxy[url] = await bounded(ses.resolveProxy(url));
    if (url === origin ? proxy[url] !== "DIRECT" : proxy[url].includes("DIRECT")) throw new Error("Proxy is not fail closed");
  }
  return { proxy, blocked };
}

async function renderCase(mode, origin) {
  phase(mode + ":construct");
  const win = probe.guardWindow(new BaseWindow(probe.windowOptions({ width: 1280, height: 720 })));
  const ses = session.fromPartition(`verify:${randomUUID()}:${mode}`, { cache: false });
  const view = new WebContentsView({ webPreferences: {
    session: ses, sandbox: true, contextIsolation: true, webSecurity: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webviewTag: false, allowRunningInsecureContent: false, spellcheck: false,
    devTools: false, backgroundThrottling: false,
  } });
  const contents = view.webContents;
  const close = async () => {
    if (!contents.isDestroyed()) {
      if (contents.debugger.isAttached()) contents.debugger.detach();
      contents.removeAllListeners("unresponsive");
      contents.removeAllListeners("render-process-gone");
      const closed = new Promise((resolve) => contents.once("destroyed", resolve));
      contents.close({ waitForBeforeUnload: false });
      await bounded(closed);
    }
    for (const operation of [() => ses.clearStorageData(), () => ses.clearCache(), () => ses.clearAuthCache(), () => ses.closeAllConnections()]) await bounded(operation());
    ses.removeAllListeners();
    if (!win.isDestroyed()) win.destroy();
  };
  owned.add(close);
  try {
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
    const policy = await guards(ses, contents, origin);
    phase(mode + ":blank");
    await bounded(contents.loadURL("about:blank"));
    phase(mode + ":cdp");
    contents.debugger.attach("1.3");
    const send = (method, params = {}) => bounded(contents.debugger.sendCommand(method, params));
    contents.debugger.on("message", (_event, method) => {
      if (method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: false }).catch(fatal);
    });
    await send("Page.enable");
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    phase(mode + ":zoom");
    await bounded(contents.setVisualZoomLevelLimits(1, 1));
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false, scale: 1 });
    const version = await send("Browser.getVersion");
    if (mode === "inactive") win.showInactive();
    phase(mode + ":load");
    await bounded(contents.loadURL(`${origin}/render.html`));
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await delay(500);
    const before = await evaluate("({raf: measurements.raf, t: performance.now()})");
    await delay(1500);
    const after = await evaluate("({raf: measurements.raf, t: performance.now()})");
    const box = await evaluate("JSON.parse(JSON.stringify(document.getElementById('target').getBoundingClientRect()))");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await delay(100);
    const hover = await evaluate("getComputedStyle(document.getElementById('target')).backgroundColor === 'rgb(1, 200, 3)'");
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    const input = await evaluate("JSON.parse(JSON.stringify(document.getElementById('typing').getBoundingClientRect()))");
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: input.x + 20, y: input.y + 20, button: "left", clickCount: 1 });
    for (const key of "guarded") {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key });
    }
    const state = await evaluate("({...measurements, typing: document.getElementById('typing').value, node: typeof require, bridge: typeof verifyWall})");
    const capture = await bounded(contents.capturePage());
    const result = {
      mode, version, rafPerSecond: (after.raf - before.raf) * 1000 / (after.t - before.t),
      hover, ...state, capture: { empty: capture.isEmpty(), size: capture.getSize() },
      visible: win.isVisible(), focused: win.isFocused(), opacity: win.getOpacity(), bounds: win.getBounds(),
      proxy: policy.proxy, blockedUrls: policy.blocked,
    };
    result.pass = result.rafPerSecond > 10 && result.transition && result.intersection && result.image && hover && result.clicks === 1 && result.typing === "guarded" && !result.capture.empty && !result.focused && result.opacity === 0;
    if (checkS11) {
      const logPath = path.join(probe.root, `${mode}-netlog.json`);
      phase(mode + ":s11");
      await ses.netLog.startLogging(logPath, { captureMode: "default", maxFileSize: 4 * 1024 * 1024 });
      const hints = [];
      ses.on("preconnect", (_event, url) => hints.push(url));
      const beforeHits = canaryHits.length;
      await bounded(contents.loadURL(`${origin}/s11.html`));
      await delay(2000);
      const attempts = await evaluate("speculationAttempts");
      const observedHits = canaryHits.length - beforeHits;
      const controlHost = `control-${mode}-${nonce}.localhost`;
      const control = await bounded(ses.resolveHost(controlHost)).then((value) => value.endpoints, (error) => ({ error: String(error) }));
      await bounded(new Promise((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: canaryPort });
        socket.on("error", reject);
        socket.on("connect", () => { socket.end(); resolve(); });
      }));
      await delay(100);
      const controlHits = canaryHits.length - beforeHits - observedHits;
      await ses.netLog.stopLogging();
      const netlog = JSON.parse(fs.readFileSync(logPath, "utf8"));
      const types = new Map(Object.entries(netlog.constants.logEventTypes).map(([key, value]) => [value, key]));
      const dnsEvents = netlog.events.filter((event) => /HOST_RESOLVER|DNS_TRANSACTION|DNS_QUERY/.test(types.get(event.type) ?? ""));
      const named = dnsEvents.filter((event) => JSON.stringify(event.params ?? {}).includes(nonce));
      const ids = new Set(named.map((event) => event.source.id));
      const relevant = dnsEvents.filter((event) => ids.has(event.source.id)).map((event) => ({ id: event.source.id, type: types.get(event.type), phase: event.phase, params: event.params }));
      const escapes = named.filter((event) => !JSON.stringify(event.params).includes(controlHost));
      const systemTasks = relevant.filter((event) => event.type === "HOST_RESOLVER_SYSTEM_TASK" && event.phase === 1);
      const sanitized = path.join(probe.root, `${mode}-dns.json`);
      fs.writeFileSync(sanitized, JSON.stringify(relevant, null, 2) + "\n");
      result.s11 = {
        attempted: ["static dns-prefetch", "static preconnect", "static prefetch", ...attempts],
        hints, observedHits, controlHost, control, controlHits,
        dnsPositive: relevant.some((event) => JSON.stringify(event.params ?? {}).includes(controlHost)),
        unapprovedDns: escapes.map((event) => ({ type: types.get(event.type), phase: event.phase, params: event.params })),
        systemTasks, logPath, sanitized,
      };
      result.s11.pass = result.s11.dnsPositive && controlHits > 0 && !observedHits && !escapes.length && !systemTasks.length;
    }
    return result;
  } finally {
    await close();
    owned.delete(close);
  }
}

const deadline = setTimeout(() => fatal(new Error("Render gate exceeded 60 s")), 60_000);
phase("await-ready");
app.whenReady().then(async () => {
  phase("ready");
  if (!app.requestSingleInstanceLock()) throw new Error("Scratch probe instance lock unavailable");
  const origin = await fixtureServer();
  if (checkS11) {
    const sockets = new Set();
    const canary = createTcpServer((socket) => {
      canaryHits.push({ time: Date.now(), remote: socket.remoteAddress });
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.end();
    });
    canaryPort = await listen(canary);
    owned.add(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => canary.close(resolve));
    });
  }
  for (const mode of ["hidden", "inactive"]) {
    try { report.cases.push(await renderCase(mode, origin)); }
    catch (error) { report.cases.push({ mode, pass: false, error: String(error.stack ?? error) }); }
    writeReport();
  }
  report.pick = report.cases.find((item) => item.pass)?.mode ?? null;
  report.isolation = checkS11 ? report.cases.every((item) => item.s11?.pass) : "not-run";
  finishing = true;
  await cleanup();
  clearTimeout(deadline);
  writeReport();
  process.stdout.write(JSON.stringify({ output, pick: report.pick, cases: report.cases, errors: report.errors }) + "\n");
  app.exit(report.pick && report.isolation !== false && !report.errors.length ? 0 : 1);
}).catch((error) => {
  clearTimeout(deadline);
  fatal(error);
});
