// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisibleClock } from "./use-visible-clock";

function Probe({ seconds, seen }: { seconds: boolean; seen: number[] }) {
  seen.push(useVisibleClock(seconds));
  return null;
}

describe("useVisibleClock", () => {
  afterEach(() => vi.useRealTimers());

  it("ticks by the second only while a caller asks, back to minutes and no timer once all unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 4, 15, 0, 0, 0));
    const minute: number[] = [];
    const second: number[] = [];
    const hosts = [document.createElement("div"), document.createElement("div")];
    const [minuteRoot, secondRoot] = hosts.map((host) => createRoot(host));
    await act(async () => minuteRoot!.render(createElement(Probe, { seconds: false, seen: minute })));
    await act(async () => secondRoot!.render(createElement(Probe, { seconds: true, seen: second })));
    const before = second.length;
    for (let i = 0; i < 3; i += 1) await act(async () => { vi.advanceTimersByTime(1000); });
    expect(second.length - before).toBe(3);

    await act(async () => secondRoot!.unmount());
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout");
    const shown = minute.length;
    // 15:00:03 now: the next tick is the minute at 15:01:00, then every minute.
    await act(async () => { vi.advanceTimersByTime(56_999); });
    expect(minute.length).toBe(shown);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(minute.length).toBe(shown + 1);
    for (const [, ms] of spy.mock.calls) delays.push(ms ?? 0);
    expect(delays).toEqual([60_000]);
    spy.mockRestore();

    await act(async () => minuteRoot!.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
