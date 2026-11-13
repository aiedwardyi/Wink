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

type Pass = { element: Element; keyframes: Keyframe[]; finish: () => void; cancel: ReturnType<typeof vi.fn>; reverse: ReturnType<typeof vi.fn>; playbackRate: number };

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
const write = (value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
  box()!.dispatchEvent(new Event("input", { bubbles: true }));
});
const fileRow = () => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((each) => each.textContent?.includes("Memory File"))!;
const editFile = () => fileRow().closest("section")!.querySelector<HTMLButtonElement>("button.mm-action")!;
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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    getExtension: (name: string) => (name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : null),
    getParameter: () => "NVIDIA GeForce",
  }) as never);
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: Element, keyframes: Keyframe[]) {
      let finish: () => void = () => undefined;
      const run = () => new Promise((done) => { finish = () => done(undefined); });
      let next = 1;
      const pass = {
        element: this, keyframes, finish: () => finish(), cancel: vi.fn(), finished: run(), playbackRate: 1,
        effect: { updateTiming: vi.fn(), getComputedTiming: () => ({ endTime: 2 * MOTION_LARGE_MS }) },
        updatePlaybackRate: (rate: number) => { next = rate; },
        reverse: vi.fn(() => { pass.playbackRate = -next; pass.finished = run(); }),
      };
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

  it("lets no tap through the pages during the pass", async () => {
    await open();
    const [settings, memory] = pages();
    expect(settings!.hasAttribute("inert")).toBe(false);
    expect(memory!.hasAttribute("inert")).toBe(true);
    await act(async () => tab(1).click());
    expect(settings!.hidden).toBe(false);
    expect(settings!.hasAttribute("inert")).toBe(true);
    expect(memory!.hasAttribute("inert")).toBe(false);
    expect(settings!.parentElement!.classList.contains("pointer-events-none")).toBe(true);
    await finishPasses();
    expect(settings!.parentElement!.classList.contains("pointer-events-none")).toBe(false);
    await act(async () => tab(0).click());
    expect(memory!.hidden).toBe(false);
    expect(memory!.hasAttribute("inert")).toBe(true);
    expect(settings!.hasAttribute("inert")).toBe(false);
    expect(settings!.parentElement!.classList.contains("pointer-events-none")).toBe(true);
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
    await act(async () => editFile().click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), "- Uses Linux");
      box()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(puts).toEqual([]);
    await act(async () => tab(0).click());
    await settle();
    expect(puts).toEqual(["- Uses Linux"]);
  });

  it("shows the Memory File save state in its own header, not the page corner", async () => {
    await open();
    await toMemory();
    await act(async () => fileRow().click());
    await act(async () => editFile().click());
    await write("- Uses Linux");
    expect(fileRow().parentElement!.querySelector('[data-save-state="saving"]')!.textContent).toBe("Saving…");
    expect(fileRow().querySelector("[data-save-state]")).toBeNull();
    expect(host.querySelectorAll("[data-save-state]")).toHaveLength(1);
    expect(host.querySelectorAll('.relative.flex.flex-col.gap-3 > [role="status"]')).toHaveLength(0);
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

describe("Memory tab on a phone whose memory read never answers", () => {
  // a dead socket after the phone sleeps: the fetch neither answers nor fails until something aborts it
  const hangReads = (count: number) => {
    const answer = vi.mocked(fetch).getMockImplementation()!;
    let reads = 0;
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (init?.method === "PUT" || String(url).includes("/memory/topics/") || ++reads > count) return answer(url, init);
      return new Promise((_, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason)));
    });
  };
  const map = () => host.querySelector(".mm");

  it("shows the map with the notes a later read brought", async () => {
    hangReads(1);
    await open();
    await toMemory();
    expect(map()).not.toBeNull();
    expect(fileRow().textContent).toContain("1 line");
    expect(map()!.textContent).toContain("Uses Windows");
  });

  it("shows the map with Retry once the read gives up", async () => {
    hangReads(Infinity);
    // native AbortSignal.timeout ignores fake timers
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const taskState: TaskResumePacket = { v: 1, threadId: "t1", botId: "bot-1", goal: "Ship the phone fix", plan: [], completed: [], evidence: [], artifacts: [], blockers: [], nextAction: "", updatedAt: 0, updatedBy: "bot", flushReason: "turn-end", turnsAtWrite: 0 };
    await open({ ...bot, tasks: [{ threadId: "t1", title: "x", createdAt: 0, taskState }] });
    await toMemory();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(map()).not.toBeNull();
    expect(map()!.querySelector(".mm-failed")!.textContent).toContain("Couldn't load memory.");
    expect(map()!.textContent).toContain("Ship the phone fix");
  });

  it("keeps an edit made before the slow first read lands", async () => {
    const answer = vi.mocked(fetch).getMockImplementation()!;
    let late: (() => void) | undefined;
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (init?.method === "PUT" || late) return answer(url, init);
      return new Promise((done) => { late = () => done(new Response(JSON.stringify({ text: "- Uses Windows", truncated: false, revision: "fixture", topics: [] }))); });
    });
    await open();
    await toMemory();
    await act(async () => fileRow().click());
    await act(async () => editFile().click());
    await write("- Uses Linux");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(puts).toEqual(["- Uses Linux"]);
    await act(async () => late!());
    await settle();
    expect(box()!.value).toBe("- Uses Linux");
  });

  it("shows Retry when the reply holds no memory", async () => {
    const answer = vi.mocked(fetch).getMockImplementation()!;
    // a body cut off by the timeout, or a proxy's page, parses as {}
    vi.mocked(fetch).mockImplementation((url, init) =>
      init?.method === "PUT" || String(url).includes("/memory/topics/") ? answer(url, init) : Promise.resolve(new Response("<html></html>")));
    await open();
    await toMemory();
    expect(map()!.querySelector(".mm-failed")!.textContent).toContain("Couldn't load memory.");
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

describe("Long-Term and Knowledge sheets", () => {
  const sheet = (kind: string) => host.querySelector<HTMLElement>(`.mm-sheet[data-kind="${kind}"]`);
  const wide = async () => {
    width(1280);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("mm") ? 1280 : 0; });
    await open();
    await toMemory();
    await act(async () => fold("long").click());
  };

  it("closes by playing its own open back, with the map never fading", async () => {
    await wide();
    const swing = passes.filter((each) => each.element === sheet("long"));
    expect(swing).toHaveLength(1);
    await act(async () => sheet("long")!.querySelector<HTMLButtonElement>(".mm-close")!.click());
    expect(host.querySelector(".mm")!.hasAttribute("data-closing")).toBe(false);
    expect(sheet("long")!.hasAttribute("data-leaving")).toBe(true);
    expect(swing[0]!.reverse).toHaveBeenCalledTimes(1);
    expect(swing[0]!.playbackRate).toBeLessThan(0);
    expect(passes.filter((each) => each.element === sheet("long"))).toHaveLength(1);
    await finishPasses();
    expect(sheet("long")).toBeNull();
  });

  it("turns a close around from where it is on a second click", async () => {
    await wide();
    const swing = passes.find((each) => each.element === sheet("long"))!;
    await act(async () => sheet("long")!.querySelector<HTMLButtonElement>(".mm-close")!.click());
    await act(async () => { fold("long").focus(); fold("long").click(); });
    expect(swing.reverse).toHaveBeenCalledTimes(2);
    expect(swing.playbackRate).toBe(1);
    expect(sheet("long")!.hasAttribute("data-leaving")).toBe(false);
    expect(passes.filter((each) => each.element === sheet("long"))).toHaveLength(1);
    expect(document.activeElement).toBe(sheet("long")!.querySelector(".mm-close"));
    await finishPasses();
    expect(sheet("long")).not.toBeNull();
  });

  it("opens Knowledge from Long-Term in one click, and a click outside closes it", async () => {
    await wide();
    await act(async () => fold("knowledge").click());
    expect(sheet("long")!.hasAttribute("data-leaving")).toBe(true);
    expect(sheet("knowledge")!.hasAttribute("data-leaving")).toBe(false);
    await finishPasses();
    expect(sheet("long")).toBeNull();
    await act(async () => host.querySelector<HTMLElement>(".mm-core")!.click());
    expect(sheet("knowledge")!.hasAttribute("data-leaving")).toBe(true);
  });

  it("keeps focus on the sheet that opened while the other was still closing", async () => {
    await wide();
    await act(async () => sheet("long")!.querySelector<HTMLButtonElement>(".mm-close")!.click());
    await act(async () => fold("knowledge").click());
    await finishPasses();
    expect(document.activeElement).toBe(sheet("knowledge")!.querySelector(".mm-close"));
  });

  it("closes at once under reduced motion, leaving the open's animations alone", async () => {
    await wide();
    const swing = passes.find((each) => each.element === sheet("long"))!;
    reduced = true;
    await act(async () => sheet("long")!.querySelector<HTMLButtonElement>(".mm-close")!.click());
    await settle();
    expect(swing.reverse).not.toHaveBeenCalled();
    expect(sheet("long")).toBeNull();
    expect(document.activeElement).toBe(fold("long"));
  });

  it("cancels the open's motion, mist and specks included, when the map unmounts", async () => {
    await wide();
    const mine = passes.filter((each) => host.querySelector(".mm")!.contains(each.element));
    expect(mine.some((each) => each.element.classList.contains("mm-mist"))).toBe(true);
    expect(mine.some((each) => each.element.classList.contains("mm-specks"))).toBe(true);
    await act(async () => root.unmount());
    for (const each of mine) expect(each.cancel).toHaveBeenCalled();
  });

  it("opens Muscle Memory from Long-Term in one click", async () => {
    await wide();
    await act(async () => fold("muscle").click());
    expect(sheet("long")!.hasAttribute("data-leaving")).toBe(true);
    expect(sheet("muscle")!.textContent).toContain("Nothing yet.");
    expect(fold("muscle").getAttribute("aria-expanded")).toBe("true");
  });

  it("shows the same save state beside Done when you edit Long-Term", async () => {
    await wide();
    await act(async () => [...sheet("long")!.querySelectorAll<HTMLButtonElement>(".mm-action")].find((each) => each.textContent === "Edit")!.click());
    await settle();
    await write("- Uses Linux");
    const state = sheet("file")!.querySelector('.mm-sheet-head [data-save-state="saving"]')!;
    expect(state.textContent).toBe("Saving…");
    expect(state.nextElementSibling!.textContent).toBe("Done");
    expect(host.querySelectorAll("[data-save-state]")).toHaveLength(1);
  });

  describe("through a phone-width resize", () => {
    let mm = 1280;
    let observers: (() => void)[] = [];
    const resize = (next: number) => act(async () => { mm = next; for (const each of observers) each(); });
    beforeEach(() => {
      mm = 1280;
      observers = [];
      vi.stubGlobal("ResizeObserver", class { constructor(fn: () => void) { observers.push(fn); } observe() {} disconnect() {} });
    });
    const wideAt = async () => {
      width(1280);
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("mm") ? mm : 0; });
      await open();
      await toMemory();
      await act(async () => fold("long").click());
    };

    it("plays the open on the sheet it shows again", async () => {
      await wideAt();
      await resize(600);
      await resize(1280);
      expect(passes.filter((each) => each.element === sheet("long"))).toHaveLength(1);
    });

    it("cancels the open's motion, mist and specks included, when the layout turns to phone", async () => {
      await wideAt();
      const mine = passes.filter((each) => host.querySelector(".mm")!.contains(each.element));
      expect(mine.some((each) => each.element.classList.contains("mm-mist"))).toBe(true);
      await resize(600);
      for (const each of mine) expect(each.cancel).toHaveBeenCalled();
    });

    it("keeps the editor up when a card opened on the phone layout", async () => {
      await wideAt();
      await act(async () => [...sheet("long")!.querySelectorAll<HTMLButtonElement>(".mm-action")].find((each) => each.textContent === "Edit")!.click());
      await resize(600);
      await act(async () => fold("long").click());
      await resize(1280);
      expect(sheet("file")).not.toBeNull();
    });
  });

  it("points a hand at every enabled button in Bot details", async () => {
    await open();
    expect(panel().className).toContain("[&_:is(button:not(:disabled),summary)]:cursor-pointer");
  });
});
