// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MOTION_LARGE_MS } from "@/lib/motion";
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
const foldAll = async () => {
  await click("[data-fold-all]");
  await act(async () => { await vi.advanceTimersByTimeAsync(MOTION_LARGE_MS); });
};
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
  expect(rule(".usage-account-identity")).toContain("font-size: 13px");
  expect(rule(".usage-account-identity")).toContain("font-weight: 500");
  expect(rule(".usage-name-button")).toContain("font-weight: 500");
  expect(rule(".usage-meter")).toContain("font-size: 12.5px");
  expect(rule(".usage-meter-summary")).toContain("font-size: 11px");
  expect(rule(".usage-reset")).toContain("font-size: inherit");
  expect(rule(".usage-email")).toContain("font-size: 11px");
  expect(rule(".usage-email")).toContain("font-weight: 400");
});

it("shares phone label and bar columns with room between collapsed rows", () => {
  expect(rule(".usage-summary")).toContain("display: flex");
  expect(rule(".usage-summary")).toContain("gap: 4px 14px");
  expect(rule(".usage-meter-summary")).toContain("flex-wrap: wrap");
  expect(rule(".usage-meter-summary")).toContain("line-height: 20px");
  expect(rule(".usage-meter-summary .usage-figures")).toContain("gap: 6px");
  expect(rule(".usage-cells-mini")).toContain("--cells-w: 70px");
  expect(rule(".usage-cells-mini")).toContain("--cell-h: 4px");
  expect(rule(".usage-sections[data-phone-columns]")).toContain("grid-template-columns: max-content max-content var(--usage-bar-col, 70px) minmax(0, 1fr)");
  expect(rule("[data-phone-columns] .usage-summary")).toContain("grid-template-columns: subgrid");
  expect(rule("[data-phone-columns] .usage-meter-summary")).toContain("grid-template-columns: subgrid");
  expect(rule('.usage-desk:not(:has([data-engine-fold][aria-expanded="true"])) .usage-sections')).toContain("row-gap: 30px");
  expect(rule('.usage-desk:not(:has([data-engine-fold][aria-expanded="true"])) .usage-toolbar')).toContain("min-height: 44px; margin-bottom: 16px");
  expect(rule("[data-phone-columns] .usage-meter-summary .usage-figures")).toContain("row-gap: 6px");
  expect(rule("[data-phone-columns] .usage-meter-summary .usage-figures")).not.toContain("display: grid");
  expect(rule(".usage-meter-summary [data-left]:empty")).toContain("display: none");
  expect(css).toMatch(/\[data-phone-columns\] \.usage-engine-head:has\(\.usage-summary\) \{[^}]*min-height: var\(--usage-row-height\)/);
  expect(css).not.toContain("@container usage-summary");
});

it("grows the chat bar's coarse-pointer hit area to 44px without moving its bars", () => {
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  expect(coarse).toContain(".usage-chat-button { position: relative; z-index: 1; }");
  expect(coarse).toMatch(/\.usage-chat-button::after \{[^}]*inset-inline: 0;[^}]*top: calc\(50% - 22px\);[^}]*height: 44px;/);
  expect(rule(".usage-chat-button")).not.toContain("min-height");
});

it("keeps account spacing out of the chat meter above the composer", () => {
  expect(rule(".usage-chat-button")).not.toContain("padding-block");
  expect(rule(".usage-chat-windows")).toContain("column-gap: 24px");
  expect(rule(".usage-meter-chat")).toContain("gap: 0 6px");
  expect(rule(".usage-meter + .usage-meter")).toContain("margin-top: 1px");
  expect(css).not.toMatch(/@media \(width < 768px\) \{[^@]*\n  \.usage-reset \{/);
});

it("measures phone rows before aligning and restores the expanded layout", async () => {
  vi.stubGlobal("innerWidth", 392);
  const size = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 302, 45));
  await mount();
  expect(q("[data-phone-columns]")).toBeNull();
  await foldAll();
  expect(q("[data-phone-columns]")).not.toBeNull();
  for (const head of host.querySelectorAll<HTMLElement>(".usage-engine-head")) {
    expect(head.style.getPropertyValue("--usage-row-height")).toBe("45px");
    expect(head.style.transitionProperty).toBe("");
  }
  await foldAll();
  expect(q("[data-phone-columns]")).toBeNull();
  size.mockRestore();
});

it.each(["unknown", "signed-out", "ready"] as const)("keeps %s status text out of the shared meter columns", async (signIn) => {
  vi.stubGlobal("innerWidth", 392);
  const account = h.board!.engines[0]!.accounts[0]!;
  account.signIn = signIn;
  account.windows = [];
  await mount();
  await click("[data-fold-all]");
  const summary = q('[data-usage-engine="claude"] .usage-summary')!;
  expect(summary.children).toHaveLength(1);
  expect(summary.firstElementChild!.tagName).toBe("SPAN");
  expect(summary.firstElementChild!.textContent).not.toBe("");
  expect(rule(".usage-summary > span")).toContain("grid-column: 1 / -1");
});

it("shares desktop window widths and drops them when expanded or too narrow", async () => {
  vi.stubGlobal("innerWidth", 1280);
  h.board!.engines.find((engine) => engine.engine === "codex")!.accounts[0]!.windows = structuredClone(h.board!.engines[0]!.accounts[0]!.windows);
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => Object.assign(document.createElement("div").style, {
    width: `${element.matches("[data-engine-fold]") ? 100 : element.matches('[data-window="session"]') ? element.closest('[data-usage-engine="codex"]') ? 210 : 180 : 190}px`,
  }));
  let width = 628;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  await mount();
  await foldAll();
  const list = q("[data-desktop-columns]")!;
  expect(list).not.toBeNull();
  expect(list.style.getPropertyValue("--usage-summary-columns")).toBe("210px 190px");
  width = 400;
  await mount();
  expect(q("[data-desktop-columns]")).toBeNull();
  width = 628;
  await foldAll();
  expect(q("[data-desktop-columns]")).toBeNull();
  vi.restoreAllMocks();
});

it("keeps layout widths while the Settings entrance scales the painted meters", async () => {
  vi.stubGlobal("innerWidth", 1200);
  localStorage.setItem("openmausbot.usageFolds.v1", JSON.stringify(Object.fromEntries(h.board!.engines.map((engine) => [engine.base, true]))));
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => Object.assign(document.createElement("div").style, {
    width: element.matches("[data-engine-fold]") ? "100px" : "184.390625px",
  }));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(628);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, (this.matches("[data-engine-fold]") ? 100 : 184.390625) * 0.96, 20 * 0.96);
  });
  await mount();
  expect(q("[data-desktop-columns]")!.style.getPropertyValue("--usage-summary-columns")).toBe("185px 185px");
  vi.restoreAllMocks();
});

it("steps every collapsed bar down with its container width and leaves phones unchanged", async () => {
  vi.stubGlobal("innerWidth", 1280);
  h.board!.engines = [h.board!.engines[0]!];
  localStorage.setItem("openmausbot.usageFolds.v1", JSON.stringify({ claude: true }));
  vi.stubGlobal("getComputedStyle", (element: HTMLElement) => {
    const size = element.closest<HTMLElement>("[data-summary-size]")?.dataset.summarySize;
    const bar = size === "large" ? 120 : size === "medium" ? 95 : 70;
    return Object.assign(document.createElement("div").style, {
      width: `${element.matches("[data-engine-fold]") ? 100 : bar + (element.dataset.window === "week" ? 100 : 80)}px`,
    });
  });
  let width = 560;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  for (const [available, size, columns] of [[560, "large", "200px 220px"], [510, "medium", "175px 195px"], [460, "small", "150px 170px"], [560, "large", "200px 220px"]] as const) {
    width = available;
    await mount();
    expect(q("[data-usage-sections]")!.dataset.summarySize).toBe(size);
    expect(q("[data-desktop-columns]")!.style.getPropertyValue("--usage-summary-columns")).toBe(columns);
  }
  expect(rule(".usage-sections .usage-cells-mini")).toContain("transition-property: none");
  expect(rule('.usage-sections[data-summary-size="large"] .usage-cells-mini')).toContain("--cells-w: 120px; --cell-h: 7px");
  expect(rule('.usage-sections[data-summary-size="medium"] .usage-cells-mini')).toContain("--cells-w: 95px; --cell-h: 5.5px");
  vi.restoreAllMocks();
});

it("sizes phone folded bars like the limits card and steps down when the figures would squeeze", async () => {
  vi.stubGlobal("innerWidth", 392);
  h.board!.engines = [h.board!.engines[0]!];
  localStorage.setItem("openmausbot.usageFolds.v1", JSON.stringify({ claude: true }));
  let overflows: string[] = [];
  let wraps: string[] = [];
  const size = (element: HTMLElement) => element.closest<HTMLElement>("[data-summary-size]")?.dataset.summarySize ?? "";
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.matches(".usage-figures") && overflows.includes(size(this)) ? 90 : 40; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(60);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.matches(".usage-figures") && wraps.includes(size(this)) ? 46 : 20; });
  for (const [overflow, wrap, expected] of [[[], [], "large"], [["large"], [], "medium"], [[], ["large"], "medium"], [[], ["large", "medium"], "small"], [["large", "medium"], ["small"], "small"]] as const) {
    overflows = [...overflow];
    wraps = [...wrap];
    await mount();
    expect(q("[data-usage-sections]")!.dataset.summarySize).toBe(expected);
    expect(q("[data-phone-columns]")).not.toBeNull();
  }
  expect(rule(".usage-sections[data-phone-columns]")).toContain("var(--usage-bar-col, 70px)");
  expect(rule(".usage-sections[data-phone-columns] .usage-cells-mini")).toContain("--cells-w: var(--usage-bar-col, 70px); --cell-h: var(--usage-bar-h, 4px)");
  expect(rule('.usage-sections[data-phone-columns][data-summary-size="large"]')).toContain("--usage-bar-col: 80px; --usage-bar-h: 7px");
  expect(rule('.usage-sections[data-phone-columns][data-summary-size="medium"]')).toContain("--usage-bar-col: 75px; --usage-bar-h: 5.5px");
  expect(css).toMatch(/@media \(width < 768px\) \{\s*\.usage-meter \{ --cells-w: 80px;/);
  expect(rule(".usage-desk, [data-usage-quick]")).toContain("--cell-h: 7px");
  await foldAll();
  expect(q("[data-summary-size]")).toBeNull();
  vi.restoreAllMocks();
});

it("gives the refresh icon a 44px coarse-pointer hit area", () => {
  expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*\[data-usage-refresh\] \{[^}]*width: 44px;[^}]*height: 44px;/);
  expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*\[data-usage-refresh\]::after \{ inset: 0;/);
});

it("keeps the limit separator with its reset when a narrow meter wraps", async () => {
  h.board!.engines[0]!.accounts[0]!.windows[0]!.usedPercent = 100;
  await mount();
  const reset = q("[data-account-bars] [data-reached] .usage-reset")!;
  expect(reset.querySelector(".usage-reset-short")!.textContent).toMatch(/^ · \(/);
  expect([...reset.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("")).not.toContain("·");
});

const bars = (root: ParentNode = host) => [...root.querySelectorAll("[data-cells]")].map((bar) => [bar.tagName.toLowerCase(), bar.getAttribute("class")!.split(" ")[0], [...bar.children].map((cell) => cell.tagName.toLowerCase()).join(",")]);
const shared = ["svg", "usage-cells", Array(10).fill("polygon").join(",")];

it("fits ten slanted cells and two-pixel gaps inside Today's collapsed box", async () => {
  const size = vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 70, 4));
  await mount();
  await click("[data-fold-all]");
  const bar = q("[data-engine-summary] [data-cells]")!;
  expect(bar.getAttribute("viewBox")).toBe("0 0 70 4");
  const shapes = [...bar.children].map((cell) => cell.getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number)));
  expect(shapes).toHaveLength(10);
  expect(shapes[0]![1]![0]! - shapes[0]![0]![0]!).toBeCloseTo(5.08);
  expect(shapes[1]![0]![0]! - shapes[0]![1]![0]!).toBe(2);
  expect(shapes[0]![3]![0]!).toBe(1.2);
  expect(shapes[9]![2]![0]!).toBeCloseTo(70);
  size.mockRestore();
});

it("draws every bar as the one shared slanted shape, never glyphs or skewed boxes", async () => {
  expect(css).not.toMatch(/skew|box-shadow: inset/);
  expect(rule(".usage-cells")).toContain("fill: currentColor");
  expect(rule('.usage-cells > [data-cell="off"]')).toContain("fill-opacity");
  vi.stubGlobal("devicePixelRatio", 1.25);
  const size = vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 120, 7));
  await mount();
  const bar = q("[data-account-bars] [data-cells]")!;
  expect(bar.getAttribute("viewBox")).toBe("0 0 150 9");
  const shapes = [...bar.children].map((cell) => cell.getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number)));
  expect(new Set(shapes.flatMap((points) => points.map(([, y]) => y)))).toEqual(new Set([0, 9]));
  expect(new Set(shapes.map(([[left], [right]]) => (right! - left!).toFixed(6))).size).toBe(1);
  expect(new Set(shapes.map(([[bottomLeft], [bottomRight], [topRight], [topLeft]]) => `${(topLeft! - bottomLeft!).toFixed(6)} ${(topRight! - bottomRight!).toFixed(6)}`))).toEqual(new Set(["2.700000 2.700000"]));
  expect(shapes.slice(1).map(([[left]], index) => left! - shapes[index]![1]![0]!).map((gap) => gap.toFixed(6))).toEqual(Array(9).fill("2.000000"));
  expect(Math.max(...shapes.flatMap((points) => points.map(([x]) => x!)))).toBeLessThanOrEqual(150);
  expect(new Set([...bar.children].map((cell) => cell.getAttribute("data-cell")))).toEqual(new Set(["on", "off"]));
  size.mockRestore();
  expect(host.textContent).not.toMatch(/[─-▟▰▱]/u);
});

it("renders the shared bar in expanded, collapsed, quick view, chat and terminal skin", async () => {
  const sites: Record<string, string[][]> = {};
  await mount();
  sites.expanded = bars(q("[data-account-bars]")!);
  await click("[data-fold-all]");
  sites.collapsed = bars(q("[data-engine-summary]")!);
  await mount(createElement(ChatPlanMeters, { instanceId: "claude", windows: [], now: usageBoardNow, onOpenUsage: () => {} }));
  sites.chat = bars(q("[data-usage-meter]")!);
  await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
  sites.quick = bars(document.querySelector("[data-usage-quick]")!);
  document.documentElement.dataset.skin = "terminal";
  await mount(createElement(UsageDesk, { key: "terminal" }));
  sites.terminal = bars();
  delete document.documentElement.dataset.skin;
  for (const [site, found] of Object.entries(sites)) {
    expect(found.length, site).toBeGreaterThan(0);
    for (const bar of found) expect(bar, site).toEqual(shared);
  }
  expect(document.body.textContent).not.toMatch(/[─-▟▰▱]/u);
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
  expect(refresh.getAttribute("title")).toBe(locale === "en" ? "Refresh (Alt R)" : "새로고침 (Alt R)");
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
