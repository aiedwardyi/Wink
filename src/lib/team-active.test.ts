// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { startTeamActive, TEAM_ACTIVE_PATH, TEAM_ACTIVE_SLOT_MS } from "./team-active";

const fetchMock = vi.fn();
let stop = () => {};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-12T00:00:00Z") });
  fetchMock.mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  stop();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("pings once per slot on keys and taps, with no body and no timer while idle", async () => {
  stop = startTeamActive();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(3 * TEAM_ACTIVE_SLOT_MS);
  expect(fetchMock).not.toHaveBeenCalled();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
  window.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(TEAM_ACTIVE_SLOT_MS - 1);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  window.dispatchEvent(new Event("pointerdown"));
  const ping = [TEAM_ACTIVE_PATH, { method: "POST", headers: { "content-type": "application/json" } }];
  expect(fetchMock.mock.calls).toEqual([ping, ping]);
  expect(vi.getTimerCount()).toBe(0);
});
