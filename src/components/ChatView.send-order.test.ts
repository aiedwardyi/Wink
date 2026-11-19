// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { TurnStreamState } from "@/lib/turn-stage";
import { StoreProvider, useStore, type Bot, type InstanceInfo, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

const live = vi.hoisted(() => ({ current: { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} } as TurnStreamState }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStreamSelect: <T>(select: (stream: TurnStreamState) => T) => select(live.current),
}));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

// recorded timings: the line sent at +6694 was appended at +8366, after the reply (+8023) and a quick answer (+8339)
const T0 = 1_795_052_000_000;
const teacher: Bot = {
  id: "b1", threadId: "t1", name: "Teacher", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: true, activity: "working", modelSelection: { instanceId: "inst", model: "m" }, messages: [],
};
const engine = (driverKind: string, queueing: boolean): InstanceInfo => ({
  instanceId: "inst", driverKind, displayName: "Engine", models: { default: "m", options: [] }, snapshot: { state: "available" }, capabilities: { queueing },
});
const history = (count: number): Message[] => Array.from({ length: count }, (_, i) => ({
  id: `h${i}`, parentId: i ? `h${i - 1}` : undefined, at: T0 - 600_000 + i * 900, role: i % 2 ? "bot" : "user", kind: "text", text: `earlier ${i}`,
}));

let store: ReturnType<typeof useStore>;
let host: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;
const posts = new Map<string, (receipt: object) => void>();
const bodies = new Map<string, { sendSeq?: number }>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  live.current = { streaming: {}, reasoning: {}, signal: { t1: "started" }, gen: {}, turn: {} };
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  posts.clear();
  bodies.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const realSetTimeout = globalThis.setTimeout;

async function answer(sendId: string, receipt: object) {
  expect(posts.has(sendId), `no POST for ${sendId}`).toBe(true);
  posts.get(sendId)?.(receipt);
  // one real macrotask: the store reads the receipt over a few promise hops
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}

const frame = (value: object) => act(async () => FakeEventSource.last.onmessage?.({ data: JSON.stringify(value), lastEventId: "" }));

async function mount(driverKind: string, queueing: boolean, messages: Message[], queued: object[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/bots?messages=200") {
      return Response.json({ bots: [{ ...teacher, messages, activeLeafId: messages.at(-1)?.id }], groups: [], computerControl: {}, queued: { t1: queued } });
    }
    if (String(url) === "/api/bots/b1/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { sendId: string; sendSeq?: number };
      bodies.set(body.sendId, body);
      return new Promise<Response>((resolve) => posts.set(body.sendId, (receipt) => resolve(Response.json(receipt, { status: 202 }))));
    }
    return Response.json({}, { status: 404 });
  }));
  function Probe() {
    store = useStore();
    const current = store.state.bots.find((candidate) => candidate.id === store.state.selectedId);
    return current ? createElement(ChatView, { bot: current }) : null;
  }
  host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Probe)))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await frame({ kind: "hello", resumed: false, cursor: "s:0" });
  await act(async () => {
    store.dispatch({ type: "select", id: "b1" });
    store.dispatch({ type: "instances", instances: [engine(driverKind, queueing)] });
  });
}

function chat(earlier: Message[]) {
  const names: Record<string, string> = earlier.length ? { [earlier.at(-1)!.id]: "H" } : {};
  const landed: Message[] = [];
  let leaf = earlier.at(-1)?.id;
  let seen: string[] = [];
  const order = () => [...host.querySelectorAll("[data-mid], .thinking-shimmer")]
    .map((el) => el.classList.contains("thinking-shimmer") ? "thinking" : names[el.getAttribute("data-mid") ?? ""])
    .filter(Boolean);
  return {
    landed,
    order,
    name: (label: string, ...ids: string[]) => ids.forEach((id) => { names[id] = label; }),
    send: (sendId: string, text: string, after?: boolean) => store.dispatch({ type: "send", botId: "b1", text, sendId, after }),
    land: (message: Omit<Message, "parentId" | "role" | "kind"> & Partial<Message>) => {
      const row = { role: "bot", kind: "text", ...message, parentId: leaf } as Message;
      leaf = row.id;
      landed.push(row);
      return frame({ kind: "message", threadId: "t1", message: row });
    },
    at: async (offset: number, run: () => unknown) => {
      vi.setSystemTime(T0 + offset);
      await act(async () => {
        await run();
      });
      const rows = order();
      const thinking = rows.indexOf("thinking");
      if (thinking >= 0) expect(thinking, `drawn under the turn at +${offset}: ${rows}`).toBe(rows.length - 1);
      const now = rows.filter((row) => row !== "thinking");
      expect(now.slice(0, seen.length), `moved at +${offset}`).toEqual(seen);
      seen = now;
      return now;
    },
  };
}

describe("ChatView send order", () => {
  it.each([
    ["claude", 0],
    ["codex", 0],
    ["claude", 600],
    ["codex", 600],
  ])("keeps every line where it was sent while %s replies (history %i)", async (driverKind, size) => {
    const earlier = history(size);
    await mount(driverKind, true, earlier);
    const c = chat(earlier);
    c.name("L1", "s1", "row-s1");
    c.name("L2", "s2", "row-s2");
    c.name("L3", "s3", "q3", "row-s3");
    c.name("Q0", "qa0");
    c.name("Q1", "qa1");
    c.name("Q2", "qa2");
    c.name("R1", "r1");
    c.name("R2", "r2");
    c.name("R3", "r3");
    const lead = size ? ["H"] : [];
    const steered = (id: string, sendId: string, text: string, sent: number, at: number) =>
      ({ id, sendId, text, role: "user" as const, steered: true, actedAt: T0 + sent, at: T0 + at });

    await c.at(4509, () => c.send("s1", "이거 이상해"));
    await c.at(5485, () => c.land(steered("row-s1", "s1", "이거 이상해", 4509, 5485)));
    await c.at(5500, () => answer("s1", { steered: true, threadId: "t1", message: c.landed.at(-1) }));
    await c.at(5906, () => c.land({ id: "qa0", text: "빠른 답 0", quick: { state: "answer", askId: "h0" }, at: T0 + 5906 }));
    await c.at(6694, () => c.send("s2", "메시지들"));
    await c.at(8023, () => c.land({ id: "r1", text: "답장 1", at: T0 + 8023 }));
    await c.at(8339, () => c.land({ id: "qa1", text: "빠른 답 1", quick: { state: "answer", askId: "row-s1" }, at: T0 + 8339 }));
    await c.at(8366, () => c.land(steered("row-s2", "s2", "메시지들", 6694, 8366)));
    await c.at(8370, () => answer("s2", { steered: true, threadId: "t1", message: c.landed.at(-1) }));
    await c.at(8979, () => c.land({ id: "qa2", text: "빠른 답 2", quick: { state: "answer", askId: "row-s2" }, at: T0 + 8979 }));
    await c.at(9500, () => c.send("s3", "한 번 더 테스트"));
    // the engine could not take it that instant: the server holds a plain send
    await c.at(9700, () => answer("s3", { queued: true, threadId: "t1", queueId: "q3" }));
    expect(host.textContent).not.toContain("Sends next");
    await c.at(11164, () => c.land({ id: "r2", text: "답장 2", at: T0 + 11164 }));
    await c.at(11500, () => c.land({ ...steered("row-s3", "s3", "한 번 더 테스트", 9500, 11500), queueId: "q3" }));
    const final = await c.at(13000, () => c.land({ id: "r3", text: "답장 3", at: T0 + 13000 }));
    expect(final).toEqual([...lead, "L1", "Q0", "L2", "R1", "Q1", "Q2", "L3", "R2", "R3"]);
    expect(host.textContent).not.toContain("Sends next");

    await unmount?.();
    await mount(driverKind, true, [...earlier, ...c.landed]);
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it.each(["claude", "codex"])("never shows Sends next for a plain line %s could not take that instant", async (driverKind) => {
    const earlier = history(2);
    await mount(driverKind, true, earlier);
    const c = chat(earlier);
    c.name("L1", "s1", "q1");
    await c.at(0, () => c.send("s1", "테스트 abc"));
    await c.at(200, () => answer("s1", { queued: true, threadId: "t1", queueId: "q1" }));
    expect(c.order()).toEqual(["H", "L1", "thinking"]);
    expect(host.textContent).not.toContain("Sends next");
  });

  it("keeps a line sent as the turn ends above the reply that finished after it", async () => {
    const earlier = history(3);
    await mount("claude", true, earlier);
    const c = chat(earlier);
    c.name("L1", "s1", "row-s1");
    c.name("R1", "r1");
    c.name("R2", "r2");
    await c.at(0, () => c.send("s1", "지금 보내"));
    await c.at(300, () => c.land({ id: "r1", text: "마지막 답", at: T0 + 300 }));
    await c.at(320, async () => {
      live.current = { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} };
      await frame({ kind: "bot", bot: { ...teacher, busy: false, activity: undefined } });
    });
    await c.at(900, async () => {
      live.current = { streaming: {}, reasoning: {}, signal: { t1: "started" }, gen: {}, turn: {} };
      await frame({ kind: "bot", bot: { ...teacher, busy: true, activity: "working" } });
      await c.land({ id: "row-s1", sendId: "s1", text: "지금 보내", role: "user", actedAt: T0, at: T0 + 900 });
    });
    const final = await c.at(5000, () => c.land({ id: "r2", text: "새 답", at: T0 + 5000 }));
    expect(final).toEqual(["H", "L1", "R1", "R2"]);

    await unmount?.();
    await mount("claude", true, [...earlier, ...c.landed]);
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it("keeps a held line where the server stamped it while this window's clock runs a minute ahead", async () => {
    const earlier = history(2);
    await mount("claude", true, earlier);
    const c = chat(earlier);
    c.name("L1", "s1", "q1");
    c.name("R1", "r1");
    // this window reads +60000 while the server stamps the held line and the reply by its own clock
    await c.at(60_000, () => c.send("s1", "내 첫 줄"));
    await c.at(60_200, () => answer("s1", { queued: true, threadId: "t1", queueId: "q1", actedAt: T0 }));
    const final = await c.at(60_500, () => c.land({ id: "r1", text: "진행 중", at: T0 + 500 }));
    expect(final).toEqual(["H", "L1", "R1"]);

    await unmount?.();
    await mount("claude", true, [...earlier, ...c.landed], [{ queueId: "q1", text: "내 첫 줄", sendId: "s1", at: T0 }]);
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it("keeps two lines in the order sent when the second POST is answered first", async () => {
    // a synced row stamped a minute ahead: the server stamps both lines just past it
    const peer: Message = { id: "peer", role: "bot", kind: "text", text: "앞선 답", at: T0 + 60_000 };
    await mount("claude", true, [peer]);
    const c = chat([peer]);
    c.name("A1", "s1", "q1");
    c.name("A2", "s2", "q2");
    await c.at(0, () => c.send("s1", "첫 답"));
    await c.at(100, () => c.send("s2", "둘째 답"));
    await c.at(300, () => answer("s2", { queued: true, threadId: "t1", queueId: "q2", actedAt: T0 + 60_001 }));
    const final = await c.at(400, () => answer("s1", { queued: true, threadId: "t1", queueId: "q1", actedAt: T0 + 60_001 }));
    expect(final).toEqual(["H", "A1", "A2"]);

    await unmount?.();
    // the server held the second POST first
    const held = (sendId: string, queueId: string, text: string) => ({ queueId, text, sendId, at: T0 + 60_001, sendSeq: bodies.get(sendId)?.sendSeq });
    await mount("claude", true, [peer], [held("s2", "q2", "둘째 답"), held("s1", "q1", "첫 답")]);
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it("still shows Sends next for a line queued with Ctrl+Enter", async () => {
    await mount("claude", true, history(2));
    await act(async () => store.dispatch({ type: "send", botId: "b1", text: "다음에", sendId: "s1", after: true }));
    expect(host.querySelector('[data-mid="s1"]')?.textContent).toContain("Sends next");
    await act(() => answer("s1", { queued: true, threadId: "t1", queueId: "q1" }));
    expect(host.querySelector('[data-mid="q1"]')?.textContent).toContain("Sends next");
  });

  it.each([60, 125])("keeps a Ctrl+Enter line and its Sends next after a reload with %i later rows", async (later) => {
    const earlier = history(later + 2);
    await mount("claude", true, earlier, [{ queueId: "q1", text: "다음에", sendId: "s1", at: earlier[1]!.at + 1, waited: true }]);
    expect(host.querySelector('[data-mid="q1"]')?.textContent).toContain("Sends next");
  });

  it("keeps Send now and Cancel on a plain line the engine could not take that instant", async () => {
    const earlier = history(2);
    await mount("claude", true, earlier, [{ queueId: "q1", text: "지금 보내", sendId: "s1", at: earlier[1]!.at + 1 }]);
    expect(host.textContent).not.toContain("Sends next");
    const sent = [...host.querySelectorAll("[data-orbit-message='user']")].find((el) => el.textContent?.includes("지금 보내"))!;
    await act(async () => sent.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
    expect(document.querySelector("[data-menu-send-now]")).not.toBeNull();
    expect(document.querySelector("[data-menu-cancel-queued]")).not.toBeNull();
  });

  it("still shows Sends next on an engine that cannot take a line mid-turn", async () => {
    await mount("acp", false, history(2));
    await act(async () => store.dispatch({ type: "send", botId: "b1", text: "기다려", sendId: "s1" }));
    await act(() => answer("s1", { queued: true, threadId: "t1", queueId: "q1" }));
    expect(host.querySelector('[data-mid="q1"]')?.textContent).toContain("Sends next");
  });
});
