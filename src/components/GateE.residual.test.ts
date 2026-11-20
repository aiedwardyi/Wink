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
  color: "blue", unread: false, busy: false, modelSelection: { instanceId: "inst", model: "m" }, messages: [],
};
const line = (id: string, text: string, sendId?: string): Message => ({ id, at: 90_000, role: "user", kind: "text", text, sendId });
const reply: Message = { id: "m1", at: 103_000, role: "bot", kind: "text", text: "the reply it waited for", from: { botId: "b1", name: "Atlas", color: "blue" } };
const room: Group = {
  id: "g1", threadId: "gt", name: "Room", memberIds: ["b1"], defaultResponder: { kind: "everyone" }, bulletin: "",
  unread: false, createdAt: 1, setupCompletedAt: 1, messages: [line("u1", "go ahead"), reply],
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

const frame = (value: unknown) => act(async () => FakeEventSource.last.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }));

async function mount(messages: Message[], extra: Partial<Group> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url) === "/api/bots?messages=200"
    ? Response.json({ bots: [bot], groups: [{ ...room, messages, ...extra }], computerControl: {} })
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

const names: Record<string, string> = { u1: "ask", m1: "reply", s1: "held", g1: "held", s2: "follow", g2: "follow" };
const order = () => [...host.querySelectorAll("[data-mid]")].map((el) => names[el.getAttribute("data-mid") ?? ""]).filter(Boolean);

describe("gate E residual", () => {
  it.each([
    ["a room", {}, 50],
    ["a room, 2 s later", {}, 2_000],
    ["a hosted room", { hosted: { roomId: "r1" } }, 50],
  ])("keeps a plain line below the held line it was sent after, in %s", async (_, extra: Partial<Group>, gap: number) => {
    await mount(room.messages, extra);
    const trace: [string, string[]][] = [];
    vi.setSystemTime(105_000);
    // held with Ctrl+Enter at 100_000, sent as the room settled
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "held line", sendId: "s1", actedAt: 100_000, waited: true }));
    trace.push(["held sent", order()]);
    vi.setSystemTime(105_000 + gap);
    await act(async () => store.dispatch({ type: "sendGroup", groupId: "g1", text: "quick follow-up", sendId: "s2" }));
    trace.push(["follow-up sent", order()]);
    const bodies = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/groups/g1/messages").map(([, init]) => JSON.parse(String(init?.body)) as Message & { actedAt?: number });
    expect(bodies).toHaveLength(2);
    const anchor = extra.hosted ? undefined : reply.id;
    expect(bodies.map((body) => body.sentAfterId)).toEqual([anchor, anchor]);
    const at1 = 105_000 + gap + 150;
    const stored1: Message = { ...line("g1", "held line", "s1"), at: at1, actedAt: bodies[0]!.actedAt, waited: bodies[0]!.waited, sendSeq: bodies[0]!.sendSeq, sentAfterId: bodies[0]!.sentAfterId };
    vi.setSystemTime(at1);
    await frame({ kind: "message", threadId: "gt", message: stored1 });
    trace.push(["held row stored", order()]);
    const at2 = at1 + 100;
    const stored2: Message = { ...line("g2", "quick follow-up", "s2"), at: at2, actedAt: bodies[1]!.actedAt === undefined ? undefined : Math.min(bodies[1]!.actedAt, at2), sendSeq: bodies[1]!.sendSeq, sentAfterId: bodies[1]!.sentAfterId, steered: true };
    vi.setSystemTime(at2);
    await frame({ kind: "message", threadId: "gt", message: stored2 });
    trace.push(["follow-up row stored", order()]);
    await unmount?.();
    await mount([...room.messages, stored1, stored2], extra);
    trace.push(["reload", order()]);
    expect(trace.map(([, rows]) => rows)).toEqual([
      ["ask", "reply", "held"],
      ["ask", "reply", "held", "follow"],
      ["ask", "reply", "held", "follow"],
      ["ask", "reply", "held", "follow"],
      ["ask", "reply", "held", "follow"],
    ]);
  });
});
