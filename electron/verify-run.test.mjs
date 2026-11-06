import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = { readers: null, fit: null, cdps: [], events: [], fail: null, prep: null, hover: null, extraPlan: null, cameras: [], opened: false, commandError: null, skipContrast: false };

import { runVerify } from "./verify-run.mjs";
import { VERIFY_BAR_MS, VERIFY_BARS, VERIFY_FINALIZE_BAR } from "./verify-protocol.mjs";

function input() {
  const page = tile => {
    const wc = new EventEmitter(), debuggerApi = new EventEmitter();
    const box = { x: 0, y: 0, w: 100, h: 24 };
    const block = { path: "p", tag: "p", text: "Recorded text", size: 16, weight: 400, box };
    let reading = false;
    const send = vi.fn(async (method, params) => {
      if (method === fake.commandError) throw new Error("Unsupported command");
      if (method.startsWith("Input.")) expect(fake.cameras.findLast(c => c.tile === tile).state.suspended).toBe(true);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: tile } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: tile === "desktop" ? 1 : 2 };
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.resolveNode") return { object: { objectId: "button" } };
      if (method === "DOMDebugger.getEventListeners") return { listeners: [{ type: "click" }] };
      if (method === "CSS.getPlatformFontsForNode") return { fonts: [{ familyName: "Fallback", glyphCount: 12 }] };
      if (method !== "Runtime.evaluate") return {};
      const expression = params.expression.split(" const value = await (").at(-1).split("); const json =")[0];
      const prep = { map: [], blocks: [block], heads: [], links: [], btns: [], inputs: [], navBottom: 0, docH: 720, ...fake.prep };
      let value = 0;
      if (expression === "lv.map()") value = prep.map;
      else if (expression === "lv.blocks()") value = tile === "phone" ? [] : fake.extraPlan?.map(j => ({ ...block, path: j.path })) ?? prep.blocks;
      else if (expression === "lv.headings()") value = prep.heads;
      else if (expression === "lv.links()") value = prep.links;
      else if (expression === "lv.buttons()") value = prep.btns;
      else if (expression === "lv.inputs()") value = prep.inputs;
      else if (expression === "document.documentElement.scrollHeight") value = prep.docH;
      else if (expression === "getComputedStyle(document.body).fontFamily") value = "WebFont";
      else if (expression.includes("document.fonts.ready.then(() => [...")) {
        if (fake.fail) return { exceptionDetails: { text: fake.fail } };
        value = [];
      } else if (expression.startsWith("lv.text(")) {
        if (!reading) { reading = true; await fake.readers?.(); }
        value = { ...block, ok: true, chars: 12, lines: 1 };
      } else if (expression.startsWith("lv.contrast(")) value = fake.skipContrast ? { skip: true } : { ratio: 21, need: 4.5, ok: true };
      else if (expression === "lv.fit()") {
        await fake.fit?.();
        value = { width: 392, scrollWidth: 392, innerWidth: 392, docHeight: 800, over: [], taps: [] };
      } else if (expression.startsWith("lv.lift(")) {
        await fake.hover?.();
        value = { color: "rgb(0, 0, 0)" };
      } else if (expression.startsWith("lv.opened(")) value = { open: fake.opened, box, path: "toast", text: "Opened", tag: "div.toast" };
      else if (expression.startsWith("lv.still(")) value = true;
      else if (expression === "lv.snap()") value = [];
      else if (expression.includes("lvCameraState")) {
        const state = JSON.parse(expression.split("Object.assign(globalThis.lvCameraState, ")[1].split(");")[0]);
        fake.cameras.push({ tile, state });
      }
      return { result: { value } };
    });
    debuggerApi.attach = vi.fn();
    debuggerApi.detach = vi.fn();
    debuggerApi.sendCommand = send;
    fake.cdps.push({ send, close: debuggerApi.detach });
    return Object.assign(wc, { debugger: debuggerApi, loadURL: vi.fn(async () => {}), isDestroyed: () => false });
  };
  const controller = new AbortController();
  return { runId: "fixture-run", site: "fixture", url: "http://127.0.0.1:1234/index.html", pages: { desktop: page("desktop"), phone: page("phone") }, scale: () => 0.65, emit: e => fake.events.push(e), progress: vi.fn(), blockedUrls: () => ["https://fonts.googleapis.com/css2?family=WebFont"], revisionUnchanged: vi.fn(async () => true), signal: controller.signal, controller };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  Object.assign(fake, { readers: null, fit: null, fail: null, events: [], cdps: [], prep: null, hover: null, extraPlan: null, cameras: [], opened: false, commandError: null, skipContrast: false });
});
afterEach(() => vi.useRealTimers());

describe("verify runner", () => {
  it("holds the scan, finalizes at bar 12, ends after bar 16 and counts blocked/notRun honestly", async () => {
    fake.readers = () => new Promise(r => setTimeout(r, VERIFY_BAR_MS * 2.5));
    const args = input(), run = runVerify(args);
    await vi.advanceTimersByTimeAsync(45_000);
    const result = await run.done;
    const kinds = fake.events.map(e => e.kind);
    expect(kinds[0]).toBe("start");
    expect(kinds.indexOf("hold")).toBeGreaterThan(0);
    expect(kinds.indexOf("load")).toBeGreaterThan(kinds.lastIndexOf("hold"));
    expect(kinds.slice(-2)).toEqual(["finalize", "end"]);
    expect(fake.events.find(e => e.kind === "finalize").t).toBeCloseTo((VERIFY_FINALIZE_BAR - 1) * VERIFY_BAR_MS, 4);
    const load = fake.events.find(e => e.kind === "load");
    expect(load.clock.holds).toBeGreaterThan(0);
    expect(fake.events.at(-1).emittedAt - load.clock.t0 - load.clock.holds * VERIFY_BAR_MS).toBeCloseTo(VERIFY_BARS * VERIFY_BAR_MS, 0);
    expect(result.counts).toEqual({ planned: 5, completed: 5, passed: 4, failed: 0, blocked: 1, notRun: 0 });
    expect(args.revisionUnchanged).toHaveBeenCalledTimes(1);
    expect(fake.events.map(e => e.seq)).toEqual(fake.events.map((_, i) => i + 1));
    expect(fake.cdps.every(c => c.close.mock.calls.length === 1)).toBe(true);
  });

  it.each([false, "throw"])("returns site-changed before any normal finalize when revision validation is %s", async value => {
    const args = input();
    args.revisionUnchanged = vi.fn(async () => { if (value === "throw") throw new Error("changed"); return value; });
    const run = runVerify(args);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await run.done).errorCode).toBe("site-changed");
    expect(fake.events.some(e => e.kind === "finalize")).toBe(false);
    expect(args.revisionUnchanged).toHaveBeenCalledTimes(1);
  });

  it.each(["page-failed", "resource-limit"])("done resolves partial coverage on %s", async code => {
    fake.fail = code;
    const run = runVerify(input());
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await run.done).errorCode).toBe(code);
  });

  it("resolves page-failed for a hung command and cancelled for abort", async () => {
    const args = input();
    fake.readers = () => new Promise(() => {});
    fake.fit = () => new Promise(() => {});
    const run = runVerify(args);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await run.done).errorCode).toBe("page-failed");
    const next = input(), aborted = runVerify(next);
    next.controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect((await aborted.done).errorCode).toBe("cancelled");
  });

  it("reapplies fixed metrics when resized and reports crashes without rejection", async () => {
    const args = input(), run = runVerify(args);
    await vi.advanceTimersByTimeAsync(1_000);
    run.rescale();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.cdps[0].send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", expect.objectContaining({ width: 1280, height: 720, deviceScaleFactor: 1 }));
    expect(fake.cdps[1].send).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", expect.objectContaining({ width: 392, height: 800, deviceScaleFactor: 2, mobile: true }));
    args.pages.desktop.emit("render-process-gone", {}, { reason: "crashed" });
    await vi.advanceTimersByTimeAsync(1);
    expect((await run.done).errorCode).toBe("page-failed");
  });

  it("retires pending live observations at cutoff without changing frozen counts", async () => {
    fake.prep = { map: [], blocks: [], heads: [], links: [], btns: [{ path: "button", name: "Open", w: 44, h: 44, box: { x: 0, y: 0, w: 44, h: 44 } }], inputs: [], navBottom: 0, docH: 720 };
    fake.hover = () => new Promise(r => setTimeout(r, 3500));
    const run = runVerify(input());
    await vi.advanceTimersByTimeAsync(24_000);
    const result = await run.done, snapshot = JSON.stringify(result);
    expect(result.counts.notRun).toBe(3);
    expect(result.counts.completed).toBe(2);
    expect(fake.events.some(e => e.kind === "point")).toBe(true);
    const eventCount = fake.events.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(fake.events).toHaveLength(eventCount);
    expect(fake.events.filter(e => e.kind === "result").map(e => e.ev.result)).toEqual(["skip", "skip", "skip"]);
  });

  it("fails honestly before serializing an oversized admitted plan", async () => {
    fake.extraPlan = Array.from({ length: 2000 }, (_, i) => ({ checker: "TEXT_A", tile: "desktop", kind: "text", path: `p${i}`.padEnd(120, "x"), stop: 0 }));
    const run = runVerify(input());
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await run.done;
    expect(result.errorCode).toBe("resource-limit");
    expect(result.counts.planned).toBe(result.counts.completed + result.counts.notRun);
    expect(fake.events.some(e => e.kind === "load")).toBe(false);
  });

  it("bounds preparation separately from the 60-second deadline", async () => {
    const args = input();
    args.pages.phone.loadURL = () => new Promise(() => {});
    const run = runVerify(args);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await run.done).errorCode).toBe("page-failed");
    expect(fake.events.some(e => e.kind === "start")).toBe(false);
  });

  it("keeps the run deadline around revision validation", async () => {
    const args = input();
    args.revisionUnchanged = vi.fn(() => new Promise(() => {}));
    const run = runVerify(args);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await run.done).errorCode).toBe("timeout");
    expect(args.revisionUnchanged).toHaveBeenCalledTimes(1);
    expect(fake.events.some(e => e.kind === "finalize")).toBe(false);
  });

  it("installs interception before navigation and fails closed if unsupported", async () => {
    fake.commandError = "Page.setInterceptFileChooserDialog";
    const args = input(), run = runVerify(args);
    await vi.advanceTimersByTimeAsync(1);
    expect((await run.done).errorCode).toBe("isolation-failed");
    expect(args.pages.desktop.loadURL).not.toHaveBeenCalled();
    expect(args.pages.phone.loadURL).not.toHaveBeenCalled();
  });

  it("keeps cameras suspended for readers and live inputs, then freezes at cutoff", async () => {
    fake.prep = { btns: [{ path: "button", name: "Open", w: 44, h: 44, tabIndex: 0, box: { x: 0, y: 0, w: 44, h: 44 } }] };
    fake.opened = true;
    fake.readers = async () => expect(fake.cameras.every(c => c.state.suspended)).toBe(true);
    const args = input(), run = runVerify(args);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await run.done, kinds = fake.events.map(e => e.kind);
    expect(result.errorCode).toBeUndefined();
    expect(kinds.indexOf("point")).toBeGreaterThan(kinds.indexOf("load"));
    expect(kinds.indexOf("opened")).toBeGreaterThan(kinds.indexOf("point"));
    expect(kinds.indexOf("finalize")).toBeGreaterThan(kinds.lastIndexOf("result"));
    expect(kinds.at(-1)).toBe("end");
    expect(result.counts.planned).toBe(result.counts.completed + result.counts.notRun);
    expect(result.counts.completed).toBe(result.counts.passed + result.counts.failed + result.counts.blocked);
    expect(fake.cameras.some(c => !c.state.suspended)).toBe(true);
    expect(args.pages.desktop.debugger.listenerCount("message")).toBe(0);
    expect(args.pages.desktop.listenerCount("did-finish-load")).toBe(0);
  });

  it("maps page targets into the emulated view while preserving wall coordinates", async () => {
    fake.prep = { btns: [{ path: "button", name: "Open", w: 44, h: 44, tabIndex: 0, pin: true, box: { x: 20, y: 40, w: 44, h: 44 } }] };
    const run = runVerify(input());
    await vi.advanceTimersByTimeAsync(30_000);
    await run.done;
    const point = fake.events.find(e => e.kind === "point" && e.inp.type === "move");
    expect(point.inp).toMatchObject({ x: 42, y: 62 });
    expect(fake.cdps[0].send).toHaveBeenCalledWith("Input.dispatchMouseEvent", { type: "mouseMoved", x: 42 * 0.65, y: 62 * 0.65 });
  });

  it("retains skipped contrast coverage as notRun without turning it into a pass", async () => {
    fake.skipContrast = true;
    const run = runVerify(input());
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await run.done;
    expect(result.errorCode).toBeUndefined();
    expect(result.counts).toEqual({ planned: 5, completed: 4, passed: 3, failed: 0, blocked: 1, notRun: 1 });
  });
});
