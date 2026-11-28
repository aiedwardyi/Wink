// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

const store = vi.hoisted(() => ({ dispatch: vi.fn(), config: {} as { liveCall?: { voice: string } }, bots: [] as Bot[] }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { bots: store.bots, config: store.config }, dispatch: store.dispatch }),
}));
vi.mock("@/lib/live-call/volume", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/live-call/volume")>();
  return { ...real, setCallVolume: vi.fn(real.setCallVolume) };
});

import { applyLocale } from "@/lib/i18n";
import { setCallVolume } from "@/lib/live-call/volume";
import { LONG_PRESS_MS } from "@/lib/use-touch-drag";
import { CallSettings, CallSettingsHold } from "./CallSettings";
import { MENU_CLASS } from "./MessageMenu";

const ada = { id: "bot-1", name: "Ada", color: "iris", messages: [] } as unknown as Bot;
const tuned = { ...ada, call: { voice: "Puck", speed: 1.2 } } as Bot;
const clips: Array<{ src: string; paused: boolean; fail: boolean; volume: number; playbackRate: number }> = [];

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Audio", class {
    paused = true;
    fail = false;
    volume = 1;
    playbackRate = 1;
    onended: (() => void) | null = null;
    constructor(public src: string) { clips.push(this); }
    play() { this.paused = false; return this.fail ? Promise.reject(new Error("missing")) : Promise.resolve(); }
    pause() { this.paused = true; }
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  applyLocale("en");
  store.dispatch.mockReset();
  store.bots = [];
  store.config = {};
  clips.length = 0;
  vi.mocked(setCallVolume).mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.innerHTML = "";
});

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

const button = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const radio = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent!.startsWith(text))!;
const menu = () => document.querySelector<HTMLElement>("[data-call-settings-menu]");
const openMore = async (root: ParentNode) => act(async () => root.querySelector<HTMLButtonElement>("[data-call-more]")!.click());
const openVoices = async (root: ParentNode) => act(async () => root.querySelector<HTMLButtonElement>("[data-call-voice-toggle]")!.click());
const patches = () => store.dispatch.mock.calls.map(([action]) => action.patch.call);

async function slide(input: HTMLInputElement, value: number) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function touch(target: Element, type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [{ clientX: 10, clientY: 10 }] } });
  target.dispatchEvent(event);
  return event;
}

async function holdCall(onCall = vi.fn()) {
  const host = await render(createElement(CallSettingsHold, { bot: ada, children: createElement("button", { type: "button", "aria-label": "Call Ada", onClick: onCall }) }));
  return { host, onCall, call: button(host, "Call Ada")! };
}

async function swipe(target: Element, flick = false) {
  const events: Event[] = [];
  await act(async () => {
    for (const [type, x, y, time] of flick
      ? [["touchstart", 200, 100, 0], ["touchmove", 225, 135, 20], ["touchend", 225, 135, 25]] as const
      : [["touchstart", 200, 100, 0], ["touchmove", 200, 300, 200], ["touchend", 200, 300, 400]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] },
        timeStamp: { value: time },
      });
      target.dispatchEvent(event);
      events.push(event);
    }
  });
  return events;
}

it.each([true, false])("only closes on a downward swipe at the top on phone=%s", async (phone) => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") && phone }));
  const { call, onCall } = await holdCall();
  await act(async () => call.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  const panel = menu()!;
  Object.defineProperty(panel, "offsetHeight", { value: 400 });
  await openVoices(panel);
  const list = panel.querySelector<HTMLElement>("[data-call-voices]")!;
  list.scrollTop = 30;
  const scrolled = await swipe(list);
  expect(scrolled[1]!.defaultPrevented).toBe(false);
  expect(panel.dataset.closing).toBeUndefined();
  list.scrollTop = 0;
  const atTop = await swipe(list);
  expect(panel.dataset.closing).toBe(phone ? "true" : undefined);
  expect(atTop[1]!.defaultPrevented).toBe(phone);
  expect(onCall).not.toHaveBeenCalled();
});

it.each(["Speed", "Volume"])("keeps the menu open on a steep %s slider drag", async (label) => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
  const { call } = await holdCall();
  await act(async () => call.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  const panel = menu()!;
  if (label === "Speed") await openMore(panel);
  Object.defineProperty(panel, "offsetHeight", { value: 100 });
  const events = await swipe(panel.querySelector(`input[aria-label="${label}"]`)!, true);
  expect(panel.dataset.closing).toBeUndefined();
  expect(events[1]!.defaultPrevented).toBe(false);
  expect(events[2]!.defaultPrevented).toBe(false);
});

it("right-click on Call opens the panel and a left-click still calls", async () => {
  const { onCall, call } = await holdCall();
  await act(async () => call.click());
  expect(onCall).toHaveBeenCalledTimes(1);
  expect(menu()).toBeNull();

  const right = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  await act(async () => call.dispatchEvent(right));
  expect(right.defaultPrevented).toBe(true);
  expect(onCall).toHaveBeenCalledTimes(1);
  expect(menu()?.getAttribute("role")).toBe("dialog");
  expect(menu()?.querySelector("[data-call-settings]")).not.toBeNull();
  // the app's shared menu motion: pop-in on open, the data-closing fade on close
  expect([...menu()!.classList]).toEqual(expect.arrayContaining(MENU_CLASS.split(" ").filter((name) => !name.startsWith("py-"))));

  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(menu()?.dataset.closing).toBe("true");
});

it("closes the panel on a press outside it", async () => {
  const { call } = await holdCall();
  await act(async () => call.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await act(async () => menu()!.querySelector("button")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(menu()?.dataset.closing).toBeUndefined();
  await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(menu()?.dataset.closing).toBe("true");
});

it("long-press on Call opens the panel without placing the call", async () => {
  vi.useFakeTimers();
  const { onCall, call } = await holdCall();
  await act(async () => void touch(call, "touchstart"));
  await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS));
  expect(menu()).not.toBeNull();
  let lift!: Event;
  await act(async () => void (lift = touch(call, "touchend")));
  expect(lift.defaultPrevented).toBe(true);
  await act(async () => call.click());
  expect(onCall).not.toHaveBeenCalled();
});

it("a short tap opens nothing", async () => {
  vi.useFakeTimers();
  const { call } = await holdCall();
  await act(async () => void touch(call, "touchstart"));
  await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS / 2));
  const lift = touch(call, "touchend");
  await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS));
  expect(lift.defaultPrevented).toBe(false);
  expect(menu()).toBeNull();
});

it("closes the compact menu on a phone swipe down from the top row, and keeps it open on a voice tap", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
  const { call } = await holdCall();
  await act(async () => call.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  const panel = menu()!;
  Object.defineProperty(panel, "offsetHeight", { value: 240 });
  await act(async () => radio(panel, "Eddie").click());
  expect(panel.dataset.closing).toBeUndefined();
  const top = panel.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Answered by"]')!;
  await swipe(top);
  expect(panel.dataset.closing).toBe("true");
});

it("fits the panel and its volume slider on a phone", async () => {
  vi.stubGlobal("innerWidth", 390);
  const { call } = await holdCall();
  await act(async () => call.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(menu()!.style.width).toBe("358px");
  expect(menu()!.style.left).toBe("16px");
  expect(menu()!.querySelector('input[aria-label="Volume"]')).not.toBeNull();
  vi.stubGlobal("innerWidth", 320);
  await act(async () => call.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(menu()!.style.width).toBe("304px");
  expect(menu()!.style.left).toBe("8px");
});

it("fades the voice grid while more voices sit below, and drops the fade at the end", async () => {
  const host = await render(createElement(CallSettings, { bot: ada }));
  await openVoices(host);
  const grid = host.querySelector<HTMLElement>("[data-call-voices]")!;
  expect(grid.className).toContain("max-h-52");
  expect(grid.className).toContain("data-[cut]:[mask-image:");
  const size = { scrollHeight: 1_000, clientHeight: 208, scrollTop: 0 };
  for (const key of Object.keys(size) as Array<keyof typeof size>) Object.defineProperty(grid, key, { configurable: true, get: () => size[key] });
  await act(async () => grid.dispatchEvent(new Event("scroll")));
  expect(grid.hasAttribute("data-cut")).toBe(true);
  size.scrollTop = 792;
  await act(async () => grid.dispatchEvent(new Event("scroll")));
  expect(grid.hasAttribute("data-cut")).toBe(false);
});

it("folds Captions, Speed and Language behind More and keeps common controls one tap away", async () => {
  const host = await render(createElement(CallSettings, { bot: ada }));
  expect(host.querySelector('input[aria-label="Volume"]')).not.toBeNull();
  expect(host.querySelector('[role="radiogroup"][aria-label="Answered by"]')).not.toBeNull();
  expect(host.querySelectorAll("[data-call-voice]")).toHaveLength(3);
  expect(host.querySelector('button[role="switch"][aria-label="Captions"]')).toBeNull();
  expect(host.querySelector('input[aria-label="Speed"]')).toBeNull();
  expect(host.querySelector('[role="radiogroup"][aria-label="Style"]')).toBeNull();
  expect(button(host, "Language")).toBeNull();

  await openMore(host);
  expect(host.querySelector('button[role="switch"][aria-label="Captions"]')).not.toBeNull();
  expect(host.querySelector('input[aria-label="Speed"]')).not.toBeNull();
  expect(host.querySelector('[role="radiogroup"][aria-label="Style"]')).toBeNull();
  expect(button(host, "Language")).not.toBeNull();
});

it("keeps a non-featured picked voice visible when the voice list is folded, without duplicating it when expanded", async () => {
  store.bots = [tuned];
  const host = await render(createElement(CallSettings, { bot: tuned }));
  expect([...host.querySelectorAll<HTMLElement>("[data-call-voice]")].map((el) => el.dataset.callVoice)).toEqual(["Aoede", "Alnilam", "Erinome", "Puck"]);
  expect(radio(host, "Puck").getAttribute("aria-checked")).toBe("true");
  await openVoices(host);
  expect(host.querySelectorAll("[data-call-voice]")).toHaveLength(30);
  expect(host.querySelectorAll('[data-call-voice="Puck"]')).toHaveLength(1);
});

it("patches the bot with the whole merged call object", async () => {
  store.bots = [tuned];
  const host = await render(createElement(CallSettings, { bot: tuned }));
  await openVoices(host);
  await openMore(host);
  await act(async () => radio(host, "Kore").click());
  await slide(host.querySelector<HTMLInputElement>('input[aria-label="Speed"]')!, 0.8);
  await act(async () => button(host, "Language")!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((b) => b.textContent === "한국어")!.click());
  expect(store.dispatch.mock.calls.every(([action]) => action.type === "updateBot" && action.botId === "bot-1")).toBe(true);
  expect(patches()).toEqual([
    { voice: "Kore", speed: 1.2 },
    { voice: "Puck", speed: 0.8 },
    { voice: "Puck", speed: 1.2, language: "ko" },
  ]);
});

it("sets Auto-detect by clearing the language", async () => {
  const korean = { ...ada, call: { language: "ko", style: "calm" } } as Bot;
  store.bots = [korean];
  const host = await render(createElement(CallSettings, { bot: korean }));
  await openMore(host);
  expect(button(host, "Language")!.textContent).toBe("한국어");
  await act(async () => button(host, "Language")!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((b) => b.textContent === "Auto-detect")!.click());
  expect(patches()).toEqual([{ style: "calm", language: undefined }]);
  expect(JSON.stringify(patches()[0])).toBe('{"style":"calm"}');
});

it("shows the speed and picks the app voice until the bot has its own", async () => {
  store.config = { liveCall: { voice: "Erinome" } };
  const host = await render(createElement(CallSettings, { bot: ada }));
  const picked = [...host.querySelectorAll<HTMLElement>("[data-call-voice]")].find((card) => card.querySelector('[aria-checked="true"]'))!;
  expect(picked.dataset.callVoice).toBe("Erinome");
  expect(picked.textContent).toContain("Adele");
  expect([...host.querySelectorAll('[data-call-voice] [role="radio"] > span[aria-hidden]')].map((badge) => badge.closest("[data-call-voice]"))).toEqual([picked]);
  await openVoices(host);
  expect(host.querySelectorAll("[data-call-voice]")).toHaveLength(30);
  await openMore(host);
  expect(host.textContent).toContain("1.0x");
  expect(button(host, "Language")!.textContent).toBe("Auto-detect");
});

it("moves the device volume, not the bot", async () => {
  const host = await render(createElement(CallSettings, { bot: ada }));
  const volume = host.querySelector<HTMLInputElement>('input[aria-label="Volume"]')!;
  expect(volume.closest("div")!.textContent).toBe("Volume100%");
  await slide(volume, 0.8);
  expect(setCallVolume).toHaveBeenCalledWith(0.8);
  expect(volume.closest("div")!.textContent).toBe("Volume80%");
  expect(store.dispatch).not.toHaveBeenCalled();
});

it("plays one preview at a time and a second tap stops it", async () => {
  const host = await render(createElement(CallSettings, { bot: ada }));
  await act(async () => button(host, "Play Jenn")!.click());
  expect(clips.map((clip) => clip.src)).toEqual(["/voice-preview/Aoede-en.mp3"]);
  expect(button(host, "Stop Jenn")!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => button(host, "Play Eddie")!.click());
  expect(clips[0]!.paused).toBe(true);
  expect(clips[1]!.paused).toBe(false);
  expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
  expect(button(host, "Play Jenn")).not.toBeNull();
  await act(async () => button(host, "Stop Eddie")!.click());
  expect(clips[1]!.paused).toBe(true);
  expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
  expect(store.dispatch).not.toHaveBeenCalled();
});

async function playJenn() {
  setCallVolume(1);
  store.bots = [ada];
  store.dispatch.mockImplementation(({ patch }) => void (store.bots = [{ ...store.bots[0]!, ...patch }]));
  const panel = () => createElement(CallSettings, { bot: ada });
  const host = await render(panel());
  await act(async () => button(host, "Play Jenn")!.click());
  // the mocked store does not re-render on dispatch
  const moved = async (change: () => Promise<void>) => {
    await change();
    await act(async () => root!.render(panel()));
  };
  return { host, clip: clips[0]!, moved };
}

it("Speed changes the sample while it plays and the next one", async () => {
  const { host, clip, moved } = await playJenn();
  await openMore(host);
  expect(clip.playbackRate).toBe(1);
  await moved(() => slide(host.querySelector<HTMLInputElement>('input[aria-label="Speed"]')!, 1.3));
  expect(clip.playbackRate).toBe(1.3);
  expect(clip.paused).toBe(false);
  await act(async () => button(host, "Play Eddie")!.click());
  expect(clips[1]!.playbackRate).toBe(1.3);
});

it("a saved Calm or Lively style plays the sample at the Normal pace", async () => {
  setCallVolume(1);
  for (const style of ["calm", "lively"] as const) {
    clips.length = 0;
    const saved = { ...ada, call: { style } } as Bot;
    store.bots = [saved];
    const host = await render(createElement(CallSettings, { bot: saved }));
    await act(async () => button(host, "Play Jenn")!.click());
    expect(clips[0]!.playbackRate).toBe(1);
    expect(clips[0]!.volume).toBeCloseTo(0.7);
  }
});

it("resets the preview button when the clip will not play, and stops on unmount", async () => {
  vi.stubGlobal("Audio", class {
    paused = true;
    constructor(public src: string) { clips.push(this as never); }
    play() { return this.src.includes("Puck") ? Promise.reject(new Error("missing")) : ((this.paused = false), Promise.resolve()); }
    pause() { this.paused = true; }
  });
  const host = await render(createElement(CallSettings, { bot: ada }));
  await openVoices(host);
  await act(async () => button(host, "Play Puck")!.click());
  expect(button(host, "Play Puck")!.getAttribute("aria-pressed")).toBe("false");
  await act(async () => button(host, "Play Zephyr")!.click());
  await act(async () => root!.unmount());
  root = null;
  expect(clips.at(-1)!.paused).toBe(true);
});

it("previews in the bot's call language", async () => {
  const korean = { ...ada, call: { language: "ko" } } as Bot;
  store.bots = [korean];
  const host = await render(createElement(CallSettings, { bot: korean }));
  await act(async () => button(host, "Play Adele")!.click());
  expect(clips[0]!.src).toBe("/voice-preview/Erinome-ko.mp3");
});

it("labels the panel in Korean", async () => {
  applyLocale("ko");
  const host = await render(createElement(CallSettings, { bot: ada }));
  for (const label of ["음량", "응답", "목소리", "전체", "더보기"]) expect(host.textContent).toContain(label);
  expect(button(host, "Jenn 들어보기")).not.toBeNull();
  expect(host.querySelector('[role="radiogroup"][aria-label="목소리"]')).not.toBeNull();
  await openVoices(host);
  expect(host.textContent).toContain("밝고 산뜻한");
  await openMore(host);
  for (const label of ["자막", "속도", "언어"]) expect(host.textContent).toContain(label);
  expect(button(host, "언어")!.textContent).toBe("자동 감지");
});

it("an older answer pick that lands late never undoes the newer one", async () => {
  type Config = { liveCall: { voice: string; answer: string } };
  store.config = { liveCall: { voice: "Aoede" } };
  const landed: Array<(config: Config) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => landed.push((config) => resolve(Response.json(config))))));
  const host = await render(createElement(CallSettings, { bot: ada }));
  const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Answered by"] [role="radio"]')];
  await act(async () => radios[0]!.click());
  await act(async () => radios[1]!.click());
  await act(async () => landed[0]!({ liveCall: { voice: "Kore", answer: "bot" } }));
  expect(store.dispatch).not.toHaveBeenCalledWith({ type: "configStatus", config: { liveCall: { voice: "Kore", answer: "bot" } } });
  await act(async () => landed[1]!({ liveCall: { voice: "Kore", answer: "gemini" } }));
  expect(store.dispatch).toHaveBeenLastCalledWith({ type: "configStatus", config: { liveCall: { voice: "Kore", answer: "gemini" } } });
});

it("a call placed while the answer pick is still saving already uses it, and a failed save puts it back", async () => {
  const answers: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve))));
  store.config = { liveCall: { voice: "Aoede" } };
  const host = await render(createElement(CallSettings, { bot: ada }));
  const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Answered by"] [role="radio"]')];
  await act(async () => radios[0]!.click());
  expect(store.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "configStatus", config: { liveCall: { voice: "Aoede", answer: "bot" } } });
  await act(async () => answers[0]!(Response.json({ error: "no" }, { status: 500 })));
  expect(store.dispatch).toHaveBeenLastCalledWith({ type: "configStatus", config: { liveCall: { voice: "Aoede" } } });
});

it("picks who answers calls for the whole app, Gemini voice until he flips it", async () => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ liveCall: { voice: "Aoede", answer: "bot" } }));
  vi.stubGlobal("fetch", fetch);
  const host = await render(createElement(CallSettings, { bot: ada }));
  const group = host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Answered by"]')!;
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(radios.map((radio) => [radio.textContent, radio.getAttribute("aria-checked")])).toEqual([["Same bot", "false"], ["Gemini voice", "true"]]);
  await act(async () => radios[0]!.click());
  const [path, init] = fetch.mock.calls[0]!;
  expect(path).toBe("/api/config");
  expect(init).toMatchObject({ method: "PATCH" });
  expect(JSON.parse(String(init!.body))).toEqual({ liveCall: { answer: "bot" } });
  await vi.waitFor(() => expect(store.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { liveCall: { voice: "Aoede", answer: "bot" } } }));
});
