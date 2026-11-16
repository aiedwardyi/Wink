import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, type Bot, type Group, type Message } from "@/state/store";
import { ChatPeekParts, ChatPreviewContext } from "@/lib/chat-preview";
import { PHONE_QUERY, swipeBlocked } from "@/lib/phone-swipe";
import { usePhoneSwipe } from "@/lib/use-phone-swipe";
import { TRANSCRIPT_TAIL_SIZE } from "@/lib/transcript-window";
import { ChatView, clearLivePaneCache } from "./ChatView";
import { GroupView } from "./GroupView";
import { TeamRoomTranscript } from "./TeamRoomRow";
import type { RoomLine } from "@/lib/team-rooms";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let requests: string[];
const messages: Message[] = [{ id: "cached-last", at: 1, role: "user", kind: "text", text: "Cached neighbor message", replyToId: "older-quote" }];
const neighbor = {
  id: "peek", threadId: "thread-peek", name: "Neighbor", title: "", description: "", notifications: false,
  color: "purple", unread: true, modelSelection: { instanceId: "inst", model: "m" },
  messages, hasMore: true, pinnedMessageId: "older-pin",
} as Bot;
const room = {
  id: "room-peek", threadId: "thread-room-peek", name: "Room Neighbor", memberIds: [], defaultResponder: { kind: "everyone" },
  bulletin: "", unread: true, createdAt: 1, setupCompletedAt: 1, hasMore: true, pinnedMessageId: "cached-room-last",
  messages: [{ id: "cached-room-last", at: 1, role: "user", kind: "text", text: "Cached room message", replyToId: "older-room-quote" }],
} as Group;
const heavyMessages: Message[] = Array.from({ length: 200 }, (_, i) => ({ id: `heavy-${i}`, parentId: i ? `heavy-${i - 1}` : undefined, at: i + 1, role: "user", kind: "text", text: `Cached line ${i}` }));
const heavyBot = { ...neighbor, messages: heavyMessages, activeLeafId: "heavy-199", hasMore: false, pinnedMessageId: undefined };
const heavyRoom = { ...room, messages: heavyMessages, hasMore: false, pinnedMessageId: undefined };
const heavyLines: RoomLine[] = heavyMessages.map((message) => ({ id: message.id, entryId: message.id, at: message.at, author: { kind: "person", id: "mina", name: "Mina" }, text: message.text ?? "", files: [] }));

const render = (preview: boolean, bot = neighbor) => act(async () => {
  root.render(createElement(StoreProvider, null, createElement(ChatPreviewContext.Provider, { value: preview }, createElement(ChatView, { bot, focusComposerBlocked: preview }))));
});
const renderRoom = (preview: boolean, group = room) => act(async () => {
  root.render(createElement(StoreProvider, null, createElement(ChatPreviewContext.Provider, { value: preview }, createElement(GroupView, { group }))));
});
const renderLines = (preview: boolean) => act(async () => root.render(createElement(StoreProvider, null,
  createElement(ChatPreviewContext.Provider, { value: preview }, createElement(TeamRoomTranscript, {
    lines: heavyLines, mine: () => false, base: "/api/rooms/peek-lines", label: "People", onReply: () => {},
    notice: { entryId: "heavy-0", text: "Pinned line", canUnpin: false },
  })),
)));

// The DOM fixture omits the initial true-to-false media change.
function phoneMediaChanges() {
  const queries: MediaQueryList[] = [];
  const match = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = match(query);
    if (query === PHONE_QUERY) queries.push(media);
    return media;
  });
  return () => { for (const media of [...queries]) media.dispatchEvent(new Event("change")); };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  requests = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    requests.push(String(url));
    return new Promise<Response>(() => {});
  }));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 392, height: 844 });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearLivePaneCache();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
  (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1024, height: 800 });
});

describe("cached chat preview", () => {
  it.each(["loaded", "loading"] as const)("measures the header once on promotion with %s fonts and repeats only for a pending font load", async (status) => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
    const loaded = new Set<() => void>();
    const fonts = {
      status,
      addEventListener: (type: string, listener: () => void) => { if (type === "loadingdone") loaded.add(listener); },
      removeEventListener: (type: string, listener: () => void) => { if (type === "loadingdone") loaded.delete(listener); },
    };
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const rangePrototype = Object.getPrototypeOf(document.createRange()) as Range;
    const measure = vi.spyOn(rangePrototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) });
    const appended = vi.spyOn(document.body, "appendChild");
    const copies = () => appended.mock.calls.filter(([node]) => node instanceof HTMLElement && node.style.left === "-9999px").length;
    try {
      const bot = { ...neighbor, id: "header", threadId: "thread-header", messages: [], hasMore: false, pinnedMessageId: undefined };
      await render(true, bot);
      await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      expect(measure).not.toHaveBeenCalled();
      await render(false, bot);
      await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      expect(measure).toHaveBeenCalledTimes(1);
      expect(copies()).toBe(0);
      if (status === "loading") {
        fonts.status = "loaded";
        expect(loaded.size).toBeGreaterThan(0);
        await act(async () => { for (const listener of loaded) listener(); });
        expect(measure).toHaveBeenCalledTimes(2);
        expect(copies()).toBe(0);
      }
    } finally {
      if (descriptor) Object.defineProperty(document, "fonts", descriptor);
      else delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it.each(["bot", "room"] as const)("keeps the %s preview window through promotion without mounting offscreen history", async (kind) => {
    const show = (preview: boolean) => kind === "bot" ? render(preview, heavyBot) : renderRoom(preview, heavyRoom);
    await show(true);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(4);
    const tail = host.querySelector('[data-mid="heavy-199"]');
    expect(tail).not.toBeNull();
    expect(requests.some((url) => url.includes("/api/threads/"))).toBe(false);
    await show(false);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(4);
    expect(host.querySelector('[data-mid="heavy-199"]')).toBe(tail);
  });

  it.each(["bot", "room"] as const)("keeps the desktop %s tap window", async (kind) => {
    (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 });
    if (kind === "bot") await render(false, heavyBot);
    else await renderRoom(false, heavyRoom);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(TRANSCRIPT_TAIL_SIZE);
  });

  it.each(["bot", "room"] as const)("opens a phone %s with the same small cached window", async (kind) => {
    if (kind === "bot") await render(false, heavyBot);
    else await renderRoom(false, heavyRoom);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(4);
    expect(host.querySelector('[data-mid="heavy-199"]')).not.toBeNull();
  });

  it.each([false, true])("keeps the phone window when an empty branch receives its first cached tail (preview=%s)", async (preview) => {
    await render(preview, { ...heavyBot, messages: [], activeLeafId: undefined });
    await render(preview, heavyBot);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(4);
    expect(host.querySelector('[data-mid="heavy-199"]')).not.toBeNull();
  });

  it.each(["bot", "room"] as const)("restores the desktop %s window after a phone resize", async (kind) => {
    const change = phoneMediaChanges();
    if (kind === "bot") await render(false, heavyBot);
    else await renderRoom(false, heavyRoom);
    const tail = host.querySelector('[data-mid="heavy-199"]');
    await act(async () => {
      (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 });
      change();
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    });
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(120);
    expect(host.querySelector('[data-mid="heavy-199"]')).toBe(tail);
  });

  it.each(["bot", "room"] as const)("fills the phone %s from cache before paging the server", async (kind) => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? this.querySelectorAll("[data-mid]").length * 20 : 0;
    });
    if (kind === "bot") await render(false, { ...heavyBot, hasMore: true });
    else await renderRoom(false, { ...heavyRoom, hasMore: true });
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(32);
    expect(requests.some((url) => url.includes("before="))).toBe(false);
  });

  it.each(["bot", "room"] as const)("keeps the phone %s at its cached tail through layout changes until the reader scrolls back", async (kind) => {
    const notifications: (() => void)[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      active = true;
      constructor(private changed: IntersectionObserverCallback, private options?: IntersectionObserverInit) {}
      observe(target: Element) {
        notifications.push(() => {
          if (this.active && this.options?.root === host.querySelector("[data-orbit-transcript]")) this.changed([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
        });
      }
      unobserve() {}
      disconnect() { this.active = false; }
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? 1000 + this.querySelectorAll("[data-mid]").length * 20 : 0;
    });
    if (kind === "bot") await render(false, heavyBot);
    else await renderRoom(false, heavyRoom);
    const initial = host.querySelectorAll("[data-mid]").length;
    const scroll = host.querySelector<HTMLElement>("[data-orbit-transcript]")!;
    scroll.scrollTop = 0;
    await act(async () => { notifications.forEach((notify) => notify()); });
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(initial);
    scroll.scrollTop = 400;
    await act(async () => {
      for (const [type, clientY] of [["touchstart", 100], ["touchmove", 150]] as const) {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, "touches", { value: [{ clientY }] });
        scroll.dispatchEvent(event);
      }
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll"));
    });
    await act(async () => { notifications.forEach((notify) => notify()); });
    expect(host.querySelectorAll("[data-mid]").length).toBeGreaterThan(initial);
    expect(requests.some((url) => url.includes("before="))).toBe(false);
  });

  it.each(["bot", "room"] as const)("fills an underfilled %s preview from cached rows before paint", async (kind) => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? this.querySelectorAll("[data-mid]").length * 20 : 0;
    });
    if (kind === "bot") await render(true, heavyBot);
    else await renderRoom(true, heavyRoom);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(32);
    expect(host.querySelector('[data-mid="heavy-199"]')).not.toBeNull();
    expect(requests.some((url) => url.includes("/api/threads/"))).toBe(false);
  });

  it("reads the transcript end on a vertical touch but not during a horizontal chat swipe", async () => {
    let reads = 0;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-orbit-transcript")) reads += 1;
      return 0;
    });
    const bot = { ...neighbor, id: "swipe", threadId: "thread-swipe", messages: [], hasMore: false, pinnedMessageId: undefined };
    function Stage() {
      const stage = usePhoneSwipe(bot.id, true, () => {}, undefined, () => [bot.id, "next"]);
      return createElement("div", { ref: stage }, createElement(ChatView, { bot }));
    }
    await act(async () => root.render(createElement(StoreProvider, null, createElement(Stage))));
    const scroll = host.querySelector<HTMLElement>("[data-orbit-transcript]")!;
    const gesture = (moves: [number, number][]) => act(async () => {
      for (const [type, [clientX, clientY]] of [["touchstart", [300, 300]], ...moves.map((move) => ["touchmove", move] as const), ["touchend", [0, 0]]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX, clientY }] });
        scroll.dispatchEvent(event);
      }
    });
    reads = 0;
    await gesture([[200, 302], [150, 304]]);
    expect(reads).toBe(0);
    await gesture([[300, 280]]);
    expect(reads).toBeGreaterThan(0);
  });

  it("uses the real header and transcript without paging, quote, pin or composer reads", async () => {
    await render(true);
    expect(host.querySelector('[aria-label="Open Neighbor\'s profile"]')).not.toBeNull();
    expect(host.querySelector('[data-mid="cached-last"]')?.textContent).toContain("Cached neighbor message");
    expect(requests.filter((url) => url.includes("thread-peek") || url.includes("/bots/peek/") || url.includes("/api/usage"))).toEqual([]);
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("activates missing quote and pin reads only after promotion", async () => {
    await render(true);
    expect(requests.some((url) => url.includes("around="))).toBe(false);
    await render(false);
    expect(requests.some((url) => url.includes("around=older-pin"))).toBe(true);
    expect(requests.some((url) => url.includes("around=older-quote"))).toBe(true);
    expect(requests.some((url) => url.includes("/api/catching-up/thread-peek"))).toBe(true);
  });

  it("shows an uncached header and empty transcript without a loading spinner or older-page request", async () => {
    await render(true, { ...neighbor, messages: [] });
    expect(host.querySelector('[aria-label="Open Neighbor\'s profile"]')).not.toBeNull();
    const transcript = host.querySelector("[data-orbit-transcript]");
    expect(transcript?.querySelector("[data-mid], .animate-spin")).toBeNull();
    expect(transcript?.textContent).not.toContain("Show earlier messages");
    expect(requests.some((url) => url.includes("/api/threads/") || url.includes("catching-up"))).toBe(false);
  });

  it("pins the preview before paint and preserves its transcript and bottom position on promotion", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? 1000 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
      this.scrollTop = typeof options === "object" ? options.top ?? 0 : y ?? 0;
    });
    await render(true);
    const transcript = host.querySelector<HTMLElement>("[data-orbit-transcript]")!;
    const row = host.querySelector('[data-mid="cached-last"]');
    expect(transcript.scrollTop).toBe(1000);
    await render(false);
    expect(host.querySelector("[data-orbit-transcript]")).toBe(transcript);
    expect(host.querySelector('[data-mid="cached-last"]')).toBe(row);
    expect(transcript.scrollTop).toBe(1000);
  });
});

describe("staged chat peek", () => {
  let frames: Map<number, FrameRequestCallback>;
  beforeEach(() => {
    frames = new Map();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  });
  const frame = () => act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
  const nextPart = async () => {
    await frame();
    await frame();
  };
  const mids = () => [...host.querySelectorAll("[data-mid]")].map((node) => node.getAttribute("data-mid"));
  const stage = (kind: "bot" | "room" | "people", preview: boolean) => act(async () => root.render(createElement(StoreProvider, null,
    createElement(ChatPeekParts, { id: kind, preview, children: createElement(ChatPreviewContext.Provider, { value: preview },
      kind === "bot" ? createElement(ChatView, { bot: heavyBot, focusComposerBlocked: preview })
        : kind === "room" ? createElement(GroupView, { group: heavyRoom })
        : createElement(TeamRoomTranscript, { lines: heavyLines, mine: () => false, base: "/api/rooms/peek-lines", label: "People", onReply: () => {} })) }),
  )));

  it.each(["bot", "room", "people"] as const)("appends a peeked %s window's rows oldest first and keeps them through promotion", async (kind) => {
    await stage(kind, true);
    expect(host.querySelector("[data-orbit-transcript]")).not.toBeNull();
    expect(mids()).toEqual([]);
    expect(host.querySelector("[data-orbit-composer]")).toBeNull();
    await nextPart();
    await nextPart();
    expect(host.querySelector("[data-orbit-composer]") === null).toBe(kind === "people");
    expect(mids()).toEqual([]);
    await nextPart();
    expect(mids()).toEqual(["heavy-196"]);
    const head = host.querySelector('[data-mid="heavy-196"]');
    await nextPart();
    expect(mids()).toEqual(["heavy-196", "heavy-197"]);
    await stage(kind, false);
    expect(mids()).toEqual(["heavy-196", "heavy-197", "heavy-198", "heavy-199"]);
    expect(host.querySelector('[data-mid="heavy-196"]')).toBe(head);
  });

  it("mounts the bot header before its controls", async () => {
    await stage("bot", true);
    expect(host.querySelector('[aria-label="Open Neighbor\'s profile"]')).not.toBeNull();
    expect(host.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    await nextPart();
    expect(host.querySelector('[aria-haspopup="dialog"]')).not.toBeNull();
  });

  it.each(["bot", "room"] as const)("grows an underfilled peeked %s only after its rows mount", async (kind) => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? this.querySelectorAll("[data-mid]").length * 20 : 0;
    });
    await stage(kind, true);
    for (let part = 1; part <= 6; part++) {
      await nextPart();
      expect(mids().length).toBe(Math.max(0, part - 2));
    }
    await nextPart();
    expect(mids()).toHaveLength(32);
    expect(requests.some((url) => url.includes("/api/threads/"))).toBe(false);
  });
});

describe("cached room preview", () => {
  it("retains the people-only room window through promotion and expands cached scrollback", async () => {
    await renderLines(true);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(4);
    const tail = host.querySelector('[data-mid="heavy-199"]');
    await renderLines(false);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(4);
    expect(host.querySelector('[data-mid="heavy-199"]')).toBe(tail);
    await act(async () => host.querySelector("[data-orbit-transcript]")!.dispatchEvent(new Event("scroll")));
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(8);
  });

  it("keeps the desktop people-only room transcript", async () => {
    (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 });
    await renderLines(false);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(200);
  });

  it("opens a phone people-only room with the same small cached window", async () => {
    await renderLines(false);
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(4);
  });

  it("restores the desktop people-only room after a phone resize", async () => {
    const change = phoneMediaChanges();
    await renderLines(false);
    const tail = host.querySelector('[data-mid="heavy-199"]');
    await act(async () => {
      (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 });
      change();
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    });
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(200);
    expect(host.querySelector('[data-mid="heavy-199"]')).toBe(tail);
  });

  it("fills a people-only preview from cached rows without reads", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? 600 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-orbit-transcript") ? this.querySelectorAll("[data-mid]").length * 20 : 0;
    });
    await renderLines(true);
    const count = host.querySelectorAll("[data-mid]").length;
    expect(count * 20).toBeGreaterThanOrEqual(648);
    expect(count).toBeLessThan(200);
    expect(requests.some((url) => url.includes("/api/rooms/peek-lines"))).toBe(false);
  });

  it("reveals a pinned cached line outside the retained people-only window", async () => {
    await renderLines(true);
    await renderLines(false);
    expect(host.querySelector('[data-mid="heavy-0"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-room-notice-jump]")!.click();
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    });
    expect(host.querySelector('[data-mid="heavy-0"]')).not.toBeNull();
  });

  it("keeps an uncached people-only room empty until it becomes live", async () => {
    const transcript = (preview: boolean) => act(async () => root.render(createElement(StoreProvider, null,
      createElement(ChatPreviewContext.Provider, { value: preview }, createElement(TeamRoomTranscript, {
        lines: [], mine: () => false, base: "/api/rooms/peek", label: "Room Neighbor", onReply: () => {},
        empty: { name: "Room Neighbor", members: ["Mina"] },
      })),
    )));
    await transcript(true);
    expect(host.querySelector("[data-room-empty], .animate-spin")).toBeNull();
    expect(requests.some((url) => url.includes("/api/rooms/peek"))).toBe(false);
    await transcript(false);
    expect(host.querySelector("[data-room-empty]")?.textContent).toContain("Room Neighbor");
  });

  it("renders the real room header and cached messages without paging or quote reads", async () => {
    await renderRoom(true);
    expect(host.querySelector("[data-room-title]")?.textContent).toContain("Room Neighbor");
    expect(host.querySelector('[data-mid="cached-room-last"]')?.textContent).toContain("Cached room message");
    expect(requests.some((url) => url.includes("thread-room-peek"))).toBe(false);
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
  });

  it("preserves the room transcript through promotion", async () => {
    await renderRoom(true);
    const transcript = host.querySelector("[data-room-transcript]");
    const row = host.querySelector('[data-mid="cached-room-last"]');
    await renderRoom(false);
    expect(host.querySelector("[data-room-transcript]")).toBe(transcript);
    expect(host.querySelector('[data-mid="cached-room-last"]')).toBe(row);
    expect(requests.some((url) => url.includes("around=older-room-quote"))).toBe(true);
  });

  it("keeps the room header available for paging and guards the bell and announcement", async () => {
    await renderRoom(true);
    expect(swipeBlocked(host.querySelector("[data-room-title]"), 200)).toBe(false);
    for (const selector of ["[data-room-bell]", '[title="Jump to the pinned message"]']) {
      const control = host.querySelector(selector);
      expect(control, selector).not.toBeNull();
      expect(control?.closest("[data-no-swipe]"), selector).not.toBeNull();
      expect(swipeBlocked(control, 200), selector).toBe(true);
    }
  });

  it("leaves an uncached room transcript empty without a spinner or load", async () => {
    await renderRoom(true, { ...room, messages: [] });
    expect(host.querySelector("[data-room-title]")?.textContent).toContain("Room Neighbor");
    expect(host.querySelector("[data-room-transcript]")?.querySelector("[data-mid], .animate-spin")).toBeNull();
    expect(requests.some((url) => url.includes("thread-room-peek"))).toBe(false);
  });
});
