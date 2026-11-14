// @vitest-environment happy-dom
import { act, createElement, Fragment, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CATCHING_UP_POLL_MS } from "@/lib/use-catching-up";
import type { Bot, Message } from "@/state/store";

vi.mock("./WhatsNewCard", () => ({ default: ({ release }: { release: string }) => createElement("section", { className: "whats-new", "data-release": release }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const say = (id: string, role: Message["role"], at: number): Message => ({ id, at, role, kind: "text", text: `text ${id}` });

const botWith = (messages: Message[]) => ({
  id: "news", threadId: "thread-news", name: "News", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, hasMore: false,
}) as unknown as Bot;

// The card's state lives in its module, so each test loads its own copy.
async function mount(catchingUp: () => boolean | null = () => false) {
  vi.resetModules();
  const { StoreProvider, useStore } = await import("@/state/store");
  const { ChatView } = await import("./ChatView");
  function Hydrate({ bot }: { bot: Bot }) {
    const { dispatch } = useStore();
    useEffect(() => dispatch({ type: "hydrate", bots: [bot], groups: [], sidebarOrder: { sectionOrder: [], itemOrder: {} } } as never), [dispatch, bot]);
    return null;
  }
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    String(url).endsWith("/api/whats-new")
      ? Response.json({ release: "1.0.247", seen: "1.0.245" })
      : String(url).endsWith("/api/catching-up/thread-news")
        ? Response.json({ catchingUp: catchingUp() })
        : new Response("{}", { status: 404 })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (messages: Message[]) => {
    const bot = botWith(messages);
    return act(async () => root.render(createElement(StoreProvider, null, createElement(Fragment, null, createElement(Hydrate, { bot }), createElement(ChatView, { bot })))));
  };
  const wait = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  });
  const order = () => [...host.querySelectorAll("[data-mid], .whats-new")].map((node) => (node as HTMLElement).dataset.mid ?? "card");
  const done = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { render, wait, order, done };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView whats new", () => {
  it("keeps the card where it showed while later messages land below it", async () => {
    const chat = await mount();
    const first = [say("u1", "user", 1), say("b1", "bot", 2)];
    await chat.render(first);
    await chat.wait(1500);
    expect(chat.order()).toEqual(["u1", "b1", "card"]);
    await chat.render([...first, say("u2", "user", 3), say("b2", "bot", 4)]);
    await chat.wait(0);
    expect(chat.order()).toEqual(["u1", "b1", "card", "u2", "b2"]);
    await chat.done();
  });

  it("lands the card under what a catch-up with another PC pulled, then lets real chat scroll it up", async () => {
    let catchingUp: boolean | null = null;
    const chat = await mount(() => catchingUp);
    const first = [say("u1", "user", 1), say("b1", "bot", 2)];
    await chat.render(first);
    await chat.wait(1500);
    catchingUp = true;
    const pulled = [...first, say("u2", "user", 3), say("b2", "bot", 4)];
    await chat.render(pulled);
    await chat.wait(CATCHING_UP_POLL_MS);
    expect(chat.order()).toEqual(["u1", "b1", "u2", "b2"]);
    catchingUp = false;
    await chat.wait(CATCHING_UP_POLL_MS);
    expect(chat.order()).toEqual(["u1", "b1", "u2", "b2", "card"]);
    await chat.render([...pulled, say("u3", "user", 5)]);
    await chat.wait(0);
    expect(chat.order()).toEqual(["u1", "b1", "u2", "b2", "card", "u3"]);
    await chat.done();
  });
});
