// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import App from "./App";
import { COLD_OPEN_PATH, startColdOpenTiming } from "@/lib/cold-open-timing";
import { lastViewedPanes } from "@/lib/terminal-panes";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

const chunk = vi.hoisted(() => {
  let release!: () => void;
  return { gate: new Promise<void>((done) => { release = done; }), release: () => release() };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Holds the lazy terminal chunk back the way a slow phone download does.
vi.mock("@/components/RemoteTerminalView", async (importActual) => {
  await chunk.gate;
  return importActual();
});

const PANES = ["aaaaaaaa-pane", "bbbbbbbb-pane"];

/** A phone page on the web: no desktop terminal bridge, so the remote terminal view opens. */
const mount = async () => {
  const panes = PANES.map((sessionId, index) => ({ sessionId, label: `WORK-${index + 1}`, main: false, changedAt: 41_000 }));
  const messages = panes.map((pane, index) => ({ id: `l${index}`, at: (index + 1) * 1_000, role: "bot", kind: "launch", text: `Launched ${pane.label}\nLabel: ${pane.label}\nSession: ${pane.sessionId}` }));
  localStorage.setItem("omb-onboarding-done", "true");
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: [{ id: "b1", threadId: "t1", name: "Scout", messages, modelSelection: { instanceId: "inst", model: "m" } }],
    groups: [], selectedId: "b1",
  }));
  const hold = { id: "", requested: false, release: () => {}, gate: Promise.resolve() };
  const first = { reads: 0, requested: false, release: () => {}, gate: Promise.resolve() };
  const roster = async (path: string) => {
    const id = new URL(path, "http://localhost").searchParams.get("sessionId");
    // The default-pane reads: the shortcut's own lookup comes first, then the opened view's first read.
    if (path.endsWith("/api/bots/b1/terminal") && ++first.reads === 2) {
      first.requested = true;
      await first.gate;
    }
    if (hold.id && id === hold.id) {
      hold.requested = true;
      await hold.gate;
    }
    return new Response(JSON.stringify({ sessionId: id ?? "main", generation: 1, screenText: "ready", panes }));
  };
  const fetched = vi.fn((input: string, _init?: RequestInit) => String(input).includes("/terminal") && !String(input).includes("pane-counts") ? roster(String(input)) : new Promise<Response>(() => {}));
  vi.useFakeTimers({ toFake: ["performance"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("max-width"), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true),
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", fetched);
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  startColdOpenTiming();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  return {
    /** Holds back the opened view's first default-pane read, then the read of `id`; each runs on once released. */
    hold: (id: string) => {
      first.gate = new Promise<void>((done) => { first.release = done; });
      hold.id = id;
      hold.gate = new Promise<void>((done) => { hold.release = done; });
      return { first, hold };
    },
    openWorker: (n: number) => act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: `Digit${n}`, altKey: true, bubbles: true, cancelable: true }));
    }),
    records: () => fetched.mock.calls
      .filter(([url]) => url === COLD_OPEN_PATH)
      .map(([, init]) => JSON.parse(String(init?.body)) as { label: string; terminal?: { tap: number; fetchStart?: number; paint?: number } })
      .filter((record) => record.label === "terminal"),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
      lastViewedPanes.clear();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      localStorage.clear();
    },
  };
};

it("starts a terminal open's timing at the tap, so the lazy chunk's download is inside it", async () => {
  const f = await mount();
  try {
    await f.openWorker(2);
    vi.advanceTimersByTime(300);
    chunk.release();
    await vi.waitFor(() => expect(f.records()).toHaveLength(1));
    const { tap, fetchStart, paint } = f.records()[0].terminal!;
    expect(fetchStart! - tap).toBeGreaterThanOrEqual(300);
    expect(paint).toBeGreaterThanOrEqual(fetchStart!);
  } finally { await f.unmount(); }
});

it("finishes a worker open when that worker's read is shown, not when the first pane's is", async () => {
  chunk.release();
  const f = await mount();
  try {
    const { first, hold } = f.hold(PANES[1]);
    await f.openWorker(2);
    await vi.waitFor(() => expect(first.requested).toBe(true));
    vi.advanceTimersByTime(300);
    first.release();
    await vi.waitFor(() => expect(hold.requested).toBe(true));
    vi.advanceTimersByTime(300);
    hold.release();
    await vi.waitFor(() => expect(f.records()).toHaveLength(1));
    const { tap, fetchStart, paint } = f.records()[0].terminal!;
    expect(fetchStart! - tap).toBeGreaterThanOrEqual(300);
    expect(paint! - fetchStart!).toBeGreaterThanOrEqual(300);
  } finally { await f.unmount(); }
});
