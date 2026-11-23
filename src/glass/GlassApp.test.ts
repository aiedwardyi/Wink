// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n-catalog";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";

import { GlassApp } from "./GlassApp";

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const models = { default: "claude-opus-5-5", options: [{ id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-sonnet-5-5", label: "Sonnet 5.5" }] };
const ready: InstanceInfo = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" }, models };
const missing: InstanceInfo = { ...ready, snapshot: { state: "unavailable" } };
const chat: Message[] = [{ id: "u1", at: 1, role: "user", kind: "text", text: "hi" }, { id: "b1", at: 2, role: "bot", kind: "text", text: "Hello" }];
const atlas = (extra: Partial<Bot> = {}): Bot => ({
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: false, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, messages: chat, hasMore: false, ...extra,
});

let root: Root | undefined;
const calls: { url: string; method: string }[] = [];

/** The real store, started from its saved snapshot; the server answers nothing. */
async function mount(bot: Bot, instances: InstanceInfo[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    return new Response("{}", { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ bots: [bot], groups: [], selectedId: bot.id, instances }));
  history.replaceState(null, "", "/glasses");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(GlassApp)));
}

const press = (key: string) => act(() => {
  (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
});
const focus = (role: string) => act(() => document.querySelector<HTMLElement>(`.glass [data-glass="${role}"]`)?.focus());
const posts = (path: RegExp) => calls.filter((call) => call.method !== "GET" && path.test(call.url));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  calls.length = 0;
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("glasses chat after a failed turn", () => {
  const failed = (busy: boolean, error: string) => atlas({
    busy,
    messages: [...chat, { id: "u2", at: 3, role: "user", kind: "text", text: "and now?" }, { id: "e1", at: 4, role: "bot", kind: "activity", tool: { name: "error: " + error } }],
  });
  const shown = () => ({
    time: document.querySelector(".glass-time")?.textContent,
    text: document.querySelector(".glass-scroll")?.textContent,
    caret: document.querySelector(".glass-caret") !== null,
    you: document.querySelector(".glass-you")?.textContent,
  });

  it.each([
    ["stream disconnected before completion", en["errors.engine"]],
    ["something nobody planned for", en["errors.unfinished"].replace("{bot}", "Atlas")],
  ])("stops Working and shows the phone's error line for %j", async (error, text) => {
    await mount(failed(false, error), [ready]);
    expect(shown()).toEqual({ time: expect.not.stringContaining("Working"), text, caret: false, you: "and now?" });
  });

  it("keeps Working while the turn still runs", async () => {
    await mount(failed(true, "stream disconnected before completion"), [ready]);
    expect(shown()).toMatchObject({ time: "Working…", caret: true, you: "and now?" });
  });
});

describe("glasses keys", () => {
  it("two fast Enters on Send send once and stay on the chat", async () => {
    await mount(atlas(), [ready]);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      return new Promise<Response>(() => {});
    }));
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const speak = document.querySelector<HTMLInputElement>('[data-glass="speak"]');
    if (speak) speak.value = "ship it";
    focus("speak");
    await press("Enter");
    expect(document.querySelector('[data-glass="send"]')).not.toBeNull();
    focus("send");
    await press("Enter");
    await press("Enter");
    expect(posts(/\/messages/)).toHaveLength(1);
    expect(back).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-glass="send"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-glass")).toBe("speak");
  });

  it("two fast Enters on a model pick it once and stay on the chat", async () => {
    await mount(atlas(), [ready]);
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    focus("header");
    await press("Enter");
    expect(document.querySelector(".glass-wheel")).not.toBeNull();
    await press("ArrowDown");
    await press("Enter");
    await press("Enter");
    expect(posts(/./)).toHaveLength(1);
    expect(back).toHaveBeenCalledOnce();
    expect(document.querySelector(".glass-wheel")).toBeNull();
  });

  it("Enter on the model chip does nothing when no model can be picked", async () => {
    await mount(atlas(), [missing]);
    const push = vi.spyOn(history, "pushState");
    focus("header");
    await press("Enter");
    await press("Enter");
    expect(push).not.toHaveBeenCalled();
    expect(document.querySelector(".glass-wheel")).toBeNull();
    expect(document.activeElement?.classList.contains("glass-chip")).toBe(true);
  });
});

describe("glasses thread fixes", () => {
  const gemini: InstanceInfo = {
    instanceId: "gem", driverKind: "antigravityAgent", displayName: "Gemini", snapshot: { state: "available" },
    models: { default: "gemini-4-carbon-high", options: [{ id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)" }, { id: "gemini-4-carbon-medium", label: "Gemini 4 Carbon (Medium)" }, { id: "gemini-4-carbon-low", label: "Gemini 4 Carbon (Low)" }] },
  };
  const scroll = () => document.querySelector(".glass-scroll")?.textContent;

  it("Enter on the current model row keeps a non-first Gemini tier", async () => {
    await mount(atlas({ modelSelection: { instanceId: "gem", model: "gemini-4-carbon-medium" } }), [gemini]);
    vi.spyOn(history, "back").mockImplementation(() => {});
    focus("header");
    await press("Enter");
    expect(document.querySelector(".glass-wheel")).not.toBeNull();
    await press("Enter");
    expect(posts(/./)).toHaveLength(0);
  });

  it("keeps the failure line when a turn fails after it wrote some text", async () => {
    await mount(
      atlas({ messages: [...chat, { id: "u2", at: 3, role: "user", kind: "text", text: "and now?" }, { id: "b2", at: 4, role: "bot", kind: "text", text: "Partial" }, { id: "e1", at: 5, role: "bot", kind: "activity", tool: { name: "error: stream disconnected before completion" } }] }),
      [ready],
    );
    expect(scroll()).toBe(en["errors.engine"]);
  });

  it("does not show an engine summary as the bot's reply", async () => {
    await mount(atlas({ messages: [...chat, { id: "b2", at: 3, role: "bot", kind: "text", text: "Looking at the files", summarized: true }] }), [ready]);
    expect(scroll()).toBe("Hello");
  });

  it("brings the voice draft back when the send is rejected", async () => {
    await mount(atlas(), [ready]);
    vi.spyOn(history, "back").mockImplementation(() => {});
    const speak = document.querySelector<HTMLInputElement>('[data-glass="speak"]');
    if (speak) speak.value = "ship it";
    focus("speak");
    await press("Enter");
    focus("send");
    await press("Enter");
    await vi.waitFor(() => expect(document.querySelector(".glass-dtext")?.textContent).toBe("ship it"));
  });
});
