import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ observations: [], failures: new Set(), commands: [], calls: [], events: {}, values: new Map(), targets: [] }));
vi.mock("./verify-cdp.mjs", () => ({ attach: page => ({
  async send(method, params) { f.commands.push(method); f.calls.push({ tile: page.tile, method, params }); },
  on(name, handler) { (f.events[page.tile] ??= {})[name] = handler; return () => {}; },
  async ev(expression) {
    if (expression.includes("document.fonts")) return true;
    if (expression.includes("!!document.querySelector")) return true;
    if (expression.includes("const { all, visible, where }")) return f.targets;
    if (expression.includes("const n = globalThis.lvWatchTargets")) return { x: 20, y: 30, scrollY: 40 };
    const rule = expression.includes('const rows = [], nodes') ? "details" : expression.includes('all("img[src]') ? "errors" : expression.includes('all("a[href]").filter(visible)') ? "links" : expression.includes("scrollWidth") ? "scroll" : expression.includes("const controls") ? "menu" : "copy";
    f.observations.push(`${page.tile}:${rule}`);
    if (f.failures.has(`${page.tile}:${rule}`)) throw new Error("Unsupported color or removed node");
    if (f.values.has(rule)) return structuredClone(f.values.get(rule));
    return { errors: { images: [] }, links: { links: [] }, scroll: { width: 392, scrollWidth: 392 }, menu: { links: [], menu: false }, copy: { texts: [] }, details: { rows: [] } }[rule];
  },
  close() {},
}) }));
import { runHiddenVerify } from "./verify-hidden.mjs";

afterEach(() => { vi.useRealTimers(); f.observations = []; f.failures.clear(); f.commands = []; f.calls = []; f.events = {}; f.values.clear(); f.targets = []; });
function input() {
  const aborter = new AbortController();
  const pages = Object.fromEntries(["desktop", "phone"].map(tile => [tile, Object.assign(new EventEmitter(), { tile, loadURL: vi.fn(async () => {}) })]));
  return { runId: "run-123456", site: "index.html", url: "http://127.0.0.1:1234/index.html", pages, hidden: true, signal: aborter.signal, aborter, emit: vi.fn(), progress: vi.fn(), blockedUrls: () => [], revisionUnchanged: vi.fn(async () => true) };
}

it.each([false, true])("keeps page visibility identical before load with recording=%s", async recording => {
  const i = input();
  if (recording) i.frame = vi.fn();
  for (const tile of ["desktop", "phone"]) i.pages[tile].loadURL = async () => {
    expect(f.calls.find(call => call.tile === tile && call.method === "Emulation.setFocusEmulationEnabled")).toMatchObject({ params: { enabled: true } });
  };
  expect((await runHiddenVerify(i).done).errorCode).toBeUndefined();
  expect(f.calls.filter(call => call.method === "Emulation.setFocusEmulationEnabled")).toHaveLength(2);
  expect(f.commands).not.toContain("Page.bringToFront");
});

it("finishes at full speed without timed show work or input", async () => {
  vi.useFakeTimers();
  const i = input(), result = await runHiddenVerify(i).done;
  expect(result.errorCode).toBeUndefined();
  expect(result.durationMs).toBe(0);
  expect(result.notChecked).toContain("form delivery");
  expect(f.commands.some(c => c.startsWith("Input."))).toBe(false);
  expect(i.emit.mock.calls.map(([event]) => event.kind)).toEqual(["start", "part", "part", "checks", "part", "end"]);
  expect(result.counts).toEqual({ planned: 1, completed: 1, passed: 1, failed: 0, blocked: 0, notRun: 0 });
});

it("contains independent failures on both tiles and continues remaining rules", async () => {
  f.failures.add("desktop:errors"); f.failures.add("phone:menu");
  const result = await runHiddenVerify(input()).done;
  expect(result.errorCode).toBeUndefined();
  expect(result.notChecked).toEqual(expect.arrayContaining(["page errors (desktop)", "phone menu (phone)"]));
  expect(result.counts).toMatchObject({ completed: 1, blocked: 0, notRun: 0 });
  expect(f.observations).toContain("phone:copy");
});

it("counts actual per-element trials, carries boxes and records every detail check", async () => {
  f.values.set("copy", { texts: [{ where: "p#unfinished", text: "undefined NaN", box: [1, 2, 30, 40], scrollY: 0 }] });
  f.values.set("details", { rows: [{ where: "button", rule: "tap size", measured: "20 x 20", bad: true, box: [5, 6, 20, 20], scrollY: 0 }] });
  const i = input(), result = await runHiddenVerify(i).done;
  expect(result.counts).toEqual({ planned: 13, completed: 13, passed: 7, failed: 6, blocked: 0, notRun: 0 });
  expect(result.issues).toHaveLength(2);
  expect(result.issues[0].box).toEqual([1, 2, 30, 40]);
  expect(result.details).toHaveLength(1);
  const events = i.emit.mock.calls.map(([event]) => event), checks = events.flatMap(event => event.checks ?? []);
  expect(checks).toHaveLength(result.counts.completed);
  expect(checks.filter(row => row.detail && row.result === "issue")).toHaveLength(2);
  expect(events.filter(event => event.kind === "part").map(event => event.part)).toEqual(["loads", "links", "phone"]);
});

it("emits actual click targets through CDP without native window input", async () => {
  f.targets = [{ index: 0, where: "button#menu", key: "menu" }];
  const i = input(); await runHiddenVerify(i).done;
  expect(f.commands.filter(command => command === "Input.dispatchMouseEvent")).toHaveLength(4);
  expect(i.emit.mock.calls.map(([event]) => event).filter(event => event.kind === "point")).toEqual(expect.arrayContaining([expect.objectContaining({ inp: expect.objectContaining({ type: "click", x: 20, y: 30 }), scrollY: 40 })]));
});

it("counts placeholder text and link destination as separate real trials", async () => {
  f.values.set("copy", { texts: [{ where: "a#mail", text: "Join", href: "mailto:join@example.com" }] });
  const i = input(), result = await runHiddenVerify(i).done;
  expect(result.counts).toMatchObject({ planned: 13, completed: 13, passed: 11, failed: 2 });
  expect(result.issues).toHaveLength(1);
  const checks = i.emit.mock.calls.flatMap(([event]) => event.checks ?? []).filter(row => row.rule === "placeholder contact");
  expect(checks.map(row => row.result)).toEqual(["ok", "issue", "ok", "issue"]);
});

it("keeps isolation, crash, cancellation and revision failures fatal", async () => {
  const i = input(); i.aborter.abort();
  expect((await runHiddenVerify(i).done).errorCode).toBe("cancelled");
  const changed = input(); changed.revisionUnchanged.mockResolvedValue(false);
  expect((await runHiddenVerify(changed).done).errorCode).toBe("site-changed");
  const crashed = input(); crashed.pages.desktop.loadURL = async () => crashed.pages.desktop.emit("render-process-gone");
  expect((await runHiddenVerify(crashed).done).errorCode).toBe("page-failed");
});

it("enforces the 60 second deadline on a hung page", async () => {
  vi.useFakeTimers();
  const i = input(); i.pages.desktop.loadURL = () => new Promise(() => {});
  const run = runHiddenVerify(i);
  await vi.advanceTimersByTimeAsync(60000);
  expect((await run.done).errorCode).toBe("timeout");
});

it("confirms an aborted local stylesheet and leaves scripts and phone layout unchecked behind a blocked CDN", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
  const i = input();
  for (const tile of ["desktop", "phone"]) i.pages[tile].loadURL = async () => {
    const on = f.events[tile];
    on["Network.requestWillBeSent"]({ requestId: "1", type: "Stylesheet", request: { url: "http://127.0.0.1:1234/missing.css" } });
    on["Network.loadingFailed"]({ requestId: "1", type: "Stylesheet", errorText: "net::ERR_ABORTED" });
    on["Network.requestWillBeSent"]({ requestId: "2", type: "Script", request: { url: "https://cdn.tailwindcss.com/" } });
    on["Network.loadingFailed"]({ requestId: "2", type: "Script", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
    on["Runtime.exceptionThrown"]({ exceptionDetails: { url: "http://127.0.0.1:1234/index.html", lineNumber: 2, exception: { description: "ReferenceError: tailwind is not defined" } } });
  };
  const result = await runHiddenVerify(i).done;
  fetch.mockRestore();
  expect(result.issues.map(x => [x.where, x.measured])).toEqual([["/missing.css", "HTTP 404; reload the page"]]);
  expect(result.notChecked).toEqual(expect.arrayContaining(["scripts (code from cdn.tailwindcss.com is blocked in the check)", "phone layout (styles from cdn.tailwindcss.com are blocked in the check)"]));
  expect(f.observations).not.toContain("phone:scroll");
});
