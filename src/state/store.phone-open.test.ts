// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconnectingCue } from "@/components/ReconnectingCue";
import { applyLocale } from "@/lib/i18n";
import { SNAPSHOT_CACHE_KEY } from "./snapshot-cache";
import { StoreProvider, useStore, useStreaming, type Bot, type Message } from "./store";

class FakeEventSource {
  static last: FakeEventSource;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() { FakeEventSource.last = this; }
}

const message = (id: string): Message => ({ id, at: Number(id.slice(1)), role: "user", kind: "text", text: id });
const bot = (id = "b1", messages = [message("m1")]): Bot => ({ id, threadId: `t${id}`, name: "Scout", color: "blue", unread: false, messages }) as Bot;
let store: ReturnType<typeof useStore>;
let stream: ReturnType<typeof useStreaming>;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let requests: Array<(response: Response) => void>;
let fetchMock: ReturnType<typeof vi.fn>;

async function mount(cached = false) {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  window.location.href = "https://phone.example/";
  if (cached) localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ bots: [bot()], groups: [], selectedId: "b1" }));
  requests = [];
  fetchMock = vi.fn((url: string) => url.startsWith("/api/bots?")
    ? new Promise<Response>((resolve) => requests.push(resolve))
    : Promise.resolve(Response.json({ instances: [], routines: [], runs: [] })));
  vi.stubGlobal("fetch", fetchMock);
  function Probe() { store = useStore(); stream = useStreaming(); return createElement(ReconnectingCue); }
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
}

const botsCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/bots?"));
const emit = (frame: object, cursor = "") => act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify(frame), lastEventId: cursor }));
const hello = (cursor = "s:1") => emit({ kind: "hello", resumed: false, cursor });
const finish = (index: number, cursor: string, messages = [message("m1")]) => act(async () => requests[index]!(Response.json({ bots: [bot("b1", messages), bot("b2")], groups: [], cursor })));

afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove();
  localStorage.clear(); applyLocale("en");
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("phone cold open", () => {
  it.each(["text", "activity"] as const)("resets covered %s streams without clearing later deltas or replaying transcript state", async (kind) => {
    await mount(true);
    await hello();
    await emit({ kind: "runtime", seq: 2, event: { type: "content.delta", threadId: "tb1", streamKind: kind === "text" ? "assistant_text" : "reasoning_text", delta: "Old" } }, "s:2");
    const settled: Message = { ...message("m3"), role: "bot", kind, text: "Fresh snapshot" };
    await emit({ kind: "message", seq: 3, threadId: "tb1", message: { ...settled, text: "Older frame" } }, "s:3");
    await emit({ kind: "runtime", seq: 4, event: { type: "content.delta", threadId: "tb1", streamKind: "assistant_text", delta: "New" } }, "s:4");
    await finish(0, "s:4", [message("m1"), settled]);
    expect(stream.streaming.tb1).toBe("New");
    expect(stream.reasoning.tb1).toBeUndefined();
    expect(store.state.bots[0]!.messages.at(-1)?.text).toBe("Fresh snapshot");
  });

  it("cancels a covered deletion's profile write before its late response can restore the bot", async () => {
    await mount(true);
    await hello();
    const original = fetchMock.getMockImplementation()! as (url: string, init?: RequestInit) => Promise<Response>;
    let reply!: (response: Response) => void;
    let signal!: AbortSignal;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/bots/b1" && init?.method === "PATCH"
      ? new Promise<Response>((resolve) => { reply = resolve; signal = init.signal as AbortSignal; })
      : original(url, init));
    await act(async () => store.dispatch({ type: "updateBot", botId: "b1", patch: { name: "Edited" } }));
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await emit({ kind: "bot.deleted", seq: 2, botId: "b1" }, "s:2");
    await act(async () => requests[0]!(Response.json({ bots: [bot("b2")], groups: [], cursor: "s:2" })));
    expect(store.state.bots.map((row) => row.id)).toEqual(["b2"]);
    await act(async () => reply(Response.json({ bot: { ...bot(), name: "Edited" } })));
    expect(store.state.bots.map((row) => row.id)).toEqual(["b2"]);
    expect(signal.aborted).toBe(true);
  });

  it.each([ ["en", "Reconnecting"], ["ko", "다시 연결 중"] ] as const)("keeps the disconnected cue after HTTP-only hydration in %s", async (locale, reconnecting) => {
    applyLocale(locale);
    await mount(true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await finish(0, "s:1");
    expect(store.state.hydrated).toBe(true);
    expect(store.state.connected).toBe(false);
    expect(host.textContent).toBe(reconnecting);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(host.textContent).toBe(reconnecting);
    await act(async () => FakeEventSource.last.onopen?.());
    expect(host.textContent).toBe("");
  });

  it("starts one remote snapshot before the stream opens", async () => {
    await mount();
    expect(botsCalls()).toHaveLength(1);
    expect(botsCalls()[0]![0]).toBe("/api/bots?messages=200");
    await act(async () => FakeEventSource.last.onopen?.());
    expect(botsCalls()).toHaveLength(1);
  });

  it("refetches an old snapshot and applies buffered messages once in order", async () => {
    await mount(true);
    await hello("s:5");
    await emit({ kind: "message", seq: 6, threadId: "tb1", message: message("m6") }, "s:6");
    await finish(0, "s:4");
    expect(store.state.hydrated).toBe(false);
    expect(botsCalls()).toHaveLength(2);
    await emit({ kind: "message", seq: 7, threadId: "tb1", message: message("m7") }, "s:7");
    await finish(1, "s:6", [message("m1"), message("m6")]);
    expect(store.state.bots[0]!.messages.map((row) => row.id)).toEqual(["m1", "m6", "m7"]);
  });

  it("reuses the in-flight fallback when hello validates its response", async () => {
    await mount(true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await hello("s:5");
    await emit({ kind: "message", threadId: "tb1", message: message("m6") }, "s:6");
    await finish(0, "s:5");
    expect(botsCalls()).toHaveLength(1);
    expect(store.state.hydrated).toBe(true);
    expect(store.state.bots[0]!.messages.map((row) => row.id)).toEqual(["m1", "m6"]);
  });

  it("keeps a snapshot's newer bot over a frame already covered by its cursor", async () => {
    await mount(true);
    await hello("s:1");
    await emit({ kind: "bot", seq: 2, bot: { ...bot(), name: "Older frame" } }, "s:2");
    await finish(0, "s:3");
    expect(store.state.bots[0]!.name).toBe("Scout");
  });

  it("saves hydration and the latest selection without hiding the page", async () => {
    await mount();
    await hello(); await finish(0, "s:1");
    expect(localStorage.getItem(SNAPSHOT_CACHE_KEY)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY)!).bots).toHaveLength(2);
    await act(async () => store.dispatch({ type: "select", id: "b2" }));
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY)!).selectedId).toBe("b2");
  });

  it("keeps the cache redacted and capped when hydration schedules a save", async () => {
    await mount();
    await hello();
    const key = "sk-proj-abcdefghijklmnop1234567890";
    const messages = Array.from({ length: 70 }, (_, i) => ({ ...message(`m${i}`), text: key }));
    await finish(0, "s:1", messages);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    const raw = localStorage.getItem(SNAPSHOT_CACHE_KEY)!;
    expect(raw).not.toContain(key);
    expect(JSON.parse(raw).bots[0].messages).toHaveLength(50);
  });

  it("silently tolerates a blocked cache write after hydration", async () => {
    await mount();
    await hello(); await finish(0, "s:1");
    const storage = localStorage;
    const write = vi.fn(() => { throw new Error("quota"); });
    vi.stubGlobal("localStorage", { setItem: write, clear: () => storage.clear(), getItem: (key: string) => storage.getItem(key) });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(store.state.hydrated).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(storage.getItem(SNAPSHOT_CACHE_KEY)).toBeNull();
  });

  it.each([ ["en", "Updating"], ["ko", "업데이트 중"] ] as const)("uses a muted first-refresh cue in %s and keeps the real-drop cue", async (locale, updating) => {
    applyLocale(locale);
    await mount(true);
    await act(async () => vi.advanceTimersByTimeAsync(2100));
    expect(host.textContent).toBe(updating);
    expect(host.querySelector("svg")).toBeNull();
    await act(async () => FakeEventSource.last.onopen?.());
    await hello(); await finish(0, "s:1");
    expect(host.textContent).toBe("");
    await act(async () => FakeEventSource.last.onerror?.());
    await act(async () => vi.advanceTimersByTimeAsync(2100));
    expect(host.textContent).toBe(locale === "en" ? "Reconnecting" : "다시 연결 중");
  });

  it.each([ ["en", "Updating", "Reconnecting"], ["ko", "업데이트 중", "다시 연결 중"] ] as const)("shows the unreachable-PC cue after ten seconds in %s", async (locale, updating, reconnecting) => {
    applyLocale(locale);
    await mount(true);
    await act(async () => vi.advanceTimersByTimeAsync(9999));
    expect(host.textContent).toBe(updating);
    expect(host.querySelector("svg")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(host.textContent).toBe(reconnecting);
    expect(host.querySelector("svg")).not.toBeNull();
  });

  it.each(["bot", "group"])("sends the selected %s read receipt for covered frames without applying their older state", async (kind) => {
    await mount(true);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const reply: Message = { ...message("m2"), role: "bot" };
    const record = { ...bot(), name: "Fresh snapshot", unread: true, messages: [message("m1"), reply] };
    await hello();
    await emit({ kind: "message", seq: 2, threadId: record.threadId, message: reply }, "s:2");
    await emit({ kind, seq: 3, [kind]: { ...record, name: "Older frame" } }, "s:3");
    await act(async () => requests[0]!(Response.json({ bots: kind === "bot" ? [record] : [], groups: kind === "group" ? [record] : [], cursor: "s:3" })));
    const patch = fetchMock.mock.calls.find(([url, init]) => url === `/api/${kind === "bot" ? "bots" : "groups"}/b1` && init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(patch![1].body)).toEqual({ unread: false, readAt: 2 });
    expect((kind === "bot" ? store.state.bots : store.state.groups)[0]!.name).toBe("Fresh snapshot");
  });

  it("applies a covered queue cancellation receipt after hydration", async () => {
    await mount(true);
    await hello();
    await act(async () => store.dispatch({ type: "pendingQueued", threadId: "tb1", queueId: "q1", text: "queued" }));
    await emit({ kind: "queue.cancelled", seq: 2, botId: "b1", sends: [{ threadId: "tb1", queueId: "q1" }] }, "s:2");
    await finish(0, "s:2");
    expect(store.state.pendingQueued.tb1).toBeUndefined();
  });

  it("settles a covered task resume acknowledgement after hydration", async () => {
    await mount(true);
    await hello();
    fetchMock.mockImplementation((url: string) => url.endsWith("/resume")
      ? Promise.resolve(Response.json({ pending: true }))
      : Promise.resolve(Response.json({})));
    const settled = vi.fn();
    await act(async () => store.dispatch({ type: "resumeTask", botId: "b1", threadId: "tb1", onSettled: settled }));
    expect(settled).toHaveBeenCalledWith(null, true);
    settled.mockClear();
    await emit({ kind: "task.resume", seq: 2, botId: "b1", threadId: "tb1" }, "s:2");
    await finish(0, "s:2");
    expect(settled).toHaveBeenCalledExactlyOnceWith(null, false);
  });
});
