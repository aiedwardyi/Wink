// @vitest-environment happy-dom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VerifyCardData, VerifyIssue } from "../../shared/live-verify";
import { chunk } from "../../electron/verify-replay.mjs";
import { applyLocale } from "@/lib/i18n";
import { EASE_STANDARD, MOTION_LARGE_MS } from "@/lib/motion";
import { chooseVerifyTab } from "@/lib/verify-watch";
import { VerifyWatchShow } from "@/lib/verify-watch-show";
import { VerifyWatchFrame, VerifyWatchPanel } from "./VerifyWatch";

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

function bufferedRun(status = "completed", issues: VerifyIssue[] = [], site = card.site, page = "index.html") {
  const chunk = (kind: number, value: unknown) => {
    const json = new TextEncoder().encode(JSON.stringify(value));
    const bytes = new Uint8Array(5 + json.length);
    new DataView(bytes.buffer).setUint32(0, json.length + 1, true);
    bytes[4] = kind;
    bytes.set(json, 5);
    return bytes;
  };
  return new Response(new Blob([
    chunk(0, { runId: "run-1", site, page }),
    chunk(3, { status, ms: 0, issues, notChecked: [] }),
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

it.each(["en", "ko"] as const)("maximizes and restores with the button and Escape in %s", async locale => {
  applyLocale(locale);
  const onClose = vi.fn();
  await act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", live: true, hidden: false, onClose })));
  const frame = host.querySelector(".verify-watch-frame")!;
  const maximize = locale === "en" ? "Maximize" : "크게 보기";
  const restore = locale === "en" ? "Restore" : "원래 크기";
  const button = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${frame.hasAttribute("data-maximized") ? restore : maximize}"]`)!;
  expect(button()?.title).toBe(maximize);
  await act(async () => button().click());
  expect(frame.hasAttribute("data-maximized")).toBe(true);
  expect(button().title).toBe(restore);
  await act(async () => button().click());
  expect(frame.hasAttribute("data-maximized")).toBe(false);
  await act(async () => button().click());
  const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  await act(async () => window.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(frame.hasAttribute("data-maximized")).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps phone playback inline without a maximize button", async () => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} })));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", live: false, hidden: false, inline: true, onClose() {} })));
  expect(host.querySelector('[data-inline="true"]')).not.toBeNull();
  expect(host.querySelector('button[aria-label="Maximize"]')).toBeNull();
});

it.each(["en", "ko"] as const)("watches the same replay again from zero without rerunning in %s", async locale => {
  applyLocale(locale);
  const tick = animationClock();
  const onClose = vi.fn();
  const shows: VerifyWatchShow[] = [];
  const begin = VerifyWatchShow.prototype.beginRun;
  vi.spyOn(VerifyWatchShow.prototype, "beginRun").mockImplementation(function (this: VerifyWatchShow) { shows.push(this); begin.call(this); });
  const fetch = vi.fn(async (_url: string) => bufferedRun());
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: { ...card, replay: ["old-1"] }, threadId: "t", live: false, hidden: false, onClose })));
  await tick(60);
  expect(shows[0]!.phase).toBe("done");
  expect(onClose).not.toHaveBeenCalled();
  const again = host.querySelector<HTMLButtonElement>(".verify-watch-again")!;
  expect(again?.textContent).toBe(locale === "en" ? "Watch again" : "다시 보기");
  await act(async () => again.click());
  expect(shows).toHaveLength(2);
  expect(shows[1]).not.toBe(shows[0]);
  expect(shows[1]!.clock).toBe(0);
  expect(shows[1]!.ms).toBe(0);
  expect(host.querySelector(".verify-watch-again")).toBeNull();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/verify/runs/old-1/replay", "/api/verify/runs/old-1/replay"]);
  await tick(60);
  expect(shows[1]!.phase).toBe("done");
  expect(host.querySelector(".verify-watch-again")).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it.each(["en", "ko"] as const)("plays silently without sound controls in %s", async locale => {
  applyLocale(locale);
  const audio = vi.fn();
  vi.stubGlobal("AudioContext", audio);
  const tick = animationClock();
  vi.stubGlobal("fetch", vi.fn(async () => bufferedRun()));
  await render({ live: false, hidden: false });
  await tick(5);
  expect(audio).not.toHaveBeenCalled();
  expect(host.querySelectorAll(".verify-watch-icon")).toHaveLength(3);
  expect([...host.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))).not.toEqual(expect.arrayContaining([locale === "en" ? "Mute" : "소리 끄기"]));
  expect([...host.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))).not.toEqual(expect.arrayContaining([locale === "en" ? "Sound on" : "소리 켜기"]));
});

it("switches both viewport tabs after recorded playback finishes", async () => {
  const tick = animationClock();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect() {} } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("fetch", vi.fn(async () => recorded(shot("desktop"), shot("phone"))));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: { ...card, replay: ["old-1"] }, threadId: "t", live: false, hidden: false, onClose() {} })));
  await tick(100);
  expect(host.querySelector(".verify-watch-again")).not.toBeNull();
  for (const index of [1, 0]) {
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]!.click());
    await tick(1);
    expect(host.querySelectorAll('[role="tab"]')[index]!.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".verify-watch-stage")?.getAttribute("data-tile")).toBe(index ? "phone" : "desktop");
    expect(host.querySelector("canvas")?.width).toBe(index ? 392 : 1280);
  }
});

it.each(["en", "ko"] as const)("reuses card rule wording for the %s reel caption", async locale => {
  applyLocale(locale);
  const tick = animationClock();
  const problem: VerifyIssue = { checker: "LINKS", tile: "desktop", rule: "missing target", where: "#apply", measured: "#apply has no target; click the link", box: [10, 20, 80, 30] };
  vi.stubGlobal("fetch", vi.fn(async () => bufferedRun("completed", [problem])));
  await render({ live: false, hidden: false });
  await tick(2);
  expect(host.querySelector(".verify-watch-caption span")?.textContent).toBe(locale === "ko" ? "#apply 링크의 대상을 찾지 못했어요. 링크를 눌러 확인해 주세요." : problem.measured);
});

it("puts phone inline captions after the stage", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  const tick = animationClock();
  vi.stubGlobal("fetch", vi.fn(async () => bufferedRun("completed", [{ checker: "LINKS", tile: "desktop", rule: "missing target", where: "#apply", measured: "#apply has no target; click the link", box: [10, 20, 80, 30] }])));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", live: false, hidden: false, inline: true, onClose() {} })));
  await tick(2);
  expect(host.querySelector(".verify-watch-stage .verify-watch-caption")).toBeNull();
  expect(host.querySelector(".verify-watch-stage + .verify-watch-caption")).not.toBeNull();
});

it.each([false, true])("keeps docked captions outside the target's stage (live=%s)", async live => {
  const tick = animationClock();
  vi.stubGlobal("fetch", vi.fn(async () => bufferedRun("completed", [{ checker: "LINKS", tile: "desktop", rule: "self sign-up", where: "a#apply", measured: 'Sign-up link "#apply" points at itself; click the link', box: [540, 300, 200, 64] }])));
  await render({ live, hidden: false });
  await tick(2);
  expect(host.querySelector(".verify-watch-stage .verify-watch-caption")).toBeNull();
  expect(host.querySelector(".verify-watch-stage + .verify-watch-caption")).not.toBeNull();
});

it.each([false, true])("draws reel boxes at the selected screenshot's scroll (live=%s)", async live => {
  const tick = animationClock();
  const strokeRect = vi.fn();
  const context = { fillRect() {}, strokeRect, drawImage() {} };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(VerifyWatchShow.prototype, "frame").mockReturnValue({ jpeg: new Uint8Array([1]), ms: 0, scrollY: 500 });
  vi.stubGlobal("fetch", vi.fn(async () => bufferedRun("completed", [{ checker: "LINKS", tile: "desktop", rule: "missing target", where: "#apply", measured: "missing", box: [10, 20, 80, 30], scrollY: 600 }])));
  await render({ live, hidden: false });
  await tick(2);
  expect(strokeRect).toHaveBeenCalledWith(10, 120, 80, 30);
});

it.each([false, true])("keeps the result pill opposite the scrolled reel target (live=%s)", async live => {
  const tick = animationClock();
  vi.spyOn(VerifyWatchShow.prototype, "frame").mockReturnValue({ jpeg: new Uint8Array([1]), ms: 0, scrollY: 500 });
  vi.stubGlobal("fetch", vi.fn(async () => bufferedRun("completed", [
    { checker: "LINKS", tile: "desktop", rule: "missing target", where: "#bottom", measured: "missing", box: [540, 548, 200, 64], scrollY: 600 },
    { checker: "LINKS", tile: "desktop", rule: "missing target", where: "#top", measured: "missing", box: [540, 104, 200, 64], scrollY: 400 },
  ])));
  await render({ live, hidden: false });
  await tick(2);
  expect(host.querySelector(".verify-watch-pill")?.hasAttribute("data-top")).toBe(true);
  expect(host.querySelector(".verify-watch-stage + .verify-watch-caption")).not.toBeNull();
  await tick(40);
  expect(host.querySelector(".verify-watch-caption b")?.textContent).toContain("#top");
  expect(host.querySelector(".verify-watch-pill")?.hasAttribute("data-top")).toBe(false);
});

it.each(["en", "ko"] as const)("shows a Rerun failure and clears it on retry in %s", async locale => {
  applyLocale(locale);
  const tick = animationClock();
  const onClose = vi.fn();
  let attempts = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return bufferedRun("blocked");
    attempts++;
    if (attempts === 1) return Response.json({ error: "desktop unavailable" }, { status: 409 });
    if (attempts === 2) throw new TypeError("Failed to fetch");
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: { ...card, status: "completed" }, threadId: "t", live: false, hidden: false, onClose })));
  await tick(2);
  const rerun = host.querySelector<HTMLButtonElement>(`button[aria-label="${locale === "en" ? "Rerun" : "다시 확인"}"]`)!;
  for (let i = 0; i < 2; i++) {
    await act(async () => rerun.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(locale === "en" ? "Could not rerun. Try again." : "다시 확인하지 못했어요. 다시 시도하세요.");
    expect(rerun.disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  }
  await act(async () => rerun.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(onClose).toHaveBeenCalledOnce();
});

it.each([false, true])("animates measured tile heights unless reduced motion is set (%s)", async reduced => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: reduced && query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return { height: this.dataset.tile === "phone" ? 358 : 160 } as DOMRect; });
  const tick = animationClock();
  await render({ live: true, hidden: false });
  const stage = host.querySelector<HTMLElement>(".verify-watch-stage")!;
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  stage.animate = animate as unknown as typeof stage.animate;
  await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
  await tick(1);
  if (reduced) expect(animate).not.toHaveBeenCalled();
  else expect(animate).toHaveBeenCalledWith([{ height: "160px" }, { height: "358px" }], { duration: MOTION_LARGE_MS, easing: EASE_STANDARD });
});

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
  expect(onClose).toHaveBeenCalledTimes(live ? 1 : 0);
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

const problems: VerifyIssue[] = [{ checker: "NAV", tile: "phone", rule: "phone menu gone", where: "header nav", measured: "No phone menu" }];

for (const locale of ["en", "ko"] as const) {
  it.each([
    { name: "fail to fail", first: problems, next: problems, site: card.site, page: "index.html", fixed: false },
    { name: "clean to clean", first: [], next: [], site: card.site, page: "index.html", fixed: false },
    { name: "page A fail to page B clean", first: problems, next: [], site: "luna/about.html", page: "about.html", fixed: false },
    { name: "fail to clean on the same page", first: problems, next: [], site: card.site, page: "index.html", fixed: true },
  ])("verifies the result before claiming a fix: $name in " + locale, async ({ first, next, site, page, fixed }) => {
    applyLocale(locale);
    const tick = animationClock();
    const wording = locale === "en" ? "Bot fixed it" : "봇이 고쳤어요";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("old-1") ? bufferedRun("completed", first) : bufferedRun("completed", next, site, page)));
    await render({ live: false, hidden: false });
    await tick(45);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(locale === "en" ? "Waiting for another check" : "다른 확인을 기다리는 중");
    const banners: string[] = [];
    for (let i = 0; i < 180; i++) {
      await tick(1);
      banners.push(host.querySelector('[role="status"]')?.textContent ?? "");
    }
    expect(banners.includes(wording)).toBe(fixed);
  });

  it("stays neutral while the next run has not been fetched in " + locale, async () => {
    applyLocale(locale);
    const tick = animationClock();
    const fetch = vi.fn((url: string) => url.includes("old-1") ? Promise.resolve(bufferedRun("completed", problems)) : new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetch);
    await render({ live: false, hidden: false });
    await tick(45);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(locale === "en" ? "Waiting for another check" : "다른 확인을 기다리는 중");
    await tick(100);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain(locale === "en" ? "Bot fixed it" : "봇이 고쳤어요");
  });
}

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

const recorded = (...rest: Uint8Array[]) => new Response(new Blob([chunk(0, { runId: "run-1", site: card.site, page: "index.html" }), ...rest, chunk(3, { status: "completed", ms: 0, issues: [], notChecked: [] })] as BlobPart[]).stream());
const shot = (tile: string) => chunk(1, { tile, ms: 0, data: Buffer.from([255, 216, 255, 217]) });
const inlineCard = (runId: string) => ({ ...card, runId, replay: [runId] });
const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent === name)!;

it("stays open on a click inside the inline player and closes on X, Escape or a click outside", async () => {
  const onClose = vi.fn();
  const trigger = document.createElement("div");
  trigger.setAttribute("data-verify-card", "");
  trigger.innerHTML = "<button data-verify-watch></button>";
  document.body.append(trigger);
  await act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", live: false, hidden: false, inline: true, onClose })));
  await act(async () => host.querySelector<HTMLElement>(".verify-watch-stage")!.click());
  await act(async () => host.querySelector<HTMLCanvasElement>("canvas")!.click());
  await act(async () => trigger.querySelector("button")!.click());
  trigger.remove();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => document.body.click());
  expect(onClose).toHaveBeenCalledTimes(2);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(onClose).toHaveBeenCalledTimes(3);
});

it("stays open when a button inside the inline player unmounts on its own click", async () => {
  const onClose = vi.fn();
  await act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", live: false, hidden: false, inline: true, onClose })));
  const button = document.createElement("button");
  host.querySelector(".verify-watch-bar")!.append(button);
  button.addEventListener("click", () => button.remove());
  await act(async () => button.click());
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps the chosen Phone tab through Watch again and a reopen", async () => {
  const tick = animationClock();
  vi.stubGlobal("fetch", vi.fn(async () => recorded(shot("desktop"), shot("phone"))));
  const data = inlineCard("run-phone-tab");
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: data, threadId: "t", live: false, hidden: false, onClose() {} })));
  await tick(60);
  await act(async () => tab("Phone").click());
  await act(async () => host.querySelector<HTMLButtonElement>(".verify-watch-again")!.click());
  await tick(3);
  expect(tab("Phone").getAttribute("aria-selected")).toBe("true");
  await tick(60);
  expect(tab("Phone").getAttribute("aria-selected")).toBe("true");
  await act(async () => root.render(createElement("div")));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: data, threadId: "t", live: false, hidden: false, onClose() {} })));
  await tick(3);
  expect(tab("Phone").getAttribute("aria-selected")).toBe("true");
});

it("offers no Phone tab when the run has no phone view", async () => {
  const tick = animationClock();
  vi.stubGlobal("fetch", vi.fn(async () => recorded(shot("desktop"))));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: inlineCard("run-no-phone"), threadId: "t", live: false, hidden: false, onClose() {} })));
  await tick(5);
  expect([...host.querySelectorAll('[role="tab"]')].map(el => el.textContent)).toEqual(["Desktop"]);
});

it("never draws check lines on a stage with no picture, and draws them once it has one", async () => {
  const tick = animationClock();
  const strokes = vi.fn();
  const ctx = new Proxy({ strokeRect: strokes }, { get: (target, key) => key in target ? target[key as "strokeRect"] : () => {}, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  let decoded = (_image: unknown) => {};
  vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(resolve => { decoded = resolve; })));
  const mark = chunk(2, { ms: 0, kind: "result", ev: { tile: "desktop", checker: "LINKS", result: "ok", box: [10, 20, 80, 30], where: "a#one" } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob([chunk(0, { runId: "run-1", site: card.site, page: "index.html" }), shot("desktop"), mark, chunk(3, { status: "completed", ms: 2000, issues: [], notChecked: [] })] as BlobPart[]).stream())));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: inlineCard("run-no-picture"), threadId: "t", live: false, hidden: false, onClose() {} })));
  await tick(6);
  expect(strokes).not.toHaveBeenCalled();
  await act(async () => decoded({ close() {} }));
  await tick(2);
  expect(strokes).toHaveBeenCalled();
});

it.each([[false, "desktop"], [true, "desktop"], [false, "phone"], [true, "phone"]] as const)("keeps the stage hidden and the clock at zero until the first picture decodes (inline=%s, %s)", async (inline, tabName) => {
  const tick = animationClock();
  const drawImage = vi.fn();
  const ctx = new Proxy({ drawImage }, { get: (target, key) => key in target ? target[key as "drawImage"] : () => {}, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  let decoded = (_image: unknown) => {};
  vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(resolve => { decoded = resolve; })));
  const clocks: number[] = [];
  const advance = VerifyWatchShow.prototype.advance;
  vi.spyOn(VerifyWatchShow.prototype, "advance").mockImplementation(function (this: VerifyWatchShow, ms: number) { const changed = advance.call(this, ms); clocks.push(this.clock); return changed; });
  const data = inlineCard(`run-first-picture-${inline}-${tabName}`);
  chooseVerifyTab(data.runId, tabName);
  const mark = chunk(2, { ms: 0, kind: "result", ev: { tile: tabName, checker: "LINKS", result: "ok", box: [10, 20, 80, 30], where: "a#one" } });
  vi.stubGlobal("fetch", vi.fn(async () => recorded(shot("desktop"), shot("phone"), mark)));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: data, threadId: "t", live: false, hidden: false, inline, onClose() {} })));
  await tick(8);
  const stage = host.querySelector(".verify-watch-stage")!;
  expect(stage.hasAttribute("data-pending")).toBe(true);
  expect(drawImage).not.toHaveBeenCalled();
  expect(Math.max(...clocks)).toBe(0);
  await act(async () => decoded({ close() {} }));
  expect(stage.hasAttribute("data-pending")).toBe(false);
  expect(drawImage).toHaveBeenCalled();
  await tick(3);
  expect(Math.max(...clocks)).toBeGreaterThan(0);
});

it("keeps the last picture up while watching again", async () => {
  const tick = animationClock();
  const drawImage = vi.fn();
  const ctx = new Proxy({ drawImage }, { get: (target, key) => key in target ? target[key as "drawImage"] : () => {}, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close() {} })));
  vi.stubGlobal("fetch", vi.fn(async () => recorded(shot("desktop"))));
  await act(async () => root.render(createElement(VerifyWatchFrame, { card: inlineCard("run-again-picture"), threadId: "t", live: false, hidden: false, onClose() {} })));
  await tick(120);
  const again = host.querySelector<HTMLButtonElement>(".verify-watch-again")!;
  const before = drawImage.mock.calls.length;
  await act(async () => again.click());
  expect(host.querySelector(".verify-watch-stage")!.hasAttribute("data-pending")).toBe(false);
  expect(drawImage.mock.calls.length).toBeGreaterThan(before);
});

it.each([["en", "Phone fit"], ["ko", "휴대폰 맞춤"]] as const)("names the phone width check so the list never cuts it in %s", async (locale, label) => {
  applyLocale(locale);
  await act(async () => root.render(createElement(VerifyWatchFrame, { card, threadId: "t", live: false, hidden: false, onClose() {} })));
  expect(host.textContent).toContain(label);
});

it("slides the docked panel in and keeps it mounted, inert and click-through, while it closes", async () => {
  const panel = (closing: boolean) => act(async () => root.render(createElement(VerifyWatchPanel, { card, threadId: "t", live: false, hidden: false, closing })));
  const aside = () => host.querySelector("aside.verify-watch")!;
  await panel(false);
  expect(aside().classList.contains("animate-panel-in")).toBe(true);
  expect(aside().hasAttribute("data-side-panel")).toBe(true);
  expect(aside().hasAttribute("data-closing")).toBe(false);
  await panel(true);
  expect(aside().hasAttribute("data-closing")).toBe(true);
  expect(aside().hasAttribute("inert")).toBe(true);
  expect(host.querySelector(".verify-watch-frame")).not.toBeNull();
});

it("stops the live stream the moment the panel starts closing", async () => {
  const panel = (closing: boolean) => act(async () => root.render(createElement(VerifyWatchPanel, { card, threadId: "t", live: true, hidden: false, closing })));
  await panel(false);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal.aborted).toBe(false);
  await panel(true);
  expect(calls[0]!.signal.aborted).toBe(true);
});

const watchCss = readFileSync("src/components/VerifyWatch.css", "utf8");
const watchRule = (selector: string) => {
  const start = watchCss.indexOf(`\n${selector} {`);
  return start < 0 ? "" : watchCss.slice(start, watchCss.indexOf("}", start));
};

it("holds the docked panel for its exit and gives the chat its column back at once", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  expect(app).toContain("usePresence(watch && watchChat && watchCard");
  expect(app).toContain("closing={watchShown.closing}");
  expect(app).not.toContain('watchCard ? " verify-watch-dock"');
  expect(watchCss).toMatch(/\.verify-watch\[data-closing\] \{[^}]*margin-left: calc\(-1 \* var\(--dock\)\); transition: none;/);
});

it("grows and shrinks the maximized panel on the shared tokens, never switching between flow and absolute", () => {
  const dock = watchRule(".verify-watch");
  for (const prop of ["width", "margin-left"]) expect(dock).toContain(`${prop} var(--motion-large) var(--ease-standard)`);
  const maximized = watchRule(".verify-watch:has(> .verify-watch-frame[data-maximized])");
  expect(maximized).toContain("width: 100cqi;");
  expect(maximized).not.toMatch(/position:|inset:|align-items/);
  expect(watchRule(".verify-watch-frame")).toContain("transition: min-height var(--motion-large) var(--ease-standard);");
  expect(watchRule(".verify-watch-frame[data-maximized]")).toContain("min-height: calc(100% - 24px);");
  expect(watchCss).not.toMatch(/\d\s?ms\b/);
});
