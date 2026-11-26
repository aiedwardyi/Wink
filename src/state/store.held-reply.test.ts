// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveFrame } from "@/lib/live-events";
import { speaker } from "@/lib/tts";
import { StoreProvider, useStore, type Bot, type Message } from "./store";

type Frame = LiveFrame & { threadId?: string; message?: Message };

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
  id: "b1", threadId: "t1", name: "Bot", busy: true, unread: false, speakReplies: true, voice: "v1",
  modelSelection: { instanceId: "inst", model: "m" },
  messages: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Fix the parser" }],
} as Bot;

let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | undefined;
let spoken: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  spoken = [];
  vi.spyOn(speaker, "speak").mockImplementation(async (text: string) => {
    spoken.push(text);
  });
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function emit(frame: Frame) {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(frame), lastEventId: "" }));
}

async function live() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [bot], groups: [], computerControl: {} })
    : Response.json({}, { status: 404 })));
  function Probe() {
    store = useStore();
    return null;
  }
  const host = document.createElement("div");
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

const text = (id: string, at: number, body: string, extra: Partial<Message> = {}): Message => ({ id, at, role: "bot", kind: "text", text: body, ...extra });
const say = (message: Message) => emit({ kind: "message", threadId: "t1", message });
const patch = (message: Message) => emit({ kind: "message.patch", threadId: "t1", message });
const end = () => emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn1" } });

describe("held reply at the turn's end", () => {
  it("reads only the answer when a step came before it", async () => {
    await live();
    const step = text("a1", 2, "Checking the parser tests.");
    await say(step);
    await say(text("a2", 3, "The parser is fixed."));
    await patch({ ...step, step: true });
    expect(spoken).toEqual([]);
    await end();
    expect(spoken).toEqual(["The parser is fixed."]);
  });

  it("does not read a step after a steer reply", async () => {
    await live();
    const step = text("a1", 2, "Checking the parser tests.");
    await say(step);
    await say({ id: "u2", at: 3, role: "user", kind: "text", text: "Also check CI", steered: true });
    await say(text("a2", 4, "CI is green."));
    expect(spoken).toEqual(["CI is green."]);
    await patch({ ...step, step: true });
    await end();
    expect(spoken).toEqual(["CI is green."]);
  });

  it("reads the answer, not commentary the turn hid after it", async () => {
    await live();
    await say(text("a1", 2, "The parser is fixed."));
    const late = text("a2", 3, "Cleaning up the scratch files.");
    await say(late);
    await patch({ ...late, summarized: true });
    await patch({ ...late, summarized: true, step: true });
    await end();
    expect(spoken).toEqual(["The parser is fixed."]);
  });
});
