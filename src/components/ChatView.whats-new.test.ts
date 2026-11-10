// @vitest-environment happy-dom
import { act, createElement, Fragment, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

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

function Hydrate({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  useEffect(() => dispatch({ type: "hydrate", bots: [bot], groups: [], sidebarOrder: { sectionOrder: [], itemOrder: {} } } as never), [dispatch, bot]);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView whats new", () => {
  it("keeps the card where it showed while later messages land below it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).endsWith("/api/whats-new")
        ? new Response(JSON.stringify({ release: "1.0.247", seen: "1.0.245" }), { headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 404 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (messages: Message[]) => {
      const bot = botWith(messages);
      return act(async () => root.render(createElement(StoreProvider, null, createElement(Fragment, null, createElement(Hydrate, { bot }), createElement(ChatView, { bot })))));
    };
    const first = [say("u1", "user", 1), say("b1", "bot", 2)];
    await render(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
      await vi.dynamicImportSettled();
    });
    const order = () => [...host.querySelectorAll("[data-mid], .whats-new")].map((node) => (node as HTMLElement).dataset.mid ?? "card");
    expect(order()).toEqual(["u1", "b1", "card"]);
    await render([...first, say("u2", "user", 3), say("b2", "bot", 4)]);
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(order()).toEqual(["u1", "b1", "card", "u2", "b2"]);
    await act(async () => root.unmount());
    host.remove();
  });
});
