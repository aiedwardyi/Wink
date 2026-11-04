// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdentityCanary, scanForCanary, type IdentityCanary } from "@/lib/identity-canary";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard, UsageBoardAccount, UsageBoardEngine, UsageBoardSample } from "@/lib/usage-board";

const h = vi.hoisted(() => ({
  state: { bots: [] as unknown[], instances: [] as unknown[], terminalPanes: {} as Record<string, string[]> },
  api: (_path: string, _init?: RequestInit): Promise<unknown> => Promise.resolve({}),
  refreshInstances: async () => {},
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: (path: string, init?: RequestInit) => h.api(path, init),
  useStore: () => ({ state: h.state, dispatch: () => undefined, refreshInstances: () => h.refreshInstances() }),
}));

const clientModules = import.meta.glob("../lib/usage-board-client.ts");
const MIN = 60_000;
const CLAUDE_2 = "acct_00000000-0000-4000-8000-000000000002";
const CLAUDE_3 = "acct_00000000-0000-4000-8000-000000000003";
const CODEX_2 = "acct_00000000-0000-4000-8000-000000000012";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let canary: IdentityCanary;
let server: {
  board: UsageBoard;
  calls: string[];
  reply: ((cursor: string | null) => Promise<UsageBoard> | UsageBoard) | null;
  post: ((id: string) => Promise<unknown>) | null;
};
let host: HTMLDivElement;
let root: Root;
let i18n: typeof import("@/lib/i18n");

const fresh = (): UsageBoard => structuredClone(usageBoardFixture);
const engineOf = (board: UsageBoard, id: string) => board.engines.find((engine) => engine.engine === id)!;
const accountOf = (board: UsageBoard, id: string) => board.engines.flatMap((engine) => engine.accounts).find((account) => account.id === id)!;
const DRIVER: Record<string, string> = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", gemini: "antigravityAgent", muse: "museAgent" };

function instancesFor(board: UsageBoard) {
  return board.engines.flatMap((engine) => engine.accounts.map((account) => ({
    instanceId: account.id,
    driverKind: DRIVER[engine.engine],
    displayName: canary.address,
    accountOf: engine.base,
    accountState: "ready",
    accountMain: account.id === engine.mainId,
    snapshot: { state: "available", authenticated: true, account: canary.address },
    models: { default: "default", options: [] },
    capabilities: { rateLimits: true },
    canRefreshUsage: true,
  })));
}

function setMedia({ phone = false, coarse = phone, reduce = false }) {
  window.matchMedia = ((query: string) => ({
    matches: (phone && query.includes("max-width")) || (coarse && query.includes("pointer: coarse")) || (reduce && query.includes("reduce")),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const text = (node: Element | null | undefined) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const q = (selector: string) => host.querySelector(selector);
const row = (id: string) => q(`[data-account-row="${id}"]`);
const useButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>("button[data-use]") ?? null;
const checkRow = () => q("[data-main-check]")?.closest("[data-account-row]")?.getAttribute("data-account-row") ?? null;
const boardGets = () => server.calls.filter((call) => call.startsWith("GET /api/usage/board"));
const mainPosts = () => server.calls.filter((call) => call.startsWith("POST /api/accounts/"));
const heroName = () => text(q("[data-hero-name]"));
const heroLeft = () => text(q("[data-hero-left]"));
const verdict = () => text(q("[data-verdict]"));
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const click = async (node: Element | null | undefined) => {
  expect(node, "control to click").toBeTruthy();
  await act(async () => { (node as HTMLElement).click(); await vi.advanceTimersByTimeAsync(0); });
};
const tab = (engine: string) => q(`[role="tab"][data-engine="${engine}"]`);
const picker = () => q('[data-usage-hero] button[aria-haspopup="menu"]');
const menuItems = () => [...host.querySelectorAll('[role="menuitemradio"]')];
async function pick(name: string) {
  await click(picker());
  await click(menuItems().find((item) => text(item) === name));
}

async function client() {
  const load = clientModules["../lib/usage-board-client.ts"];
  expect(load, "usage board client module").toBeDefined();
  return await load!() as { usageBoardFrame: (revision: number) => void; usageBoardReconnected: () => void };
}

async function mount({ phone = false, coarse = phone, locale = "en" as "en" | "ko", reduce = false } = {}) {
  setMedia({ phone, coarse, reduce });
  i18n.persistPreference(locale);
  h.state.instances = instancesFor(server.board);
  const { UsageSection } = await import("./UsageSection");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(i18n.I18nProvider, null, createElement(UsageSection))));
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
  host.remove();
}
async function rerender() {
  const { UsageSection } = await import("./UsageSection");
  await act(async () => root.render(createElement(i18n.I18nProvider, null, createElement(UsageSection))));
  await settle();
}

beforeEach(async () => {
  vi.useFakeTimers({ now: usageBoardNow, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.resetModules();
  i18n = await import("@/lib/i18n");
  canary = makeIdentityCanary();
  server = { board: fresh(), calls: [], reply: null, post: null };
  h.state.terminalPanes = {};
  h.refreshInstances = async () => {};
  h.api = async (path, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    server.calls.push(`${method} ${path}`);
    if (path.startsWith("/api/usage/board")) {
      const cursor = new URL(path, "http://wink.invalid").searchParams.get("cursor");
      return structuredClone(await (server.reply ? server.reply(cursor) : server.board));
    }
    const main = /^\/api\/accounts\/([^/]+)\/default$/.exec(path);
    if (main) return server.post ? server.post(decodeURIComponent(main[1]!)) : {};
    if (path === "/api/accounts") return { accounts: [] };
    return {};
  };
});
afterEach(async () => {
  if (host?.isConnected) await unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
});

// Points every 5 minutes ending at `end`, used % climbing by `rate` per minute.
function trail(end: number, count: number, endUsed: number, rate: number, step = 5): UsageBoardSample[] {
  return Array.from({ length: count }, (_, i) => {
    const minute = end / MIN - (count - 1 - i) * step;
    return [minute, Math.round((endUsed - rate * (end / MIN - minute)) * 10) / 10, 10];
  });
}
function paceBoard(session: Partial<UsageBoardAccount["windows"][number]>, fine: UsageBoardSample[]): UsageBoard {
  const board = fresh();
  const claude = accountOf(board, "claude");
  claude.windows = [
    { id: "five_hour", kind: "session", usedPercent: 80, resetsAt: usageBoardNow + 50 * MIN, windowMinutes: 300, ...session },
    { id: "seven_day", kind: "week", usedPercent: 10, resetsAt: usageBoardNow + 3 * 1440 * MIN, windowMinutes: 10080 },
  ];
  claude.history = { fine, coarse: [] };
  engineOf(board, "claude").events = [];
  return board;
}

describe("Usage desk", () => {
  it.each([
    [false, "en"], [true, "en"], [false, "ko"], [true, "ko"],
  ] as const)("keeps account identities out of Usage (phone=%s, %s)", async (phone, locale) => {
    server.post = async () => { throw new Error(`409 ${canary.address} is busy`); };
    await mount({ phone, locale });
    const scans: string[] = [];
    const scan = (label: string) => {
      scans.push(label);
      expect(scanForCanary(canary), label).toEqual([]);
    };
    expect(picker(), "hero account selector").not.toBeNull();
    scan("closed");
    for (const node of host.querySelectorAll("button, [tabindex]")) {
      await act(async () => {
        node.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        (node as HTMLElement).focus();
        node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      });
    }
    scan("hover, focus and touch");
    await click(picker());
    expect(menuItems().map(text)).toEqual(["Claude 1", "Claude 2", "Studio"]);
    scan("open picker");
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    scan("closing picker");
    await click(q("button[data-details]"));
    scan("details fold");
    await click(useButton(CLAUDE_3));
    expect(q('[role="alert"]')).not.toBeNull();
    scan("error");
    expect(q('[data-usage-event="auto"]')).not.toBeNull();
    scan("receipts");
    expect(scans).toHaveLength(7);
  });

  it("names accounts from the board", async () => {
    const board = fresh();
    const claude = engineOf(board, "claude");
    claude.accounts = [claude.accounts[2]!, claude.accounts[0]!, claude.accounts[1]!];
    server.board = board;
    await mount();
    expect(text(row(CLAUDE_3)?.querySelector("[data-account-name]"))).toBe("Studio");
    expect(text(row(CLAUDE_3)?.querySelector("[data-tile]"))).toBe("3");
    expect(text(row(CLAUDE_2)?.querySelector("[data-account-name]"))).toBe("Claude 2");
    expect(text(row("claude")?.querySelector("[data-account-name]"))).toBe("Claude 1");
    await click(picker());
    expect(menuItems().map(text)).toEqual(["Studio", "Claude 1", "Claude 2"]);
    const all = text(host);
    expect(all).not.toContain("Account 1");
    expect(all).not.toContain(CLAUDE_3);
    expect(all).not.toContain(CLAUDE_2);
  });

  it("holds the check until the board confirms the new Main", async () => {
    const post = deferred<unknown>();
    server.post = () => post.promise;
    await mount();
    expect(checkRow()).toBe("claude");
    await click(useButton(CLAUDE_3));
    expect(text(row(CLAUDE_3))).toContain("Switching...");
    expect(checkRow()).toBe("claude");
    const early = fresh();
    early.revision = 43;
    server.board = early;
    (await client()).usageBoardFrame(43);
    await settle();
    expect(text(row(CLAUDE_3))).toContain("Switching...");
    const read = deferred<UsageBoard>();
    server.reply = () => read.promise;
    const before = boardGets().length;
    await act(async () => { post.resolve({}); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets().length).toBe(before + 1);
    expect(checkRow()).toBe("claude");
    expect(text(row(CLAUDE_3))).toContain("Switching...");
    const confirmed = fresh();
    confirmed.revision = 44;
    engineOf(confirmed, "claude").mainId = CLAUDE_3;
    for (const account of engineOf(confirmed, "claude").accounts) account.main = account.id === CLAUDE_3;
    engineOf(confirmed, "claude").events.push({ seq: 11, at: usageBoardNow, kind: "main", from: "claude", to: CLAUDE_3 });
    await act(async () => { read.resolve(confirmed); await vi.advanceTimersByTimeAsync(0); });
    expect(checkRow()).toBe(CLAUDE_3);
    expect(text(host)).not.toContain("Switching...");
    expect(text(q('[data-usage-event="main"]'))).toContain("Claude Main changed: Claude 1 -> Studio.");
  });

  it("sends one Main request per engine while one is pending", async () => {
    server.post = () => new Promise(() => {});
    await mount();
    await click(useButton(CLAUDE_3));
    await click(useButton(CLAUDE_3));
    await click(useButton(CLAUDE_2));
    expect(mainPosts()).toEqual([`POST /api/accounts/${encodeURIComponent(CLAUDE_3)}/default`]);
    await pick("Claude 2");
    expect(heroName()).toBe("Claude 2");
    await click(tab("codex"));
    await click(useButton(CODEX_2));
    expect(mainPosts()).toHaveLength(2);
    expect(mainPosts()[1]).toBe(`POST /api/accounts/${encodeURIComponent(CODEX_2)}/default`);
  });

  it.each(["500 Internal Server Error", "409 Conflict"])("keeps Main and shows a safe error when the save fails (%s)", async (status) => {
    server.post = async () => { throw new Error(`${status}: ${canary.address} raw provider text`); };
    await mount();
    await click(useButton(CLAUDE_3));
    const alert = q('[role="alert"]');
    expect(text(alert)).toBe(i18n.translate("en", "usage.desk.mainFailed" as never));
    expect(text(alert)).not.toContain("raw provider text");
    expect(checkRow()).toBe("claude");
    expect(text(host)).not.toContain("Switching...");
    expect(useButton(CLAUDE_3)?.disabled).toBe(false);
  });

  it.each([
    [false, "en"], [true, "en"], [false, "ko"], [true, "ko"],
  ] as const)("keeps the viewed account picked while Main saves (phone=%s, %s)", async (phone, locale) => {
    const post = deferred<unknown>();
    server.post = () => post.promise;
    await mount({ phone, locale });
    await click(useButton(CLAUDE_3));
    await pick("Claude 2");
    expect(heroName()).toBe("Claude 2");
    const confirmed = fresh();
    confirmed.revision = 43;
    engineOf(confirmed, "claude").mainId = CLAUDE_3;
    server.board = confirmed;
    await act(async () => { post.resolve({}); await vi.advanceTimersByTimeAsync(0); });
    expect(checkRow()).toBe(CLAUDE_3);
    expect(heroName()).toBe("Claude 2");
    expect(heroLeft()).toBe("0%");
  });

  it("drops a board reply whose revision is not higher (equal and out of order)", async () => {
    await mount();
    expect(heroLeft()).toBe("34%");
    const { usageBoardFrame } = await client();
    const reply = (revision: number, used: number) => {
      const board = fresh();
      board.revision = revision;
      accountOf(board, "claude").windows[0]!.usedPercent = used;
      return board;
    };
    server.board = reply(42, 90);
    await act(async () => { usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets()).toHaveLength(2);
    expect(heroLeft()).toBe("34%");
    server.board = reply(40, 95);
    await act(async () => { usageBoardFrame(44); await vi.advanceTimersByTimeAsync(0); });
    expect(heroLeft()).toBe("34%");
    server.board = reply(45, 50);
    await act(async () => { usageBoardFrame(45); await vi.advanceTimersByTimeAsync(0); });
    expect(heroLeft()).toBe("50%");
  });

  it("upserts a partial board and drops a removed account", async () => {
    await mount();
    const points = () => Number(q("[data-trace]")?.getAttribute("data-points"));
    const before = points();
    expect(before).toBeGreaterThan(0);
    const { usageBoardFrame } = await client();
    const partial = fresh();
    partial.revision = 43;
    partial.full = false;
    partial.cursor = "fixture-43";
    const claude = accountOf(partial, "claude");
    const last = usageBoardFixture.engines[0]!.accounts[0]!.history.fine.at(-1)![0];
    claude.history = { fine: [[last, 66, 41], [last + 5, 67, 41]], coarse: [] };
    claude.windows[0]!.usedPercent = 67;
    engineOf(partial, "claude").events = [{ seq: 11, at: usageBoardNow + 5 * MIN, kind: "moved", from: CLAUDE_2, to: CLAUDE_3, paneId: "pane-22", label: "MIRA-2" }];
    await act(async () => { vi.setSystemTime(usageBoardNow + 5 * MIN); });
    server.board = partial;
    await act(async () => { usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets().at(-1)).toBe("GET /api/usage/board?cursor=fixture-42");
    expect(points()).toBe(before + 1);
    expect(q('[data-usage-event="main"]')).not.toBeNull();
    expect(text(q('[data-usage-event="moved"]'))).toContain("MIRA-2");
    await pick("Studio");
    expect(heroName()).toBe("Studio");
    const full = fresh();
    full.revision = 44;
    engineOf(full, "claude").accounts.splice(2, 1);
    server.board = full;
    await act(async () => { usageBoardFrame(44); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets().at(-1)).toBe("GET /api/usage/board?cursor=fixture-43");
    expect(row(CLAUDE_3)).toBeNull();
    expect(heroName()).toBe("Claude 1");
  });

  it("refetches only on a higher frame, focus, reconnect or pane change", async () => {
    let revision = 42;
    server.reply = () => ({ ...fresh(), revision: revision, cursor: `fixture-${revision}` });
    await mount();
    expect(q("[data-usage-desk]")).not.toBeNull();
    expect(boardGets()).toEqual(["GET /api/usage/board"]);
    const { usageBoardFrame, usageBoardReconnected } = await client();
    await act(async () => { usageBoardFrame(42); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets()).toHaveLength(1);
    revision = 43;
    await act(async () => { usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets()).toEqual(["GET /api/usage/board", "GET /api/usage/board?cursor=fixture-42"]);
    const slow = deferred<UsageBoard>();
    server.reply = () => slow.promise;
    await act(async () => { usageBoardFrame(44); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { usageBoardFrame(45); usageBoardFrame(46); window.dispatchEvent(new Event("focus")); });
    expect(boardGets()).toHaveLength(3);
    server.reply = () => ({ ...fresh(), revision: 47, cursor: "fixture-47" });
    await act(async () => { slow.resolve({ ...fresh(), revision: 44, cursor: "fixture-44" }); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets()).toHaveLength(4);
    expect(boardGets()[3]).toBe("GET /api/usage/board?cursor=fixture-44");
    server.reply = () => ({ ...fresh(), revision: 48, cursor: "fixture-48" });
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets()).toHaveLength(5);
    await act(async () => { usageBoardReconnected(); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets()).toHaveLength(6);
    h.state.terminalPanes = { "bot-atlas": ["ATLAS-1", "ATLAS-3"] };
    await rerender();
    expect(boardGets()).toHaveLength(7);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * MIN / 60); });
    expect(boardGets()).toHaveLength(7);
    const store = readFileSync(new URL("../state/store.tsx", import.meta.url), "utf8");
    expect(store).toMatch(/case "usage\.board":\s*usageBoardFrame\(frame\.revision\)/);
    expect(store).toContain("usageBoardReconnected()");
  });

  it("paints Usage from cache while the board is 500 ms late", async () => {
    const late = () => new Promise<UsageBoard>((resolve) => setTimeout(() => resolve(fresh()), 500));
    server.reply = late;
    await mount();
    expect(q("[data-usage-desk]"), "shell paints before the board").not.toBeNull();
    expect(text(q("[data-empty-state]"))).toBe(i18n.translate("en", "usage.desk.loading" as never));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(heroLeft()).toBe("34%");
    await unmount();
    await mount();
    expect(heroLeft(), "cached board on the first frame").toBe("34%");
    expect(q("[data-empty-state]")).toBeNull();
  });

  it("forecasts only under the pace rules", async () => {
    const now = usageBoardNow;
    const cases: Array<[string, UsageBoard, string]> = [
      ["exactly 10 min before reset", paceBoard({ resetsAt: now + 50 * MIN }, trail(now, 13, 80, 0.5)), "Lasts to reset"],
      ["11 min before reset", paceBoard({ resetsAt: now + 51 * MIN }, trail(now, 13, 80, 0.5)), "Runs out ~3:40 PM"],
      ["9 min before reset", paceBoard({ resetsAt: now + 49 * MIN }, trail(now, 13, 80, 0.5)), "Lasts to reset"],
      ["first 20 min of a cycle", paceBoard({ resetsAt: now + 285 * MIN }, trail(now, 4, 80, 0.5)), "Learning pace"],
      ["under 3 points", paceBoard({ resetsAt: now + 120 * MIN }, trail(now, 2, 80, 0.5)), "Learning pace"],
      ["under 15 min", paceBoard({ resetsAt: now + 120 * MIN }, trail(now, 3, 80, 0.5)), "Learning pace"],
      ["newest over 5 min", paceBoard({ resetsAt: now + 120 * MIN }, trail(now - 6 * MIN, 13, 80, 0.5)), "No recent data"],
      ["newest at 5 min", paceBoard({ resetsAt: now + 120 * MIN }, trail(now - 5 * MIN, 13, 80, 0.1)), "Lasts to reset"],
      ["unknown reset", paceBoard({ resetsAt: null }, trail(now, 13, 80, 0.5)), "No recent data"],
      ["unknown duration", paceBoard({ windowMinutes: null }, trail(now, 13, 80, 0.5)), "No recent data"],
      ["gap", paceBoard({ resetsAt: now + 120 * MIN }, trail(now, 13, 80, 0.5).filter((_, i) => i < 3 || i > 7)), "No recent data"],
      ["future point", paceBoard({ resetsAt: now + 120 * MIN }, [...trail(now, 13, 80, 0.5), [now / MIN + 10, 81, 10]]), "No recent data"],
      ["past reset", paceBoard({ resetsAt: now - MIN }, trail(now, 13, 80, 0.5)), "Awaiting a fresh report"],
      ["zero burn", paceBoard({ resetsAt: now + 51 * MIN }, trail(now, 13, 80, 0)), "Lasts to reset"],
      ["missing history", paceBoard({ resetsAt: now + 51 * MIN }, trail(now, 13, 80, 0).map(([m, , w]) => [m, null, w])), "Learning pace"],
    ];
    for (const [name, board, expected] of cases) {
      server.board = board;
      await mount();
      expect(verdict(), name).toBe(expected);
      if (name === "past reset") expect(heroLeft(), name).not.toBe("100%");
      if (name === "11 min before reset") expect(q("[data-projection]"), name).not.toBeNull();
      if (expected !== "Runs out ~3:40 PM" && expected !== "Lasts to reset") expect(q("[data-projection]"), name).toBeNull();
      await unmount();
    }
  });

  it("says Weekly only only with complete coverage", async () => {
    await mount();
    await click(tab("codex"));
    expect(heroName()).toBe("Codex 1");
    expect(text(q('[data-reset="session"]'))).toContain("Weekly only");
    expect(text(tab("codex"))).toContain("7d 62%");
    await click(tab("claude"));
    await pick("Claude 2");
    expect(text(q('[data-reset="session"]'))).toContain("No data");
    expect(text(q('[data-reset="session"]'))).not.toContain("Weekly only");
  });

  it("shows unknown workers apart from none", async () => {
    const board = fresh();
    board.runs = "unknown";
    for (const account of engineOf(board, "claude").accounts) account.workers = null;
    server.board = board;
    await mount();
    expect(text(row("claude"))).toContain("Workers unknown");
    expect(text(row("claude"))).not.toMatch(/\b0 workers\b/);
    await unmount();
    server.board = fresh();
    await mount();
    expect(text(row("claude"))).toContain("3 workers");
    expect(text(row(CLAUDE_3))).not.toContain("Workers unknown");
    expect(text(row(CLAUDE_3))).not.toMatch(/\b0 workers\b/);
    expect(text(row("claude"))).toContain("Atlas, Mira");
  });

  it("keeps every reported window and Muse", async () => {
    const board = fresh();
    accountOf(board, "claude").windows.push({ id: "seven_day_opus", kind: "week", usedPercent: 75, resetsAt: usageBoardNow + 2 * 1440 * MIN, windowMinutes: 10080 });
    const muse: UsageBoardEngine = {
      engine: "muse", base: "muse", mainId: "muse", events: [],
      accounts: [{
        id: "muse", number: 1, nickname: null, name: "Muse", main: true, signIn: "ready", coverage: "unknown",
        windows: [
          { id: "five_hour", kind: "session", usedPercent: 100, resetsAt: usageBoardNow + 2 * 60 * MIN, windowMinutes: 300 },
          { id: "seven_day", kind: "week", usedPercent: 61, resetsAt: usageBoardNow + 4 * 1440 * MIN, windowMinutes: 10080 },
        ],
        observedAt: usageBoardNow - 2 * 60 * MIN, history: { fine: [], coarse: [] }, bots: [], workers: [],
      }],
    };
    board.engines.push(muse);
    server.board = board;
    await mount();
    await click(q("button[data-details]"));
    expect(text(q("[data-details-body]"))).toContain("Opus");
    expect(text(q("[data-details-body]"))).toContain("25% left");
    await click(tab("gemini"));
    await click(q("button[data-details]"));
    expect(text(q("[data-details-body]"))).toContain("24h");
    expect(text(q("[data-details-body]"))).toContain("82% left");
    await click(tab("muse"));
    expect(heroName()).toBe("Muse");
    expect(text(q("[data-usage-hero]"))).toContain("As of 2h ago");
    expect(q("[data-usage-hero]")?.hasAttribute("data-stale")).toBe(true);
    expect(text(q("[data-usage-hero]"))).toContain("Limit reached.");
    expect(server.calls.some((call) => call.includes("/api/usage/check/"))).toBe(false);
  });

  it("keeps the last good board after a failed read", async () => {
    await mount();
    expect(heroLeft()).toBe("34%");
    server.reply = async () => { throw new Error("Not found"); };
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(heroLeft()).toBe("34%");
    expect(text(q("[data-board-status]"))).toBe(i18n.translate("en", "usage.desk.stale" as never));
    await unmount();
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount();
    expect(text(q("[data-empty-state]"))).toBe(i18n.translate("en", "usage.desk.unavailable" as never));
    expect(q("[data-hero-left]")).toBeNull();
  });

  it("inspects another account without a Main request", async () => {
    await mount();
    await pick("Studio");
    expect(heroName()).toBe("Studio");
    expect(heroLeft()).toBe("40%");
    expect(mainPosts()).toEqual([]);
    expect(checkRow()).toBe("claude");
    expect(menuItems()).toHaveLength(0);
  });

  it("shows a fresh-worker receipt and keeps Main", async () => {
    await mount();
    expect(text(q('[data-usage-event="auto"]'))).toContain("Claude 2 ran out. New worker ATLAS-2 uses Claude 1.");
    expect(text(q('[data-usage-event="auto"]'))).not.toContain("Main stays");
    expect(text(q('[data-usage-event="main"]'))).toContain(
      "Claude Main changed: Claude 2 -> Claude 1. Replies already resolved keep their account. Still running on Claude 2: MIRA-2.");
    await unmount();
    const board = fresh();
    engineOf(board, "claude").events.push(
      { seq: 11, at: usageBoardNow - 10 * MIN, kind: "auto", from: "claude", to: CLAUDE_3, paneId: "pane-14", label: "ATLAS-3" },
      { seq: 12, at: usageBoardNow - 5 * MIN, kind: "moved", from: CLAUDE_2, to: CLAUDE_3, paneId: "pane-22", label: "MIRA-2" },
    );
    server.board = board;
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount();
    expect(text(q('[data-usage-event="auto"]'))).toContain("New worker ATLAS-3 uses Studio. Main stays Claude 1.");
    expect(text(q('[data-usage-event="auto"]'))).not.toContain("ran out");
    expect(text(q('[data-usage-event="moved"]'))).toContain("MIRA-2 resumed on Studio.");
    expect(text(q('[data-usage-event="moved"]'))).not.toContain("Main");
    expect(checkRow()).toBe("claude");
    await unmount();
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount({ locale: "ko" });
    expect(text(q('[data-usage-event="moved"]'))).toContain("MIRA-2");
    expect(text(q('[data-usage-event="moved"]'))).toContain("Studio에서");
  });

  it("omits Today vs normal without three comparable days", async () => {
    await mount();
    await click(tab("codex"));
    expect(q("[data-today-normal]")).not.toBeNull();
    await unmount();
    const board = fresh();
    const codex = accountOf(board, "codex");
    codex.history.coarse = codex.history.coarse.slice(-60);
    server.board = board;
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount();
    await click(tab("codex"));
    expect(q("[data-usage-desk]")).not.toBeNull();
    expect(q("[data-today-normal]")).toBeNull();
  });

  it("shows an account change at its own values and settles under reduced motion", async () => {
    await mount({ reduce: true });
    expect(heroLeft()).toBe("34%");
    await pick("Studio");
    expect(heroLeft()).toBe("40%");
    await pick("Claude 1");
    const update = fresh();
    update.revision = 43;
    accountOf(update, "claude").windows[0]!.usedPercent = 70;
    server.board = update;
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(heroLeft()).toBe("30%");
  });

  it.each(["en", "ko"] as const)("drops Refresh All, Used/Remaining and Alt+R in both languages (%s)", async (locale) => {
    await mount({ locale });
    expect(q("[data-usage-desk]")).not.toBeNull();
    const labels = [...host.querySelectorAll("button")].map((button) => `${text(button)}|${button.getAttribute("aria-label") ?? ""}`);
    for (const key of ["usage.limits.refreshAll", "usage.limits.countUp", "usage.limits.countDown"]) {
      expect(labels.some((label) => label.includes(i18n.translate(locale, key as never)))).toBe(false);
    }
    expect(host.querySelector('[aria-keyshortcuts="Alt+R"]')).toBeNull();
    const before = server.calls.length;
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", altKey: true, bubbles: true })); });
    expect(server.calls.slice(before).filter((call) => call.startsWith("POST /api/usage/"))).toEqual([]);
    const { en, ko } = await import("@/lib/i18n-catalog");
    for (const catalog of [en, ko]) {
      for (const key of ["shortcuts.usageRefresh", "usage.limits.refreshAll", "usage.limits.direction", "usage.limits.countUp", "usage.limits.countDown"]) {
        expect(key in catalog, key).toBe(false);
      }
    }
    const { KeyboardShortcuts } = await import("./KeyboardShortcuts");
    const shortcuts = document.createElement("div");
    const shortcutsRoot = createRoot(shortcuts);
    await act(async () => shortcutsRoot.render(createElement(i18n.I18nProvider, null, createElement(KeyboardShortcuts))));
    expect(text(shortcuts)).not.toContain(locale === "en" ? "Refresh Usage" : "사용량 새로 고침");
    expect(text(shortcuts)).toContain(locale === "en" ? "Toggle Usage" : "사용량 열기");
    await act(async () => shortcutsRoot.unmount());
  });

  it("fits Usage at 390 with eight accounts and long ko names", async () => {
    const board = fresh();
    const claude = engineOf(board, "claude");
    const extra = Array.from({ length: 5 }, (_, i): UsageBoardAccount => ({
      ...structuredClone(claude.accounts[2]!),
      id: `acct_00000000-0000-4000-8000-00000000010${i}`,
      number: 4 + i,
      nickname: `아주긴이름의작업용계정번호${i}입니다`,
      name: `아주긴이름의작업용계정번호${i}입니다`,
    }));
    claude.accounts.push(...extra);
    server.board = board;
    await mount({ phone: true, locale: "ko" });
    const rows = [...host.querySelectorAll("[data-account-row]")];
    expect(rows).toHaveLength(8);
    for (const node of rows) {
      const use = node.querySelector("button[data-use]");
      if (use) expect(use.className).toMatch(/\[@media\(pointer:coarse\)\]:min-h-11/);
      const names = node.querySelector("button[data-bot-count]");
      if (names) {
        expect(names.getAttribute("aria-expanded")).toBe("false");
        await click(names);
        expect(names.getAttribute("aria-expanded")).toBe("true");
        expect(mainPosts()).toEqual([]);
      }
    }
    for (const fact of host.querySelectorAll("[data-reset]")) expect(fact.className).not.toMatch(/\btruncate\b/);
    expect(text(q('[data-reset="session"]'))).toMatch(/후 초기화/);
    expect(q("[data-usage-desk]")?.className).toMatch(/min-w-0/);
  });
});
