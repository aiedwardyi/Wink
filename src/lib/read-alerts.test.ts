import { afterEach, describe, expect, it, vi } from "vitest";

import { closeReadAlerts } from "./read-alerts";

afterEach(() => vi.unstubAllGlobals());

function installAlerts(alerts: Array<{ chat?: string; at?: number }>) {
  const shown = alerts.map((data) => ({ data, close: vi.fn() }));
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => ({ getNotifications: async () => shown }) } });
  return shown;
}

describe("closeReadAlerts", () => {
  it("closes alerts that arrived before their chat was read", async () => {
    const shown = installAlerts([{ chat: "b1", at: 5 }, { chat: "b1", at: 20 }, { chat: "b2", at: 5 }, { chat: "g1", at: 5 }, { chat: "g1" }, {}]);
    await closeReadAlerts(() => [
      { id: "b1", readAt: 10 },
      { id: "b2", unread: true, readAt: 10 },
      { id: "g1", readAt: 10 },
    ]);
    expect(shown.map((alert) => alert.close.mock.calls.length)).toEqual([1, 0, 0, 1, 1, 0]);
  });

  it("skips the read state when no alert is shown", async () => {
    installAlerts([]);
    const chats = vi.fn(async () => []);
    await closeReadAlerts(chats);
    expect(chats).not.toHaveBeenCalled();
  });
});
