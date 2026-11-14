// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buffersForTurn } from "@/lib/turn-stage";
import { StoreProvider, useStore, useStreaming, type Bot } from "./store";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

let store: ReturnType<typeof useStore>;
let stream: ReturnType<typeof useStreaming>;
let unmount: (() => Promise<void>) | undefined;
let frame: FrameRequestCallback | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mountOriginStore(messages: Bot["messages"] = [], busy = false, snapshot?: Promise<Response>, onOrigin?: (origin: ReturnType<typeof useStore>["turnOrigin"]) => void) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const bot = {
    id: "b1", threadId: "t1", name: "Bot", busy, unread: false,
    modelSelection: { instanceId: "inst", model: "m" }, messages,
  } as Bot;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? snapshot ? (await snapshot).clone() : Response.json({ bots: [bot], groups: [], computerControl: {} })
    : Response.json({}, { status: 404 })));
  function Probe() {
    store = useStore();
    onOrigin?.(store.turnOrigin);
    return null;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await emit({ kind: "hello", resumed: false, cursor: "c1" });
}

describe("store turn origins", () => {
  it("keeps dispatch origin through joins and starts the drained turn anew", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    await mountOriginStore();
    await emit({ kind: "turn.dispatch", threadId: "t1", createdAt: new Date(103_000).toISOString() });
    expect(store.turnOrigin("t1")).toBe(100_000);
    now.mockReturnValue(100_900);
    await emit({ kind: "message", threadId: "t1", message: { id: "u1", at: 103_001, role: "user", kind: "text", text: "Preview" } });
    await emit({ kind: "message", threadId: "t1", message: { id: "join", at: 103_900, role: "user", kind: "text", steered: true, queueId: "q1" } });
    await emit({ kind: "runtime", event: { type: "turn.started", threadId: "t1", turnId: "turn-1", createdAt: new Date(103_850).toISOString() } });
    now.mockReturnValue(101_800);
    await emit({ kind: "message", threadId: "t1", message: { id: "steer", at: 104_800, role: "user", kind: "text", steered: true } });
    expect(store.turnOrigin("t1")).toBe(100_000);
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn-1" } });
    now.mockReturnValue(110_000);
    await emit({ kind: "turn.dispatch", threadId: "t1", createdAt: new Date(113_000).toISOString() });
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn-1" } });
    expect(store.turnOrigin("t1")).toBe(110_000);
  });

  it("hydrates the first user row and preserves it through snapshot reconnect", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    await mountOriginStore([
      { id: "u1", at: 90_000, role: "user", kind: "text", text: "Preview" },
      { id: "join", at: 99_000, role: "user", kind: "text", steered: true, text: "And the phone" },
    ], true);
    expect(store.turnOrigin("t1")).toBe(90_000);
    now.mockReturnValue(103_000);
    await emit({ kind: "hello", resumed: false, cursor: "c2" });
    expect(store.turnOrigin("t1")).toBe(90_000);
  });

  it("uses dispatch receipt time when hydration delays frame application", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    let resolve!: (response: Response) => void;
    const snapshot = new Promise<Response>((done) => { resolve = done; });
    await mountOriginStore([], false, snapshot);
    await emit({ kind: "turn.dispatch", threadId: "t1", createdAt: new Date(100_000).toISOString() });
    now.mockReturnValue(102_000);
    await act(async () => resolve(Response.json({ bots: [], groups: [], computerControl: {} })));
    expect(store.turnOrigin("t1")).toBe(100_000);
  });

  it("changes origins four times at turn edges and zero times during 200 steady frames", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const changes = new Set<ReturnType<typeof useStore>["turnOrigin"]>();
    await mountOriginStore([], false, undefined, (origin) => changes.add(origin));
    const initial = changes.size;
    await emit({ kind: "turn.dispatch", threadId: "t1", createdAt: new Date(100_000).toISOString() });
    await emit({ kind: "message", threadId: "t1", message: { id: "u1", at: 100_010, role: "user", kind: "text", text: "Preview" } });
    await emit({ kind: "runtime", event: { type: "turn.started", threadId: "t1", turnId: "turn-1", createdAt: new Date(100_850).toISOString() } });
    expect(changes.size - initial).toBe(3);
    const steady = changes.size;
    for (let index = 0; index < 200; index++) {
      now.mockReturnValue(101_000 + index * 100);
      await delta("more ");
      if (index % 20 === 0) {
        await emit({ kind: "message", threadId: "t1", message: { id: `tool-${index}`, at: Date.now(), role: "bot", kind: "activity", tool: { name: "Read", ok: true } } });
        await emit({ kind: "message", threadId: "t1", message: { id: `join-${index}`, at: Date.now(), role: "user", kind: "text", steered: true, text: "And this" } });
        await emit({ kind: "runtime", event: { type: "turn.started", threadId: "t1", turnId: "turn-1" } });
      }
    }
    expect(changes.size - steady).toBe(0);
    expect(store.turnOrigin("t1")).toBe(100_000);
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn-1" } });
    expect(changes.size - initial).toBe(4);
  });
});

async function emit(value: object) {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(value), lastEventId: "" }));
}

async function delta(text: string) {
  await emit({ kind: "runtime", event: { type: "content.delta", threadId: "t1", streamKind: "assistant_text", delta: text } });
  await act(async () => frame?.(0));
}

describe("launch rows while streaming", () => {
  it("keeps streamed text through three launch rows and chat switches", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bot = {
      id: "b1", threadId: "t1", name: "Bot", busy: true, unread: false,
      modelSelection: { instanceId: "inst", model: "m" },
      messages: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Spawn three workers" }],
    } as Bot;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
      ? Response.json({ bots: [bot, { ...bot, id: "b2", threadId: "t2", messages: [] }], groups: [], computerControl: {} })
      : Response.json({}, { status: 404 })));
    function Probe() {
      store = useStore();
      stream = useStreaming();
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
    await emit({ kind: "hello", resumed: false, cursor: "c1" });
    await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
    await delta("Opening ");
    expect(stream.streaming.t1).toBe("Opening ");
    for (let i = 1; i <= 3; i++) {
      await emit({ kind: "message", threadId: "t1", message: {
        id: `l${i}`, parentId: i === 1 ? "u1" : `l${i - 1}`, at: i + 1, role: "bot", kind: "launch", text: `Launched worker ${i}`,
      } });
      expect.soft(buffersForTurn(stream, "t1", `l${i}`).streaming).toBe(`Opening ${"worker ".repeat(i - 1)}`);
      await delta("worker ");
    }
    await act(async () => store.dispatch({ type: "select", id: "b2" }));
    await act(async () => store.dispatch({ type: "select", id: "b1" }));
    expect(stream.streaming.t1).toBe("Opening worker worker worker ");
  });

  it("keeps streamed text whole when the user steers mid-turn", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // SAFETY: the probe bot is a full Bot fixture; only the opening user message is set.
    const bot = {
      id: "b1", threadId: "t1", name: "Bot", busy: true, unread: false,
      modelSelection: { instanceId: "inst", model: "m" },
      messages: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Make a test.txt on my Desktop" }],
    } as Bot;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
      ? Response.json({ bots: [bot], groups: [], computerControl: {} })
      : Response.json({}, { status: 404 })));
    function Probe() {
      store = useStore();
      stream = useStreaming();
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
    await emit({ kind: "hello", resumed: false, cursor: "c1" });
    await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const typed = async (text: string) => {
      await delta(text);
      clock += 1_000;
      await act(async () => frame?.(clock));
    };
    await emit({ kind: "runtime", event: { type: "turn.started", threadId: "t1", turnId: "turn-1" } });
    await typed("I'll change your Desktop ");
    await emit({ kind: "message", threadId: "t1", message: {
      id: "s1", parentId: "u1", at: 2, role: "user", kind: "text", text: "edit it and write test 2", steered: true,
    } });
    expect(buffersForTurn(stream, "t1", "s1").streaming).toBe("I'll change your Desktop ");
    await typed("test.txt to test 2.");
    expect(buffersForTurn(stream, "t1", "s1").streaming).toBe("I'll change your Desktop test.txt to test 2.");
    await emit({ kind: "message", threadId: "t1", message: {
      id: "r1", parentId: "s1", at: 3, role: "bot", kind: "text", text: "I'll change your Desktop test.txt to test 2.",
    } });
    await emit({ kind: "runtime", event: { type: "turn.completed", threadId: "t1", turnId: "turn-1" } });
    expect(store.state.bots[0]!.messages.map((message) => message.id)).toEqual(["u1", "s1", "r1"]);
  });

  it("keeps a mid-turn resume in transcript order with the reply after it", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // SAFETY: the probe bot is a full Bot fixture; only the opening user message is set.
    const bot = {
      id: "b1", threadId: "t1", name: "Bot", busy: true, unread: false,
      modelSelection: { instanceId: "inst", model: "m" },
      messages: [{ id: "u1", at: 1, role: "user", kind: "text", text: "Send the follow-up" }],
    } as Bot;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
      ? Response.json({ bots: [bot], groups: [], computerControl: {} })
      : Response.json({}, { status: 404 })));
    function Probe() {
      store = useStore();
      stream = useStreaming();
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
    await emit({ kind: "hello", resumed: false, cursor: "c1" });
    await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
    await delta("Opening ");
    await emit({ kind: "message", threadId: "t1", message: {
      id: "r1", parentId: "u1", at: 2, role: "bot", kind: "launch",
      text: "Resumed worker\nLabel: worker\nWorking folder: C:\\repo\nSession: p1",
    } });
    const ids = store.state.bots[0]!.messages.map((message) => message.id);
    expect(ids).toEqual(["u1", "r1"]);
    expect(buffersForTurn(stream, "t1", "r1").streaming).toBe("Opening ");
    await delta("more");
    expect(buffersForTurn(stream, "t1", "r1").streaming).toBe("Opening more");
    expect(buffersForTurn(stream, "t1", "u1").streaming).toBeUndefined();
  });
});
