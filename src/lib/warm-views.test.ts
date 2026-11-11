// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { warmAllowed, warmViews } from "./warm-views";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  [{ type: "ethernet" }, false, true],
  [undefined, false, true],
  [{ saveData: true }, false, false],
  [{ type: "wifi" }, true, true],
  [{ type: "unknown" }, true, true],
  [{}, true, true],
  [{ type: "cellular" }, true, false],
  [{ type: "wifi", saveData: true }, true, false],
] as const)("warm allowed on %o, phone %s: %s", (connection, phone, allowed) => {
  expect(warmAllowed(connection, phone)).toBe(allowed);
});

it("warms each screen in its own idle slot in a window without the desktop bridge", async () => {
  expect((window as { ogb?: unknown }).ogb).toBeUndefined();
  const slots: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (run: () => void) => slots.push(run));
  const loads = [vi.fn(async () => {}), vi.fn(async () => { throw new Error("chunk"); }), vi.fn(async () => {})];
  warmViews(loads, []);
  for (const [index, load] of loads.entries()) {
    expect(slots).toHaveLength(index + 1);
    slots[index]!();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(slots.length).toBe(Math.min(index + 2, loads.length)));
  }
  expect(loads.every((load) => load.mock.calls.length === 1)).toBe(true);
});

it("stops before the next slot once cancelled", () => {
  const slots: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (run: () => void) => slots.push(run));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const load = vi.fn(async () => {});
  warmViews([load], [])();
  expect(cancelIdleCallback).toHaveBeenCalledWith(1);
  expect(load).not.toHaveBeenCalled();
});

it("skips the warm-up when Save-Data is on", () => {
  vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
  const idle = vi.fn();
  vi.stubGlobal("requestIdleCallback", idle);
  const load = vi.fn(async () => {});
  warmViews([load], []);
  expect(idle).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

it("falls back to a timer without requestIdleCallback, and cancels it", () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  const first = vi.fn(async () => {});
  warmViews([first], []);
  vi.advanceTimersByTime(1);
  expect(first).toHaveBeenCalledTimes(1);
  const second = vi.fn(async () => {});
  warmViews([second], [])();
  vi.advanceTimersByTime(1);
  expect(second).not.toHaveBeenCalled();
});
