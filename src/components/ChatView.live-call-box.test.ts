// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import type { LiveEvents } from "@/lib/live-call/engine";

import { ChatView } from "./ChatView";

const fakes = vi.hoisted(() => ({ engines: [] as Array<{ events: LiveEvents; texts: string[] }>, level: 0, micError: "" }));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
vi.mock("@/lib/live-call/gemini", () => ({
  GeminiLive: class {
    events!: LiveEvents;
    texts: string[] = [];
    connect(_session: unknown, events: LiveEvents) { this.events = events; fakes.engines.push(this); }
    sendAudio() {}
    audioPaused() {}
    sendText(text: string) { this.texts.push(text); }
    sendToolResult() {}
    close() {}
  },
}));
vi.mock("@/lib/live-call/audio", () => ({
  CallAudio: class {
    playing = false;
    onIdle = () => {};
    onStart = () => {};
    async capture() { if (fakes.micError) throw Object.assign(new Error("Permission denied"), { name: fakes.micError }); }
    play() {}
    flush() {}
    close() {}
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
  if (path.endsWith("/call/token")) return Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" });
  if (path.endsWith("/messages")) return Response.json({ ok: true }, { status: 202 });
  return new Response("{}", { status: 404 });
};

async function mount() {
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: atlas }))));
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
  Reflect.deleteProperty(window, "ogb");
});

describe("live call in the message box", () => {
  it("puts the controls in the box's bottom row, with no bar above it and a quiet header button", async () => {
    const { host, unmount } = await mount();
    try {
      await connect(host);
      const box = frame(host).querySelector<HTMLElement>("[data-call-box]")!;
      expect(box.className).toContain("row-start-2");
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

  it("captions only when turned on, remembers it, and gives way to typing", async () => {
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
      expect(first.host.querySelector("[data-call-caption]")).toBeNull();
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
});
