// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usageBoardFixture, usageBoardNow } from "@/lib/usage-board.fixture";
import type { UsageBoard } from "@/lib/usage-board";
import type { Bot, InstanceInfo, useStore } from "@/state/store";

const h = vi.hoisted(() => ({ store: null as ReturnType<typeof useStore> | null }));
vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return { ...actual, useStore: () => {
    const value = actual.useStore();
    h.store = value;
    return value;
  } };
});

import App from "./App";

const MIN = 60_000;
const DRIVER: Record<string, string> = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", gemini: "antigravityAgent", muse: "museAgent" };

function instancesFor(board: UsageBoard): InstanceInfo[] {
  return board.engines.flatMap((engine) => engine.accounts.map((account): InstanceInfo => ({
    instanceId: account.id,
    driverKind: DRIVER[engine.engine]!,
    displayName: engine.engine,
    accountOf: engine.base,
    accountState: "ready",
    accountMain: account.id === engine.mainId,
    snapshot: { state: "available", authenticated: true },
    models: { default: "model", options: [{ id: "model", label: "Model" }] },
    capabilities: { rateLimits: true },
    rateLimits: {
      observedAt: new Date(usageBoardNow - MIN).toISOString(),
      windows: account.windows.map(({ id, usedPercent, resetsAt }) => ({ id, usedPercent, resetsAt })),
    },
  })));
}
const muse: InstanceInfo = {
  instanceId: "muse", driverKind: "museAgent", displayName: "Muse",
  snapshot: { state: "available", authenticated: true },
  models: { default: "model", options: [{ id: "model", label: "Model" }] },
};
const botOn = (instanceId: string): Bot => ({
  id: "bot-atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", color: "blue",
  notifications: false, unread: false, busy: false, cwd: "/repo",
  modelSelection: { instanceId, model: "model", effort: "high" },
  messages: [{ id: "q", at: usageBoardNow - MIN, role: "user", kind: "text", text: "Still going" }],
});

const quick = () => document.body.querySelector("[data-usage-quick]");
const settings = () => h.store!.state.appSettingsOpen ? h.store!.state.appSettingsSection : null;
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
let cleanup: (() => Promise<void>) | null = null;
const keys: Event[] = [];
const onKey = (event: Event) => { keys.push(event); };

async function mount(bot: Bot, instances: InstanceInfo[]) {
  localStorage.setItem("omb-onboarding-done", "true");
  vi.useFakeTimers({ now: usageBoardNow, toFake: ["Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/api/usage/board")
    ? new Response(JSON.stringify(usageBoardFixture), { headers: { "content-type": "application/json" } })
    : new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  keys.length = 0;
  window.addEventListener("orbit:usage-key", onKey);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(App)));
  await act(async () => {
    h.store!.dispatch({ type: "instances", instances });
    h.store!.dispatch({ type: "connected", value: true });
    h.store!.dispatch({ type: "hydrate", bots: [bot], groups: [], computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } });
  });
  await settle();
}
async function press(init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { code: "KeyU", key: "u", altKey: true, bubbles: true, cancelable: true, ...init });
  await act(async () => { window.dispatchEvent(event); });
  await settle();
  return event;
}

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  window.removeEventListener("orbit:usage-key", onKey);
  document.body.replaceChildren();
  h.store = null;
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Alt+U", () => {
  it("opens the quick view, then all Usage, then closes on Alt+U", async () => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture));
    expect((await press()).defaultPrevented).toBe(true);
    expect(quick(), "quick view").not.toBeNull();
    expect(settings()).toBeNull();
    await press();
    expect(quick()).toBeNull();
    expect(settings()).toBe("usage");
    await press();
    expect(settings()).toBeNull();
    expect(quick()).toBeNull();
  });

  it("opens all Usage on Alt+U with no eligible meter", async () => {
    await mount(botOn("muse"), [...instancesFor(usageBoardFixture), muse]);
    expect(document.body.querySelector("[data-usage-meter]")).toBeNull();
    expect((await press()).defaultPrevented).toBe(true);
    expect(settings()).toBe("usage");
    expect(quick()).toBeNull();
    expect(keys.map((event) => event.cancelable)).toEqual([true]);
  });

  it("opens all Usage on Alt+U while the terminal covers the chat", async () => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture));
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", key: "`", ctrlKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(document.body.querySelector('.orbit-terminal-overlay[data-open="true"]'), "terminal open").not.toBeNull();
    await press();
    expect(quick(), "hidden chat's quick view").toBeNull();
    expect(settings()).toBe("usage");
  });

  it("shuts an open quick view when the terminal covers the chat and keeps it shut after", async () => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture));
    await press();
    expect(quick(), "quick view").not.toBeNull();
    const backquote = () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", key: "`", ctrlKey: true, bubbles: true, cancelable: true })); });
    await backquote();
    await settle();
    expect(document.body.querySelector('.orbit-terminal-overlay[data-open="true"]'), "terminal open").not.toBeNull();
    expect(quick(), "view over the terminal").toBeNull();
    await backquote();
    await settle();
    expect(document.body.querySelector('.orbit-terminal-overlay[data-open="true"]'), "terminal shut").toBeNull();
    expect(quick(), "view back after the terminal").toBeNull();
  });

  it.each([
    { code: "KeyT", key: "t", altKey: true },
    { code: "KeyI", key: "i", altKey: true },
    { code: "KeyK", key: "k", ctrlKey: true, altKey: false },
  ])("shuts the quick view when an app overlay opens ($code)", async (shortcut) => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture));
    await press();
    expect(quick()).not.toBeNull();
    await press(shortcut);
    expect(quick(), "view over the app overlay").toBeNull();
    await press({ code: "Escape", key: "Escape", altKey: false });
    expect(quick(), "view after the overlay closes").toBeNull();
  });

  it("leaves Settings shut when a view takes Alt+U", async () => {
    await mount(botOn("muse"), [...instancesFor(usageBoardFixture), muse]);
    const take = (event: Event) => event.preventDefault();
    window.addEventListener("orbit:usage-key", take);
    try {
      await press();
      expect(keys).toHaveLength(1);
      expect(settings()).toBeNull();
    } finally {
      window.removeEventListener("orbit:usage-key", take);
    }
    await press();
    expect(settings()).toBe("usage");
  });

  it("ignores Alt+U repeats and composition", async () => {
    await mount(botOn("claude"), instancesFor(usageBoardFixture));
    for (const init of [{ repeat: true }, { isComposing: true }]) {
      await press(init);
      expect(settings(), JSON.stringify(init)).toBeNull();
      expect(quick(), JSON.stringify(init)).toBeNull();
    }
    expect(keys).toHaveLength(0);
    await press();
    expect(quick(), "quick view").not.toBeNull();
    await press({ repeat: true });
    expect(quick()).not.toBeNull();
    expect(settings()).toBeNull();
  });
});
