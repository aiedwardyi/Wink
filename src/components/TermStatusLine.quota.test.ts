// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard } from "@/lib/usage-board";
import type { Bot, InstanceInfo } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const SKINS = ["terminal", "terminal-dracula", "terminal-ice", "paper-tape", "logfile", "multiplexer", "modal"] as const;
const DRIVER: Record<string, string> = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", gemini: "antigravityAgent", muse: "museAgent" };

type Mods = {
  store: typeof import("@/state/store");
  term: typeof import("./TermStatusLine");
  desktop: typeof import("./DesktopCapabilities");
  i18n: typeof import("@/lib/i18n");
};
let m: Mods;
let host: HTMLDivElement;
let root: Root;
let store: ReturnType<Mods["store"]["useStore"]>;
const matchMedia = window.matchMedia;
const getContext = HTMLCanvasElement.prototype.getContext;

const text = (node: Element | null | undefined) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

function instancesFor(board: UsageBoard): InstanceInfo[] {
  return board.engines.flatMap((engine) => engine.accounts.map((account): InstanceInfo => ({
    instanceId: account.id,
    driverKind: DRIVER[engine.engine]!,
    displayName: engine.engine,
    accountOf: engine.base,
    accountState: "ready",
    accountMain: account.id === engine.mainId,
    snapshot: { state: "available", authenticated: true },
    models: { default: "model", options: [{ id: "model", label: "Claude Sonnet 4.6 (Thinking)" }] },
    capabilities: { rateLimits: true },
    rateLimits: {
      observedAt: new Date(usageBoardNow - MIN).toISOString(),
      windows: account.windows.map(({ id, usedPercent, resetsAt }) => ({ id, usedPercent, resetsAt })),
    },
  })));
}
const muse = (windows: boolean): InstanceInfo => ({
  instanceId: "muse", driverKind: "museAgent", displayName: "Muse",
  snapshot: { state: "available", authenticated: true },
  models: { default: "model", options: [{ id: "model", label: "Muse model" }] },
  rateLimits: windows ? {
    observedAt: new Date(usageBoardNow - MIN).toISOString(),
    windows: [{ id: "five_hour", usedPercent: 20, resetsAt: usageBoardNow + 60 * MIN }],
  } : undefined,
});
const botOn = (instanceId: string): Bot => ({
  id: "bot-atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", color: "blue",
  notifications: false, unread: false, cwd: "/home/fern/work/app",
  modelSelection: { instanceId, model: "model", effort: "high" },
  messages: [],
});

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

async function load(braille: number) {
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (glyph: string) => ({ width: /[⠀-⣿]/.test(glyph) ? braille : 7.2 }),
  })) as unknown as typeof getContext;
  vi.resetModules();
  m = {
    store: await import("@/state/store"),
    term: await import("./TermStatusLine"),
    desktop: await import("./DesktopCapabilities"),
    i18n: await import("@/lib/i18n"),
  };
}

async function mount(bot: Bot, instances: InstanceInfo[], { skin = "terminal", phone = false, locale = "en" }: { skin?: string; phone?: boolean; locale?: "en" | "ko" } = {}) {
  document.documentElement.dataset.skin = skin;
  setMedia(phone);
  m.i18n.applyLocale(locale);
  function Harness() {
    store = m.store.useStore();
    return createElement(m.term.TermStatusLine, { bot, engine: instances.find((each) => each.instanceId === bot.modelSelection.instanceId) });
  }
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(m.store.StoreProvider, null,
    createElement(m.desktop.DesktopCapabilitiesProvider, null, createElement(Harness)))));
  await act(async () => store.dispatch({ type: "instances", instances }));
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
}

beforeEach(async () => {
  vi.useFakeTimers({ now: usageBoardNow, toFake: ["Date"] });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/usage/board")
    ? new Response(JSON.stringify(usageBoardFixture), { headers: { "content-type": "application/json" } })
    : new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { close() {} });
  await load(7.2);
});
afterEach(async () => {
  if (host?.isConnected) await unmount();
  HTMLCanvasElement.prototype.getContext = getContext;
  window.matchMedia = matchMedia;
  delete window.ogb;
  delete document.documentElement.dataset.skin;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("terminal status line quota ticker", () => {
  it("draws no glyph trace, with or without braille", async () => {
    for (const width of [3, 7.2]) {
      await load(width);
      await mount(botOn("claude"), instancesFor(usageBoardFixture));
      const ticker = q("[data-term-ticker]");
      expect(ticker, "ticker").not.toBeNull();
      expect(ticker!.querySelector("[data-glyphs]")).toBeNull();
      expect(text(ticker)).not.toMatch(/[⠀-⣿▁-█]/);
      await unmount();
    }
  });

  it("opens the quick view from the ticker, else all Usage", async () => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture));
    const ticker = q("[data-term-ticker]");
    expect(ticker, "ticker").not.toBeNull();
    await act(async () => ticker!.click());
    await settle();
    expect(q("[data-usage-quick]"), "quick view").not.toBeNull();
    expect(store.state.appSettingsOpen).toBe(false);
    await unmount();
    await mount(botOn("muse"), [...instancesFor(usageBoardFixture), muse(true)]);
    await act(async () => q("[data-term-ticker]")!.click());
    await settle();
    expect(q("[data-usage-quick]")).toBeNull();
    expect(store.state.appSettingsOpen).toBe(true);
    expect(store.state.appSettingsSection).toBe("usage");
  });

  it("keeps model, home folder and effort on desktop with no quota data", async () => {
    window.ogb = { platform: "linux", getCapabilities: async () => ({
      ...(await import("@/lib/desktop")).initialDesktopCapabilities(),
      host: { platform: "linux", label: "Linux", session: "unknown", packaged: false, homeDir: "/home/fern" },
    }) } as unknown as NonNullable<typeof window.ogb>;
    await mount(botOn("muse"), [muse(false)]);
    const status = q("[data-term-status]");
    expect(text(status)).toContain("Muse model");
    expect(text(status)).toContain("~/work/app");
    expect(text(status)).toContain("high");
    expect(status!.querySelector("[data-term-ticker]")).toBeNull();
    expect(text(status)).not.toMatch(/%/);
  });

  it.each(SKINS)("renders the ticker with a window and reset summary in %s", async (skin) => {
    for (const locale of ["en", "ko"] as const) {
      await mount(botOn("claude"), instancesFor(usageBoardFixture), { skin, locale });
      const ticker = q("[data-term-ticker]");
      expect(ticker, `${skin} ${locale}`).not.toBeNull();
      expect(ticker!.tagName).toBe("BUTTON");
      const summary = text(ticker!.querySelector(".sr-only"));
      if (locale === "en") expect(summary).toMatch(/^5h 34% left, resets \S/);
      else expect(summary).toMatch(/5시간.*34%/);
      expect(text(q("[data-term-status]"))).toContain("Claude Sonnet 4.6 (Thinking)");
      await unmount();
    }
  });

  it("prefixes [n] on a multi-account line only for an unnamed account", async () => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture));
    expect(text(q("[data-term-ticker]"))).toContain("[1]");
    await unmount();
    const board = structuredClone(usageBoardFixture);
    const claude = board.engines.find((each) => each.engine === "claude")!;
    claude.mainId = claude.accounts.find((each) => each.nickname)!.id;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/usage/board")
      ? new Response(JSON.stringify(board), { headers: { "content-type": "application/json" } })
      : new Promise<Response>(() => {})));
    await load(7.2);
    await mount(botOn("claude"), instancesFor(board));
    expect(q("[data-term-ticker]"), "ticker").not.toBeNull();
    expect(text(q("[data-term-ticker]"))).not.toMatch(/\[\d+\]/);
  });

  it("keeps the Multiplexer bot tab and only the tightest window on a phone", async () => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture), { skin: "multiplexer", phone: true });
    const status = q("[data-term-status]");
    expect(status?.getAttribute("data-term-phone")).toBe("multiplexer");
    expect(text(status!.querySelector("[data-term-tab]"))).toBe("0:Atlas*");
    expect(text(status!.querySelector("[data-term-model]"))).toBe("Sonnet 4.6");
    const ticker = status!.querySelector("[data-term-ticker]");
    expect(ticker, "ticker").not.toBeNull();
    expect(text(ticker)).toContain("34%");
    expect(text(ticker)).not.toContain("59%");
  });

  it("leaves the first Alt+U to all Usage while the ticker is hidden", async () => {
    const board = structuredClone(usageBoardFixture);
    for (const engine of board.engines) for (const account of engine.accounts) account.windows = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/usage/board")
      ? new Response(JSON.stringify(board), { headers: { "content-type": "application/json" } })
      : new Promise<Response>(() => {})));
    const instances = instancesFor(board).map((each) => ({ ...each, rateLimits: { observedAt: new Date(usageBoardNow - MIN).toISOString(), windows: [] } }));
    await mount(botOn("claude"), instances);
    expect(q("[data-term-status]"), "status line").not.toBeNull();
    expect(q("[data-term-ticker]"), "hidden ticker").toBeNull();
    const press = new CustomEvent("orbit:usage-key", { cancelable: true });
    await act(async () => { window.dispatchEvent(press); });
    expect(press.defaultPrevented, "the first Alt+U reaches all Usage").toBe(false);
  });
});
