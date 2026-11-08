// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StoreProvider, useStore, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const user: Message = { id: "u1", at: 100_000, role: "user", kind: "text", text: "Check the preview" };
const bot = (messages: Message[], busy = true): Bot => ({
  id: "b1", threadId: "t1", name: "Teacher", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy, activity: "working", modelSelection: { instanceId: "inst", model: "m" }, messages,
});

let store: ReturnType<typeof useStore>;
let host: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;
let showChat = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.documentElement.dataset.skin = "terminal";
  showChat = true;
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.skin;
});

const frame = (value: object) => act(async () => FakeEventSource.last.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }));
const runtime = (type: string, turnId = "turn-1") => frame({ kind: "runtime", event: { type, threadId: "t1", turnId, createdAt: new Date().toISOString() } });
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
const elapsed = () => host.textContent?.match(/\(\d+s\)/)?.[0];
const row = (message: Message) => frame({ kind: "message", threadId: "t1", message });

async function mount(messages: Message[] = [], busy = false, older?: Promise<{ messages: Message[]; hasMore: boolean }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [{ ...bot(messages, busy), hasMore: Boolean(older) }, { ...bot([], false), id: "b2", threadId: "t2" }], groups: [], computerControl: {} })
    : older && String(url).startsWith("/api/threads/t1/messages?")
      ? Response.json(await older)
      : Response.json({}, { status: 404 })));
  function Probe() {
    store = useStore();
    const current = store.state.bots.find((candidate) => candidate.id === store.state.selectedId);
    return showChat && current ? createElement(ChatView, { bot: current }) : null;
  }
  host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = () => act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Probe)))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await render();
  await frame({ kind: "hello", resumed: false, cursor: "s:0" });
  expect(store.state.hydrated).toBe(true);
  await frame({ kind: "instances", instances: [{
    instanceId: "inst", driverKind: "codex", displayName: "Engine", snapshot: { state: "available" },
    models: { default: "m", options: [{ id: "m", label: "Model" }] },
  }] });
  await act(async () => store.dispatch({ type: "select", id: "b1" }));
  return render;
}

async function dispatch(createdAt = new Date().toISOString()) {
  const value = { kind: "turn.dispatch", threadId: "t1", createdAt };
  await frame(value);
  await frame({ kind: "bot", bot: { ...bot([], true), messages: undefined } });
  return value;
}

describe("ChatView turn origin", () => {
  it("a queued join during setup keeps the elapsed origin", async () => {
    await mount();
    await dispatch();
    await row(user);
    await advance(900);
    await row({ ...user, id: "u2", parentId: "u1", at: Date.now(), queueId: "q1", steered: true });
    await advance(1300);
    expect(elapsed()).toBe("(2s)");
  });

  it("an accepted steer keeps the elapsed origin", async () => {
    await mount();
    await dispatch();
    await row(user);
    await runtime("turn.started");
    await advance(1800);
    await row({ ...user, id: "u2", parentId: "u1", at: Date.now(), steered: true });
    await advance(1400);
    expect(elapsed()).toBe("(3s)");
  });

  it("the count starts at dispatch before the row lands", async () => {
    await mount();
    await dispatch();
    await advance(2200);
    expect(elapsed()).toBe("(2s)");
    await row({ ...user, at: Date.now() });
    expect(elapsed()).toBe("(2s)");
  });

  it("a drained queued message starts a new origin", async () => {
    await mount();
    await dispatch();
    await row(user);
    await runtime("turn.started");
    await advance(3200);
    await runtime("turn.completed");
    await row({ ...user, id: "drain", parentId: "u1", at: Date.now(), queueId: "q1" });
    await dispatch();
    await runtime("turn.started", "turn-2");
    await advance(1800);
    expect(elapsed()).toBe("(1s)");
    expect(store.turnOrigin("t1")).toBe(103_200);
  });

  it("remount, docking and chat switch keep the origin", async () => {
    const render = await mount();
    await dispatch();
    await row(user);
    await runtime("turn.started");
    await advance(2200);
    showChat = false;
    await render();
    showChat = true;
    await render();
    expect(elapsed()).toBe("(2s)");
    await act(async () => store.dispatch({ type: "select", id: "b2" }));
    await advance(1000);
    await act(async () => store.dispatch({ type: "select", id: "b1" }));
    expect(elapsed()).toBe("(3s)");
    await frame({ kind: "runtime", event: { type: "content.delta", threadId: "t1", turnId: "turn-1", streamKind: "assistant_text", delta: "Checking the preview. " } });
    await advance(500);
    expect(host.querySelector("[data-turn-mascot]")).not.toBeNull();
    expect(elapsed()).toBe("(3s)");
    expect(store.turnOrigin("t1")).toBe(100_000);
  });

  it("SSE reconnect with the same row keeps the origin", async () => {
    await mount();
    const dispatchFrame = await dispatch();
    await row(user);
    await runtime("turn.started");
    await advance(2200);
    await frame({ kind: "hello", resumed: true, cursor: "s:2" });
    await frame(dispatchFrame);
    await row(user);
    await runtime("turn.started");
    await advance(1000);
    expect(elapsed()).toBe("(3s)");
  });

  it("a viewer behind the server clock never holds 0", async () => {
    await mount();
    await dispatch(new Date(Date.now() + 3000).toISOString());
    await row({ ...user, at: Date.now() + 3000 });
    await advance(1200);
    expect(elapsed()).toBe("(1s)");
  });

  it("hydration mid-turn counts from the turn's first row", async () => {
    await mount([
      { ...user, at: 90_000 },
      { ...user, id: "tool", parentId: "u1", at: 95_000, role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
      { ...user, id: "join", parentId: "tool", at: 99_000, steered: true },
    ], true);
    expect(elapsed()).toBe("(10s)");
    expect(store.turnOrigin("t1")).toBe(90_000);
  });

  it("a reload with a future row starts from its first observation", async () => {
    await mount([{ ...user, at: 103_000 }], true);
    expect(elapsed()).toBe("(0s)");
    await advance(1200);
    expect(elapsed()).toBe("(1s)");
  });

  it("recovers the elapsed origin when prompt paging loads an older user row", async () => {
    let resolve!: (page: { messages: Message[]; hasMore: boolean }) => void;
    const older = new Promise<{ messages: Message[]; hasMore: boolean }>((done) => { resolve = done; });
    const messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
      id: `tool-${index}`, parentId: index ? `tool-${index - 1}` : "u1", at: 95_000 + index,
      role: "bot", kind: "activity", tool: { name: "Read", ok: true },
    }));
    await mount(messages, true, older);
    expect(store.turnOrigin("t1")).toBe(100_000);
    await advance(1200);
    await act(async () => resolve({ messages: [{ ...user, at: 90_000 }], hasMore: false }));
    expect(store.state.bots[0].messages[0].id).toBe("u1");
    expect(store.turnOrigin("t1")).toBe(90_000);
    await advance(1000);
    expect(elapsed()).toBe("(12s)");
  });

  it("noReply shows no timer", async () => {
    await mount();
    await dispatch();
    await row(user);
    await runtime("turn.started");
    await advance(120_000);
    expect(host.textContent).toContain("hasn't replied in 2");
    expect(elapsed()).toBeUndefined();
  });
});
