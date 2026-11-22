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
  const roster = async (path: string) => {
    const id = new URL(path, "http://localhost").searchParams.get("sessionId");
    if (hold.id && id === hold.id) {
      hold.requested = true;
      await hold.gate;
    }
    return new Response(JSON.stringify({ sessionId: id ?? "main", generation: 1, screenText: "ready", panes }));
  };
  const fetched = vi.fn((input: string, _init?: RequestInit) => String(input).includes("/terminal") ? roster(String(input)) : new Promise<Response>(() => {}));
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
    hold: (id: string) => {
      hold.id = id;
      hold.gate = new Promise<void>((done) => { hold.release = done; });
      return hold;
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
      localStorage.clear();
    },
  };
};

it("starts a terminal open's timing at the tap, so the lazy chunk's download is inside it", async () => {
  const f = await mount();
  try {
    await f.openWorker(2);
    await new Promise((done) => setTimeout(done, 300));
    expect(f.records()).toEqual([]);
    chunk.release();
    await vi.waitFor(() => expect(f.records()).toHaveLength(1));
    const { tap, fetchStart, paint } = f.records()[0].terminal!;
    expect(fetchStart! - tap).toBeGreaterThanOrEqual(250);
    expect(paint).toBeGreaterThanOrEqual(fetchStart!);
  } finally { await f.unmount(); }
});

it("finishes a worker open only when that worker's read is shown, not the first pane's", async () => {
  chunk.release();
  const f = await mount();
  try {
    const held = f.hold(PANES[1]);
    await f.openWorker(2);
    await vi.waitFor(() => expect(held.requested).toBe(true));
    await new Promise((done) => setTimeout(done, 300));
    expect(f.records()).toEqual([]);
    held.release();
    await vi.waitFor(() => expect(f.records()).toHaveLength(1));
    const { tap, fetchStart, paint } = f.records()[0].terminal!;
    expect(fetchStart! - tap).toBeGreaterThanOrEqual(0);
    expect(paint! - fetchStart!).toBeGreaterThanOrEqual(250);
  } finally { await f.unmount(); }
});
