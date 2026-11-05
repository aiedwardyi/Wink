// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StoreProvider, useEngineLoginRefresh, useStore, type InstanceInfo } from "./store";

class FakeEventSource {
  static last: FakeEventSource;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  constructor() { FakeEventSource.last = this; }
  close() {}
}
let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof useStore>;
const polled = vi.fn();
const instance = (main: boolean): InstanceInfo => ({ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", accountMain: main,
  snapshot: { state: "available", authenticated: true }, models: { default: "model", options: [] } });
async function mount(waiting = false) {
  function Capture() {
    store = useStore();
    useEngineLoginRefresh(waiting, polled);
    return null;
  }
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Capture))));
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "stream00:1" }), lastEventId: "" }));
  expect(store.state.hydrated, "live frames are applied after hydration").toBe(true);
}
async function live() {
  await act(async () => FakeEventSource.last.onmessage!({ data: JSON.stringify({ kind: "instances", instances: [instance(false)] }), lastEventId: "" }));
  expect(store.state.instances[0]?.accountMain, "the live Main landed before the old reply").toBe(false);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(window.location, "protocol", "get").mockReturnValue("http:");
  vi.spyOn(window.location, "hostname", "get").mockReturnValue("127.0.0.1");
  polled.mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("ignores an older instances reply after a newer live frame", async () => {
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn((url: string) => url === "/api/bots?messages=200" ? Promise.resolve(Response.json({ bots: [], groups: [], cursor: "stream00:1" }))
    : ["/api/config", "/api/routines"].includes(url) ? Promise.resolve(Response.json({}))
    : url === "/api/instances?refresh=1" ? new Promise<Response>((resolve) => { finish = resolve; }) : new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  await mount();
  let request!: Promise<void>;
  await act(async () => { request = store.refreshInstances("passive"); });
  await live();
  await act(async () => { finish(Response.json({ instances: [instance(true)] })); await request; });
  expect(store.state.instances[0]?.accountMain, "newer Main survives the reload").toBe(false);
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/instances?refresh=1")).toHaveLength(1);
});

it("ignores an older sign-in poll reply after a newer live frame", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("requestIdleCallback", () => 1);
  vi.stubGlobal("cancelIdleCallback", () => {});
  const fetchMock = vi.fn((url: string) => url === "/api/bots?messages=200" ? Promise.resolve(Response.json({ bots: [], groups: [], cursor: "stream00:1" }))
    : ["/api/config", "/api/routines"].includes(url) ? Promise.resolve(Response.json({}))
    : url === "/api/instances" ? new Promise<Response>((resolve) => { finish = resolve; }) : new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  await mount(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await live();
  await act(async () => finish(Response.json({ instances: [instance(true)] })));
  expect(store.state.instances[0]?.accountMain, "newer Main survives the sign-in poll").toBe(false);
  expect(polled, "a stale sign-in callback is discarded too").not.toHaveBeenCalled();
  const reads = () => fetchMock.mock.calls.filter(([url]) => url === "/api/instances").length;
  expect(reads()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(reads(), "the poll goes on while sign-in waits").toBe(2);
  await act(async () => finish(Response.json({ instances: [instance(false)] })));
  expect(polled, "the next current reply reaches the sign-in callback").toHaveBeenCalledOnce();
});
