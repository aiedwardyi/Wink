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

const bot: Bot = {
  id: "b1", threadId: "t1", name: "Atlas", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: true, activity: "working", workingThreadId: "gt", modelSelection: { instanceId: "inst", model: "m" }, messages: [],
};
const line = (id: string, text: string, sendId?: string): Message => ({ id, at: 90_000, role: "user", kind: "text", text, sendId });
const room: Group = {
  id: "g1", threadId: "gt", name: "Room", memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "",
  unread: false, createdAt: 1, setupCompletedAt: 1, busyBotId: "b1", messages: [line("u1", "go ahead")],
};

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
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

type Frame = { kind: "hello"; resumed: boolean; cursor: string } | { kind: "message"; threadId: string; message: Message };
const frame = (value: Frame) => act(async () => FakeEventSource.last.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }));
const shown = (text: string) => host.querySelector('[role="log"]')?.textContent?.split(text).length ?? 0;

async function mount() {
  // the send POST never answers, as when the server holds it for sync
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [bot], groups: [room], computerControl: {} })
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
  await act(async () => store.dispatch({ type: "select", id: "g1" }));
}

describe("GroupView sent lines", () => {
  it("shows a line the moment it is sent, while the server still holds it", async () => {
    await mount();
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "one more thing", sendId: "s1" }));
    expect(shown("one more thing")).toBe(2);
  });

  it("offers Reply on a sent line only once the server has it", async () => {
    await mount();
    const reply = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Reply to message"]')].at(-1);
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "one more thing", sendId: "s1" }));
    expect(reply()?.disabled).toBe(true);
    await frame({ kind: "message", threadId: "gt", message: line("u2", "one more thing", "s1") });
    expect(reply()?.disabled).toBe(false);
  });

  it("keeps one copy when the server's message lands", async () => {
    await mount();
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "one more thing", sendId: "s1" }));
    await frame({ kind: "message", threadId: "gt", message: line("u2", "one more thing", "s1") });
    expect(shown("one more thing")).toBe(2);
  });
});
