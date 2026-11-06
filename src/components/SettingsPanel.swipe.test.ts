import "./ProfileFields.test-dom.ts";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { SWIPE_MOTION_MS } from "@/lib/phone-swipe";
import { Presence, PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { Bot } from "@/state/store";

const dispatch = vi.hoisted(() => vi.fn());

// oxlint-disable-next-line anti-slop/no-module-mocking -- Bot details reads the shared store; this harness drives its close action.
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({
      state: { instances: [], bots: [], config: {}, mascotMotion: null },
      dispatch,
      refreshInstances: async () => undefined,
    }),
  };
});

// oxlint-disable-next-line anti-slop/no-module-mocking -- Desktop capability probes need a packaged host.
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({
    capabilities: { host: { platform: "other" }, toasts: { available: false }, localComputer: { available: false } },
    ready: true,
  }),
}));

import { SettingsPanel } from "./SettingsPanel";

const bot: Bot = {
  id: "bot-1", threadId: "t1", name: "Mentor", title: "", description: "A long description. ".repeat(30),
  notifications: false, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" }, messages: [],
};

let host: HTMLDivElement;
let root: Root;
let reduced: boolean;
let time: number;
const vibrate = vi.fn();
const panel = () => host.querySelector<HTMLElement>("[data-settings-panel]")!;

function Harness() {
  const [open, setOpen] = useState(true);
  dispatch.mockImplementation((action) => {
    if (action.type === "toggleSettings") setOpen(action.open);
  });
  return createElement(I18nProvider, null,
    createElement("button", { "data-reopen": true, onClick: () => setOpen(true) }, "Open details"),
    createElement("div", { "data-chat": bot.threadId }, createElement("textarea", { "data-draft": true, defaultValue: "Keep this draft" })),
    createElement(Presence, { open, children: (closing: boolean) => createElement(SettingsPanel, { bot, closing }) }),
  );
}

function touch(type: string, x: number, y = 200, target: Element = panel(), dt = 200) {
  time += dt;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
  return event;
}

async function release(type = "touchend") {
  await act(async () => { touch(type, 0); vi.advanceTimersByTime(SWIPE_MOTION_MS); });
}

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  time = 0;
  dispatch.mockReset();
  vibrate.mockReset();
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("reduced-motion") ? reduced : window.innerWidth < 768,
    media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => true,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  }));
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(392);
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "Memory text", revision: "fixture", topics: [] }))));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Bot details swipe", () => {
  it.each([360, 392])("follows the finger and closes on %i while keeping the chat and draft", async (width) => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    await act(async () => root.render(createElement(Harness)));
    const chat = host.querySelector<HTMLElement>("[data-chat]")!;
    chat.scrollTop = 123;
    touch("touchstart", 40);
    touch("touchmove", 200);
    expect(panel().style.transform).toBe("translate3d(160px, 0, 0)");
    expect(dispatch).not.toHaveBeenCalled();
    await release();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleSettings", open: false });
    expect(vibrate).toHaveBeenCalledExactlyOnceWith(10);
    expect(panel().style.transform).toBe(`translate3d(${width}px, 0, 0)`);
    expect(panel().style.animation).toBe("none");
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS));
    expect(panel()).toBeNull();
    expect(host.querySelector("[data-chat]")).toBe(chat);
    expect(chat.scrollTop).toBe(123);
    expect(host.querySelector<HTMLTextAreaElement>("[data-draft]")!.value).toBe("Keep this draft");
  });

  it.each([[15, 0], [30, 120], [40, 40], [-160, 0]])("keeps details open for a rejected drag (%i, %i)", async (dx, dy) => {
    await act(async () => root.render(createElement(Harness)));
    touch("touchstart", 80);
    const move = touch("touchmove", 80 + dx, 200 + dy);
    if (dy || dx < 0) expect(move.defaultPrevented).toBe(false);
    await release();
    expect(dispatch).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
    expect(panel().style.transform).toBe("");
  });

  it.each(["textarea", "input", "[data-horizontal] span"])("leaves %s in control of its drag", async (selector) => {
    await act(async () => root.render(createElement(Harness)));
    const horizontal = document.createElement("div");
    horizontal.dataset.horizontal = "";
    horizontal.style.overflowX = "auto";
    horizontal.appendChild(document.createElement("span"));
    Object.defineProperties(horizontal, { scrollWidth: { value: 600 }, clientWidth: { value: 200 } });
    panel().appendChild(horizontal);
    const target = panel().querySelector(selector)!;
    expect(target).not.toBeNull();
    touch("touchstart", 40, 200, target);
    expect(touch("touchmove", 240, 200, target).defaultPrevented).toBe(false);
    await release();
    expect(dispatch).not.toHaveBeenCalled();
    expect(panel().style.transform).toBe("");
  });

  it("cancels without closing or buzzing", async () => {
    await act(async () => root.render(createElement(Harness)));
    touch("touchstart", 40);
    touch("touchmove", 240);
    await release("touchcancel");
    expect(dispatch).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
    expect(panel().style.transform).toBe("");
  });

  it("closes immediately without sliding or buzzing with reduced motion", async () => {
    reduced = true;
    await act(async () => root.render(createElement(Harness)));
    touch("touchstart", 40);
    touch("touchmove", 240);
    expect(panel().style.transform).toBe("");
    await act(async () => { touch("touchend", 240); });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleSettings", open: false });
    expect(panel()).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not swipe on desktop", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    await act(async () => root.render(createElement(Harness)));
    touch("touchstart", 40);
    expect(touch("touchmove", 600).defaultPrevented).toBe(false);
    await release();
    expect(dispatch).not.toHaveBeenCalled();
    expect(panel().style.cssText).toBe("");
  });

  it("clears the completed swipe when reopened before the exit unmounts", async () => {
    await act(async () => root.render(createElement(Harness)));
    touch("touchstart", 40);
    touch("touchmove", 240);
    await release();
    expect(panel().style.animation).toBe("none");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-reopen]")!.click());
    expect(panel().style.cssText).toBe("");
    expect(panel().hasAttribute("data-closing")).toBe(false);
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS));
    expect(panel()).not.toBeNull();
  });
});
