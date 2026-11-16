// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

const live = vi.hoisted(() => ({ botId: "" }));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
vi.mock("@/lib/live-call/active", async (actual) => ({
  ...(await actual<typeof import("@/lib/live-call/active")>()),
  useActiveCall: () => (live.botId ? { id: 1, botId: live.botId } : null),
}));

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const call = "c-0123456789ab";
const at = (h: number, m: number, s = 0) => new Date(2026, 10, 16, h, m, s).getTime();

function bot(ms?: number, after: Message[] = []): Bot {
  const messages: Message[] = [
    { id: "u0", at: at(14, 50), role: "user", kind: "text", text: "Before the call" },
    { id: "l1", parentId: "u0", at: at(14, 59), role: "bot", kind: "text", text: "Hey, I'm here.", call: { id: call, voice: true, ...(ms ? { ms, summary: "You asked Atlas about the build." } : {}) } },
    { id: "l2", parentId: "l1", at: at(14, 59, 20), role: "user", kind: "text", text: "How is the build?", call: { id: call } },
    { id: "t1", parentId: "l2", at: at(15, 0), role: "user", kind: "text", text: "Typed during the call" },
    { id: "b1", parentId: "t1", at: at(15, 0, 30), role: "bot", kind: "text", text: "Reply during the call" },
    { id: "l3", parentId: "b1", at: at(15, 1, 44), role: "bot", kind: "text", text: "It passed.", call: { id: call, voice: true } },
    { id: "u3", parentId: "l3", at: at(15, 5), role: "user", kind: "text", text: "After the call" },
    ...after,
  ];
  // SAFETY: a fixture with the Bot fields ChatView reads; the rest stay unset.
  return {
    id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: false,
    color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages, activeLeafId: messages.at(-1)!.id, hasMore: false,
  } as unknown as Bot;
}

function View({ seed }: { seed: Bot }) {
  const { state, dispatch } = useStore();
  useEffect(() => {
    dispatch({ type: "hydrate", bots: [seed], groups: [], computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } });
  }, [dispatch, seed]);
  const shown = state.bots.find((b) => b.id === seed.id);
  return shown ? createElement(ChatView, { bot: shown }) : null;
}

async function mount(seed: Bot) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(View, { seed }))));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => {
  live.botId = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView call card", () => {
  it("puts an ended call after what was sent during it, at its end time", async () => {
    const view = await mount(bot(165_000));
    try {
      const card = view.host.querySelector("[data-call-card]")!;
      expect(card.textContent).toContain("Call · 2:45");
      expect(card.textContent).toContain("3:01");
      expect(card.textContent).not.toContain("2:59");
      expect(before(view.host.querySelector('[data-mid="b1"]')!, card)).toBe(true);
      expect(before(card, view.host.querySelector('[data-mid="u3"]')!)).toBe(true);
      expect(view.host.querySelectorAll("[data-call-card]")).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  it("moves an old call with no saved length to its end too", async () => {
    const view = await mount(bot());
    try {
      const card = view.host.querySelector("[data-call-card]")!;
      expect(card.textContent).toContain("3:01");
      expect(before(view.host.querySelector('[data-mid="b1"]')!, card)).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it("keeps an order sent at hang-up in its own row, after the card", async () => {
    const view = await mount(bot(165_000, [{ id: "o1", parentId: "u3", at: at(15, 6), role: "user", kind: "text", text: "Ship the build.", call: { id: call, order: true } }]));
    try {
      const card = view.host.querySelector("[data-call-card]")!;
      expect(card.textContent).toContain("3:01");
      expect(view.host.querySelector('[data-mid="o1"] [data-call-card]')).toBeNull();
      expect(before(card, view.host.querySelector('[data-mid="o1"]')!)).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it("keeps the live call line where the call started", async () => {
    live.botId = "atlas";
    const view = await mount(bot());
    try {
      const line = [...view.host.querySelectorAll("div")].find((div) => div.textContent === "Call · 2:59 PM")!;
      expect(line).toBeDefined();
      expect(before(line, view.host.querySelector('[data-mid="t1"]')!)).toBe(true);
      expect(before(view.host.querySelector('[data-mid="u0"]')!, line)).toBe(true);
    } finally {
      await view.unmount();
    }
  });
});
