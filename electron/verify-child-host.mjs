import { app, BaseWindow, ipcMain, screen, session, WebContentsView } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { windowsAppUserModelId } from "./desktop-notify.mjs";
import { validCounts, validResult } from "./verify-child-link.mjs";
import { verifyCopy } from "./verify-copy.mjs";
import { createVerifyFonts } from "./verify-fonts.mjs";
import { isolatePage, isolateWall, VERIFY_PAGE_PREFERENCES } from "./verify-network.mjs";
import { guardVerifyProbeWindow, verifyProbeWindowOptions } from "./verify-probe-bootstrap.mjs";
import { tileRect, VERIFY_IPC, VERIFY_RUN_MS } from "./verify-protocol.mjs";
import { runVerify } from "./verify-run.mjs";
import { startSiteServer } from "./verify-site-server.mjs";

export const VERIFY_RENDER_MODE = "inactive";
const stageUrl = new URL("./verify/stage.html", import.meta.url).href;
const preload = fileURLToPath(new URL("./verify-wall-preload.cjs", import.meta.url));
const icon = fileURLToPath(new URL("./resources/app-icon.png", import.meta.url));
const tiles = ["desktop", "phone"];
const zero = () => ({ planned: 0, completed: 0, passed: 0, failed: 0, blocked: 0, notRun: 0 });
const epoch = () => performance.timeOrigin + performance.now();
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

function bounded(promise, ms = 1500) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Verify operation timeout")), ms); })]).finally(() => clearTimeout(timer));
}

export function revealVerifyWindow(win, display, probe) {
  const { x, y, width, height } = display;
  win.setBounds({ x: Math.round(x + (width - 1280) / 2), y: Math.round(y + (height - 720) / 2), width: 1280, height: 720 });
  if (probe) return;
  win.setFocusable(true); win.setSkipTaskbar(false); win.setIgnoreMouseEvents(false); win.setOpacity(1);
  win.setAlwaysOnTop(true); win.show(); win.moveTop(); win.setAlwaysOnTop(false); win.focus();
}

export function createVerifyChildHost({ send, probe = null, log = () => {}, dependencies = {} }) {
  const d = { app, BaseWindow, ipcMain, screen, session, WebContentsView, isolatePage, isolateWall, runVerify, startSiteServer, ...dependencies };
  const records = new Map();
  const lookups = new Set();
  let active;
  let wallOwner;
  let closing;
  let ipcInstalled = false;
  function safe(fn) { return (...args) => { try { Promise.resolve(fn(...args)).catch((err) => log("error", err.message)); } catch (err) { log("error", err.message); } }; }
  function listen(r, emitter, name, handler) { const wrapped = safe(handler); emitter.on(name, wrapped); r.listeners.push(() => emitter.off(name, wrapped)); }
  function idle() { if (!active && !wallOwner) send({ type: "idle" }); }
  function unwatch(r) {
    r.watching = false; r.win.hide();
    if (!r.finished) {
      r.win.setOpacity(0); r.win.setFocusable(false); r.win.setSkipTaskbar(true);
      r.win.setIgnoreMouseEvents(true); r.win.setPosition(-32000, -32000); r.win.showInactive();
    }
  }
  function state(r, name, result = null) {
    r.state = name;
    send({ type: "state", runId: r.input.runId, state: name, counts: r.counts, result, ...(result?.errorCode ? { errorCode: result.errorCode } : {}) });
  }
  function snapshot(r) { return structuredClone(r.snapshot); }
  function wallEvent(r, ev) {
    if (r.wall && !r.wall.webContents.isDestroyed() && r.wall.webContents.getURL() === stageUrl) r.wall.webContents.send(VERIFY_IPC.event, ev);
  }
  function admit(r, ev, reserve = true) {
    if (!Number.isSafeInteger(ev.seq) || ev.seq <= r.snapshot.lastSeq || !Number.isFinite(ev.emittedAt) || ev.emittedAt <= r.lastTime) throw new Error("Invalid verify sequence");
    const next = { ...r.snapshot, events: [...r.snapshot.events, ev], lastSeq: ev.seq };
    if (ev.kind === "start") { next.scan = ev.scan; next.clock = ev.clock; }
    if (ev.kind === "load") { if (bytes(ev.score) > 1024 * 1024) throw Object.assign(new Error("Verify score cap"), { errorCode: "resource-limit" }); next.score = ev.score; next.clock = ev.clock; }
    if (ev.kind === "end") next.result = ev.result;
    const nonImage = { ...next }; delete nonImage.finalFrames;
    nonImage.events = nonImage.events.map(({ finalFrames: _frames, ...event }) => event);
    if (next.events.length > (reserve ? 1999 : 2000) || bytes(nonImage) > 2 * 1024 * 1024 - (reserve ? 32768 : 0)) throw Object.assign(new Error("Verify snapshot cap"), { errorCode: "resource-limit" });
    r.snapshot = next; r.lastTime = ev.emittedAt;
    wallEvent(r, ev);
    if (ev.kind !== "end" && r.input.recording !== false && bytes(ev) < 60 * 1024) send({ type: "mark", runId: r.input.runId, event: ev });
  }
  function fail(r, errorCode) {
    r.forced ??= errorCode;
    r.abort.abort(Object.assign(new Error(errorCode), { errorCode }));
    if (!r.finishing) void finish(r).catch((err) => log("error", err.message));
  }
  function emit(r, event) {
    if (r.finishing || r.finished) return;
    try {
      if (event.kind === "end") { if (r.end) throw new Error("Duplicate verify end"); r.end = structuredClone(event); return; }
      if (r.end) throw new Error("Event after verify end");
      admit(r, structuredClone(event));
      if (event.kind === "start" && r.state !== "running") state(r, "running");
    } catch (err) { fail(r, err.errorCode ?? "internal"); }
  }
  function progress(r, counts) {
    if (r.finished || r.finishing) return;
    if (!validCounts(counts)) return fail(r, "internal");
    r.counts = structuredClone(counts);
    if (!r.countTimer) r.countTimer = setTimeout(() => { r.countTimer = null; if (!r.finishing) state(r, r.state); }, 1000);
  }
  async function clearSession(ses) {
    for (const name of ["clearStorageData", "clearCache", "clearAuthCache", "closeAllConnections"]) {
      try { await bounded(Promise.resolve().then(() => ses[name]()), 800); } catch (err) { log("warn", err.message); }
    }
  }
  async function closeContents(contents) {
    if (!contents || contents.isDestroyed()) return;
    try { if (contents.debugger.isAttached()) contents.debugger.detach(); } catch {}
    try {
      await bounded(new Promise((resolve) => { contents.once("destroyed", resolve); contents.close({ waitForBeforeUnload: false }); }), 800);
    } catch (err) { log("warn", err.message); }
    if (!contents.isDestroyed()) throw new Error("Verify contents survived teardown");
  }
  async function retirePages(r) {
    for (const remove of r.listeners.splice(0)) remove();
    await Promise.all(tiles.map(async (tile) => {
      const page = r.pages[tile];
      if (!page) return;
      try { r.win?.contentView.removeChildView(page.view); } catch {}
      await closeContents(page.view.webContents);
      try { await bounded(Promise.resolve().then(() => page.guard?.close()), 1000); } catch (err) { log("warn", err.message); }
      await clearSession(page.session);
      delete r.pages[tile];
    }));
    r.fonts?.close();
    try { await bounded(Promise.resolve().then(() => r.server?.close()), 1000); } catch (err) { log("warn", err.message); }
    r.server = null;
  }
  async function closeWall(r) {
    if (wallOwner === r) wallOwner = null;
    const wall = r.wall; r.wall = null;
    if (wall) {
      try { r.win.contentView.removeChildView(wall); } catch {}
      await closeContents(wall.webContents);
      try { await bounded(Promise.resolve().then(() => r.wallGuard?.close())); } catch (err) { log("warn", err.message); }
      await clearSession(r.wallSession);
    }
    if (r.finished && r.win && !r.win.isDestroyed()) r.win.destroy();
    if (r.finished) records.delete(r.input.runId);
  }
  function blockedResult(r) {
    return { v: 1, runId: r.input.runId, site: r.input.site, counts: r.counts ?? zero(), issues: [], issueTotal: 0, durationMs: Math.round(epoch() - r.started), errorCode: r.forced ?? "internal" };
  }
  async function finalFrames(r) {
    const frames = {};
    let total = 0;
    for (const tile of tiles) {
      const page = r.pages[tile]?.view.webContents;
      if (!page || page.isDestroyed()) continue;
      try {
        const image = await bounded(page.capturePage(), 700);
        const png = image.toPNG();
        if (!png.length || total + png.length > 6 * 1024 * 1024) continue;
        total += png.length;
        frames[tile] = `data:image/png;base64,${png.toString("base64")}`;
      } catch (err) { log("warn", err.message); }
    }
    return frames;
  }
  function finish(r, supplied) {
    if (r.finishPromise) return r.finishPromise;
    r.finishing = true;
    clearTimeout(r.deadline); clearTimeout(r.countTimer);
    r.finishPromise = (async () => {
      await r.prepared;
      let result = supplied;
      if (!validResult(result) || result.runId !== r.input.runId || result.site !== r.input.site) { r.forced ??= "internal"; result = null; }
      if (r.forced || !result) result = blockedResult(r);
      if (!result.errorCode && r.server && !await bounded(r.server.revisionUnchanged()).catch(() => false)) result = { ...result, errorCode: "site-changed" };
      const frames = r.wall && r.watching ? await finalFrames(r) : null;
      try { await retirePages(r); }
      catch { send({ type: "fatal", reason: "Site teardown failed" }); return; }
      r.counts = result.counts;
      if (frames) r.snapshot.finalFrames = frames;
      const ev = { kind: "end", seq: r.end?.seq ?? r.snapshot.lastSeq + 1, emittedAt: Math.max(epoch(), r.lastTime + 0.001), result, ...(frames ? { finalFrames: frames } : {}) };
      try { admit(r, ev, false); }
      catch {
        result = { ...result, errorCode: "resource-limit" };
        r.snapshot.result = result;
        const end = { ...ev, seq: r.snapshot.lastSeq + 1, result };
        admit(r, end, false);
      }
      r.finished = true;
      if (active === r) active = null;
      state(r, result.errorCode ? "blocked" : "completed", result);
      if (!r.wall || !r.watching) await closeWall(r);
      idle();
    })().catch(async (err) => {
      log("error", err.message);
      r.forced = "internal";
      await retirePages(r);
      r.finished = true;
      if (active === r) active = null;
      state(r, "blocked", blockedResult(r));
      await closeWall(r); idle();
    });
    return r.finishPromise;
  }
  function layout(r) {
    if (!r?.win || r.win.isDestroyed()) return null;
    const [width, height] = r.win.getContentSize();
    return { content: { width, height }, bounds: r.win.getContentBounds(), tiles: Object.fromEntries(tiles.filter((t) => r.pages[t]).map((tile) => [tile, r.pages[tile].view.getBounds()])), scaleFactor: d.screen.getDisplayMatching(r.win.getBounds()).scaleFactor, handle: r.win.getNativeWindowHandle().toString("hex") };
  }
  function resize(r) {
    if (!r.win || r.win.isDestroyed()) return;
    const [w, h] = r.win.getContentSize();
    for (const tile of tiles) {
      const rect = tileRect(tile, w, h);
      r.pages[tile]?.view.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    }
    r.wall?.setBounds({ x: 0, y: 0, width: w, height: h });
    try { r.handle?.rescale(); } catch { fail(r, "internal"); }
  }
  function trusted(event) {
    const r = wallOwner;
    const contents = r?.wall?.webContents;
    return contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === stageUrl && contents.getURL() === stageUrl ? r : null;
  }
  function installIpc() {
    if (ipcInstalled) return;
    ipcInstalled = true;
    d.ipcMain.handle(VERIFY_IPC.ready, (event, ...args) => {
      const r = trusted(event);
      if (!r || args.length) throw new Error("Untrusted verify wall");
      if (probe) send({ type: "timing", runId: r.input.runId, name: "first-wall-frame", epochMs: epoch() });
      return snapshot(r);
    });
    d.ipcMain.on(VERIFY_IPC.mute, safe((event, value) => {
      const r = trusted(event);
      if (!r || !value || Object.keys(value).join() !== "muted" || typeof value.muted !== "boolean") return;
      r.snapshot.muted = value.muted;
      send({ type: "muted", muted: value.muted });
    }));
    d.ipcMain.on(VERIFY_IPC.close, safe(async (event, ...args) => {
      const r = trusted(event);
      if (!r || args.length) return;
      unwatch(r);
      await closeWall(r); idle();
    }));
  }
  async function watch(r, frame) {
    r.snapshot.locale = frame.locale; r.snapshot.muted = frame.muted;
    if (wallOwner && wallOwner !== r) await closeWall(wallOwner);
    if (!r.wall) {
      installIpc();
      r.wallSession = d.session.fromPartition(`verify-wall:${r.input.runId}`, { cache: false });
      r.wall = new d.WebContentsView({ webPreferences: { ...VERIFY_PAGE_PREFERENCES, session: r.wallSession, preload, autoplayPolicy: "no-user-gesture-required" } });
      wallOwner = r;
      r.wall.setBackgroundColor("#00000000");
      r.win.contentView.addChildView(r.wall);
      r.wallGuard = await bounded(d.isolateWall(r.wallSession, r.wall.webContents, stageUrl));
      let crashes = 0;
      r.wall.webContents.on("render-process-gone", safe(async () => {
        if (crashes++ === 0) { try { await bounded(r.wall.webContents.loadURL(stageUrl)); return; } catch {} }
        unwatch(r); await closeWall(r); idle();
      }));
      await bounded(r.wall.webContents.loadURL(stageUrl));
    }
    r.watching = true;
    revealVerifyWindow(r.win, frame.display, probe);
    resize(r);
  }
  async function run(r) {
    try {
      const serving = d.startSiteServer({ root: r.input.root, entry: r.input.entry, revision: r.input.revision, site: r.input.site });
      void serving.then((server) => { if (r.preparationClosed) return server.close(); }).catch(() => {});
      r.server = await bounded(serving);
      if (r.abort.signal.aborted) return;
      r.fonts = createVerifyFonts({ fontUrls: r.server.fontUrls, logLookup: (name) => { if (probe) lookups.add(name); } });
      const options = { width: 1280, height: 720, minWidth: 960, minHeight: 540, show: false, opacity: 0, x: -32000, y: -32000, skipTaskbar: true, focusable: false, backgroundColor: "#080910", title: verifyCopy(r.input.locale, "title", r.input.site), icon };
      r.win = new d.BaseWindow(probe ? verifyProbeWindowOptions(options) : options);
      if (probe) guardVerifyProbeWindow(r.win);
      r.win.setAppDetails({ appId: windowsAppUserModelId({ packaged: d.app.isPackaged }), appIconPath: process.execPath, appIconIndex: 0, ...(d.app.isPackaged ? { relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: "Wink" } : {}) });
      r.win.setIgnoreMouseEvents(true);
      r.win.on("resize", safe(() => resize(r)));
      r.win.on("close", safe((event) => {
        event.preventDefault(); unwatch(r);
        void closeWall(r).then(idle);
      }));
      for (const tile of tiles) {
        const ses = d.session.fromPartition(`verify:${r.input.runId}:${tile}`, { cache: false });
        const view = new d.WebContentsView({ webPreferences: { ...VERIFY_PAGE_PREFERENCES, session: ses } });
        r.pages[tile] = { view, session: ses };
        view.webContents.setAudioMuted(true);
        r.win.contentView.addChildView(view);
        await bounded(view.webContents.loadURL("about:blank"));
        if (r.abort.signal.aborted) return;
        try { await bounded(ses.resolveHost(`verify-canary-${r.input.runId}-${tile}.localhost`)); throw new Error("Canary resolved"); }
        catch (err) { if (err.message === "Canary resolved" || err.message === "Verify operation timeout") throw Object.assign(err, { errorCode: "isolation-failed" }); }
        const guarding = d.isolatePage(ses, view.webContents, { origin: r.server.origin, fontUrls: r.server.fontUrls, fonts: r.fonts });
        void guarding.then((guard) => { if (r.preparationClosed && !r.pages[tile]) return guard.close(); }).catch(() => {});
        r.pages[tile].guard = await bounded(guarding);
        if (r.abort.signal.aborted) return;
        listen(r, view.webContents, "render-process-gone", () => fail(r, "page-failed"));
        listen(r, view.webContents, "unresponsive", () => fail(r, "page-failed"));
      }
      resize(r);
      if (r.input.watch) r.win.showInactive();
      if (r.input.watch) await watch(r, r.input);
      r.prepareDone();
      if (r.abort.signal.aborted) return;
      r.handle = d.runVerify({ hidden: !r.input.watch, runId: r.input.runId, site: r.input.site, url: r.server.url, pages: Object.fromEntries(tiles.map((tile) => [tile, r.pages[tile].view.webContents])), scale: (tile) => { const [w, h] = r.win.getContentSize(); return tileRect(tile, w, h).scale; }, ...(r.input.recording === false ? {} : { frame: (frame) => { if (!r.finishing) send({ type: "cast", runId: r.input.runId, ...frame }); } }), emit: (ev) => emit(r, ev), progress: (c) => progress(r, c), blockedUrls: () => tiles.flatMap((tile) => r.pages[tile]?.guard?.blockedUrls() ?? []), revisionUnchanged: r.server.revisionUnchanged, signal: r.abort.signal, ...(probe ? { onTiming: (name, epochMs) => send({ type: "timing", runId: r.input.runId, name, epochMs }) } : {}) });
      const result = await r.handle.done;
      await finish(r, result);
    } catch (err) { fail(r, err.errorCode ?? "internal"); }
    finally { r.preparationClosed = true; r.prepareDone(); if (r.abort.signal.aborted && !r.finishPromise) await finish(r); }
  }
  async function query(q) {
    const name = typeof q === "string" ? q : q.name;
    if (name === "metrics") return d.app.getAppMetrics();
    if (name === "lookups") return [...lookups];
    if (name === "counts") {
      const all = [...records.values()];
      const guards = all.flatMap((r) => Object.values(r.pages).map((p) => p.guard?.counts?.() ?? {}));
      return { pages: all.reduce((n, r) => n + Object.keys(r.pages).length, 0), listeners: all.reduce((n, r) => n + r.listeners.length, 0), sockets: guards.reduce((n, c) => n + (c.sockets ?? 0), 0) + all.reduce((n, r) => n + (r.server?.counts?.().sockets ?? 0), 0), servers: guards.reduce((n, c) => n + (c.servers ?? 0), 0) + all.filter((r) => r.server).length };
    }
    const r = active ?? wallOwner;
    if (name === "resize") { if (r?.win) { r.win.setContentSize(q.width, q.height); resize(r); } return layout(r); }
    if (name === "stall") { const end = Date.now() + q.ms; while (Date.now() < end) {} return { stalled: q.ms }; }
    if (name === "layout") {
      const result = layout(r);
      if (!result) return null;
      const folder = path.join(probe.root, "probe"); await fs.mkdir(folder, { recursive: true });
      result.captures = {};
      for (const [tile, page] of Object.entries(r.pages)) {
        const image = await bounded(page.view.webContents.capturePage());
        const file = path.join(folder, `${r.input.runId}-${tile}.png`);
        await fs.writeFile(file, image.toPNG()); result.captures[tile] = file;
      }
      return result;
    }
  }
  async function handle(frame) {
    if (closing) return;
    if (frame.type === "start") {
      if (active) { send({ type: "rejected", runId: frame.runId, error: "busy" }); return; }
      if (frame.watch && !probe) { send({ type: "rejected", runId: frame.runId, error: "internal" }); idle(); return; }
      const r = { input: frame, started: epoch(), state: "preparing", pages: {}, listeners: [], abort: new AbortController(), counts: null, lastTime: 0, watching: false, snapshot: { runId: frame.runId, site: frame.site, muted: frame.muted, locale: frame.locale, lastSeq: 0, clock: null, scan: null, score: null, events: [], result: null } };
      r.prepared = new Promise((resolve) => { r.prepareDone = resolve; });
      active = r; records.set(frame.runId, r);
      send({ type: "accepted", runId: frame.runId }); state(r, "preparing");
      r.deadline = setTimeout(() => fail(r, "timeout"), VERIFY_RUN_MS);
      void run(r);
    } else if (frame.type === "watch") {
      const r = records.get(frame.runId);
      if (r && !r.win) await bounded(r.prepared, 4000).catch(() => {});
      if (!r?.win || r.finished && !r.wall) { send({ type: "unknown", runId: frame.runId }); return; }
      try { await watch(r, frame); send({ type: "shown", runId: frame.runId }); }
      catch (err) { log("error", err.message); unwatch(r); await closeWall(r); send({ type: "unknown", runId: frame.runId }); }
    } else if (frame.type === "cancel") {
      const r = records.get(frame.runId);
      const cancelled = !!r && !r.finished;
      send({ type: "cancelled", runId: frame.runId, cancelled });
      if (cancelled) fail(r, "cancelled");
    } else if (frame.type === "probe" && probe) {
      try { send({ type: "probe", q: frame.q, data: await bounded(query(frame.q), 4500) }); }
      catch (err) { send({ type: "probe", q: frame.q, data: { error: err.message } }); }
    }
  }
  function close() {
    return closing ??= (async () => {
      for (const r of records.values()) { r.forced = "cancelled"; r.abort.abort(); }
      await Promise.all([...records.values()].map(async (r) => { if (!r.finished) await finish(r); await closeWall(r); }));
      if (ipcInstalled) { d.ipcMain.removeHandler(VERIFY_IPC.ready); d.ipcMain.removeAllListeners(VERIFY_IPC.mute); d.ipcMain.removeAllListeners(VERIFY_IPC.close); }
    })();
  }
  return { handle, close };
}
