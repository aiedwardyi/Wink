// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard } from "@/lib/usage-board";
import type { UsageBoardState } from "@/lib/usage-board-client";

const h = vi.hoisted(() => ({ state: null as unknown as UsageBoardState, layout: "B", reduce: true }));
vi.mock("@/lib/use-usage-board", () => ({ useUsageBoard: () => h.state }));
vi.mock("@/lib/use-visible-clock", () => ({ useVisibleClock: () => usageBoardNow }));
vi.mock("@/lib/use-phone-swipe", () => ({ useIsPhone: () => true }));
vi.mock("@/lib/phone-swipe", () => ({ reducedMotion: () => h.reduce }));
vi.mock("@/lib/skins", () => ({ useSkin: () => "github-dimmed", isTerminalSkin: () => false }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { instances: [] }, dispatch: vi.fn(), refreshInstances: vi.fn() }) }));
vi.mock("./usage-layout", async (original) => ({ ...await original<typeof import("./usage-layout")>(), get USAGE_LAYOUT() { return h.layout; } }));
vi.mock("@/lib/usage-board-client", async (original) => ({
  ...await original<typeof import("@/lib/usage-board-client")>(),
  requestMain: vi.fn((base: string, id: string) => { h.state.board!.engines.find((each) => each.base === base)!.mainId = id; }),
}));

import { I18nProvider, persistPreference } from "@/lib/i18n";
import { UsageDesk } from "./UsageDesk";
import { UsageQuickView } from "./UsageQuickView";

const KEY = "openmausbot.usageAccountsOpen.v1";
let root: Root;
let host: HTMLDivElement;
let board: UsageBoard;
const engine = (base = "claude") => board.engines.find((each) => each.base === base)!;
const section = (base = "claude") => host.querySelector(`[data-usage-engine="${base}"]`)!;
const rows = (base = "claude") => [...section(base).querySelectorAll("[data-account-row]")].map((each) => each.getAttribute("data-account-row"));
const button = (base = "claude") => section(base).querySelector<HTMLButtonElement>("[data-accounts-cap]");
const ids = (base = "claude") => engine(base).accounts.map((each) => each.id);
function accounts(count: number, base = "claude", main = 1) {
  const each = engine(base);
  const sample = each.accounts[0]!;
  each.accounts = Array.from({ length: count }, (_, i) => ({ ...sample, id: `${base}-${i + 1}`, number: i + 1, name: `${base} ${i + 1}`, main: i + 1 === main }));
  each.mainId = each.accounts[main - 1]!.id;
}
const render = async () => act(async () => { root.render(createElement(I18nProvider, null, createElement(UsageDesk))); });
const click = async (node: HTMLElement | null) => {
  expect(node).toBeTruthy();
  await act(async () => { node!.click(); });
};
async function reopen() {
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  persistPreference("en");
  h.layout = "B";
  h.reduce = true;
  board = structuredClone(usageBoardFixture);
  h.state = { board, status: "ready", pending: {}, failed: new Set() };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Usage account cap", () => {
  it.each([1, 3])("shows all %i accounts without a button", async (count) => {
    accounts(count);
    await render();
    expect(rows()).toEqual(ids());
    expect(button()).toBeNull();
  });

  it.each(["en", "ko"] as const)("opens four accounts and closes with counted %s labels", async (locale) => {
    persistPreference(locale);
    accounts(4);
    await render();
    expect(rows()).toEqual(ids().slice(0, 3));
    expect(button()?.textContent).toBe(locale === "ko" ? "1개 더 보기" : "Show 1 more");
    expect(button()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(button()!.getAttribute("aria-controls")!)).toBeTruthy();
    await click(button());
    expect(rows()).toEqual(ids());
    expect(button()?.textContent).toBe(locale === "ko" ? "접기" : "Show less");
    expect(button()?.getAttribute("aria-expanded")).toBe("true");
    expect(section().querySelector("[role=group]:not([data-engine-head])")?.lastElementChild?.contains(button())).toBe(true);
    await click(button());
    expect(rows()).toEqual(ids().slice(0, 3));
  });

  it("keeps Main at row six, preserves order after Use, and picks again only on close", async () => {
    accounts(8, "claude", 6);
    await render();
    const initial = [ids()[0], ids()[1], ids()[5]];
    expect(rows()).toEqual(initial);
    expect(button()?.textContent).toBe("Show 5 more");
    await click(section().querySelector<HTMLButtonElement>("[data-use]"));
    await render();
    expect(rows()).toEqual(initial);
    await click(button());
    expect(rows()).toEqual(ids());
    await click(section().querySelector<HTMLButtonElement>(`[data-account-row="${ids()[7]}"] [data-use]`));
    await render();
    expect(rows()).toEqual(ids());
    await click(button());
    expect(rows()).toEqual([ids()[0], ids()[1], ids()[7]]);
    await reopen();
    expect(rows()).toEqual([ids()[0], ids()[1], ids()[7]]);
  });

  it("remembers each engine across reopening and keeps another engine closed", async () => {
    accounts(8);
    accounts(8, "codex");
    await render();
    await click(button());
    await reopen();
    expect(rows()).toEqual(ids());
    expect(rows("codex")).toEqual(ids("codex").slice(0, 3));
    await click(button());
    await click(button("codex"));
    await reopen();
    expect(rows()).toEqual(ids().slice(0, 3));
    expect(rows("codex")).toEqual(ids("codex"));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ claude: false, codex: true });
  });

  it.each(["{", '{"claude":"open"}'])("ignores invalid saved state %s", async (saved) => {
    accounts(8);
    localStorage.setItem(KEY, saved);
    await render();
    expect(rows()).toEqual(ids().slice(0, 3));
  });

  it("keeps the toggle working when localStorage rejects writes", async () => {
    accounts(4);
    await render();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    await click(button());
    expect(rows()).toEqual(ids());
    await click(button());
    expect(rows()).toEqual(ids().slice(0, 3));
  });

  it("uses shared Fold motion and waits for an opening fold before closing", async () => {
    accounts(8, "claude", 6);
    h.reduce = false;
    await render();
    await click(button());
    const moving = section().querySelector<HTMLElement>('[data-fold="opening"]')!;
    expect(moving).toBeTruthy();
    let finish!: () => void;
    moving.getAnimations = () => [{ playState: "running", finished: new Promise<void>((resolve) => { finish = resolve; }) }] as unknown as Animation[];
    await click(button());
    expect(button()?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { finish(); });
    expect(button()?.getAttribute("aria-expanded")).toBe("false");
    expect(section().querySelector('[data-fold="closing"]')).toBeTruthy();
  });

  it("leaves layout A without a cap", async () => {
    accounts(8);
    h.layout = "A";
    await render();
    expect(button()).toBeNull();
    expect(section().querySelector('[aria-haspopup="menu"]')).toBeTruthy();
  });

  it("keeps all eight accounts in the quick view", async () => {
    accounts(8, "claude", 6);
    const anchor = document.createElement("button");
    host.append(anchor);
    anchor.getBoundingClientRect = () => ({ top: 700, left: 24, right: 300, bottom: 730, width: 276, height: 30, x: 24, y: 700, toJSON: () => ({}) });
    await act(async () => root.render(createElement(I18nProvider, null, createElement(UsageQuickView, {
      engine: engine(), account: engine().accounts[5]!, board, state: h.state, anchor: { current: anchor }, onClose: vi.fn(),
    }))));
    const quick = document.querySelector("[data-usage-quick]")!;
    expect([...quick.querySelectorAll("[data-account-row]")].map((each) => each.getAttribute("data-account-row"))).toEqual(ids());
    expect(quick.querySelector("[data-accounts-cap]")).toBeNull();
  });
});

describe("motion", () => {
  const quick = (closing: boolean) => {
    const anchor = document.createElement("button");
    host.append(anchor);
    anchor.getBoundingClientRect = () => ({ top: 700, left: 24, right: 300, bottom: 730, width: 276, height: 30, x: 24, y: 700, toJSON: () => ({}) });
    return act(async () => root.render(createElement(I18nProvider, null, createElement(UsageQuickView, {
      engine: engine(), account: engine().accounts[0]!, board, state: h.state, anchor: { current: anchor }, onClose: vi.fn(), closing,
    }))));
  };
  const scrim = () => document.querySelector<HTMLElement>('body > div[aria-hidden="true"].bg-black\\/45');

  it("fades the phone scrim in, and out with the view, taking no taps while it goes", async () => {
    await quick(false);
    expect(scrim()?.classList.contains("animate-fade-in")).toBe(true);
    expect(scrim()?.hasAttribute("data-closing")).toBe(false);
    await quick(true);
    for (const part of [scrim(), document.querySelector("[data-usage-quick]")]) {
      expect(part?.hasAttribute("data-closing")).toBe(true);
      expect(part?.hasAttribute("inert")).toBe(true);
    }
  });

  it("fades the desk in when the board arrives after loading, not when it is already there", async () => {
    const desk = () => host.querySelector("[data-usage-desk]")!;
    h.state = { board: null, status: "loading", pending: {}, failed: new Set() } as unknown as UsageBoardState;
    await render();
    expect(desk().classList.contains("animate-fade-in")).toBe(false);
    h.state = { board, status: "ready", pending: {}, failed: new Set() };
    await render();
    expect(desk().classList.contains("animate-fade-in")).toBe(true);
    await reopen();
    expect(desk().classList.contains("animate-fade-in")).toBe(false);
  });
});
