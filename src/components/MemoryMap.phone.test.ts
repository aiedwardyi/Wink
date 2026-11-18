// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EASE_STANDARD, MOTION_FAST_MS, MOTION_LARGE_MS } from "@/lib/motion";
import type { Bot } from "@/state/store";
import { MemoryMap, warmGlow } from "./MemoryMap";

const bot = { id: "b", threadId: "t", messages: [], tasks: [] } as unknown as Bot;
const nativeAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
interface Pass {
  element: HTMLElement;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: Animation;
  finish: () => void;
}
let host: HTMLDivElement;
let root: Root;
let worker: ReturnType<typeof vi.fn<() => void>>;
let passes: Pass[];
let reduced: boolean;

const mount = () => act(async () => root.render(createElement(MemoryMap, { bot, text: "- Keeps notes", topics: [], active: true })));
const panel = (kind: string) => host.querySelector<HTMLButtonElement>(`button.mm-panel[data-kind="${kind}"]`)!;
const fold = (kind: string) => panel(kind).parentElement!.querySelector<HTMLElement>(".mm-fold");
const tap = (kind: string) => act(async () => panel(kind).click());
const finish = () => act(async () => { for (const each of passes) each.finish(); });

beforeEach(() => {
  passes = [];
  reduced = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(392);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(350);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: reduced && query.includes("prefers-reduced-motion"), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("OffscreenCanvas", class {});
  worker = vi.fn<() => void>();
  vi.stubGlobal("Worker", class { constructor() { worker(); } postMessage() {} });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value(this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    let done = () => {}, rate = 1;
    const pending = () => new Promise<void>((resolve) => { done = resolve; });
    const animation = {
      playbackRate: 1, finished: pending(), cancel: vi.fn(),
      effect: { updateTiming: vi.fn(), getComputedTiming: () => ({ endTime: Number(options.duration) + Number(options.delay ?? 0) }) },
      updatePlaybackRate: (next: number) => { rate = next; },
      reverse: vi.fn(() => {
        const previous = done;
        animation.playbackRate = -rate;
        animation.finished = pending();
        queueMicrotask(previous);
      }),
    };
    passes.push({ element: this, keyframes, options, animation: animation as unknown as Animation, finish: () => done() });
    return animation;
  } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (nativeAnimate) Object.defineProperty(HTMLElement.prototype, "animate", nativeAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("phone memory glow", () => {
  it("keeps the CSS glow even when the browser supports the bitmap painter", async () => {
    await mount();
    const map = host.querySelector(".mm")!;
    expect(map.hasAttribute("data-stacked")).toBe(true);
    expect(map.hasAttribute("data-smooth")).toBe(false);
    expect(map.querySelector(".mm-smooth, .mm-smooth-live, canvas")).toBeNull();
    expect(map.querySelector(".mm-glow")).not.toBeNull();
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not warm a bitmap painter on a phone", () => {
    warmGlow();
    expect(worker).not.toHaveBeenCalled();
  });
});

describe("phone memory motion", () => {
  it.each(["long", "knowledge", "muscle"])("keeps %s in place for its reverse close, then removes it", async (kind) => {
    await mount();
    await tap(kind);
    const shown = fold(kind)!;
    const opening = passes.find((each) => each.element === shown)!;
    expect(opening.options).toMatchObject({ duration: MOTION_LARGE_MS, easing: EASE_STANDARD });
    expect(JSON.stringify(opening.keyframes)).not.toMatch(/rotate|scale|height|grid/);
    await finish();
    await tap(kind);
    expect(fold(kind)).toBe(shown);
    expect(shown.hasAttribute("inert")).toBe(true);
    expect(shown.hasAttribute("data-leaving")).toBe(true);
    expect(opening.animation.playbackRate).toBe(-MOTION_LARGE_MS / MOTION_FAST_MS);
    await finish();
    expect(fold(kind)).toBeNull();
    expect(worker).not.toHaveBeenCalled();
  });

  it("reverses a closing fold without replacing its content or starting a second open", async () => {
    await mount();
    await tap("long");
    const shown = fold("long")!;
    await tap("long");
    await tap("long");
    await finish();
    expect(fold("long")).toBe(shown);
    expect(shown.hasAttribute("inert")).toBe(false);
    expect(passes.filter((each) => each.element === shown)).toHaveLength(1);
  });

  it("closes the previous kind while the next one opens", async () => {
    await mount();
    await tap("long");
    await finish();
    await tap("knowledge");
    expect(fold("long")?.hasAttribute("inert")).toBe(true);
    expect(fold("knowledge")?.hasAttribute("inert")).toBe(false);
    await finish();
    expect(fold("long")).toBeNull();
    expect(fold("knowledge")).not.toBeNull();
  });

  it("moves following rows on both sides of a fold taller than the viewport", async () => {
    await mount();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const tall = host.querySelector(".mm-left > .mm-fold:not([data-leaving])") ? 1400 : 0;
      const top = this.classList.contains("mm-right") ? 100 + tall : this.classList.contains("mm-bottom") ? 200 + tall : 0;
      return new DOMRect(0, top, 350, 100);
    });
    const next = panel("knowledge").parentElement!;
    await tap("long");
    const opening = passes.find((each) => each.element === next)!;
    expect(opening.keyframes[0].transform).toBe("translateY(-1400px)");
    expect(opening.options).toMatchObject({ duration: MOTION_LARGE_MS, easing: EASE_STANDARD });
    await finish();
    await tap("long");
    const closing = passes.filter((each) => each.element === next).at(-1)!;
    expect(closing.keyframes[0].transform).toBe("translateY(1400px)");
    expect(closing.options).toMatchObject({ duration: MOTION_FAST_MS, easing: EASE_STANDARD });
    await finish();
  });

  it("keeps Live at its painted position when a close clamps the scroll", async () => {
    let scrolled = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains("mm-live") && scrolled ? fold("long")?.hasAttribute("data-leaving") ? 211 : -113 : 0;
      return new DOMRect(0, top, 350, 100);
    });
    await mount();
    await tap("long");
    await finish();
    scrolled = true;
    await tap("long");
    const live = host.querySelector(".mm-live"), travel = passes.find((each) => each.element === live);
    expect(travel).toBeDefined();
    expect(travel!.keyframes[0].transform).toBe("translateY(-324px)");
    await finish();
  });

  it("sizes fold rows on their first layout, so moveRows measures where the rows below land", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MemoryMap.css"), "utf8");
    const deferred = [...css.matchAll(/([^{}]*\.mm-fold[^{}]*)\{([^}]*)\}/g)].filter(([, , body]) => body!.includes("content-visibility")).map(([, selector]) => selector!.trim());
    expect(deferred, "a fold row that resizes after the open frame leaves the FLIP offset stale and flashes the next row over this one").toEqual([]);
  });

  it("opens and closes immediately under reduced motion", async () => {
    reduced = true;
    await mount();
    await tap("long");
    expect(fold("long")).not.toBeNull();
    await tap("long");
    expect(fold("long")).toBeNull();
    expect(passes).toHaveLength(0);
  });
});
