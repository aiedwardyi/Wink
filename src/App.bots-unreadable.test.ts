// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { useStore } from "@/state/store";

const store = vi.hoisted(() => ({ dispatch: null as ReturnType<typeof useStore>["dispatch"] | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => {
    const value = actual.useStore();
    store.dispatch = value.dispatch;
    return value;
  } };
});

import App from "./App";

describe("An empty bot list", () => {
  it.each([
    { botsUnreadable: false, sheet: true },
    { botsUnreadable: true, sheet: false },
  ])("requires a first bot only when the list was read: unreadable $botsUnreadable", async ({ botsUnreadable, sheet }) => {
    localStorage.setItem("omb-onboarding-done", "true");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      await act(async () => {
        store.dispatch!({ type: "instances", instances: [{
          instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
          snapshot: { state: "available" }, models: { default: "default", options: [] },
        }] });
        store.dispatch!({ type: "connected", value: true });
        store.dispatch!({ type: "hydrate", bots: [], groups: [], botsUnreadable, computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } });
      });
      if (sheet) await vi.waitFor(() => expect(host.textContent).toContain("Name your bot"));
      else {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
        expect(host.textContent).not.toContain("Name your bot");
      }
      const notice = host.querySelector('main[role="alert"]')?.textContent;
      expect(notice).toBe(sheet ? undefined : "Wink could not read your bot listNothing was deleted. Restart Wink to load your bots.");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
      store.dispatch = null;
    }
  });
});
