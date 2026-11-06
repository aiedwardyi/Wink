import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BaseWindow: {}, ipcMain: {}, screen: {}, session: {}, WebContentsView: {} }));
import { createVerifyChildHost, revealVerifyWindow, VERIFY_RENDER_MODE } from "./verify-child-host.mjs";
import { tileRect, VERIFY_IPC } from "./verify-protocol.mjs";
import { verifyCopy } from "./verify-copy.mjs";

const hosts = [], roots = [];
afterEach(async () => { vi.useRealTimers(); for (const h of hosts.splice(0)) await h.close(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const counts = { planned: 1, completed: 1, passed: 1, failed: 0, blocked: 0, notRun: 0 };
const start = (watch = false) => ({ type: "start", runId: "run-123456", botId: "bot-1", root: "C:\\site", entry: "index.html", revision: "a".repeat(64), site: "site", watch, locale: "ko", muted: true, display: { x: 0, y: 0, width: 1920, height: 1080 } });
const result = () => ({ v: 1, runId: start().runId, site: "site", counts, issues: [], issueTotal: 0, durationMs: 1 });
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await delay(5); } throw new Error("Host fixture did not settle"); }

function fixture({ probe = true, packaged = false, resolves = false } = {}) {
  const scratch = path.join(os.tmpdir(), "wink-lv0-host"); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "child-host-test-")); roots.push(root);
  const frames = [], contents = [], windows = [], sessions = [], calls = [];
  const ipc = Object.assign(new EventEmitter(), { handlers: new Map(), handle(key, fn) { this.handlers.set(key, fn); }, removeHandler(key) { this.handlers.delete(key); } });
  let runInput, resolveRun;
  class Contents extends EventEmitter {
    constructor(options) { super(); this.options = options; this.dead = false; this.mainFrame = { url: "" }; this.debugger = { isAttached: () => false }; contents.push(this); }
    setAudioMuted(value) { calls.push(["audio", value]); }
    async loadURL(url) { this.url = url; this.mainFrame.url = url; }
    getURL() { return this.url; }
    isDestroyed() { return this.dead; }
    close(options) { this.dead = true; calls.push(["close", options]); this.emit("destroyed"); }
    send(channel, event) { calls.push(["event", channel, event]); }
    async capturePage() { return { toPNG: () => Buffer.from("png") }; }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(options); }
    setBounds(bounds) { this.bounds = bounds; } getBounds() { return this.bounds; } setBackgroundColor(value) { calls.push(["background", value]); }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; this.contentView = { addChildView() {}, removeChildView() {} }; windows.push(this); }
    setBounds(b) { this.bounds = b; this.emit("resize"); } getBounds() { return this.bounds; } getContentBounds() { return this.bounds; }
    getContentSize() { return [this.bounds.width, this.bounds.height]; } setContentSize(width, height) { this.setBounds({ ...this.bounds, width, height }); }
    getNativeWindowHandle() { return Buffer.from([1, 2]); }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    isDestroyed() { return this.dead; } destroy() { this.dead = true; } hide() { calls.push(["hide"]); }
  }
  for (const name of ["setOpacity", "setFocusable", "setSkipTaskbar", "setIgnoreMouseEvents", "setAlwaysOnTop", "show", "showInactive", "focus", "moveTop", "restore", "setAppDetails"]) Window.prototype[name] = (...args) => calls.push([name, ...args]);
  const dependencies = {
    app: { isPackaged: packaged, getAppMetrics: () => [{ pid: 1 }] }, BaseWindow: Window, WebContentsView: View, ipcMain: ipc,
    screen: { getDisplayMatching: () => ({ scaleFactor: 1.5 }) },
    session: { fromPartition(name) { const ses = { name, resolveHost: vi.fn(async () => { if (resolves) return {}; throw new Error("NOTFOUND"); }) }; for (const method of ["clearStorageData", "clearCache", "clearAuthCache", "closeAllConnections"]) ses[method] = vi.fn(async () => {}); sessions.push(ses); return ses; } },
    isolatePage: vi.fn(async () => ({ close: async () => {}, blockedUrls: () => [], counts: () => ({ sockets: 0, servers: 1 }) })),
    isolateWall: vi.fn(async () => ({ close: async () => {} })),
    startSiteServer: vi.fn(async () => ({ origin: "http://127.0.0.1:12345", url: "http://127.0.0.1:12345/index.html", fontUrls: [], revisionUnchanged: async () => true, close: async () => {} })),
    runVerify(input) { runInput = input; return { done: new Promise((resolve) => { resolveRun = resolve; }), rescale: () => calls.push(["rescale"]) }; },
  };
  const host = createVerifyChildHost({ probe: probe ? { root } : null, send: (v) => frames.push(v), dependencies }); hosts.push(host);
  return { host, frames, contents, windows, sessions, calls, ipc, dependencies, input: () => runInput, finish: (value = result()) => resolveRun(value) };
}

it("runs the real hidden path outside probes and keeps native copy bilingual", async () => {
  const f = fixture({ probe: false }); await f.host.handle(start());
  await until(() => f.input());
  expect(f.input().hidden).toBe(true);
  expect(f.calls.some(c => ["show", "showInactive", "focus", "moveTop"].includes(c[0]))).toBe(false);
  f.finish(); await until(() => f.frames.some(v => v.state === "completed"));
  expect(verifyCopy("ko", "unavailable")).toMatch(/[가-힣]/);
});

it("attests both partitions before ENGINE and creates the inactive shape with taskbar identity", async () => {
  const f = fixture({ packaged: true }); await f.host.handle(start()); await until(() => f.input());
  expect(VERIFY_RENDER_MODE).toBe("inactive");
  expect(f.windows[0].options).toMatchObject({ opacity: 0, x: -32000, y: -32000, focusable: false, skipTaskbar: true, minWidth: 960, minHeight: 540 });
  expect(f.sessions.slice(0, 2).map((s) => s.resolveHost.mock.calls.length)).toEqual([1, 1]);
  expect(f.dependencies.isolatePage).toHaveBeenCalledTimes(2);
  expect(f.dependencies.isolatePage.mock.calls[0][2].fonts).toBe(f.dependencies.isolatePage.mock.calls[1][2].fonts);
  expect(f.input().revisionUnchanged).toBeTypeOf("function");
  expect(f.calls.find((c) => c[0] === "setAppDetails")[1]).toEqual({ appId: "com.orbit.agentdesk", appIconPath: process.execPath, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: "Wink" });
  await f.host.handle(start()); expect(f.frames.at(-1)).toMatchObject({ type: "rejected", error: "busy" });
});

it("a resolving partition canary blocks before ENGINE", async () => {
  const f = fixture({ resolves: true }); await f.host.handle(start()); await until(() => f.frames.some((v) => v.type === "idle"));
  expect(f.input()).toBeUndefined(); expect(f.frames.find((v) => v.type === "state" && v.result)?.errorCode).toBe("isolation-failed"); expect(f.contents.every((c) => c.dead)).toBe(true);
});

it("keeps final pixels and retires every page, session and server before terminal state", async () => {
  const f = fixture(); await f.host.handle(start(true)); await until(() => f.input());
  const wall = f.contents.at(-1); expect(wall.options.webPreferences.autoplayPolicy).toBe("no-user-gesture-required");
  f.input().emit({ kind: "start", seq: 1, emittedAt: 1, scan: {}, clock: { t0: 1, holds: 0 } });
  f.input().emit({ kind: "end", seq: 2, emittedAt: 2, result: result() }); f.finish();
  await until(() => f.frames.some((v) => v.state === "completed"));
  expect(f.contents.slice(0, 2).every((c) => c.dead)).toBe(true); expect(wall.dead).toBe(false);
  const snap = f.ipc.handlers.get(VERIFY_IPC.ready)({ sender: wall, senderFrame: wall.mainFrame });
  expect(snap.lastSeq).toBe(2); expect(snap.events.map((e) => e.kind)).toEqual(["start", "end"]); expect(snap.finalFrames.desktop).toMatch(/^data:image\/png/);
  for (const ses of f.sessions.slice(0, 2)) for (const method of ["clearStorageData", "clearCache", "clearAuthCache", "closeAllConnections"]) expect(ses[method]).toHaveBeenCalledTimes(1);
  expect(f.calls.filter((v) => v[0] === "close").every((v) => v[1].waitForBeforeUnload === false)).toBe(true);
  await f.host.handle({ type: "probe", q: "counts" }); expect(f.frames.at(-1).data).toMatchObject({ pages: 0, servers: 0, sockets: 0, listeners: 0 });
  f.ipc.emit(VERIFY_IPC.close, { sender: wall, senderFrame: wall.mainFrame }); await until(() => f.frames.at(-1).type === "idle");
});

it("rejects wrong contents/frame/URL/payload and snapshots events atomically", async () => {
  const f = fixture(); await f.host.handle(start(true)); await until(() => f.input());
  const wall = f.contents.at(-1), ready = f.ipc.handlers.get(VERIFY_IPC.ready);
  const event = { sender: wall, senderFrame: wall.mainFrame };
  expect(() => ready({ sender: f.contents[0], senderFrame: wall.mainFrame })).toThrow();
  expect(() => ready({ sender: wall, senderFrame: { url: wall.url } })).toThrow();
  f.ipc.emit(VERIFY_IPC.mute, event, { muted: false, extra: true }); expect(f.frames.some((v) => v.type === "muted")).toBe(false);
  f.ipc.emit(VERIFY_IPC.mute, event, { muted: false }); expect(ready(event).muted).toBe(false);
  f.input().emit({ kind: "point", seq: 1, emittedAt: 1, inp: {}, scrollY: 0 });
  expect(ready(event).lastSeq).toBe(1); expect(ready(event).events).toHaveLength(1);
  wall.mainFrame.url = "https://evil.invalid"; expect(() => ready(event)).toThrow();
});

it("resize probes use tileRect and rescale, while probe Watch cannot reveal", async () => {
  const f = fixture(); await f.host.handle(start()); await until(() => f.input());
  await f.host.handle({ type: "probe", q: { name: "resize", width: 1600, height: 900 } });
  const layout = f.frames.at(-1).data;
  for (const tile of ["desktop", "phone"]) { const r = tileRect(tile, 1600, 900); expect(layout.tiles[tile]).toEqual({ x: r.x, y: r.y, width: r.w, height: r.h }); }
  expect(f.calls).toContainEqual(["rescale"]);
  await f.host.handle({ type: "watch", runId: start().runId, locale: "en", muted: false, display: start().display });
  expect(f.calls.some((v) => ["show", "focus", "moveTop"].includes(v[0]))).toBe(false);
});

it.each(["cancel", "crash", "hang", "quit", "cap"])("cleans up on %s", async (kind) => {
  const f = fixture(); await f.host.handle(start()); await until(() => f.input());
  if (kind === "cancel") await f.host.handle({ type: "cancel", runId: start().runId });
  if (kind === "crash") f.contents[0].emit("render-process-gone", {}, {});
  if (kind === "hang") f.contents[1].emit("unresponsive");
  if (kind === "quit") await f.host.close();
  if (kind === "cap") f.input().emit({ kind: "load", seq: 1, emittedAt: 1, score: "x".repeat(1024 * 1024 + 1), clock: { t0: 1, holds: 0 } });
  await until(() => f.frames.some((v) => v.state === "blocked"));
  expect(f.contents.every((c) => c.dead)).toBe(true);
  expect(f.frames.find((v) => v.state === "blocked").errorCode).toBe(kind === "cap" ? "resource-limit" : ["crash", "hang"].includes(kind) ? "page-failed" : "cancelled");
});

it("production Watch uses the specified foreground lift order", () => {
  const calls = [], win = {};
  for (const name of ["setBounds", "setFocusable", "setSkipTaskbar", "setIgnoreMouseEvents", "setOpacity", "setAlwaysOnTop", "show", "moveTop", "focus"]) win[name] = (...args) => calls.push([name, ...args]);
  revealVerifyWindow(win, start().display, false);
  expect(calls.map((v) => v[0])).toEqual(["setBounds", "setFocusable", "setSkipTaskbar", "setIgnoreMouseEvents", "setOpacity", "setAlwaysOnTop", "show", "moveTop", "setAlwaysOnTop", "focus"]);
  expect(calls.slice(-5)).toEqual([["setAlwaysOnTop", true], ["show"], ["moveTop"], ["setAlwaysOnTop", false], ["focus"]]);
});

it("cancels during setup and closes late server resources", async () => {
  const f = fixture();
  const server = await f.dependencies.startSiteServer(); server.close = vi.fn(async () => {});
  let release; f.dependencies.startSiteServer.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  await f.host.handle(start()); await f.host.handle({ type: "cancel", runId: start().runId });
  release(server);
  await until(() => f.frames.some((v) => v.state === "blocked"));
  expect(f.windows).toHaveLength(0); expect(server.close).toHaveBeenCalledTimes(1);
});

it("closing Watch preserves inactive rendering and the run", async () => {
  const f = fixture(); await f.host.handle(start(true)); await until(() => f.input());
  const wall = f.contents.at(-1);
  f.calls.length = 0;
  f.ipc.emit(VERIFY_IPC.close, { sender: wall, senderFrame: wall.mainFrame });
  await until(() => wall.dead);
  expect(f.calls).toContainEqual(["showInactive"]); expect(f.input().signal.aborted).toBe(false);
  expect(f.contents.slice(0, 2).every((c) => !c.dead)).toBe(true);
  f.finish(); await until(() => f.frames.some((v) => v.type === "idle"));
});

it("bounds replay admission and reloads a crashed wall only once", async () => {
  const f = fixture(); await f.host.handle(start(true)); await until(() => f.input());
  const wall = f.contents.at(-1), reload = vi.spyOn(wall, "loadURL");
  wall.emit("render-process-gone"); await until(() => reload.mock.calls.length === 1);
  wall.emit("render-process-gone"); await until(() => wall.dead);
  for (let seq = 1; seq <= 2000; seq++) f.input().emit({ kind: "point", seq, emittedAt: seq, inp: {}, scrollY: 0 });
  await until(() => f.frames.some((v) => v.state === "blocked"));
  expect(f.frames.find((v) => v.state === "blocked").errorCode).toBe("resource-limit");
});
