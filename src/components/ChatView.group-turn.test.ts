// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const asked: Message = { id: "u1", at: 100_000, role: "user", kind: "text", text: "What is the plan?" };
const bot = (workingThreadId: string | null): Bot => ({
  id: "b1", threadId: "t1", name: "Alpha", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: true, activity: "working", workingThreadId, modelSelection: { instanceId: "inst", model: "m" }, messages: [asked],
});
const room = (busyBotId: string | null): Group => ({
  id: "g1", threadId: "g1-thread", name: "Team", memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "",
  unread: false, createdAt: 1, busyBotId, messages: [],
});

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
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const frame = (value: object) => act(async () => FakeEventSource.last.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }));

async function mount(workingThreadId: string | null, busyBotId: string | null) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [bot(workingThreadId)], groups: [room(busyBotId)], computerControl: {} })
    : Response.json({}, { status: 404 })));
  let store!: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    const current = store.state.bots.find((candidate) => candidate.id === store.state.selectedId);
    return current ? createElement(ChatView, { bot: current }) : null;
  }
  host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Probe)))));
  await frame({ kind: "hello", resumed: false, cursor: "s:0" });
  await frame({ kind: "instances", instances: [{
    instanceId: "inst", driverKind: "codex", displayName: "Engine", snapshot: { state: "available" },
    models: { default: "m", options: [{ id: "m", label: "Model" }] },
  }] });
  await act(async () => store.dispatch({ type: "select", id: "b1" }));
  await act(async () => vi.advanceTimersByTime(30_000));
}

const presence = () => host.querySelector("[data-turn-mascot]");

describe("ChatView while the bot works in a group", () => {
  it("shows no working line in the 1:1 for a turn running in a group", async () => {
    await mount("g1-thread", "b1");
    expect(presence()).toBeNull();
    expect(host.textContent).not.toMatch(/\(\d+s\)/);
  });

  it("shows none when only the group names the bot as working", async () => {
    await mount(null, "b1");
    expect(presence()).toBeNull();
  });

  it("keeps the working line for a turn in the 1:1 itself", async () => {
    await mount("t1", null);
    expect(presence()).not.toBeNull();
  });
});
