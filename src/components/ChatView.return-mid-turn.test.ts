// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import type { TurnStreamState } from "@/lib/turn-stage";

import { ChatView } from "./ChatView";

const live = vi.hoisted(() => ({ current: { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} } as TurnStreamState }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStreamSelect: <T>(select: (stream: TurnStreamState) => T) => select(live.current),
}));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const row = (id: string, at: number, extra: Partial<Message>): Message => ({ id, at, text: `line ${id}.`, ...extra } as Message);
const base = { title: "", description: "", notifications: false, color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" } };
const idle = { ...base, id: "b", threadId: "thread-b", name: "B", messages: [row("ub", 1, { role: "user", kind: "text" })] } as unknown as Bot;
const turn = [
  row("u1", 1, { role: "user", kind: "text" }),
  row("t1", 2, { role: "bot", kind: "text" }),
  row("t2", 3, { role: "bot", kind: "text" }),
];
const working = (messages: Message[]) => ({ ...base, id: "a", threadId: "thread-a", name: "A", busy: true, activity: "working", messages }) as unknown as Bot;

afterEach(() => {
  live.current = { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(first: Bot) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let show: (bot: Bot) => void = () => {};
  function Switcher() {
    const [bot, setBot] = useState<Bot>(first);
    show = setBot;
    return createElement(ChatView, { bot });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Switcher))));
  return {
    show: (bot: Bot) => act(async () => show(bot)),
    bubbles: () => [...host.querySelectorAll('[data-orbit-message="bot"]')].map((el) => el.textContent?.match(/line \w+(?=\.)/)?.[0]),
    liveLine: () => host.querySelector("[data-live-step]")?.textContent,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("ChatView back on a chat mid-turn", () => {
  it.each([
    ["a send", [row("p1", 4, { role: "user", kind: "text", placeholder: true })], "line t2"],
    ["a worker note", [row("n1", 4, { role: "bot", kind: "note" }), row("t3", 5, { role: "bot", kind: "text" })], "line t3"],
  ])("keeps the running turn's lines in the live line when %s lands", async (_, landed, line) => {
    live.current = { streaming: {}, reasoning: {}, signal: { "thread-a": "started" }, gen: {}, turn: {} };
    const chat = await mount(idle);
    try {
      await chat.show(working(turn));
      expect(chat.bubbles()).toEqual([]);
      expect(chat.liveLine()).toContain("line t2");
      await chat.show(working([...turn, ...landed]));
      expect(chat.bubbles()).toEqual([]);
      expect(chat.liveLine()).toContain(line);
    } finally {
      await chat.unmount();
    }
  });

  it.each([
    ["switching back", true],
    ["reopening the chat", false],
  ])("keeps the running turn's lines in the live line after a room echo lands, %s", async (_, switched) => {
    live.current = { streaming: {}, reasoning: {}, signal: { "thread-a": "started" }, gen: {}, turn: {} };
    const echoed = working([...turn, row("e1", 4, { role: "bot", kind: "note", roomEcho: { groupId: "g" } })]);
    const chat = await mount(switched ? idle : echoed);
    try {
      if (switched) await chat.show(echoed);
      expect(chat.bubbles()).toEqual([]);
      expect(chat.liveLine()).toContain("line t2");
    } finally {
      await chat.unmount();
    }
  });

  it("a wait that begins on screen after a mid-turn note keeps the answer just given", async () => {
    const answered = [
      row("u1", 1, { role: "user", kind: "text" }),
      row("s1", 2, { role: "bot", kind: "text", step: true }),
      row("n1", 3, { role: "bot", kind: "note" }),
      row("a1", 4, { role: "bot", kind: "text" }),
    ];
    const chat = await mount({ ...working(answered), busy: false, activity: "idle" } as Bot);
    try {
      expect(chat.bubbles()).toEqual(["line a1"]);
      live.current = { streaming: {}, reasoning: {}, signal: { "thread-a": "started" }, gen: {}, turn: {} };
      await chat.show(working(answered));
      expect(chat.bubbles()).toEqual(["line a1"]);
      await chat.show(working([...answered, row("w1", 5, { role: "bot", kind: "text" })]));
      expect(chat.bubbles()).toEqual(["line a1"]);
      expect(chat.liveLine()).toContain("line w1");
    } finally {
      await chat.unmount();
    }
  });
});
