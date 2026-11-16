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

function engine(instanceId: string, driverKind: string, ids: string[], signedIn = true): InstanceInfo {
  return {
    instanceId, driverKind, displayName: instanceId,
    snapshot: { state: "available", authenticated: signedIn },
    models: { default: ids[0]!, options: ids.map((id) => ({ id, label: id })) },
    capabilities: { effortLevels: [...L5] },
  };
}

function media() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("reduce") || query.split(", ").some((part) => !part.startsWith("(max-width")),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

async function mount({ view = "chart", grokSignedIn = true, model = "claude-opus-5-5" } = {}) {
  localStorage.setItem("omb-model-picker-view", view);
  const instances = [
    engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
    engine("codex", "codex", ["gpt-6.1-sol", "gpt-6-luna"]),
    engine("grok", "grokAgent", ["grok-4.7", "grok-4.6"], grokSignedIn),
  ];
  const bot: Bot = { id: "bot-1", threadId: "thread-1", name: "Chart", title: "", description: "", color: "green", notifications: false, unread: false, messages: [], modelSelection: { instanceId: "claude", model, effort: "high", mode: "pinned" } };
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

async function key(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

const click = (selector: string) => act(async () => {
  document.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const saved = () => dispatch.mock.calls.find(([action]) => action.type === "setModel")?.[0].selection;
const model = () => document.querySelector('.model-chart [data-model-cell][aria-checked="true"]')?.getAttribute("data-model-cell");
const effort = () => document.querySelector('.model-chart [data-picker-effort][aria-checked="true"]')?.getAttribute("data-picker-effort");
const stat = (name: string) => document.querySelector(`[data-chart-stat="${name}"]`)?.textContent;

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

describe("ModelChart", () => {
  it("opens as the chart with lab, model and effort rows and the current pick", async () => {
    await mount();
    expect(document.querySelector(".model-chart")).not.toBeNull();
    expect([...document.querySelectorAll("[data-chart-lab]")].map((lab) => lab.getAttribute("data-chart-lab"))).toEqual(["claude", "codex", "grok"]);
    expect(model()).toBe("claude-opus-5-5");
    expect(effort()).toBe("high");
    expect(stat("intelligence")).toBe("51.8");
    expect(stat("coding")).toBe("35.9");
    expect(stat("cost")).toBe("$3.46");
    expect(document.querySelector("[data-chart-now]")?.textContent).toBe("Nowclaude-opus-5-5 · high");
  });

  it.each([
    ["claude-sonnet-5-5", "xhigh"],
    ["gpt-6.1-sol", "low"],
  ])("picks %s at %s from a chart dot the same as List", async (cell, level) => {
    await mount({ view: "list" });
    await click(`[data-model-cell="${cell}"]`);
    await click(`[data-picker-effort="${level}"]`);
    await key("Enter");
    const list = saved();
    expect(list).toMatchObject({ model: cell, effort: level });
    await act(async () => root.unmount());
    dispatch.mockReset();
    await mount();
    await click(`[data-stop="${cell}:${level}"]`);
    expect(model()).toBe(cell);
    expect(effort()).toBe(level);
    await click("[data-chart-pick]");
    expect(saved()).toEqual(list);
  });

  it("steps models with up and down, effort with left and right, labs with 1-5, and picks with Enter", async () => {
    await mount();
    await key("ArrowDown");
    expect(model()).toBe("claude-sonnet-5-5");
    await key("ArrowUp");
    await key("ArrowUp");
    expect(model()).toBe("grok-4.6");
    await key("1");
    expect(model()).toBe("claude-opus-5-5");
    for (let i = 0; i < 4; i++) await key("ArrowRight");
    expect(effort()).toBe("max");
    for (let i = 0; i < 8; i++) await key("ArrowLeft");
    expect(effort()).toBe("low");
    await key("2");
    expect(model()).toBe("gpt-6.1-sol");
    await key("ArrowRight");
    expect(effort()).toBe("medium");
    await key("Enter");
    expect(saved()).toEqual({ instanceId: "codex", model: "gpt-6.1-sol", effort: "medium", mode: "pinned" });
  });

  it('shows "-" and a dashed reticle on the nearest scored stop where no score is published', async () => {
    await mount();
    await key("3");
    await key("ArrowDown");
    expect(model()).toBe("grok-4.6");
    expect(effort()).toBe("high");
    expect(stat("intelligence")).toBe("-");
    expect(stat("coding")).toBe("-");
    expect(stat("cost")).toBe("-");
    const reticle = document.querySelector("[data-chart-reticle]");
    expect(reticle?.hasAttribute("data-ghost")).toBe(true);
    expect(document.querySelector('[data-picker-effort="high"] span')?.textContent).toBe("-");
    await key("ArrowRight");
    expect(effort()).toBe("xhigh");
    expect(stat("intelligence")).toBe("31.0");
    expect(document.querySelector("[data-chart-reticle]")?.hasAttribute("data-ghost")).toBe(false);
  });

  it("shows a signed-out lab locked and never picks it", async () => {
    await mount({ grokSignedIn: false });
    expect(document.querySelector('[data-chart-lab="grok"]')?.hasAttribute("data-locked")).toBe(true);
    await key("3");
    expect(model()).toBe("grok-4.7");
    expect(document.querySelector<HTMLButtonElement>("[data-chart-pick]")?.disabled).toBe(true);
    await key("Enter");
    await click("[data-chart-pick]");
    expect(saved()).toBeUndefined();
  });

  it("switches to the list view from the chart and back", async () => {
    await mount();
    const shown = () => document.querySelector("[data-picker-style-button]")?.getAttribute("data-picker-view");
    const tile = (view: string) => document.querySelector<HTMLButtonElement>(`[data-picker-style="${view}"]`)!;
    expect(shown()).toBe("chart");
    await act(async () => document.querySelector<HTMLButtonElement>("[data-picker-style-button]")!.click());
    await act(async () => tile("list").click());
    expect(document.querySelector(".model-chart")).toBeNull();
    expect(document.querySelector(".model-cross-stage")).not.toBeNull();
    expect(localStorage.getItem("omb-model-picker-view")).toBe("list");
    expect(shown()).toBe("list");
    await act(async () => document.querySelector<HTMLButtonElement>("[data-picker-style-button]")!.click());
    expect(tile("list").getAttribute("aria-checked")).toBe("true");
    await act(async () => tile("chart").click());
    expect(document.querySelector(".model-chart")).not.toBeNull();
    expect(localStorage.getItem("omb-model-picker-view")).toBe("chart");
  });

  it("steps on a wheel over the plot but leaves the controls to scroll", async () => {
    await mount();
    const wheel = (selector: string) => act(async () => {
      document.querySelector(selector)!.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    });
    await wheel(".chart-controls");
    expect(model()).toBe("claude-opus-5-5");
    await wheel(".chart-plot");
    expect(model()).toBe("claude-sonnet-5-5");
  });
});
