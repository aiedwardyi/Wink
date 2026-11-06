// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard } from "@/lib/usage-board";
import { setUsageMode } from "@/lib/usage-preferences";

const h = vi.hoisted(() => ({ board: null as UsageBoard | null, instances: [] as any[], api: vi.fn(), dispatch: vi.fn(), pending: {} as Record<string, {target: string; from: string; after: number | null}>, requestMain: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: h.api,
  useStore: () => ({ state: { instances: h.instances, bots: [], terminalPanes: {} }, dispatch: h.dispatch, refreshInstances: async () => {} }),
}));
vi.mock("@/lib/use-usage-board", () => ({ useUsageBoard: () => ({ board: h.board, status: "ready", pending: h.pending, failed: new Set() }) }));
vi.mock("@/lib/usage-auto-refresh", async (original) => ({ ...await original<typeof import("@/lib/usage-auto-refresh")>(), useAutoRefresh: () => {} }));
vi.mock("@/lib/usage-board-client", async (original) => ({ ...await original<typeof import("@/lib/usage-board-client")>(), requestMain: h.requestMain }));
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { UsageDesk } from "./UsageDesk";
import { ChatPlanMeters } from "./ChatPlanMeters";

let host: HTMLDivElement;
let root: Root;
const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const click = async (selector: string) => {
  expect(q(selector), selector).not.toBeNull();
  await act(async () => q(selector)!.click());
};
const mount = async (node: ReactElement = createElement(UsageDesk)) => {
  await act(async () => root.render(createElement(I18nProvider, null, node)));
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  setUsageMode("remaining");
  persistPreference("en");
  vi.useFakeTimers({ now: usageBoardNow, toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  h.board = structuredClone(usageBoardFixture);
  h.instances = h.board.engines.flatMap((engine) => engine.accounts.map((account) => ({
    instanceId: account.id, accountOf: engine.base, driverKind: engine.engine === "codex" ? "codex" : `${engine.engine}Agent`,
    snapshot: { authenticated: true, state: "available", account: `account-${account.number}@example.com` },
    canRefreshUsage: true, models: { default: "default", options: [] },
  })));
  h.pending = {};
  h.requestMain.mockReset();
  h.api.mockReset().mockResolvedValue({});
  h.dispatch.mockReset();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const css = readFileSync(resolve("src/components/UsageDesk.css"), "utf8");
const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0] ?? "";

it("matches sidebar name and chat meter sizes while keeping emails small", () => {
  expect(rule(".usage-account-identity")).toContain("font-size: 15px");
  expect(rule(".usage-name-button")).toContain("font-weight: 600");
  expect(rule(".usage-meter")).toContain("font-size: 12.5px");
  expect(rule(".usage-meter-summary")).toContain("font-size: 12.5px");
  expect(rule(".usage-reset")).toContain("font-size: inherit");
  expect(rule(".usage-email")).toContain("font-size: 11px");
  expect(rule(".usage-email")).toContain("font-weight: 400");
});

it("uses straight shared box segments in expanded, collapsed and chat meters", async () => {
  expect(rule(".usage-cells > span")).not.toContain("skew");
  await mount();
  expect(q("[data-account-bars] [data-cells]")!.children).toHaveLength(10);
  await click("[data-fold-all]");
  expect(q("[data-engine-summary] .usage-cells-mini")!.children).toHaveLength(10);
  await mount(createElement(ChatPlanMeters, { instanceId: "claude", windows: [], now: usageBoardNow, onOpenUsage: () => {} }));
  expect(q("[data-usage-meter] .usage-cells")!.children).toHaveLength(10);
  expect(host.textContent).not.toMatch(/[\u25b0\u25b1]/u);
});

it.each(["en", "ko"] as const)("puts Collapse all then the refresh icon at the right in %s and spins only while busy", async (locale) => {
  persistPreference(locale);
  let finish!: (value: object) => void;
  h.api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  h.instances = [h.instances[0]];
  await mount();
  const toolbar = q(".usage-toolbar")!;
  expect([...toolbar.children].map((el) => el.hasAttribute("data-fold-all") ? "fold" : el.hasAttribute("data-usage-refresh") ? "refresh" : "count")).toEqual(["count", "fold", "refresh"]);
  const refresh = q("[data-usage-refresh]")!;
  expect(refresh.getAttribute("aria-label")).toBe(locale === "en" ? "Refresh" : "새로고침");
  expect(refresh.getAttribute("title")).toBe(refresh.getAttribute("aria-label"));
  expect(refresh.querySelector("svg")).not.toBeNull();
  expect(refresh.textContent).toBe("");
  expect(refresh.getAttribute("aria-busy")).toBe("false");
  await click("[data-usage-refresh]");
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  expect(refresh.querySelector("svg")!.classList.contains("motion-safe:animate-spin")).toBe(true);
  await act(async () => finish({}));
  expect(refresh.getAttribute("aria-busy")).toBe("false");
  expect(refresh.querySelector("svg")!.classList.contains("motion-safe:animate-spin")).toBe(false);
});

it("moves Main after confirmation and clears the soft highlight after 600ms without fading other rows", async () => {
  await mount();
  const engine = h.board!.engines[0]!;
  const next = engine.accounts[1]!;
  const nextRow = `[data-account-row="${next.id}"]`;
  await click(`${nextRow} [data-use]`);
  expect(h.requestMain).toHaveBeenCalledWith(engine.base, next.id, expect.any(Function));
  h.pending = { [engine.base]: { target: next.id, from: engine.mainId!, after: null } };
  await mount();
  expect(q("[data-usage-switched]")).toBeNull();
  expect(host.querySelectorAll('[class*="opacity-50"]')).toHaveLength(0);
  engine.mainId = next.id;
  h.pending = {};
  await mount();
  expect(q(`${nextRow} [data-main-check]`)).not.toBeNull();
  expect(q(`${nextRow}[data-usage-switched]`)).not.toBeNull();
  expect(q('[data-account-row="claude"] [data-main-check]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(601); });
  expect(q("[data-usage-switched]")).toBeNull();
  expect(css).toContain("usage-main-in 200ms");
  expect(css).toContain("usage-switch-highlight 600ms");
  expect(rule(".usage-control[data-use]")).toContain("-webkit-tap-highlight-color: transparent");
  expect(rule(".usage-control[data-use]")).toContain("animation: none");
});

it("swaps Main instantly without highlight under reduced motion", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  await mount();
  const engine = h.board!.engines[0]!;
  engine.mainId = engine.accounts[1]!.id;
  await mount();
  expect(q(`[data-account-row="${engine.mainId}"] [data-main-check]`)).not.toBeNull();
  expect(q("[data-usage-switched]")).toBeNull();
});

