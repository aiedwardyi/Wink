// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { LiveCall } from "@/lib/live-call/controller";
import type { LiveEvents } from "@/lib/live-call/engine";

import { ChatView } from "./ChatView";

const fakes = vi.hoisted(() => ({ engines: [] as Array<{ events: LiveEvents; texts: string[] }>, level: 0, micError: "", capture: vi.fn(), config: undefined as (() => Promise<Response>) | undefined, token: undefined as (() => Response | Promise<Response>) | undefined, key: false, sse: undefined as { onmessage: ((event: { data: string; lastEventId: string }) => void) | null } | undefined }));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
vi.mock("@/lib/live-call/gemini", () => ({
  GeminiLive: class {
    events!: LiveEvents;
    texts: string[] = [];
    connect(_session: unknown, events: LiveEvents) { this.events = events; fakes.engines.push(this); }
    sendAudio() {}
    audioPaused() {}
    sendText(text: string) { this.texts.push(text); }
    sendContext() {}
    sendToolResult() {}
    close() {}
  },
}));
vi.mock("@/lib/live-call/audio", () => ({
  CallAudio: class {
    playing = false;
    onIdle = () => {};
    onStart = () => {};
    async capture() { fakes.capture(); if (fakes.micError) throw Object.assign(new Error("Permission denied"), { name: fakes.micError }); }
    play() {}
    flush() {}
    close() {}
    ring() {}
    stopRing() {}
    boop() {}
    heardShare() { return 1; }
    level() { return fakes.level; }
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const atlas = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages: [], hasMore: false,
} as unknown as Bot;

const posts: string[] = [];
const fetchImpl = async (input: RequestInfo | URL) => {
  const path = String(input);
  posts.push(path);
  if (path === "/api/config") return fakes.config ? fakes.config() : Response.json({ gemini: { configured: false } });
  if (path.endsWith("/call/token") && fakes.token) return fakes.token();
  if (path.endsWith("/call/token")) return Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" });
  if (path.endsWith("/messages")) return Response.json({ ok: true }, { status: 202 });
  if (fakes.key && path.startsWith("/api/bots?")) return Response.json({ bots: [atlas], groups: [], computerControl: {} });
  return new Response("{}", { status: 404 });
};

async function saveKey(configured = true) {
  fakes.key = true;
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" }));
  await vi.waitFor(() => expect(posts.some((path) => path.startsWith("/api/bots?"))).toBe(true));
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: "qa:2", gemini: { configured } }), lastEventId: "qa:2" }));
}

async function mount(key = false) {
  vi.stubGlobal("EventSource", class { onmessage = null; constructor() { fakes.sse = this; } close() {} });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: atlas }))));
  if (!fakes.config) await saveKey(key);
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const frame = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-orbit-composer-frame]")!;
const button = (root: HTMLElement, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

async function connect(host: HTMLElement) {
  const before = fakes.engines.length;
  await act(async () => button(host, "Call Atlas")!.click());
  await vi.waitFor(() => expect(fakes.engines.length).toBe(before + 1));
  const engine = fakes.engines.at(-1)!;
  await act(async () => engine.events.ready());
  await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).not.toBeNull());
  return engine;
}

const intro = () => document.querySelector("[data-call-intro]")?.closest<HTMLElement>('[role="dialog"]') ?? null;
const pick = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;
const tokens = () => posts.filter((path) => path.endsWith("/call/token")).length;

async function type(host: HTMLElement, text: string) {
  const input = host.querySelector<HTMLTextAreaElement>("textarea[data-orbit-composer]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  posts.length = 0;
  fakes.level = 0;
  fakes.engines.length = 0;
  fakes.micError = "";
  fakes.capture.mockClear();
  fakes.config = undefined;
  fakes.token = undefined;
  fakes.key = false;
  fakes.sse = undefined;
  Reflect.deleteProperty(window, "ogb");
});

describe("live call in the message box", () => {
  it("puts the controls in the box's bottom row, with no bar above it and a quiet header button", async () => {
    const { host, unmount } = await mount();
    try {
      await connect(host);
      const box = frame(host).querySelector<HTMLElement>("[data-call-box]")!;
      expect(box.className).toContain("row-start-3");
      for (const label of ["Captions", "Mute", "End"]) expect(button(box, label)).not.toBeNull();
      expect(host.querySelector("[data-live-call]")?.querySelector("button")).toBeNull();
      const header = button(host, "Hang up on Atlas")!;
      expect(header.className).toContain("bg-accent/15");
      expect(button(box, "End")!.className).toContain("bg-danger");
      expect(header.className).not.toContain("text-white");
      expect(host.textContent).toContain("Free Gemini");

      await act(async () => button(box, "End")!.click());
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
      await connect(host);
      expect(host.textContent).not.toContain("Free Gemini");
    } finally {
      await unmount();
    }
  });

  it("keeps captions above typing and remembers the toggle", async () => {
    const first = await mount();
    try {
      const engine = await connect(first.host);
      await act(async () => engine.events.heard("Can you fix the login bug?"));
      expect(first.host.querySelector("[data-call-caption]")).toBeNull();
      const toggle = button(frame(first.host), "Captions")!;
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      await act(async () => toggle.click());
      const caption = frame(first.host).querySelector("[data-call-caption]");
      expect(caption?.textContent).toBe("YouCan you fix the login bug?");
      expect(frame(first.host).querySelector("[data-call-caption] ~ textarea")).not.toBeNull();
      await act(async () => engine.events.said("The one where sign-in loops back?"));
      expect(frame(first.host).querySelector("[data-call-caption]")?.textContent).toBe("AtlasThe one where sign-in loops back?");
      await type(first.host, "also check the reset email");
      expect(frame(first.host).querySelector("[data-call-caption]")?.textContent).toBe("AtlasThe one where sign-in loops back?");
      expect(first.host.querySelector<HTMLTextAreaElement>("textarea[data-orbit-composer]")?.value).toBe("also check the reset email");
    } finally {
      await first.unmount();
    }
    const second = await mount();
    try {
      await connect(second.host);
      expect(button(frame(second.host), "Captions")!.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await second.unmount();
    }
  });

  it("folds the job confirm open above the box with a time-left line", async () => {
    const { host, unmount } = await mount();
    try {
      const engine = await connect(host);
      await act(async () => engine.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the login page bug." } }]));
      const order = host.querySelector<HTMLElement>("[data-live-call-order]")!;
      expect(order.closest("[data-fold]")).not.toBeNull();
      expect(frame(host).contains(order)).toBe(false);
      expect(order.querySelector("[data-live-call-time-left]")).not.toBeNull();
      expect(order.textContent).toContain("Send: Fix the login page bug?");
      await act(async () => [...order.querySelectorAll("button")].find((b) => b.textContent === "Yes")!.click());
      await vi.waitFor(() => expect(posts.some((path) => path.endsWith("/api/bots/atlas/messages"))).toBe(true));
    } finally {
      await unmount();
    }
  });

  it("keeps the newest wrapped caption at the bottom", async () => {
    const { host, unmount } = await mount();
    try {
      const engine = await connect(host);
      await act(async () => button(frame(host), "Captions")!.click());
      await act(async () => engine.events.said("I am ready to help"));
      const text = frame(host).querySelector("[data-call-caption]")!.children[1] as HTMLElement;
      Object.defineProperty(text, "scrollHeight", { value: 144 });
      Object.defineProperty(text, "clientHeight", { value: 72 });
      await act(async () => engine.events.said(" with any questions you have about the volume issue."));
      expect(text.scrollTop).toBe(144);
      expect(text.scrollLeft).toBe(0);
    } finally {
      await unmount();
    }
  });

  it("drives the voice bars from the audio level by animation frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { host, unmount } = await mount();
    try {
      await connect(host);
      const bars = [...frame(host).querySelectorAll<HTMLElement>("[data-voice-bars] > span")];
      expect(bars).toHaveLength(4);
      expect(bars.every((bar) => bar.classList.contains("bg-accent"))).toBe(true);
      const scale = (bar: HTMLElement) => Number(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1] ?? 0);
      for (let i = 0; i < 5; i++) frames.shift()?.(i * 16);
      expect(scale(bars[1]!)).toBeCloseTo(0.2);
      fakes.level = 1;
      for (let i = 0; i < 30; i++) frames.shift()?.(i * 16);
      expect(scale(bars[1]!)).toBeGreaterThan(0.95);
      expect(scale(bars[0]!)).toBeLessThan(scale(bars[1]!));
    } finally {
      await unmount();
    }
  });

  it("shows the same phone button in the desktop app and calls from it", async () => {
    Object.assign(window, { ogb: { permOpenSettings: vi.fn(), speechStop: vi.fn() } });
    const { host, unmount } = await mount();
    try {
      const header = button(host, "Call Atlas")!;
      expect(header.className).toContain("size-9");
      await connect(host);
      expect(button(host, "Hang up on Atlas")).not.toBeNull();
      await act(async () => button(host, "Hang up on Atlas")!.click());
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
      await connect(host);
      await act(async () => button(frame(host), "End")!.click());
      await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
    } finally {
      await unmount();
    }
  });

  it("says the mic is off with an Open settings action in the desktop app", async () => {
    const permOpenSettings = vi.fn();
    Object.assign(window, { ogb: { permOpenSettings, speechStop: vi.fn() } });
    fakes.micError = "NotAllowedError";
    const { host, unmount } = await mount();
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      const alert = await vi.waitFor(() => host.querySelector<HTMLElement>("[data-live-call] [role=alert]")!);
      expect(alert.textContent).toBe("Microphone is off for Wink.Open settings");
      await act(async () => [...alert.querySelectorAll("button")].find((b) => b.textContent === "Open settings")!.click());
      expect(permOpenSettings).toHaveBeenCalledWith("mic");
    } finally {
      await unmount();
    }
  });

  it("saving the key does not start the call", async () => {
    fakes.token = () => Response.json({ error: "Add a Gemini key to call." }, { status: 409 });
    const { host, unmount } = await mount();
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(host.querySelector("[data-live-call]")?.getAttribute("data-live-call")).toBe("needsKey"));
      fakes.token = undefined;
      await saveKey();
      await vi.waitFor(() => expect(intro()).not.toBeNull());
      expect(tokens()).toBe(1);
      expect(fakes.engines).toHaveLength(0);
      expect(frame(host).querySelector("[data-call-box]")).toBeNull();
      await act(async () => pick(intro()!, "Start call").click());
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
    } finally {
      await unmount();
    }
  });

  it("waits for config and Start call before the first mic or token request", async () => {
    const start = vi.spyOn(LiveCall.prototype, "start");
    let finish!: (response: Response) => void;
    const config = new Promise<Response>((resolve) => { finish = resolve; });
    fakes.config = () => config;
    const { host, unmount } = await mount();
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(host.querySelector("[data-live-call]")).not.toBeNull());
      expect(start).not.toHaveBeenCalled();
      expect(tokens()).toBe(0);
      expect(fakes.capture).not.toHaveBeenCalled();
      fakes.key = true;
      await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" }));
      await vi.waitFor(() => expect(posts).toContain("/api/config"));
      await act(async () => finish(Response.json({ gemini: { configured: true } })));
      await vi.waitFor(() => expect(intro()).not.toBeNull());
      expect(start).not.toHaveBeenCalled();
      expect(tokens()).toBe(0);
      expect(fakes.capture).not.toHaveBeenCalled();
      await act(async () => pick(intro()!, "Start call").click());
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
      expect(start).toHaveBeenCalledTimes(1);
      expect(tokens()).toBe(1);
      expect(fakes.capture).toHaveBeenCalledTimes(1);
    } finally {
      finish(Response.json({ gemini: { configured: true } }));
      await unmount();
    }
  });

  it("starts once when Start call is clicked twice after saving a key", async () => {
    fakes.token = () => Response.json({ error: "Add a Gemini key to call." }, { status: 409 });
    const { host, unmount } = await mount();
    let finish!: (response: Response) => void;
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(host.querySelector("[data-live-call]")?.getAttribute("data-live-call")).toBe("needsKey"));
      await saveKey();
      const token = new Promise<Response>((resolve) => { finish = resolve; });
      fakes.token = () => token;
      const start = vi.spyOn(LiveCall.prototype, "start");
      const confirm = pick(intro()!, "Start call");
      await act(async () => { confirm.click(); confirm.click(); });
      expect(start).toHaveBeenCalledTimes(1);
      expect(confirm.disabled).toBe(true);
      expect(tokens()).toBe(2);
      expect(fakes.capture).not.toHaveBeenCalled();
      await act(async () => finish(Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" })));
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
      expect(fakes.capture).toHaveBeenCalledTimes(1);
    } finally {
      finish?.(Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" }));
      await unmount();
    }
  });

  it("first call shows the intro once", async () => {
    const { host, unmount } = await mount(true);
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(intro()).not.toBeNull());
      const card = intro()!;
      expect(card.textContent).toContain("Talk with your bot");
      expect(card.textContent).toContain("Runs on your Gemini credit. End anytime.");
      expect(pick(card, "Start call").className).toContain("bg-accent");
      expect(tokens()).toBe(0);
      expect(frame(host).querySelector("[data-call-box]")).toBeNull();
      await act(async () => pick(card, "Start call").click());
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
      await act(async () => fakes.engines[0]!.events.ready());
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).not.toBeNull());
      await vi.waitFor(() => expect(intro()).toBeNull());
      expect(button(frame(host), "End")!.className).toContain("bg-danger");
      expect(host.textContent).toContain("Free Gemini");
    } finally {
      await unmount();
    }
  });

  it("second call starts without the intro", async () => {
    const { host, unmount } = await mount(true);
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(intro()).not.toBeNull());
      await act(async () => pick(intro()!, "Start call").click());
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
      await act(async () => fakes.engines[0]!.events.ready());
      await act(async () => button(host, "Hang up on Atlas")!.click());
      await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
      await connect(host);
      expect(intro()).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("not now starts nothing", async () => {
    const { host, unmount } = await mount(true);
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(intro()).not.toBeNull());
      await act(async () => pick(intro()!, "Not now").click());
      await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
      expect(intro()).toBeNull();
      expect(tokens()).toBe(0);
      expect(fakes.engines).toHaveLength(0);
      expect(posts.some((path) => path.includes("/call/") && !path.endsWith("/call/token"))).toBe(false);
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(intro()).not.toBeNull());
    } finally {
      await unmount();
    }
  });

  it("escape or a tap outside the intro means not now", async () => {
    const { host, unmount } = await mount(true);
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(intro()).not.toBeNull());
      const backdrop = intro()!.parentElement!;
      expect(backdrop.className).toContain("backdrop-blur-[2px]");
      expect(backdrop.className).toContain("bg-black/25");
      expect(intro()!.querySelectorAll("[data-call-intro] svg")).toHaveLength(3);
      expect(intro()!.querySelector("[data-call-intro] linearGradient")).not.toBeNull();
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(intro()).not.toBeNull());
      await act(async () => intro()!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
      expect(tokens()).toBe(0);
      expect(fakes.engines).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  it("missing mic shows plain line", async () => {
    const { host, unmount } = await mount();
    try {
      for (const [error, line] of [
        ["NotFoundError", "No microphone found. Plug one in, or type in the chat instead."],
        ["OverconstrainedError", "No microphone found. Plug one in, or type in the chat instead."],
        ["NotReadableError", "Your microphone is in use by another app."],
      ] as const) {
        fakes.micError = error;
        await act(async () => button(host, "Call Atlas")!.click());
        await vi.waitFor(() => expect(host.textContent).toContain(line));
        expect(host.textContent).not.toContain(error);
      }
    } finally {
      await unmount();
    }
  });

  it("mic failure leaves no live call", async () => {
    fakes.micError = "NotFoundError";
    const { host, unmount } = await mount();
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(button(host, "Call Atlas")?.getAttribute("aria-pressed")).toBe("false"));
      expect(button(host, "Hang up on Atlas")).toBeNull();
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
      expect(button(host, "End")).toBeNull();
      fakes.micError = "";
      await connect(host);
    } finally {
      await unmount();
    }
  });

  for (const [name, fail] of [
    ["the mic is blocked", () => { fakes.micError = "NotAllowedError"; }],
    ["the network drops", () => { fakes.token = () => { throw new TypeError("Failed to fetch"); }; }],
    ["the key is missing", () => { fakes.token = () => Response.json({ error: "Add a Gemini key to call." }, { status: 409 }); }],
  ] as const) {
    it(`ends the call from the box when ${name}, then calls again`, async () => {
      fail();
      const { host, unmount } = await mount();
      try {
        await act(async () => button(host, "Call Atlas")!.click());
        await vi.waitFor(() => expect(host.querySelector("[data-live-call]")?.getAttribute("data-live-call")).toMatch(/failed|needsKey/));
        await act(async () => button(frame(host), "End")!.click());
        await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
        await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
        fakes.micError = "";
        fakes.token = undefined;
        await connect(host);
      } finally {
        await unmount();
      }
    });
  }
});
