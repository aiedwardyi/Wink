// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdentityCanary, scanForCanary, type IdentityCanary } from "@/lib/identity-canary";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard, UsageBoardAccount, UsageBoardEngine, UsageBoardSample } from "@/lib/usage-board";
import { MOTION_LARGE_MS } from "@/lib/motion";

const h = vi.hoisted(() => ({
  state: { bots: [] as unknown[], instances: [] as unknown[], terminalPanes: {} as Record<string, string[]> },
  api: (_path: string, _init?: RequestInit): Promise<unknown> => Promise.resolve({}),
  refreshInstances: async () => {},
  dispatched: [] as unknown[],
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: (path: string, init?: RequestInit) => h.api(path, init),
  useStore: () => ({ state: h.state, dispatch: (action: unknown) => { h.dispatched.push(action); }, refreshInstances: () => h.refreshInstances() }),
}));

const clientModules = import.meta.glob("../lib/usage-board-client.ts");
const MIN = 60_000;
const CLAUDE_2 = "acct_00000000-0000-4000-8000-000000000002";
const CLAUDE_3 = "acct_00000000-0000-4000-8000-000000000003";
const CLAUDE_4 = "acct_00000000-0000-4000-8000-000000000004";
const CODEX_2 = "acct_00000000-0000-4000-8000-000000000012";
const UNUSED = { id: "five_hour", kind: "session", usedPercent: 0, resetsAt: null, windowMinutes: 300 } as const;
const GLYPHS = /[\u2580-\u25FF]/u;
const FOLDS = "openmausbot.usageFolds.v1";
const BOARD = "omb-usage-board-v1";
const BOX = ["h-[22px]", "min-w-12", "shrink-0", "border", "px-2", "text-[11px]", "rounded-md"];

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

const text = (node: Element | null | undefined) => {
  const clone = node?.cloneNode(true) as Element | undefined;
  clone?.querySelectorAll(".usage-reset-short").forEach((el) => el.remove());
  return (clone?.textContent ?? "").replace(/\s+/g, " ").trim();
};
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
const arrows = (engine = "claude") => [...section(engine)?.firstElementChild?.querySelectorAll<HTMLButtonElement>("button:not([data-engine-fold])") ?? []];
const picker = (engine = "claude") => [...section(engine)?.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]') ?? []].find(live) ?? null;
const fold = (engine = "claude") => section(engine)?.querySelector<HTMLButtonElement>("button[data-engine-fold]") ?? null;
// The phrases sit apart by a CSS gap, not a space, so join them as they read.
const summary = (engine = "claude") => {
  const node = section(engine)?.querySelector("[data-engine-summary]");
  const windows = [...node?.querySelectorAll("[data-window]") ?? []];
  return windows.length ? windows.map((window) => `${text(window.firstElementChild)} ${text(window.querySelector("[data-left]"))}`).join(" · ") : text(node);
};
const boxOf = (node: Element | null | undefined) => BOX.filter((name) => node?.classList.contains(name));
const tones = (meter: Element | null | undefined) => [...meter?.querySelectorAll("[data-cell]") ?? []].map((cell) => cell.getAttribute("data-cell") === "on" ? [...cell.parentElement!.classList].find((name) => name.startsWith("text-")) : "off");
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
      expect(on, label).toBe(left ? Math.max(parseInt(text(left), 10) > 0 ? 1 : 0, Math.round(parseInt(text(left), 10) / 10)) : 0);
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
  if (layout) vi.doMock("./usage-layout", async (original) => ({ ...await original<typeof import("./usage-layout")>(), USAGE_LAYOUT: layout }));
  const { UsageSection } = await import("./UsageSection");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(i18n.I18nProvider, null, createElement(UsageSection))));
  await settle();
}
it.each(["en", "ko"] as const)("marks a promo account in Usage: %s", async (locale) => {
  Object.assign(accountOf(server.board, "codex"), { codexPromo: true });
  await mount({ locale });
  const row = host.querySelector('[data-account-row="codex"]');
  expect(row?.textContent).toContain(locale === "en" ? "Unavailable for Codex: API credit promo" : "Codex 사용 불가: API 크레딧 프로모션");
  expect(row?.querySelector("button[data-use], [data-main-check]")).toBeNull();
});

async function unmount() {
  await act(async () => root.unmount());
  host.remove();
}
// A new page load: no cached board, a fresh client.
async function reload() {
  if (host?.isConnected) await unmount();
  localStorage.removeItem(BOARD);
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
  localStorage.removeItem(BOARD);
  vi.resetModules();
  i18n = await import("@/lib/i18n");
  await warm();
  canary = makeIdentityCanary();
  server = { board: fresh(), calls: [], reply: null, post: null };
  h.state.terminalPanes = {};
  h.refreshInstances = async () => {};
  h.dispatched = [];
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
  localStorage.removeItem(FOLDS);
  vi.doUnmock("./usage-layout");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["en", "ko"] as const)("omits the OpenAI credit row from Usage in %s", async (locale) => {
  const codex = engineOf(server.board, "codex");
  codex.accounts.push({ ...codex.accounts[0]!, id: "codex-credit", name: "OpenAI credit", number: 3,
    main: false, credit: true, windows: [], bots: [], workers: [] });
  await mount({ locale });
  expect(row("codex-credit")).toBeNull();
  expect(host.textContent).not.toContain("OpenAI credit");
  expect(row("codex")).not.toBeNull();
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
    [false, "en", "A"], [true, "en", "A"], [false, "ko", "A"], [true, "ko", "A"],
    [false, "en", "B"], [true, "en", "B"], [false, "ko", "B"], [true, "ko", "B"],
  ] as const)("keeps account identities out of Usage (phone=%s, %s, layout %s)", async (phone, locale, layout) => {
    server.post = async () => { throw new Error(`409 ${canary.address} is busy`); };
    await mount({ phone, locale, layout });
    const scans: string[] = [];
    const scan = (label: string) => {
      scans.push(label);
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[data-account-email]").forEach((el) => { el.textContent = ""; });
      expect(scanForCanary(canary, clone), label).toEqual([]);
    };
    expect(picker() !== null, "engine account selector").toBe(layout === "A");
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
    if (layout === "A") {
      await click(picker());
      expect(menuItems().map(menuName)).toEqual(phone ? ["Claude 1", "Claude 2", "Studio"] : ["Claude 2", "Studio"]);
      scan("open picker");
      await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      scan("closing picker");
      await pick("Studio");
      scan("picked account");
    }
    const counts = [...host.querySelectorAll("button[data-bot-count]")];
    expect(counts).toHaveLength(0);
    for (const count of counts) await click(count);
    expect(counts.map((count) => count.getAttribute("aria-expanded"))).toEqual(counts.map(() => "true"));
    scan("bot names");
    await click(useButton(CLAUDE_3));
    expect(q('[role="alert"]')).not.toBeNull();
    scan("error");
    const folds = [...host.querySelectorAll("button[data-engine-fold]")];
    expect(folds).toHaveLength(4);
    for (const node of folds) await click(node);
    await act(async () => { await vi.advanceTimersByTimeAsync(MOTION_LARGE_MS); });
    expect(host.querySelectorAll("[data-engine-summary]")).toHaveLength(4);
    expect(q("[data-account-row]")).toBeNull();
    scan("every engine folded");
    for (const node of folds) await click(node);
    expect(q("[data-engine-summary]")).toBeNull();
    expect(q("[data-account-row]")).not.toBeNull();
    scan("every engine open again");
    expect(q("[data-usage-event]")).toBeNull();
    expect(scans).toHaveLength(layout === "A" ? 9 : 6);
  });

  it("names accounts from the board", async () => {
    const board = fresh();
    const claude = engineOf(board, "claude");
    claude.accounts = [claude.accounts[2]!, claude.accounts[0]!, claude.accounts[1]!];
    server.board = board;
    await mount({ layout: "A" });
    expect(text(row(CLAUDE_3)?.querySelector("[data-account-name]"))).toBe("Studio");
    expect(text(row(CLAUDE_2)?.querySelector("[data-account-name]"))).toBe("Claude 2");
    expect(text(row("claude")?.querySelector("[data-account-name]"))).toBe("Claude 1");
    expect(visible()).toEqual(["claude", CLAUDE_3]);
    expect(text(column("main")?.querySelector("[data-account-head] [data-account-name]"))).toBe("Claude 1");
    expect(text(column("main")?.querySelector("[data-main-check]"))).toBe("Main");
    await click(picker());
    expect(menuItems().map(menuName)).toEqual(["Studio", "Claude 2"]);
    expect(menuItems().map(text)).toEqual(["Studio", "Claude 2"]);
    expect(host.querySelector("[data-tile]")).toBeNull();
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
    expect(text(row(CLAUDE_3)?.querySelector("[data-main-check]"))).toBe("Main");
    expect(useButton("claude")).not.toBeNull();
    expect(q("[data-usage-event]")).toBeNull();
  });

  it("sends one Main request per engine while one is pending", async () => {
    server.post = () => new Promise(() => {});
    await mount();
    await click(useButton(CLAUDE_3));
    await click(useButton(CLAUDE_3));
    await click(useButton(CLAUDE_2));
    expect(mainPosts()).toEqual([`POST /api/accounts/${encodeURIComponent(CLAUDE_3)}/default`]);
    expect(mainPosts()).toHaveLength(1);
    expect(section("codex")?.contains(useButton(CODEX_2) ?? null)).toBe(true);
    await click(useButton(CODEX_2));
    expect(mainPosts()).toHaveLength(2);
    expect(mainPosts()[1]).toBe(`POST /api/accounts/${encodeURIComponent(CODEX_2)}/default`);
  });

  it.each([["main-model", "usage.desk.mainModel"], ["main-effort", "usage.desk.mainEffort"], ["main-unavailable", "usage.desk.mainUnavailable"]])("says why the save was refused (%s)", async (code, key) => {
    server.post = async () => { throw Object.assign(new Error("raw server text"), { code, bot: "Atlas" }); };
    await mount();
    await click(useButton(CLAUDE_3));
    expect(text(q('[role="alert"]'))).toBe(i18n.translate("en", key as never, { bot: "Atlas" }));
    expect(checkRow()).toBe("claude");
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
    await mount({ phone, locale, layout: "A" });
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
    expect(left(CLAUDE_2, "week")).toBe(i18n.translate(locale, "usage.desk.windowLeft", { percent: 0 }));
  });

  it("drops a board reply whose revision is not higher (equal and out of order)", async () => {
    await mount();
    expect(left("claude")).toBe("34% left");
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
    expect(left("claude")).toBe("34% left");
    server.board = reply(40, 95);
    await act(async () => { usageBoardFrame(44); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("34% left");
    server.board = reply(45, 50);
    await act(async () => { usageBoardFrame(45); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("50% left");
  });

  it("upserts a partial board and drops a removed account", async () => {
    await mount({ layout: "A" });
    const { usageBoardFrame, usageBoardState } = await client();
    const shown = () => usageBoardState().board?.engines.find((engine) => engine.base === "claude");
    const fine = () => shown()?.accounts.find((account) => account.id === "claude")?.history.fine ?? [];
    const before = fine().length;
    expect(before).toBeGreaterThan(0);
    expect(left("claude")).toBe("34% left");
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
    expect(left("claude")).toBe("33% left");
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
    expect(left("claude")).toBe("34% left");
    await unmount();
    await mount();
    expect(left("claude"), "cached board on the first frame").toBe("34% left");
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
    expect(before).not.toContain("workers");
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
      names: { get: () => null }, rateLimits: { get: () => report, delete: vi.fn() },
      history: { snapshot: empty, since: empty, record: vi.fn(), event: vi.fn(), purge: vi.fn() },
      runs: async () => ({ known: true, runs: [] }), bots: () => [], now: () => usageBoardNow,
    });
    server.board = await board.read();
    await mount();
    expect(row("codex")?.querySelector('[data-window="session"]')?.getAttribute("aria-label")).toBe("5h: 76% left, Resets in 1 hour");
    expect(row("codex")?.querySelector('[data-window="week"]')?.getAttribute("aria-label")).toBe("7d: 60% left, Resets in 7 days");
    expect(text(q('[data-reset="session"]'))).toBe("resets in 1h");
    expect(text(q('[data-reset="week"]'))).toBe("resets in 7d");
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
        expect(row("claude")?.querySelector('[data-window="session"]')?.getAttribute("aria-label"), name).toBe("5h: Reset passed");
        expect(text(row("claude")?.querySelector('[data-reset="session"]')), name).toBe("Reset passed");
      } else expect(left("claude"), name).toBe("20% left");
      expect(left("claude", "week"), name).toBe("90% left");
      await unmount();
    }
  });

  it.each(["en", "ko"] as const)("shows one meter for an account that reports one window, with no empty row, whatever the coverage (%s)", async (locale) => {
    await mount({ locale });
    const say = (key: Parameters<typeof i18n.translate>[1], vars?: Record<string, number>) => i18n.translate(locale, key, vars);
    expect(accountOf(server.board, "codex").coverage).toBe("complete");
    expect(accountOf(server.board, CLAUDE_2).coverage).toBe("unknown");
    for (const [id, label] of [["codex", say("usage.limits.weeklyShort")], [CLAUDE_2, say("usage.limits.weeklyShort")]] as const) {
      expect(slots(id), id).toEqual([label]);
      expect(row(id)?.querySelectorAll('[role="group"][data-window]'), id).toHaveLength(1);
      expect(row(id)?.querySelector("[data-window-empty]"), id).toBeNull();
    }
    expect(left("codex", "week")).toBe(say("usage.desk.windowLeft", { percent: 62 }));
    expect(text(host)).not.toContain(say("usage.desk.noData"));
    expect(text(host)).not.toContain(say("usage.desk.weeklyOnly"));
  });

  it.each([
    [false, "en", "A"], [true, "en", "A"], [false, "ko", "A"], [true, "ko", "A"],
    [false, "en", "B"], [true, "en", "B"], [false, "ko", "B"], [true, "ko", "B"],
  ] as const)("shows Today's bars, 5h then 7d, for every account (phone=%s, %s, layout %s)", async (phone, locale, layout) => {
    await mount({ phone, locale, layout });
    const say = (key: Parameters<typeof i18n.translate>[1], vars?: Record<string, number>) => i18n.translate(locale, key, vars);
    const [h5, d7, noData] = [say("usage.limits.sessionShort"), say("usage.limits.weeklyShort"), say("usage.desk.noData")];
    const reported: Record<string, string[]> = {
      claude: [h5, d7], [CLAUDE_2]: [d7], [CLAUDE_3]: [h5, d7], codex: [d7], [CODEX_2]: [h5, d7], grok: [], gemini: [say("usage.limits.compactH", { hours: 24 })],
    };
    const accounts = usageBoardFixture.engines.flatMap((engine) => engine.accounts.map((account) => ({ engine: engine.engine, account })));
    for (const { engine, account } of accounts) {
      const bars = row(account.id)?.querySelector("[data-account-bars], [data-window-empty]");
      expect(bars, `${account.name} bars`).toBeTruthy();
      expect(section(engine)?.contains(bars ?? null), `${account.name} under its engine`).toBe(true);
      expect(slots(account.id), account.name).toEqual(reported[account.id]);
      expect(who(account.id), account.name).toBe("");
    }
    expect(host.querySelectorAll("[data-account-row]")).toHaveLength(accounts.length);
    const empties = [...host.querySelectorAll("[data-window-empty]")];
    expect(empties.map((node) => node.closest("[data-account-row]")?.getAttribute("data-account-row"))).toEqual(["grok"]);
    expect(empties.map(text)).toEqual([say("usage.desk.noUsage")]);
    expect(text(host)).not.toContain(noData);
    const week = row(CLAUDE_2)?.querySelector('[data-window="week"]');
    expect(week?.querySelector("[data-cells]")?.getAttribute("data-cells")).toBe("0");
    expect(week?.querySelector("[data-left]")?.className).toMatch(/\btext-danger\b/);
    expect(text(week?.querySelector("[data-left]"))).toBe(say("usage.desk.windowLeft", { percent: 0 }));
    expect(text(week?.querySelector('[data-reset="week"]'))).toBe(locale === "en" ? "Limit reached · resets in 5d 2h" : "한도 도달 · 5일 2시간 후 초기화");
    expect(document.querySelector(HIDDEN)).toBeNull();
    expect(text(host)).not.toContain(say("usage.desk.quota"));
    const controls = [...host.querySelectorAll("[data-account-row] [data-main-check], [data-account-row] button[data-use]")];
    expect(controls).toHaveLength(accounts.length);
    for (const control of controls) expect(boxOf(control)).toEqual(BOX);
    expect(host.querySelector("[data-account-row] svg.lucide-check")).toBeNull();
  });

  it("keeps bot and worker details off account rows, including unknown workers", async () => {
    server.board.runs = "unknown";
    for (const account of engineOf(server.board, "claude").accounts) account.workers = null;
    await mount();
    expect(q("[data-account-who], [data-bot-count]")).toBeNull();
    expect(text(row("claude"))).not.toMatch(/workers|Atlas|Mira/);
  });

  const museEngine = (observedAt: number): UsageBoardEngine => ({
    engine: "muse", base: "muse", mainId: "muse", events: [],
    accounts: [{
      id: "muse", number: 1, nickname: null, name: "Muse", main: true, signIn: "ready", coverage: "unknown",
      windows: [
        { id: "five_hour", kind: "session", usedPercent: 100, resetsAt: usageBoardNow + 2 * 60 * MIN, windowMinutes: 300 },
        { id: "seven_day", kind: "week", usedPercent: 61, resetsAt: usageBoardNow + 4 * 1440 * MIN, windowMinutes: 10080 },
      ],
      observedAt, history: { fine: [], coarse: [] }, bots: [], workers: [],
    }],
  });

  it.each([false, true])("checks Muse once after a manual refresh has no observation (phone=%s)", async (phone) => {
    server.board.engines.push(museEngine(usageBoardNow - 2 * 60 * MIN));
    await mount({ phone });
    const api = h.api;
    const check = deferred<unknown>();
    const report = { observedAt: new Date(usageBoardNow).toISOString(), windows: [
      { ...accountOf(server.board, "muse").windows[0]!, usedPercent: 0 },
      { ...accountOf(server.board, "muse").windows[1]!, usedPercent: 20 },
    ] };
    h.api = async (path, init) => {
      if (path === "/api/usage/refresh/muse" || path === "/api/usage/check/muse") {
        server.calls.push(`${init?.method} ${path}`);
        return path.includes("/check/") ? check.promise : { status: "no_observation" };
      }
      return api(path, init);
    };
    await click(q("[data-usage-refresh]"));
    await click(q("[data-usage-refresh]"));
    expect(server.calls.filter((call) => call === "POST /api/usage/check/muse")).toHaveLength(1);
    expect(q("[data-usage-refresh]")?.hasAttribute("disabled")).toBe(true);
    accountOf(server.board, "muse").windows = report.windows;
    accountOf(server.board, "muse").observedAt = usageBoardNow;
    server.board.revision++;
    await act(async () => {
      check.resolve({ status: "fresh", report });
      (await client()).usageBoardFrame(server.board.revision);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.dispatched).toContainEqual({ type: "rateLimits", instanceId: "muse", report, identity: canary.address });
    expect(left("muse", "five_hour")).toBe("100% left");
    expect(left("muse", "seven_day")).toBe("80% left");
    expect(q("[role=alert]")).toBeNull();
    expect(q("[data-usage-refresh]")?.hasAttribute("disabled")).toBe(false);
  });

  it("spends no Muse turn when manual refresh returns a fresh reading", async () => {
    server.board.engines.push(museEngine(usageBoardNow));
    await mount();
    const api = h.api;
    h.api = async (path, init) => path === "/api/usage/refresh/muse" ? { status: "fresh" } : api(path, init);
    await click(q("[data-usage-refresh]"));
    expect(server.calls.some((call) => call.includes("/api/usage/check/"))).toBe(false);
  });

  it("never checks Muse automatically on mount, tab return or reopen", async () => {
    server.board.engines.push(museEngine(usageBoardNow - 2 * 60 * MIN));
    const api = h.api;
    h.api = async (path, init) => {
      if (!path.startsWith("/api/usage/refresh/")) return api(path, init);
      server.calls.push(`${init?.method} ${path}`);
      return { status: "no_observation" };
    };
    await mount();
    const { useAutoRefresh } = await import("@/lib/usage-auto-refresh");
    function QuickRefresh() { useAutoRefresh(server.board); return null; }
    await act(async () => root.render(createElement(QuickRefresh)));
    await settle();
    expect(server.calls).toContain("POST /api/usage/refresh/muse");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * MIN);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await unmount();
    await mount();
    expect(server.calls.some((call) => call.includes("/api/usage/check/"))).toBe(false);
  });

  it.each(["transport_error", "auth_error", "no_observation", "limit_reached", "reject", "auth_error_ko"])("keeps Muse's reading when its check returns %s", async (outcome) => {
    const locale = outcome === "auth_error_ko" ? "ko" : "en";
    const status = outcome === "auth_error_ko" ? "auth_error" : outcome;
    server.board.engines.push(museEngine(usageBoardNow));
    await mount({ locale });
    const api = h.api;
    h.api = async (path, init) => {
      if (path === "/api/usage/refresh/muse") return { status: "no_observation" };
      if (path === "/api/usage/check/muse") {
        server.calls.push(`${init?.method} ${path}`);
        if (status === "reject") throw new Error("offline");
        return { status, ...(status.endsWith("error") ? { error: status === "auth_error" ? "Sign in again in Muse" : "Could not refresh Muse limits" } : {}) };
      }
      return api(path, init);
    };
    await click(q("[data-usage-refresh]"));
    expect(server.calls.filter((call) => call === "POST /api/usage/check/muse")).toHaveLength(1);
    expect(left("muse", "seven_day")).toBe(locale === "ko" ? "39% 남음" : "39% left");
    expect(h.dispatched).toEqual([]);
    expect(Boolean(q("[role=alert]"))).toBe(status.endsWith("error") || status === "reject");
    if (status === "auth_error") expect(text(q("[role=alert]"))).toBe(locale === "ko" ? "Muse에서 다시 로그인하세요" : "Sign in again in Muse");
  });

  it("keeps every reported window and Muse", async () => {
    const board = fresh();
    accountOf(board, "claude").windows.push({ id: "seven_day_opus", kind: "week", usedPercent: 75, resetsAt: usageBoardNow + 2 * 1440 * MIN, windowMinutes: 10080 });
    board.engines.push(museEngine(usageBoardNow - 2 * 60 * MIN));
    server.board = board;
    await mount();
    expect(slots("claude")).toEqual(["5h", "7d", "Opus 7d"]);
    const opus = row("claude")?.querySelector('[data-window="seven_day_opus"]');
    expect(opus?.getAttribute("aria-label")).toBe("Opus 7d: 25% left, Resets in 2 days");
    expect(text(opus?.querySelector("[data-left]"))).toBe("25% left");
    expect(tones(opus)).toEqual([...Array(3).fill("text-warning"), ...Array(7).fill("off")]);
    expect(tones(row("claude")?.querySelector('[data-window="session"]'))).toEqual([...Array(3).fill("text-accent"), ...Array(7).fill("off")]);
    expect(slots("gemini")).toEqual(["24h"]);
    expect(left("gemini", "daily")).toBe("82% left");
    expect(row("gemini")?.querySelectorAll("[data-cells]")).toHaveLength(1);
    expect(q("[data-verdict]")).toBeNull();
    expect(text(host)).not.toContain("No history yet");
    expect(text(section("muse")?.querySelector("[data-engine-name]"))).toBe("Muse");
    expect(text(row("muse")?.querySelector("[data-account-name]"))).toBe("Muse");
    expect(slots("muse")).toEqual(["5h", "7d"]);
    expect(left("muse", "five_hour")).toBe("0% left");
    expect(row("muse")?.querySelector('[data-window="five_hour"] [data-left]')?.className).toMatch(/\btext-danger\b/);
    expect(tones(row("muse")?.querySelector('[data-window="five_hour"]'))).toEqual(Array(10).fill("off"));
    expect(left("muse", "seven_day")).toBe("39% left");
    expect(row("muse")?.querySelector("[data-reading-age]")).toBeNull();
    expect(row("muse")?.querySelector("[data-account-bars]")?.className).not.toMatch(/\bopacity-60\b/);
    expect(host.querySelectorAll("[data-reading-age]")).toHaveLength(0);
    expect(text(host)).not.toContain("Limit reached.");
    expect(q("[data-stale]")).toBeNull();
    expect(server.calls.some((call) => call.includes("/api/usage/check/"))).toBe(false);
  });

  it.each(["en", "ko"] as const)("states Muse's reading age on its row and mutes it only past 1h (%s)", async (locale) => {
    const board = fresh();
    board.engines.push(museEngine(usageBoardNow - 5 * MIN));
    server.board = board;
    await mount({ locale });
    expect(q("[data-reading-age]")).toBeNull();
    expect(row("muse")?.querySelector("[data-account-bars]")?.className).not.toMatch(/\bopacity-60\b/);
  });

  it("keeps the last good board after a failed read", async () => {
    await mount();
    expect(left("claude")).toBe("34% left");
    server.reply = async () => { throw new Error("Not found"); };
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("34% left");
    expect(text(q("[data-board-status]"))).toBe(i18n.translate("en", "usage.desk.stale" as never));
    await unmount();
    vi.resetModules();
    i18n = await import("@/lib/i18n");
    await mount();
    expect(left("claude")).toBe("34% left");
    expect(text(q("[data-board-status]"))).toBe(i18n.translate("en", "usage.desk.stale" as never));
    await reload();
    await mount();
    expect(text(q("[data-empty-state]"))).toBe(i18n.translate("en", "usage.desk.unavailable" as never));
    expect(q("[data-account-row]")).toBeNull();
  });

  it("inspects another account without a Main request", async () => {
    await mount({ layout: "A" });
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
    expect(left(CLAUDE_3)).toBe("40% left");
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
    expect(slots("codex")).toEqual(["7d"]);
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
    expect(slots("codex")).toEqual(["7d"]);
    expect(q("[data-today-normal]")).toBeNull();
  });

  it("shows an account change at its own values and settles under reduced motion", async () => {
    await mount({ reduce: true, layout: "A" });
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const animated = vi.spyOn(Element.prototype, "animate");
    expect(left("claude")).toBe("34% left");
    await pick("Studio");
    expect(heroName()).toBe("Studio");
    expect(left(CLAUDE_3)).toBe("40% left");
    expect(left("claude")).toBe("34% left");
    await pick("Claude 2");
    expect(viewed()).toBe(CLAUDE_2);
    expect(scrolled).not.toHaveBeenCalled();
    expect(animated).not.toHaveBeenCalled();
    const update = fresh();
    update.revision = 43;
    accountOf(update, "claude").windows[0]!.usedPercent = 70;
    server.board = update;
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(left("claude")).toBe("30% left");
    expect(row("claude")?.querySelector('[data-window="session"] [data-cells]')?.getAttribute("data-cells")).toBe("3");
  });

  it.each(["en", "ko"] as const)("keeps Refresh All and Used/Remaining gone and refreshes on Alt+R in both languages (%s)", async (locale) => {
    await mount({ locale });
    expect(q("[data-usage-desk]")).not.toBeNull();
    const labels = [...host.querySelectorAll("button")].map((button) => `${text(button)}|${button.getAttribute("aria-label") ?? ""}`);
    for (const key of ["usage.limits.countUp", "usage.limits.countDown"]) {
      expect(labels.some((label) => label.includes(i18n.translate(locale, key as never)))).toBe(true);
    }
    const button = q("[data-usage-refresh]");
    expect(button?.getAttribute("aria-keyshortcuts")).toBe("Alt+R");
    expect(button?.getAttribute("title")).toBe(locale === "en" ? "Refresh (Alt R)" : "새로고침 (Alt R)");
    const gate = deferred<unknown>();
    const api = h.api;
    h.api = async (path, init) => {
      if (!path.startsWith("/api/usage/refresh/")) return api(path, init);
      server.calls.push(`${init?.method} ${path}`);
      return gate.promise;
    };
    const posts = () => server.calls.filter((call) => call.startsWith("POST /api/usage/"));
    const altR = async (init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key: "r", code: "KeyR", altKey: true, bubbles: true, cancelable: true, ...init });
      await act(async () => { window.dispatchEvent(event); await vi.advanceTimersByTimeAsync(0); });
      return event.defaultPrevented;
    };
    const before = posts().length;
    for (const init of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: false }, { code: "AltRight", key: "Alt" }]) {
      expect(await altR(init), JSON.stringify(init)).toBe(false);
    }
    expect(posts().length, "ignored keys").toBe(before);
    expect(await altR()).toBe(true);
    const pressed = posts().slice(before);
    expect(pressed.length).toBeGreaterThan(0);
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.querySelector("svg")?.classList.contains("motion-safe:animate-spin")).toBe(true);
    expect(await altR(), "ignored while pending").toBe(false);
    await act(async () => { gate.reject(new Error("offline")); await vi.advanceTimersByTimeAsync(0); });
    expect(text(q("[role=alert]"))).toBe(i18n.translate(locale, "usage.desk.refreshFailed"));
    const clicked = posts().length;
    h.api = async (path, init) => path.startsWith("/api/usage/refresh/") ? (server.calls.push(`${init?.method} ${path}`), {}) : api(path, init);
    await click(button);
    expect(posts().slice(clicked), "same accounts as the button").toEqual(pressed);
    await unmount();
    const shut = posts().length;
    expect(await altR(), "Usage shut").toBe(false);
    expect(posts().length).toBe(shut);
    const { en, ko } = await import("@/lib/i18n-catalog");
    for (const catalog of [en, ko]) {
      expect("usage.limits.refreshAll" in catalog).toBe(false);
      expect("shortcuts.usageRefresh" in catalog).toBe(true);
    }
    const { KeyboardShortcuts } = await import("./KeyboardShortcuts");
    const shortcuts = document.createElement("div");
    const shortcutsRoot = createRoot(shortcuts);
    await act(async () => shortcutsRoot.render(createElement(i18n.I18nProvider, null, createElement(KeyboardShortcuts))));
    expect(text(shortcuts)).toContain(locale === "en" ? "Refresh Usage (in Usage)" : "사용량 새로고침 (사용량 화면에서)");
    expect(shortcuts.querySelector('[aria-label="Alt + R"]')).not.toBeNull();
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
    if (layout === "B") {
      const more = section("claude")?.querySelector("button[data-accounts-cap]");
      expect(text(more)).toBe("5개 더 보기");
      await click(more);
    }
    const rows = [...section("claude")?.querySelectorAll("[data-account-row]") ?? []];
    expect(rows).toHaveLength(8);
    expect(rows[0]?.parentElement?.className).not.toMatch(/\bgrid-cols-2\b/);
    for (const node of rows) {
      const control = node.querySelector("button[data-use], [data-main-check]");
      expect(boxOf(control)).toEqual(BOX);
      expect(control?.className).toMatch(/\[@media\(pointer:coarse\)\]:after:-inset-y-2/);
      expect(node.querySelector("[data-account-head]")?.lastElementChild, "Main or Use ends the head line").toBe(control);
      expect(control?.previousElementSibling?.contains(node.querySelector("[data-account-name]") ?? null), "the name sits beside it").toBe(true);
      expect(control?.previousElementSibling?.className).toMatch(/\bmin-w-0\b/);
      expect(node.querySelector("[data-account-name]")?.className).toMatch(/\bmin-w-0\b/);
      // A's picker button keeps its own one-line name.
      if (layout === "B") expect(node.querySelector("[data-account-name]")?.className, "a 24-character nickname with no space wraps instead of running under Use, and a Korean name wraps between words").toMatch(/\bbreak-keep\b.*\[overflow-wrap:anywhere\]/);
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
    expect(text(row("claude")?.querySelector('[data-reset="session"]'))).toBe("40분 후 초기화");
    expect(q("[data-usage-desk]")?.className).toMatch(/min-w-0/);
    expect(visible()).toEqual(layout === "A" ? ["claude"] : rows.map((node) => node.getAttribute("data-account-row")));
  });

  it.each([
    [false, "en"], [true, "en"], [false, "ko"], [true, "ko"],
  ] as const)("shows Main on the left and one other account on the right, or one row from Main on a phone (phone=%s, %s)", async (phone, locale) => {
    await mount({ phone, locale, layout: "A" });
    const engines = ["claude", "codex", "grok", "gemini"];
    expect(engines.map((engine) => visible(engine))).toEqual(phone
      ? [["claude"], ["codex"], ["grok"], ["gemini"]]
      : [["claude", CLAUDE_2], ["codex", CODEX_2], ["grok"], ["gemini"]]);
    expect(engines.map((engine) => [arrows(engine).length, picker(engine) !== null])).toEqual(phone
      ? [[2, true], [2, true], [0, false], [0, false]]
      : [[2, true], [0, false], [0, false], [0, false]]);
    for (const engine of engines) {
      const box = section(engine)?.querySelector('[role="group"]:not([data-engine-head])');
      const grid = box?.querySelector("[data-account-column]")?.parentElement ?? box;
      expect(grid?.classList.contains("grid-cols-2"), engine).toBe(!phone && (engine === "claude" || engine === "codex"));
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
    await mount({ phone, locale, layout: "A" });
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
    expect(menuItems().map(text)).toEqual([...phone ? [`Claude 1${say("accounts.main")}`] : [], "Claude 2", "Studio", "Claude 4"]);
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
    await mount({ phone, layout: "A" });
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
  ] as const)("names every shown row first on its head line, Codex 2 too (layout %s, phone=%s)", async (layout, phone) => {
    await mount({ phone, layout });
    const named = () => [...host.querySelectorAll("[data-account-row]")].filter(live).map((node) => {
      const id = node.getAttribute("data-account-row") ?? "";
      expect(node.querySelector("[data-tile]"), id).toBeNull();
      const lead = node.querySelector("[data-account-head]")?.firstElementChild?.firstElementChild;
      const name = lead?.matches("[data-account-name]") ? lead : lead?.querySelector("[data-account-name]");
      expect(text(name), id).not.toBe("");
      return text(name);
    });
    expect(named()).toEqual(layout === "B" ? ["Claude 1", "Claude 2", "Studio", "Codex 1", "Codex 2", "Grok", "Gemini"]
      : phone ? ["Claude 1", "Codex 1", "Grok", "Gemini"] : ["Claude 1", "Claude 2", "Codex 1", "Codex 2", "Grok", "Gemini"]);
    if (layout === "A" && phone) {
      await click(arrows("codex")[1]);
      expect(named()).toEqual(["Claude 1", "Codex 2", "Grok", "Gemini"]);
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
    expect(bars.map((node) => text(node?.querySelector("[data-left]")))).toEqual([say("usage.desk.windowLeft", { percent: 100 }), say("usage.desk.windowLeft", { percent: 100 })]);
    expect(bars.map((node) => text(node?.querySelector("[data-reset]")))).toEqual(["", ""]);
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
    expect(on).toHaveLength(10);
    expect([Math.min(...on), Math.max(...on)]).toEqual([0, 10]);
    expect(said(host)).not.toMatch(GLYPHS);
  });

  it.each([false, true])("labels the account arrows in Korean (phone=%s)", async (phone) => {
    await mount({ phone, locale: "ko", layout: "A" });
    expect(["claude", "codex", "grok", "gemini"].map((engine) => arrows(engine).map((button) => button.getAttribute("aria-label"))))
      .toEqual([["이전 계정", "다음 계정"], phone ? ["이전 계정", "다음 계정"] : [], [], []]);
    expect(arrows().map((button) => text(button))).toEqual(["", ""]);
    expect(picker()?.getAttribute("aria-label")).toBe(`계정 선택: ${phone ? "Claude 1" : "Claude 2"}`);
    expect(said(host)).not.toMatch(/Previous Account|Next Account|Choose account/);
  });

  it.each(["A", "B"] as const)("folds and opens an engine from its header, stores the fold under the engine's base and keeps it after a reload (layout %s)", async (layout) => {
    engineOf(server.board, "codex").base = "codex-work";
    await mount({ layout });
    const expanded = () => ["claude", "codex", "grok", "gemini"].map((engine) => fold(engine)?.getAttribute("aria-expanded"));
    const stored = () => JSON.parse(localStorage.getItem(FOLDS) ?? "null") as unknown;
    const content = (engine: string) => document.getElementById(fold(engine)?.getAttribute("aria-controls") ?? "");
    expect(expanded()).toEqual(["true", "true", "true", "true"]);
    expect(stored()).toBeNull();
    expect(arrows()).toHaveLength(layout === "A" ? 2 : 0);
    const header = fold("codex");
    expect([header?.firstElementChild?.hasAttribute("data-engine-mark"), text(header?.querySelector("[data-engine-name]")), header?.lastElementChild?.matches('svg[aria-hidden="true"]')])
      .toEqual([true, "Codex", true]);
    const group = content("codex")?.querySelector('[role="group"].usage-group');
    expect([group?.getAttribute("aria-label"), group?.contains(row("codex")), group?.contains(row(CODEX_2))]).toEqual(["Codex", true, true]);
    await click(fold("codex"));
    await click(fold("claude"));
    expect(expanded()).toEqual(["false", "false", "true", "true"]);
    expect(stored()).toEqual({ "codex-work": true, claude: true });
    expect(arrows()).toHaveLength(0);
    expect([content("codex")?.getAttribute("data-fold"), content("codex")?.hasAttribute("inert"), content("codex")?.contains(row("codex"))]).toEqual(["closing", true, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(MOTION_LARGE_MS); });
    expect([content("codex")?.hidden, content("codex")?.childElementCount, content("claude")?.hidden]).toEqual([true, 0, true]);
    expect([row("codex"), row(CODEX_2), row("claude")]).toEqual([null, null, null]);
    expect([summary("codex"), summary()]).toEqual(["7d 62% left", "5h 34% left · 7d 59% left"]);
    expect(visible("gemini")).toEqual(["gemini"]);
    await reload();
    await mount({ layout });
    expect(expanded()).toEqual(["false", "false", "true", "true"]);
    expect([row("codex"), row("claude")]).toEqual([null, null]);
    await click(fold("claude"));
    expect(expanded()).toEqual(["true", "false", "true", "true"]);
    expect(stored()).toEqual({ "codex-work": true, claude: false });
    expect(visible()).toEqual(layout === "A" ? ["claude", CLAUDE_2] : ["claude", CLAUDE_2, CLAUDE_3]);
    expect(arrows()).toHaveLength(layout === "A" ? 2 : 0);
    expect(mainPosts()).toEqual([]);
  });

  it("folds an engine with no ready account by default, sums it up with its Main's state, and a stored fold wins", async () => {
    engineOf(server.board, "codex").mainId = CODEX_2;
    accountOf(server.board, "codex").signIn = "signed-out";
    accountOf(server.board, CODEX_2).signIn = "draining";
    accountOf(server.board, "grok").signIn = "signing-in";
    const expanded = () => ["claude", "codex", "grok", "gemini"].map((engine) => fold(engine)?.getAttribute("aria-expanded"));
    await mount();
    expect(expanded()).toEqual(["true", "false", "false", "true"]);
    expect(["claude", "codex", "grok", "gemini"].map((engine) => summary(engine))).toEqual(["", "Finishing work", "Signing in", ""]);
    expect([row("codex"), row(CODEX_2), row("grok")]).toEqual([null, null, null]);
    expect(localStorage.getItem(FOLDS)).toBeNull();
    await reload();
    localStorage.setItem(FOLDS, JSON.stringify({ claude: true, codex: false }));
    await mount();
    expect(expanded()).toEqual(["false", "true", "false", "true"]);
    expect(summary()).toBe("5h 34% left · 7d 59% left");
    expect(visible("codex")).toEqual(["codex", CODEX_2]);
    expect(text(row(CODEX_2)?.querySelector("[data-row-status]"))).toBe("Finishing work");
    for (const bad of ["{", JSON.stringify({ claude: "yes", codex: false })]) {
      await reload();
      localStorage.setItem(FOLDS, bad);
      await mount();
      expect(expanded(), bad).toEqual(["true", "false", "false", "true"]);
    }
  });

  it.each(["en", "ko"] as const)("sums up a folded engine with its Main's windows, one phrase per window (%s)", async (locale) => {
    localStorage.setItem(FOLDS, JSON.stringify({ claude: true, codex: true, grok: true, gemini: true }));
    await mount({ locale });
    const en = locale === "en";
    const engines = ["claude", "codex", "grok", "gemini"];
    expect(engines.map((engine) => summary(engine))).toEqual(en
      ? ["5h 34% left · 7d 59% left", "7d 62% left", "No usage yet", "24h 82% left"]
      : ["5시간 34% 남음 · 7일 59% 남음", "7일 62% 남음", "아직 사용량 없음", "24시간 82% 남음"]);
    expect(engines.map((engine) => section(engine)?.querySelectorAll("[data-engine-summary] .usage-meter-summary").length)).toEqual([2, 1, 0, 1]);
    expect(q("[data-account-row]")).toBeNull();
    expect(q("[data-engine-summary] [data-left].text-danger")).toBeNull();
    const next = fresh();
    next.revision = 43;
    engineOf(next, "claude").mainId = CLAUDE_2;
    server.board = next;
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(summary()).toBe(en ? "7d 0% left" : "7일 0% 남음");
    expect(text(section("claude")?.querySelector("[data-engine-summary] [data-left].text-danger"))).toBe(en ? "0% left" : "0% 남음");
  });

  it.each(["en", "ko"] as const)("shows Main as a plain tag and Switch as the button (%s)", async (locale) => {
    await mount({ locale });
    const en = locale === "en";
    const tag = row("claude")?.querySelector("[data-main-check]") ?? null;
    expect(text(tag)).toBe(en ? "Main" : "기본");
    expect(tag?.tagName).toBe("SPAN");
    expect(tag?.closest("button")).toBeNull();
    expect(tag?.hasAttribute("tabindex")).toBe(false);
    expect(tag?.className).toMatch(/border-transparent/);
    expect(tag?.className).not.toMatch(/(?:bg-|hover:|border-accent)/);
    expect(boxOf(tag)).toEqual(BOX);
    const button = useButton(CLAUDE_2);
    expect(text(button)).toBe(en ? "Switch" : "전환");
    expect(button?.getAttribute("aria-label")).toBe(en ? "Switch to Claude 2" : "Claude 2 전환");
  });

  it.each(["en", "ko"] as const)("starts that account's sign-in on the Usage page in one tap (%s)", async (locale) => {
    accountOf(server.board, CLAUDE_3).signIn = "signed-out";
    await mount({ locale });
    h.state.instances = h.state.instances.map((each) => (each as { instanceId: string }).instanceId === CLAUDE_3 ? { ...each as object, accountState: "stopped" } : each);
    await rerender();
    const signIn = row(CLAUDE_3)?.querySelector("button[data-sign-in]") ?? null;
    expect(boxOf(signIn)).toEqual(BOX);
    expect(row(CLAUDE_3)?.querySelector("[data-account-head]")?.lastElementChild?.contains(signIn), "Sign In ends the head line").toBe(true);
    h.api = async (path, init) => { server.calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`); return { url: "https://auth.example/device", code: "ABCD-EFGH" }; };
    await click(signIn);
    expect(server.calls.filter((call) => call.includes("/sign-in"))).toEqual([`POST /api/instances/${encodeURIComponent(CLAUDE_3)}/sign-in`]);
    expect(text(row(CLAUDE_3))).toContain("ABCD-EFGH");
    expect(h.dispatched).toEqual([]);
  });

  it.each(["en", "ko"] as const)("offers Sign In in the same box as Main and Use for a signed-out account Wink has no record of and opens Connections (%s)", async (locale) => {
    accountOf(server.board, CLAUDE_3).signIn = "signed-out";
    await mount({ locale });
    h.state.instances = h.state.instances.filter((each) => (each as { instanceId: string }).instanceId !== CLAUDE_3);
    await rerender();
    const en = locale === "en";
    const account = row(CLAUDE_3);
    const signIn = account?.querySelector("button[data-sign-in]") ?? null;
    expect(text(signIn)).toBe(en ? "Sign In" : "로그인");
    expect(account?.querySelector("[data-account-head]")?.lastElementChild).toBe(signIn);
    expect([signIn, row("claude")?.querySelector("[data-main-check]"), useButton(CLAUDE_2)].map(boxOf)).toEqual([BOX, BOX, BOX]);
    expect(text(account?.querySelector("[data-row-status]"))).toBe(en ? "Not signed in" : "로그인되지 않음");
    expect(account?.querySelector("[data-window], [data-account-bars], [data-window-empty], button[data-use], [data-main-check]")).toBeNull();
    expect(fold()?.getAttribute("aria-expanded")).toBe("true");
    await click(signIn);
    expect(h.dispatched).toEqual([{ type: "toggleAppSettings", open: true, section: "connections" }]);
    expect(mainPosts()).toEqual([]);
  });

  it.each(["en", "ko"] as const)("shows a used-up window in red with Limit reached before its reset (%s)", async (locale) => {
    accountOf(server.board, CLAUDE_3).windows[0]!.usedPercent = 90;
    await mount({ locale });
    const en = locale === "en";
    const week = row(CLAUDE_2)?.querySelector('[data-window="week"]');
    expect(week?.getAttribute("aria-label")).toBe(en ? "7d: 0% left, Resets in 5 days" : "7일: 0% 남음, 5일 후 초기화");
    const used = week?.querySelector("[data-left]");
    expect([text(used), used?.classList.contains("text-danger")]).toEqual([en ? "0% left" : "0% 남음", true]);
    const reset = week?.querySelector('[data-reset="week"]');
    expect(text(reset)).toBe(en ? "Limit reached · resets in 5d 2h" : "한도 도달 · 5일 2시간 후 초기화");
    expect([...reset?.querySelectorAll(".text-danger") ?? []].map(text)).toEqual([en ? "Limit reached" : "한도 도달"]);
    expect(tones(week)).toEqual(Array(10).fill("off"));
    const low = row(CLAUDE_3)?.querySelector('[data-window="session"]');
    expect(text(low?.querySelector("[data-left].text-danger"))).toBe(en ? "10% left" : "10% 남음");
    expect(text(low?.querySelector('[data-reset="session"]'))).toBe(en ? "resets in 2h 10m" : "2시간 10분 후 초기화");
    expect(tones(low)).toEqual(["text-danger", ...Array(9).fill("off")]);
  });

  it.each(["en", "ko"] as const)("ends a used-up window with no reset time at Limit reached, with no dot after it (%s)", async (locale) => {
    accountOf(server.board, CLAUDE_2).windows.find((each) => each.usedPercent >= 100)!.resetsAt = null;
    await mount({ locale });
    expect(text(row(CLAUDE_2)?.querySelector('[data-window="week"] [data-reset="week"]'))).toBe(locale === "en" ? "Limit reached" : "한도 도달");
  });

  it.each(["en", "ko"] as const)("keeps 99.9 percent usage below Limit reached (%s)", async (locale) => {
    accountOf(server.board, CLAUDE_2).windows.find((each) => each.kind === "week")!.usedPercent = 99.9;
    await mount({ locale });
    const week = row(CLAUDE_2)?.querySelector('[data-window="week"]');
    expect(text(week?.querySelector("[data-left]"))).toBe(locale === "en" ? "1% left" : "1% 남음");
    expect(text(week?.querySelector("[data-reset]"))).not.toContain(locale === "en" ? "Limit reached" : "한도 도달");
  });

  it.each(["en", "ko"] as const)("keeps the Opus qualifier on a standalone weekly window (%s)", async (locale) => {
    accountOf(server.board, "claude").windows = [{ id: "seven_day_opus", kind: "week", usedPercent: 40, resetsAt: usageBoardNow + 1440 * MIN, windowMinutes: 10080 }];
    await mount({ locale });
    expect(row("claude")?.querySelector('[data-window="week"]')?.getAttribute("aria-label")).toMatch(locale === "en" ? /^Opus 7d:/ : /^Opus 7일:/);
  });

  it.each(["en", "ko"] as const)("shows the age of retained quota readings until a fresh report arrives (%s)", async (locale) => {
    for (const id of ["claude", "codex", "grok"]) {
      const account = accountOf(server.board, id);
      account.windows = structuredClone(accountOf(server.board, "claude").windows);
      account.observedAt = usageBoardNow - 10 * MIN;
    }
    await mount({ locale });
    for (const id of ["claude", "codex", "grok"]) {
      expect(row(id)?.querySelector("[data-reading-age]")).toBeNull();
    }
    const boardClient = await client();
    await act(async () => { boardClient.usageBoardReconnected(); await vi.advanceTimersByTimeAsync(0); });
    expect(q("[data-reading-age]")).toBeNull();
    for (const id of ["claude", "codex", "grok"]) accountOf(server.board, id).observedAt = usageBoardNow - 5 * MIN;
    server.board.revision++;
    await act(async () => { boardClient.usageBoardFrame(server.board.revision); await vi.advanceTimersByTimeAsync(0); });
    for (const id of ["claude", "codex", "grok"]) expect(row(id)?.querySelector("[data-reading-age]")).toBeNull();
  });

  it.each(["en", "ko"] as const)("updates Muse sign-in after an equal-revision reread (%s)", async (locale) => {
    server.board.engines.push(museEngine(usageBoardNow));
    await mount({ locale });
    const boardClient = await client();
    accountOf(server.board, "muse").signIn = "signed-out";
    h.state.instances = h.state.instances.map((each) => (each as { instanceId: string }).instanceId === "muse" ? { ...each as object, accountState: "stopped" } : each);
    await act(async () => { boardClient.usageBoardReconnected(); await vi.advanceTimersByTimeAsync(0); });
    expect(row("muse")?.querySelector("[data-account-bars], [data-main-check]")).toBeNull();
    expect(text(row("muse"))).toContain(locale === "en" ? "Sign In" : "로그인");
    accountOf(server.board, "muse").signIn = "ready";
    await act(async () => { boardClient.usageBoardReconnected(); await vi.advanceTimersByTimeAsync(0); });
    expect(row("muse")?.querySelector("[data-account-bars]")).not.toBeNull();
  });

  it.each(["en", "ko"] as const)("clears swapped usage and pace before painting the new email (%s)", async (locale) => {
    server.board.engines.push(museEngine(usageBoardNow));
    const ids = ["claude", "codex", "grok", "gemini", "muse"];
    for (const id of ids) accountOf(server.board, id).windows = structuredClone(accountOf(server.board, "claude").windows);
    await mount({ locale });
    for (const id of ids) expect(row(id)?.querySelector("[data-account-bars]")).not.toBeNull();
    const reply = deferred<UsageBoard>();
    server.reply = () => reply.promise;
    h.state.instances = h.state.instances.map((instance) => ({ ...instance as object,
      snapshot: { state: "available", authenticated: true, account: "new@example.test" },
    }));
    await rerender();
    for (const id of ids) {
      if (id === "gemini") { expect(row(id)).toBeNull(); continue; }
      expect(text(row(id))).toContain("new@example.test");
      expect(row(id)?.querySelector("[data-account-bars], [data-window], [data-pace]")).toBeNull();
      expect(text(row(id)?.querySelector("[data-window-empty]"))).toBe(locale === "en" ? "No usage yet" : "아직 사용량 없음");
    }
    const next = fresh();
    next.engines.push(museEngine(usageBoardNow));
    next.revision++;
    for (const id of ids) {
      accountOf(next, id).windows = [{ ...UNUSED, usedPercent: 40 }];
      accountOf(next, id).history = { fine: [], coarse: [] };
    }
    await act(async () => { reply.resolve(next); await vi.advanceTimersByTimeAsync(0); });
    for (const id of ids) expect(text(row(id)?.querySelector("[data-left]"))).toBe(locale === "en" ? "60% left" : "60% 남음");
  });

  it.each(["en", "ko"] as const)("says No usage yet, the same on every engine, for an account with no windows (%s)", async (locale) => {
    await mount({ locale });
    const words = locale === "en" ? "No usage yet" : "아직 사용량 없음";
    const empties = () => [...host.querySelectorAll("[data-window-empty]")];
    const owners = () => empties().map((node) => [node.closest("[data-account-row]")?.getAttribute("data-account-row"), text(node)]);
    expect(owners()).toEqual([["grok", words]]);
    expect(row("grok")?.querySelector("[data-account-bars], [data-window], [data-row-status]")).toBeNull();
    const next = fresh();
    next.revision = 43;
    accountOf(next, CLAUDE_2).windows = [];
    server.board = next;
    await act(async () => { (await client()).usageBoardFrame(43); await vi.advanceTimersByTimeAsync(0); });
    expect(owners()).toEqual([[CLAUDE_2, words], ["grok", words]]);
    // React reuses the bars div for the empty state in place, so compare attributes as a set, not by outerHTML order.
    const shape = (node: Element | undefined) => [node?.tagName, [...node?.attributes ?? []].map((each) => `${each.name}=${each.value}`).sort(), node?.innerHTML];
    expect(shape(empties()[0])).toEqual(shape(empties()[1]));
    expect(row(CLAUDE_2)?.querySelector("[data-window]")).toBeNull();
    expect(said(host)).not.toContain(i18n.translate(locale, "usage.desk.noData"));
  });
});
