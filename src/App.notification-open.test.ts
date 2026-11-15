// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Action, useStore } from "@/state/store";

const store = vi.hoisted(() => ({ dispatch: null as ReturnType<typeof useStore>["dispatch"] | null, state: null as ReturnType<typeof useStore>["state"] | null, actions: [] as Action[] }));
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
    store.state = value.state;
    return { ...value, dispatch };
  } };
});

import App from "./App";
import { closeShow, showItem } from "@/lib/show-pane";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

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
      expect(store.actions.filter((action) => action.type === "select")).toEqual([{ type: "select", id: kind === "bot" ? "b1" : "g1", reveal: true }]);
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

describe("a tapped phone notification", () => {
  it.each(["menu", "bot details", "pane", "settings", "new bot", "new group"])("lands on its chat with the %s open over it", async (cover) => {
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
      bots: ["b1", "b2"].map((id, at) => ({ id, threadId: `t${at + 1}`, name: id, messages: [], modelSelection: { instanceId: "inst", model: "m" } })),
      groups: [],
      selectedId: "b1",
    }));
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") || query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const worker = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
    const menu = () => document.querySelector("[data-phone-menu]")!.getAttribute("aria-expanded");
    const covers = () => ({
      menu: menu() === "true",
      details: Boolean(document.querySelector("[data-settings-panel]:not([data-closing])")),
      pane: Boolean(document.querySelector("aside.show-pane:not([data-closing])")),
      settings: store.state!.appSettingsOpen,
      newBot: store.state!.createBotOpen,
      newGroup: Boolean(document.querySelector("[role=dialog][aria-labelledby=group-wizard-title]")),
    });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      await act(async () => {
        if (cover === "menu") document.querySelector<HTMLElement>("[data-phone-menu]")!.click();
        else if (cover === "bot details") store.dispatch!({ type: "toggleSettings", open: true });
        else if (cover === "pane") showItem({ threadId: "t1", path: "C:\w\a.png", kind: "image" });
        else if (cover === "settings") store.dispatch!({ type: "toggleAppSettings", open: true });
        else if (cover === "new bot") store.dispatch!({ type: "newBot" });
      });
      if (cover === "new group") {
        await act(async () => document.querySelector<HTMLElement>('button[aria-label="New or share"]')!.click());
        await act(async () => [...document.querySelectorAll<HTMLElement>("button")].find((each) => each.textContent === "New group")!.click());
        expect(covers().newGroup).toBe(true);
      }
      await vi.waitFor(() => expect(Object.values(covers())).toContain(true));
      await act(async () => worker.dispatchEvent(new MessageEvent("message", { data: { type: "orbit-open", url: "/?bot=b1&thread=t1" } })));
      await vi.waitFor(() => expect(covers()).toEqual({ menu: false, details: false, pane: false, settings: false, newBot: false, newGroup: false }));
      expect(store.state!.selectedId).toBe("b1");
    } finally {
      await act(async () => root.unmount());
      closeShow();
      host.remove();
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
      store.dispatch = null;
      store.state = null;
      store.actions.length = 0;
    }
  });
});
