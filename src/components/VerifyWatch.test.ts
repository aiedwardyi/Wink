// @vitest-environment happy-dom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifyCardData } from "../../shared/live-verify";
import { applyLocale } from "@/lib/i18n";
import { VerifyWatchShow } from "@/lib/verify-watch-show";
import { VerifyWatchFrame } from "./VerifyWatch";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("../../shared/live-verify", async importOriginal => ({ ...await importOriginal<typeof import("../../shared/live-verify")>(), get LIVE_VERIFY_V0() { return flag.on; } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: VerifyCardData = { v: 1, runId: "run-1", owner: "bot", site: "luna/index.html", status: "running", mode: "auto", decisionNonce: "n", offeredAt: Date.now(), startedAt: Date.now(), live: true, replay: ["old-1", "old-2"] };
let root: Root;
let host: HTMLElement;
let calls: Array<{ url: string; signal: AbortSignal }>;
let visibility: DocumentVisibilityState;

beforeEach(() => {
  calls = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, signal: init.signal! });
    if (url.includes("old-")) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); } })));
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); applyLocale("en"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const render = (props: { live: boolean; hidden: boolean }) => act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", onClose: () => {}, ...props })));
const flipVisibility = (next: DocumentVisibilityState) => act(async () => { visibility = next; document.dispatchEvent(new Event("visibilitychange")); });

it("streams live only while the chat is shown and the window is visible, aborting on each change", async () => {
  await render({ live: true, hidden: true });
  expect(calls).toHaveLength(0);
  await render({ live: true, hidden: false });
  expect(calls.map(c => c.url)).toEqual(["/api/verify/runs/run-1/live"]);
  await render({ live: true, hidden: true });
  expect(calls[0]!.signal.aborted).toBe(true);
  expect(calls).toHaveLength(1);
  await render({ live: true, hidden: false });
  expect(calls).toHaveLength(2);
  await flipVisibility("hidden");
  expect(calls[1]!.signal.aborted).toBe(true);
  await flipVisibility("visible");
  expect(calls).toHaveLength(3);
  act(() => root.unmount());
  expect(calls[2]!.signal.aborted).toBe(true);
  root = createRoot(host);
});

it("plays the card's kept runs from the replay route and says Replay expired on 404", async () => {
  await render({ live: false, hidden: false });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  expect(calls.map(c => c.url)).toEqual(["/api/verify/runs/old-1/replay"]);
  await act(async () => { await new Promise(r => setTimeout(r, 60)); });
  expect(host.textContent).toContain("Replay expired");
  expect(host.querySelector(".verify-watch-url")?.textContent).toBe("luna/index.html");
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
});

function bufferedRun(status = "completed") {
  const chunk = (kind: number, value: unknown) => {
    const json = new TextEncoder().encode(JSON.stringify(value));
    const bytes = new Uint8Array(5 + json.length);
    new DataView(bytes.buffer).setUint32(0, json.length + 1, true);
    bytes[4] = kind;
    bytes.set(json, 5);
    return bytes;
  };
  return new Response(new Blob([
    chunk(0, { runId: "run-1", site: card.site, page: "index.html" }),
    chunk(3, { status, ms: 0, issues: [], notChecked: [] }),
  ]).stream());
}

function animationClock() {
  let now = performance.now(), id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  return async (count: number) => {
    for (let i = 0; i < count; i++) await act(async () => {
      now += 40;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(now));
    });
  };
}

it.each([false, true])("settles an end received before the next frame and finishes playback (live=%s)", async live => {
  const tick = animationClock();
  const finish = vi.spyOn(VerifyWatchShow.prototype, "finish");
  const onClose = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push({ url, signal: new AbortController().signal }); return bufferedRun(); }));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", live, hidden: false, onClose })));
  expect(finish).not.toHaveBeenCalled();
  await tick(200);
  expect(calls.map(c => c.url)).toEqual(live ? ["/api/verify/runs/run-1/live"] : ["/api/verify/runs/old-1/replay", "/api/verify/runs/old-2/replay"]);
  expect(finish).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it("plays on past a kept run whose check was blocked to the latest run", async () => {
  const tick = animationClock();
  const finish = vi.spyOn(VerifyWatchShow.prototype, "finish");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push({ url, signal: new AbortController().signal }); return bufferedRun(url.includes("old-1") ? "blocked" : "completed"); }));
  await render({ live: false, hidden: false });
  await tick(5);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Could not check this page");
  await tick(200);
  expect(calls.map(c => c.url)).toEqual(["/api/verify/runs/old-1/replay", "/api/verify/runs/old-2/replay"]);
  expect(finish).toHaveBeenCalledOnce();
});

it.each(["en", "ko"] as const)("uses the card's failed-check wording for blocked playback in %s", async locale => {
  applyLocale(locale);
  const tick = animationClock();
  vi.stubGlobal("fetch", vi.fn(async () => bufferedRun("blocked")));
  await render({ live: false, hidden: false });
  await tick(5);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(locale === "en" ? "Could not check this page" : "페이지를 확인하지 못했어요");
  expect(host.textContent).not.toContain(locale === "en" ? "No problems" : "문제 없음");
});

it("keeps the tabs on one line at their own width and the phone controls at least 44 px, desktop unchanged", async () => {
  applyLocale("ko");
  await render({ live: false, hidden: false });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(readFileSync("src/components/VerifyWatch.css", "utf8"));
  const style = (el: Element, width: number, prop: string) => {
    let value = "";
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          const max = /max-width:\s*(\d+)px/.exec(rule.conditionText);
          if (max && width <= Number(max[1])) visit(rule.cssRules);
        } else if (rule instanceof CSSStyleRule && el.matches(rule.selectorText)) value = rule.style.getPropertyValue(prop) || value;
      }
    };
    visit(sheet.cssRules);
    return value;
  };
  const tabs = [...host.querySelectorAll(".verify-watch-tabs button")];
  const icons = [...host.querySelectorAll(".verify-watch-icon")];
  expect(tabs.map(tab => tab.textContent)).toEqual(["데스크톱", "휴대폰"]);
  expect(icons).toHaveLength(3);
  for (const width of [360, 392, 1280]) {
    for (const tab of tabs) expect([style(tab, width, "white-space"), style(tab, width, "overflow-wrap"), style(tab, width, "flex-shrink")]).toEqual(["nowrap", "normal", "0"]);
    expect(style(host.querySelector(".verify-watch-tabs")!, width, "flex-shrink")).toBe("0");
  }
  for (const width of [360, 392]) {
    for (const tab of tabs) expect(parseFloat(style(tab, width, "height"))).toBeGreaterThanOrEqual(44);
    for (const icon of icons) expect([parseFloat(style(icon, width, "width")), parseFloat(style(icon, width, "height"))].every(px => px >= 44)).toBe(true);
  }
  for (const tab of tabs) expect(style(tab, 1280, "height")).toBe("100%");
  for (const icon of icons) expect([style(icon, 1280, "width"), style(icon, 1280, "height")]).toEqual(["28px", "28px"]);
});
