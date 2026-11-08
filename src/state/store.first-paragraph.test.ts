// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMarkdown } from "@/components/ChatMarkdown";
import type { LiveFrame } from "@/lib/live-events";
import { StoreProvider, useStore, useStreaming, type Bot, type Message } from "./store";

type Frame = LiveFrame & { threadId?: string; message?: Message };

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

// SAFETY: the store folds only these fields here; the full Bot contract is server-owned.
const bot = {
  id: "b1", threadId: "t1", name: "Bot", busy: true, unread: false,
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Write" }],
} as Bot;

let store: ReturnType<typeof useStore>;
let host: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;

beforeEach(() => {
  localStorage.setItem("omb-reply-style", "paragraphs");
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function emit(frame: Frame, lastEventId = "") {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(frame), lastEventId }));
}

function Reply() {
  const stream = useStreaming();
  const { state } = useStore();
  const reveal = stream.reveal?.t1;
  const settled = (state.bots[0]?.messages ?? []).filter((m) => m.role === "bot");
  return createElement(
    "div",
    null,
    ...settled.map((m) => createElement(ChatMarkdown, { key: m.id, text: m.text ?? "" })),
    createElement(ChatMarkdown, { text: stream.streaming.t1 ?? "", streaming: !reveal?.ended, whole: reveal?.whole }),
  );
}

async function live() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [bot], groups: [], computerControl: {} })
    : Response.json({}, { status: 404 })));
  function Probe() {
    store = useStore();
    return createElement(Reply);
  }
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await emit({ kind: "hello", resumed: false, cursor: "s:0" });
  await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
  await emit({ kind: "runtime", event: { type: "turn.started", threadId: "t1", turnId: "turn1" } });
}

const delta = (text: string) => emit({
  kind: "runtime",
  event: { type: "content.delta", threadId: "t1", turnId: "turn1", streamKind: "assistant_text", delta: text },
});

async function frame() {
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
}

const paragraphs = () => [...host.querySelectorAll("p")].map((p) => p.textContent);

describe("first paragraph while it streams", () => {
  it("shows the first paragraph as it arrives", async () => {
    await live();
    await delta("Here is the ");
    await frame();
    expect(paragraphs()).toEqual(["Here is the"]);
    await delta("answer, in one line.");
    await frame();
    expect(paragraphs()).toEqual(["Here is the answer, in one line."]);
  });

  it("holds every later paragraph until it is finished", async () => {
    await live();
    await delta("First done.\n\nSecond is still");
    await frame();
    expect(paragraphs()).toEqual(["First done."]);
    await delta(" arriving.\n\nThird");
    await frame();
    expect(paragraphs()).toEqual(["First done.", "Second is still arriving."]);
  });

  it("lets the settled reply replace the partial text without a duplicate", async () => {
    await live();
    await delta("Hello wor");
    await frame();
    expect(paragraphs()).toEqual(["Hello wor"]);
    await delta("ld.");
    await emit({ kind: "message", threadId: "t1", message: { id: "a1", parentId: "u1", at: 2, role: "bot", kind: "text", text: "Hello world." } });
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });
    await frame();
    expect(paragraphs()).toEqual(["Hello world."]);
    expect(store.state.bots[0].messages.at(-1)).toMatchObject({ id: "a1", text: "Hello world." });
  });

  it("keeps a first paragraph that will be a table, list or code out of sight", async () => {
    await live();
    await delta("| Name | Age |");
    await frame();
    expect(host.textContent).toBe("");
    await delta("\n|---|---|\n| Ann | 3 |");
    await frame();
    expect(host.textContent).toBe("");
  });

  it("keeps what streamed when the turn ends without a settled reply", async () => {
    await live();
    await delta("Cut off mid");
    await frame();
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });
    await frame();
    expect(paragraphs()).toEqual(["Cut off mid"]);
  });
});
