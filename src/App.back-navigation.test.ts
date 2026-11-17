// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { useStore } from "@/state/store";

const store = vi.hoisted(() => ({ dispatch: null as ReturnType<typeof useStore>["dispatch"] | null, state: null as ReturnType<typeof useStore>["state"] | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => {
    const value = actual.useStore();
    store.dispatch = value.dispatch;
    store.state = value.state;
    return value;
  } };
});

import App from "./App";
import { FORUM_SELECTION } from "@/lib/board";
import { closeShow, showItem } from "@/lib/show-pane";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

describe("Back with no bots", () => {
  it.each(["create-bot", "popup"])("closes %s before leaving the page", async (layer) => {
    localStorage.setItem("omb-onboarding-done", "true");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const push = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    const close = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      await act(async () => {
        store.dispatch!({ type: "instances", instances: [{
          instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
          snapshot: { state: "unavailable" }, models: { default: "default", options: [] },
        }] });
        store.dispatch!({ type: "connected", value: true });
        store.dispatch!({ type: "hydrate", bots: [], groups: [], computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } });
      });
      await act(async () => {
        if (layer === "create-bot") store.dispatch!({ type: "newBot" });
        else window.dispatchEvent(new CustomEvent("orbit:back-layer", { detail: { key: "popup:test", close } }));
      });
      if (layer === "create-bot") {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        await vi.waitFor(() => expect(host.textContent).toContain("No engine is connected yet."));
      }
      expect(push).toHaveBeenLastCalledWith({ orbitBack: layer === "create-bot" ? "create-bot" : "popup:test", depth: 1 }, "");
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: null })));
      if (layer === "popup") expect(close).toHaveBeenCalledOnce();
      else {
        push.mockClear();
        await act(async () => store.dispatch!({ type: "newBot" }));
        expect(push).toHaveBeenCalledOnce();
      }
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

describe("Back with the pane open on a phone", () => {
  it("closes the sheet and stays on the chat", async () => {
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
      bots: ["b1", "b2"].map((id, at) => ({ id, threadId: `t${at + 1}`, name: id, messages: [], modelSelection: { instanceId: "inst", model: "m" } })),
      groups: [],
      selectedId: "b2",
    }));
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") || query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const entries: unknown[] = [];
    vi.spyOn(window.history, "pushState").mockImplementation((state) => { entries.push(state); });
    const back = () => act(async () => {
      entries.pop();
      window.dispatchEvent(new PopStateEvent("popstate", { state: entries.at(-1) ?? null }));
    });
    const sheet = () => document.querySelector("body > div > aside.show-pane:not([data-closing])");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      expect(entries).toEqual([{ orbitBack: "chat:b2", depth: 1 }]);
      await act(async () => showItem({ threadId: "t2", path: "C:\w\a.png", kind: "image" }));
      await vi.waitFor(() => expect(sheet()).toBeTruthy());
      await back();
      expect(store.state!.selectedId).toBe("b2");
      expect(sheet()).toBeNull();
      expect(entries).toEqual([{ orbitBack: "chat:b2", depth: 1 }]);
    } finally {
      await act(async () => root.unmount());
      closeShow();
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
      store.dispatch = null;
    }
  });
});

describe("Back inside a Forum post on a phone", () => {
  it("returns to the Forum list, then closes the Forum", async () => {
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
      bots: [{ id: "b1", threadId: "t1", name: "b1", messages: [], modelSelection: { instanceId: "inst", model: "m" } }],
      groups: [],
      selectedId: "b1",
    }));
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") || query.includes("reduce"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const posts = ["pold", "pnew"].map((id, at) => ({
      id, parent_id: null, author_bot_id: "b1", project_id: "wink", kind: "stuck", title: id, body: id, error_sig: "", status: "open",
      fix: "", source_ref: id, helped_bot_ids: [], created_at: at + 1, updated_at: at + 1, pc_id: "home",
    }));
    vi.stubGlobal("fetch", vi.fn((url: string) => String(url).includes("/api/board")
      ? Promise.resolve(new Response(JSON.stringify({ posts }), { headers: { "content-type": "application/json" } }))
      : new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const entries: unknown[] = [];
    vi.spyOn(window.history, "pushState").mockImplementation((state) => { entries.push(state); });
    const back = () => act(async () => {
      entries.pop();
      window.dispatchEvent(new PopStateEvent("popstate", { state: entries.at(-1) ?? null }));
    });
    const rows = () => [...document.querySelectorAll("[data-board-post]")].map((row) => row.getAttribute("data-board-post"));
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(App)));
      await act(async () => store.dispatch!({ type: "select", id: FORUM_SELECTION }));
      await vi.waitFor(() => expect(rows()).toEqual(["pnew", "pold"]));
      await act(async () => document.querySelector<HTMLButtonElement>('[data-board-post="pold"] button')!.click());
      expect(rows()).toEqual(["pold"]);
      await back();
      expect(store.state!.selectedId).toBe(FORUM_SELECTION);
      expect(rows()).toEqual(["pnew", "pold"]);
      await back();
      expect(store.state!.selectedId).toBe("b1");
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

describe("Phone menu across a rotation", () => {
  async function mountPhone() {
    localStorage.setItem("omb-onboarding-done", "true");
    localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
      bots: ["b1", "b2"].map((id, at) => ({ id, threadId: `t${at + 1}`, name: id, messages: [], modelSelection: { instanceId: "inst", model: "m" } })),
      groups: [],
      selectedId: "b2",
    }));
    const media = { phone: true, flips: new Set<() => void>() };
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      get matches() { return query.includes("max-width") ? media.phone : query.includes("reduce"); },
      media: query,
      addEventListener: (_type: string, flip: () => void) => media.flips.add(flip),
      removeEventListener: (_type: string, flip: () => void) => media.flips.delete(flip),
    }) as unknown as MediaQueryList);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
    const entries: unknown[] = [];
    vi.spyOn(window.history, "pushState").mockImplementation((state) => { entries.push(state); });
    const go = vi.spyOn(window.history, "go").mockImplementation((delta = 0) => {
      entries.splice(entries.length + delta);
      queueMicrotask(() => window.dispatchEvent(new PopStateEvent("popstate", { state: entries.at(-1) ?? null })));
    });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(App)));
    const rotate = (phone: boolean) => act(async () => {
      media.phone = phone;
      [...media.flips].forEach((flip) => flip());
    });
    const openMenu = () => act(async () => host.querySelector<HTMLButtonElement>("[data-phone-menu]")!.click());
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      localStorage.clear();
      store.dispatch = null;
    };
    return { host, entries, go, rotate, openMenu, unmount };
  }

  it("drops the menu's Back entry when the wide layout hides the menu", async () => {
    const view = await mountPhone();
    try {
      await view.openMenu();
      expect(view.entries.at(-1)).toEqual({ orbitBack: "drawer", depth: 2 });
      await view.rotate(false);
      expect(view.go).toHaveBeenCalledWith(-1);
      expect(view.entries).toEqual([{ orbitBack: "chat:b2", depth: 1 }]);
      expect(view.host.querySelector("[data-phone-menu]")!.getAttribute("aria-expanded")).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  it("opens full width on a phone whatever fold the wide layout saved", async () => {
    localStorage.setItem("openmausbot.sidebarCollapsed", "1");
    const view = await mountPhone();
    try {
      await view.openMenu();
      expect(view.host.querySelector("[data-phone-drawer] input")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
