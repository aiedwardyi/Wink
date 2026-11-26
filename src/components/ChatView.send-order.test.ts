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
  id: `h${i}`, parentId: i ? `h${i - 1}` : undefined, at: T0 - 600_000 + i * 900, role: (count - i) % 2 ? "user" : "bot", kind: "text", text: `earlier ${i}`,
}));

let store: ReturnType<typeof useStore>;
let host: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;
const posts = new Map<string, (receipt: object) => void>();
const bodies = new Map<string, { sendSeq?: number; actedAt?: number; sentAfterId?: string | null }>();

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

async function mount(driverKind: string, queueing: boolean, messages: Message[], queued: object[] = [], hello: object = {}, flat = false, bot: Partial<Bot> = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/bots?messages=200") {
      return Response.json({ bots: [{ ...teacher, messages, activeLeafId: flat ? null : messages.at(-1)?.id, ...bot }], groups: [], computerControl: {}, queued: { t1: queued } });
    }
    if (String(url) === "/api/bots/b1/messages" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { sendId: string; sendSeq?: number; actedAt?: number; sentAfterId?: string | null };
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
  await frame({ kind: "hello", resumed: false, cursor: "s:0", ...hello });
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
  let liveName: string | undefined;
  // the running turn's newest text sits in the live step line, which replaces itself
  const order = () => [...host.querySelectorAll("[data-mid], [data-live-step], .thinking-shimmer")]
    .map((el) => el.classList.contains("thinking-shimmer") ? "thinking" : !el.hasAttribute("data-live-step") ? names[el.getAttribute("data-mid") ?? ""]
      : liveName = names[landed.findLast((row) => row.role === "bot" && el.textContent?.includes(row.text ?? "\u0000"))?.id ?? ""])
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
      seen = now.filter((row) => row !== liveName);
      return now;
    },
  };
}

describe("ChatView send order", () => {
  it("keeps the sender's order across a 300 ms peer skew, queue receipt and reload", async () => {
    const peer: Message = { id: "peer", parentId: null, role: "bot", kind: "text", text: "peer", at: T0 + 300 };
    await mount("codex", true, [peer], [], { now: T0 });
    const c = chat([peer]);
    c.name("L1", "s1", "q1", "row-s1");
    c.name("L2", "s2", "row-s2");
    c.name("R1", "r1");
    await c.at(100, () => c.send("s1", "one"));
    await c.at(150, () => c.land({ id: "r1", at: T0 + 150, text: "progress" }));
    await c.at(200, () => c.send("s2", "two"));
    expect(bodies.get("s1")?.sentAfterId).toBe("peer");
    expect(bodies.get("s2")?.sentAfterId).toBe("r1");
    const { sendSeq, sentAfterId, actedAt } = bodies.get("s1")!;
    await c.at(210, () => answer("s1", { queued: true, threadId: "t1", queueId: "q1", actedAt, sentAfterId }));
    await c.at(260, () => c.land({ ...bodies.get("s2"), id: "row-s2", at: T0 + 260, role: "user", sendId: "s2", text: "two" }));
    await c.at(270, () => answer("s2", { threadId: "t1", message: c.landed.at(-1) }));

    await unmount?.();
    await mount("codex", true, [peer, ...c.landed], [{ queueId: "q1", text: "one", sendId: "s1", at: actedAt, sendSeq, sentAfterId }]);
    expect(c.order().filter((row) => row !== "thinking")).toEqual(["H", "L1", "R1", "L2"]);
    const final = await c.at(280, () => c.land({ id: "row-s1", at: T0 + 280, role: "user", sendId: "s1", queueId: "q1", text: "one", actedAt, sendSeq, sentAfterId }));
    await unmount?.();
    await mount("codex", true, [peer, ...c.landed]);
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it("anchors a send only to a loaded transcript", async () => {
    await mount("codex", true, history(4), [], {}, false, { activeLeafId: "older-leaf", hasMore: true });
    expect(host.querySelectorAll("[data-mid]")).toHaveLength(0);
    await act(async () => store.dispatch({ type: "send", botId: "b1", text: "while paging", sendId: "s1" }));
    await unmount?.();
    await mount("codex", true, history(2));
    await act(async () => store.dispatch({ type: "send", botId: "b1", threadId: "t2", text: "other thread", sendId: "s2" }));
    await unmount?.();
    await mount("codex", true, []);
    await act(async () => store.dispatch({ type: "send", botId: "b1", text: "first line", sendId: "s3" }));
    expect(bodies.get("s1")).not.toHaveProperty("sentAfterId");
    expect(bodies.get("s2")).toMatchObject({ threadId: "t2" });
    expect(bodies.get("s2")).not.toHaveProperty("sentAfterId");
    expect(bodies.get("s3")).toHaveProperty("sentAfterId", null);
  });

  it("allocates consecutive sequences and keeps stamps through a late ping before React renders", async () => {
    const earlier = history(2);
    earlier[0]!.sendSeq = 42;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    await mount("codex", true, earlier, [], { now: T0 });
    const c = chat(earlier);
    await act(async () => {
      c.send("s1", "one");
      FakeEventSource.last.onmessage?.({ data: JSON.stringify({ kind: "ping", now: T0 - 2_000 }), lastEventId: "" });
      c.send("s2", "two");
    });
    expect([bodies.get("s1"), bodies.get("s2")]).toMatchObject([{ actedAt: T0, sendSeq: 43 }, { actedAt: T0, sendSeq: 44 }]);
  });

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
      ({ id, sendId, text, role: "user" as const, steered: true, actedAt: T0 + sent, at: T0 + at, sendSeq: bodies.get(sendId)?.sendSeq });

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
    // with history the turn has a start, so R2 is an earlier step of it and R3 its live line
    expect(final).toEqual([...lead, "L1", "Q0", "L2", "R1", "Q1", "Q2", "L3", ...size ? [] : ["R2"], "R3"]);
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
      await c.land({ id: "row-s1", sendId: "s1", text: "지금 보내", role: "user", actedAt: T0, at: T0 + 900, sendSeq: bodies.get("s1")?.sendSeq });
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
    await mount("claude", true, [...earlier, ...c.landed], [{ queueId: "q1", text: "내 첫 줄", sendId: "s1", at: T0, sendSeq: bodies.get("s1")?.sendSeq }]);
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

  it.each([
    [300, "steer"],
    [300, "queue"],
    [2000, "steer"],
    [2000, "queue"],
  ])("keeps a line where it was sent while this window's clock runs %i ms ahead of the server (%s)", async (ahead, path) => {
    const earlier = history(2);
    // the window counts on from the server's clock by elapsed time, which only timers move here
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    // the server's hello reads T0 while this window reads T0 + ahead
    vi.setSystemTime(T0 + ahead);
    await mount("claude", true, earlier, [], { now: T0 });
    const c = chat(earlier);
    c.name("L1", "s1", "q1", "row-s1");
    c.name("P1", "p1");
    await c.at(ahead, () => c.send("s1", "내 줄"));
    // the server takes the POST at T0 + 10 and never stamps a line later than that
    const stamp = Math.min(bodies.get("s1")!.actedAt!, T0 + 10);
    await c.at(ahead + 40, () => c.land({ id: "p1", text: "진행 중", at: T0 + 40 }));
    if (path === "steer") {
      await c.at(ahead + 70, () => c.land({ id: "row-s1", sendId: "s1", text: "내 줄", role: "user", steered: true, actedAt: stamp, at: T0 + 70, sendSeq: bodies.get("s1")?.sendSeq }));
      await c.at(ahead + 80, () => answer("s1", { steered: true, threadId: "t1", message: c.landed.at(-1) }));
    } else {
      await c.at(ahead + 80, () => answer("s1", { queued: true, threadId: "t1", queueId: "q1", actedAt: stamp }));
    }
    const final = c.order().filter((row) => row !== "thinking");
    expect(final).toEqual(["H", "L1", "P1"]);

    await unmount?.();
    const held = path === "queue" ? [{ queueId: "q1", text: "내 줄", sendId: "s1", at: stamp, sendSeq: bodies.get("s1")?.sendSeq }] : [];
    await mount("claude", true, [...earlier, ...c.landed], held, { now: T0 + 100 });
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it.each([1500, 3000])("keeps two lines in the order sent when a ping %i ms late lands between them", async (late) => {
    const earlier = history(2);
    // the window counts on from the server's clock by elapsed time, which only timers move here
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    vi.setSystemTime(T0);
    await mount("claude", true, earlier, [], { now: T0 });
    const c = chat(earlier);
    c.name("L1", "s1", "row-s1");
    c.name("L2", "s2", "row-s2");
    const mine = (sendId: string, text: string, at: number) =>
      ({ ...bodies.get(sendId), id: `row-${sendId}`, sendId, text, role: "user" as const, steered: true, at: T0 + at });
    await c.at(0, () => c.send("s1", "첫 줄"));
    // the server wrote this ping `late` ms before the network handed it over, and the first line has not landed
    await c.at(400, () => frame({ kind: "ping", now: T0 + 400 - late }));
    await c.at(800, () => c.send("s2", "둘째 줄"));
    expect(bodies.get("s2")!.actedAt).toBeGreaterThanOrEqual(bodies.get("s1")!.actedAt!);
    await c.at(900, () => c.land(mine("s1", "첫 줄", 900)));
    await c.at(910, () => answer("s1", { steered: true, threadId: "t1", message: c.landed.at(-1) }));
    await c.at(950, () => c.land(mine("s2", "둘째 줄", 950)));
    const final = await c.at(960, () => answer("s2", { steered: true, threadId: "t1", message: c.landed.at(-1) }));
    expect(final).toEqual(["H", "L1", "L2"]);

    await unmount?.();
    await mount("claude", true, [...earlier, ...c.landed], [], { now: T0 + 1000 });
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it("keeps a line above progress through a two-second server clock step back", async () => {
    const earlier = history(2);
    await mount("codex", true, earlier, [], { now: T0 });
    const c = chat(earlier);
    c.name("L1", "s1", "row-s1");
    c.name("P1", "p1");

    await act(async () => c.send("cancelled", "cancelled line"));
    await act(() => answer("cancelled", { ok: true, cancelled: true, threadId: "t1" }));
    const serverNow = T0 - 2_000;
    await frame({ kind: "ping", now: serverNow });
    expect(await c.at(0, () => c.send("s1", "my line"))).toEqual(["H", "L1"]);
    const actedAt = Math.min(bodies.get("s1")!.actedAt!, serverNow + 10);
    await c.at(50, () => c.land({ id: "p1", text: "progress", at: serverNow + 50 }));
    const final = await c.at(70, () => c.land({ id: "row-s1", sendId: "s1", text: "my line", role: "user", steered: true, actedAt, at: serverNow + 70, sendSeq: bodies.get("s1")?.sendSeq }));
    expect(final).toEqual(["H", "L1", "P1"]);

    await unmount?.();
    await mount("codex", true, [...earlier, ...c.landed], [], { now: serverNow + 100 });
    expect(c.order().filter((row) => row !== "thinking")).toEqual(final);
  });

  it.each([
    ["steered", "codex", true],
    ["held", "acp", false],
  ])("draws a %s line stored before send order where it was stored", async (_, driverKind, steered) => {
    const at = (offset: number) => T0 - 600_000 + offset;
    // written before lines carried a send order: a sent time on every line, no waited mark
    const stored = [
      { id: "u0", sendId: "s0", role: "user", text: "first ask", at: at(0), actedAt: at(0) },
      { id: "b0", role: "bot", text: "working on first", at: at(3000) },
      { id: "b1", role: "bot", text: "reply to first", at: at(5000) },
      { id: "u1", sendId: "s1", role: "user", text: "typed while busy", at: at(6000), actedAt: at(1000), ...(steered ? { steered } : {}) },
      { id: "b2", role: "bot", text: "reply to typed", at: at(8000) },
    ].map((row, i, rows) => ({ kind: "text", parentId: i ? rows[i - 1]!.id : null, ...row }) as Message);
    live.current = { streaming: {}, reasoning: {}, signal: {}, gen: {}, turn: {} };
    await mount(driverKind, steered, stored, [], {}, false, { busy: false, activity: undefined });
    const c = chat(stored);
    for (const row of stored) c.name(row.text!, row.id);
    expect(c.order().filter((row) => row !== "thinking")).toEqual(stored.map((row) => row.text));
  });

  it("draws a chat's first reply once when a line sent before it lands draws above it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored: Message[] = [
      { id: "root", parentId: null, role: "bot", kind: "text", text: "bot speaks first", at: T0 + 2000 },
      { id: "u1", parentId: "root", sendId: "s1", sendSeq: 1, role: "user", kind: "text", text: "early line", steered: true, actedAt: T0 + 1000, at: T0 + 3000 },
      { id: "r2", parentId: "u1", role: "bot", kind: "text", text: "answer to early", at: T0 + 4000 },
    ];
    await mount("codex", true, stored);
    const c = chat(stored);
    c.name("first", "root");
    c.name("early", "u1");
    c.name("answer", "r2");
    for (let i = 0; i < 3; i++) {
      c.name(`later ${i}`, `l${i}`);
      await c.land({ id: `l${i}`, text: `later row ${i}`, at: T0 + 5000 + i * 1000 });
    }
    expect(c.order().filter((row) => row !== "thinking")).toEqual(["early", "first", "answer", "later 0", "later 1", "later 2"]);
    expect(host.textContent?.split("bot speaks first").length).toBe(2);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
  });

  it("still shows Sends next for a line queued with Ctrl+Enter", async () => {
    await mount("claude", true, history(2));
    await act(async () => store.dispatch({ type: "send", botId: "b1", text: "다음에", sendId: "s1", after: true }));
    expect(host.querySelector('[data-mid="s1"]')?.textContent).toContain("Sends next");
    await act(() => answer("s1", { queued: true, threadId: "t1", queueId: "q1" }));
    expect(host.querySelector('[data-mid="q1"]')?.textContent).toContain("Sends next");
  });

  it("renders two first replies with distinct keys", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const stored: Message[] = [
      { id: "r1", parentId: null, role: "bot", kind: "text", text: "first reply", at: T0 },
      { id: "r2", parentId: null, role: "bot", kind: "text", text: "second reply", at: T0 + 1 },
    ];
    await mount("codex", true, stored, [], {}, true);
    expect(host.querySelectorAll('[data-mid="r1"], [data-mid="r2"]')).toHaveLength(2);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
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
