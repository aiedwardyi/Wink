import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import type { Bot, InstanceInfo } from "@/state/store";
import { ModelPickerControl } from "./ModelPicker";

const L5 = ["low", "medium", "high", "xhigh", "max"] as const;
const dispatch = vi.fn();
let root: Root;

function engine(instanceId: string, driverKind: string, ids: string[], signedIn = true, levels: NonNullable<NonNullable<InstanceInfo["capabilities"]>["effortLevels"]> = [...L5], local: string[] = []): InstanceInfo {
  return {
    instanceId, driverKind, displayName: instanceId,
    snapshot: { state: "available", authenticated: signedIn },
    models: { default: ids[0]!, options: [...ids.map((id) => ({ id, label: id })), ...local.map((id) => ({ id, label: id, custom: true }))] },
    capabilities: { effortLevels: levels },
  };
}

function media(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("reduce") ? reduce : query.split(", ").some((part) => !part.startsWith("(max-width")),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

async function mount({ view = "chart", grokSignedIn = true, local = [] as string[] } = {}) {
  localStorage.setItem("omb-model-picker-view", view);
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"], true, [...L5], local),
    engine("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"], true, ["minimal", ...L5]),
    engine("grok", "grokAgent", ["grok-4.7", "grok-4.6"], grokSignedIn),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Machine", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model: "claude-opus-5-5", effort: "high", mode: "pinned" } };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(ModelPickerControl, {
      bot,
      store: { state: { instances, selectedId: "bot-1" }, dispatch, refreshInstances: async () => undefined },
      defaultOpen: true,
      dial: true,
    })));
  });
}

async function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

const machine = () => document.querySelector(".model-machine");
const hotkey = async () => {
  await press("M", { code: "KeyM", altKey: true, shiftKey: true });
  for (let i = 0; i < 50 && !machine(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
};
const click = (selector: string) => act(async () => {
  document.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const audio = { contexts: 0, sounds: 0 };
const speakers = { kind: "speakers" };
class FakeParam {
  value = 0;
  setValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = "";
  buffer = null;
  connect(target: object) { if (target === speakers) audio.sounds++; }
  start() {}
  stop() {}
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  destination = speakers;
  constructor() { audio.contexts++; }
  createGain() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
  close() { return Promise.resolve(); }
}

const saved = () => dispatch.mock.calls.find(([action]) => action.type === "setModel")?.[0].selection;

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  media(true);
  Object.assign(audio, { contexts: 0, sounds: 0 });
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  dispatch.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ModelMachine", () => {
  it("opens over the picker on Alt+Shift+M and Esc goes back to the picker", async () => {
    await mount();
    expect(machine()).toBeNull();
    await hotkey();
    expect(machine()).not.toBeNull();
    expect(document.querySelector(".model-chart")).not.toBeNull();
    await press("Escape");
    expect(machine()).toBeNull();
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stocks only the picker's engines and models", async () => {
    await mount();
    await hotkey();
    expect([...document.querySelectorAll("[data-machine-slot]")].map((slot) => slot.getAttribute("data-machine-slot")))
      .toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6.1-sol", "gpt-6-luna", "grok-4.7", "grok-4.6"]);
    expect(document.querySelector("[data-machine-now]")?.textContent).toContain("claude-opus-5-5");
  });

  it.each([
    ["claude-sonnet-5-5", "xhigh"],
    ["gpt-6.1-sol", "low"],
  ])("picks %s at %s through the picker's save, the same as List", async (cell, level) => {
    await mount({ view: "list" });
    await click(`[data-model-cell="${cell}"]`);
    await click(`[data-picker-effort="${level}"]`);
    await press("Enter");
    const list = saved();
    expect(list).toMatchObject({ model: cell, effort: level });
    await act(async () => root.unmount());
    dispatch.mockReset();
    await mount();
    await hotkey();
    await click(`[data-machine-slot="${cell}"]`);
    await click(`[data-machine-effort="${level}"]`);
    await click("[data-machine-pick]");
    expect(saved()).toEqual(list);
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
  });

  it("picks from the keyboard: letter for lab, digit for model, arrows for effort, Enter", async () => {
    await mount();
    await hotkey();
    await press("b");
    await press("2");
    await press("ArrowLeft");
    await press("Enter");
    expect(saved()).toEqual({ instanceId: "codex", model: "gpt-6-luna", effort: "medium", mode: "pinned" });
  });

  it("tumbles the can before closing, and skips the tumble with reduced motion", async () => {
    media(false);
    await mount();
    await hotkey();
    await click('[data-machine-slot="claude-sonnet-5-5"]');
    await click("[data-machine-pick]");
    expect(saved()).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(document.querySelector('[data-machine-slot="claude-sonnet-5-5"]')?.hasAttribute("data-vend")).toBe(true);
    expect(document.querySelector("[data-model-picker-content]")).not.toBeNull();
    for (let i = 0; i < 60 && document.querySelector("[data-model-picker-content]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();

    await act(async () => root.unmount());
    dispatch.mockReset();
    media(true);
    await mount();
    await hotkey();
    await click('[data-machine-slot="claude-sonnet-5-5"]');
    await click("[data-machine-pick]");
    expect(saved()).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(document.querySelector("[data-vend]")).toBeNull();
    expect(document.querySelector("[data-model-picker-content]")).toBeNull();
  });

  it.each([false, true])("plays one clunk per PICK and none on open, hover or close (reduced motion %s)", async (reduce) => {
    media(reduce);
    await mount();
    await hotkey();
    await act(async () => {
      document.querySelector('[data-machine-slot="gpt-6.1-sol"]')!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    await press("Escape");
    await hotkey();
    expect(audio.contexts).toBe(0);
    await click('[data-machine-slot="gpt-6.1-sol"]');
    await click("[data-machine-pick]");
    expect(saved()).toMatchObject({ model: "gpt-6.1-sol" });
    expect(audio.sounds).toBe(1);
  });

  it("leaves keys native in the local-model controls and Tab reaches the search box", async () => {
    await mount({ local: ["llama-local"] });
    await hotkey();
    const toggle = document.querySelector<HTMLButtonElement>(".vm-setup [aria-expanded]")!;
    await act(async () => toggle.focus());
    expect((await press("Enter")).defaultPrevented).toBe(false);
    expect(saved()).toBeUndefined();
    await click(".vm-setup [aria-expanded]");
    await act(async () => toggle.focus());
    await press("Tab");
    const search = document.querySelector<HTMLInputElement>(".vm-setup input")!;
    expect(document.activeElement).toBe(search);
    for (const key of ["b", "2", "ArrowLeft", "ArrowUp", "Enter"]) expect((await press(key)).defaultPrevented).toBe(false);
    expect(saved()).toBeUndefined();
    expect(document.querySelector("[data-machine-slot][data-on]")?.getAttribute("data-machine-slot")).toBe("claude-opus-5-5");
    expect(document.activeElement).toBe(search);
    await press("Escape");
    expect(machine()).toBeNull();
  });

  it("offers every effort the engine supports, minimal included", async () => {
    await mount();
    await hotkey();
    await click('[data-machine-slot="gpt-6.1-sol"]');
    await click('[data-machine-effort="minimal"]');
    await click("[data-machine-pick]");
    expect(saved()).toMatchObject({ model: "gpt-6.1-sol", effort: "minimal" });
  });

  it("never vends a signed-out engine", async () => {
    await mount({ grokSignedIn: false });
    await hotkey();
    await click('[data-machine-slot="grok-4.7"]');
    expect(document.querySelector<HTMLButtonElement>("[data-machine-pick]")?.disabled).toBe(true);
    await press("Enter");
    await click("[data-machine-pick]");
    expect(saved()).toBeUndefined();
  });
});
