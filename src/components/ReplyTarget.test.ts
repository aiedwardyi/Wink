// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearReplyDraft } from "@/lib/drafts";
import { I18nProvider } from "@/lib/i18n";
import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const from = { botId: "b1", name: "Atlas", color: "blue" as const };
const text = (id: string, role: Message["role"]): Message => ({ id, at: 1, role, kind: "text", text: id, ...(role === "bot" && { from }) });
const messages = [text("u1", "user"), text("target", "bot"), text("u2", "user"), text("last", "bot")];
const bot: Bot = {
  id: "b1", threadId: "t1", name: "Atlas", title: "", description: "", notifications: false,
  color: "blue", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages,
};
const room: Group = {
  id: "g1", threadId: "gt", name: "Room", memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "",
  unread: false, createdAt: 1, setupCompletedAt: 1, messages,
};

// happy-dom has no layout: the transcript is a window `view.height` tall over 2000px of rows, less the reply strip once it shows, and the target row sits at `rowTop`.
const view = { height: 400, rowTop: 380 };
const ROW_HEIGHT = 50;
const STRIP_HEIGHT = 50;
const edge = () => view.height - (document.querySelector('[aria-label="Cancel reply"]') ? STRIP_HEIGHT : 0);
const scrollTops = new WeakMap<Element, number>();
const transcript = () => document.querySelector<HTMLElement>("[data-orbit-transcript]")!;
const observers: { callback: () => void; targets: Element[] }[] = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    entry: { callback: () => void; targets: Element[] };
    constructor(callback: () => void) {
      this.entry = { callback, targets: [] };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.push(target); }
    unobserve() {}
    disconnect() { this.entry.targets = []; }
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const isTranscript = (el: Element) => el.hasAttribute("data-orbit-transcript");
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
    set(this: HTMLElement, top: number) { scrollTops.set(this, Math.max(0, Math.round(top))); },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return isTranscript(this) ? 2000 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return isTranscript(this) ? edge() : 0; } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (isTranscript(this)) return DOMRect.fromRect({ y: 0, height: edge() });
    if (this.closest('[data-mid="target"]')) return DOMRect.fromRect({ y: view.rowTop - transcript().scrollTop, height: ROW_HEIGHT });
    return DOMRect.fromRect({});
  });
});

afterEach(() => {
  clearReplyDraft(bot.threadId);
  clearReplyDraft(room.threadId);
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

async function mount(kind: "chat" | "group") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [bot], groups: [room], computerControl: {} })
    : new Response("{}", { status: 404 })));
  let store: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    if (kind === "chat") return createElement(ChatView, { bot: store.state.bots.find((candidate) => candidate.id === "b1") ?? bot });
    const group = store.state.groups.find((candidate) => candidate.id === store.state.selectedId);
    return group ? createElement(GroupView, { group }) : null;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Probe)))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "s:0" }), lastEventId: "s:0" }));
  if (kind === "group") await act(async () => store.dispatch({ type: "select", id: "g1" }));
  // the reader scrolled up into the chat, so bottom-follow is off
  await act(async () => transcript().dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })));
  transcript().scrollTop = 0;
}

const reply = () => act(async () => document.querySelector<HTMLButtonElement>('[data-mid="target"] button[aria-label="Reply to message"]')!.click());
const resize = (height: number) => act(async () => {
  view.height = height;
  for (const observer of observers) if (observer.targets.includes(transcript())) observer.callback();
});
const targetBottom = () => view.rowTop + ROW_HEIGHT - transcript().scrollTop;

describe.each(["chat", "group"] as const)("the message a %s reply answers", (kind) => {
  it("stays above the reply strip", async () => {
    view.height = 400;
    view.rowTop = 330;
    await mount(kind);
    await reply();
    expect(transcript().scrollTop).toBe(30);
    expect(targetBottom()).toBeLessThanOrEqual(edge());
  });

  it("leaves the chat put when the message already ran past the bottom", async () => {
    view.height = 400;
    view.rowTop = 1200;
    await mount(kind);
    await reply();
    expect(transcript().scrollTop).toBe(0);
    await resize(200);
    expect(transcript().scrollTop).toBe(0);
  });

  it("stays above a phone keyboard that opens after the tap", async () => {
    view.height = 600;
    view.rowTop = 380;
    await mount(kind);
    await reply();
    expect(transcript().scrollTop).toBe(0);
    await resize(300);
    expect(targetBottom()).toBeLessThanOrEqual(edge());
  });

  it("stays above the keyboard after the strip already moved it", async () => {
    view.height = 400;
    view.rowTop = 330.4;
    await mount(kind);
    await reply();
    await resize(200);
    expect(targetBottom()).toBeLessThanOrEqual(edge() + 1);
  });

  it("leaves the chat put when nothing is being replied to", async () => {
    view.height = 600;
    view.rowTop = 380;
    await mount(kind);
    await resize(300);
    expect(transcript().scrollTop).toBe(0);
  });
});
