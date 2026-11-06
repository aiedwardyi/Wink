// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard } from "@/lib/usage-board";
import { setUsageMode } from "@/lib/usage-preferences";

const h = vi.hoisted(() => ({ board: null as UsageBoard | null, instances: [] as any[], api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: h.api,
  useStore: () => ({ state: { instances: h.instances, bots: [], terminalPanes: {} }, dispatch: h.dispatch, refreshInstances: async () => {} }),
}));
vi.mock("@/lib/use-usage-board", () => ({ useUsageBoard: () => ({ board: h.board, status: "ready", pending: {}, failed: new Set() }) }));
vi.mock("@/lib/usage-auto-refresh", async (original) => ({ ...await original<typeof import("@/lib/usage-auto-refresh")>(), useAutoRefresh: () => {} }));
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { UsageDesk } from "./UsageDesk";
import { ChatPlanMeters } from "./ChatPlanMeters";
import { AccountPicker } from "./UsageAccounts";

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
const remount = async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
};
const engines = () => [...host.querySelectorAll("[data-usage-engine]")].map((el) => el.getAttribute("data-usage-engine"));
const rows = () => [...host.querySelectorAll('[data-usage-engine="claude"] [data-account-row]')].map((el) => el.getAttribute("data-account-row"));
const key = async (selector: string, direction: string) => act(async () => {
  expect(q(selector), selector).not.toBeNull();
  q(selector)!.dispatchEvent(new KeyboardEvent("keydown", { key: direction, altKey: true, bubbles: true }));
});

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
});

it("folds to Main's bars and reset, without another account's windows", async () => {
  await mount();
  await click('[data-usage-engine="claude"] [data-engine-fold]');
  const summary = q('[data-usage-engine="claude"] [data-engine-summary]')!;
  expect(summary.querySelectorAll("[data-cells]")).toHaveLength(2);
  expect(summary.textContent).toContain("34%");
  expect(summary.textContent).toContain("40m");
  expect(summary.textContent).not.toContain("Limit reached");
});

it("has no reading-age text, including Muse", async () => {
  const muse = structuredClone(h.board!.engines[0]!);
  muse.engine = "muse"; muse.base = "muse"; muse.mainId = "muse";
  muse.accounts = [{ ...muse.accounts[0]!, id: "muse", name: "Muse", observedAt: usageBoardNow - 7_200_000 }];
  h.board!.engines.push(muse);
  await mount();
  expect(host.textContent).not.toMatch(/As of|ago/);
  expect(q("[data-reading-age]")).toBeNull();
});

it.each(["en", "ko"] as const)("expands and collapses every section in %s", async (locale) => {
  persistPreference(locale);
  await mount();
  await click("[data-fold-all]");
  expect([...host.querySelectorAll("[data-engine-fold]")].every((el) => el.getAttribute("aria-expanded") === "false")).toBe(true);
  await click("[data-fold-all]");
  expect([...host.querySelectorAll("[data-engine-fold]")].every((el) => el.getAttribute("aria-expanded") === "true")).toBe(true);
  expect(q("[data-fold-all]")!.textContent).toBe(locale === "en" ? "Collapse all" : "모두 접기");
});

it("persists the count choice and animates numbers with their cells", async () => {
  await mount();
  await click('[data-count-mode="used"]');
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(q('[data-account-row="claude"] [data-left]')!.textContent).toContain("66%");
  expect(q('[data-account-row="claude"] [data-cells]')!.getAttribute("data-cells")).toBe("7");
  await remount();
  expect(q('[data-count-mode="used"]')!.getAttribute("aria-pressed")).toBe("true");
  await mount(createElement(ChatPlanMeters, { instanceId: "claude", windows: [], now: usageBoardNow, onOpenUsage: () => {} }));
  await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
  const quick = document.querySelector('[data-usage-quick] [data-account-row="claude"]');
  expect(quick?.querySelector("[data-left]")?.textContent).toContain("66%");
  expect(quick?.querySelector("[data-cells]")?.getAttribute("data-cells")).toBe("7");
  await mount();
  await click('[data-count-mode="remaining"]');
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(q('[data-account-row="claude"] [data-left]')!.textContent).toContain("34%");
});

it("keeps one red cell for one percent and says Limit reached at zero", async () => {
  h.board!.engines[0]!.accounts[0]!.windows[0]!.usedPercent = 99;
  await mount();
  const meter = q('[data-account-row="claude"] [data-window="session"]')!;
  expect(meter.querySelectorAll('[data-cell="on"]')).toHaveLength(1);
  expect(meter.querySelector("[data-left]")!.className).toContain("text-danger");
  expect(host.textContent).toContain("Limit reached");
});

it.each([[-3, 0], [99.49, 99], [99.5, 99], [99.9, 99], [100, 100], [120, 100]])("clamps used %s to %s without reaching the limit early", async (used, shown) => {
  h.board!.engines[0]!.accounts[0]!.windows[0]!.usedPercent = used!;
  await mount();
  await click('[data-count-mode="used"]');
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  const meter = q('[data-account-row="claude"] [data-window="session"]')!;
  expect(meter.querySelector("[data-left]")!.textContent).toBe(`${shown}% used`);
  expect(meter.hasAttribute("data-reached")).toBe(used! >= 100);
  await click('[data-count-mode="remaining"]');
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  const left = Math.max(0, Math.min(100, 100 - used!));
  expect(meter.querySelector("[data-left]")!.textContent).toBe(`${left > 0 ? Math.max(1, Math.round(left)) : 0}% left`);
});

it("shows email under Settings names and nowhere in chat, quick view or picker", async () => {
  await mount();
  expect(q('[data-account-row="claude"] [data-account-email]')!.textContent).toBe("account-1@example.com");
  await mount(createElement(ChatPlanMeters, { instanceId: "claude", windows: [], now: usageBoardNow, onOpenUsage: () => {} }));
  expect(host.innerHTML).not.toContain("@example.com");
  await act(async () => window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })));
  expect(document.querySelector("[data-usage-quick]")).not.toBeNull();
  expect(document.querySelector("[data-usage-quick]")!.outerHTML).not.toContain("@example.com");
  await mount(createElement(AccountPicker, { accounts: h.board!.engines[0]!.accounts, viewedId: "claude", select: () => {} }));
  await click('[aria-haspopup="menu"]');
  expect(host.innerHTML).not.toContain("@example.com");
});

it("reorders accounts with Alt+Down and keeps the order after remount", async () => {
  await mount();
  const before = rows();
  await key('[data-account-row="claude"] [data-usage-grip]', "ArrowDown");
  expect(rows()).toEqual([before[1], before[0], before[2]]);
  await remount();
  expect(rows()).toEqual([before[1], before[0], before[2]]);
});

it("reorders sections with Alt+Down and keeps the order after remount", async () => {
  await mount();
  const before = engines();
  await key('[data-usage-engine="claude"] > [data-engine-head] [data-usage-grip]', "ArrowDown");
  expect(engines()).toEqual([before[1], before[0], ...before.slice(2)]);
  await remount();
  expect(engines()).toEqual([before[1], before[0], ...before.slice(2)]);
});

it.each(["keyboard", "pointer", "animated pointer"])("restores the current grip after a capped row remounts through %s", async (how) => {
  const engine = h.board!.engines[0]!;
  engine.accounts.push({ ...engine.accounts[0]!, id: "claude-four", number: 4, name: "Claude 4", main: false });
  await mount();
  await click('[data-usage-engine="claude"] [data-accounts-cap]');
  const id = engine.accounts[2]!.id;
  const selector = `[data-account-row="${id}"] [data-usage-grip]`;
  const pressed = q(selector)!;
  pressed.focus();
  if (how === "keyboard") await key(selector, "ArrowDown");
  else {
    for (const [index, row] of [...host.querySelectorAll<HTMLElement>('[data-usage-engine="claude"] [data-account-row]')].entries()) {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 80, 400, 80));
    }
    Object.defineProperty(pressed.closest("[data-account-row]"), "animate", { configurable: true,
      value: how === "animated pointer" ? () => ({ finished: Promise.resolve(), cancel() {} }) : undefined });
    await act(async () => {
      pressed.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, clientY: 170, bubbles: true }));
      document.dispatchEvent(new PointerEvent("pointermove", { clientY: 280, bubbles: true }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
  }
  expect(pressed.isConnected).toBe(false);
  expect(document.activeElement).toBe(q(selector));
  await key(selector, "ArrowUp");
  expect(rows()).toEqual(engine.accounts.map((account) => account.id));
  expect(document.activeElement).toBe(q(selector));
});

it("keeps hidden accounts in place when a reorder key hits the list boundary", async () => {
  const engine = h.board!.engines[0]!;
  const fourth = { ...engine.accounts[0]!, id: "claude-four", number: 4, name: "Claude 4", main: true };
  engine.accounts.push(fourth);
  engine.mainId = fourth.id;
  await mount();
  await key('[data-account-row="claude"] [data-usage-grip]', "ArrowUp");
  await click('[data-usage-engine="claude"] [data-accounts-cap]');
  expect(rows()).toEqual(engine.accounts.map((account) => account.id));
});

it.each([false, true])("preserves hidden account slots after a collapsed reorder (saved=%s)", async (saved) => {
  const engine = h.board!.engines[0]!;
  engine.accounts.push(...[4, 5, 6].map((number) => ({ ...engine.accounts[0]!, id: `claude-${number}`, number, name: `Claude ${number}`, main: false })));
  engine.mainId = "claude-6";
  const full = engine.accounts.map((account) => account.id);
  if (saved) [full[2], full[4]] = [full[4]!, full[2]!];
  localStorage.setItem("openmausbot.usageOrder.v1", JSON.stringify({ claude: full, codex: ["codex"] }));
  await mount();
  expect(rows()).toEqual([full[0], full[1], full[5]]);
  await key(`[data-account-row="${full[0]}"] [data-usage-grip]`, "ArrowDown");
  const expected = [full[1], full[0], ...full.slice(2)];
  expect(JSON.parse(localStorage.getItem("openmausbot.usageOrder.v1")!)).toEqual({ claude: expected, codex: ["codex"] });
  await remount();
  await click('[data-usage-engine="claude"] [data-accounts-cap]');
  expect(rows()).toEqual(expected);
});

it("returns focus to the account name after cancelling a rename", async () => {
  await mount();
  await click('[data-account-row="claude"] [data-edit-name]');
  await act(async () => q('[data-account-name-editor] input')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(q('[data-account-row="claude"] [data-edit-name]'));
});

it("refreshes through the existing refresh API, including Muse", async () => {
  h.instances.push({ ...h.instances[0], instanceId: "muse", driverKind: "museAgent" });
  await mount();
  await click("[data-usage-refresh]");
  expect(h.api).toHaveBeenCalledWith("/api/usage/refresh/muse", { method: "POST" });
  expect(h.api).toHaveBeenCalledWith("/api/usage/refresh/claude", { method: "POST" });
});

it.each(["en", "ko"] as const)("refreshes a displayed Gemini reading in %s", async (locale) => {
  persistPreference(locale);
  const instance = h.instances.find((each) => each.instanceId === "gemini")!;
  instance.driverKind = "antigravityAgent";
  const report = { observedAt: new Date(usageBoardNow).toISOString(), windows: [] };
  h.api.mockResolvedValue({ report });
  await mount();
  expect(q('[data-usage-engine="gemini"] [data-account-row="gemini"]')).not.toBeNull();
  await click("[data-usage-refresh]");
  expect(h.api).toHaveBeenCalledWith("/api/usage/refresh/gemini", { method: "POST" });
  expect(h.dispatch).toHaveBeenCalledWith({ type: "rateLimits", instanceId: "gemini", report, identity: instance.snapshot.account });
});

it.each(["unread", "signed out", "unsupported"])("skips manual Gemini refresh when %s", async (state) => {
  const instance = h.instances.find((each) => each.instanceId === "gemini")!;
  instance.driverKind = "antigravityAgent";
  if (state === "unread") h.board!.engines.find((each) => each.engine === "gemini")!.accounts[0]!.windows = [];
  if (state === "signed out") instance.snapshot.authenticated = false;
  if (state === "unsupported") instance.canRefreshUsage = false;
  await mount();
  await click("[data-usage-refresh]");
  expect(h.api).not.toHaveBeenCalledWith("/api/usage/refresh/gemini", { method: "POST" });
});

it("opens Settings on a chat bar click and preserves both Alt+U presses", async () => {
  const open = vi.fn();
  await mount(createElement(ChatPlanMeters, { instanceId: "claude", windows: [], now: usageBoardNow, onOpenUsage: open }));
  await click("[data-usage-meter]");
  expect(open).toHaveBeenCalledOnce();
  expect(document.querySelector("[data-usage-quick]")).toBeNull();
  const first = new Event("orbit:usage-key", { cancelable: true });
  await act(async () => { window.dispatchEvent(first); });
  expect(first.defaultPrevented).toBe(true);
  expect(document.querySelector("[data-usage-quick]")).not.toBeNull();
  const second = new Event("orbit:usage-key", { cancelable: true });
  await act(async () => { window.dispatchEvent(second); });
  expect(second.defaultPrevented).toBe(false);
  expect(document.querySelector("[data-usage-quick]")).toBeNull();
});

it("draws CSS chat bars without the desktop hover row or mini phone cells", async () => {
  await mount(createElement(ChatPlanMeters, { windows: [{ id: "five_hour", usedPercent: 20, resetsAt: usageBoardNow + 60_000 }], now: usageBoardNow, onOpenUsage: () => {} }));
  expect(q("[data-usage-meter]")!.className).not.toContain("hover:bg");
  expect(host.querySelectorAll("[data-cell]")).toHaveLength(10);
  const css = readFileSync(resolve("src/components/UsageDesk.css"), "utf8");
  expect(css).toContain("skewX(-12deg)");
  expect(css).toContain("--cell-w: 9px");
});


it("removes bot and worker counts and offers inline name editing", async () => {
  await mount();
  expect(q("[data-account-who], [data-bot-count]")).toBeNull();
  await click('[data-account-row="claude"] [data-edit-name]');
  expect(q('[data-account-row="claude"] [data-account-name-editor] input')).not.toBeNull();
  expect(q('[data-account-name-editor]')!.className).toContain("account-name-inline");
});
