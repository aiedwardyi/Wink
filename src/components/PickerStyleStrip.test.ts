import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { Bot, InstanceInfo } from "@/state/store";
import { ModelPickerControl } from "./ModelPicker";
import { TileRow } from "./PickerStyleStrip";

const L5 = ["low", "medium", "high", "xhigh", "max"] as const;
const dispatch = vi.fn();
let root: Root;

function engine(instanceId: string, driverKind: string, ids: string[], local: string[] = []): InstanceInfo {
  return {
    instanceId, driverKind, displayName: instanceId,
    snapshot: { state: "available", authenticated: true },
    models: { default: ids[0]!, options: [...ids.map((id) => ({ id, label: id })), ...local.map((id) => ({ id, label: id, custom: true }))] },
    capabilities: { effortLevels: [...L5] },
  };
}

function media() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("reduce") ? false : query.split(", ").some((part) => !part.startsWith("(max-width")),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

async function mount(view = "dial", dial = true) {
  localStorage.setItem("omb-model-picker-view", view);
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"], ["local-llama"]),
    engine("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"]),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Style", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high", mode: "pinned" } };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(ModelPickerControl, {
      bot,
      store: { state: { instances, selectedId: "bot-1" }, dispatch, refreshInstances: async () => undefined },
      defaultOpen: true,
      dial,
    })));
  });
}

async function press(key: string, init: KeyboardEventInit = {}, target: Element | null = document.activeElement) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { (target ?? document.body).dispatchEvent(event); });
  return event;
}

const altS = (shiftKey = false, target?: Element | null) => press(shiftKey ? "S" : "s", { code: "KeyS", altKey: true, shiftKey }, target);
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const strip = () => document.querySelector("[data-picker-style-strip]");
const shown = () => document.querySelector("[data-picker-style-button]")?.getAttribute("data-picker-view");
const picker = () => document.querySelector("[data-model-picker-content]");
const looks = () => [...document.querySelectorAll("[data-picker-look]")].map((tile) => `${tile.textContent}${tile.getAttribute("aria-checked") === "true" ? "*" : ""}`);
const tap = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const backdrop = () => document.querySelector(".model-cross-backdrop")!;

async function closesWithFade() {
  expect(strip()?.hasAttribute("data-closing")).toBe(true);
  expect(strip()?.classList.contains("animate-pop-in")).toBe(true);
  await wait(PRESENCE_EXIT_MS + 40);
  expect(strip()).toBeNull();
  expect(picker()).not.toBeNull();
}

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  media();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  dispatch.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Picker style strip", () => {
  it("opens with Alt+S and closes with Alt+S, Esc, an outside click or its button, fading like a popover", async () => {
    await mount();
    for (const close of [() => altS(), () => press("Escape"), () => act(async () => { backdrop().dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); }), () => tap("[data-picker-style-button]")]) {
      expect((await altS()).defaultPrevented).toBe(true);
      expect(strip()?.classList.contains("animate-pop-in")).toBe(true);
      expect(strip()?.hasAttribute("data-closing")).toBe(false);
      await close();
      await closesWithFade();
    }
    await press("Escape");
    expect(picker()).toBeNull();
  });

  it("rotates styles live with Alt+Shift+S, strip open or closed, and keeps each", async () => {
    await mount();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await altS(true);
      seen.push([shown(), localStorage.getItem("omb-model-picker-view")]);
    }
    expect(seen).toEqual([["list", "list"], ["chart", "chart"], ["machine", "machine"], ["dial", "dial"]]);
    expect(strip()).toBeNull();
    await altS();
    await altS(true);
    expect([shown(), strip()?.querySelector('[aria-checked="true"]')?.getAttribute("data-picker-style")]).toEqual(["list", "list"]);
    expect(strip()?.hasAttribute("data-closing")).toBe(false);
  });

  it("leaves Alt+S and Alt+Shift+S to the local model search", async () => {
    await mount("list");
    await tap('button[aria-expanded="false"]:not([data-picker-style-button])');
    const search = document.querySelector("input")!;
    search.focus();
    expect((await altS(false, search)).defaultPrevented).toBe(false);
    expect((await altS(true, search)).defaultPrevented).toBe(false);
    expect([shown(), strip()]).toEqual(["list", null]);
  });

  it("puts Theme first and on, and keeps a picked look until Theme is picked again", async () => {
    await mount();
    await altS();
    expect(looks()).toEqual(["Theme*", "Dark", "Light", "Atelier"]);
    expect(backdrop().hasAttribute("data-light")).toBe(false);
    await tap('[data-picker-look="light"]');
    expect(looks()).toEqual(["Theme", "Dark", "Light*", "Atelier"]);
    expect([backdrop().hasAttribute("data-light"), localStorage.getItem("omb-model-picker-look")]).toEqual([true, "light"]);
    await act(async () => root.unmount());
    await mount();
    expect(backdrop().hasAttribute("data-light")).toBe(true);
    await altS();
    await tap('[data-picker-look="theme"]');
    expect(looks()).toEqual(["Theme*", "Dark", "Light", "Atelier"]);
    expect([backdrop().hasAttribute("data-light"), localStorage.getItem("omb-model-picker-look")]).toEqual([false, null]);
  });

  it("saves the Machine as a style, reopens on it, and closes the picker from its X", async () => {
    await mount();
    await altS();
    await tap('[data-picker-style="machine"]');
    for (let i = 0; i < 50 && !document.querySelector(".model-machine"); i++) await wait(5);
    expect([shown(), localStorage.getItem("omb-model-picker-view")]).toEqual(["machine", "machine"]);
    expect(strip()?.hasAttribute("data-closing")).toBe(false);
    await press("Escape");
    expect(document.activeElement?.classList.contains("model-machine")).toBe(true);
    const enter = await press("Enter", {}, document.querySelector(".model-machine [data-picker-style-button]"));
    expect([enter.defaultPrevented, dispatch.mock.calls.length, picker() !== null]).toEqual([false, 0, true]);
    await act(async () => root.unmount());
    await mount(localStorage.getItem("omb-model-picker-view")!);
    for (let i = 0; i < 50 && !document.querySelector(".model-machine"); i++) await wait(5);
    expect(document.querySelector(".model-machine [data-picker-style-button]")).not.toBeNull();
    await tap("[data-machine-close]");
    expect(picker()).toBeNull();
  });

  it("keeps the saved Machine and the style keys to pickers with the dial", async () => {
    await mount("machine", false);
    await altS();
    await altS(true);
    expect([document.querySelector(".model-machine"), document.querySelector("[data-picker-style-button]"), strip()]).toEqual([null, null, null]);
    expect(localStorage.getItem("omb-model-picker-view")).toBe("machine");
  });

  it.each(["style", "look"] as const)("folds eight %s tiles to four plus More, keeping the pick up front", async (kind) => {
    const tiles = Array.from({ length: 8 }, (_, i) => ({ id: `t${i + 1}`, label: `T${i + 1}`, mini: null }));
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(TileRow, { kind, title: kind, more: (count: number) => `More (${count})`, tiles, selected: "t7", onPick: () => undefined }));
    });
    const names = () => [...host.querySelectorAll(`[data-picker-${kind}]`)].map((tile) => tile.textContent);
    expect(names()).toEqual(["T1", "T2", "T3", "T7"]);
    expect(host.querySelector(`[data-picker-more="${kind}"]`)?.textContent).toBe("More (4)");
    await tap(`[data-picker-more="${kind}"]`);
    expect(names()).toEqual(["T1", "T2", "T3", "T7", "T4", "T5", "T6", "T8"]);
  });
});
