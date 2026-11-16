// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";

import { GroupView } from "./GroupView";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot = (busy = false): Bot => ({
  id: "b1", threadId: "t1", name: "Atlas", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy, activity: busy ? "working" : undefined, modelSelection: { instanceId: "inst", model: "m" }, messages: [],
});
const room = (busyBotId: string | null, messages: Message[] = []): Group => ({
  id: "g1", threadId: "gt", name: "Room", memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "",
  unread: false, createdAt: 1, setupCompletedAt: 1, busyBotId, messages,
});
const line = (id: string, at: number): Message => ({ id, at, role: "user", kind: "text", text: id });

let store: ReturnType<typeof useStore>;
let host: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;

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
const runtime = (type: string, turnId: string) => frame({ kind: "runtime", event: { type, threadId: "gt", turnId, createdAt: new Date().toISOString() } });
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
const elapsed = () => host.textContent?.match(/\(\d+s\)/)?.[0];
const busy = (busyBotId: string | null) => frame({ kind: "group", group: { ...room(busyBotId), messages: undefined } });
const dispatch = async () => {
  await frame({ kind: "turn.dispatch", threadId: "gt", createdAt: new Date().toISOString() });
  await busy("b1");
};

async function mount() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [bot()], groups: [room(null)], computerControl: {} })
    : String(url).includes("/messages")
      ? new Promise<Response>(() => {})
      : Response.json({}, { status: 404 })));
  function Probe() {
    store = useStore();
    const current = store.state.groups.find((candidate) => candidate.id === store.state.selectedId);
    return current ? createElement(GroupView, { group: current }) : null;
  }
  host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Probe)))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await frame({ kind: "hello", resumed: false, cursor: "s:0" });
  await frame({ kind: "instances", instances: [{
    instanceId: "inst", driverKind: "codex", displayName: "Engine", snapshot: { state: "available" },
    models: { default: "m", options: [{ id: "m", label: "Model" }] },
  }] });
  await act(async () => store.dispatch({ type: "select", id: "g1" }));
}

describe("GroupView turn origin", () => {
  it("a new send never shows the previous line's age", async () => {
    await mount();
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "first", sendId: "s1" }));
    await dispatch();
    await frame({ kind: "message", threadId: "gt", message: line("u1", Date.now()) });
    await runtime("turn.started", "turn-1");
    await advance(3200);
    await runtime("turn.completed", "turn-1");
    await busy(null);
    await advance(12_000);
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "second", sendId: "s2" }));
    expect(host.querySelector("[data-turn-mascot]")).not.toBeNull();
    expect(elapsed()).toBeUndefined();
    await dispatch();
    expect(elapsed()).toBe("(0s)");
    await frame({ kind: "message", threadId: "gt", message: line("u2", Date.now()) });
    await advance(1200);
    expect(elapsed()).toBe("(1s)");
  });
});
