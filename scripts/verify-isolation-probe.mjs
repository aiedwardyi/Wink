import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tileRect } from "../electron/verify-protocol.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const scratch = path.join(os.tmpdir(), "wink-lv0-host");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function until(read, check, ms = 12000) {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (check(value)) return value; if (Date.now() >= end) throw new Error("Probe wait expired"); await delay(50); }
}

function systemEnvironment(root) {
  const keep = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "SYSTEMDRIVE"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key.toUpperCase())));
  for (const [key, name] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "appData", LOCALAPPDATA: "appData", TEMP: "temp", TMP: "temp" })) { env[key] = path.join(root, name); fs.mkdirSync(env[key], { recursive: true }); }
  env.TEMP = env.TMP = path.dirname(scratch);
  return env;
}

function launch(exe, args, root) {
  const proc = spawn(exe, args, { cwd: root, env: systemEnvironment(root), stdio: ["ignore", "pipe", "pipe"] });
  os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  let ring = "";
  proc.stdout.on("data", (value) => { ring = (ring + value).slice(-16384); });
  proc.stderr.on("data", (value) => { ring = (ring + value).slice(-16384); });
  proc.on("error", (err) => { ring += err.message; });
  return { proc, output: () => ring, done: new Promise((resolve) => proc.once("exit", (code) => resolve(code))) };
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.method === "Log.entryAdded" && events.length < 200) events.push(frame.params.entry);
    const item = pending.get(frame.id);
    if (!item) return;
    pending.delete(frame.id); clearTimeout(item.timer);
    if (frame.error) item.reject(new Error(frame.error.message)); else item.resolve(frame.result);
  });
  return {
    events,
    call(method, params = {}) {
      return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method + " " + (params.expression ?? "").slice(0, 100))); }, 5000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    },
    async evaluate(expression, userGesture = false) {
      const response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ": " + response.exceptionDetails.exception?.description);
      return response.result.value;
    },
    close() { socket.close(); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("CDP closed")); } pending.clear(); },
  };
}

function copyProbeApp(root, nonce, tcp, udp) {
  const appPath = path.join(root, "app");
  fs.mkdirSync(path.join(appPath, "electron", "resources"), { recursive: true });
  const files = ["entry.mjs", "verify-child.mjs", "verify-child-host.mjs", "verify-child-link.mjs", "verify-protocol.mjs", "verify-network.mjs", "verify-fonts.mjs", "verify-copy.mjs", "verify-probe-bootstrap.mjs", "verify-stub-run.mjs", "verify-wall-preload.cjs", "desktop-notify.mjs", "i18n.mjs"];
  const sourceHashes = {};
  for (const name of files) {
    if (flag("child-exe") && !fs.existsSync(path.join(repo, "electron", name))) continue;
    const source = fs.readFileSync(path.join(repo, "electron", name));
    fs.writeFileSync(path.join(appPath, "electron", name), source); sourceHashes[name] = hash(source);
  }
  fs.copyFileSync(path.join(repo, "electron", "resources", "app-icon.png"), path.join(appPath, "electron", "resources", "app-icon.png"));
  fs.writeFileSync(path.join(appPath, "package.json"), JSON.stringify({ type: "module", main: "electron/entry.mjs" }));
  fs.writeFileSync(path.join(appPath, "electron", "main.mjs"), 'process.exit(71);\n');
  const fixtures = path.join(appPath, "scripts", "fixtures", "verify-host"); fs.mkdirSync(fixtures, { recursive: true });
  for (const name of fs.readdirSync(path.join(repo, "scripts", "fixtures", "verify-host"))) {
    const bytes = fs.readFileSync(path.join(repo, "scripts", "fixtures", "verify-host", name));
    fs.writeFileSync(path.join(fixtures, name), /\.(html|js)$/.test(name) ? bytes.toString().replaceAll("__NONCE__", nonce).replaceAll("__TCP__", String(tcp)).replaceAll("__UDP__", String(udp)) : bytes);
  }
  const stage = path.join(appPath, "electron", "verify"); fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "stage.html"), '<!doctype html><html><head><meta charset="utf-8"><script src="stage.js" defer></script></head><body><p id="site"></p></body></html>');
  fs.writeFileSync(path.join(stage, "stage.js"), `
const queued=[];window.wallEvents=[];
window.verifyWall.onEvent(ev=>{queued.push(ev);window.wallEvents.push(ev);});
window.verifyWall.ready().then(s=>{window.wallSnapshot=s;document.getElementById("site").textContent=s.site;});
`);
  fs.writeFileSync(path.join(stage, "beat.wav"), Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=", "base64"));
  const manifest = fs.readdirSync(fixtures).sort().map((name) => [name, hash(fs.readFileSync(path.join(fixtures, name)))]);
  return { appPath, fixtures: fs.realpathSync.native(fixtures), revision: hash(JSON.stringify(manifest)), sourceHashes, wall: "trusted fixture; FACE visual acceptance is separate" };
}

function dnsSummary(file, nonce) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const types = new Map(Object.entries(data.constants.logEventTypes).map(([name, id]) => [id, name]));
  const named = data.events.filter((event) => /HOST_RESOLVER|DNS_TRANSACTION|DNS_QUERY/.test(types.get(event.type) ?? "") && JSON.stringify(event.params ?? {}).includes(nonce));
  return named.map((event) => ({ type: types.get(event.type), phase: event.phase, params: event.params }));
}

function httpStatus(url, { method = "GET", pathname, host } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: pathname ?? target.pathname, method, headers: host ? { Host: host } : {}, agent: false }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end();
  });
}

async function runParent(app, dialog) {
  const { prepareVerifyProbe } = await import("../electron/verify-probe-bootstrap.mjs");
  const root = flag("verify-probe-root");
  const bootstrap = prepareVerifyProbe({ app, dialog, root });
  const reportPath = path.join(root, "isolation.json");
  const report = { versions: process.versions, pid: process.pid, root, rows: [], lifecycle: [], logs: [], errors: [], phase: "ready", paths: bootstrap.paths };
  const write = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  let host;
  let tcp;
  let udp;
  const clients = [];
  const panic = (err) => {
    report.errors.push(String(err?.stack ?? err)); write();
    void Promise.resolve().then(() => host?.close()).finally(() => { for (const c of clients) c.close(); tcp?.close(); udp?.close(); app.exit(1); });
  };
  process.on("uncaughtException", panic); process.on("unhandledRejection", panic);
  process.stdout.on("error", panic); process.stderr.on("error", panic);
  app.on("window-all-closed", () => {});
  app.commandLine.appendSwitch("mute-audio");
  if (!app.requestSingleInstanceLock()) throw new Error("Scratch lock failed");
  app.whenReady().then(async () => {
    const { createVerifyHost } = await import("../electron/verify-host.mjs");
    const nonce = randomBytes(12).toString("hex");
    let tcpHits = 0, udpHits = 0;
    tcp = createServer((socket) => { tcpHits++; socket.on("error", () => {}); socket.destroy(); });
    await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    udp = createSocket("udp4"); udp.on("message", () => { udpHits++; });
    await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const fixture = copyProbeApp(root, nonce, tcp.address().port, udp.address().port);
    report.fixture = fixture;
    const childOptions = { root, exe: flag("child-exe") ?? process.execPath, ...(flag("child-exe") ? {} : { appPath: fixture.appPath }), scale: 1 };
    host = createVerifyHost({ log: (msg) => { report.logs.push(msg); if (report.logs.length > 200) report.logs.shift(); }, probe: childOptions });
    report.lifecycle.push({ name: "lazy", pass: host.child() === null });
    const input = { runId: "probe-" + nonce, botId: "fixture", root: fixture.fixtures, entry: "hostile.html", revision: fixture.revision, site: '<img src=x onerror="globalThis.escaped=true">', watch: true };
    host.start(input);
    report.phase = "preparing"; write();
    await until(() => host.poll(input.runId), (state) => state.state !== "preparing");
    const state = await host.poll(input.runId);
    report.child = host.child(); report.initialState = state;
    if (state.state === "blocked") throw new Error("Run blocked: " + state.errorCode);
    report.lifecycle.push({ name: "attested ready", pass: !!report.child, readyMs: report.child.readyMs, transport: report.child.transport });
    const mode = flag("mode");
    if (mode === "kill-parent" || mode === "kill-stalled-parent") {
      report.killChild = host.child(); report.killMetrics = await host.probe("metrics");
      if (mode === "kill-stalled-parent") void host.probe({ name: "stall", ms: 35000 }).catch(() => {});
      report.phase = "kill-parent-ready"; write(); return;
    }
    const activePort = await until(() => ["userData", "sessionData"].map((dir) => path.join(report.child.root, dir, "DevToolsActivePort")).find((file) => fs.existsSync(file)), Boolean);
    report.activePortFile = activePort;
    const port = Number(fs.readFileSync(activePort, "utf8").split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pages = targets.filter((target) => target.type === "page" && target.url.includes("/hostile.html"));
    const wallTarget = targets.find((target) => target.url.endsWith("/verify/stage.html"));
    if (pages.length !== 2 || !wallTarget) throw new Error("Missing owned pages/wall");
    const pageClients = await Promise.all(pages.map((page) => connectCdp(page.webSocketDebuggerUrl))); clients.push(...pageClients);
    const wall = await connectCdp(wallTarget.webSocketDebuggerUrl); clients.push(wall);
    const serverUrl = pages[0].url;
    report.input = [];
    for (const client of pageClients) {
      const viewport = await client.evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,touch:navigator.maxTouchPoints})");
      const scale = tileRect(viewport.width === 392 ? "phone" : "desktop", 1280, 720).scale;
      const box = await client.evaluate("(()=>{const r=document.getElementById('target').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      box.x *= scale; box.y *= scale;
      await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
      for (const type of ["mousePressed", "mouseReleased"]) await client.call("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
      const inputBox = await client.evaluate("(()=>{const r=document.getElementById('typing').getBoundingClientRect();return {x:r.x+20,y:r.y+20};})()");
      inputBox.x *= scale; inputBox.y *= scale;
      for (const type of ["mousePressed", "mouseReleased"]) await client.call("Input.dispatchMouseEvent", { type, ...inputBox, button: "left", clickCount: 1 });
      for (const key of "guarded") {
        await client.call("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
        await client.call("Input.dispatchKeyEvent", { type: "keyUp", key });
      }
      report.input.push({ viewport, scale, ...await client.evaluate("({clicks:measurements.clicks,typing:document.getElementById('typing').value})") });
      await client.evaluate("(()=>{alert('click');confirm('click');try{prompt('click')}catch{}document.getElementById('file').showPicker();return true})()", true);
    }
    const observed = [];
    for (const client of pageClients) {
      const boot = await client.evaluate("({url:location.href,ready:document.readyState,probe:typeof isolationProbe,dialogs:window.firstLoadDialogs,scripts:[...document.scripts].map(x=>x.src),resources:performance.getEntriesByType('resource').map(x=>({name:x.name,size:x.transferSize}))})");
      report.pageBoot ??= []; report.pageBoot.push(boot); write();
      observed.push(await client.evaluate("isolationProbe()", true));
    }
    report.observed = observed;
    const first = await pageClients[0].evaluate("localStorage.getItem('tile')");
    await pageClients[0].evaluate("localStorage.setItem('tile','one')");
    const second = await pageClients[1].evaluate("localStorage.getItem('tile')");
    await pageClients[1].evaluate("localStorage.setItem('tile','two')");
    const preserved = await pageClients[0].evaluate("localStorage.getItem('tile')");
    const row = (id, attempted, pass, detail) => { report.rows.push({ id, attempted, observed: pass ? 0 : 1, blocked: pass, detail }); write(); };
    row("S01", 6, first === null && second === null && preserved === "one" && observed.every((v) => v.cookies === ""), { first, second, preserved });
    row("S02", 8, observed.every((v) => v.node === "undefined" && v.require === "undefined" && v.bridge === "undefined" && v.frameNode === "undefined"), "page and same-origin child frame");
    const denied = observed.flatMap((v) => v.checks).filter((v) => ["media", "display", "notification", "clipboard", "geolocation"].includes(v.name));
    row("S03", 10, denied.length === 10 && denied.every((v) => v.error || v.name === "notification" && v.value === "denied"), denied);
    const devices = observed.flatMap((v) => v.checks).filter((v) => ["hid", "serial", "usb", "bluetooth"].includes(v.name));
    row("S04", 8, devices.length === 8 && devices.every((v) => v.error), devices);
    row("S05", 12, observed.every((v) => v.popup) && tcpHits === 0, "popup/download/navigation attempts; sender policies also unit tested");
    row("S06", 14, observed.every((v) => v.firstLoadDialogs === 3), "first-load and click-time alert/confirm/prompt plus file chooser; prompt natively unsupported");
    row("S07", 16, observed.every((v) => v.assets) && tcpHits === 0, "own asset positive; writes and HTTP(S)/WebSocket/beacon negatives");
    row("S08", 10, tcpHits === 0, "exact-origin proxy checks run by isolatePage before navigation");
    const fontLookups = await host.probe("lookups");
    const loadedFonts = await pageClients[0].evaluate("Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,3000))]).then(()=>[...document.fonts].map(face=>({family:face.family,status:face.status})))");
    const fontEntries = await pageClients[0].evaluate("performance.getEntriesByType('resource').filter(x=>x.name.startsWith('https://fonts.')).map(x=>({name:x.name,duration:x.duration}))");
    row("S09", 2, fontLookups.includes("fonts.googleapis.com") && fontLookups.includes("fonts.gstatic.com") && fontLookups.every((name) => ["fonts.googleapis.com", "fonts.gstatic.com"].includes(name)) && loadedFonts.some((face) => face.family.includes("Roboto") && face.status === "loaded"), { lookups: fontLookups, resources: fontEntries, loadedFonts, bounds: "unit tested with header/MIME/redirect/timeout/byte cases" });
    row("S10", 6, tcpHits === 0 && udpHits === 0, "STUN UDP and TURN TCP/TLS listeners");
    const staticChecks = await Promise.all([
      httpStatus(serverUrl), httpStatus(serverUrl, { method: "HEAD" }), httpStatus(serverUrl, { method: "POST" }),
      httpStatus(serverUrl, { host: "foreign.invalid" }), httpStatus(serverUrl, { pathname: "/../secret" }), httpStatus(serverUrl, { pathname: "/%2e%2e/secret" }),
      httpStatus(serverUrl, { pathname: "/%252e%252e/secret" }), httpStatus(serverUrl, { pathname: "/hostile.html:secret" }), httpStatus(serverUrl, { pathname: "/.env" }),
    ]);
    row("S12", staticChecks.length, staticChecks.slice(0, 2).every((status) => status === 200) && staticChecks.slice(2).every((status) => status === 403), staticChecks);
    const layout = await host.probe("layout"); report.layout = layout;
    const resized = await host.probe({ name: "resize", width: 1600, height: 900 }); report.resized = resized;
    await wall.call("Log.enable");
    const wallPolicy = await wall.evaluate(`(async()=>({api:Object.keys(verifyWall).sort(),label:document.getElementById('site').textContent,escaped:!!globalThis.escaped,beat:await fetch(new URL('beat.wav',location.href)).then(r=>r.status,()=>0),file:await fetch('file:///C:/Windows/win.ini').then(r=>r.status,()=>0),remote:await fetch('http://127.0.0.1:${tcp.address().port}/wall').then(r=>r.status,()=>0),inline:(()=>{const s=document.createElement('script');s.textContent='globalThis.escaped=true';document.head.append(s);return !!globalThis.escaped;})()}))()`);
    report.wallConsole = wall.events;
    row("S14", 6, wallPolicy.label === input.site && wallPolicy.beat === 200 && !wallPolicy.escaped && !wallPolicy.inline && wallPolicy.file !== 200 && wallPolicy.remote !== 200, wallPolicy);
    row("S15", 6, wallPolicy.api.join() === "close,onEvent,ready,setMuted" && observed.every((v) => v.bridge === "undefined"), "registered wall only; wrong sender/frame/URL/payload unit cases");
    row("S16", 8, observed.every((v) => v.measurements.raf > 10 && v.measurements.intersection && v.measurements.transition) && report.input.every((v) => v.clicks === 1 && v.typing === "guarded"), { render: observed.map((v) => v.measurements), input: report.input });
    await until(() => host.poll(input.runId), (s) => ["completed", "blocked"].includes(s.state), 30000);
    report.terminal = await host.poll(input.runId);
    const finalCounts = await host.probe("counts");
    row("S17", 6, finalCounts.pages === 0 && finalCounts.servers === 0 && finalCounts.sockets === 0 && finalCounts.listeners === 0 && report.terminal.state === "completed", finalCounts);
    await wall.evaluate("setTimeout(()=>verifyWall.close(),50);true");
    for (const client of clients.splice(0)) client.close();
    const childRoot = report.child.root;
    await until(() => host.child(), (value) => value === null, 10000);
    await until(() => fs.existsSync(childRoot), (exists) => !exists, 10000);
    report.lifecycle.push({ name: "idle cleanup", pass: true });
    const logFile = path.join(root, "s11-global.json");
    fs.copyFileSync(path.join(root, "child-net-1.json"), logFile);
    const dns = dnsSummary(logFile, nonce); fs.writeFileSync(path.join(root, "dns-sanitized.json"), JSON.stringify(dns, null, 2));
    row("S11", 16, dns.length === 0, { events: dns, globalNetlog: logFile, positiveControl: "launcher no-rule render gate" });
    const controlTcp = createConnection({ host: "127.0.0.1", port: tcp.address().port });
    await new Promise((resolve) => controlTcp.once("close", resolve));
    udp.send(Buffer.from("positive"), udp.address().port, "127.0.0.1"); await delay(100);
    report.listenerControls = { tcp: tcpHits, udp: udpHits, pass: tcpHits === 1 && udpHits === 1 };
    report.lifecycle.push({ name: "second instance", pass: bootstrap.metrics().secondInstances === 0 });
    await host.close();
    const scopeChecks = [];
    for (const [name, change, expected] of [["revision", { revision: "b".repeat(64) }, "site-changed"], ["root", { root: fixture.fixtures + "-sibling" }, "outside-folders"], ["entry", { entry: "../hostile.html" }, "outside-folders"]]) {
      host = createVerifyHost({ probe: childOptions });
      const runId = `scope-${name}-${nonce}`; host.start({ ...input, ...change, runId, watch: false });
      const end = await until(() => host.poll(runId), (s) => s.state === "blocked");
      scopeChecks.push({ name, expected, observed: end.errorCode }); await host.close();
    }
    row("S13", 3, scopeChecks.every((check) => check.observed === check.expected), scopeChecks);
    host = createVerifyHost({ probe: childOptions });
    host.start({ ...input, runId: "hang-" + nonce, watch: false });
    await until(() => host.poll("hang-" + nonce), (s) => s.state === "running");
    const hangStart = Date.now();
    void host.probe({ name: "stall", ms: 35000 }).catch(() => {});
    const hung = await until(() => host.poll("hang-" + nonce), (s) => s.state === "blocked", 12000);
    report.lifecycle.push({ name: "stalled child", pass: hung.errorCode === "internal" && Date.now() - hangStart <= 12000, elapsedMs: Date.now() - hangStart });
    host.start({ ...input, runId: "crash-" + nonce, watch: false });
    await until(() => host.poll("crash-" + nonce), (s) => s.state === "running");
    const crashChild = host.child();
    const crashPids = (await host.probe("metrics")).map((metric) => metric.pid);
    const crashStart = Date.now(); process.kill(crashChild.pid, "SIGKILL");
    const crashed = await until(() => host.poll("crash-" + nonce), (s) => s.state === "blocked", 2000);
    await until(() => crashPids.filter(pidAlive), (pids) => pids.length === 0, 5000);
    report.lifecycle.push({ name: "crash", pass: crashed.errorCode === "internal", elapsedMs: Date.now() - crashStart, pids: crashPids });
    host.start({ ...input, runId: "cancel-" + nonce, watch: false });
    await until(() => host.poll("cancel-" + nonce), (s) => s.state === "running");
    const fresh = host.child();
    await host.cancel("cancel-" + nonce);
    const cancelled = await until(() => host.poll("cancel-" + nonce), (s) => s.state === "blocked");
    report.lifecycle.push({ name: "restart and cancel", pass: fresh.pid !== crashChild.pid && cancelled.errorCode === "cancelled" });
    await host.close();
    report.phase = "done";
    report.attempted = report.rows.reduce((n, row) => n + row.attempted, 0);
    report.pass = report.rows.length === 17 && report.rows.every((r) => r.blocked) && report.listenerControls.pass && report.lifecycle.every((r) => r.pass);
    write(); tcp.close(); udp.close(); app.exit(report.pass ? 0 : 1);
  }).catch(panic);
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function runLauncher() {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, "isolation-")));
  const exe = flag("exe") ?? path.join(repo, "node_modules", "electron", "dist", "electron.exe");
  const result = { root, cases: [], pass: false };
  const runRoot = path.join(root, "normal"); fs.mkdirSync(runRoot);
  const child = launch(exe, ["--mute-audio", `--user-data-dir=${path.join(runRoot, "userData")}`, script, `--verify-probe-root=${runRoot}`, ...(flag("child-exe") ? [`--child-exe=${flag("child-exe")}`] : [])], runRoot);
  const code = await child.done;
  const report = fs.existsSync(path.join(runRoot, "isolation.json")) ? JSON.parse(fs.readFileSync(path.join(runRoot, "isolation.json"), "utf8")) : null;
  result.cases.push({ name: "normal", code, pass: report?.pass === true, report: path.join(runRoot, "isolation.json"), output: child.output() });
  const controlRoot = path.join(root, "dns-control"); fs.mkdirSync(controlRoot);
  const control = launch(exe, ["--mute-audio", `--user-data-dir=${path.join(controlRoot, "userData")}`, path.join(repo, "scripts", "verify-render-gate.mjs"), "--s11", `--verify-probe-root=${controlRoot}`], controlRoot);
  const controlCode = await control.done;
  const controlReport = JSON.parse(fs.readFileSync(path.join(controlRoot, "render.json"), "utf8"));
  result.cases.push({ name: "DNS positive control", code: controlCode, pass: controlReport.isolation === false && controlReport.cases.length === 2 && controlReport.cases.every((item) => item.pass && item.s11?.dnsPositive && item.s11?.unapprovedDns.length > 0), report: path.join(controlRoot, "render.json") });
  for (const mode of ["kill-parent", "kill-stalled-parent"]) {
    const modeRoot = path.join(root, mode); fs.mkdirSync(modeRoot);
    const parent = launch(exe, ["--mute-audio", `--user-data-dir=${path.join(modeRoot, "userData")}`, script, `--verify-probe-root=${modeRoot}`, `--mode=${mode}`, ...(flag("child-exe") ? [`--child-exe=${flag("child-exe")}`] : [])], modeRoot);
    const artifact = path.join(modeRoot, "isolation.json");
    const ready = await until(() => { try { return JSON.parse(fs.readFileSync(artifact, "utf8")); } catch { return null; } }, (value) => value?.phase === "kill-parent-ready" || value?.errors.length, 60000);
    if (ready.phase !== "kill-parent-ready") { await parent.done; result.cases.push({ name: mode, pass: false, report: artifact, output: parent.output() }); continue; }
    const pids = [...new Set([ready.killChild.pid, ...ready.killMetrics.map((metric) => metric.pid)])];
    await delay(150);
    const started = Date.now(); parent.proc.kill("SIGKILL"); await parent.done;
    let survivors;
    try { survivors = await until(() => pids.filter(pidAlive), (value) => value.length === 0, 3000); }
    catch { survivors = pids.filter(pidAlive); }
    result.cases.push({ name: mode, pass: survivors.length === 0, elapsedMs: Date.now() - started, pids, survivors, report: artifact });
  }
  result.pass = result.cases.every((value) => value.pass);
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.pass ? 0 : 1;
}

if (process.versions.electron) {
  const { app, dialog } = await import("electron");
  void runParent(app, dialog).catch((err) => { process.stderr.write(String(err.stack)); app.exit(1); });
} else await runLauncher();
