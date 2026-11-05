// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
const CLAUDE_4 = "acct_00000000-0000-4000-8000-000000000004";
const CODEX_2 = "acct_00000000-0000-4000-8000-000000000012";
const UNUSED = { id: "five_hour", kind: "session", usedPercent: 0, resetsAt: null, windowMinutes: 300 } as const;
const GLYPHS = /[\u2580-\u25FF]/u;

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

function setMedia({ phone = false, coarse = phone, reduce = false }: { phone?: boolean; coarse?: boolean; reduce?: boolean }) {
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
const section = (engine: string) => q(`section[data-usage-engine="${engine}"]`);
const row = (id: string) => q(`[data-account-row="${id}"]`);
const useButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>("button[data-use]") ?? null;
const checkRow = (engine = "claude") => section(engine)?.querySelector("[data-main-check]")?.closest("[data-account-row]")?.getAttribute("data-account-row") ?? null;
const boardGets = () => server.calls.filter((call) => call.startsWith("GET /api/usage/board"));
const mainPosts = () => server.calls.filter((call) => call.startsWith("POST /api/accounts/"));
const heroName = (engine = "claude") => text(picker(engine)?.querySelector("[data-hero-name]"));
const left = (id: string, slot = "session") => text(row(id)?.querySelector(`[data-window="${slot}"] [data-left]`));
const who = (id: string) => [...row(id)?.querySelector("[data-account-who]")?.children ?? []].map((node) => text(node)).join(" ");
const slots = (id: string) => [...row(id)?.querySelector("[data-account-bars]")?.children ?? []].map((node) => node.getAttribute("aria-label")?.split(":")[0]);
const HIDDEN = '[data-usage-hero], [data-hero-left], [data-verdict], [data-projection], [data-usage-chart], [data-trace], [data-chart-fold], [data-today-normal], [data-details], [role="tablist"], [role="tab"], [data-usage-event]';
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const click = async (node: Element | null | undefined) => {
  expect(node, "control to click").toBeTruthy();
  await act(async () => { (node as HTMLElement).click(); await vi.advanceTimersByTimeAsync(0); });
};
const live = (node: Element) => !node.closest("[aria-hidden]");
const visible = (engine = "claude") => [...section(engine)?.querySelectorAll("[data-account-row]") ?? []].filter(live).map((node) => node.getAttribute("data-account-row") ?? "");
const viewed = (engine = "claude") => visible(engine).at(-1) ?? null;
const column = (name: string, engine = "claude") => section(engine)?.querySelector(`[data-account-column="${name}"]`) ?? null;
const arrows = (engine = "claude") => [...section(engine)?.firstElementChild?.querySelectorAll<HTMLButtonElement>("button") ?? []];
const picker = (engine = "claude") => [...section(engine)?.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]') ?? []].find(live) ?? null;
const said = (root: Element) => [root.textContent ?? "", ...[...root.querySelectorAll("*")].flatMap((node) => [...node.attributes].map((attribute) => attribute.value))].join("\n");
function unused(board: UsageBoard, ...ids: string[]) {
  for (const id of ids) {
    const account = accountOf(board, id);
    account.windows = [{ ...UNUSED }, ...account.windows.filter((window) => window.kind !== "session")];
  }
  return board;
}
function cellsOn(root: Element | null | undefined) {
  const bars = [...root?.querySelectorAll("[data-account-bars]") ?? []];
  expect(bars.length, "bars").toBeGreaterThan(0);
  return bars.flatMap((node) => {
    expect(node.textContent).not.toMatch(GLYPHS);
    return [...node.children].map((group) => {
      const label = group.getAttribute("aria-label") ?? "";
      const boxes = group.querySelectorAll("[data-cells]");
      expect(boxes, label).toHaveLength(1);
      const on = Number(boxes[0]!.getAttribute("data-cells"));
      expect([...boxes[0]!.children].map((cell) => cell.getAttribute("data-cell")), label).toEqual(Array.from({ length: 10 }, (_, i) => (i < on ? "on" : "off")));
      expect(boxes[0]!.textContent, label).toBe("");
      const left = group.querySelector("[data-left]");
      expect(on, label).toBe(left ? Math.round(parseInt(text(left), 10) / 10) : 0);
      return on;
    });
  });
}
const menuItems = () => [...host.querySelectorAll('[role="menuitemradio"]')];
const menuName = (item: Element) => text(item.querySelector("span:not([data-tile])"));
async function pick(name: string) {
  await click(picker());
  await click(menuItems().find((item) => menuName(item) === name));
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

async function client() {
  const load = clientModules["../lib/usage-board-client.ts"];
  expect(load, "usage board client module").toBeDefined();
  return await load!() as {
    usageBoardFrame: (revision: number) => void;
    usageBoardReconnected: () => void;
    usageBoardState: () => { board: UsageBoard | null };
  };
}

async function mount({ phone = false, coarse = phone, locale = "en", reduce = false, layout }: { phone?: boolean; coarse?: boolean; locale?: "en" | "ko"; reduce?: boolean; layout?: "A" | "B" } = {}) {
  setMedia({ phone, coarse, reduce });
  i18n.persistPreference(locale);
  h.state.instances = instancesFor(server.board);
  if (layout) vi.doMock("./usage-layout", () => ({ USAGE_LAYOUT: layout }));
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
// A new page load: no cached board, a fresh client.
async function reload() {
  if (host?.isConnected) await unmount();
  vi.resetModules();
  i18n = await import("@/lib/i18n");
  await warm();
}
// Load the store and client before a mount, as the running app has them.
async function warm() {
  await import("@/state/store");
  await clientModules["../lib/usage-board-client.ts"]?.();
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
  await warm();
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
  vi.doUnmock("./usage-layout");
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(picker(), "engine account selector").not.toBeNull();
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
    expect(menuItems().map(menuName)).toEqual(phone ? ["Claude 1", "Claude 2", "Studio"] : ["Claude 2", "Studio"]);
    scan("open picker");
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    scan("closing picker");
    await pick("Studio");
    scan("picked account");
    const counts = [...host.querySelectorAll("button[data-bot-count]")];
    expect(counts.length).toBeGreaterThan(0);
    for (const count of counts) await click(count);
    expect(counts.map((count) => count.getAttribute("aria-expanded"))).toEqual(counts.map(() => "true"));
    scan("bot names");
    await click(useButton(CLAUDE_3));
    expect(q('[role="alert"]')).not.toBeNull();
    scan("error");
    expect(q("[data-usage-event]")).toBeNull();
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
    expect(visible()).toEqual(["claude", CLAUDE_3]);
    expect(text(column("main")?.querySelector("[data-account-head]"))).toBe("1Claude 1");
    expect(text(column("main")?.querySelector("[data-main-check]"))).toBe("Main");
    await click(picker());
    expect(menuItems().map(menuName)).toEqual(["Studio", "Claude 2"]);
    expect(menuItems().map(text)).toEqual(["3Studio", "2Claude 2"]);
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
    await pick("Studio");
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
    expect(text(row(CLAUDE_3)?.querySelector("[data-main-check]"))).toBe("Main");
    expect(useButton("claude")).not.toBeNull();
    expect(q("[data-usage-event]")).toBeNull();
  });

  it("sends one Main request per engine while one is pending", async () => {
    server.post = () => new Promise(() => {});
    await mount();
    await pick("Studio");
    await click(useButton(CLAUDE_3));
    await click(useButton(CLAUDE_3));
    await pick("Claude 2");
    await click(useButton(CLAUDE_2));
    expect(mainPosts()).toEqual([`POST /api/accounts/${encodeURIComponent(CLAUDE_3)}/default`]);
    expect(heroName()).toBe("Claude 2");
    expect(mainPosts()).toHaveLength(1);
    expect(section("codex")?.contains(useButton(CODEX_2) ?? null)).toBe(true);
    await click(useButton(CODEX_2));
    expect(mainPosts()).toHaveLength(2);
    expect(mainPosts()[1]).toBe(`POST /api/accounts/${encodeURIComponent(CODEX_2)}/default`);
  });

  it.each(["500 Internal Server Error", "409 Conflict"])("keeps Main and shows a safe error when the save fails (%s)", async (status) => {
    server.post = async () => { throw new Error(`${status}: ${canary.address} raw provider text`); };
    await mount();
    await pick("Studio");
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
    await pick("Studio");
    await click(useButton(CLAUDE_3));
    await pick("Claude 2");
    expect(heroName()).toBe("Claude 2");
    const confirmed = fresh();
    confirmed.revision = 43;
    engineOf(confirmed, "claude").mainId = CLAUDE_3;
    server.board = confirmed;
    await act(async () => { post.resolve({}); await vi.advanceTimersByTimeAsync(0); });
    expect(checkRow()).toBe(CLAUDE_3);
    expect(heroName()).toBe(phone ? "Claude 2" : "Claude 1");
    expect(left(CLAUDE_2, "week")).toBe("0%");
  });

  it("drops a board reply whose revision is not higher (equal and out of order)", async () => {
    await mount();
    expect(left("claude")).toBe("34%");
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
    expect(left("claude")).toBe("34%");
    server.board = reply(40, 95);
    await act(async () => { usageBoardFrame(44); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("34%");
    server.board = reply(45, 50);
    await act(async () => { usageBoardFrame(45); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("50%");
  });

  it("upserts a partial board and drops a removed account", async () => {
    await mount();
    const { usageBoardFrame, usageBoardState } = await client();
    const shown = () => usageBoardState().board?.engines.find((engine) => engine.base === "claude");
    const fine = () => shown()?.accounts.find((account) => account.id === "claude")?.history.fine ?? [];
    const before = fine().length;
    expect(before).toBeGreaterThan(0);
    expect(left("claude")).toBe("34%");
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
    expect(fine().slice(-2)).toEqual([[last, 66, 41], [last + 5, 67, 41]]);
    expect(fine()).toHaveLength(Math.min(before + 1, 288));
    expect(shown()?.events.map((event) => event.kind)).toEqual(["limit", "auto", "main", "reset", "moved"]);
    expect(shown()?.events.at(-1)).toMatchObject({ kind: "moved", label: "MIRA-2" });
    expect(left("claude")).toBe("33%");
    expect(q("[data-usage-event]")).toBeNull();
    await pick("Studio");
    expect(heroName()).toBe("Studio");
    const full = fresh();
    full.revision = 44;
    engineOf(full, "claude").accounts.splice(2, 1);
    server.board = full;
    await act(async () => { usageBoardFrame(44); await vi.advanceTimersByTimeAsync(0); });
    expect(boardGets().at(-1)).toBe("GET /api/usage/board?cursor=fixture-43");
    expect(row(CLAUDE_3)).toBeNull();
    expect(visible()).toEqual(["claude", CLAUDE_2]);
    expect(picker()).toBeNull();
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
    const store = readFileSync(resolve(process.cwd(), "src/state/store.tsx"), "utf8");
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
    expect(left("claude")).toBe("34%");
    await unmount();
    await mount();
    expect(left("claude"), "cached board on the first frame").toBe("34%");
    expect(q("[data-empty-state]")).toBeNull();
  });

  it.each([false, true])("refreshes workers on cached reopen (another subscriber=%s)", async (retained) => {
    const { useUsageBoard } = await import("@/lib/use-usage-board");
    const meterHost = document.createElement("div");
    const meterRoot = createRoot(meterHost);
    function Meter() { useUsageBoard(); return null; }
    await mount();
    if (retained) await act(async () => meterRoot.render(createElement(Meter)));
    const before = text(row("claude"));
    expect(before).toContain("3 workers");
    await unmount();
    h.state.terminalPanes = { "bot-atlas": [] };
    accountOf(server.board, "claude").workers = [];
    const late = deferred<UsageBoard>();
    server.reply = () => late.promise;
    const reads = boardGets().length;
    try {
      if (retained) await act(async () => meterRoot.render(createElement(Meter)));
      await mount();
      expect(text(row("claude")), "cached workers paint first").toBe(before);
      expect(boardGets().length - reads, "one cached-open read").toBe(1);
      await act(async () => { late.resolve(server.board); await vi.advanceTimersByTimeAsync(0); });
      expect(text(row("claude"))).not.toContain("3 workers");
      expect(text(row("claude"))).not.toContain("Workers unknown");
      expect(boardGets().length - reads).toBe(1);
    } finally {
      await act(async () => meterRoot.unmount());
    }
  });

  it("fills both reset lines from an undurationed Codex report", async () => {
    const { createUsageBoard } = await import("../../server/usage-board");
    const { codexRateLimitWindows } = await import("../../server/drivers/rate-limits");
    const report = { observedAt: new Date(usageBoardNow).toISOString(), windows: codexRateLimitWindows({
      primary: { usedPercent: 24, resetsAt: (usageBoardNow + 60 * MIN) / 1000 },
      secondary: { usedPercent: 40, resetsAt: (usageBoardNow + 7 * 1440 * MIN) / 1000 },
    }) };
    const empty = () => ({ version: 1 as const, accounts: {}, events: {}, seq: 0, counter: 0 });
    const board = createUsageBoard({
      accounts: { list: () => [{ id: "codex", of: "codex", driverKind: "codex", generation: 0, existing: false, state: "ready" }], defaultFor: () => "codex", drains: {} },
      names: { get: () => null }, rateLimits: { get: () => report },
      history: { snapshot: empty, since: empty, record: vi.fn(), event: vi.fn(), purge: vi.fn() },
      runs: async () => ({ known: true, runs: [] }), bots: () => [], now: () => usageBoardNow,
    });
    server.board = await board.read();
    await mount();
    expect(row("codex")?.querySelector('[data-window="session"]')?.getAttribute("aria-label")).toBe("5h: 76% left, Resets in 1 hour");
    expect(row("codex")?.querySelector('[data-window="week"]')?.getAttribute("aria-label")).toBe("7d: 60% left, Resets in 7 days");
    expect(text(q('[data-reset="session"]'))).toBe("(1h)");
    expect(text(q('[data-reset="week"]'))).toBe("(7d)");
    expect(row("codex")?.querySelector("[data-window-empty]")).toBeNull();
    expect(text(row("codex"))).not.toContain("No data");
  });

  it("shows the 5h bar and no forecast under every pace case", async () => {
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
      await reload();
      server.board = board;
      await mount();
      expect(q("[data-verdict]"), name).toBeNull();
      expect(q("[data-projection]"), name).toBeNull();
      expect(text(host), name).not.toContain(expected);
      if (name === "past reset") {
        expect(left("claude"), name).toBe("");
        expect(row("claude")?.querySelector("[data-window-empty]")?.getAttribute("aria-label"), name).toBe("5h: Reset passed");
      } else expect(left("claude"), name).toBe("20%");
      expect(left("claude", "week"), name).toBe("90%");
      await unmount();
    }
  });

  it("says No data for a missing 5h whatever the coverage", async () => {
    await mount();
    expect(accountOf(server.board, "codex").coverage).toBe("complete");
    expect(row("codex")?.querySelector("[data-window-empty]")?.getAttribute("aria-label")).toBe("5h: No data");
    expect(left("codex", "week")).toBe("62%");
    expect(accountOf(server.board, CLAUDE_2).coverage).toBe("unknown");
    expect(row(CLAUDE_2)?.querySelector("[data-window-empty]")?.getAttribute("aria-label")).toBe("5h: No data");
    expect(text(host)).not.toContain("Weekly only");
  });

  it.each([
    [false, "en", "A"], [true, "en", "A"], [false, "ko", "A"], [true, "ko", "A"],
    [false, "en", "B"], [true, "en", "B"], [false, "ko", "B"], [true, "ko", "B"],
  ] as const)("shows Today's bars, 5h then 7d, for every account (phone=%s, %s, layout %s)", async (phone, locale, layout) => {
    await mount({ phone, locale, layout });
    const say = (key: Parameters<typeof i18n.translate>[1], vars?: Record<string, number>) => i18n.translate(locale, key, vars);
    const [h5, d7, noData] = [say("usage.limits.sessionShort"), say("usage.limits.weeklyShort"), say("usage.desk.noData")];
    const accounts = usageBoardFixture.engines.flatMap((engine) => engine.accounts.map((account) => ({ engine: engine.engine, account })));
    for (const { engine, account } of accounts) {
      const bars = row(account.id)?.querySelector("[data-account-bars]");
      expect(bars, `${account.name} bars`).toBeTruthy();
      expect(section(engine)?.contains(bars ?? null), `${account.name} under its engine`).toBe(true);
      expect(slots(account.id), account.name).toEqual(engine === "gemini" ? [say("usage.limits.compactH", { hours: 24 })] : [h5, d7]);
      if (locale === "en") expect(who(account.id), account.name).toMatch(/^\d+ bots? · /);
    }
    expect(host.querySelectorAll("[data-account-row]")).toHaveLength(accounts.length);
    const empties = [...host.querySelectorAll("[data-window-empty]")];
    expect(empties.map((node) => node.closest("[data-account-row]")?.getAttribute("data-account-row"))).toEqual([CLAUDE_2, "codex", "grok", "grok"]);
    expect(empties.map((node) => node.getAttribute("aria-label"))).toEqual([`${h5}: ${noData}`, `${h5}: ${noData}`, `${h5}: ${noData}`, `${d7}: ${noData}`]);
    const tree = (node: Element | undefined): string => node ? `${node.tagName}.${node.className}(${[...node.children].map(tree).join(",")})` : "";
    for (const node of empties) {
      expect(text(node)).toContain(noData);
      expect(tree(node)).toBe(tree(empties[0]));
    }
    expect(empties[1]?.outerHTML).toBe(empties[0]?.outerHTML);
    expect(empties[2]?.outerHTML).toBe(empties[0]?.outerHTML);
    const week = row(CLAUDE_2)?.querySelector('[data-window="week"]');
    expect(week?.querySelector("[data-cells]")?.getAttribute("data-cells")).toBe("0");
    expect(week?.querySelector("[data-cells]")?.className).toMatch(/\btext-danger\b/);
    expect(text(week?.querySelector("[data-left]"))).toBe("0%");
    expect(text(week?.querySelector('[data-reset="week"]'))).toBe(locale === "en" ? "(5d2h)" : "(5일 2시간)");
    expect(document.querySelector(HIDDEN)).toBeNull();
    expect(text(host)).not.toContain(say("usage.desk.quota"));
    const controls = [...host.querySelectorAll("[data-account-row] [data-main-check], [data-account-row] button[data-use]")];
    expect(controls).toHaveLength(accounts.length);
    for (const control of controls) {
      expect(control.className).toContain("w-[4.5rem]");
      expect(control.className).toMatch(/(^|\s)min-h-7(\s|$)/);
    }
    expect(host.querySelector("[data-account-row] svg.lucide-check")).toBeNull();
  });

  it("shows unknown workers apart from none", async () => {
    const board = fresh();
    board.runs = "unknown";
    for (const account of engineOf(board, "claude").accounts) account.workers = null;
    server.board = board;
    await mount();
    expect(who("claude")).toBe("2 bots · Workers unknown");
    expect(who(CLAUDE_3)).toBe("0 bots · Workers unknown");
    expect(who(CLAUDE_3)).not.toMatch(/\b0 workers\b/);
    await reload();
    server.board = fresh();
    await mount();
    expect(who("claude")).toBe("2 bots · 3 workers");
    expect(who(CLAUDE_3)).toBe("0 bots · 0 workers");
    expect(who(CLAUDE_3)).not.toContain("Workers unknown");
    expect(text(row("claude"))).not.toContain("Atlas, Mira");
    await click(row("claude")?.querySelector("button[data-bot-count]"));
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
    expect(slots("claude")).toEqual(["5h", "7d", "Opus 7d"]);
    const opus = row("claude")?.querySelector('[data-window="seven_day_opus"]');
    expect(opus?.getAttribute("aria-label")).toBe("Opus 7d: 25% left, Resets in 2 days");
    expect(text(opus?.querySelector("[data-left]"))).toBe("25%");
    expect(slots("gemini")).toEqual(["24h"]);
    expect(row("gemini")?.querySelector('[data-window="daily"]')?.getAttribute("aria-label")).toBe("24h: 82% left, Resets in 9 hours");
    expect(left("gemini", "daily")).toBe("82%");
    expect(q("[data-verdict]")).toBeNull();
    expect(text(host)).not.toContain("No history yet");
    expect(text(section("muse")?.querySelector("[data-engine-name]"))).toBe("Muse");
    expect(text(row("muse")?.querySelector("[data-account-name]"))).toBe("Muse");
    expect(slots("muse")).toEqual(["5h", "7d"]);
    expect(left("muse", "five_hour")).toBe("0%");
    expect(row("muse")?.querySelector('[data-window="five_hour"] [data-cells]')?.className).toMatch(/\btext-danger\b/);
    expect(left("muse", "seven_day")).toBe("39%");
    expect(text(host)).not.toContain("Last seen");
    expect(text(host)).not.toContain("Limit reached.");
    expect(q("[data-stale]")).toBeNull();
    expect(server.calls.some((call) => call.includes("/api/usage/check/"))).toBe(false);
  });

  it("keeps the last good board after a failed read", async () => {
    await mount();
    expect(left("claude")).toBe("34%");
    server.reply = async () => { throw new Error("Not found"); };
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("34%");
    expect(text(q("[data-board-status]"))).toBe(i18n.translate("en", "usage.desk.stale" as never));
    await unmount();
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount();
    expect(text(q("[data-empty-state]"))).toBe(i18n.translate("en", "usage.desk.unavailable" as never));
    expect(q("[data-account-row]")).toBeNull();
  });

  it("inspects another account without a Main request", async () => {
    await mount();
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const animated = vi.spyOn(Element.prototype, "animate");
    await pick("Studio");
    expect(heroName()).toBe("Studio");
    expect(viewed()).toBe(CLAUDE_3);
    expect(scrolled).not.toHaveBeenCalled();
    const moved = [...row(CLAUDE_3)?.children ?? []].filter((part) => !part.hasAttribute("data-account-head"));
    expect(moved.length).toBeGreaterThan(0);
    expect(animated.mock.contexts).toHaveLength(moved.length);
    expect(animated.mock.contexts.every((node, i) => node === moved[i])).toBe(true);
    expect(animated.mock.calls.map(([frames]) => (frames as Keyframe[])[0]?.transform)).toEqual(moved.map(() => "translateX(12px)"));
    expect(left(CLAUDE_3)).toBe("40%");
    expect(mainPosts()).toEqual([]);
    expect(checkRow()).toBe("claude");
    expect(menuItems()).toHaveLength(0);
  });

  it("keeps Main through fresh-worker and moved events and shows no receipt lines", async () => {
    await mount();
    expect(checkRow()).toBe("claude");
    expect(q("[data-usage-event]")).toBeNull();
    expect(text(host)).not.toContain("ran out");
    expect(text(host)).not.toContain("Main changed");
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
    expect(checkRow()).toBe("claude");
    expect(text(row("claude")?.querySelector("[data-main-check]"))).toBe("Main");
    expect(mainPosts()).toEqual([]);
    expect(q("[data-usage-event]")).toBeNull();
    expect(text(host)).not.toContain("New worker");
    expect(text(host)).not.toContain("resumed on");
    await unmount();
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount({ locale: "ko" });
    expect(checkRow()).toBe("claude");
    expect(q("[data-usage-event]")).toBeNull();
    expect(text(host)).not.toContain("Studio에서");
  });

  it("never shows Today vs normal, with or without three comparable days", async () => {
    await mount();
    expect(slots("codex")).toEqual(["5h", "7d"]);
    expect(q("[data-today-normal]")).toBeNull();
    expect(text(host)).not.toMatch(/× normal|than normal today|About normal today/);
    await unmount();
    const board = fresh();
    const codex = accountOf(board, "codex");
    codex.history.coarse = codex.history.coarse.slice(-60);
    server.board = board;
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount();
    expect(q("[data-usage-desk]")).not.toBeNull();
    expect(slots("codex")).toEqual(["5h", "7d"]);
    expect(q("[data-today-normal]")).toBeNull();
  });

  it("shows an account change at its own values and settles under reduced motion", async () => {
    await mount({ reduce: true });
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const animated = vi.spyOn(Element.prototype, "animate");
    expect(left("claude")).toBe("34%");
    await pick("Studio");
    expect(heroName()).toBe("Studio");
    expect(left(CLAUDE_3)).toBe("40%");
    expect(left("claude")).toBe("34%");
    await pick("Claude 2");
    expect(viewed()).toBe(CLAUDE_2);
    expect(scrolled).not.toHaveBeenCalled();
    expect(animated).not.toHaveBeenCalled();
    const update = fresh();
    update.revision = 43;
    accountOf(update, "claude").windows[0]!.usedPercent = 70;
    server.board = update;
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("30%");
    expect(row("claude")?.querySelector('[data-window="session"] [data-cells]')?.getAttribute("data-cells")).toBe("3");
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

  it.each(["A", "B"] as const)("fits Usage at 390 with eight accounts and long ko names (layout %s)", async (layout) => {
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
    await mount({ phone: true, locale: "ko", layout });
    const rows = [...section("claude")?.querySelectorAll("[data-account-row]") ?? []];
    expect(rows).toHaveLength(8);
    expect(rows[0]?.parentElement?.className).not.toMatch(/\bgrid-cols-2\b/);
    for (const node of rows) {
      const control = node.querySelector("button[data-use], [data-main-check]");
      expect(control?.className).toContain("w-[4.5rem]");
      expect(control?.className).toMatch(/\[@media\(pointer:coarse\)\]:after:-inset-y-2/);
      expect(node.querySelector("[data-account-head] button[data-use], [data-account-head] [data-main-check]"), "the name keeps its whole line").toBeNull();
      expect(control?.previousElementSibling?.hasAttribute("data-account-who"), "Main or Use ends the bots line").toBe(true);
      expect(node.querySelector("[data-account-name]")?.className).toMatch(/\bmin-w-0\b.*\btruncate\b/);
      const names = node.querySelector("button[data-bot-count]");
      if (names) {
        expect(names.getAttribute("aria-expanded")).toBe("false");
        await click(names);
        expect(names.getAttribute("aria-expanded")).toBe("true");
        expect(mainPosts()).toEqual([]);
      }
    }
    for (const fact of host.querySelectorAll("[data-reset]")) expect(fact.className).not.toMatch(/\btruncate\b/);
    expect(row("claude")?.querySelector('[data-window="session"]')?.getAttribute("aria-label")).toMatch(/후 초기화$/);
    expect(text(row("claude")?.querySelector('[data-reset="session"]'))).toBe("(40분)");
    expect(q("[data-usage-desk]")?.className).toMatch(/min-w-0/);
    expect(visible()).toEqual(layout === "A" ? ["claude"] : rows.map((node) => node.getAttribute("data-account-row")));
  });

  it.each([
    [false, "en"], [true, "en"], [false, "ko"], [true, "ko"],
  ] as const)("shows Main on the left and one other account on the right, or one row from Main on a phone (phone=%s, %s)", async (phone, locale) => {
    await mount({ phone, locale });
    const engines = ["claude", "codex", "grok", "gemini"];
    expect(engines.map((engine) => visible(engine))).toEqual(phone
      ? [["claude"], ["codex"], ["grok"], ["gemini"]]
      : [["claude", CLAUDE_2], ["codex", CODEX_2], ["grok"], ["gemini"]]);
    expect(engines.map((engine) => [arrows(engine).length, picker(engine) !== null])).toEqual(phone
      ? [[2, true], [2, true], [0, false], [0, false]]
      : [[2, true], [0, false], [0, false], [0, false]]);
    for (const engine of engines) {
      const grid = section(engine)?.children[1];
      expect(grid?.classList.contains("grid-cols-2"), engine).toBe(!phone);
      expect([...grid?.children ?? []].map((node) => node.getAttribute("data-account-column")), engine)
        .toEqual(phone ? ["pages"] : engine === "claude" || engine === "codex" ? ["main", "other"] : [null]);
    }
    expect(column("main", "claude")?.firstElementChild?.getAttribute("data-account-row") ?? null).toBe(phone ? null : "claude");
    const parts = (engine: string) => {
      const pages = column(phone ? "pages" : "other", engine);
      if (pages) expect(pages.classList.contains("grid"), engine).toBe(true);
      return [...pages?.children ?? []].map((part) => {
        const hidden = part.getAttribute("aria-hidden") === "true";
        expect([part.classList.contains("col-start-1"), part.classList.contains("row-start-1"), part.classList.contains("invisible"), part.hasAttribute("inert")], engine)
          .toEqual([true, true, hidden, hidden]);
        return `${hidden ? "hidden" : "shown"} ${part.querySelector("[data-account-row]")?.getAttribute("data-account-row")}`;
      });
    };
    expect(parts("claude")).toEqual(phone ? [`hidden ${CLAUDE_2}`, `hidden ${CLAUDE_3}`, "shown claude"] : [`hidden ${CLAUDE_3}`, `shown ${CLAUDE_2}`]);
    expect(parts("codex")).toEqual(phone ? [`hidden ${CODEX_2}`, "shown codex"] : [`shown ${CODEX_2}`]);
    expect(parts("grok")).toEqual(phone ? ["shown grok"] : []);
  });

  it.each([
    [false, "en"], [true, "en"], [false, "ko"], [true, "ko"],
  ] as const)("pages to the ends with the arrows, jumps with the list and asks for Main only on Use (phone=%s, %s)", async (phone, locale) => {
    const claude = engineOf(server.board, "claude");
    claude.accounts.push({ ...structuredClone(claude.accounts[1]!), id: CLAUDE_4, number: 4, name: "Claude 4" });
    server.post = () => new Promise(() => {});
    await mount({ phone, locale });
    const say = (key: Parameters<typeof i18n.translate>[1]) => i18n.translate(locale, key);
    const pages = phone ? ["claude", CLAUDE_2, CLAUDE_3, CLAUDE_4] : [CLAUDE_2, CLAUDE_3, CLAUDE_4];
    const ends = () => arrows().map((button) => button.disabled);
    const walk = async (side: 0 | 1, presses: number) => {
      const seen: (string | null)[] = [];
      for (let press = 0; press < presses; press += 1) {
        await click(arrows()[side]);
        seen.push(viewed());
      }
      return seen;
    };
    expect(arrows().map((button) => button.getAttribute("aria-label"))).toEqual([say("accounts.previous"), say("accounts.next")]);
    expect(viewed()).toBe(pages[0]);
    expect(ends()).toEqual([true, false]);
    expect(await walk(0, 1)).toEqual([pages[0]]);
    expect(await walk(1, pages.length)).toEqual([...pages.slice(1), pages.at(-1)]);
    expect(ends()).toEqual([false, true]);
    expect(await walk(0, pages.length)).toEqual([...pages.slice(0, -1).reverse(), pages[0]]);
    expect(ends()).toEqual([true, false]);
    await click(picker());
    expect(menuItems().map(text)).toEqual([...phone ? [`1Claude 1${say("accounts.main")}`] : [], "2Claude 2", "3Studio", "4Claude 4"]);
    await click(menuItems().at(-1));
    expect(viewed()).toBe(CLAUDE_4);
    expect(heroName()).toBe("Claude 4");
    expect(document.activeElement).toBe(picker());
    expect(ends()).toEqual([false, true]);
    await pick(phone ? "Claude 1" : "Claude 2");
    expect(viewed()).toBe(pages[0]);
    expect(ends()).toEqual([true, false]);
    expect(mainPosts()).toEqual([]);
    expect(checkRow()).toBe("claude");
    await pick("Studio");
    await click(useButton(CLAUDE_3));
    expect(mainPosts()).toEqual([`POST /api/accounts/${encodeURIComponent(CLAUDE_3)}/default`]);
  });

  it.each([false, true])("keeps each engine's pick to itself (phone=%s)", async (phone) => {
    await mount({ phone });
    const codex = section("codex")?.innerHTML;
    await pick("Studio");
    expect(viewed()).toBe(CLAUDE_3);
    expect(section("codex")?.innerHTML).toBe(codex);
    expect(viewed("codex")).toBe(phone ? "codex" : CODEX_2);
    if (phone) {
      const claude = section("claude")?.innerHTML;
      await click(arrows("codex")[1]);
      expect(viewed("codex")).toBe(CODEX_2);
      expect(section("claude")?.innerHTML).toBe(claude);
    }
    expect(viewed()).toBe(CLAUDE_3);
    expect(mainPosts()).toEqual([]);
  });

  it.each([
    ["A", false], ["A", true], ["B", false], ["B", true],
  ] as const)("names every shown row beside its tile, Codex 2 too (layout %s, phone=%s)", async (layout, phone) => {
    await mount({ phone, layout });
    const named = () => [...host.querySelectorAll("[data-account-row]")].filter(live).map((node) => {
      const id = node.getAttribute("data-account-row") ?? "";
      const tiles = node.querySelectorAll("[data-tile]");
      expect(tiles, id).toHaveLength(1);
      const next = tiles[0]?.nextElementSibling;
      const name = next?.matches("[data-account-name]") ? next : next?.querySelector("[data-account-name]");
      expect(text(name), id).not.toBe("");
      return `${text(tiles[0])} ${text(name)}`;
    });
    expect(named()).toEqual(layout === "B" ? ["1 Claude 1", "2 Claude 2", "3 Studio", "1 Codex 1", "2 Codex 2", "1 Grok", "1 Gemini"]
      : phone ? ["1 Claude 1", "1 Codex 1", "1 Grok", "1 Gemini"] : ["1 Claude 1", "2 Claude 2", "1 Codex 1", "2 Codex 2", "1 Grok", "1 Gemini"]);
    if (layout === "A" && phone) {
      await click(arrows("codex")[1]);
      expect(named()).toEqual(["1 Claude 1", "2 Codex 2", "1 Grok", "1 Gemini"]);
    }
    expect(visible("codex")).toContain(CODEX_2);
    expect(text(row(CODEX_2)?.querySelector("[data-account-name]"))).toBe("Codex 2");
    if (layout === "A") expect(column(phone ? "pages" : "other", "codex")?.contains(row(CODEX_2))).toBe(true);
    else expect(host.querySelector("[aria-hidden] [data-account-row], [data-account-column]")).toBeNull();
  });

  it.each([
    ["A", false, "en"], ["A", true, "en"], ["A", false, "ko"], ["A", true, "ko"],
    ["B", false, "en"], ["B", true, "en"], ["B", false, "ko"], ["B", true, "ko"],
  ] as const)("reads an unused window the same on Main and other accounts, with no title or not-reported words (layout %s, phone=%s, %s)", async (layout, phone, locale) => {
    server.board = unused(fresh(), "claude", CLAUDE_2);
    await mount({ phone, locale, layout });
    const say = (key: Parameters<typeof i18n.translate>[1], vars?: Record<string, number>) => i18n.translate(locale, key, vars);
    const label = `${say("usage.limits.sessionShort")}: ${say("usage.desk.windowLeft", { percent: 100 })}`;
    const bars = ["claude", CLAUDE_2].map((id) => row(id)?.querySelector('[data-window="session"]'));
    expect(bars.map((node) => node?.getAttribute("aria-label"))).toEqual([label, label]);
    expect(bars.map((node) => text(node?.querySelector("[data-left]")))).toEqual(["100%", "100%"]);
    expect(bars.map((node) => node?.querySelector("[data-reset]") ?? null)).toEqual([null, null]);
    expect(bars[1]?.outerHTML).toBe(bars[0]?.outerHTML);
    expect(host.querySelectorAll("[data-account-bars][title], [data-account-bars] [title]")).toHaveLength(0);
    expect(said(host)).not.toContain(say("usage.limits.resetUnknown"));
    expect(said(host)).not.toMatch(/not reported|보고되지/);
  });

  it.each([
    ["A", false], ["A", true], ["B", false], ["B", true],
  ] as const)("draws every bar as ten boxes, filled ones first, with no glyphs (layout %s, phone=%s)", async (layout, phone) => {
    server.board = unused(fresh(), "grok");
    await mount({ phone, layout });
    const on = cellsOn(host);
    expect(on).toHaveLength(13);
    expect([Math.min(...on), Math.max(...on)]).toEqual([0, 10]);
    expect(said(host)).not.toMatch(GLYPHS);
  });

  it.each([false, true])("labels the account arrows in Korean (phone=%s)", async (phone) => {
    await mount({ phone, locale: "ko" });
    expect(["claude", "codex", "grok", "gemini"].map((engine) => arrows(engine).map((button) => button.getAttribute("aria-label"))))
      .toEqual([["이전 계정", "다음 계정"], phone ? ["이전 계정", "다음 계정"] : [], [], []]);
    expect(arrows().map((button) => text(button))).toEqual(["", ""]);
    expect(picker()?.getAttribute("aria-label")).toBe(`계정 선택: ${phone ? "Claude 1" : "Claude 2"}`);
    expect(said(host)).not.toMatch(/Previous Account|Next Account|Choose account/);
  });
});
