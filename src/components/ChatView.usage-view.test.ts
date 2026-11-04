// @vitest-environment happy-dom
import { act, createElement, Fragment, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeIdentityCanary, scanForCanary, type IdentityCanary } from "@/lib/identity-canary";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard, UsageBoardAccount } from "@/lib/usage-board";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { UsageWaitView } from "../../server/limit-wait-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const CLAUDE_2 = "acct_00000000-0000-4000-8000-000000000002";
const CLAUDE_3 = "acct_00000000-0000-4000-8000-000000000003";
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
const text = (node: Element | null | undefined) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
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
const key = async (node: Element, name: string) => {
  const down = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  await act(async () => { node.dispatchEvent(down); });
  if (!down.defaultPrevented && node instanceof HTMLButtonElement) await act(async () => node.click());
  await settle();
};

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
      await click(trigger);
      expect(quick(), "quick view").not.toBeNull();
      scan("open quick view");
      for (const node of quick()!.querySelectorAll("button, [tabindex]")) await poke(node);
      scan("quick view hover and focus");
      await click(quick()!.querySelector("[data-chart-fold]"));
      scan("chart fold");
      for (const count of quick()!.querySelectorAll("button[data-bot-count]")) await click(count);
      scan("names");
      const picker = quick()!.querySelector('button[aria-haspopup="menu"]');
      if (picker) {
        await click(picker);
        scan("open picker");
        await click(picker);
        scan("closing picker");
      }
      await click(quick()!.querySelector(`[data-account-row="${CLAUDE_3}"] button[data-use]`));
      expect(quick()!.querySelector('[role="alert"]'), "failed Main save").not.toBeNull();
      scan("failed Main save");
      const card = q("[data-usage-wait]");
      expect(card, "wait card").not.toBeNull();
      await click(card!.querySelector("[data-engine-details]"));
      expect(card!.querySelector("[data-engine-details-body]"), "engine details").not.toBeNull();
      scan("engine details");
      await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
      scan("closing quick view");
      await settle();
      scan("closed");
      await unmount();
    }
    expect(scans.length).toBeGreaterThanOrEqual(4 * 9);
  });

  it("puts the binding fact first and paints today's values before the first board read", async () => {
    const read = deferred<UsageBoard>();
    server.read = () => read.promise;
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    expect(meter(), "meter before the board").not.toBeNull();
    expect(text(q("[data-meter-name]"))).toBe("Claude");
    expect(text(q("[data-meter-first]"))).toBe("5h 29%");
    expect(text(q("[data-meter-second]"))).toBe("7d 54%");
    const board = fresh();
    board.engines[0]!.accounts[0]!.windows[1]!.usedPercent = 90;
    await act(async () => read.resolve(board));
    await settle();
    expect(text(q("[data-meter-name]"))).toBe("Claude 1");
    expect(text(q("[data-meter-first]"))).toBe("7d 10%");
    expect(text(q("[data-meter-second]"))).toBe("5h 34%");
  });

  it("closes the old quick view before the next bot renders", async () => {
    await mount(makeBot("bot-atlas", "Atlas", "claude"));
    await click(meter());
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
    expect(text(q("[data-meter-name]"))).toBe("Codex 1");
  });

  it("returns focus to the meter after Escape, Back or an outside tap", async () => {
    const layers: { key: string; close?: () => void }[] = [];
    const listen = (event: CustomEvent<{ key: string; close?: () => void }>) => { layers.push(event.detail); };
    window.addEventListener("orbit:back-layer", listen);
    try {
      await mount(makeBot("bot-atlas", "Atlas", "claude"));
      for (const how of ["Escape", "Back", "outside tap"] as const) {
        await click(meter());
        expect(quick(), how).not.toBeNull();
        expect(meter()!.getAttribute("aria-expanded"), how).toBe("true");
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
        expect(meter()!.getAttribute("aria-expanded"), how).toBe("false");
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
    await click(meter());
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

  it("shows the reset of a binding window that keeps no history, with no empty chart fold", async () => {
    await mount(makeBot("bot-juno", "Juno", "gemini"));
    await click(meter());
    const view = quick();
    expect(view, "quick view").not.toBeNull();
    const extra = view!.querySelector("[data-reset=\"extra\"]");
    expect(text(extra), "the daily reset line").toMatch(/Resets in/);
    expect(view!.querySelector("[data-chart-fold]"), "no fold over an empty chart").toBeNull();
    expect(view!.querySelector("[data-empty-state]"), "no empty chart message").toBeNull();
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
    expect(text(q("[data-meter-name]"))).toBe("Claude 1");
    expect(boardGets().length).toBeGreaterThan(0);
    const before = boardGets().length;
    await show(makeBot("bot-kai", "Kai", "codex"));
    await settle();
    expect(text(q("[data-meter-name]"))).toBe("Codex 1");
    expect(text(q("[data-meter-first]"))).toBe("7d 62%");
    expect(text(q("[data-meter-second]"))).toBe("Weekly only");
    await show(makeBot("bot-atlas", "Atlas", "claude"));
    await settle();
    expect(text(q("[data-meter-name]"))).toBe("Claude 1");
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
    expect(text(q("[data-meter-name]"))).toBe("Studio");
    expect(text(q("[data-meter-first]"))).toBe("5h 40%");
    expect(text(q("[data-meter-second]"))).toBe("7d 78%");
    await act(async () => store.dispatch({ type: "instances", instances: draining("failed") }));
    await settle();
    expect(text(q("[data-meter-name]"))).toBe("Claude 1");
    expect(text(q("[data-meter-first]"))).toBe("5h 34%");
  });

  it("shares one pending Main request with Usage", async () => {
    server.post = () => new Promise<Response>(() => {});
    await mount(makeBot("bot-atlas", "Atlas", "claude"), { desk: true });
    await click(meter());
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

  it("keeps engine details readable by touch and keyboard", async () => {
    const raw = `Rate limited for ${canary.address} on ${canary.domain}. Try again later.`;
    await mount(makeBot("bot-atlas", "Atlas", "claude", [limitMessage(raw, waiting)]));
    const card = q("[data-usage-wait]");
    expect(card, "wait card").not.toBeNull();
    const details = card!.querySelector<HTMLButtonElement>("[data-engine-details]");
    expect(details?.tagName).toBe("BUTTON");
    expect(details!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { details!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })); });
    await click(details);
    expect(details!.getAttribute("aria-expanded")).toBe("true");
    const body = card!.querySelector("[data-engine-details-body]");
    expect(text(body)).toContain("Rate limited for");
    expect(text(body)).toContain("Try again later.");
    await click(details);
    expect(details!.getAttribute("aria-expanded")).toBe("false");
    details!.focus();
    expect(document.activeElement).toBe(details);
    await key(details!, "Enter");
    expect(details!.getAttribute("aria-expanded")).toBe("true");
    await key(details!, " ");
    expect(details!.getAttribute("aria-expanded")).toBe("false");
    await key(details!, "Enter");
    const titles = [...document.querySelectorAll("[title]")].map((node) => node.getAttribute("title") ?? "");
    expect(titles.filter((title) => title.includes("Rate limited"))).toEqual([]);
    expect(scanForCanary(canary)).toEqual([]);
  });
});
