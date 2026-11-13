// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot } from "@/state/store";
import { applyLocale } from "@/lib/i18n";
import type { LiveEvents } from "@/lib/live-call/engine";

import { CallHostSlot, CallWidgetSlot } from "./CallSlots";
import { CallVoicePicker } from "./CallVoicePicker";
import { ChatView } from "./ChatView";

const fakes = vi.hoisted(() => ({ engines: [] as Array<{ events: LiveEvents; closed: boolean }>, sse: undefined as { onmessage: ((event: { data: string; lastEventId: string }) => void) | null } | undefined, puts: [] as unknown[], clips: [] as Array<{ src: string; paused: boolean; onended: (() => void) | null }> }));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
vi.mock("@/lib/live-call/gemini", () => ({
  GeminiLive: class {
    events!: LiveEvents;
    closed = false;
    connect(_session: unknown, events: LiveEvents) { this.events = events; fakes.engines.push(this); }
    sendAudio() {}
    audioPaused() {}
    sendText() {}
    sendContext() {}
    sendToolResult() {}
    close() { this.closed = true; }
  },
}));
vi.mock("@/lib/live-call/audio", () => ({
  CallAudio: class {
    playing = false;
    onIdle = () => {};
    onStart = () => {};
    async capture() {}
    play() {}
    flush() {}
    close() {}
    boop() {}
    heardShare() { return 1; }
    level() { return 0; }
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (id: string, name: string) => ({
  id, threadId: `thread-${id}`, name, title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages: [], hasMore: false,
}) as unknown as Bot;
const atlas = bot("atlas", "Atlas");
const juno = bot("juno", "Juno");
const CONFIG: { gemini: { configured: boolean }; liveCall: { voice: string; language: string } } = { gemini: { configured: true }, liveCall: { voice: "Aoede", language: "auto" } };

const posts: string[] = [];
const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  posts.push(path);
  if (path === "/api/config" && init?.method === "PUT") {
    const body = JSON.parse(String(init.body));
    fakes.puts.push(body);
    return Response.json({ ...CONFIG, liveCall: { ...CONFIG.liveCall, ...body.liveCall } });
  }
  if (path === "/api/config") return Response.json(CONFIG);
  if (path.endsWith("/call/token")) return Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" });
  if (path.endsWith("/messages")) return Response.json({ ok: true }, { status: 202 });
  if (path.startsWith("/api/bots?")) return Response.json({ bots: [atlas, juno], groups: [], computerControl: {} });
  return new Response("{}", { status: 404 });
};

function Selected() {
  const { state } = useStore();
  return createElement("output", { "data-selected": state.selectedId });
}

let root: Root;
let host: HTMLElement;
const render = (chat: Bot | null) => act(async () => root.render(createElement(StoreProvider, null,
  chat ? createElement(ChatView, { bot: chat }) : null,
  createElement("aside", { "data-test-sidebar": true }, createElement(CallWidgetSlot as (props: object) => ReactNode, {})),
  createElement("section", { "data-test-settings": true }, createElement(CallVoicePicker)),
  createElement(CallHostSlot),
  createElement(Selected),
)));

async function mount(chat: Bot) {
  localStorage.setItem("wink.liveCall.intro", "1");
  vi.stubGlobal("EventSource", class { onmessage = null; constructor() { fakes.sse = this; } close() {} });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("Audio", class {
    paused = true;
    onended: (() => void) | null = null;
    constructor(public src: string) { fakes.clips.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render(chat);
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" }));
  await vi.waitFor(() => expect(posts.some((path) => path.startsWith("/api/bots?"))).toBe(true));
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: "qa:2", ...CONFIG }), lastEventId: "qa:2" }));
}

const button = (scope: ParentNode, label: string) => scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const widget = () => host.querySelector<HTMLElement>("[data-test-sidebar] [data-call-widget]");
const settings = () => host.querySelector<HTMLElement>("[data-test-settings]")!;
const preview = (name: string) => button(settings(), `Play ${name}`) ?? button(settings(), `Stop ${name}`);
const pills = (label: string) => [...settings().querySelectorAll<HTMLElement>(`[role=radiogroup][aria-label="${label}"] [role=radio]`)];

async function call() {
  await act(async () => button(host, "Call Atlas")!.click());
  await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
  await act(async () => fakes.engines[0]!.events.ready());
  await vi.waitFor(() => expect(host.querySelector("[data-call-box]")).not.toBeNull());
  return fakes.engines[0]!;
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  posts.length = 0;
  fakes.engines.length = 0;
  fakes.puts.length = 0;
  fakes.sse = undefined;
  fakes.clips.length = 0;
  CONFIG.gemini.configured = true;
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("call follows you", () => {
  it("survives a chat switch and a room, with the widget only outside the call's chat", async () => {
    await mount(atlas);
    const engine = await call();
    expect(widget()).toBeNull();

    await render(juno);
    expect(engine.closed).toBe(false);
    expect(host.querySelector("[data-call-box]")).toBeNull();
    const shown = widget()!;
    expect(shown.textContent).toContain("Atlas");
    expect(shown.textContent).toMatch(/0:0\d/);
    expect(shown.querySelector("[data-call-dot]")).not.toBeNull();
    expect(button(shown, "Mute")).not.toBeNull();

    await render(null);
    expect(engine.closed).toBe(false);
    expect(widget()).not.toBeNull();

    await render(atlas);
    expect(engine.closed).toBe(false);
    expect(widget()).toBeNull();
    expect(host.querySelector("[data-call-box]")).not.toBeNull();
  });

  it("keeps talking through a chat switch and a voice change, and shows the saved voice", async () => {
    await mount(atlas);
    const engine = await call();
    await render(juno);
    await act(async () => pills("Call voice")[1]!.click());
    await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: "qa:3", ...CONFIG, liveCall: { voice: "Alnilam", language: "auto" } }), lastEventId: "qa:3" }));
    expect(pills("Call voice")[1]!.getAttribute("aria-checked")).toBe("true");
    expect(fakes.engines).toEqual([engine]);
    expect(engine.closed).toBe(false);
    expect(button(widget()!, "Mute")).not.toBeNull();
  });

  it("says a call that dropped in another chat failed and stops its clock", async () => {
    await mount(atlas);
    const engine = await call();
    await render(juno);
    await act(async () => engine.events.closed(1006, ""));
    const shown = widget()!;
    expect(shown.querySelector("[role=alert]")?.textContent).toBe("Call failed: The call dropped");
    expect(shown.textContent).not.toMatch(/\d:\d\d/);
    expect(button(shown, "End")).not.toBeNull();
  });

  it("opens the call's chat from the widget and hangs up from it", async () => {
    await mount(atlas);
    const engine = await call();
    await render(juno);
    await act(async () => button(widget()!, "Back to the call with Atlas")!.click());
    expect(host.querySelector("[data-selected]")!.getAttribute("data-selected")).toBe("atlas");
    await act(async () => button(widget()!, "End")!.click());
    await vi.waitFor(() => expect(widget()).toBeNull());
    expect(engine.closed).toBe(true);
    expect(button(host, "Call Juno")).not.toBeNull();
  });

  it("keeps the normal Call and Send in another chat during a call", async () => {
    await mount(atlas);
    await call();
    await render(juno);
    const frame = () => host.querySelector<HTMLElement>("[data-orbit-composer-frame]")!;
    const corner = () => [...frame().querySelectorAll("button")].at(-1)!;
    expect(corner().getAttribute("aria-label")).toBe("Call Juno");
    expect(button(frame(), "End")).toBeNull();
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-orbit-composer]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "hi");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(corner().getAttribute("aria-label")).toBe("Send message");
  });

  it("switches to another bot's call on one press", async () => {
    await mount(atlas);
    const first = await call();
    await render(juno);
    await act(async () => button(host, "Call Juno")!.click());
    await vi.waitFor(() => expect(fakes.engines).toHaveLength(2));
    expect(first.closed).toBe(true);
    await act(async () => fakes.engines[1]!.events.ready());
    await vi.waitFor(() => expect(host.querySelector("[data-call-box]")).not.toBeNull());
    expect(fakes.engines[1]!.closed).toBe(false);
  });

  it("answers the order from the widget in another chat", async () => {
    await mount(atlas);
    const engine = await call();
    await render(juno);
    await act(async () => engine.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the login page bug." } }]));
    const order = widget()!.querySelector<HTMLElement>("[data-live-call-order]")!;
    expect([...order.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Ask Atlas to do this?", "Fix the login page bug."]);
    await act(async () => [...order.querySelectorAll("button")].find((b) => b.textContent === "Yes")!.click());
    await vi.waitFor(() => expect(posts).toContain("/api/bots/atlas/messages"));
  });

  it("shows a Not sent notice in the widget", async () => {
    await mount(atlas);
    const engine = await call();
    await render(juno);
    await act(async () => engine.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the login page bug." } }]));
    await act(async () => [...widget()!.querySelectorAll("button")].find((b) => b.textContent === "No")!.click());
    expect(widget()!.querySelector("[data-live-call-notice=notSent]")?.textContent).toBe("Not sent: Fix the login page bug. (declined)");
  });

  it("calls on a plain click and opens nothing on right-click", async () => {
    await mount(atlas);
    const right = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => button(host, "Call Atlas")!.dispatchEvent(right));
    expect(right.defaultPrevented).toBe(false);
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(fakes.engines).toHaveLength(0);
    await call();
  });
});

describe("call voice in Settings", () => {
  it("offers three voices and Auto / English / Korean, and saves each pick", async () => {
    await mount(atlas);
    expect(pills("Call voice").map((p) => [p.textContent, p.getAttribute("aria-checked")])).toEqual([["Jenn", "true"], ["Eddie", "false"], ["Adele", "false"]]);
    expect(pills("Call language").map((p) => [p.textContent, p.getAttribute("aria-checked")])).toEqual([["Auto", "true"], ["English", "false"], ["한국어", "false"]]);
    await act(async () => pills("Call voice")[1]!.click());
    expect(fakes.puts).toEqual([{ liveCall: { voice: "Alnilam" } }]);
    await vi.waitFor(() => expect(pills("Call voice")[1]!.getAttribute("aria-checked")).toBe("true"));
    await act(async () => pills("Call language")[2]!.click());
    expect(fakes.puts.at(-1)).toEqual({ liveCall: { language: "ko" } });
    expect(fakes.engines).toHaveLength(0);
  });

  it("labels the card in Korean", async () => {
    await mount(atlas);
    applyLocale("ko");
    try {
      await render(atlas);
      const text = settings().textContent!;
      for (const word of ["통화 목소리", "Jenn", "Eddie", "아델", "통화 언어", "자동", "한국어", "English"]) expect(text).toContain(word);
      await act(async () => button(settings(), "Jenn 들어보기")!.click());
      expect(fakes.clips.map((clip) => clip.src)).toEqual(["/voice-preview/Aoede-ko.mp3"]);
      await act(async () => button(settings(), "아델 들어보기")!.click());
      expect(fakes.clips.map((clip) => clip.src)).toEqual(["/voice-preview/Aoede-ko.mp3", "/voice-preview/Erinome-ko.mp3"]);
    } finally {
      applyLocale("en");
    }
  });

  it("labels the composer call button in Korean", async () => {
    await mount(atlas);
    applyLocale("ko");
    try {
      await render(atlas);
      const frame = host.querySelector<HTMLElement>("[data-orbit-composer-frame]")!;
      expect(button(host, "Atlas 통화 시작")).toBeNull();
      await act(async () => button(frame, "Atlas에게 전화")!.click());
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
      await act(async () => fakes.engines[0]!.events.ready());
      await vi.waitFor(() => expect(button(frame, "종료")).not.toBeNull());
      expect(button(host, "Atlas 통화 끊기")).toBeNull();
    } finally {
      applyLocale("en");
    }
  });

  it("previews in the call language, not the app's", async () => {
    await mount(atlas);
    await act(async () => pills("Call language")[2]!.click());
    await vi.waitFor(() => expect(pills("Call language")[2]!.getAttribute("aria-checked")).toBe("true"));
    await act(async () => preview("Jenn")!.click());
    expect(fakes.clips.map((clip) => clip.src)).toEqual(["/voice-preview/Aoede-ko.mp3"]);
  });

  it("previews without selecting, one clip at a time, loading none until asked", async () => {
    await mount(atlas);
    expect(fakes.clips).toHaveLength(0);
    await act(async () => preview("Eddie")!.click());
    expect(fakes.puts).toEqual([]);
    expect(pills("Call voice")[0]!.getAttribute("aria-checked")).toBe("true");
    expect(fakes.clips.map((clip) => [clip.src, clip.paused])).toEqual([["/voice-preview/Alnilam-en.mp3", false]]);
    expect(preview("Eddie")!.getAttribute("aria-label")).toBe("Stop Eddie");
    await act(async () => preview("Jenn")!.click());
    expect(fakes.clips.map((clip) => clip.paused)).toEqual([true, false]);
    expect(preview("Eddie")!.getAttribute("aria-label")).toBe("Play Eddie");
    await act(async () => fakes.clips[1]!.onended?.());
    expect(preview("Jenn")!.getAttribute("aria-label")).toBe("Play Jenn");
    await act(async () => preview("Jenn")!.click());
    await act(async () => root.render(createElement(StoreProvider, null)));
    expect(fakes.clips.at(-1)!.paused).toBe(true);
  });

  it("plays with no Gemini key", async () => {
    CONFIG.gemini.configured = false;
    await mount(atlas);
    await act(async () => preview("Jenn")!.click());
    expect(fakes.clips.map((clip) => [clip.src, clip.paused])).toEqual([["/voice-preview/Aoede-en.mp3", false]]);
  });

  it("stops and hides the preview during a live call", async () => {
    await mount(atlas);
    await act(async () => preview("Jenn")!.click());
    await call();
    expect(fakes.clips[0]!.paused).toBe(true);
    expect(preview("Jenn")).toBeNull();
    expect(preview("Eddie")).toBeNull();
  });
});
