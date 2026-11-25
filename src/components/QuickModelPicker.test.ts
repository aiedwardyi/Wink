import "./ProfileFields.test-dom.ts";
import { act, createElement, createRef, useState, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isDialogActive } from "@/lib/focus-composer";
import { I18nProvider } from "@/lib/i18n";
import { modelFamilyAccent } from "@/lib/model-chip";
import { saveModelPickerView, type ModelPickerView } from "@/lib/model-picker-view";
import type { Action, Bot, InstanceInfo, ModelSelection } from "@/state/store";
import { ModelPickerControl } from "./ModelPicker";
import { effortFlowTier } from "./QuickModelPicker";

const here = dirname(fileURLToPath(import.meta.url));
let root: Root;

function makeInstance(
  instanceId: string,
  driverKind: string,
  options: Array<{ id: string; label: string }>,
  effortLevels?: NonNullable<InstanceInfo["capabilities"]>["effortLevels"],
): InstanceInfo {
  return {
    instanceId,
    driverKind,
    displayName: instanceId,
    snapshot: { state: "available", authenticated: true },
    models: { default: options[0]!.id, options },
    capabilities: effortLevels ? { effortLevels } : {},
  };
}

function mockMedia({ reduced = false } = {}) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("reduce") ? reduced : query.split(", ").some((part) => !part.startsWith("(max-width")),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function makeBot(selection: ModelSelection): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Atlas",
    title: "",
    description: "",
    color: "green",
    notifications: false,
    unread: false,
    messages: [],
    modelSelection: selection,
  };
}

function StatefulPicker({ initial, instances, control }: { initial: ModelSelection; instances: InstanceInfo[]; control?: Ref<(() => void) | null> }) {
  const [selection, setSelection] = useState(initial);
  return createElement(I18nProvider, null, createElement(ModelPickerControl, {
    bot: makeBot(selection),
    dial: true,
    switchControl: control,
    store: {
      state: { instances, selectedId: "bot-1" },
      dispatch: (action: Action) => {
        if (action.type === "setModel") setSelection(action.selection);
      },
      refreshInstances: async () => undefined,
    },
  }));
}

async function mountPicker(initial: ModelSelection, instances: InstanceInfo[], view: ModelPickerView = "quick", control?: Ref<(() => void) | null>) {
  saveModelPickerView(view);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(StatefulPicker, { initial, instances, control }));
  });
}

/** The inside of every gradient in a stylesheet. */
function gradientBodies(sheet: string): string[] {
  const bodies: string[] = [];
  for (const match of sheet.matchAll(/(?:linear|radial|conic)-gradient\(/g)) {
    let depth = 0;
    let end = match.index;
    for (; end < sheet.length; end++) {
      if (sheet[end] === "(") depth++;
      else if (sheet[end] === ")" && --depth === 0) break;
    }
    bodies.push(sheet.slice(match.index + match[0].length, end));
  }
  return bodies;
}

const isGray = (hex: string) => {
  const digits = hex.slice(1);
  const [r, g, b] = digits.length <= 4 ? digits.slice(0, 3).split("").map((d) => d + d) : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
  return r === g && g === b;
};

const claude = makeInstance("claude", "claudeAgent", [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }], ["low", "medium", "high", "xhigh", "max"]);
const codex = makeInstance("codex", "codex", [{ id: "gpt-6.2-astra", label: "GPT-6.2 Astra" }, { id: "gpt-6.2-mini", label: "GPT-6.2 Mini" }], ["low", "medium", "high", "xhigh", "max"]);
const atHigh: ModelSelection = { instanceId: "claude", model: "claude-opus-5-5", effort: "high", mode: "pinned" };

const triggerBtn = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]:not([data-picker-style-button])')!;
const quickCard = () => document.querySelector<HTMLElement>("[data-quick-model-picker]");
const fullDialog = () => document.querySelector<HTMLElement>(".model-cross-dialog[data-model-picker-content]");
const click = (selector: string) => act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());
const altKey = (target: Element, code: "KeyM" | "KeyT") => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: code.slice(3).toLowerCase(), code, altKey: true, bubbles: true, cancelable: true }));
});

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.clear();
  mockMedia();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Quick picker style", () => {
  it("opens under the top-right button, owns Alt+T like the full picker, and switches with the other styles", async () => {
    await mountPicker(atHigh, [claude, codex]);
    expect(triggerBtn().querySelector("[data-model-label]")?.textContent).toContain("Claude Opus 5.5");
    expect(quickCard()).toBeNull();

    await act(async () => triggerBtn().click());
    expect(quickCard()).not.toBeNull();
    expect(fullDialog()).toBeNull();
    // App's Alt+T (Themes) and Inspector's Escape yield to this marker.
    expect(quickCard()!.hasAttribute("data-model-picker-content")).toBe(true);
    expect(triggerBtn().getAttribute("aria-controls")).toBe(quickCard()!.id);

    await altKey(quickCard()!, "KeyT");
    expect([...document.querySelectorAll("[data-picker-style]")].map((el) => el.getAttribute("data-picker-style")))
      .toEqual(["dial", "list", "chart", "quick"]);
    await click('[data-picker-style="dial"]');
    expect(quickCard()).toBeNull();
    expect(fullDialog()).not.toBeNull();
    expect(localStorage.getItem("omb-model-picker-view")).toBe("dial");

    await click("[data-picker-style-button]");
    await click('[data-picker-style="quick"]');
    expect(quickCard()).not.toBeNull();
    expect(fullDialog()).toBeNull();

    await altKey(quickCard()!, "KeyM");
    expect(quickCard()?.hasAttribute("data-closing")).toBe(true);
    expect(quickCard()?.hasAttribute("data-model-picker-content")).toBe(false);
  });

  it("keeps model rows free of lab icons and every gradient in the model's own color", async () => {
    await mountPicker(atHigh, [claude, codex]);
    await act(async () => triggerBtn().click());
    for (const lab of ["claude", "codex"]) {
      await click(`[data-quick-lab="${lab}"]`);
      const rows = [...quickCard()!.querySelectorAll("[data-quick-model]")];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect([...row.querySelectorAll("svg")].filter((svg) => !svg.closest(".quick-model-check"))).toHaveLength(0);
        expect(row.querySelector("img, [data-brand-mark]")).toBeNull();
      }
    }
    for (const el of [quickCard()!, ...quickCard()!.querySelectorAll<HTMLElement>("[style]")]) {
      expect(el.getAttribute("style") ?? "").not.toMatch(/gradient|hue-rotate/);
    }

    const sheet = readFileSync(join(here, "QuickModelPicker.css"), "utf8");
    expect(sheet).not.toMatch(/hue-rotate/);
    const allowed = new Set(["from", "to", "at", "in", "srgb", "circle", "closest-side", "top", "white", "black", "transparent", "color-mix"]);
    for (const body of gradientBodies(sheet)) {
      const rest = body.replace(/var\(--quick-(?:view-)?accent\)/g, " ");
      expect(rest).not.toMatch(/var\(/);
      for (const hex of rest.match(/#[0-9a-f]{3,8}\b/gi) ?? []) expect(isGray(hex)).toBe(true);
      const words = rest.replace(/#[0-9a-f]{3,8}\b/gi, " ").replace(/-?[\d.]+(?:deg|turn|px|%)?/g, " ").match(/[a-z][a-z-]*/gi) ?? [];
      for (const word of words) expect(allowed).toContain(word);
    }
  });

  it("flows from Extra High up in the model's color, with Gemini's top Extra High flowing like Max", async () => {
    expect(effortFlowTier("low", 0, 5)).toBe("none");
    expect(effortFlowTier("high", 2, 5)).toBe("none");
    expect(effortFlowTier("xhigh", 3, 5)).toBe("xhigh");
    expect(effortFlowTier("max", 4, 5)).toBe("max");
    expect(effortFlowTier("xhigh", 3, 4)).toBe("max");

    const gemini = makeInstance("antigravity", "antigravityAgent", [
      { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
      { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (Extra High)" },
    ]);
    await mountPicker(atHigh, [claude, codex, gemini]);
    await act(async () => triggerBtn().click());

    expect(quickCard()?.getAttribute("data-flow")).toBeNull();
    expect(quickCard()?.querySelector(".quick-card-neon")).toBeNull();

    await click('[data-quick-effort="xhigh"]');
    expect(quickCard()?.querySelector('.quick-card-neon[data-flow="xhigh"]')).not.toBeNull();
    expect(quickCard()?.querySelector(".quick-deck-aurora")).toBeNull();
    expect(quickCard()?.style.getPropertyValue("--quick-accent")).toBe(modelFamilyAccent("claudeAgent"));

    await click('[data-quick-effort="max"]');
    expect(quickCard()?.querySelector('.quick-card-neon[data-flow="max"]')).not.toBeNull();
    expect(quickCard()?.querySelector(".quick-deck-aurora")).not.toBeNull();
    expect(quickCard()?.querySelector(".quick-thumb-neon")).not.toBeNull();

    await click('[data-quick-lab="codex"]');
    await click('[data-quick-model="gpt-6.2-astra"]');
    expect(quickCard()?.getAttribute("data-flow")).toBe("max");
    expect(quickCard()?.style.getPropertyValue("--quick-accent")).toBe(modelFamilyAccent("codex"));

    await click('[data-quick-lab="antigravity"]');
    await click('[data-quick-model^="gemini-4-neon"]');
    expect(quickCard()?.getAttribute("data-flow")).toBe("max");
    expect(quickCard()?.style.getPropertyValue("--quick-accent")).toBe(modelFamilyAccent("antigravityAgent"));
    expect(quickCard()?.querySelector("[data-quick-effort-readout]")?.textContent).toBe("Extra High");
  });

  it("plays one flourish on the closed button after Max is picked, then rests as a still glow", async () => {
    await mountPicker(atHigh, [claude]);
    expect(triggerBtn().classList.contains("quick-header-max")).toBe(false);

    await act(async () => triggerBtn().click());
    await click('[data-quick-effort="max"]');
    await act(async () => triggerBtn().click());
    expect(triggerBtn().classList.contains("quick-header-max")).toBe(true);
    expect(triggerBtn().style.getPropertyValue("--quick-accent")).toBe(modelFamilyAccent("claudeAgent"));
    expect(triggerBtn().querySelector("[data-quick-flourish]")).not.toBeNull();

    // Reopening and closing without a new pick keeps the glow but plays nothing.
    await act(async () => triggerBtn().click());
    await act(async () => triggerBtn().click());
    expect(triggerBtn().classList.contains("quick-header-max")).toBe(true);
    expect(triggerBtn().querySelector("[data-quick-flourish]")).toBeNull();
  });

  it("plays the flourish when a no-reply switch picks Max", async () => {
    const control = createRef<() => void>();
    await mountPicker(atHigh, [claude], "quick", control);
    await act(async () => control.current?.());
    await click('[data-quick-effort="max"]');
    expect(triggerBtn().classList.contains("quick-header-max")).toBe(true);
    expect(triggerBtn().querySelector("[data-quick-flourish]")).not.toBeNull();
  });

  it("skips the flourish under reduced motion and keeps the still glow", async () => {
    mockMedia({ reduced: true });
    await mountPicker(atHigh, [claude]);
    await act(async () => triggerBtn().click());
    await click('[data-quick-effort="max"]');
    await act(async () => triggerBtn().click());
    expect(triggerBtn().classList.contains("quick-header-max")).toBe(true);
    expect(triggerBtn().querySelector("[data-quick-flourish]")).toBeNull();

    const sheet = readFileSync(join(here, "QuickModelPicker.css"), "utf8");
    expect(sheet).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it("picks the focused row on Enter, leaves other controls their keys, and drops the dialog role while closing", async () => {
    await mountPicker(atHigh, [claude, codex]);
    await act(async () => triggerBtn().click());
    const press = async (target: Element, key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(event); });
      return event;
    };
    const lab = quickCard()!.querySelector('[data-quick-lab="codex"]')!;
    expect((await press(lab, "Enter")).defaultPrevented).toBe(false);
    await press(lab, "ArrowRight");
    expect(quickCard()?.querySelector('[data-quick-effort][aria-checked="true"]')?.getAttribute("data-quick-effort")).toBe("high");
    expect(quickCard()?.getAttribute("role")).toBe("dialog");

    await click('[data-quick-lab="codex"]');
    await press(quickCard()!.querySelector('[data-quick-model="gpt-6.2-astra"]')!, "Enter");
    expect(triggerBtn().querySelector("[data-model-label]")?.textContent).toContain("GPT-6.2 Astra");
    expect(quickCard()?.hasAttribute("data-closing")).toBe(true);
    expect(isDialogActive(document)).toBe(false);
  });

  it.each(["dial", "list", "chart"] as const)("leaves the %s header button as it is today at Max", async (view) => {
    await mountPicker({ ...atHigh, effort: "max" }, [claude], view);
    expect(triggerBtn().classList.contains("quick-header-max")).toBe(false);
    expect(triggerBtn().hasAttribute("style")).toBe(false);
    expect(triggerBtn().hasAttribute("data-light")).toBe(false);
    expect(triggerBtn().querySelector("[data-quick-flourish]")).toBeNull();
  });
});
