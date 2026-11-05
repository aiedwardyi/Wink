import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { attach } from "./verify-cdp.mjs";
import { checks, world } from "./verify-checks.mjs";

const box = { x: 10, y: 10, w: 100, h: 24 };
const block = { path: "h1", tag: "h1", text: "Recorded heading", box, size: 24, weight: 700, pin: false };
function page({ width = 44, height = 44, clipped = false, sheet = false, button = {} } = {}) {
  const events = [], plan = [];
  const P = {
    tile: "desktop",
    fonts: async () => [{ familyName: "Fallback", glyphCount: 16 }],
    listeners: async () => ["click"],
    ev: async expression => {
      if (expression.includes("lv.text(")) return { ...block, ok: !clipped, clip: clipped && { px: 8 }, chars: 16, lines: 1 };
      if (expression === "lv.blocks()") return [block, { ...block, path: "p" }];
      if (expression === "lv.navBottom()") return 0;
      if (expression === "lv.headings()" || expression === "lv.links()") return [];
      if (expression === "lv.buttons()") return [{ path: "button", name: "Open", box, w: 24, h: 24, tabIndex: 0, ...button }];
      if (expression.includes("lv.contrast(")) return { ratio: 4.49, need: 4.5, ok: false };
      if (expression === "lv.fit()") return { width: 392, scrollWidth: 392, innerWidth: 392, docHeight: 800, over: [], taps: [{ path: "button", name: "Open", box, w: width, h: height, ok: width >= 44 && height >= 44 }] };
      if (expression.includes("document.fonts")) return [];
      return 0;
    },
  };
  const C = checks(e => { events.push(e); return e; }, jobs => plan.push(...jobs));
  return { C, P, events, plan, prep: { map: [], blocks: [block, { ...block, path: "p" }], heads: [], links: [], btns: [{ path: "button", box }], navBottom: 0, docH: 720, declared: "WebFont" }, blocked: sheet ? ["https://fonts.googleapis.com/css2?family=WebFont"] : [] };
}

describe("verify checks", () => {
  it("dedupes fonts by stop/weight/size and reserves blocked face coverage", async () => {
    const { C, P, prep, blocked, events, plan } = page({ sheet: true });
    await C.readers(P, prep, blocked);
    expect(events.filter(e => e.kind === "font")).toHaveLength(1);
    expect(events.find(e => e.kind === "font-face").result).toBe("blocked");
    expect(plan.filter(e => e.checker === "FONT")).toHaveLength(2);
    expect(events.filter(e => e.kind === "contrast").every(e => e.result === "issue")).toBe(true);
  });

  it.each([{ w: 23 }, { h: 23 }, { disabled: true }, { name: "" }, { tabIndex: -1 }])("keeps every BUTTONS criterion: %j", async button => {
    const { C, P, prep, events } = page({ button });
    await C.readers(P, prep, []);
    expect(events.find(e => e.checker === "BUTTONS").result).toBe("issue");
  });

  it("requires an actual click listener", async () => {
    const { C, P, prep, events } = page();
    P.listeners = async () => [];
    await C.readers(P, prep, []);
    expect(events.find(e => e.checker === "BUTTONS").result).toBe("issue");
  });

  it.each([43.9, 44])("keeps the 44px tap threshold and cut-text failures: %s", async width => {
    const { C, P, events } = page({ width, clipped: true });
    P.tile = "phone";
    await C.fit(P);
    expect(events.find(e => e.kind === "tap").result).toBe(width < 44 ? "issue" : "ok");
    expect(events.filter(e => e.kind === "cut").every(e => e.result === "issue")).toBe(true);
  });

  it("queries bounded roots and releases listener objects on failure", async () => {
    const send = vi.fn(async method => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.resolveNode") return { object: { objectId: "owned" } };
      if (method === "DOMDebugger.getEventListeners") throw new Error("lost page");
      return {};
    });
    const P = await world({ send, ev: async () => true, on: () => () => {} }, "desktop");
    await expect(P.listeners("button")).rejects.toThrow("lost page");
    expect(send).toHaveBeenCalledWith("DOM.getDocument", { depth: 0 });
    expect(send).toHaveBeenCalledWith("Runtime.releaseObject", { objectId: "owned" });
  });

  it("releases every listener function object after inspection", async () => {
    const send = vi.fn(async method => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
      if (method === "DOMDebugger.getEventListeners") return { listeners: [{ type: "click", handler: { objectId: "handler" }, originalHandler: { objectId: "original" } }] };
      return {};
    });
    const P = await world({ send, ev: async () => true, on: () => () => {} }, "desktop");
    expect(await P.listeners("button")).toEqual(["click"]);
    expect(send.mock.calls.filter(([m]) => m === "Runtime.releaseObject").map(([, p]) => p.objectId)).toEqual(["node", "handler", "original"]);
  });

  it("shares one bounded document root across parallel readers and refreshes after navigation", async () => {
    let document = 0;
    const handlers = new Map();
    const send = vi.fn(async (method, params) => {
      if (method === "DOM.getDocument") return { root: { nodeId: ++document * 10 } };
      if (method === "DOM.querySelector") {
        if (params.nodeId !== document * 10) throw new Error("stale document root");
        return { nodeId: params.nodeId + 1 };
      }
      if (method === "CSS.getPlatformFontsForNode") {
        if (params.nodeId !== document * 10 + 1) throw new Error("stale node id");
        return { fonts: [{ familyName: "Recorded" }] };
      }
      return {};
    });
    const P = await world({ send, ev: async () => true, on: (event, callback) => handlers.set(event, callback) }, "desktop");
    expect(await Promise.all([P.fonts("p"), P.fonts("h1")])).toEqual([[{ familyName: "Recorded" }], [{ familyName: "Recorded" }]]);
    expect(send.mock.calls.filter(([m]) => m === "DOM.getDocument")).toHaveLength(1);
    handlers.get("DOM.documentUpdated")();
    expect(await P.fonts("p")).toEqual([{ familyName: "Recorded" }]);
    expect(send.mock.calls.filter(([m]) => m === "DOM.getDocument")).toHaveLength(2);
  });

  it("finishes every first-stop job after the admission budget expires", async () => {
    const { C, P, prep, events, plan } = page();
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
    const evaluate = P.ev;
    P.ev = async expression => { if (expression.includes("lv.text(")) elapsed += 5000; return evaluate(expression); };
    prep.blocks = [block, { ...block, path: "later", box: { ...box, y: 1500 } }];
    prep.docH = 2500;
    try { await C.readers(P, prep, []); } finally { clock.mockRestore(); }
    expect(events.some(e => e.checker === "TEXT_A")).toBe(true);
    expect(events.some(e => e.checker === "BUTTONS")).toBe(true);
    expect(events.some(e => e.checker === "CONTRAST")).toBe(true);
    expect(events.some(e => e.checker === "TEXT_B")).toBe(false);
    expect(plan.some(e => e.path === "later")).toBe(true);
  });
});

describe("verify CDP lifetime", () => {
  function target(sendCommand) {
    const wc = new EventEmitter(), debuggerApi = new EventEmitter();
    debuggerApi.attach = vi.fn();
    debuggerApi.detach = () => debuggerApi.emit("detach", {}, "closed");
    debuggerApi.sendCommand = sendCommand;
    wc.debugger = debuggerApi;
    return wc;
  }

  it("retires timeout replies and rejects pending work on detach", async () => {
    let resolve;
    const wc = target(() => new Promise(r => resolve = r)), cdp = attach(wc);
    await expect(cdp.send("Page.enable", {}, { timeoutMs: 2 })).rejects.toMatchObject({ code: "page-failed" });
    resolve({ late: true });
    const pending = cdp.send("DOM.enable");
    const rejected = expect(pending).rejects.toMatchObject({ code: "page-failed" });
    cdp.close();
    await rejected;
    expect(wc.debugger.attach).toHaveBeenCalledWith("1.3");
  });

  it("rejects protocol evaluation exceptions and releases their object", async () => {
    const send = vi.fn(async method => method === "Runtime.evaluate" ? { exceptionDetails: { text: "boom", exception: { objectId: "exception" } } } : {});
    const cdp = attach(target(send));
    await expect(cdp.send("Runtime.evaluate")).rejects.toThrow("boom");
    expect(send).toHaveBeenCalledWith("Runtime.releaseObject", { objectId: "exception" });
    cdp.close();
  });

  it("releases a late resolved node and never dispatches work after close", async () => {
    let reply;
    const send = vi.fn(method => method === "DOM.resolveNode" ? new Promise(r => reply = r) : Promise.resolve({}));
    const cdp = attach(target(send));
    await expect(cdp.send("DOM.resolveNode", {}, { timeoutMs: 1 })).rejects.toThrow("timeout");
    reply({ object: { objectId: "late-node" } });
    await new Promise(resolve => setImmediate(resolve));
    expect(send).toHaveBeenCalledWith("Runtime.releaseObject", { objectId: "late-node" });
    const pending = cdp.send("Page.enable"), rejected = expect(pending).rejects.toThrow("detached");
    cdp.close();
    await rejected;
    expect(send.mock.calls.some(([m]) => m === "Page.enable")).toBe(false);
  });

  it("recreates isolated contexts after navigation and context clearing", async () => {
    let next = 10;
    const send = vi.fn(async method => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: next++ };
      return { result: { value: 42 } };
    });
    const wc = target(send), cdp = attach(wc);
    await expect(cdp.ev("21 * 2")).resolves.toBe(42);
    wc.debugger.emit("message", {}, "Runtime.executionContextsCleared", {});
    await cdp.ev("21 * 2");
    wc.debugger.emit("message", {}, "Page.frameNavigated", { frame: { id: "next" } });
    await cdp.ev("21 * 2");
    expect(send.mock.calls.filter(([m]) => m === "Runtime.evaluate").map(([, p]) => p.contextId)).toEqual([10, 11, 12]);
    expect(send.mock.calls.filter(([m]) => m === "Page.createIsolatedWorld").every(([, p]) => p.worldName === "lv")).toBe(true);
    cdp.close();
  });

  it("contains synchronous cleanup failures without losing the primary reply", async () => {
    const send = vi.fn(method => {
      if (method === "Runtime.releaseObject") throw new Error("detached during cleanup");
      return Promise.resolve({ result: { objectId: "remote" } });
    });
    const cdp = attach(target(send));
    try { await expect(cdp.send("Runtime.evaluate", {}, { timeoutMs: 5 })).resolves.toEqual({ result: { objectId: "remote" } }); }
    finally { cdp.close(); }
  });
});

function contrastProbe(source, { background = "none", clipped = false, decoration = false } = {}) {
  const rect = { left: 0, top: 0, right: 100, bottom: 24, width: 100, height: 24 };
  const style = { display: "block", visibility: "visible", opacity: "1", position: "static", pointerEvents: "auto", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", color: "rgb(0, 0, 0)", webkitTextFillColor: "rgb(0, 0, 0)", fontSize: "16px", fontWeight: "400", fontFamily: "Test", overflowX: "visible", overflowY: "visible" };
  const element = (localName, extra = {}) => ({ localName, tagName: localName.toUpperCase(), nodeType: 1, id: "", className: "", children: [], textContent: "", clientWidth: 100, clientHeight: 24, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => rect, contains(other) { return this === other; }, style: { ...style, ...extra } });
  const html = element("html", { backgroundColor: "rgb(255, 255, 255)" });
  const body = element("body"); body.parentElement = html;
  const paint = { backgroundImage: background };
  if (clipped) Object.assign(paint, { backgroundClip: "text", webkitTextFillColor: "rgba(0, 0, 0, 0)" });
  const p = element("p", paint);
  p.parentElement = body; p.id = "text"; p.textContent = "Contrast";
  const deco = element("div", { pointerEvents: "none", backgroundColor: "rgb(120, 120, 120)" }); deco.parentElement = body;
  const elements = decoration ? [p, deco] : [p];
  body.children = elements; body.querySelectorAll = () => elements;
  const node = { nodeValue: "Contrast", parentElement: p };
  const document = {
    body, documentElement: html, getElementsByTagName: () => [html, body, ...elements], querySelectorAll: () => elements,
    createTreeWalker: () => { let read = false; return { nextNode: () => read ? null : (read = true, node) }; },
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [rect] }),
    elementsFromPoint: () => [p, body, html], elementFromPoint: () => p,
  };
  const context = { document, NodeFilter: { SHOW_TEXT: 4 }, CSS: { escape: s => s }, getComputedStyle: el => el.style, scrollX: 0, scrollY: 0, innerWidth: 100, innerHeight: 100, addEventListener() {} };
  runInNewContext(source, context);
  context.lv.blocks();
  return JSON.parse(JSON.stringify(context.lv.contrast("#text")));
}
describe("verify contrast math", () => {
  const port = readFileSync(new URL("./verify/probe.js", import.meta.url), "utf8");
  const reference = readFileSync(new URL("../scripts/fixtures/verify/reference-probe.js", import.meta.url), "utf8");
  it.each([
    {},
    { background: "linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))" },
    { background: "radial-gradient(circle, rgba(0, 0, 0, 0.3), rgb(255, 255, 255))" },
    { background: "linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))", clipped: true },
    { decoration: true },
  ])("preserves pinned gradient and backdrop measurements: %j", options => {
    const actual = contrastProbe(port, options);
    expect(actual).toEqual(contrastProbe(reference, options));
    expect(actual.need).toBe(4.5);
    expect(Number.isFinite(actual.ratio)).toBe(true);
    if (!Object.keys(options).length) expect(actual.ratio).toBe(21);
  });
});

describe("verify DOM admission", () => {
  const source = readFileSync(new URL("./verify/probe.js", import.meta.url), "utf8");
  it("rejects excess mapped nodes before enumerating into main", () => {
    const context = { document: { getElementsByTagName: () => ({ length: 5001 }) }, addEventListener() {} };
    runInNewContext(source, context);
    expect(() => context.lv.map()).toThrow("resource-limit");
  });

  it("bounds the combined semantic targets across checker APIs", () => {
    const rect = { left: 0, top: 0, width: 100, height: 44 };
    const element = (tag, i) => ({ id: `${tag}${i}`, localName: tag, tagName: tag.toUpperCase(), nodeType: 1, className: "", textContent: "Target", getBoundingClientRect: () => rect, getAttribute: () => null, closest: () => null });
    const headings = Array.from({ length: 200 }, (_, i) => element("h1", i));
    const buttons = Array.from({ length: 101 }, (_, i) => element("button", i));
    const document = { documentElement: {}, getElementsByTagName: () => ({ length: 301 }), querySelectorAll: selector => selector.startsWith("h1") ? headings : buttons };
    const context = { document, CSS: { escape: s => s }, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }), scrollX: 0, scrollY: 0, addEventListener() {} };
    runInNewContext(source, context);
    expect(context.lv.headings()).toHaveLength(200);
    expect(() => context.lv.buttons()).toThrow("resource-limit");
  });
});
