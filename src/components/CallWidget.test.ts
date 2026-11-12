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

const fakes = vi.hoisted(() => ({ engines: [] as Array<{ events: LiveEvents; closed: boolean }>, sse: undefined as { onmessage: ((event: { data: string; lastEventId: string }) => void) | null } | undefined, puts: [] as unknown[] }));
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
    ring() {}
    stopRing() {}
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
const CONFIG = { gemini: { configured: true }, liveCall: { voice: "Kore", language: "auto" } };

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
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
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
  it("offers two voices and Auto / English / Korean, and saves each pick", async () => {
    await mount(atlas);
    expect(pills("Call voice").map((p) => [p.textContent, p.getAttribute("aria-checked")])).toEqual([["Warm", "true"], ["Deep", "false"]]);
    expect(pills("Call language").map((p) => [p.textContent, p.getAttribute("aria-checked")])).toEqual([["Auto", "true"], ["English", "false"], ["한국어", "false"]]);
    await act(async () => pills("Call voice")[1]!.click());
    expect(fakes.puts).toEqual([{ liveCall: { voice: "Charon" } }]);
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
      for (const word of ["통화 목소리", "따뜻한", "낮은", "통화 언어", "자동", "한국어", "English"]) expect(text).toContain(word);
    } finally {
      applyLocale("en");
    }
  });
});
