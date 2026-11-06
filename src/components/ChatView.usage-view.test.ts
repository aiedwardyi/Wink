// @vitest-environment happy-dom
import { act, createElement, Fragment, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdentityCanary, scanForCanary, type IdentityCanary } from "@/lib/identity-canary";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard, UsageBoardAccount } from "@/lib/usage-board";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { UsageWaitView } from "../../server/limit-wait-store";
import { runtimeErrorTool } from "../../server/chat-error";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const CLAUDE_2 = "acct_00000000-0000-4000-8000-000000000002";
const CLAUDE_3 = "acct_00000000-0000-4000-8000-000000000003";
const CODEX_2 = "acct_00000000-0000-4000-8000-000000000012";
const BOX = ["h-[22px]", "min-w-12", "shrink-0", "border", "px-2", "text-[11px]", "rounded-md"];
const DRIVER: Record<string, string> = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", gemini: "antigravityAgent", muse: "museAgent" };
const ENGINE: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", muse: "Muse" };

type Mods = {
  store: typeof import("@/state/store");
  view: typeof import("./ChatView");
  usage: typeof import("./UsageSection");
  i18n: typeof import("@/lib/i18n");
  skins: typeof import("@/lib/skins");
};
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((yes) => { resolve = yes; }), resolve };
}

let m: Mods;
let canary: IdentityCanary;
let server: { board: UsageBoard; calls: string[]; read: (() => Promise<UsageBoard>) | null; post: (() => Promise<Response>) | null };
let host: HTMLDivElement;
let root: Root;
let store: ReturnType<Mods["store"]["useStore"]>;
let commits: { bot: string; quick: string[] }[];
const matchMedia = window.matchMedia;

const fresh = (): UsageBoard => structuredClone(usageBoardFixture);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (node: Element | null | undefined) => {
  const clone = node?.cloneNode(true) as Element | undefined;
  clone?.querySelectorAll(".usage-reset-short").forEach((el) => el.remove());
  return (clone?.textContent ?? "").replace(/\s+/g, " ").trim();
};
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const quick = () => q("[data-usage-quick]");
const meter = () => q<HTMLButtonElement>("[data-usage-meter]");
const boardGets = () => server.calls.filter((call) => call.startsWith("GET /api/usage/board"));
const mainPosts = () => server.calls.filter((call) => call.startsWith("POST /api/accounts/"));
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = async (node: Element | null | undefined) => {
  expect(node, "control to click").toBeTruthy();
  await act(async () => { (node as HTMLElement).click(); });
  await settle();
};
const poke = async (node: Element) => act(async () => {
  node.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  (node as HTMLElement).focus();
});
const whoLine = (row: Element) => [...row.querySelector("[data-account-who]")?.children ?? []].map((node) => text(node)).join(" ");
const HIDDEN = '[data-usage-hero], [data-hero-left], [data-verdict], [data-projection], [data-usage-chart], [data-trace], [data-chart-fold], [data-today-normal], [data-details], [role="tablist"], [role="tab"], [data-usage-event]';
const UNUSED = { id: "five_hour", kind: "session", usedPercent: 0, resetsAt: null, windowMinutes: 300 } as const;
const GLYPHS = /[\u2580-\u25FF]/u;
const boxOf = (node: Element | null | undefined) => BOX.filter((name) => node?.classList.contains(name));
const said = (root: Element | null | undefined) => [root?.textContent ?? "", ...[...root?.querySelectorAll("*") ?? []].flatMap((node) => [...node.attributes].map((attribute) => attribute.value))].join("\n");
function unused(board: UsageBoard, ...ids: string[]) {
  for (const account of board.engines.flatMap((engine) => engine.accounts)) {
    if (ids.includes(account.id)) account.windows = [{ ...UNUSED }, ...account.windows.filter((window) => window.kind !== "session")];
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

function setMedia(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && (query.includes("max-width") || query.includes("pointer: coarse")),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

type Viewport = { width: number; height: number; offsetTop: number; offsetLeft: number; scale: number; resize: (height: number) => Promise<void> };
function viewport(width: number, height: number): Viewport {
  const listeners: { type: string; listener: EventListener }[] = [];
  const vv = {
    width, height, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0,
    addEventListener: (type: string, listener: EventListener) => { listeners.push({ type, listener }); },
    removeEventListener: (type: string, listener: EventListener) => {
      const at = listeners.findIndex((each) => each.type === type && each.listener === listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    resize: async (next: number) => {
      vv.height = next;
      await act(async () => { for (const each of listeners.filter((one) => one.type === "resize")) each.listener(new Event("resize")); });
      await settle();
    },
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  return vv;
}

function seatMeter(vv: Viewport) {
  const rect = Element.prototype.getBoundingClientRect;
  const meterTop = () => vv.offsetTop + vv.height - 132;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (!this.closest("[data-usage-meter]")) return rect.call(this);
    const top = meterTop();
    return { x: 0, y: top, top, bottom: top + 28, left: 0, right: vv.width, width: vv.width, height: 28, toJSON: () => ({}) } as DOMRect;
  });
  return meterTop;
}

function instancesFor(board: UsageBoard): InstanceInfo[] {
  return board.engines.flatMap((engine) => engine.accounts.map((account): InstanceInfo => ({
    instanceId: account.id,
    driverKind: DRIVER[engine.engine]!,
    displayName: ENGINE[engine.engine]!,
    accountOf: engine.base,
    accountState: "ready",
    accountMain: account.id === engine.mainId,
    snapshot: { state: "available", authenticated: true, account: canary.address },
    models: { default: "model", options: [{ id: "model", label: "Model" }] },
    capabilities: { rateLimits: true },
    rateLimits: {
      observedAt: new Date(usageBoardNow - MIN).toISOString(),
      windows: account.windows.map(({ id, usedPercent, resetsAt }) => ({ id, usedPercent: Math.min(100, usedPercent + 5), resetsAt })),
    },
  })));
}

const signedOut = (id: string) => instancesFor(server.board).map((each) => each.instanceId === id ? { ...each, accountState: "stopped" as const } : each);

function makeBot(id: string, name: string, instanceId: string, messages: Message[] = []): Bot {
  return {
    id, threadId: `thread-${id}`, name, title: "", description: "", color: "blue",
    notifications: false, unread: false, busy: false, cwd: "/repo",
    modelSelection: { instanceId, model: "model", effort: "high" },
    messages: [{ id: `${id}-q`, at: usageBoardNow - 2 * MIN, role: "user", kind: "text", text: "Still going" }, ...messages],
  };
}

const waiting: UsageWaitView = { id: "wait", ownerDeviceId: "pc-a", state: "waiting", resumesAt: usageBoardNow + 40 * MIN, weekly: false, cancelable: true };
const limitMessage = (message: string, usageWait?: UsageWaitView): Message => ({
  id: "limit", at: usageBoardNow - MIN, role: "bot", kind: "activity",
  tool: { name: `error: ${message}`, usageLimit: { resetsAt: usageBoardNow + 40 * MIN }, usageWait },
});

function Probe({ id }: { id: string }) {
  useLayoutEffect(() => {
    commits.push({ bot: id, quick: [...document.querySelectorAll("[data-usage-quick]")].map((node) => text(node)) });
  });
  return null;
}
function Harness({ bot, desk }: { bot: Bot; desk: boolean }) {
  store = m.store.useStore();
  return createElement(Fragment, null,
    createElement(m.view.ChatView, { bot }),
    desk ? createElement(m.usage.UsageSection) : null,
    createElement(Probe, { id: bot.id }));
}
async function show(bot: Bot, desk = false) {
  await act(async () => root.render(createElement(m.store.StoreProvider, null, createElement(Harness, { bot, desk }))));
}
async function mount(bot: Bot, { phone = false, locale = "en", desk = false, instances }: { phone?: boolean; locale?: "en" | "ko"; desk?: boolean; instances?: InstanceInfo[] } = {}) {
  setMedia(phone);
  m.i18n.applyLocale(locale);
  m.skins.applySkin("precision");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await show(bot, desk);
  await act(async () => store.dispatch({ type: "instances", instances: instances ?? instancesFor(server.board) }));
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
}

beforeEach(async () => {
  vi.useFakeTimers({ now: usageBoardNow, toFake: ["Date"] });
  vi.resetModules();
  canary = makeIdentityCanary();
  commits = [];
  server = { board: fresh(), calls: [], read: null, post: null };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    server.calls.push(`${(init?.method ?? "GET").toUpperCase()} ${path}`);
    if (path.startsWith("/api/usage/board")) return json(server.read ? await server.read() : structuredClone(server.board));
    if (/^\/api\/accounts\/[^/]+\/default$/.test(path)) return server.post ? server.post() : json({});
    if (/^\/api\/instances\/[^/]+\/sign-in$/.test(path)) return json({ url: "https://auth.example/device", code: "ABCD-EFGH" });
    return new Promise<Response>(() => {});
  }));
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m = {
    store: await import("@/state/store"),
    view: await import("./ChatView"),
    usage: await import("./UsageSection"),
    i18n: await import("@/lib/i18n"),
    skins: await import("@/lib/skins"),
  };
});
afterEach(async () => {
  if (host?.isConnected) await unmount();
  document.body.replaceChildren();
  window.matchMedia = matchMedia;
  for (const name of ["visualViewport", "innerWidth", "innerHeight"]) delete (window as unknown as Record<string, unknown>)[name];
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat usage meter, quick view and wait card", () => {
  it("keeps account identities out of the meter, quick view and wait card", async () => {
    const scans: string[] = [];
    for (const [phone, locale] of [[false, "en"], [true, "en"], [false, "ko"], [true, "ko"]] as const) {
      server.post = async () => json({ error: `409 ${canary.address} is busy` }, 409);
      viewport(phone ? 390 : 1280, phone ? 844 : 800);
      const raw = `Usage limit reached for ${canary.address} (${canary.local} at ${canary.domain}).`;
      await mount(makeBot("bot-atlas", "Atlas", "claude", [limitMessage(raw, waiting)]), { phone, locale });
      const scan = (label: string) => {
        scans.push(label);
        expect(scanForCanary(canary), `${label} (phone=${phone}, ${locale})`).toEqual([]);
      };
      const trigger = meter();
      expect(trigger, "meter").not.toBeNull();
      await poke(trigger!);
      await act(async () => { trigger!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
      scan("meter hover, focus and touch");
      await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
      await settle();
      expect(quick(), "quick view").not.toBeNull();
      scan("open quick view");
      for (const node of quick()!.querySelectorAll("button, [tabindex]")) await poke(node);
      scan("quick view hover and focus");
      expect(quick()!.querySelector("[data-chart-fold], [data-usage-hero]"), "no chart fold or hero").toBeNull();
      for (const count of quick()!.querySelectorAll("button[data-bot-count]")) await click(count);
      scan("names");
      expect(quick()!.querySelector('button[aria-haspopup="menu"]'), "no picker in the quick view").toBeNull();
      await click(quick()!.querySelector(`[data-account-row="${CLAUDE_3}"] button[data-use]`));
      expect(quick()!.querySelector('[role="alert"]'), "failed Main save").not.toBeNull();
      scan("failed Main save");
      const card = q("[data-usage-wait]");
      expect(card, "wait card").not.toBeNull();
      expect(card!.querySelector("[data-engine-details]"), "no details toggle").toBeNull();
      expect(card!.querySelector("[data-engine-details-body]"), "engine details").not.toBeNull();
      scan("engine details");
      await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      scan("closing quick view");
      await settle();
      scan("closed");
      await unmount();
    }
    expect(scans).toHaveLength(4 * 8);
  });

  it("puts the binding fact first and paints today's values before the first board read", async () => {
    const read = deferred<UsageBoard>();
    server.read = () => read.promise;
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    expect(meter(), "meter before the board").not.toBeNull();
    expect(q("[data-meter-name]")).toBeNull();
    expect(text(meter()?.querySelectorAll("[data-window]")[0]?.querySelector("[data-left]"))).toBe("29%");
    expect(text(meter()?.querySelectorAll("[data-window]")[1]?.querySelector("[data-left]"))).toBe("54%");
    const board = fresh();
    board.engines[0]!.accounts[0]!.windows[1]!.usedPercent = 90;
    await act(async () => read.resolve(board));
    await settle();
    expect(q("[data-meter-name]")).toBeNull();
    expect(text(meter()?.querySelectorAll("[data-window]")[0]?.querySelector("[data-left]"))).toBe("34%");
    expect(text(meter()?.querySelectorAll("[data-window]")[1]?.querySelector("[data-left]"))).toBe("10%");
  });

  it("keeps quick-view document listeners across clock ticks", async () => {
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    expect(quick()).not.toBeNull();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    await act(async () => {
      vi.setSystemTime(usageBoardNow + 61_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const closes = (calls: unknown[][]) => calls.filter(([type]) => type === "pointerdown" || type === "keydown");
    expect(closes(add.mock.calls)).toEqual([]);
    expect(closes(remove.mock.calls)).toEqual([]);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(quick()).toBeNull();
  });

  it("closes the old quick view before the next bot renders", async () => {
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    expect(text(quick())).toContain("Claude 1");
    commits = [];
    await show(makeBot("bot-kai", "Kai", "codex"));
    await settle();
    const first = commits.find((commit) => commit.bot === "bot-kai");
    expect(first, "first commit with the next bot").toBeDefined();
    expect(first!.quick.filter((shown) => shown.includes("Claude 1"))).toEqual([]);
    expect(commits.filter((commit) => commit.quick.length > 1)).toEqual([]);
    expect(document.querySelectorAll("[data-usage-quick]").length).toBeLessThanOrEqual(1);
    expect(text(quick())).not.toContain("Claude 1");
    expect(q("[data-meter-name]")).toBeNull();
  });

  it("returns focus to the meter after Escape, Back or an outside tap", async () => {
    const layers: { key: string; close?: () => void }[] = [];
    const listen = (event: CustomEvent<{ key: string; close?: () => void }>) => { layers.push(event.detail); };
    window.addEventListener("orbit:back-layer", listen);
    try {
      await mount(makeBot("bot-atlas", "Atlas", "claude"));
      for (const how of ["Escape", "Back", "outside tap"] as const) {
        await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
        expect(quick(), how).not.toBeNull();
        expect(quick(), how).not.toBeNull();
        q<HTMLElement>("[data-quick-close]")?.focus();
        if (how === "Escape") {
          await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
        } else if (how === "Back") {
          const layer = [...layers].reverse().find((each) => each.close);
          expect(layer, "back layer").toBeDefined();
          await act(async () => layer!.close!());
        } else {
          await act(async () => { host.querySelector("main")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
        }
        await settle();
        expect(quick(), how).toBeNull();
        expect(document.activeElement, how).toBe(meter());
        expect(quick(), how).toBeNull();
      }
    } finally {
      window.removeEventListener("orbit:back-layer", listen);
    }
  });

  it("keeps the phone quick view within 60% of the visual viewport", async () => {
    const board = fresh();
    const claude = board.engines[0]!;
    claude.accounts.push(...Array.from({ length: 5 }, (_, i): UsageBoardAccount => ({
      ...structuredClone(claude.accounts[2]!),
      id: `acct_00000000-0000-4000-8000-00000000010${i}`,
      number: 4 + i,
      nickname: `아주긴이름의작업용계정번호${i}입니다그리고더길어집니다`,
      name: `아주긴이름의작업용계정번호${i}입니다그리고더길어집니다`,
    })));
    server.board = board;
    const vv = viewport(390, 844);
    const meterTop = () => vv.offsetTop + vv.height - 132;
    const rect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (!this.closest("[data-usage-meter]")) return rect.call(this);
      const top = meterTop();
      return { x: 0, y: top, top, bottom: top + 28, left: 0, right: 390, width: 390, height: 28, toJSON: () => ({}) } as DOMRect;
    });
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { phone: true, locale: "ko" });
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    const view = quick();
    expect(view, "quick view").not.toBeNull();
    expect(view!.querySelectorAll("[data-account-row]")).toHaveLength(8);
    const scroll = view!.querySelector("[data-quick-scroll]");
    expect(scroll, "scroller").not.toBeNull();
    for (const selector of ["[data-quick-close]", "[data-all-usage]"]) {
      expect(view!.querySelector(selector), selector).not.toBeNull();
      expect(scroll!.contains(view!.querySelector(selector)), selector).toBe(false);
    }
    const heights: number[] = [];
    for (const height of [844, 600, 400, 844]) {
      await vv.resize(height);
      const max = parseFloat(quick()!.style.maxHeight);
      heights.push(max);
      expect(max, `${height}`).toBeGreaterThan(0);
      expect(max, `${height}: 60% of the visual viewport`).toBeLessThanOrEqual(0.6 * height + 0.5);
      expect(meterTop() - max, `${height}: 48 px of the last message`).toBeGreaterThanOrEqual(47.5);
    }
    expect(heights[2]).toBeLessThan(heights[1]!);
    expect(heights[3]).toBe(heights[0]);
    await vv.resize(400);
    const footer = quick()!.querySelector("[data-all-usage]")!.parentElement!;
    expect(footer.contains(quick()!.querySelector("[data-quick-close]")), "a tight view seats Close beside All usage").toBe(true);
    await vv.resize(844);
    expect(footer.isConnected && footer.contains(quick()!.querySelector("[data-quick-close]")), "a roomy view keeps Close in its header").toBe(false);
  });

  it("keeps 48 px of the last message on a short phone, with no 120 px floor", async () => {
    const vv = viewport(390, 844);
    const meterTop = seatMeter(vv);
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { phone: true });
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    expect(quick(), "quick view").not.toBeNull();
    for (const height of [300, 260]) {
      await vv.resize(height);
      const room = meterTop() - 6 - 48;
      const max = parseFloat(quick()!.style.maxHeight);
      expect(room, `${height}`).toBeLessThan(120);
      expect(max, `${height}: the room above the last message`).toBe(room);
      expect(meterTop() - max, `${height}: 48 px of the last message`).toBeGreaterThanOrEqual(47.5);
      expect(quick()!.querySelector("[data-all-usage]"), `${height}: All usage`).not.toBeNull();
    }
  });

  it.each([
    [false, "en"], [true, "en"], [false, "ko"], [true, "ko"],
  ] as const)("shows Today's bars for every account of the chat's engine (phone=%s, %s)", async (phone, locale) => {
    seatMeter(viewport(phone ? 390 : 1280, phone ? 844 : 800));
    const say = (key: Parameters<Mods["i18n"]["translate"]>[1], vars?: Record<string, number>) => m.i18n.translate(locale, key, vars);
    const [h5, d7, noData] = [say("usage.limits.sessionShort"), say("usage.limits.weeklyShort"), say("usage.desk.noData")];
    const reported: Record<string, string[]> = {
      claude: [h5, d7], [CLAUDE_2]: [d7], [CLAUDE_3]: [h5, d7], codex: [d7], [CODEX_2]: [h5, d7], gemini: [say("usage.limits.compactH", { hours: 24 })],
    };
    for (const engine of server.board.engines.filter((each) => each.accounts.some((account) => account.windows.length > 0))) {
      await mount(makeBot("bot-atlas", "Atlas", engine.base), { phone, locale });
      await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
      const view = quick();
      expect(view, `${engine.engine} quick view`).not.toBeNull();
      const rows = [...view?.querySelectorAll("[data-account-row]") ?? []];
      expect(rows.map((node) => node.getAttribute("data-account-row")), engine.engine).toEqual(engine.accounts.map((account) => account.id));
      const group = view?.querySelector('[role="group"].usage-group');
      expect(group?.getAttribute("aria-label"), engine.engine).toBe(ENGINE[engine.engine]);
      expect(rows.every((node) => node.parentElement === group), `${engine.engine} rows in one group`).toBe(true);
      for (const node of rows) {
        const name = text(node.querySelector("[data-account-name]"));
        const bars = node.querySelector("[data-account-bars]");
        expect(bars, `${name} bars`).toBeTruthy();
        expect([...bars?.children ?? []].map((bar) => bar.getAttribute("aria-label")?.split(":")[0]), name)
          .toEqual(reported[node.getAttribute("data-account-row") ?? ""]);
        expect(whoLine(node), name).toBe("");
        const control = node.querySelector("[data-main-check], button[data-use]");
        expect(boxOf(control), name).toEqual(BOX);
        expect(node.querySelector("svg.lucide-check"), name).toBeNull();
      }
      expect(view?.querySelector("[data-window-empty]"), engine.engine).toBeNull();
      expect(text(view)).not.toContain(noData);
      if (engine.engine === "claude") {
        const week = view?.querySelector(`[data-account-row="${CLAUDE_2}"] [data-window="week"]`);
        expect(week?.querySelector("[data-cells]")?.getAttribute("data-cells")).toBe("0");
        expect(week?.querySelector("[data-left]")?.className).toMatch(/\btext-danger\b/);
        expect(text(week?.querySelector("[data-left]"))).toBe(say("usage.desk.windowLeft", { percent: 0 }));
        expect(text(week?.querySelector('[data-reset="week"]'))).toBe(locale === "en" ? "Limit reached · resets in 5d 2h" : "한도 도달 · 5일 2시간 후 초기화");
      }
      expect(view?.querySelector(HIDDEN), `${engine.engine} hero or chart`).toBeNull();
      expect(text(view)).not.toContain(say("usage.desk.quota"));
      expect(text(view?.querySelector("[data-all-usage]"))).toContain(say("usage.chat.allUsage"));
      await unmount();
    }
  });

  it.each([
    [false, "en"], [true, "en"], [false, "ko"], [true, "ko"],
  ] as const)("reads an unused window the same on every quick view account, with no title or not-reported words (phone=%s, %s)", async (phone, locale) => {
    seatMeter(viewport(phone ? 390 : 1280, phone ? 844 : 800));
    const say = (key: Parameters<Mods["i18n"]["translate"]>[1], vars?: Record<string, number>) => m.i18n.translate(locale, key, vars);
    const label = `${say("usage.limits.sessionShort")}: ${say("usage.desk.windowLeft", { percent: 100 })}`;
    server.board = unused(fresh(), "claude", CLAUDE_2, "grok");
    const bars: [string, string | null, string][] = [];
    for (const engine of server.board.engines) {
      await mount(makeBot("bot-atlas", "Atlas", engine.base), { phone, locale });
      await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
      const view = quick();
      expect(view, `${engine.engine} quick view`).not.toBeNull();
      for (const bar of view?.querySelectorAll('[data-window="session"]') ?? []) {
        const id = bar.closest("[data-account-row]")?.getAttribute("data-account-row") ?? "";
        if (["claude", CLAUDE_2, "grok"].includes(id)) bars.push([id, bar.getAttribute("aria-label"), bar.outerHTML]);
      }
      expect(view?.querySelectorAll("[data-account-bars][title], [data-account-bars] [title]"), engine.engine).toHaveLength(0);
      expect(said(view), engine.engine).not.toContain(say("usage.limits.resetUnknown"));
      expect(said(view), engine.engine).not.toMatch(/not reported|보고되지/);
      await unmount();
    }
    expect(bars.map(([id, aria]) => `${id} ${aria}`)).toEqual(["claude", CLAUDE_2, "grok"].map((id) => `${id} ${label}`));
    expect(new Set(bars.map(([, , html]) => html)).size).toBe(1);
  });

  it.each([false, true])("draws every quick view bar as ten boxes, filled ones first, with no glyphs (phone=%s)", async (phone) => {
    seatMeter(viewport(phone ? 390 : 1280, phone ? 844 : 800));
    server.board = unused(fresh(), "grok");
    const on: number[] = [];
    for (const engine of server.board.engines) {
      await mount(makeBot("bot-atlas", "Atlas", engine.base), { phone });
      await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
      expect(quick(), `${engine.engine} quick view`).not.toBeNull();
      on.push(...cellsOn(quick()));
      expect(said(quick()), engine.engine).not.toMatch(GLYPHS);
      await unmount();
    }
    expect(on).toHaveLength(10);
    expect([Math.min(...on), Math.max(...on)]).toEqual([0, 10]);
  });

  it("shows the reset of a binding window that keeps no history, with no empty chart fold", async () => {
    await mount(makeBot("bot-juno", "Juno", "gemini"));
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    const view = quick();
    expect(view, "quick view").not.toBeNull();
    expect(view!.querySelector("[data-window=\"daily\"]")?.getAttribute("aria-label")).toMatch(/Resets in/);
    expect(text(view!.querySelector("[data-reset=\"daily\"]"))).toBe("resets in 9h");
    expect(view!.querySelector("[data-chart-fold]"), "no fold over an empty chart").toBeNull();
    expect(view!.querySelector("[data-empty-state]"), "no empty chart message").toBeNull();
  });

  it("reaches both groups of one driver in Settings, each under its own header", async () => {
    const board = fresh();
    const claude = board.engines[0]!;
    const twin = structuredClone(claude);
    twin.base = "claude-work";
    twin.mainId = "claude-work";
    twin.events = [];
    twin.accounts = [{ ...structuredClone(claude.accounts[0]!), id: "claude-work", name: "Claude Work 1", bots: [] }];
    board.engines.splice(1, 0, twin);
    server.board = board;
    const instances = instancesFor(board).map((each) => each.instanceId === "claude-work" ? { ...each, displayName: "Claude work" } : each);
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { desk: true, instances });
    const sections = [...document.querySelectorAll("[data-usage-desk]:not([data-usage-quick]) section[data-usage-engine]")];
    expect(sections.map((section) => section.getAttribute("data-usage-engine"))).toEqual(board.engines.map((engine) => engine.engine));
    expect(q("[role=\"tab\"]")).toBeNull();
    expect(text(sections[0]?.querySelector("[data-engine-name]")), "the first group").toBe("Claude");
    expect(text(sections[1]?.querySelector("[data-engine-name]")), "the twin header names its instance").toBe("Claude work");
    expect(text(sections[1]?.querySelector("[data-account-row=\"claude-work\"] [data-account-name]")), "the twin group in All usage").toBe("Claude Work 1");
    expect(sections[0]?.querySelector("[data-account-row=\"claude-work\"]")).toBeNull();
    expect(text(sections[0]?.querySelector("[data-account-row=\"claude\"] [data-account-name]")), "the first group keeps its own").toBe("Claude 1");
  });

  it("counts bots instead of cutting their names to a stub", async () => {
    const overflow = (node: Element) => node.closest("[data-account-row]") !== null && node.children.length === 0 && /Atlas, Mira/.test(node.textContent ?? "");
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) { return overflow(this) ? 200 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: Element) { return overflow(this) ? 40 : 0; });
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    const row = quick()!.querySelector("[data-account-row=\"claude\"]");
    expect(row, "row").not.toBeNull();
    expect(row!.querySelector("[data-account-who], [data-bot-count]")).toBeNull();
    expect(text(row)).not.toContain("Atlas, Mira");
  });

  it.each(["en", "ko"] as const)("says No usage yet for an account with no windows, the same in Settings and the quick view (%s)", async (locale) => {
    server.board.engines[0]!.accounts[1]!.windows = [];
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { desk: true, locale });
    const expected = locale === "en" ? "No usage yet" : "아직 사용량 없음";
    const settings = q(`[data-usage-desk]:not([data-usage-quick]) [data-account-row="${CLAUDE_2}"] [data-window-empty]`);
    expect(text(settings), "Settings row").toBe(expected);
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    const row = quick()!.querySelector(`[data-account-row="${CLAUDE_2}"]`);
    const empty = row?.querySelector("[data-window-empty]");
    expect(text(empty), "quick view row").toBe(expected);
    expect(row?.querySelector("[data-window]"), "no meter").toBeNull();
    expect(empty?.outerHTML, "one empty state on both surfaces").toBe(settings?.outerHTML);
  });

  it.each(["en", "ko"] as const)("starts that account's sign-in from the quick view in one tap (%s)", async (locale) => {
    server.board.engines[0]!.accounts[2]!.signIn = "signed-out";
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { locale, instances: signedOut(CLAUDE_3) });
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    const row = () => quick()?.querySelector(`[data-account-row="${CLAUDE_3}"]`);
    const signIn = row()?.querySelector("button[data-sign-in]") ?? null;
    expect(text(signIn)).toBe(locale === "en" ? "Sign In" : "로그인");
    expect(row()?.querySelector("[data-account-head]")?.lastElementChild?.contains(signIn), "Sign In ends the head line").toBe(true);
    expect(boxOf(signIn)).toEqual(BOX);
    expect(text(row()?.querySelector("[data-row-status]"))).toBe(locale === "en" ? "Not signed in" : "로그인되지 않음");
    expect(row()?.querySelector("[data-window], button[data-use], [data-main-check]")).toBeNull();
    await click(signIn);
    expect(quick(), "the quick view stays open").not.toBeNull();
    expect(store.state.appSettingsOpen).toBeFalsy();
    expect(server.calls.filter((call) => call.includes("/sign-in"))).toEqual([`POST /api/instances/${encodeURIComponent(CLAUDE_3)}/sign-in`]);
    expect(text(row())).toContain("ABCD-EFGH");
    expect(text(row()?.querySelector("[data-account-name]"))).toBe("Studio");
    expect(mainPosts()).toEqual([]);
  });

  it.each(["en", "ko"] as const)("shows Signed out on the chat bar for a signed-out Main with no live windows (%s)", async (locale) => {
    const main = server.board.engines[0]!.accounts[0]!;
    main.signIn = "signed-out";
    main.windows = [];
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { locale, instances: signedOut("claude") });
    expect(meter(), "the bar stays").not.toBeNull();
    expect(text(q("[data-meter-name]"))).toBe("Claude 1");
    expect(text(q("[data-meter-signed-out]"))).toBe(locale === "en" ? "Signed out" : "로그아웃됨");
    expect(q("[data-meter-first], [data-meter-second]"), "no percentages").toBeNull();
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    expect(quick(), "Alt+U opens the quick view with no windows").not.toBeNull();
  });

  it("starts the signed-out text where the composer text starts", async () => {
    const main = server.board.engines[0]!.accounts[0]!;
    main.signIn = "signed-out";
    main.windows = [];
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { locale: "en", instances: signedOut("claude") });
    // The composer text sits 36px in: frame px-5 + field px-3 + textarea px-1.
    expect(q("[data-meter-name]")!.parentElement!.className).toContain("px-4");
  });

  it.each(["en", "ko"] as const)("binds a sign-out error to the failed account, not the base engine (%s)", async (locale) => {
    const tool = runtimeErrorTool({
      eventId: "e1", provider: "claudeAgent", providerInstanceId: CLAUDE_3, threadId: "t1", createdAt: new Date(usageBoardNow).toISOString(),
      type: "runtime.error", message: "Claude is not signed in.", signIn: true,
    }, (id) => id === CLAUDE_3);
    const failed: Message = { id: "signed-out", at: usageBoardNow - MIN, role: "bot", kind: "activity", tool: JSON.parse(JSON.stringify(tool)) };
    const instances = signedOut(CLAUDE_3).map((each) => each.instanceId === CLAUDE_3 ? { ...each, displayName: "Studio" } : each);
    await mount(makeBot("bot-atlas", "Atlas", "claude", [failed]), { locale, instances });
    const card = q("[data-sign-in-card]");
    expect(text(card)).toContain(locale === "en" ? "Studio is signed out" : "Studio 계정이 로그아웃됐어요");
    expect(text(card?.querySelector("button"))).toBe(locale === "en" ? "Sign In Again" : "다시 로그인");
    expect(text(card)).not.toContain(locale === "en" ? "Retry" : "다시 시도");
    await click(card?.querySelector("button"));
    expect(server.calls.filter((call) => call.includes("/sign-in"))).toEqual([`POST /api/instances/${encodeURIComponent(CLAUDE_3)}/sign-in`]);
    await act(async () => store.dispatch({ type: "instances", instances: instances.filter((each) => each.instanceId !== CLAUDE_3) }));
    await settle();
    expect(q("[data-sign-in-card]"), "an account that is gone gets the plain error").toBeNull();
    expect(text(q("[data-orbit-transcript]"))).toContain("Claude is not signed in.");
  });

  it("keeps the board quiet through an equal pane poll", async () => {
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    await act(async () => store.dispatch({ type: "setTerminalPanes", panes: { "bot-atlas": ["ATLAS-1"] } }));
    await settle();
    const before = boardGets().length;
    for (let i = 0; i < 3; i += 1) {
      await act(async () => store.dispatch({ type: "setTerminalPanes", panes: { "bot-atlas": ["ATLAS-1"] } }));
      await settle();
    }
    expect(boardGets().length - before, "equal copies").toBe(0);
    await act(async () => store.dispatch({ type: "setTerminalPanes", panes: { "bot-atlas": ["ATLAS-1", "ATLAS-2"] } }));
    await settle();
    expect(boardGets().length - before, "a new worker").toBe(1);
    await unmount();
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { desk: true });
    await settle();
    const desk = boardGets().length;
    await act(async () => store.dispatch({ type: "setTerminalPanes", panes: { "bot-atlas": ["ATLAS-1"] } }));
    await settle();
    expect(boardGets().length - desk, "one read for the line and the desk together").toBe(1);
  });

  it("switches bots without a board request", async () => {
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    expect(q("[data-meter-name]")).toBeNull();
    expect(boardGets().length).toBeGreaterThan(0);
    const before = boardGets().length;
    await show(makeBot("bot-kai", "Kai", "codex"));
    await settle();
    expect(q("[data-meter-name]")).toBeNull();
    expect(text(meter()?.querySelectorAll("[data-window]")[0]?.querySelector("[data-left]"))).toBe("62%");
    expect(meter()?.querySelectorAll("[data-window]")).toHaveLength(1);
    await show(makeBot("bot-atlas", "Atlas", "claude"));
    await settle();
    expect(q("[data-meter-name]")).toBeNull();
    expect(boardGets().length - before).toBe(0);
    await show(makeBot("bot-kai", "Kai", "codex"));
    await settle();
    const press = new CustomEvent("orbit:usage-key", { cancelable: true });
    await act(async () => { window.dispatchEvent(press); });
    await settle();
    expect(press.defaultPrevented, "Alt+U after a switch reaches the new line").toBe(true);
    expect(quick(), "Alt+U after a switch opens the new line's view").not.toBeNull();
  });

  it("follows the drain destination of a draining Main", async () => {
    const draining = (phase: "draining" | "failed") => instancesFor(server.board).map((instance) =>
      instance.instanceId === "claude" ? { ...instance, drain: { destinationId: CLAUDE_3, phase } } : instance);
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { instances: draining("draining") });
    expect(q("[data-meter-name]")).toBeNull();
    expect(text(meter()?.querySelectorAll("[data-window]")[0]?.querySelector("[data-left]"))).toBe("40%");
    expect(text(meter()?.querySelectorAll("[data-window]")[1]?.querySelector("[data-left]"))).toBe("78%");
    await act(async () => store.dispatch({ type: "instances", instances: draining("failed") }));
    await settle();
    expect(q("[data-meter-name]")).toBeNull();
    expect(text(meter()?.querySelectorAll("[data-window]")[0]?.querySelector("[data-left]"))).toBe("34%");
  });

  it("shares one pending Main request with Usage", async () => {
    server.post = () => new Promise<Response>(() => {});
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { desk: true });
    await act(async () => { window.dispatchEvent(new Event("orbit:usage-key", { cancelable: true })); });
    await settle();
    const use = (id: string) => quick()?.querySelector(`[data-account-row="${id}"] button[data-use]`);
    await click(use(CLAUDE_3));
    await click(use(CLAUDE_3));
    await click(use(CLAUDE_2));
    await click(q(`[data-usage-desk] [data-account-row="${CLAUDE_2}"] button[data-use]`));
    expect(mainPosts()).toEqual([`POST /api/accounts/${encodeURIComponent(CLAUDE_3)}/default`]);
  });

  it.each(["en", "ko"] as const)("shows All usage on the wait card and no account switch (%s)", async (locale) => {
    await mount(makeBot("bot-atlas", "Atlas", "claude", [limitMessage("You've hit your usage limit.", waiting)]), { locale });
    const card = q("[data-usage-wait]");
    expect(card, "wait card").not.toBeNull();
    const all = card!.querySelector("[data-all-usage]");
    expect(all, "All usage").not.toBeNull();
    expect(text(all)).toBe(locale === "en" ? "All usage in Settings" : "설정의 전체 사용량");
    expect(text(card)).toContain(m.i18n.translate(locale, "chat.cancelQueuedAction"));
    const labels = [...card!.querySelectorAll("button")].filter((button) => !button.hasAttribute("data-all-usage"))
      .map((button) => `${text(button)} ${button.getAttribute("aria-label") ?? ""}`);
    expect(labels.filter((label) => /\bUse\b|사용(?!량)/.test(label))).toEqual([]);
    expect(card!.querySelector("[data-use], [data-account-name], [data-tile], [data-account-row], svg:not(.lucide) path")).toBeNull();
    for (const name of ["Claude 1", "Claude 2", "Studio"]) expect(text(card)).not.toContain(name);
    await click(all);
    expect(store.state.appSettingsOpen).toBe(true);
    expect(store.state.appSettingsSection).toBe("usage");
  });

  it("keeps engine details readable without a toggle", async () => {
    const raw = `Rate limited for ${canary.address} on ${canary.domain}. Try again later.`;
    await mount(makeBot("bot-atlas", "Atlas", "claude", [limitMessage(raw, waiting)]));
    const card = q("[data-usage-wait]");
    expect(card, "wait card").not.toBeNull();
    expect(card!.querySelector("[data-engine-details]")).toBeNull();
    expect(card!.querySelector("[aria-expanded]")).toBeNull();
    const body = card!.querySelector("[data-engine-details-body]");
    expect(text(body)).toContain("Rate limited for");
    expect(text(body)).toContain("Try again later.");
    await act(async () => { card!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
    expect(card!.querySelector("[data-engine-details-body]"), "still shown after a touch").toBe(body);
    expect(text(card!.querySelector("[data-all-usage]"))).toBe("All usage in Settings");
    const titles = [...document.querySelectorAll("[title]")].map((node) => node.getAttribute("title") ?? "");
    expect(titles.filter((title) => title.includes("Rate limited"))).toEqual([]);
    expect(scanForCanary(canary)).toEqual([]);
  });
});
