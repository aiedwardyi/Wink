import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ observations: [], failures: new Set(), commands: [], events: {} }));
vi.mock("./verify-cdp.mjs", () => ({ attach: page => ({
  async send(method) { f.commands.push(method); },
  on(name, handler) { (f.events[page.tile] ??= {})[name] = handler; return () => {}; },
  async ev(expression) {
    if (expression.includes("document.fonts")) return true;
    if (expression.includes("!!document.querySelector")) return true;
    const rule = expression.includes('all("img[src]') ? "errors" : expression.includes('all("a[href]").filter(visible)') ? "links" : expression.includes("scrollWidth") ? "scroll" : expression.includes("const controls") ? "menu" : "copy";
    f.observations.push(`${page.tile}:${rule}`);
    if (f.failures.has(`${page.tile}:${rule}`)) throw new Error("Unsupported color or removed node");
    return { errors: { images: [] }, links: { links: [] }, scroll: { width: 392, scrollWidth: 392 }, menu: { links: [], menu: false }, copy: { texts: [] } }[rule];
  },
  close() {},
}) }));
import { runHiddenVerify } from "./verify-hidden.mjs";

afterEach(() => { vi.useRealTimers(); f.observations = []; f.failures.clear(); f.commands = []; f.events = {}; });
function input() {
  const aborter = new AbortController();
  const pages = Object.fromEntries(["desktop", "phone"].map(tile => [tile, Object.assign(new EventEmitter(), { tile, loadURL: vi.fn(async () => {}) })]));
  return { runId: "run-123456", site: "index.html", url: "http://127.0.0.1:1234/index.html", pages, hidden: true, signal: aborter.signal, aborter, emit: vi.fn(), progress: vi.fn(), blockedUrls: () => [], revisionUnchanged: vi.fn(async () => true) };
}

it("finishes at full speed without timed show work or input", async () => {
  vi.useFakeTimers();
  const i = input(), result = await runHiddenVerify(i).done;
  expect(result.errorCode).toBeUndefined();
  expect(result.durationMs).toBe(0);
  expect(result.notChecked).toContain("form delivery");
  expect(f.commands.some(c => c.startsWith("Input."))).toBe(false);
  expect(i.emit.mock.calls.map(([event]) => event.kind)).toEqual(["start", "end"]);
});

it("contains independent failures on both tiles and continues remaining rules", async () => {
  f.failures.add("desktop:errors"); f.failures.add("phone:menu");
  const result = await runHiddenVerify(input()).done;
  expect(result.errorCode).toBeUndefined();
  expect(result.notChecked).toEqual(expect.arrayContaining(["page errors (desktop)", "phone menu (phone)"]));
  expect(result.counts).toMatchObject({ completed: 10, blocked: 2, notRun: 0 });
  expect(f.observations).toContain("phone:copy");
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
