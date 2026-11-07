import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VERIFY_GEOMETRY } from "./verify-protocol.mjs";

const fixtureRoot = fileURLToPath(new URL("../scripts/fixtures/verify-host/", import.meta.url));
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function manifest(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".") || !mime[path.extname(entry.name)]) throw new Error("Invalid stub fixture");
    const full = path.join(root, entry.name);
    if (await fs.realpath(full) !== full) throw new Error("Fixture link refused");
    const body = await fs.readFile(full);
    if (body.length > 8 * 1024 * 1024) throw new Error("Fixture byte cap");
    files.push([entry.name, hash(body)]);
  }
  if (files.length > 512) throw new Error("Fixture count cap");
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { revision: hash(JSON.stringify(files)), files: new Map(files) };
}

export async function startSiteServer({ root, entry, revision }) {
  const trusted = await fs.realpath(fixtureRoot);
  if (root !== trusted || !/^[a-zA-Z0-9_-]+\.html$/.test(entry)) throw Object.assign(new Error("Stub fixture only"), { errorCode: "outside-folders" });
  const initial = await manifest(root);
  if (initial.revision !== revision || !initial.files.has(entry)) throw Object.assign(new Error("Fixture changed"), { errorCode: "site-changed" });
  const sockets = new Set();
  let port;
  const revisionUnchanged = async () => { try { return (await manifest(root)).revision === revision; } catch { return false; } };
  const server = createServer(async (req, res) => {
    try {
      const target = req.url?.split("?")[0];
      const name = target?.slice(1);
      if (req.headers.host !== `127.0.0.1:${port}` || !["GET", "HEAD"].includes(req.method) || !initial.files.has(name) || !/^\/[a-zA-Z0-9_.-]+$/.test(target)) return void res.writeHead(403).end();
      const full = path.join(root, name);
      if (await fs.realpath(full) !== full || !await revisionUnchanged()) return void res.writeHead(409).end();
      const handle = await fs.open(full, "r");
      let body;
      try { if (!(await handle.stat()).isFile()) throw new Error("Not a file"); body = await handle.readFile(); } finally { await handle.close(); }
      if (hash(body) !== initial.files.get(name) || await fs.realpath(full) !== full) return void res.writeHead(409).end();
      res.writeHead(200, { "content-type": mime[path.extname(name)], "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-dns-prefetch-control": "off" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  port = server.address().port;
  let closing;
  return {
    origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/${entry}`, fontUrls: [...new Set((await fs.readFile(path.join(root, entry), "utf8")).match(/https:\/\/fonts\.googleapis\.com\/[^"'<>\s]+/g) ?? [])].map((url) => url.replaceAll("&amp;", "&")), revisionUnchanged,
    counts: () => ({ servers: server.listening ? 1 : 0, sockets: sockets.size }),
    close: () => closing ??= new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

export function runVerify(input) {
  const counts = { planned: 1, completed: 0, passed: 0, failed: 0, blocked: 0, notRun: 1 };
  let attached = [];
  let seq = 0;
  let clock;
  const sizing = async () => {
    for (const [tile, page] of Object.entries(input.pages)) {
      const g = VERIFY_GEOMETRY[tile];
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: g.cssW, height: g.cssH, deviceScaleFactor: g.dpr, mobile: g.mobile, scale: input.scale(tile) });
      await page.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: g.mobile });
    }
  };
  const done = (async () => {
    const started = performance.timeOrigin + performance.now();
    let errorCode;
    try {
      for (const page of Object.values(input.pages)) {
        page.debugger.attach("1.3");
        const dialogs = (_event, method) => { if (method === "Page.javascriptDialogOpening") void page.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: false }).catch(() => {}); };
        page.debugger.on("message", dialogs);
        attached.push({ page, debug: page.debugger, dialogs });
        await page.debugger.sendCommand("Page.enable");
        await page.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
        await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      }
      await sizing();
      await Promise.all(Object.values(input.pages).map((page) => page.loadURL(input.url)));
      input.onTiming?.("run-start", started);
      const stream = JSON.parse(await fs.readFile(path.join(fixtureRoot, "stream.json"), "utf8"));
      clock = { t0: performance.timeOrigin + performance.now(), holds: 0 };
      for (const { at, ...ev } of stream) {
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); reject(input.signal.reason ?? new Error("cancelled")); };
          const timer = setTimeout(() => { input.signal.removeEventListener("abort", abort); resolve(); }, Math.max(0, clock.t0 + at - performance.timeOrigin - performance.now()));
          input.signal.addEventListener("abort", abort, { once: true });
          if (input.signal.aborted) abort();
        });
        if (ev.kind === "end") break;
        if (ev.kind === "start" || ev.kind === "load") ev.clock = { ...clock };
        input.emit({ ...ev, seq: ++seq, emittedAt: performance.timeOrigin + performance.now() });
      }
      if (!await input.revisionUnchanged()) throw Object.assign(new Error("changed"), { errorCode: "site-changed" });
      Object.assign(counts, { completed: 1, passed: 1, notRun: 0 });
      input.progress(counts);
    } catch (err) { errorCode = err.errorCode ?? (input.signal.aborted ? "cancelled" : "internal"); }
    finally { for (const { page, debug, dialogs } of attached) { try { debug.off("message", dialogs); if (!page.isDestroyed() && debug.isAttached()) debug.detach(); } catch {} } attached = []; }
    const result = { v: 1, runId: input.runId, site: input.site, counts, issues: [], issueTotal: 0, durationMs: Math.round(performance.timeOrigin + performance.now() - started), ...(errorCode ? { errorCode } : {}) };
    input.emit({ kind: "end", seq: ++seq, emittedAt: performance.timeOrigin + performance.now(), result });
    return result;
  })();
  return { done, rescale: () => { void sizing().catch(() => {}); } };
}
