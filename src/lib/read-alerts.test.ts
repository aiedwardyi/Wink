import { afterEach, describe, expect, it, vi } from "vitest";

import { closeReadAlerts } from "./read-alerts";

afterEach(() => vi.unstubAllGlobals());

describe("closeReadAlerts", () => {
  it("closes the alerts of chats that just went read", async () => {
    const alerts = ["b1", "b2", "g1", undefined].map((chat) => ({ data: chat ? { chat } : { url: "/" }, close: vi.fn() }));
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ getNotifications: async () => alerts }) } });
    await closeReadAlerts(new Set(["b1", "b2", "g1"]), new Set(["b2"]));
    expect(alerts.map((alert) => alert.close.mock.calls.length)).toEqual([1, 0, 1, 0]);
  });

  it("skips the worker when nothing went read", async () => {
    const getRegistration = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    await closeReadAlerts(new Set(["b1"]), new Set(["b1", "b2"]));
    expect(getRegistration).not.toHaveBeenCalled();
  });
});
