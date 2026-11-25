// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n-catalog";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";
import { speaker } from "@/lib/tts";

import { GlassApp } from "./GlassApp";

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const models = { default: "claude-opus-5-5", options: [{ id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Sonnet 5.5" }] };
const ready: InstanceInfo = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" }, models };
const missing: InstanceInfo = { ...ready, snapshot: { state: "unavailable" } };
const chat: Message[] = [{ id: "u1", at: 1, role: "user", kind: "text", text: "hi" }, { id: "b1", at: 2, role: "bot", kind: "text", text: "Hello" }];
const atlas = (extra: Partial<Bot> = {}): Bot => ({
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: false, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, messages: chat, hasMore: false, ...extra,
});

let root: Root | undefined;
const calls: { url: string; method: string }[] = [];

/** The real store, started from its saved snapshot; the server answers nothing. */
async function mount(bot: Bot, instances: InstanceInfo[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    return new Response("{}", { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ bots: [bot], groups: [], selectedId: bot.id, instances }));
  history.replaceState(null, "", "/glasses");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(GlassApp)));
}

const press = (key: string) => act(() => {
  (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
});
const focus = (role: string) => act(() => document.querySelector<HTMLElement>(`.glass [data-glass="${role}"]`)?.focus());
const posts = (path: RegExp) => calls.filter((call) => call.method !== "GET" && path.test(call.url));
const focused = () => document.activeElement?.getAttribute("data-glass");
const shownReply = () => document.querySelector(".glass-scroll")?.textContent;
const listen = () => document.querySelector('[data-glass="listen"]');

/** The lens's speechSynthesis: what it was asked to say, and the utterances to end. */
function lensVoice() {
  const said: string[] = [];
  type Utterance = { text: string; onend: (() => void) | null };
  const utterances: Utterance[] = [];
  const cancel = vi.fn();
  vi.stubGlobal("SpeechSynthesisUtterance", class {
    onend: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(public text: string) {}
  });
  vi.stubGlobal("speechSynthesis", {
    cancel,
    speak: (utterance: Utterance) => {
      said.push(utterance.text);
      utterances.push(utterance);
    },
  });
  return { said, utterances, cancel };
}

const talk = (from: number, to: number): Message[] => Array.from({ length: to - from }, (_, i): Message[] => [
  { id: "u" + (from + i), at: (from + i) * 2 + 1, role: "user", kind: "text", text: "ask " + (from + i) },
  { id: "b" + (from + i), at: (from + i) * 2 + 2, role: "bot", kind: "text", text: "reply " + (from + i) },
]).flat();

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  calls.length = 0;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("glasses chat after a failed turn", () => {
  const failed = (busy: boolean, error: string) => atlas({
    busy,
    messages: [...chat, { id: "u2", at: 3, role: "user", kind: "text", text: "and now?" }, { id: "e1", at: 4, role: "bot", kind: "activity", tool: { name: "error: " + error } }],
  });
  const shown = () => ({
    time: document.querySelector(".glass-time")?.textContent,
    text: document.querySelector(".glass-scroll")?.textContent,
    caret: document.querySelector(".glass-caret") !== null,
    you: document.querySelector(".glass-you")?.textContent,
  });

  it.each([
    ["stream disconnected before completion", en["errors.engine"]],
    ["something nobody planned for", en["errors.unfinished"].replace("{bot}", "Atlas")],
  ])("stops Working and shows the phone's error line for %j", async (error, text) => {
    await mount(failed(false, error), [ready]);
    expect(shown()).toEqual({ time: expect.not.stringContaining("Working"), text, caret: false, you: "and now?" });
  });

  it("keeps Working while the turn still runs", async () => {
    await mount(failed(true, "stream disconnected before completion"), [ready]);
    expect(shown()).toMatchObject({ time: "Working…", caret: true, you: "and now?" });
  });
});

describe("glasses keys", () => {
  it("two fast Enters on Send send once and stay on the chat", async () => {
    await mount(atlas(), [ready]);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      return new Promise<Response>(() => {});
    }));
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const speak = document.querySelector<HTMLInputElement>('[data-glass="speak"]');
    if (speak) speak.value = "ship it";
    focus("speak");
    await press("Enter");
    expect(document.querySelector('[data-glass="send"]')).not.toBeNull();
    focus("send");
    await press("Enter");
    await press("Enter");
    expect(posts(/\/messages/)).toHaveLength(1);
    expect(back).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-glass="send"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-glass")).toBe("speak");
  });

  it("two fast Enters on a model pick it once and stay on the chat", async () => {
    await mount(atlas(), [ready]);
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    focus("bar");
    await press("Enter");
    expect(document.querySelector(".glass-wheel")).not.toBeNull();
    await press("ArrowDown");
    await press("Enter");
    await press("Enter");
    expect(posts(/./)).toHaveLength(1);
    expect(back).toHaveBeenCalledOnce();
    expect(document.querySelector(".glass-wheel")).toBeNull();
  });

  it("Enter on the model bar does nothing when no model can be picked", async () => {
    await mount(atlas(), [missing]);
    const push = vi.spyOn(history, "pushState");
    focus("bar");
    await press("Enter");
    await press("Enter");
    expect(push).not.toHaveBeenCalled();
    expect(document.querySelector(".glass-wheel")).toBeNull();
    expect(focused()).toBe("bar");
  });
});

describe("glasses navigation", () => {
  it("ArrowDown from the newest reply reaches the model bar with the engine's usage left; ArrowUp returns, Enter opens the models", async () => {
    const used: InstanceInfo = { ...ready, rateLimits: { observedAt: new Date().toISOString(), windows: [{ id: "five_hour", usedPercent: 62, resetsAt: Date.now() + 3_600_000, windowMinutes: 300 }] } };
    await mount(atlas(), [used]);
    expect(document.querySelector(".glass-top [data-glass]")).toBeNull();
    await press("ArrowDown");
    expect(focused()).toBe("bar");
    expect(document.querySelector(".glass-bar")?.textContent).toBe("Opus 5.55h · 38% left");
    await press("ArrowUp");
    expect(focused()).toBe("speak");
    expect(shownReply()).toBe("Hello");
    await press("ArrowDown");
    await press("Enter");
    expect(document.querySelector(".glass-wheel")).not.toBeNull();
  });

  it("Read aloud sits under the bar: Enter reads the newest reply with the lens voice, Enter again stops it, ArrowUp returns to the bar", async () => {
    const synth = lensVoice();
    const clip = vi.spyOn(speaker, "speak").mockImplementation(async () => {});
    await mount(atlas(), [ready]);
    await press("ArrowDown");
    await press("ArrowDown");
    expect(focused()).toBe("listen");
    await press("Enter");
    expect(synth.said).toEqual(["Hello"]);
    expect(clip).not.toHaveBeenCalled();
    expect(listen()?.getAttribute("aria-pressed")).toBe("true");
    await press("Enter");
    expect(synth.cancel).toHaveBeenCalled();
    expect(listen()?.getAttribute("aria-pressed")).toBe("false");
    await press("Enter");
    await act(() => synth.utterances.at(-1)?.onend?.());
    expect(listen()?.getAttribute("aria-pressed")).toBe("false");
    await press("ArrowUp");
    expect(focused()).toBe("bar");
  });

  it("ArrowUp walks the 10 newest replies, then See 10 more; Enter adds 10 older until none are left", async () => {
    await mount(atlas({ messages: talk(0, 25) }), [ready]);
    expect(shownReply()).toBe("reply 24");
    for (let i = 0; i < 9; i++) await press("ArrowUp");
    expect(shownReply()).toBe("reply 15");
    await press("ArrowUp");
    expect(focused()).toBe("older");
    expect(document.querySelector(".glass-older")?.textContent).toBe("See 10 more");
    await press("ArrowDown");
    expect([focused(), shownReply()]).toEqual(["speak", "reply 15"]);
    await press("ArrowUp");
    await press("Enter");
    expect([focused(), shownReply()]).toEqual(["speak", "reply 14"]);
    for (let i = 0; i < 9; i++) await press("ArrowUp");
    expect(shownReply()).toBe("reply 5");
    await press("ArrowUp");
    await press("Enter");
    expect([focused(), shownReply()]).toEqual(["speak", "reply 4"]);
    for (let i = 0; i < 5; i++) await press("ArrowUp");
    expect([focused(), shownReply()]).toEqual(["speak", "reply 0"]);
    expect(document.querySelector(".glass-older")).toBeNull();
  });

  it("See 10 more fetches the page before the oldest loaded message and shows the reply it brings", async () => {
    await mount(atlas({ messages: talk(1, 4), hasMore: true }), [ready]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push({ url: String(url), method: "GET" });
      return String(url).includes("before=u1")
        ? new Response(JSON.stringify({ messages: talk(0, 1), hasMore: false }), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response("{}", { status: 404 });
    }));
    for (let i = 0; i < 3; i++) await press("ArrowUp");
    expect([focused(), shownReply()]).toEqual(["older", undefined]);
    await press("Enter");
    await vi.waitFor(() => expect([focused(), shownReply()]).toEqual(["speak", "reply 0"]));
    await press("ArrowUp");
    expect([focused(), shownReply()]).toEqual(["speak", "reply 0"]);
    expect(document.querySelector(".glass-older")).toBeNull();
  });

  it("a long reply opens at its start; Up and Down scroll inside it before moving on", async () => {
    const glassScroll = (el: Element) => el.classList.contains("glass-scroll");
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return glassScroll(this) ? 600 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return glassScroll(this) ? 200 : 0; });
    await mount(atlas({ messages: talk(0, 2) }), [ready]);
    const top = () => document.querySelector<HTMLElement>(".glass-scroll")?.scrollTop;
    expect([shownReply(), top()]).toEqual(["reply 1", 0]);
    await press("ArrowDown");
    expect([focused(), top()]).toEqual(["speak", 168]);
    await press("ArrowUp");
    expect([focused(), shownReply(), top()]).toEqual(["speak", "reply 1", 0]);
    await press("ArrowUp");
    expect([shownReply(), top()]).toEqual(["reply 0", 0]);
    await press("ArrowDown");
    expect([shownReply(), top()]).toEqual(["reply 0", 168]);
  });
});

describe("glasses thread fixes", () => {
  const gemini: InstanceInfo = {
    instanceId: "gem", driverKind: "antigravityAgent", displayName: "Gemini", snapshot: { state: "available" },
    models: { default: "gemini-4-carbon-high", options: [{ id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" }, { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)" }, { id: "gemini-4-carbon-low", label: "Gemini 4 Carbon (Low)" }] },
  };
  const scroll = () => document.querySelector(".glass-scroll")?.textContent;

  it("Enter on the current model row keeps a non-first Gemini tier", async () => {
    await mount(atlas({ modelSelection: { instanceId: "gem", model: "gemini-4-carbon-medium" } }), [gemini]);
    vi.spyOn(history, "back").mockImplementation(() => {});
    focus("bar");
    await press("Enter");
    expect(document.querySelector(".glass-wheel")).not.toBeNull();
    await press("Enter");
    expect(posts(/./)).toHaveLength(0);
  });

  it("keeps the failure line when a turn fails after it wrote some text", async () => {
    await mount(
      atlas({ messages: [...chat, { id: "u2", at: 3, role: "user", kind: "text", text: "and now?" }, { id: "b2", at: 4, role: "bot", kind: "text", text: "Partial" }, { id: "e1", at: 5, role: "bot", kind: "activity", tool: { name: "error: stream disconnected before completion" } }] }),
      [ready],
    );
    expect(scroll()).toBe(en["errors.engine"]);
  });

  it("does not show an engine summary as the bot's reply", async () => {
    await mount(atlas({ messages: [...chat, { id: "b2", at: 3, role: "bot", kind: "text", text: "Looking at the files", summarized: true }] }), [ready]);
    expect(scroll()).toBe("Hello");
  });

  it("brings the voice draft back when the send is rejected", async () => {
    await mount(atlas(), [ready]);
    vi.spyOn(history, "back").mockImplementation(() => {});
    const speak = document.querySelector<HTMLInputElement>('[data-glass="speak"]');
    if (speak) speak.value = "ship it";
    focus("speak");
    await press("Enter");
    focus("send");
    await press("Enter");
    await vi.waitFor(() => expect(document.querySelector(".glass-dtext")?.textContent).toBe("ship it"));
  });
});

describe("glasses voice reply", () => {
  it("a dictated reply that commits through input opens the draft, and text still being composed does not", async () => {
    await mount(atlas(), [ready]);
    const speak = document.querySelector<HTMLInputElement>('[data-glass="speak"]')!;
    speak.value = "ship";
    await act(() => {
      speak.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    });
    expect(document.querySelector(".glass-dtext")).toBeNull();
    speak.value = "ship it";
    await act(() => {
      speak.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    expect(document.querySelector(".glass-dtext")?.textContent).toBe("ship it");
    await vi.waitFor(() => expect(focused()).toBe("send"));
  });
});

describe("glasses question card", () => {
  const ask = (subtitle: string, options: string[]): Message => ({
    id: "ask", at: 3, role: "bot", kind: "options", card: { title: "Your bot has a question", subtitle, options, askUser: true, staysOpen: true },
  });
  const sent: { url: string; body: string }[] = [];
  const answering = () => {
    sent.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      if (init.method === "POST" || init.method === "PATCH") sent.push({ url: String(url), body: String(init.body) });
      return new Response("{}", { status: 404 });
    }));
  };
  const card = () => ({
    question: document.querySelector(".glass-ask-q")?.textContent,
    choices: [...document.querySelectorAll(".glass-choice")].map((choice) => choice.textContent),
  });

  it("shows the bot's open question under the newest reply with its choices", async () => {
    await mount(atlas({ messages: [...chat, ask("Prod or staging?", ["Prod", "Staging"])] }), [ready]);
    expect(shownReply()).toBe("Hello");
    expect(card()).toEqual({ question: "Prod or staging?", choices: ["Prod", "Staging"] });
    expect(document.querySelector(".glass-ask-who")?.textContent).toBe("Atlas asks");
  });

  it("Down walks the question and its choices to the bar; Enter answers like a phone tap and the card closes", async () => {
    await mount(atlas({ messages: [...chat, ask("Prod or staging?", ["Prod", "Staging"])] }), [ready]);
    answering();
    await press("ArrowDown");
    expect(focused()).toBe("ask");
    await press("ArrowDown");
    expect([focused(), document.activeElement?.textContent]).toEqual(["choice", "Prod"]);
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Staging");
    await press("ArrowDown");
    expect(focused()).toBe("bar");
    await press("ArrowUp");
    expect(document.activeElement?.textContent).toBe("Staging");
    await press("ArrowUp");
    await press("ArrowUp");
    expect(focused()).toBe("ask");
    await press("ArrowUp");
    expect([focused(), shownReply()]).toEqual(["speak", "Hello"]);
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Enter");
    expect(document.querySelector(".glass-ask")).toBeNull();
    expect(focused()).toBe("speak");
    await vi.waitFor(() => expect(sent.map((call) => call.url)).toEqual(["/api/bots/atlas/cards/ask", "/api/bots/atlas/messages"]));
    expect(JSON.parse(sent[0]!.body)).toEqual({ answered: "Staging" });
    expect(JSON.parse(sent[1]!.body)).toMatchObject({ text: "Staging", threadId: "thread-atlas", cardId: "ask" });
  });

  it("a long question scrolls before its choices", async () => {
    const question = (el: Element) => el.classList.contains("glass-ask-q");
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return question(this) ? 300 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return question(this) ? 80 : 0; });
    await mount(atlas({ messages: [...chat, ask("A long question", ["Yes"])] }), [ready]);
    const top = () => document.querySelector<HTMLElement>(".glass-ask-q")?.scrollTop;
    await press("ArrowDown");
    await press("ArrowDown");
    expect([focused(), top()]).toEqual(["ask", 48]);
    await press("ArrowUp");
    expect([focused(), top()]).toEqual(["ask", 0]);
  });

  it("a long reply's first Down reaches the question; Up from it reads the reply through", async () => {
    const glassScroll = (el: Element) => el.classList.contains("glass-scroll");
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return glassScroll(this) ? 2400 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return glassScroll(this) ? 64 : 0; });
    await mount(atlas({ messages: [...chat, ask("Prod or staging?", ["Prod", "Staging"])] }), [ready]);
    const top = () => document.querySelector<HTMLElement>(".glass-scroll")?.scrollTop;
    await press("ArrowDown");
    expect([focused(), top()]).toEqual(["ask", 0]);
    await press("ArrowUp");
    expect([focused(), top()]).toEqual(["speak", 0]);
    await press("ArrowDown");
    expect([focused(), top()]).toEqual(["speak", 32]);
  });

  it("an answered or older question does not show", async () => {
    await mount(atlas({ messages: [...chat, { ...ask("Prod?", ["Prod"]), card: { title: "Q", subtitle: "Prod?", options: ["Prod"], askUser: true, answered: "Prod" } }] }), [ready]);
    expect(document.querySelector(".glass-ask")).toBeNull();
  });
});
