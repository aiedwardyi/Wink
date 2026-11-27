// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { applyLocale } from "@/lib/i18n";
import { LiveCall } from "@/lib/live-call/controller";
import { initialDesktopCapabilities } from "@/lib/desktop";
import type { LiveEvents } from "@/lib/live-call/engine";

import { LONG_PRESS_MS } from "@/lib/use-touch-drag";
import { CallHostSlot } from "./CallSlots";
import { ChatView } from "./ChatView";
import * as desktop from "./DesktopCapabilities";

const fakes = vi.hoisted(() => ({ engines: [] as Array<{ events: LiveEvents; texts: string[] }>, level: 0, micError: "", capture: vi.fn(), frame: undefined as ((pcm: ArrayBuffer) => void) | undefined, config: undefined as (() => Promise<Response>) | undefined, token: undefined as (() => Response | Promise<Response>) | undefined, messages: undefined as (() => Response) | undefined, key: false, played: undefined as boolean | undefined, sse: undefined as { onmessage: ((event: { data: string; lastEventId: string }) => void) | null } | undefined }));
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
    async capture(onFrame: (pcm: ArrayBuffer) => void) { fakes.capture(); if (fakes.micError) throw Object.assign(new Error("Permission denied"), { name: fakes.micError }); fakes.frame = onFrame; return fakes.played; }
    async heal() { return true; }
    stopMic() {}
    play() {}
    endTurn() {}
    tune() {}
    flush() {}
    close() {}
    boop() {}
    heardShare() { return 1; }
    level() { return fakes.level; }
    micLevel() { return 0; }
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
  if (path === "/api/config") return fakes.config ? fakes.config() : Response.json({ gemini: { configured: false }, features: { voiceCalls: true } });
  if (path.endsWith("/call/token") && fakes.token) return fakes.token();
  if (path.endsWith("/call/token")) return Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" });
  if (path.endsWith("/messages")) return fakes.messages?.() ?? Response.json({ ok: true }, { status: 202 });
  if (fakes.key && path.startsWith("/api/bots?")) return Response.json({ bots: [atlas], groups: [], computerControl: {} });
  return new Response("{}", { status: 404 });
};

async function saveKey(configured = true) {
  fakes.key = true;
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" }));
  await vi.waitFor(() => expect(posts.some((path) => path.startsWith("/api/bots?"))).toBe(true));
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: "qa:2", gemini: { configured }, features: { voiceCalls: true } }), lastEventId: "qa:2" }));
}

async function mount(key = false, mic = true) {
  vi.stubGlobal("EventSource", class { onmessage = null; constructor() { fakes.sse = this; } close() {} });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  if (mic) Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: atlas }), createElement(CallHostSlot))));
  if (!fakes.config) await saveKey(key);
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const frame = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-orbit-composer-frame]")!;
const button = (root: HTMLElement, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const corner = (host: HTMLElement) => [...frame(host).querySelectorAll("button")].at(-1)!;

async function connect(host: HTMLElement, name = "Atlas") {
  const before = fakes.engines.length;
  await act(async () => button(host, `Call ${name}`)!.click());
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  posts.length = 0;
  fakes.level = 0;
  fakes.engines.length = 0;
  fakes.micError = "";
  fakes.capture.mockClear();
  fakes.frame = undefined;
  fakes.config = undefined;
  fakes.token = undefined;
  fakes.messages = undefined;
  fakes.key = false;
  fakes.played = undefined;
  fakes.sse = undefined;
  Reflect.deleteProperty(window, "ogb");
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("call button in the message box", () => {
  it("is Call while the box is empty and Send while typing, with none in the header", async () => {
    const { host, unmount } = await mount();
    try {
      expect(corner(host).getAttribute("aria-label")).toBe("Call Atlas");
      expect(host.querySelectorAll('button[aria-label="Call Atlas"]')).toHaveLength(1);
      await type(host, "hi");
      expect(corner(host).getAttribute("aria-label")).toBe("Send message");
      expect(button(host, "Call Atlas")).toBeNull();
      await type(host, "");
      expect(corner(host).getAttribute("aria-label")).toBe("Call Atlas");
    } finally {
      await unmount();
    }
  });

  it("turns into a red End during the call and back to Call after", async () => {
    const { host, unmount } = await mount();
    try {
      await connect(host);
      expect(corner(host).getAttribute("aria-label")).toBe("End");
      expect(corner(host).className).toContain("bg-danger");
      expect(button(host, "Call Atlas")).toBeNull();
      expect(button(host, "Hang up on Atlas")).toBeNull();
      await type(host, "also check the reset email");
      expect(corner(host).getAttribute("aria-label")).toBe("Send message");
      expect(button(frame(host), "End")).not.toBeNull();
      await type(host, "");
      await act(async () => corner(host).click());
      await vi.waitFor(() => expect(corner(host).getAttribute("aria-label")).toBe("Call Atlas"));
    } finally {
      await unmount();
    }
  });

  it("shows no Call button where the device has no mic", async () => {
    const { host, unmount } = await mount(false, false);
    try {
      expect(host.querySelector('button[aria-label^="Call"]')).toBeNull();
      await type(host, "hi");
      expect(corner(host).getAttribute("aria-label")).toBe("Send message");
    } finally {
      await unmount();
    }
  });

  it("keeps the keyless desktop call setup in the composer", async () => {
    Object.assign(window, { ogb: { speechStart: vi.fn() } });
    vi.spyOn(desktop, "useDesktopCapabilities").mockReturnValue({
      ready: true,
      capabilities: { ...initialDesktopCapabilities(), dictation: { available: true, engine: "apple-speech", onDevice: true } },
    });
    const { host, unmount } = await mount();
    const label = "Set up a voice in an agent profile to make calls";
    try {
      expect(button(frame(host), label)).not.toBeNull();
      expect(button(host, "Call Atlas")).toBeNull();
      await act(async () => button(frame(host), label)!.click());
      expect(frame(host).querySelector('[aria-label="Call unavailable"]')).not.toBeNull();
      expect(frame(host).querySelector('[aria-label="Call unavailable"]')!.className).toContain("bottom-full");
      await type(host, "hi");
      expect(corner(host).getAttribute("aria-label")).toBe("Send message");
      expect(button(host, label)).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("opens nothing on a right-click on Call and still calls on a left-click", async () => {
    const { host, unmount } = await mount();
    try {
      const right = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
      await act(async () => button(host, "Call Atlas")!.dispatchEvent(right));
      expect(right.defaultPrevented).toBe(false);
      expect(document.querySelector("[data-call-settings-menu]")).toBeNull();
      expect(tokens()).toBe(0);
      await connect(host);
      expect(tokens()).toBe(1);
    } finally {
      await unmount();
    }
  });

  it("puts the call settings gear before Call, opens the menu, and hides it while typing", async () => {
    const { host, unmount } = await mount();
    try {
      const gear = button(frame(host), "Call settings")!;
      expect(gear.title).toBe("Call settings");
      expect(gear.compareDocumentPosition(button(frame(host), "Call Atlas")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.querySelector("[data-call-settings-menu]")).toBeNull();
      await act(async () => gear.click());
      expect(document.querySelector("[data-call-settings-menu]")).not.toBeNull();
      expect(tokens()).toBe(0);
      await act(async () => gear.click());
      await vi.waitFor(() => expect(document.querySelector("[data-call-settings-menu]")).toBeNull());
      await type(host, "hi");
      expect(button(host, "Call settings")).toBeNull();
      await type(host, "");
      expect(button(host, "Call settings")).not.toBeNull();
      await connect(host);
      expect(tokens()).toBe(1);
    } finally {
      await unmount();
    }
  });

  it("uses the same gear in the message box as in the call, without changing the row height", async () => {
    const rem = (className: string, prefix: string) => Number(className.match(new RegExp(`(?:^| )${prefix}(-?\\d+)(?: |$)`))?.[1] ?? 0);
    const phone = (el: HTMLElement) => (rem(el.className, "max-md:size-") || rem(el.className, "size-")) - 2 * rem(el.className, "max-md:-my-");
    const { host, unmount } = await mount();
    try {
      const gear = button(frame(host), "Call settings")!;
      expect(rem(gear.className, "max-md:size-")).toBe(10);
      await type(host, "hi");
      const send = button(frame(host), "Send message")!;
      expect(phone(gear)).toBe(phone(send));
      await type(host, "");
      await connect(host);
      const live = button(frame(host), "Call settings")!;
      expect(rem(live.className, "size-")).toBe(rem(gear.className, "size-"));
      expect(rem(live.className, "max-md:size-")).toBe(10);
    } finally {
      await unmount();
    }
  });

  it("labels Call in Korean", async () => {
    applyLocale("ko");
    const { host, unmount } = await mount();
    try {
      expect(corner(host).getAttribute("aria-label")).toBe("Atlas에게 전화");
      expect(corner(host).title).toBe("Atlas에게 전화");
    } finally {
      applyLocale("en");
      await unmount();
    }
  });
});

describe("live call in the message box", () => {
  it("puts the controls in the box's bottom row, with no bar above it", async () => {
    const { host, unmount } = await mount();
    try {
      await connect(host);
      const box = frame(host).querySelector<HTMLElement>("[data-call-box]")!;
      expect(box.className).toContain("row-start-3");
      const row = [...box.querySelectorAll("button")];
      expect(row.map((b) => b.getAttribute("aria-label"))).toEqual(["Call settings", "Mute", "End"]);
      expect(new Set(row.map((b) => b.className.match(/\bsize-\d+\b/)![0])).size).toBe(1);
      expect(row.every((b) => b.className.includes("rounded-full"))).toBe(true);
      expect(row.some((b) => b.className.includes("accent"))).toBe(false);
      expect(row.filter((b) => b.className.includes("bg-danger"))).toEqual([button(box, "End")]);
      expect(frame(host).querySelectorAll('[aria-label="End"]')).toHaveLength(1);
      expect(button(box, "End")!.hasAttribute("title")).toBe(false);
      expect([...frame(host).querySelectorAll("*")].some((el) => el.children.length === 0 && el.textContent === "End")).toBe(false);
      expect(host.querySelector("[data-live-call]")?.querySelector("button")).toBeNull();
      expect(button(box, "End")!.className).toContain("bg-danger");
      expect(host.textContent).toContain("Free Gemini");

      await act(async () => button(box, "End")!.click());
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
      await connect(host);
      expect(host.textContent).not.toContain("Free Gemini");
    } finally {
      await unmount();
    }
  });

  it("shows the call settings gear that opens the small menu, and a right-click on End opens nothing", async () => {
    const { host, unmount } = await mount();
    try {
      await connect(host);
      expect(frame(host).querySelector("[data-call-settings]")).toBeNull();
      const gear = button(frame(host), "Call settings")!;
      expect(gear.title).toBe("Call settings");
      expect(gear.compareDocumentPosition(button(frame(host), "End")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await act(async () => gear.click());
      const small = document.querySelector<HTMLElement>("[data-call-settings-menu]")!;
      expect(small.querySelector('input[aria-label="Speed"]')).not.toBeNull();
      expect(frame(host).querySelector("[data-call-box]")).not.toBeNull();
      await act(async () => small.click());
      expect(document.querySelector("[data-call-settings-menu]:not([data-closing])")).not.toBeNull();
      await act(async () => {
        gear.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        gear.click();
      });
      await vi.waitFor(() => expect(document.querySelector("[data-call-settings-menu]")).toBeNull());
      await act(async () => void button(frame(host), "End")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
      expect(document.querySelector("[data-call-settings-menu]")).toBeNull();
      await act(async () => button(frame(host), "End")!.click());
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
    } finally {
      await unmount();
    }
  });

  it("c-93117b5a76ea a tap on End while the call menu is open ends the call", async () => {
    const { host, unmount } = await mount();
    try {
      await connect(host);
      await act(async () => button(frame(host), "Call settings")!.click());
      expect(document.querySelector("[data-call-settings-menu]")).not.toBeNull();
      const end = button(frame(host), "End")!;
      const touch = (type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: 10, clientY: 10 }] });
        end.dispatchEvent(event);
      };
      await act(async () => {
        touch("touchstart");
        touch("touchend");
        end.click();
      });
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
    } finally {
      await unmount();
    }
  });

  it("c-93117b5a76ea a hold on End ends the call and opens no settings", async () => {
    const { host, unmount } = await mount();
    try {
      await connect(host);
      const end = button(frame(host), "End")!;
      const touch = (type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: 10, clientY: 10 }] });
        end.dispatchEvent(event);
        return event;
      };
      vi.useFakeTimers();
      let lift: Event;
      await act(async () => {
        touch("touchstart");
        vi.advanceTimersByTime(LONG_PRESS_MS);
        lift = touch("touchend");
      });
      vi.useRealTimers();
      expect(document.querySelector("[data-call-settings-menu]")).toBeNull();
      expect(lift!.defaultPrevented).toBe(false);
      await act(async () => end.click());
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
    } finally {
      vi.useRealTimers();
      await unmount();
    }
  });

  it("Back closes the call menu first", async () => {
    const layers = new Map<string, () => void>();
    const layer = (event: Event) => {
      const { key, close } = (event as CustomEvent<{ key: string; close?: () => void }>).detail;
      if (close) layers.set(key, close);
      else layers.delete(key);
    };
    window.addEventListener("orbit:back-layer", layer);
    const { host, unmount } = await mount();
    try {
      await connect(host);
      await act(async () => button(frame(host), "Call settings")!.click());
      expect(document.querySelector("[data-call-settings-menu]")).not.toBeNull();
      expect(layers.size).toBe(1);
      await act(async () => [...layers.values()][0]!());
      await vi.waitFor(() => expect(document.querySelector("[data-call-settings-menu]")).toBeNull());
      expect(frame(host).querySelector("[data-call-box]")).not.toBeNull();
    } finally {
      window.removeEventListener("orbit:back-layer", layer);
      await unmount();
    }
  });

  it("shows captions by default, above typing, and the menu switch turns them off for good", async () => {
    const first = await mount();
    try {
      const engine = await connect(first.host);
      expect(button(frame(first.host), "Captions")).toBeNull();
      await act(async () => engine.events.heard("Can you fix the login bug?"));
      const caption = frame(first.host).querySelector("[data-call-caption]");
      expect(caption?.textContent).toBe("YouCan you fix the login bug?");
      expect(frame(first.host).querySelector("[data-call-caption] ~ textarea")).not.toBeNull();
      await act(async () => engine.events.said("The one where sign-in loops back?"));
      expect(frame(first.host).querySelector("[data-call-caption]")?.textContent).toBe("AtlasThe one where sign-in loops back?");
      await type(first.host, "also check the reset email");
      expect(frame(first.host).querySelector("[data-call-caption]")?.textContent).toBe("AtlasThe one where sign-in loops back?");
      expect(first.host.querySelector<HTMLTextAreaElement>("textarea[data-orbit-composer]")?.value).toBe("also check the reset email");
      await act(async () => button(frame(first.host), "Call settings")!.click());
      const toggle = button(document.body, "Captions")!;
      expect(toggle.getAttribute("role")).toBe("switch");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(frame(first.host).querySelector("[data-call-caption]")).toBeNull();
    } finally {
      await first.unmount();
    }
    expect(localStorage.getItem("wink.liveCall.captions")).toBe("0");
    const second = await mount();
    try {
      await type(second.host, "");
      const engine = await connect(second.host);
      await act(async () => engine.events.heard("Still off"));
      expect(frame(second.host).querySelector("[data-call-caption]")).toBeNull();
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
      expect([...order.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Ask Atlas to do this?", "Fix the login page bug."]);
      expect(order.querySelector("p + p")!.className).toContain("font-medium");
      await act(async () => [...order.querySelectorAll("button")].find((b) => b.textContent === "Yes")!.click());
      await vi.waitFor(() => expect(posts.some((path) => path.endsWith("/api/bots/atlas/messages"))).toBe(true));
    } finally {
      await unmount();
    }
  });

  it("asks in Korean which bot gets the order", async () => {
    const { host, unmount } = await mount();
    try {
      const engine = await connect(host);
      applyLocale("ko");
      await act(async () => engine.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "체크리스트를 워드 파일로 만들어 줘" } }]));
      const order = host.querySelector<HTMLElement>("[data-live-call-order]")!;
      expect([...order.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Atlas에게 이렇게 요청할까요?", "체크리스트를 워드 파일로 만들어 줘"]);
      expect(pick(order, "예")).toBeDefined();
    } finally {
      applyLocale("en");
      await unmount();
    }
  });

  it("shows an order that was not sent in the bar, en and ko", async () => {
    const { host, unmount } = await mount();
    try {
      const engine = await connect(host);
      await act(async () => engine.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "Fix the login page bug." } }]));
      await act(async () => pick(host.querySelector<HTMLElement>("[data-live-call-order]")!, "No")!.click());
      expect(host.querySelector("[data-live-call-notice=notSent]")?.textContent).toBe("Not sent: Fix the login page bug. (declined)");
      applyLocale("ko");
      await act(async () => engine.events.toolCall([{ id: "t2", name: "propose_work", args: { order: "로그인 버그 고쳐 줘" } }]));
      expect(host.querySelector("[data-live-call-notice]")).toBeNull();
      await act(async () => pick(host.querySelector<HTMLElement>("[data-live-call-order]")!, "아니요")!.click());
      expect(host.querySelector("[data-live-call-notice=notSent]")?.textContent).toBe("보내지 않음: 로그인 버그 고쳐 줘 (거절됨)");
    } finally {
      applyLocale("en");
      await unmount();
    }
  });

  it("never shows a raw English reason in the Korean bar", async () => {
    fakes.messages = () => Response.json({ error: "the bot switched tasks before it could receive the message" }, { status: 409 });
    const { host, unmount } = await mount();
    try {
      const engine = await connect(host);
      applyLocale("ko");
      await act(async () => engine.events.toolCall([{ id: "t1", name: "propose_work", args: { order: "로그인 버그 고쳐 줘" } }]));
      await act(async () => pick(host.querySelector<HTMLElement>("[data-live-call-order]")!, "예")!.click());
      await vi.waitFor(() => expect(host.querySelector("[data-live-call-notice=notSent]")?.textContent).toBe("보내지 않음: 로그인 버그 고쳐 줘"));
    } finally {
      applyLocale("en");
      await unmount();
    }
  });

  it("wraps a long unbroken order and keeps a $ in the bot name", async () => {
    const name = atlas.name;
    atlas.name = "Cash$&Bot";
    const { host, unmount } = await mount();
    try {
      const engine = await connect(host, "Cash$&Bot");
      const path = `C:\Users\${"very-long-folder-name".repeat(6)}\report.docx`;
      await act(async () => engine.events.toolCall([{ id: "t1", name: "propose_work", args: { order: `Open ${path}` } }]));
      const [ask, order] = host.querySelectorAll<HTMLElement>("[data-live-call-order] p");
      expect(ask!.textContent).toBe("Ask Cash$&Bot to do this?");
      expect(order!.className).toContain("break-words");
    } finally {
      atlas.name = name;
      await unmount();
    }
  });

  it("keeps the newest wrapped caption at the bottom", async () => {
    const { host, unmount } = await mount();
    try {
      const engine = await connect(host);
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

  it("shows the same Call button in the desktop app and calls from it", async () => {
    Object.assign(window, { ogb: { permOpenSettings: vi.fn(), speechStop: vi.fn() } });
    const { host, unmount } = await mount();
    try {
      expect(corner(host).getAttribute("aria-label")).toBe("Call Atlas");
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

  async function silentHint(host: HTMLElement) {
    vi.useFakeTimers({ toFake: ["Date"] });
    await connect(host);
    vi.setSystemTime(Date.now() + 6_000);
    fakes.frame!(new ArrayBuffer(320));
    await vi.waitFor(() => expect(host.querySelector("[data-call-mic-hint]")).not.toBeNull(), { timeout: 3_000 });
    return host.querySelector<HTMLElement>("[data-call-mic-hint]")!;
  }

  it.each(["win32", "darwin"])("links sound input in the mic hint to the %s sound settings", async (platform) => {
    const permOpenSettings = vi.fn();
    Object.assign(window, { ogb: { platform, permOpenSettings, speechStop: vi.fn() } });
    const { host, unmount } = await mount();
    try {
      const hint = await silentHint(host);
      expect(hint.textContent).toBe("Can't hear your mic. Check your sound input.");
      await act(async () => pick(hint, "sound input").click());
      expect(permOpenSettings).toHaveBeenCalledWith("sound");
    } finally {
      await unmount();
    }
  });

  it.each([["the browser", undefined], ["Linux", { platform: "linux", permOpenSettings: vi.fn(), speechStop: vi.fn() }]])("keeps the mic hint plain text in %s", async (_where, ogb) => {
    if (ogb) Object.assign(window, { ogb });
    const { host, unmount } = await mount();
    try {
      const hint = await silentHint(host);
      expect(hint.textContent).toBe("Can't hear your mic. Check your sound input.");
      expect(hint.querySelector("button, a")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it.each([["en", "Tap to hear Atlas"], ["ko", "Atlas 목소리 듣기"]])("puts one %s sound pill in the call row when the phone won't play, gone after the tap", async (locale, label) => {
    applyLocale(locale as "en" | "ko");
    fakes.played = false;
    const { host, unmount } = await mount();
    try {
      await act(async () => corner(host).click());
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
      await act(async () => fakes.engines[0]!.events.ready());
      const pills = () => [...document.querySelectorAll<HTMLButtonElement>("[data-live-call-sound]")];
      await vi.waitFor(() => expect(pills()).toHaveLength(1));
      expect(frame(host).contains(pills()[0]!)).toBe(true);
      expect(pills()[0]!.textContent).toBe(label);
      expect(document.querySelector("[data-live-call-resume]")).toBeNull();
      await act(async () => pills()[0]!.click());
      await vi.waitFor(() => expect(pills()).toHaveLength(0));
      expect(document.querySelector("[data-live-call-resume]")).toBeNull();
    } finally {
      applyLocale("en");
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

  it("waits for Start call before the first mic or token request", async () => {
    const start = vi.spyOn(LiveCall.prototype, "start");
    const { host, unmount } = await mount(true);
    try {
      await act(async () => button(host, "Call Atlas")!.click());
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
      // The mic opens on each tap, beside the token: once for the keyless try, once for this start.
      expect(fakes.capture).toHaveBeenCalledTimes(2);
      await act(async () => finish(Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" })));
      await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
      expect(fakes.capture).toHaveBeenCalledTimes(2);
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
      await act(async () => button(frame(host), "End")!.click());
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
        await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
        await act(async () => button(host, "Call Atlas")!.click());
        await vi.waitFor(() => expect(host.textContent).toContain(line));
        expect(host.textContent).not.toContain(error);
      }
    } finally {
      await unmount();
    }
  });

  it("voice limit at start shows a plain line and leaves no live call", async () => {
    fakes.token = () => Response.json({ error: "You exceeded your current quota" }, { status: 429 });
    const { host, unmount } = await mount();
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(host.textContent).toContain("Out of voice for today. Keep typing, I'm still here."));
      expect(host.textContent).not.toContain("quota");
      await vi.waitFor(() => expect(frame(host).querySelector("[data-call-box]")).toBeNull());
    } finally {
      await unmount();
    }
  });

  it("mic failure leaves no live call", async () => {
    fakes.micError = "NotFoundError";
    const { host, unmount } = await mount();
    try {
      await act(async () => button(host, "Call Atlas")!.click());
      await vi.waitFor(() => expect(button(host, "Call Atlas")).not.toBeNull());
      expect(frame(host).querySelector("[data-call-box]")).toBeNull();
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
