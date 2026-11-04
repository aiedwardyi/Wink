// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconnectingCue } from "@/components/ReconnectingCue";
import { applyLocale } from "@/lib/i18n";
import { SNAPSHOT_CACHE_KEY } from "./snapshot-cache";
import { StoreProvider, useStore, type Bot, type Message } from "./store";

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
  function Probe() { store = useStore(); return createElement(ReconnectingCue); }
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
});

