// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Action, useStore } from "@/state/store";

const store = vi.hoisted(() => ({ dispatch: null as ReturnType<typeof useStore>["dispatch"] | null, actions: [] as Action[] }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  const { useMemo } = await import("react");
  return { ...actual, useStore: () => {
    const value = actual.useStore();
    const dispatch = useMemo(() => (action: Action) => {
      store.actions.push(action);
      value.dispatch(action);
    }, [value.dispatch]);
    store.dispatch = dispatch;
    return { ...value, dispatch };
  } };
});

import App from "./App";

describe("desktop notification routing", () => {
  it.each(["bot", "room"])("selects a %s and switches its task once per click", async (kind) => {
    localStorage.setItem("omb-onboarding-done", "true");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    type Target = { botId: string; threadId: string };
    const listeners = new Set<(target: Target) => void>();
    window.ogb = { onNotificationClick: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    } } as NonNullable<Window["ogb"]>;
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      await act(async () => store.dispatch!({
        type: "hydrate",
        bots: [{ id: "b1", name: "Scout", title: "", description: "", notifications: true, color: "blue", unread: false, threadId: "t-current", modelSelection: { instanceId: "inst", model: "m" }, messages: [], tasks: [{ threadId: "t-background", title: "Background", createdAt: 1 }] }],
        groups: [{ id: "g1", name: "Crew", threadId: "g-current", memberIds: ["b1"], bulletin: "", defaultResponder: { kind: "mentions" }, createdAt: 1, unread: false, messages: [], tasks: [{ threadId: "g-background", title: "Background", createdAt: 1 }] }],
        computerControl: {},
        sidebarOrder: { sectionOrder: [], itemOrder: {} },
      }));
      store.actions.length = 0;
      vi.mocked(fetch).mockClear();
      focus.mockClear();
      const target = { botId: "b1", threadId: kind === "bot" ? "t-background" : "g-background" };
      await act(async () => { for (const listener of listeners) listener(target); });
      const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts.map(([path]) => path)).toEqual([kind === "bot" ? "/api/bots/b1/tasks/t-background" : "/api/groups/g1/tasks/g-background"]);
      expect(store.actions.filter((action) => action.type === "select")).toEqual([{ type: "select", id: kind === "bot" ? "b1" : "g1" }]);
      expect(listeners.size).toBe(1);
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      expect(listeners.size).toBe(0);
      host.remove();
      delete window.ogb;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
      store.dispatch = null;
      store.actions.length = 0;
    }
  });
});
