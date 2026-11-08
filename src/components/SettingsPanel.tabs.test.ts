// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { MOTION_LARGE_MS, MOTION_MODERATE_MS } from "@/lib/motion";
import { SWIPE_MOTION_MS } from "@/lib/phone-swipe";
import { Presence } from "@/lib/use-presence";
import type { Bot, TaskResumePacket } from "@/state/store";

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

import "./MemoryMap";
import { SettingsPanel } from "./SettingsPanel";

const bot: Bot = {
  id: "bot-1", threadId: "t1", name: "Mentor", title: "", description: "",
  notifications: false, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-3-5-sonnet", mode: "automatic" }, messages: [],
};

type Pass = { element: Element; keyframes: Keyframe[]; finish: () => void; cancel: ReturnType<typeof vi.fn> };

let host: HTMLDivElement;
let root: Root;
let time: number;
let reduced: boolean;
let passes: Pass[];
let puts: string[];
const vibrate = vi.fn();
const panel = () => host.querySelector<HTMLElement>("[data-settings-panel]")!;
const pages = () => [...panel().querySelectorAll<HTMLElement>(".absolute.inset-0.overflow-y-auto")];
const tab = (index: number) => panel().querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]!;
const onMemory = () => tab(1).getAttribute("aria-selected") === "true";
const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory"]');
const fileRow = () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((each) => each.textContent?.includes("Memory File"))!;
const closes = () => dispatch.mock.calls.filter(([action]) => action.type === "toggleSettings");

function Harness({ of = bot }: { of?: Bot }) {
  const [open, setOpen] = useState(true);
  dispatch.mockImplementation((action) => {
    if (action.type === "toggleSettings") setOpen(action.open);
  });
  return createElement(I18nProvider, null, createElement(Presence, { open, children: (closing: boolean) => createElement(SettingsPanel, { bot: of, closing }) }));
}

function touch(type: string, x: number, y = 200, target: Element = panel(), dt = 16) {
  time += dt;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
  return event;
}

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const release = async () => { await act(async () => { touch("touchend", 0); }); await act(async () => { await vi.advanceTimersByTimeAsync(SWIPE_MOTION_MS); }); };
const finishPasses = () => act(async () => { for (const each of passes) each.finish(); await vi.advanceTimersByTimeAsync(0); });
const open = async (of = bot) => { await act(async () => root.render(createElement(Harness, { of }))); await settle(); };
const toMemory = async () => { await act(async () => tab(1).click()); await settle(); await finishPasses(); };
const toSettings = async () => { await act(async () => tab(0).click()); await settle(); await finishPasses(); };
const drag = async (from: number, to: number) => { touch("touchstart", from); await act(async () => { touch("touchmove", to); }); };
const fold = (kind: string) => host.querySelector<HTMLButtonElement>(`button.mm-panel[data-kind="${kind}"]`)!;

function width(value: number) {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(value);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  time = 0;
  reduced = false;
  passes = [];
  puts = [];
  dispatch.mockReset();
  vibrate.mockReset();
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("reduced-motion") ? reduced : window.innerWidth < 768,
    media: query, onchange: null,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => true,
    addEventListener: () => undefined, removeEventListener: () => undefined,
  }));
  width(392);
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: Element, keyframes: Keyframe[]) {
      let finish: () => void = () => undefined;
      const finished = new Promise((done) => { finish = () => done(undefined); });
      const pass = { element: this, keyframes, finish: () => finish(), cancel: vi.fn(), finished, reverse: vi.fn() };
      passes.push(pass);
      return pass;
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const { text } = JSON.parse(String(init.body));
      puts.push(text);
      return new Response(JSON.stringify({ ok: true, truncated: false, revision: `r:${text}` }));
    }
    if (url.includes("/memory/topics/")) return new Response(JSON.stringify({ name: "prefs.md", text: "Likes tea in the morning" }));
    return new Response(JSON.stringify({ text: "- Uses Windows", truncated: false, revision: "fixture", topics: [{ name: "prefs.md", bytes: 3 }, { name: "work.md", bytes: 4 }] }));
  }));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  window.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Bot details tab pass", () => {
  it("moves both pages by the tab order on a phone and keeps them up until it ends", async () => {
    await open();
    await act(async () => tab(1).click());
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    const [settings, memory] = pages();
    const [incoming, outgoing] = passes.filter((each) => each.element === memory || each.element === settings);
    expect(incoming!.element).toBe(memory);
    expect(incoming!.keyframes[0]).toMatchObject({ transform: "translate3d(40px, 0, 0)", opacity: 0 });
    expect(outgoing!.element).toBe(settings);
    expect(outgoing!.keyframes.at(-1)).toMatchObject({ transform: "translate3d(-40px, 0, 0)", opacity: 0 });
    expect(settings!.hidden).toBe(false);
    await finishPasses();
    expect(settings!.hidden).toBe(true);
    expect(incoming!.cancel).toHaveBeenCalled();
    passes = [];
    await act(async () => tab(0).click());
    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    expect(passes.find((each) => each.element === settings)!.keyframes[0]).toMatchObject({ transform: "translate3d(-40px, 0, 0)" });
    await finishPasses();
    expect(memory!.hidden).toBe(true);
  });

  it("never shows both pages at once on a phone", async () => {
    await open();
    for (const to of [1, 0]) {
      passes = [];
      await act(async () => tab(to).click());
      await act(async () => { await vi.advanceTimersByTimeAsync(16); });
      const incoming = passes.find((each) => each.element === pages()[to])!;
      const outgoing = passes.find((each) => each.element === pages()[1 - to])!;
      expect(incoming.keyframes[1]).toMatchObject({ transform: incoming.keyframes[0]!.transform, opacity: 0 });
      expect(incoming.keyframes[1]!.offset).toBeGreaterThan(outgoing.keyframes[1]!.offset as number);
      await finishPasses();
    }
  });

  it("moves only the incoming page on a wide window, under the cover", async () => {
    width(1440);
    await open();
    await act(async () => tab(1).click());
    const [settings, memory] = pages();
    expect(passes.filter((each) => each.element === memory)).toHaveLength(1);
    expect(passes.find((each) => each.element === memory)!.keyframes).toHaveLength(2);
    expect(passes.filter((each) => each.element === settings)).toHaveLength(0);
    expect(settings!.hidden).toBe(true);
  });

  it("switches at once with reduced motion", async () => {
    reduced = true;
    await open();
    await act(async () => tab(1).click());
    expect(passes.filter((each) => pages().some((page) => page === each.element))).toHaveLength(0);
    expect(pages()[0]!.hidden).toBe(true);
  });

  it("times the pass on the shared token", () => {
    expect(MOTION_LARGE_MS).toBe(240);
  });
});

describe("Bot details tab swipe", () => {
  it("follows the finger from Settings to Memory", async () => {
    await open();
    const [settings, memory] = pages();
    await drag(300, 140);
    expect(settings!.style.transform).toBe("translate3d(-160px, 0, 0)");
    expect(memory!.style.transform).toBe("translate3d(232px, 0, 0)");
    expect(memory!.hidden).toBe(false);
    await release();
    expect(onMemory()).toBe(true);
    expect(vibrate).toHaveBeenCalledExactlyOnceWith(10);
    expect(closes()).toEqual([]);
    expect(settings!.hidden).toBe(true);
    expect(memory!.style.transform).toBe("");
  });

  it("goes back to Settings from Memory without closing", async () => {
    await open();
    await toMemory();
    await drag(60, 260);
    expect(pages()[1]!.style.transform).toBe("translate3d(200px, 0, 0)");
    await release();
    expect(onMemory()).toBe(false);
    expect(closes()).toEqual([]);
    expect(panel().style.transform).toBe("");
  });

  it("still closes Bot details on a right swipe from Settings", async () => {
    await open();
    await toMemory();
    await toSettings();
    await drag(40, 240);
    expect(panel().style.transform).toBe("translate3d(200px, 0, 0)");
    await release();
    expect(closes()).toEqual([[{ type: "toggleSettings", open: false }]]);
  });

  it.each([[-40, 120], [-30, 0]])("stays put for a drag of (%i, %i)", async (dx, dy) => {
    await open();
    touch("touchstart", 300);
    await act(async () => { touch("touchmove", 300 + dx, 200 + dy, panel(), 400); });
    await release();
    expect(onMemory()).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
    expect(pages()[0]!.style.transform).toBe("");
  });

  it("leaves a left drag on Memory alone", async () => {
    await open();
    await toMemory();
    touch("touchstart", 300);
    expect(touch("touchmove", 100).defaultPrevented).toBe(false);
    await release();
    expect(onMemory()).toBe(true);
  });

  it("leaves a text selection alone", async () => {
    await open();
    const range = document.createRange();
    range.selectNodeContents(tab(0));
    window.getSelection()!.addRange(range);
    touch("touchstart", 300);
    expect(touch("touchmove", 100).defaultPrevented).toBe(false);
    await release();
    expect(onMemory()).toBe(false);
  });

  it("does not swipe tabs on a wide window", async () => {
    width(1440);
    await open();
    touch("touchstart", 600);
    expect(touch("touchmove", 200).defaultPrevented).toBe(false);
    await release();
    expect(onMemory()).toBe(false);
  });
});

describe("Memory tab on return", () => {
  it("closes the Memory File and the open kinds when you leave", async () => {
    await open();
    await toMemory();
    await act(async () => fileRow().click());
    await act(async () => fold("long").click());
    expect(fold("long").getAttribute("aria-expanded")).toBe("true");
    await toSettings();
    await act(async () => { await vi.advanceTimersByTimeAsync(MOTION_LARGE_MS); });
    await toMemory();
    expect(fileRow().getAttribute("aria-expanded")).toBe("false");
    expect(fold("long").getAttribute("aria-expanded")).toBe("false");
  });

  it("saves typed text the moment you leave", async () => {
    await open();
    await toMemory();
    await act(async () => fileRow().click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), "- Uses Linux");
      box()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(puts).toEqual([]);
    await act(async () => tab(0).click());
    await settle();
    expect(puts).toEqual(["- Uses Linux"]);
  });

  it("keeps the file open through a save conflict", async () => {
    localStorage.setItem("omb-memory-draft:bot-held", JSON.stringify({ text: "mine", base: "r:older" }));
    await open({ ...bot, id: "bot-held" });
    await toMemory();
    expect(fileRow().getAttribute("aria-expanded")).toBe("true");
    await toSettings();
    await toMemory();
    expect(fileRow().getAttribute("aria-expanded")).toBe("true");
    expect(box()!.value).toBe("mine");
  });
});

describe("Knowledge and Edit", () => {
  it("reads a topic file from its Knowledge row and has no second list", async () => {
    await open();
    await toMemory();
    expect([...host.querySelectorAll("button")].some((each) => each.textContent?.startsWith("Topic Files"))).toBe(false);
    await act(async () => fold("knowledge").click());
    const row = host.querySelector<HTMLButtonElement>('button[data-topic="prefs.md"]')!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await act(async () => row.click());
    await settle();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.parentElement!.textContent).toContain("Likes tea in the morning");
    await act(async () => row.click());
    expect(row.parentElement!.textContent).not.toContain("Likes tea in the morning");
  });

  it("offers Edit in Long-Term Memory and brings the Memory File up", async () => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) { scrolled.push(this); });
    await open();
    await toMemory();
    expect(box()).toBeNull();
    await act(async () => fold("long").click());
    const edit = [...host.querySelectorAll<HTMLButtonElement>(".mm-fold button")].find((each) => each.textContent === "Edit")!;
    await act(async () => edit.click());
    expect(box()!.value).toBe("- Uses Windows");
    expect(scrolled).not.toContain(fileRow());
    await act(async () => { await vi.advanceTimersByTimeAsync(MOTION_MODERATE_MS); });
    expect(scrolled).toContain(fileRow());
  });

  it("marks only the first unfinished step as current", async () => {
    const plan: TaskResumePacket["plan"] = [{ step: "a", status: "done" }, { step: "b", status: "active" }, { step: "c", status: "pending" }];
    const taskState: TaskResumePacket = { v: 1, threadId: "t1", botId: "bot-1", goal: "Ship", plan, completed: [], evidence: [], artifacts: [], blockers: [], nextAction: "", updatedAt: 0, updatedBy: "bot", flushReason: "turn-end", turnsAtWrite: 0 };
    const tasks = [{ threadId: "t1", title: "x", createdAt: 0, taskState }];
    await act(async () => root.render(createElement(I18nProvider, null, createElement(SettingsPanel, { bot: { ...bot, tasks } }))));
    await settle();
    await toMemory();
    await settle();
    expect([...host.querySelectorAll(".mm-steps i")].map((each) => each.hasAttribute("data-now"))).toEqual([false, true, false]);
  });
});
