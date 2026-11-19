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

async function mount(idle = false, messages = room.messages) {
  // the send POST never answers, as when the server holds it for sync
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json(idle
      ? { bots: [{ ...bot, busy: false, activity: undefined }], groups: [{ ...room, messages, busyBotId: undefined }], computerControl: {} }
      : { bots: [bot], groups: [{ ...room, messages }], computerControl: {} })
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

  it("keeps a line sent into an idle room through a reconnect while the server still holds it", async () => {
    await mount(true);
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "one more thing", sendId: "s1" }));
    expect(shown("one more thing")).toBe(2);
    await frame({ kind: "hello", resumed: false, cursor: "s:1" });
    expect(shown("one more thing")).toBe(2);
  });

  it("quotes the line a sent reply answers while the server still holds it", async () => {
    await mount();
    expect(shown("go ahead")).toBe(2);
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "yes", sendId: "s1", replyToId: "u1" }));
    expect(shown("go ahead")).toBe(3);
  });

  it("keeps one copy when the server's message lands", async () => {
    await mount();
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "one more thing", sendId: "s1" }));
    await frame({ kind: "message", threadId: "gt", message: line("u2", "one more thing", "s1") });
    expect(shown("one more thing")).toBe(2);
  });

  it("keeps every line where it was sent while a member replies, live and after reload", async () => {
    await mount();
    const names: Record<string, string> = { u1: "U", s1: "L1", g1: "L1", s2: "L2", g2: "L2", s3: "L3", g3: "L3", m1: "M1", m2: "M2" };
    const order = () => [...host.querySelectorAll("[data-mid]")].map((el) => names[el.getAttribute("data-mid") ?? ""]).filter(Boolean);
    const landed: Message[] = [];
    let seen: string[] = [];
    const at = async (time: number, run: () => unknown) => {
      vi.setSystemTime(time);
      await act(async () => {
        await run();
      });
      const now = order();
      expect(now.slice(0, seen.length), `moved at ${time}`).toEqual(seen);
      seen = now;
    };
    const send = (sendId: string, text: string) => store.dispatch({ type: "sendGroup", groupId: "g1", text, sendId });
    const land = (message: Message) => {
      landed.push(message);
      return frame({ kind: "message", threadId: "gt", message });
    };
    const member = (id: string, text: string, at: number): Message => ({ id, at, role: "bot", kind: "text", text, from: { botId: "b1", name: "Atlas", color: "blue" } });
    const mine = (id: string, sendId: string, text: string, sent: number, at: number): Message => ({ ...line(id, text, sendId), at, steered: true, actedAt: sent });

    await at(100_000, () => send("s1", "이거 이상해"));
    await at(100_600, () => land(member("m1", "답장 1", 100_600)));
    await at(100_900, () => land(mine("g1", "s1", "이거 이상해", 100_000, 100_900)));
    await at(101_500, () => send("s2", "메시지들"));
    await at(102_000, () => send("s3", "한 번 더"));
    await at(102_300, () => land(member("m2", "답장 2", 102_300)));
    await at(102_600, () => land(mine("g2", "s2", "메시지들", 101_500, 102_600)));
    await at(102_900, () => land(mine("g3", "s3", "한 번 더", 102_000, 102_900)));
    expect(seen).toEqual(["U", "L1", "M1", "L2", "L3", "M2"]);

    const live = seen;
    await unmount?.();
    await mount(false, [...room.messages, ...landed]);
    expect(order()).toEqual(live);
  });
});
