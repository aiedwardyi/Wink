// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { usageBoardFixture } from "@/lib/usage-board.fixture";
import type { InstanceInfo } from "@/state/store";

const { mockState, mockApi, settle, pendingPaths } = vi.hoisted(() => {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const state: { instances: InstanceInfo[]; bots: never[]; appSettingsSection: string; config: unknown } = {
    instances: [], bots: [], appSettingsSection: "account", config: null,
  };
  return {
    mockState: state,
    mockApi: vi.fn((path: string): Promise<unknown> => {
      if (path === "/api/accounts") return Promise.resolve({ accounts: [] });
      if (path.startsWith("/api/usage/board")) return new Promise(() => {});
      return new Promise((resolve, reject) => pending.set(path, { resolve, reject }));
    }),
    pendingPaths: () => [...pending.keys()],
    settle: (path: string, outcome: "ok" | "fail" | Record<string, unknown>) => {
      const entry = pending.get(path);
      pending.delete(path);
      if (outcome === "fail") return entry?.reject(new Error("offline"));
      if (typeof outcome === "object") return entry?.resolve(outcome);
      const observedAt = new Date().toISOString();
      const id = path.split("/").pop()!;
      entry?.resolve({ report: { windows: [{ id: "five_hour", usedPercent: 10, resetsAt: Date.now() + 3_600_000 }], observedAt }, instanceId: id });
    },
  };
});

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: mockApi,
    useStore: () => ({
      state: mockState,
      dispatch: (action: { type: string; instanceId: string; report: NonNullable<InstanceInfo["rateLimits"]> }) => {
        mockState.instances = mockState.instances.map((instance) => instance.instanceId === action.instanceId
          ? { ...instance, rateLimits: action.report } : instance);
      },
    }),
  };
});

import { UsageSection } from "./UsageSection";
import { SettingsModal } from "./SettingsModal";
import { UsageQuickView } from "./UsageQuickView";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const reading = (observedAt: string, usedPercent = 90) => ({
  observedAt,
  windows: [{ id: "five_hour", usedPercent, resetsAt: Date.now() + 3_600_000 }],
});
const engine = (instanceId: string, driverKind: string, displayName: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName,
  snapshot: { state: "available", authenticated: true },
  models: { default: "default", options: [] },
  capabilities: { rateLimits: true },
  ...extra,
});

let tests = 0;

describe("Usage auto refresh", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const open = (node: ReactElement = createElement(UsageSection)) => act(async () => root.render(createElement(I18nProvider, null, node)));
  const refreshed = () => mockApi.mock.calls.map(([path]) => path).filter((path) => /^\/api\/usage\/(refresh|check)\//.test(path)).sort();
  const settleAll = () => act(async () => { settle("/api/usage/refresh/claude", "ok"); settle("/api/usage/refresh/grok", "ok"); });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.now() + ++tests * 3_600_000);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockApi.mockClear();
    mockState.instances = [
      engine("claude", "claudeAgent", "Claude", { rateLimits: reading(minutesAgo(6)) }),
      engine("codex", "codex", "Codex", { rateLimits: reading(minutesAgo(2)) }),
      engine("grok", "grokAgent", "Grok"),
      engine("muse", "museAgent", "Meta Muse", { rateLimits: reading(minutesAgo(24 * 60)) }),
    ];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { for (const path of pendingPaths()) settle(path, "ok"); });
    await act(async () => root.unmount());
    host.remove();
    mockState.appSettingsSection = "account";
    vi.useRealTimers();
  });

  it("refreshes only readings older than 5 minutes and never Muse", async () => {
    await open();
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
  });

  it("starts nothing twice while a refresh runs and nothing again within 5 minutes", async () => {
    await open();
    await open(createElement("div", null, createElement(UsageSection), createElement(UsageSection)));
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
    await settleAll();
    await act(async () => root.unmount());
    root = createRoot(host);
    await open();
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
  });

  it("leaves Muse to the manual check and does not spin for it", async () => {
    mockState.instances = [engine("muse", "museAgent", "Meta Muse", { rateLimits: reading(minutesAgo(24 * 60)) })];
    await open();
    expect(refreshed()).toEqual([]);
    expect(host.querySelector("svg.animate-spin")).toBeNull();
  });

  it("keeps the old reading and shows no error when a refresh fails", async () => {
    await open();
    await act(async () => { settle("/api/usage/refresh/claude", "fail"); settle("/api/usage/refresh/grok", "fail"); });
    expect(host.textContent).not.toContain("Could not refresh");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores a refresh response for the previous signed-in identity", async () => {
    mockState.instances = [engine("grok", "grokAgent", "Grok", { snapshot: { state: "available", authenticated: true, account: "old@example.test" } })];
    await open();
    mockState.instances = mockState.instances.map((instance) => ({ ...instance, snapshot: { ...instance.snapshot, account: "new@example.test" } }));
    await open();
    await act(async () => { settle("/api/usage/refresh/grok", { report: reading(minutesAgo(0), 100) }); });
    expect(mockState.instances[0].rateLimits).toBeUndefined();
  });

  it("starts the refresh when Settings opens on another tab", async () => {
    await open(createElement(SettingsModal));
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
  });

  it("refreshes once when Settings opens straight on Usage, as Alt+U and the chat bar do", async () => {
    mockState.appSettingsSection = "usage";
    await open(createElement(SettingsModal));
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
  });

  it("refreshes again when the Usage tab is picked after Settings was left open", async () => {
    await open(createElement(SettingsModal));
    await settleAll();
    mockState.instances = mockState.instances.map((instance) => ({ ...instance, rateLimits: reading(minutesAgo(6)) }));
    mockState.appSettingsSection = "usage";
    await open(createElement(SettingsModal));
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/claude", "/api/usage/refresh/codex", "/api/usage/refresh/grok", "/api/usage/refresh/grok"]);
  });

  it("waits out a failed attempt and the server's retryAt before trying again", async () => {
    await open();
    await act(async () => { settle("/api/usage/refresh/claude", "fail"); settle("/api/usage/refresh/grok", { error: "Could not refresh Grok limits", retryAt: Date.now() + 10 * 60_000 }); });
    await act(async () => root.unmount());
    root = createRoot(host);
    await open();
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
    await act(async () => root.unmount());
    vi.setSystemTime(Date.now() + 61_000);
    root = createRoot(host);
    await open();
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
  });

  it("treats a retained answer as a failed attempt", async () => {
    await open();
    await act(async () => { settle("/api/usage/refresh/claude", { status: "retained", report: reading(minutesAgo(6)), retryAt: Date.now() + 30_000 }); settle("/api/usage/refresh/grok", "fail"); });
    await act(async () => root.unmount());
    root = createRoot(host);
    await open();
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
  });

  it("refreshes Muse and a shown Gemini when the quick view opens, once within the throttle", async () => {
    const board = structuredClone(usageBoardFixture);
    const anchor = document.body.appendChild(document.createElement("button"));
    mockState.instances = [
      engine("claude", "claudeAgent", "Claude", { rateLimits: reading(minutesAgo(6)) }),
      engine("muse", "museAgent", "Meta Muse", { rateLimits: reading(minutesAgo(24 * 60)) }),
      engine("gemini", "antigravityAgent", "Gemini"),
      engine("hidden-gemini", "antigravityAgent", "Gemini 2"),
    ];
    const quick = () => createElement(UsageQuickView, { engine: board.engines[0]!, account: board.engines[0]!.accounts[0]!, board,
      state: { board, status: "ready", pending: {}, failed: new Set<string>() }, anchor: { current: anchor }, onClose: () => {} });
    await open(quick());
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/gemini", "/api/usage/refresh/muse"]);
    await act(async () => { settle("/api/usage/refresh/claude", "ok"); settle("/api/usage/refresh/gemini", "ok"); settle("/api/usage/refresh/muse", "ok"); });
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(quick());
    expect(refreshed()).toHaveLength(3);
    anchor.remove();
  });

  describe("quick view refresh button", () => {
    const board = structuredClone(usageBoardFixture);
    let anchor: HTMLButtonElement;
    const quick = (failed = new Set<string>()) => createElement(UsageQuickView, { engine: board.engines[0]!, account: board.engines[0]!.accounts[0]!, board,
      state: { board, status: "ready", pending: {}, failed }, anchor: { current: anchor }, onClose: () => {} });
    const button = () => document.body.querySelector<HTMLButtonElement>("[data-usage-refresh]");
    const fresh = () => {
      mockState.instances = [
        engine("claude", "claudeAgent", "Claude", { rateLimits: reading(minutesAgo(1)) }),
        engine("codex", "codex", "Codex", { rateLimits: reading(minutesAgo(1)) }),
      ];
    };
    beforeEach(() => { anchor = document.body.appendChild(document.createElement("button")); fresh(); });
    afterEach(() => anchor.remove());

    it("sits left of Close and refreshes this engine's accounts even when fresh", async () => {
      await open(quick());
      expect(refreshed()).toEqual([]);
      const close = document.body.querySelector("[data-quick-close]")!;
      expect(button()).not.toBeNull();
      expect(button()!.nextElementSibling).toBe(close);
      expect(button()!.getAttribute("aria-label")).toBe("Refresh");
      await act(async () => { button()!.click(); });
      expect(refreshed()).toEqual(["/api/usage/refresh/claude"]);
    });

    it("spins and disables while a refresh is pending, then stops", async () => {
      await open(quick());
      await act(async () => { button()!.click(); });
      expect(button()!.disabled).toBe(true);
      expect(button()!.querySelector("svg[class*='animate-spin']")).not.toBeNull();
      await act(async () => { settle("/api/usage/refresh/claude", "ok"); });
      expect(button()!.disabled).toBe(false);
      expect(button()!.querySelector("svg[class*='animate-spin']")).not.toBeNull();
      await act(async () => { button()!.querySelector("svg")!.dispatchEvent(new Event("animationiteration", { bubbles: true })); });
      expect(button()!.querySelector("svg[class*='animate-spin']")).toBeNull();
    });

    it("spins for the automatic refresh on open", async () => {
      mockState.instances = [engine("claude", "claudeAgent", "Claude", { rateLimits: reading(minutesAgo(6)) })];
      await open(quick());
      expect(button()!.querySelector("svg[class*='animate-spin']")).not.toBeNull();
    });

    it("shows the failure line and keeps the old reading", async () => {
      await open(quick());
      await act(async () => { button()!.click(); });
      await act(async () => { settle("/api/usage/refresh/claude", "fail"); });
      expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("Could not refresh usage. Try again.");
      expect(mockState.instances[0]!.rateLimits).toBeDefined();
    });
  });

  it("checks again when accounts hydrate late and when the tab becomes visible, never while hidden", async () => {
    const real = mockState.instances;
    mockState.instances = real.map((instance) => ({ ...instance, snapshot: { state: "unavailable" as const, authenticated: false } }));
    await open();
    expect(refreshed()).toEqual([]);
    mockState.instances = real;
    await open(createElement("div", null, createElement(UsageSection)));
    expect(refreshed()).toEqual(["/api/usage/refresh/claude", "/api/usage/refresh/grok"]);
    await settleAll();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    mockState.instances = mockState.instances.map((instance) => ({ ...instance, rateLimits: reading(minutesAgo(6)) }));
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(refreshed()).toHaveLength(2);
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(refreshed()).toHaveLength(5);
    visibility.mockRestore();
  });
});
