import "./ProfileFields.test-dom.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelDialEnabled } from "@/lib/feature-flags";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import * as phoneSwipe from "@/lib/phone-swipe";
import type { Bot, InstanceInfo } from "@/state/store";
import { ModelPickerControl } from "./ModelPicker";

const L5 = ["low", "medium", "high", "xhigh", "max"] as const;
const dispatch = vi.fn();
const animate = vi.fn((_keyframes: Keyframe[], _options?: number | KeyframeAnimationOptions) => ({ cancel: vi.fn() } as unknown as Animation));
const originalAnimate = Element.prototype.animate;
let root: Root;

function engine(instanceId: string, driverKind: string, ids: string[], signedIn = true): InstanceInfo {
  return {
    instanceId, driverKind, displayName: instanceId,
    snapshot: { state: "available", authenticated: signedIn },
    models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
    capabilities: { effortLevels: [...L5] },
  };
}

function media({ wide = true, reduced = false, phone = false } = {}) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("reduce") ? reduced : query.split(", ").some((part) => part.startsWith("(max-width") ? phone : wide),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function mouse(width: number, height = 900) {
  const screen = { width, height, changes: new Set<(event: Event) => void>() };
  vi.spyOn(window, "innerWidth", "get").mockImplementation(() => screen.width);
  vi.spyOn(window, "innerHeight", "get").mockImplementation(() => screen.height);
  const fits = (query: string) => query.split(", ").some((part) => part.split(" and ").every((term) => {
    const [, name, value] = /\(([\w-]+): ([\w./]+)\)/.exec(term)!;
    if (name === "max-aspect-ratio") return screen.width * Number(value.split("/")[1]) <= screen.height * Number(value.split("/")[0]);
    return name === "pointer" ? value === "fine" : name === "max-width" ? screen.width <= parseFloat(value) : name === "min-width" ? screen.width >= parseFloat(value) : false;
  }));
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    get matches() { return fits(query); },
    media: query,
    onchange: null,
    addEventListener: (_: string, change: (event: Event) => void) => void screen.changes.add(change),
    removeEventListener: (_: string, change: (event: Event) => void) => void screen.changes.delete(change),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  return (next: number) => act(async () => {
    screen.width = next;
    screen.changes.forEach((change) => change(new Event("change")));
    window.dispatchEvent(new Event("resize"));
  });
}

function control({ grokSignedIn = true, dial = true, model = "claude-opus-5-5", open = true } = {}) {
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
    engine("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"]),
    engine("grok", "grokAgent", ["grok-4.7"], grokSignedIn),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Dial", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model, effort: "high", mode: "pinned" } };
  return createElement(ModelPickerControl, {
    bot,
    store: { state: { instances, selectedId: "bot-1" }, dispatch, refreshInstances: async () => undefined },
    defaultOpen: open,
    dial,
  });
}

async function render(...controls: ReturnType<typeof control>[]) {
  await act(async () => {
    root.render(createElement(I18nProvider, null, ...controls));
  });
}

async function mount(options: Parameters<typeof control>[0] = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render(control(options));
}

async function key(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const wait = (ms: number) => act(async () => vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : new Promise((resolve) => setTimeout(resolve, ms)));

async function settle() {
  for (let i = 0; i < 60; i++) await wait(20);
}

async function pointer(type: string, x: number, y: number, pointerType = "touch", button = 0) {
  await act(async () => {
    document.querySelector(".dial-stage")!.dispatchEvent(new window.PointerEvent(type, { pointerId: 1, pointerType, isPrimary: true, button, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  });
}

async function drag(dx: number, dy: number, moves = 4, ms = 30, pointerType = "touch") {
  await pointer("pointerdown", 200, 400, pointerType);
  for (let i = 1; i <= moves; i++) {
    await wait(ms);
    await pointer("pointermove", 200 + dx * i / moves, 400 + dy * i / moves, pointerType);
  }
  await pointer("pointerup", 200 + dx, 400 + dy, pointerType);
}

async function wheel(deltaY: number, deltaMode = 0) {
  await act(async () => {
    document.querySelector(".dial-stage")!.dispatchEvent(new window.WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true }));
  });
}

const order = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol", "gpt-6-luna", "grok-4.7"];
const selected = () => document.querySelector('.dial-card[aria-pressed="true"]')?.getAttribute("data-model-cell");
const effort = () => document.querySelector(".dial-effort b")?.textContent;
const saved = () => dispatch.mock.calls.find(([action]) => action.type === "setModel")?.[0].selection;

function spoken(node: Node): string {
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : Array.from(node.childNodes, spoken).join("");
}

beforeEach(() => {
  Element.prototype.animate = animate;
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  dispatch.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Element.prototype.animate = originalAnimate;
  Reflect.deleteProperty(window.navigator, "vibrate");
});

describe("ModelDial", () => {
  it("steps models with up and down and wraps at the ends", async () => {
    media();
    await mount();
    expect(document.querySelector(".model-dial")).not.toBeNull();
    expect(selected()).toBe("claude-opus-5-5");
    await key("ArrowDown");
    expect(selected()).toBe("claude-sonnet-5-5");
    await key("ArrowUp");
    await key("ArrowUp");
    expect(selected()).toBe("grok-4.7");
  });

  it("clamps effort at both ends", async () => {
    media();
    await mount();
    expect(effort()).toBe("high");
    for (let i = 0; i < 4; i++) await key("ArrowRight");
    expect(effort()).toBe("max");
    expect(document.querySelector(".dial-stage")?.hasAttribute("data-max")).toBe(true);
    for (let i = 0; i < 8; i++) await key("ArrowLeft");
    expect(effort()).toBe("low");
  });

  it("squashes the logo on each effort step, not at the clamp", async () => {
    media();
    await mount();
    const q = () => document.querySelector<HTMLElement>(".dial-tile")!.dataset.q;
    const before = q();
    await key("ArrowRight");
    expect(q()).not.toBe(before);
    for (let i = 0; i < 4; i++) await key("ArrowRight");
    expect(effort()).toBe("max");
    const clamped = q();
    await key("ArrowRight");
    expect(q()).toBe(clamped);
  });

  it("picks with Enter and closes with Esc", async () => {
    media();
    await mount();
    await key("ArrowDown");
    await key("Enter");
    expect(saved()).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", effort: "high", mode: "pinned" });
    await act(async () => root.unmount());
    dispatch.mockReset();
    await mount();
    await key("Escape");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
    expect(saved()).toBeUndefined();
  });

  it.each([
    [true, '[aria-label="Previous model"]', "grok-4.7"],
    [true, '[aria-label="Next model"]', "claude-sonnet-5-5"],
    [true, '[data-dial-lab="codex"]', "gpt-6.1-sol"],
    [false, '[aria-label="Previous model"]', "grok-4.7"],
    [false, '[aria-label="Next model"]', "claude-sonnet-5-5"],
  ])("keeps native Enter activation on %s dial %s", async (dial, selector, model) => {
    media();
    await mount({ dial });
    const button = document.querySelector<HTMLButtonElement>(selector)!;
    button.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => (button.querySelector("svg") ?? button).dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(saved()).toBeUndefined();
    await act(async () => button.click());
    expect(document.querySelector(`[data-model-cell="${model}"][aria-pressed="true"]`)).not.toBeNull();
    expect(saved()).toBeUndefined();
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
  });

  it("keeps native Enter activation on List View", async () => {
    media();
    await mount();
    const button = document.querySelector<HTMLButtonElement>(".model-dial-view")!;
    button.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(saved()).toBeUndefined();
    await act(async () => button.click());
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
    expect(saved()).toBeUndefined();
  });

  it.each([false, true])("commits on Enter after clicking the view toggle (back to dial %s)", async (backToDial) => {
    media();
    await mount();
    const toggle = () => document.querySelector<HTMLButtonElement>(".model-dial-view")!;
    for (let i = 0; i < (backToDial ? 2 : 1); i++) {
      await act(async () => { toggle().focus(); toggle().click(); });
    }
    expect(localStorage.getItem("omb-model-picker-view")).toBe(backToDial ? "dial" : "list");
    await key("Enter");
    expect(saved()).toEqual({ instanceId: "claude", model: "claude-opus-5-5", effort: "high", mode: "pinned" });
    await wait(200);
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
    expect(Boolean(document.querySelector(".model-dial"))).toBe(backToDial);
    expect(localStorage.getItem("omb-model-picker-view")).toBe(backToDial ? "dial" : "list");
  });

  it.each([
    ["claude-opus-5-5", ["51.8", "35.9", "3.46"]],
    ["unlisted-model", ["Unavailable", "Unavailable", "Unavailable"]],
  ])("exposes formatted stats without rolling digits for %s", async (model, values) => {
    media();
    await mount({ model });
    expect(Array.from(document.querySelectorAll(".dial-odo"), spoken)).toEqual(values);
  });

  it.each([
    ["en", "/Task"],
    ["ko", "/작업"],
  ] as const)("rolls the cost with effort in %s", async (locale, unit) => {
    persistPreference(locale);
    media();
    await mount();
    const cost = () => document.querySelector(".dial-cost");
    const shown = () => [spoken(cost()!.querySelector(".dial-odo")!), cost()!.querySelector(".unit")!.textContent];
    expect(shown()).toEqual(["3.46", unit]);
    expect(cost()!.parentElement!.querySelector(".dial-src")!.textContent).toContain("$");
    await key("ArrowLeft");
    expect(shown()).toEqual(["2.45", unit]);
    await key("ArrowLeft");
    await key("ArrowLeft");
    expect(shown()).toEqual(["0.98", unit]);
    for (let i = 0; i < 4; i++) await key("ArrowRight");
    expect(shown()).toEqual(["10.04", unit]);
  });

  it("keeps the price per 1M where an effort has no run cost", async () => {
    persistPreference("en");
    media();
    await mount({ model: "grok-4.7" });
    for (let i = 0; i < 4; i++) await key("ArrowLeft");
    await key("ArrowRight");
    expect(effort()).toBe("medium");
    expect(document.querySelector(".dial-cost .unit")!.textContent).toBe("/1M");
    expect(spoken(document.querySelector(".dial-cost .dial-odo")!)).not.toBe("0.00");
  });

  it("jumps by typed name and lands with Enter", async () => {
    media();
    await mount();
    await key("s");
    await key("o");
    expect(selected()).toBe("claude-sonnet-5-5");
    await key("l");
    expect(selected()).toBe("gpt-6.1-sol");
    await key("Enter");
    expect(saved()).toEqual({ instanceId: "codex", model: "gpt-6.1-sol", effort: "high", mode: "pinned" });
  });

  it("shows a signed-out engine locked and never picks it", async () => {
    media();
    await mount({ grokSignedIn: false });
    expect(document.querySelector('[data-dial-lab="grok"]')?.hasAttribute("data-locked")).toBe(true);
    await key("ArrowUp");
    expect(selected()).toBe("grok-4.7");
    expect((document.querySelector("[data-dial-pick]") as HTMLButtonElement).disabled).toBe(true);
    await key("Enter");
    expect(saved()).toBeUndefined();
  });

  it("switches to the list view and back", async () => {
    media();
    await mount();
    const toggle = () => document.querySelector<HTMLButtonElement>(".model-dial-view")!;
    expect(toggle().textContent).toBe("List View");
    await act(async () => toggle().click());
    expect(document.querySelector(".model-dial")).toBeNull();
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
    expect(toggle().textContent).toBe("Dial View");
    await act(async () => toggle().click());
    expect(document.querySelector(".model-dial")).not.toBeNull();
  });

  it("remembers the view on reopen and a fresh mount", async () => {
    media();
    await mount();
    const toggle = () => document.querySelector<HTMLButtonElement>(".model-dial-view")!;
    const reopen = async () => {
      await key("Escape");
      await wait(400);
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
    };
    await act(async () => toggle().click());
    expect(localStorage.getItem("omb-model-picker-view")).toBe("list");
    await reopen();
    expect(document.querySelector(".model-dial")).toBeNull();
    expect(toggle().textContent).toBe("Dial View");
    await act(async () => root.unmount());
    await mount();
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
    expect(toggle().textContent).toBe("Dial View");
    await act(async () => toggle().click());
    await reopen();
    expect(document.querySelector(".model-dial")).not.toBeNull();
    await act(async () => root.unmount());
    await mount();
    expect(document.querySelector(".model-dial")).not.toBeNull();
    expect(localStorage.getItem("omb-model-picker-view")).toBe("dial");
  });

  it("keeps the list picker below the desktop cutoff", async () => {
    media({ wide: false });
    await mount();
    expect(document.querySelector(".model-dial")).toBeNull();
    expect(document.querySelector(".model-dial-view")).toBeNull();
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
  });

  it("shows the rest look at once under reduced motion", async () => {
    media({ reduced: true });
    await mount();
    await key("ArrowDown");
    expect(document.querySelector(".dial-plane")?.hasAttribute("data-open")).toBe(true);
    media();
    await key("ArrowDown");
    expect(document.querySelector(".dial-plane")?.hasAttribute("data-open")).toBe(false);
  });

  describe("in a mouse window", () => {
    const vertical = () => document.querySelector(".dial-stage")?.hasAttribute("data-phone");
    const stage = () => document.querySelector<HTMLElement>(".dial-stage")!.style;
    const floor = () => parseFloat(stage().getPropertyValue("--floor")) * Number(stage().zoom);

    it("keeps the wide dial when wide or short", async () => {
      for (const [width, height] of [[1440, 900], [1024, 600]]) {
        mouse(width, height);
        await mount();
        expect(vertical()).toBe(false);
        await act(async () => root.unmount());
        vi.restoreAllMocks();
      }
    });

    it("takes the vertical dial when narrow", async () => {
      for (const [width, height] of [[800, 900], [700, 900], [480, 900], [600, 300]]) {
        mouse(width, height);
        await mount();
        expect(vertical()).toBe(true);
        expect(document.querySelector(".model-dial-view")?.textContent).toBe("List View");
        await act(async () => root.unmount());
        vi.restoreAllMocks();
      }
    });

    it("keeps the wide dial in a desktop window down to 801px", async () => {
      for (const [width, height] of [[1000, 900], [937, 904], [801, 900], [801, 600]]) {
        mouse(width, height);
        await mount();
        expect(vertical()).toBe(false);
        await act(async () => root.unmount());
        vi.restoreAllMocks();
      }
    });

    it("floors desktop text at 12px as the window shrinks", async () => {
      for (const [width, height, zoom] of [[2560, 1080, 1.2], [1440, 900, 1], [937, 904, 12 / 13.5], [801, 600, 12 / 13.5]]) {
        mouse(width, height);
        await mount();
        expect(Number(stage().zoom)).toBeCloseTo(zoom);
        expect(floor()).toBeCloseTo(12);
        await act(async () => root.unmount());
        vi.restoreAllMocks();
      }
    });

    it("scales the wide dial to fit a short window", async () => {
      for (const height of [480, 448]) {
        mouse(1024, height);
        await mount();
        const px = (name: string) => parseFloat(stage().getPropertyValue(name));
        const [cy, fs, stats] = [px("--cy"), px("--fs"), px("--stats")];
        expect(px("--ph") * Number(stage().zoom)).toBeLessThanOrEqual(height);
        expect(cy + 240 * fs).toBeLessThanOrEqual(stats);
        expect(cy + 32).toBeLessThanOrEqual(stats - 72);
        await act(async () => root.unmount());
        vi.restoreAllMocks();
      }
    });

    it("caps the vertical dial's width and floors its text", async () => {
      mouse(800, 900);
      await mount();
      expect(vertical()).toBe(true);
      expect(parseFloat(stage().getPropertyValue("--pw"))).toBeLessThanOrEqual(480);
      expect(floor()).toBeCloseTo(12);
    });

    it("runs the scene to the window's edges past the capped vertical stage", async () => {
      mouse(800, 900);
      await mount();
      expect(parseFloat(stage().getPropertyValue("--pw")) * Number(stage().zoom)).toBeLessThan(800);
      const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ModelDial.css"), "utf8");
      expect(css).toMatch(/\.dial-stage\[data-phone\] \{[^}]*overflow: visible; clip-path: inset\(0 -100vw\)/);
      expect(css).toMatch(/\.dial-stage\[data-phone\] \.dial-scene \{[^}]*left: -100vw; right: -100vw/);
    });

    it("turns models with a mouse drag when narrow", async () => {
      Element.prototype.setPointerCapture = () => undefined;
      mouse(700);
      await mount();
      await drag(0, -60, 4, 60, "mouse");
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
    });

    it("ignores a right-button drag", async () => {
      mouse(1440);
      await mount();
      await pointer("pointerdown", 200, 400, "mouse", 2);
      await pointer("pointermove", 200, 300, "mouse");
      await pointer("pointerup", 200, 300, "mouse");
      await settle();
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("swaps layouts on resize and keeps the pick and the view", async () => {
      const resize = mouse(1440);
      await mount();
      await key("ArrowDown");
      await key("ArrowLeft");
      await resize(700);
      expect(vertical()).toBe(true);
      expect([selected(), effort()]).toEqual(["claude-sonnet-5-5", "medium"]);
      await resize(1440);
      expect(vertical()).toBe(false);
      expect([selected(), effort()]).toEqual(["claude-sonnet-5-5", "medium"]);
      await act(async () => document.querySelector<HTMLButtonElement>(".model-dial-view")!.click());
      await resize(700);
      expect(document.querySelector(".model-dial")).toBeNull();
      expect(document.querySelector(".model-dial-view")?.textContent).toBe("Dial View");
    });
  });

  describe("on a phone", () => {
    beforeEach(() => {
      Element.prototype.setPointerCapture = () => undefined;
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    });

    it.each([
      ["short", 24, 4, 15, 0],
      ["ordinary", 60, 4, 30, 1],
      ["fast", 120, 4, 10, 1],
    ])("bounds %s swipes in both directions", async (_name, distance, moves, ms, steps) => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      const tick = vi.spyOn(phoneSwipe, "hapticTick");
      await mount();
      const landed = [];
      for (const dir of [-1, 1]) {
        tick.mockClear();
        await drag(0, dir * distance, moves, ms);
        await settle();
        landed.push(tick.mock.calls.length);
        expect(selected()).toBe(dir < 0 ? order[steps % order.length] : order[0]);
        await settle();
        expect(tick).toHaveBeenCalledTimes(steps);
      }
      expect(landed).toEqual([steps, steps]);
      expect(selected()).toBe("claude-opus-5-5");
    });

    it.each([-1, 1])("swipes effort in chat order with direction %s", async (dir) => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await drag(dir * 160, 0, 4, 30);
      expect(effort()).toBe(dir < 0 ? "Extra high" : "medium");
      expect(selected()).toBe("claude-opus-5-5");
    });

    it.each([-1, 1])("ignores incidental motion with direction %s", async (dir) => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await drag(dir * 8, dir * 6, 4, 10);
      await drag(dir * 39, dir * 8, 4, 10);
      await settle();
      expect(effort()).toBe("high");
      expect(selected()).toBe("claude-opus-5-5");
    });

    it.each([-1, 1])("locks the vertical axis and cancels without coasting with direction %s", async (dir) => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await pointer("pointerdown", 200, 400);
      for (let i = 1; i <= 4; i++) {
        await wait(10);
        await pointer("pointermove", 200 + (i === 1 ? 0 : 60), 400 + dir * 30 * i);
      }
      await pointer("pointercancel", 260, 400 + dir * 120);
      await settle();
      expect(selected()).toBe(dir < 0 ? "claude-sonnet-5-5" : "grok-4.7");
      expect(effort()).toBe("high");
      await settle();
      expect(selected()).toBe(dir < 0 ? "claude-sonnet-5-5" : "grok-4.7");
    });

    it.each([-1, 1])("keeps one effort notch through a reversal with direction %s", async (dir) => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await pointer("pointerdown", 200, 400);
      await pointer("pointermove", 200 + dir * 80, 400);
      await pointer("pointermove", 200 - dir * 160, 400);
      await pointer("pointerup", 200 - dir * 160, 400);
      expect(effort()).toBe(dir < 0 ? "Extra high" : "medium");
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("fills the screen with no text floor", async () => {
      media({ phone: true });
      await mount();
      const style = document.querySelector<HTMLElement>(".dial-stage")!.style;
      expect([style.zoom, style.getPropertyValue("--pw"), style.getPropertyValue("--ph"), style.getPropertyValue("--floor")]).toEqual(["1", "390px", "844px", ""]);
    });

    it("turns one model per drag step", async () => {
      media({ phone: true });
      await mount();
      expect(document.querySelector(".dial-stage")?.hasAttribute("data-phone")).toBe(true);
      await drag(0, -60, 4, 60);
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
      await drag(0, 60, 4, 60);
      await settle();
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("lands one model after a quick flick, with no coast", async () => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await drag(0, -40, 4, 10);
      await wait(20);
      expect(selected()).toBe("claude-sonnet-5-5");
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
      expect(document.querySelectorAll('.dial-card[aria-pressed="true"]')).toHaveLength(1);
    });

    it.each([-1, 1])("stays put when the finger rests before release with direction %s", async (dir) => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true });
      await mount();
      await pointer("pointerdown", 200, 400);
      for (let i = 1; i <= 4; i++) {
        await wait(10);
        await pointer("pointermove", 200, 400 + dir * 30 * i);
      }
      await wait(150);
      await pointer("pointerup", 200, 400 + dir * 120);
      await settle();
      expect(selected()).toBe(dir < 0 ? "claude-sonnet-5-5" : "grok-4.7");
    });

    it("moves effort one notch per horizontal swipe", async () => {
      media({ phone: true });
      await mount();
      await drag(-200, 0);
      expect(effort()).toBe("Extra high");
      await drag(200, 0);
      await drag(200, 0);
      expect(effort()).toBe("medium");
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("picks a tapped card and saves with the pick button", async () => {
      media({ phone: true });
      await mount();
      await act(async () => document.querySelector<HTMLButtonElement>('.dial-card[data-model-cell="claude-sonnet-5-5"]')!.click());
      expect(selected()).toBe("claude-sonnet-5-5");
      expect(saved()).toBeUndefined();
      await act(async () => document.querySelector<HTMLButtonElement>("[data-dial-pick]")!.click());
      expect(saved()).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", effort: "high", mode: "pinned" });
    });

    it("keeps a dial drag from the sidebar swipe", async () => {
      media({ phone: true });
      await mount();
      const swipe = vi.fn();
      document.addEventListener("touchstart", swipe);
      document.addEventListener("touchmove", swipe);
      const stage = document.querySelector(".dial-stage")!;
      await act(async () => {
        stage.dispatchEvent(new window.TouchEvent("touchstart", { bubbles: true }));
        stage.dispatchEvent(new window.TouchEvent("touchmove", { bubbles: true, cancelable: true }));
      });
      await drag(0, -60, 4, 60);
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
      expect(swipe).not.toHaveBeenCalled();
      document.removeEventListener("touchstart", swipe);
      document.removeEventListener("touchmove", swipe);
    });

    it("cancels touch moves so a flick leaves no fling to eat the next tap", async () => {
      media({ phone: true });
      await mount();
      const move = new window.TouchEvent("touchmove", { bubbles: true, cancelable: true });
      document.querySelector("[data-dial-pick]")!.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
    });

    it("ticks once per model or effort step, never on open or a clamped step", async () => {
      const vibrate = vi.fn((_pattern: VibratePattern) => true);
      Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
      media({ phone: true });
      await mount();
      await settle();
      expect(vibrate).not.toHaveBeenCalled();
      await act(async () => document.querySelector<HTMLButtonElement>('.dial-card[data-model-cell="claude-sonnet-5-5"]')!.click());
      expect(vibrate).toHaveBeenCalledTimes(1);
      await drag(0, 60, 4, 60);
      await settle();
      expect(selected()).toBe("claude-opus-5-5");
      expect(vibrate).toHaveBeenCalledTimes(2);
      await drag(-200, 0);
      await drag(-200, 0);
      expect(effort()).toBe("max");
      expect(vibrate.mock.calls.map(([pattern]) => pattern)).toEqual([10, 10, 10, [10, 40, 30]]);
      await drag(-200, 0);
      expect(vibrate).toHaveBeenCalledTimes(4);
    });

    it("stays still under reduced motion and where vibrate is missing", async () => {
      const vibrate = vi.fn(() => true);
      Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
      media({ phone: true, reduced: true });
      await mount();
      await drag(-200, 0);
      expect(effort()).toBe("Extra high");
      expect(vibrate).not.toHaveBeenCalled();
      Reflect.deleteProperty(window.navigator, "vibrate");
      await act(async () => root.unmount());
      media({ phone: true });
      await mount();
      await drag(-200, 0);
      expect(effort()).toBe("Extra high");
    });

    it.each([-1, 1])("snaps without coasting under reduced motion with direction %s", async (dir) => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      media({ phone: true, reduced: true });
      await mount();
      await drag(0, dir * 120, 4, 10);
      await settle();
      expect(selected()).toBe(dir < 0 ? "claude-sonnet-5-5" : "grok-4.7");
    });
  });

  describe.each([
    { where: "on a phone", kind: "touch", setup: () => {
      media({ phone: true });
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    } },
    { where: "with a mouse on the wide dial", kind: "mouse", setup: () => void mouse(1440) },
  ])("one model per swipe $where", ({ kind, setup }) => {
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      Element.prototype.setPointerCapture = () => undefined;
      setup();
      await mount();
    });

    const path = async (ys: number[], end = "pointerup") => {
      await pointer("pointerdown", 200, 400, kind);
      for (const y of ys) {
        await wait(16);
        await pointer("pointermove", 200, y, kind);
      }
      await pointer(end, 200, ys.at(-1)!, kind);
    };

    it.each([["slow", 60, 130], ["normal", 120, 30], ["fast", 400, 4]])("turns one model per %s swipe in both directions", async (_speed, distance, ms) => {
      for (const [dy, model] of [[-distance, "claude-sonnet-5-5"], [distance, "claude-opus-5-5"], [distance, "grok-4.7"]] as const) {
        await drag(0, dy, 4, ms, kind);
        await settle();
        expect(selected()).toBe(model);
      }
    });

    it("keeps motion under the threshold still, held or not", async () => {
      await drag(0, -39, 4, 10, kind);
      await drag(0, 39, 4, 10, kind);
      await drag(5, -39, 4, 200, kind);
      await settle();
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("turns once for each swipe in a quick run", async () => {
      for (let i = 0; i < 3; i++) await drag(0, -120, 2, 4, kind);
      await settle();
      expect(selected()).toBe("gpt-6-luna");
      for (let i = 0; i < 2; i++) await drag(0, 120, 2, 4, kind);
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
    });

    it("adds nothing for a reversal inside a swipe", async () => {
      await path([340, 400, 480, 360]);
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
    });

    it("keeps the model a cancelled swipe already turned", async () => {
      await path([380, 340], "pointercancel");
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
      await path([420, 430], "pointercancel");
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
    });

    it("turns one more model per pitch only once held", async () => {
      await pointer("pointerdown", 200, 400, kind);
      await wait(700);
      for (const y of [390, 360, 330, 294, 260, 228]) {
        await pointer("pointermove", 200, y, kind);
        await wait(16);
      }
      await settle();
      expect(selected()).toBe("gpt-6-luna");
      for (const y of [250, 294]) {
        await pointer("pointermove", 200, y, kind);
        await wait(16);
      }
      await pointer("pointerup", 200, 294, kind);
      await settle();
      expect(selected()).toBe("gpt-6.1-sol");
    });

    it("stays one model when a fast swipe rests past the hold", async () => {
      await pointer("pointerdown", 200, 400, kind);
      await wait(4);
      await pointer("pointermove", 200, 250, kind);
      await wait(4);
      await pointer("pointermove", 200, 100, kind);
      await wait(700);
      await pointer("pointermove", 200, 102, kind);
      await pointer("pointermove", 200, 96, kind);
      await pointer("pointerup", 200, 96, kind);
      await settle();
      expect(selected()).toBe("claude-sonnet-5-5");
    });
  });

  describe.each([1440, 700])("wheel at %ipx", (width) => {
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
      mouse(width);
      await mount();
    });

    const burst = async (deltas: number[], mode = 0) => {
      for (const delta of deltas) {
        await wheel(delta, mode);
        await wait(16);
      }
    };

    it.each([
      [0, [2, 6, 18, 42, 60, 34, 20, 11, 6, 3, 2, 1]],
      [1, [1, 3, 2, 1, 1]],
      [2, [1, 1]],
    ])("turns one model per burst and its momentum tail in delta mode %i", async (mode, deltas) => {
      for (const [dir, model] of [[1, "claude-sonnet-5-5"], [1, "gpt-6.1-sol"], [-1, "claude-sonnet-5-5"]] as const) {
        await burst(deltas.map((delta) => dir * delta), mode);
        expect(selected()).toBe(model);
        await wait(250);
      }
    });

    it("turns once per notch when the notches come apart", async () => {
      for (let i = 0; i < 3; i++) {
        await wheel(100);
        await wait(300);
      }
      expect(selected()).toBe("gpt-6-luna");
    });

    it("steps a rolled mouse wheel every 130 ms, not once per roll", async () => {
      for (let i = 0; i < 10; i++) {
        await wheel(100);
        await wait(60);
      }
      expect(selected()).toBe("grok-4.7");
    });

    it("steps a rolled line-mode wheel on the same gap", async () => {
      for (let i = 0; i < 10; i++) {
        await wheel(3, 1);
        await wait(60);
      }
      expect(selected()).toBe("grok-4.7");
    });

    it("keeps a trackpad flick starting on a big delta to one step", async () => {
      await burst([60, 34, 20, 11, 6, 3, 2, 1].map((delta) => delta * 1.5));
      expect(selected()).toBe("claude-sonnet-5-5");
    });

    it("turns back at once when a burst reverses", async () => {
      await burst([20, 40, 20]);
      expect(selected()).toBe("claude-sonnet-5-5");
      await burst([-20, -40, -20]);
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("ignores a brush under 16px", async () => {
      await burst([5, 5, 5]);
      await wait(250);
      await burst([-4, -4]);
      expect(selected()).toBe("claude-opus-5-5");
    });

    it("keeps one step per wheel event in List View", async () => {
      await act(async () => document.querySelector<HTMLButtonElement>(".model-dial-view")!.click());
      await act(async () => {
        for (let i = 0; i < 3; i++) document.querySelector(".model-cross-stage")!.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 4, bubbles: true, cancelable: true }));
      });
      expect(document.querySelector('[data-model-cell][aria-pressed="true"]')?.getAttribute("data-model-cell")).toBe("gpt-6-luna");
    });
  });
});

describe("ModelDial confirm", () => {
  const saves = () => dispatch.mock.calls.filter(([action]) => action.type === "setModel");
  const fills = (button: Element) => animate.mock.calls.filter(([frames], k) => animate.mock.contexts[k] === button && frames[0]?.backgroundColor === "var(--accent)");
  const rings = () => animate.mock.calls.filter(([, options]) => typeof options === "object" && options.pseudoElement === "::after");
  const click = (selector: string) => act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The dialog and dial schedule through the window timer.
    vi.spyOn(window, "setTimeout").mockImplementation((fn, ms) => setTimeout(fn as () => void, ms));
  });

  it.each([
    [false, "[data-dial-pick]"],
    [false, "[data-pick]"],
    [false, "Enter"],
    [false, '.dial-card[aria-pressed="true"]'],
    [true, "[data-dial-pick]"],
    [true, '.dial-card[aria-pressed="true"]'],
  ])("saves once before confirming and closing on phone=%s via %s", async (phone, path) => {
    media({ phone });
    await mount();
    await key("ArrowDown");
    const button = document.querySelector(path === "[data-pick]" ? path : "[data-dial-pick]")!;
    animate.mockClear();
    if (path === "Enter") await key("Enter");
    else await click(path);
    expect(saved()?.model).toBe("claude-sonnet-5-5");
    expect(saves()).toHaveLength(1);
    expect(fills(button)).toHaveLength(1);
    expect(rings()).toHaveLength(1);
    expect(dispatch.mock.invocationCallOrder.at(-1)).toBeLessThan(animate.mock.invocationCallOrder[0]!);
    if (path === "Enter") {
      expect(document.querySelector("[data-model-picker-content]")).toBeNull();
      return;
    }
    await click("[data-dial-pick]");
    await click('.dial-card[aria-pressed="true"]');
    await key("Enter");
    expect(saves()).toHaveLength(1);
    expect(fills(button)).toHaveLength(1);
    await wait(139);
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    await wait(1);
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
  });

  it("closes at once on Enter so the next keys reach the composer", async () => {
    mouse(1200);
    const composer = document.createElement("textarea");
    composer.setAttribute("data-orbit-composer", "");
    document.body.append(composer);
    await mount();
    await key("ArrowDown");
    await key("Enter");
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
    const letter = new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true });
    await act(async () => (document.activeElement ?? document.body).dispatchEvent(letter));
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    expect(letter.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(composer);
  });

  it("does nothing for a disabled selection through every commit path", async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    media({ phone: true });
    await mount({ grokSignedIn: false });
    await key("ArrowUp");
    const button = document.querySelector("[data-dial-pick]")!;
    vibrate.mockClear();
    animate.mockClear();
    await click("[data-dial-pick]");
    await click("[data-pick]");
    await click('.dial-card[aria-pressed="true"]');
    await key("Enter");
    await wait(180);
    expect(saves()).toHaveLength(0);
    expect(fills(button)).toHaveLength(0);
    expect(rings()).toHaveLength(0);
    expect(vibrate).not.toHaveBeenCalled();
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
  });

  it("keeps the accent fill and close delay without a ring under reduced motion", async () => {
    media({ reduced: true });
    await mount();
    const button = document.querySelector("[data-dial-pick]")!;
    animate.mockClear();
    await click("[data-dial-pick]");
    expect(saves()).toHaveLength(1);
    expect(fills(button)).toHaveLength(1);
    expect(rings()).toHaveLength(0);
    await wait(139);
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    await wait(1);
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
  });

  it.each([
    [true, true, false, 1],
    [true, false, false, 0],
    [false, true, false, 0],
    [true, true, true, 0],
  ])("gates the haptic on phone=%s vibration=%s reduced=%s", async (phone, vibration, reduced, ticks) => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    localStorage.setItem(phoneSwipe.VIBRATION_KEY, vibration ? "on" : "off");
    media({ phone, reduced });
    await mount();
    await click("[data-dial-pick]");
    await key("Enter");
    expect(vibrate).toHaveBeenCalledTimes(ticks);
    if (ticks) expect(vibrate).toHaveBeenCalledWith(10);
  });

  it("stays silent in a narrow mouse window", async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    mouse(700);
    await mount();
    await click("[data-dial-pick]");
    expect(saves()).toHaveLength(1);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("cancels the pending close on dismiss and confirms again after reopening", async () => {
    media();
    await mount();
    await key("Enter");
    await key("Escape");
    await wait(50);
    await click('[aria-haspopup="dialog"]');
    await wait(90);
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    await key("Enter");
    expect(saves()).toHaveLength(2);
    await wait(140);
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
  });
});

describe("ModelDial ring", () => {
  let reads = 0;
  const cap = () => document.querySelectorAll(".dial-ring .cap")[1];
  const turns = (el: Element | undefined) => animate.mock.calls.filter((_, k) => animate.mock.contexts[k] === el).map(([keyframes]) => keyframes.map((frame) => Number(String(frame.transform).slice(7, -4))));

  beforeEach(() => {
    reads = 0;
    const real = globalThis.getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (!el.classList.contains("dial-stage")) return real(el, pseudo);
      reads++;
      // SAFETY: the dial reads only getPropertyValue off the stage style.
      return { getPropertyValue: (name: string) => name === "--spring" ? "0, .8, 1" : "" } as CSSStyleDeclaration;
    });
  });

  it("places the ring without reading the spring curve", async () => {
    media();
    await mount();
    await wait(50);
    expect(reads).toBe(0);
    expect(turns(cap()).at(-1)?.at(-1)).toBe(51.8359958227294 * 3.6);
  });

  it("jumps the ring under reduced motion without reading the spring curve", async () => {
    media({ reduced: true });
    await mount();
    await wait(50);
    const before = turns(cap()).length;
    await key("ArrowDown");
    expect(turns(cap())).toHaveLength(before + 1);
    expect(turns(cap()).at(-1)).toHaveLength(1);
    expect(reads).toBe(0);
  });

  it("eases a timed sweep with one spring read and resumes an interrupted one in place", async () => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    media();
    await mount();
    await wait(50);
    const from = 51.8359958227294 * 3.6;
    await key("ArrowDown");
    expect(reads).toBe(1);
    const first = turns(cap()).at(-1)!;
    const to = first.at(-1)!;
    expect(first).toHaveLength(25);
    expect(first[0]).toBe(from);
    expect(first[12]).toBe(from + (to - from) * 0.8);
    await wait(85);
    await key("ArrowDown");
    expect(reads).toBe(2);
    expect(turns(cap()).at(-1)![0]).toBe(from + (to - from) * 0.8);
  });
});

describe("ModelDial font warm", () => {
  let load: ReturnType<typeof vi.fn<(font: string) => Promise<FontFace[]>>>;
  const trigger = (k = 0) => document.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]')[k]!;
  const loaded = () => load.mock.calls.map(([font]) => font);
  const WEIGHTS = ['400 11px "JetBrains Mono"', '500 11px "JetBrains Mono"', '600 11px "JetBrains Mono"'];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // SAFETY: the picker only schedules function callbacks.
    vi.spyOn(window, "setTimeout").mockImplementation((fn, ms) => setTimeout(fn as () => void, ms));
    load = vi.fn(async () => []);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
    Reflect.deleteProperty(window, "requestIdleCallback");
    Reflect.deleteProperty(window, "cancelIdleCallback");
  });

  it("loads the font once for every closed desktop picker", async () => {
    media();
    await render(control({ open: false }), control({ open: false }));
    await wait(1999);
    expect(load).not.toHaveBeenCalled();
    await wait(1);
    expect(loaded()).toEqual(WEIGHTS);
    await wait(10000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("waits for an idle moment when the browser has one", async () => {
    const idle: Array<() => void> = [];
    const request = vi.fn((callback: () => void, _options?: IdleRequestOptions) => idle.push(callback));
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: request });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: vi.fn() });
    media();
    await render(control({ open: false }));
    await wait(2000);
    expect(request).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });
    expect(load).not.toHaveBeenCalled();
    idle.forEach((callback) => callback());
    expect(loaded()).toEqual(WEIGHTS);
  });

  it("skips the load once a picker opens first", async () => {
    media();
    await render(control({ open: false }), control({ open: false }));
    await wait(1000);
    await act(async () => trigger(1).click());
    expect(document.querySelector(".model-dial")).not.toBeNull();
    await wait(5000);
    await key("Escape");
    await wait(10000);
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("cancels on unmount and lets the next picker take over", async () => {
    media();
    await render(control({ open: false }));
    await wait(1000);
    await render();
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
    await render(control({ open: false }));
    await wait(2000);
    expect(loaded()).toEqual(WEIGHTS);
  });

  it("cancels when the flag turns off", async () => {
    media();
    await render(control({ open: false }));
    await wait(1000);
    await render(control({ open: false, dial: false }));
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["the flag is off", false, {}],
    ["config has not loaded", modelDialEnabled(null), {}],
    ["the desktop is too narrow", true, { wide: false }],
  ])("never loads when %s", async (_, dial, screen) => {
    media(screen);
    await render(control({ open: false, dial }));
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves the phone dial to load its font on open", async () => {
    media({ wide: false, phone: true });
    await render(control({ open: false }));
    await wait(10000);
    expect(load).not.toHaveBeenCalled();
    await act(async () => trigger().click());
    expect(document.querySelector(".dial-stage")?.hasAttribute("data-phone")).toBe(true);
  });

  it("does nothing without a font API", async () => {
    Reflect.deleteProperty(document, "fonts");
    media();
    await render(control({ open: false }));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => trigger().click());
    expect(document.querySelector(".model-dial")).not.toBeNull();
  });

  it("swallows a rejected load without retrying", async () => {
    load.mockRejectedValue(new Error("offline"));
    media();
    await render(control({ open: false }));
    await wait(2000);
    await wait(10000);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
