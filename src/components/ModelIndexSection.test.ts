import "./ProfileFields.test-dom.ts";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, applyLocale, localeTag, t } from "@/lib/i18n";
import { useSettingsSwipe } from "@/lib/use-settings-swipe";
import { MODEL_INDEX_ENTRIES, MODEL_INDEX_SOURCES } from "../../shared/model-index-data.ts";

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { instances: [] }, dispatch: () => undefined }),
}));

import { ModelIndexSection } from "./ModelIndexSection";
import { Badge, ProviderChips, dodge, placeNames } from "./ModelIndexPhone";
import { ProviderMark } from "./ProviderIcons";

let root: Root;
let host: HTMLElement;
let savedCosts: Array<number | undefined>;

const tab = () => host.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
const group = (label: string) => host.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
const chosen = (label: string) => group(label)?.querySelector('[aria-checked="true"]')?.textContent;
const pick = (label: string, option: string) =>
  act(() => [...group(label)!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((el) => el.textContent === option)!.click());
const mount = async () => {
  await act(async () => root.unmount());
  host.innerHTML = "";
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(ModelIndexSection))));
};
const press = (target: EventTarget, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { code: "KeyI", altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

beforeEach(async () => {
  savedCosts = MODEL_INDEX_ENTRIES.map((entry) => entry.cost);
  // Layout tests need priced fixtures even when a live refresh leaves costs pending.
  MODEL_INDEX_ENTRIES.forEach((entry, i) => {
    if (entry.index === "intelligence" && entry.cost === undefined) entry.cost = (i + 1) / 10;
  });
  applyLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(ModelIndexSection))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  MODEL_INDEX_ENTRIES.forEach((entry, i) => { entry.cost = savedCosts[i]; });
  document.body.innerHTML = "";
});

describe("benchmark hotkey", () => {
  it("cycles tabs with Alt+Shift+I and wraps around", () => {
    const seen = [tab()];
    for (let i = 0; i < 7; i++) {
      press(window);
      seen.push(tab());
    }
    expect(seen).toEqual(["Intelligence", "Coding", "Design", "Security", "General Work", "Legal", "Cost", "Intelligence"]);
  });

  it("keeps the keystroke from a focused terminal", () => {
    const terminal = document.createElement("textarea");
    document.body.append(terminal);
    terminal.focus();
    const reached = vi.fn();
    terminal.addEventListener("keydown", reached);
    const event = press(terminal);
    expect(reached).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(tab()).toBe("Coding");
  });

  it("leaves Alt+I and other chords alone", () => {
    press(window, { shiftKey: false });
    press(window, { ctrlKey: true });
    expect(tab()).toBe("Intelligence");
  });
});

describe("coding tabs", () => {
  it("labels Legal Research Bench in English and Korean", async () => {
    pick("Benchmark", "Legal");
    expect(host.textContent).toContain("Legal Research Bench, % all-pass");
    expect(host.textContent).not.toContain("LegalBench, % accuracy");
    try {
      vi.stubGlobal("localStorage", { getItem: () => "ko" });
      applyLocale("ko");
      await mount();
      pick("벤치마크", "법률");
      expect(host.textContent).toContain("Legal Research Bench, 전체 통과율 %");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fits desktop tabs with compact padding and hides the scrollbar on every pointer type", () => {
    const tabs = group("Benchmark")!;
    expect(tabs.className).toContain("[scrollbar-width:none]");
    expect(tabs.className).not.toContain("pointer-coarse:");
    expect(tabs.querySelector("button")?.className).toContain("px-2");
    expect(tabs.className).toContain("overflow-x-auto");
  });

  it("puts Terminal-Bench first under Coding, FrontierCode second, and no Agentic tab", () => {
    expect([...group("Benchmark")!.querySelectorAll('[role="radio"]')].map((el) => el.textContent)).toEqual([
      "Intelligence",
      "Coding",
      "Design",
      "Security",
      "General Work",
      "Legal",
      "Cost",
    ]);
    expect(group("Coding Benchmark")).toBeNull();
    pick("Benchmark", "Coding");
    expect([...group("Coding Benchmark")!.querySelectorAll('[role="radio"]')].map((el) => el.textContent)).toEqual(["Terminal-Bench", "FrontierCode"]);
    expect(chosen("Coding Benchmark")).toBe("Terminal-Bench");
    expect(host.textContent).toContain("Terminal-Bench 4.0, % resolved");
    pick("Coding Benchmark", "FrontierCode");
    expect(host.textContent).toContain("FrontierCode 2.0, mean score %");
  });

  it("keeps the chosen coding benchmark across view and tab switches", () => {
    pick("Benchmark", "Coding");
    pick("Coding Benchmark", "FrontierCode");
    pick("Chart", "Ranked");
    expect(chosen("Coding Benchmark")).toBe("FrontierCode");
    pick("Benchmark", "Legal");
    pick("Benchmark", "Coding");
    expect(chosen("Coding Benchmark")).toBe("FrontierCode");
    for (let i = 0; i < 7; i++) press(window);
    expect(chosen("Coding Benchmark")).toBe("FrontierCode");
    expect(host.textContent).toContain("FrontierCode 2.0, mean score %");
  });
});

describe("source freshness", () => {
  const STALE = "Not updated since";
  const sourceFor = (index: string) => {
    const source = Object.values(MODEL_INDEX_SOURCES).find((entry) => entry.index === index);
    if (!source) throw new Error(`no source for ${index}`);
    return source;
  };
  const nbDay = (iso: string) =>
    new Date(iso.slice(0, 10))
      .toLocaleDateString(localeTag("en"), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
      .replace(/ /g, "\u00a0");
  const atLocal = (iso: string, plusDays: number, hour: number, minute: number) => {
    const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) throw new Error(`bad date ${iso}`);
    return new Date(year, month - 1, day + plusDays, hour, minute);
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says when it was checked when the source publishes no date", () => {
    expect(host.textContent).toContain(`Checked ${nbDay(sourceFor("intelligence").retrievedAt)}`);
    expect(host.textContent).not.toContain("Source updated");
  });

  it("shows the source's own date beside the check", async () => {
    const legal = sourceFor("legal");
    if (legal.updated === null) throw new Error("legal publishes no date");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atLocal(legal.updated, 14, 23, 30));
    await mount();
    pick("Benchmark", "Legal");
    expect(host.textContent).toContain(`Source updated ${nbDay(legal.updated)} \u00b7 checked ${nbDay(legal.retrievedAt)}`);
    expect(host.textContent).not.toContain(STALE);
  });

  it("flags a source not updated for more than 14 days", async () => {
    const security = sourceFor("security");
    if (security.updated === null) throw new Error("security publishes no date");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atLocal(security.updated, 14, 23, 30));
    await mount();
    pick("Benchmark", "Security");
    expect(host.textContent).toContain(`Source updated ${nbDay(security.updated)}`);
    expect(host.textContent).not.toContain(STALE);
    vi.setSystemTime(atLocal(security.updated, 15, 0, 30));
    await mount();
    pick("Benchmark", "Security");
    const badge = [...host.querySelectorAll("span")].find((el) => el.textContent === `${STALE} ${nbDay(security.updated)}`);
    expect(badge?.className).toContain("text-warning");
  });

  it("flags a source with no published date once it was last checked more than 14 days ago", async () => {
    const CHECKED = "Not checked since";
    const checked = nbDay(sourceFor("intelligence").retrievedAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atLocal(sourceFor("intelligence").retrievedAt, 14, 23, 30));
    await mount();
    expect(host.textContent).toContain(`Checked ${checked}`);
    expect(host.textContent).not.toContain(CHECKED);
    vi.setSystemTime(atLocal(sourceFor("intelligence").retrievedAt, 15, 0, 30));
    await mount();
    const badge = [...host.querySelectorAll("span")].find((el) => el.textContent === `${CHECKED} ${checked}`);
    expect(badge?.className).toContain("text-warning");
    expect(host.textContent).not.toContain(STALE);
  });
});

describe("model filter", () => {
  it("has no Show all toggle and draws every point at full strength", () => {
    expect(host.textContent).not.toContain("Show all models");
    const faded = [...host.querySelectorAll<HTMLElement>("[data-mi-move]")].filter((el) => ["0.4", "0.5", "0.3"].includes(el.style.opacity));
    expect(faded).toHaveLength(0);
  });

  it("charts only picker models on every tab", () => {
    const named = () => [...host.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "").join("|");
    for (let i = 0; i < 7; i++) {
      expect(named(), tab() ?? "").not.toMatch(/GLM|Kimi|Qwen|DeepSeek|Inkling|Haiku 4\.5/);
      if (tab() === "Coding") {
        pick("Coding Benchmark", "FrontierCode");
        expect(named(), "FrontierCode").not.toMatch(/GLM|Kimi|Qwen|DeepSeek|Inkling|Haiku 4\.5/);
      }
      press(window);
    }
  });

  it("charts Argon on every tab and both coding benchmarks", () => {
    const named = () => [...host.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "").join("|");
    for (const benchmark of ["Intelligence", "Coding", "Design", "Security", "General Work", "Legal", "Cost"]) {
      pick("Benchmark", benchmark);
      expect(named(), benchmark).toMatch(/Gemini 4 Argon/);
    }
    pick("Benchmark", "Coding");
    pick("Coding Benchmark", "FrontierCode");
    expect(named(), "FrontierCode").toMatch(/Gemini 4 Argon/);
  });
});

describe("cost tab", () => {
  it("shows input / output list price per 1M tokens", () => {
    for (let i = 0; i < 6; i++) press(window);
    expect(tab()).toBe("Cost");
    const opus = [...host.querySelectorAll('[tabindex="0"]')].find((el) => el.textContent?.includes("Claude Opus 5.5"));
    expect(opus?.textContent).toContain("$4 / $20");
    expect(host.textContent).toContain("List price per 1M tokens");
    expect(host.textContent).toContain("Ranked by the 7:2:1 blend");
  });
});

describe("promo price on the cost tab", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const costRow = async (day: [number, number, number], model: string, locale: "en" | "ko" = "en") => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(...day, 12));
    vi.stubGlobal("localStorage", { getItem: () => locale });
    await mount();
    for (let i = 0; i < 6; i++) press(window);
    return [...host.querySelectorAll('[tabindex="0"]')].find((el) => el.textContent?.includes(model))?.textContent;
  };

  it("shows both prices with the start date before it, in English and Korean", async () => {
    expect(await costRow([2026, 10, 30], "Gemini 4 Argon")).toBe("Gemini 4 Argon$2\u00a0/\u00a0$10, $4\u00a0/\u00a0$20 from Dec\u00a01");
    expect(await costRow([2026, 11, 30], "Gemini 3.8 Flash")).toBe("Gemini 3.8 Flash$0.75\u00a0/\u00a0$3.75, $1.50\u00a0/\u00a0$7.50 from Jan\u00a01");
    expect(await costRow([2026, 10, 30], "Gemini 4 Argon", "ko")).toBe("Gemini 4 Argon$2\u00a0/\u00a0$10, 12월\u00a01일부터 $4\u00a0/\u00a0$20");
  });

  it("shows only the new price, with no promo wording, once it starts", async () => {
    expect(await costRow([2026, 11, 1], "Gemini 4 Argon")).toBe("Gemini 4 Argon$4 / $20");
    expect(await costRow([2026, 11, 1], "Gemini 4 Argon", "ko")).toBe("Gemini 4 Argon$4 / $20");
    expect(await costRow([2027, 0, 1], "Gemini 3.8 Flash")).toBe("Gemini 3.8 Flash$1.50 / $7.50");
    expect(host.textContent).not.toMatch(/ from |promo/);
  });

  it("leaves a row with no next as one price", async () => {
    expect(await costRow([2026, 10, 30], "Claude Opus 5.5")).toBe("Claude Opus 5.5$4 / $20");
  });

  it("keeps Korean dates whole on the Cost bars and on the Cost and Legal tooltips", async () => {
    const date = "12월 1일부터";
    const kept = () =>
      [...host.querySelectorAll("span")].filter((el) => !el.children.length && el.textContent?.includes(date)).map((el) => el.className.includes("break-keep"));
    const argon = () => [...host.querySelectorAll<HTMLElement>('[tabindex="0"]')].find((el) => (el.getAttribute("aria-label") ?? el.textContent)?.includes("Gemini 4 Argon"))!;
    await costRow([2026, 10, 30], "Gemini 4 Argon", "ko");
    expect(kept()).toEqual([true, true]);
    act(() => argon().focus());
    expect(kept()).toEqual([true, true, true]);
    await mount();
    for (let i = 0; i < 5; i++) press(window);
    act(() => argon().focus());
    expect(kept()).toEqual([true]);
  });
});

describe("score vs cost", () => {
  it("draws Design against published page cost with the Rams scale in both locales", async () => {
    for (const locale of ["en", "ko"] as const) {
      try {
        vi.stubGlobal("localStorage", { getItem: () => locale });
        applyLocale(locale);
        await mount();
        pick(locale === "en" ? "Benchmark" : "벤치마크", locale === "en" ? "Design" : "디자인");
        const chart = locale === "en" ? "Chart" : "차트";
        expect(chosen(chart)).toBe(locale === "en" ? "Score vs Cost" : "점수 대비 비용");
        expect(host.textContent).toContain("Rams Index");
        expect(host.textContent).toContain(locale === "en" ? "Cost per page" : "페이지당 비용");
        const sol = host.querySelector<SVGElement>('[aria-label="GPT-6.1 Sol default"]')!;
        act(() => sol.focus());
        const tip = host.querySelector('[role="tooltip"]')?.textContent;
        expect(tip).toContain("87.8");
        expect(tip).toContain("84.6-89.9");
        expect(tip).toContain("$0.15");
        expect(tip).not.toContain("87.8%");
        pick(chart, locale === "en" ? "Ranked" : "순위");
        expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(12);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("plots Intelligence with committed run costs without layout fixtures", async () => {
    MODEL_INDEX_ENTRIES.forEach((entry, i) => { entry.cost = savedCosts[i]; });
    await mount();
    const opus = MODEL_INDEX_ENTRIES.find((entry) => entry.index === "intelligence" && entry.model === "claude-opus-5-5" && entry.effort === "max")!;
    expect(opus.cost).toBeGreaterThan(0);
    expect(chosen("Chart")).toBe("Score vs Cost");
    expect(host.querySelector('[aria-label="Claude Opus 5.5 max"]')).not.toBeNull();
    expect(host.textContent).toContain("Cost per task, AA Intelligence Index");
    expect(host.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("falls back to Ranked when every cost awaits a hand check", async () => {
    for (const row of MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence")) row.cost = undefined;
    await mount();
    expect(chosen("Chart")).toBe("Ranked");
    expect([...group("Chart")!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((el) => el.textContent === "Score vs Cost")!.disabled).toBe(true);
    expect(host.querySelectorAll('[tabindex="0"]').length).toBeGreaterThan(0);
    expect(host.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("plots priced rows and keeps unpriced scores and tooltips available in Ranked", async () => {
    const low = MODEL_INDEX_ENTRIES.find((row) => row.index === "intelligence" && row.model === "claude-opus-5-5" && row.effort === "low")!;
    const max = MODEL_INDEX_ENTRIES.find((row) => row.index === "intelligence" && row.model === "claude-opus-5-5" && row.effort === "max")!;
    const costs = [low.cost, max.cost];
    low.cost = undefined;
    max.cost = 1.25;
    try {
      await mount();
      expect(chosen("Chart")).toBe("Score vs Cost");
      const priced = host.querySelector<SVGElement>('[aria-label="Claude Opus 5.5 max"]')!;
      act(() => priced.focus());
      expect(host.querySelector('[role="tooltip"]')?.textContent).toContain("Cost per task$1.25");
      expect(host.innerHTML).not.toMatch(/NaN|Infinity/);
      pick("Chart", "Ranked");
      const unpriced = [...host.querySelectorAll<HTMLElement>('[tabindex="0"]')].find((el) => el.textContent?.startsWith("Claude Opus 5.5low"))!;
      expect(unpriced).toBeDefined();
      act(() => unpriced.focus());
      const tip = host.querySelector('[role="tooltip"]')?.textContent ?? "";
      expect(tip).toContain("Cost per task-");
      expect(tip).toContain("Price per 1M, in / out$4 / $20");
      expect(tip).not.toMatch(/undefined|NaN|Infinity/);
    } finally {
      [low.cost, max.cost] = costs;
    }
  });

  it("draws Legal against each model's cost per test", () => {
    pick("Benchmark", "Legal");
    expect(group("Chart")!.querySelector<HTMLButtonElement>('[role="radio"]')!.disabled).toBe(false);
    expect(chosen("Chart")).toBe("Score vs Cost");
    expect(host.querySelector('[aria-label="Claude Fable 5 all"]')?.closest("[data-mi-move]")).not.toBeNull();
    expect(host.textContent).toContain("Cost per task →");
  });

  it("plots each effort at its own cost to run, not one list price", () => {
    const x = (effort: string) =>
      host.querySelector(`[aria-label="Claude Opus 5.5 ${effort}"]`)?.closest<HTMLElement>("[data-mi-move]")?.style.transform.match(/translate\(([\d.]+)px/)?.[1];
    const xs = ["low", "medium", "high", "xhigh", "max"].map(x);
    expect(xs.every(Boolean), xs.join()).toBe(true);
    expect(new Set(xs).size).toBe(5);
    expect(host.textContent).toContain("Cost per task, AA Intelligence Index");
  });
});

describe("score hover card", () => {
  const hoverTip = (label: string) => {
    act(() => host.querySelector<SVGElement>(`[aria-label="${label}"]`)!.focus());
    const tip = host.querySelector('[role="tooltip"]')?.textContent ?? "";
    act(() => host.querySelector<SVGElement>(`[aria-label="${label}"]`)!.blur());
    return tip;
  };
  const rowTip = (text: string) => {
    const row = [...host.querySelectorAll<HTMLElement>('[tabindex="0"]')].find((el) => el.textContent?.startsWith(text))!;
    act(() => row.focus());
    const tip = host.querySelector('[role="tooltip"]')?.textContent ?? "";
    act(() => row.blur());
    return tip;
  };

  it.each(["en", "ko"] as const)("shows a filled checked date on hover and focus in %s", async (locale) => {
    const row = MODEL_INDEX_ENTRIES.find((entry) => entry.index === "legal" && entry.model === "claude-fable-5")! as typeof MODEL_INDEX_ENTRIES[number] & { scoreDate?: { date: string; kind: "checked" | "published" } };
    row.scoreDate = { date: "2026-08-03", kind: "checked" };
    try {
      vi.stubGlobal("localStorage", { getItem: () => locale });
      applyLocale(locale);
      await mount();
      for (let i = 0; i < 5; i++) press(window);
      const text = locale === "en" ? "as of Aug 2026" : "2026년 8월 기준";
      expect(hoverTip("Claude Fable 5 all")).toContain(text);
      const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"]')].at(-1)!;
      act(() => radios.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
      const bar = [...host.querySelectorAll<HTMLElement>('[tabindex="0"]')].find((el) => el.textContent?.startsWith("Claude Fable 5"))!;
      act(() => bar.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      expect(host.querySelector('[role="tooltip"]')?.textContent).toContain(text);
    } finally {
      delete row.scoreDate;
      vi.unstubAllGlobals();
    }
  });

  it("shows a published score month without calling it a checked date", () => {
    const row = MODEL_INDEX_ENTRIES.find((entry) => entry.index === "legal" && entry.model === "claude-fable-5")!;
    row.scoreDate = { date: "2026-08-03", kind: "published" };
    try {
      pick("Benchmark", "Legal");
      const tip = hoverTip("Claude Fable 5 all");
      expect(tip).toContain("Legal, Aug 2026");
      expect(tip).not.toContain("as of");
    } finally {
      delete row.scoreDate;
    }
  });

  it("shows each effort's own cost per task over one shared price", () => {
    const low = hoverTip("Claude Opus 5.5 low");
    const max = hoverTip("Claude Opus 5.5 max");
    const cost = (tip: string) => tip.match(/Cost per task(\$[\d.]+)/)?.[1];
    expect(cost(low), low).toBeDefined();
    expect(cost(max), max).toBeDefined();
    expect(cost(low)).not.toBe(cost(max));
    for (const tip of [low, max]) expect(tip).toContain("Price per 1M, in / out$4 / $20Same at every effort");
  });

  it("names the coding benchmark and hides retired models", () => {
    pick("Benchmark", "Coding");
    const terminal = hoverTip("Claude Opus 5.5 high");
    expect(terminal).toMatch(/%Terminal-Bench/);
    expect(terminal).toContain("Cost per task");
    expect(terminal).not.toMatch(/95% CI|Harness/);
    pick("Coding Benchmark", "FrontierCode");
    expect(chosen("Chart")).toBe("Ranked");
    expect(rowTip("Claude Opus 5.5medium")).toContain("33.1%FrontierCode");
    pick("Benchmark", "Design");
    expect(host.textContent).not.toContain("GPT-5.6 Terra");
  });

  it("names the harness when the benchmark row has one", () => {
    const row = MODEL_INDEX_ENTRIES.find((entry) => entry.index === "design" && entry.model === "gpt-6-astra")!;
    const harness = row.harness;
    row.harness = "Codex";
    try {
      pick("Benchmark", "Design");
      pick("Chart", "Ranked");
      expect(rowTip("GPT-6 Astradefault")).toContain("HarnessCodex");
    } finally {
      row.harness = harness;
    }
  });
});

describe("index tabs", () => {
  const scroll = (el: HTMLElement, sizes: { scrollWidth: number; clientWidth: number; scrollLeft: number }) => {
    for (const [key, value] of Object.entries(sizes)) Object.defineProperty(el, key, { configurable: true, value });
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    return el.style.maskImage;
  };

  it("fades the edge with more tabs past it and hides the scrollbar", () => {
    const row = host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(scroll(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })).toMatch(/^linear-gradient\(to right, black, .*transparent\)$/);
    expect(scroll(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 100 })).toMatch(/^linear-gradient\(to right, transparent, .*transparent\)$/);
    expect(scroll(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 200 })).toMatch(/^linear-gradient\(to right, transparent, .*black\)$/);
    expect(scroll(row, { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })).toBe("");
    expect(row.className).toContain("[scrollbar-width:none]");
  });
});

describe("score vs cost axis", () => {
  const rebuild = async (width: number) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe = () => this.cb([{ contentRect: { width } }]);
        disconnect = () => undefined;
      },
    );
    await act(async () => root.unmount());
    host.innerHTML = "";
    root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(ModelIndexSection))));
  };
  const ticks = () =>
    [...host.querySelectorAll<SVGGElement>("g[data-mi-enter]")]
      .filter((g) => g.querySelector("line")?.hasAttribute("y1") && !g.hasAttribute("data-mi-leave"))
      .map((g) => ({ label: g.textContent ?? "", x: Number(g.style.transform.match(/translate\(([\d.]+)px/)?.[1]) }));
  const caption = () => [...host.querySelectorAll("text")].find((el) => el.textContent?.includes("Cost per task"))!;
  afterEach(() => vi.unstubAllGlobals());

  it("spans the cheapest to the dearest cost per task, with a one-line caption, at the narrowest desktop width", async () => {
    await rebuild(454);
    const labels = ticks().map((tick) => tick.label);
    const values = labels.map((label) => Number(label.slice(1)));
    expect(labels.join(), "no k suffix").not.toMatch(/k/);
    expect(values.every(Number.isFinite), labels.join()).toBe(true);
    const axis = host.querySelector<SVGLineElement>("line[x1][y1]")!;
    const xs = [...host.querySelectorAll<SVGElement>('circle[tabindex="0"][aria-label]')]
      .map((dot) => Number(dot.closest<SVGElement>("[data-mi-move]")!.style.transform.match(/translate\(([\d.]+)px/)?.[1]));
    expect(xs.length).toBeGreaterThan(1);
    expect(Math.min(...xs)).toBeGreaterThan(Number(axis.getAttribute("x1")));
    expect(Math.max(...xs)).toBeLessThan(Number(axis.getAttribute("x2")));
    expect(caption().querySelectorAll("tspan")).toHaveLength(0);
  });

  it("keeps labels apart and the caption inside the card at phone widths", async () => {
    for (const width of [320, 360, 376, 420]) {
      await rebuild(width);
      const shown = ticks();
      expect(shown.length, String(width)).toBeGreaterThanOrEqual(2);
      shown.slice(1).forEach((tick, i) => {
        const prev = shown[i]!;
        const half = ((prev.label.length + tick.label.length) * 6) / 2;
        expect(tick.x - prev.x, `${width}: ${prev.label} ${tick.label}`).toBeGreaterThanOrEqual(half);
      });
      const tspans = [...caption().querySelectorAll("tspan")];
      if (width <= 360) expect(tspans.length, String(width)).toBeGreaterThan(1);
      for (const line of tspans.length ? tspans : [caption()]) {
        expect((line.textContent ?? "").length * 6, `${width}: ${line.textContent}`).toBeLessThanOrEqual(width - 36);
      }
    }
  });

  it("centres every caption line inside the plot and keeps the unit note whole", async () => {
    for (const width of [320, 360, 420]) {
      await rebuild(width);
      const axis = [...host.querySelectorAll("line")].find((line) => line.hasAttribute("x1") && line.hasAttribute("y1"))!;
      const [left, right] = [Number(axis.getAttribute("x1")), Number(axis.getAttribute("x2"))];
      const tspans = [...caption().querySelectorAll("tspan")];
      const lines = tspans.length ? tspans : [caption()];
      for (const line of lines) {
        const centre = Number(line.getAttribute("x") ?? caption().getAttribute("x"));
        const half = ((line.textContent ?? "").length * 6 * 11) / 10.5 / 2;
        expect(centre - half, `${width}: ${line.textContent}`).toBeGreaterThanOrEqual(left);
        expect(centre + half, `${width}: ${line.textContent}`).toBeLessThanOrEqual(right);
      }
      expect(lines.some((line) => line.textContent?.includes("(USD, log scale)")), `${width}: ${lines.map((l) => l.textContent).join(" | ")}`).toBe(true);
    }
  });

  it("never draws wider than a narrow phone gives it", async () => {
    await rebuild(260);
    expect(host.querySelector("svg[role=img]")?.getAttribute("width")).toBe("260");
  });

  it("measures labels in the font the app is drawn in", async () => {
    const fonts: string[] = [];
    const ctx = {
      set font(value: string) {
        fonts.push(value);
      },
      measureText: (text: string) => ({ width: text.length * 6 }),
    };
    // SAFETY: the chart only sets `font` and calls `measureText` on its 2D context.
    const getContext = vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    document.documentElement.style.fontFamily = "serif";
    document.body.style.fontFamily = '"Space Grotesk", sans-serif';
    try {
      await rebuild(360);
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.at(-1)).toContain("Space Grotesk");
    } finally {
      getContext.mockRestore();
      document.documentElement.style.fontFamily = "";
      document.body.style.fontFamily = "";
    }
  });
});

describe("full screen chart", () => {
  const innerWidth = window.innerWidth;
  const back = vi.fn();
  function SettingsChart() {
    const ref = useRef<HTMLDivElement>(null);
    useSettingsSwipe(ref, true, "models-index", back);
    return createElement("div", { ref },
      createElement("div", { "data-settings-underlay": "" }),
      createElement("div", { "data-settings-page": "models-index" },
        createElement("p", { "data-outside-chart": "" }, "Model Index"),
        createElement(ModelIndexSection),
      ),
    );
  }
  const rebuild = async (phone: boolean, size: { width: number; height: number }, settings = false) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe = () => this.cb([{ contentRect: size }]);
        disconnect = () => undefined;
      },
    );
    // SAFETY: isPhone only reads .matches
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width") }) as MediaQueryList);
    await act(async () => root.unmount());
    host.innerHTML = "";
    root = createRoot(host);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(settings ? SettingsChart : ModelIndexSection))));
    if (phone) pick(t("modelIndex.viewLabel"), t("modelIndex.view.chart"));
  };
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const svg = () => host.querySelector<SVGSVGElement>("svg[role=img], [data-mi-phone-chart] svg[role=group]")!;
  const badges = () => [...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].filter((el) => el.querySelector("[data-mi-badge]"));
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers full screen on phones only", async () => {
    await rebuild(false, { width: 640, height: 400 });
    expect(button("Full Screen")).toBeNull();
    await rebuild(true, { width: 360, height: 400 });
    expect(button("Full Screen")).not.toBeNull();
  });

  it("fills the screen with the chart, then closes back into the card", async () => {
    await rebuild(true, { width: 780, height: 330 });
    const inline = svg().getAttribute("height");
    act(() => button("Full Screen")!.click());
    expect(svg().getAttribute("width")).toBe("780");
    expect(svg().getAttribute("height")).toBe("330");
    act(() => button("Exit Full Screen")!.click());
    expect(button("Exit Full Screen")).toBeNull();
    expect(svg().getAttribute("height")).toBe(inline);
  });

  it("closes when Back leaves full screen before the request settles", async () => {
    await rebuild(true, { width: 780, height: 330 });
    let shown: Element | null = null;
    const request = vi.fn(() => new Promise<void>(() => undefined));
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "requestFullscreen");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => shown });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    try {
      act(() => button("Full Screen")!.click());
      expect(request).toHaveBeenCalledTimes(1);
      shown = svg();
      act(() => void document.dispatchEvent(new Event("fullscreenchange")));
      shown = null;
      act(() => void document.dispatchEvent(new Event("fullscreenchange")));
      expect(button("Exit Full Screen")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
      if (original) Object.defineProperty(HTMLElement.prototype, "requestFullscreen", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });

  it.each(["en", "ko"] as const)("keeps full-screen tabs and the coding choice in %s", async (locale) => {
    vi.stubGlobal("localStorage", { getItem: () => locale });
    applyLocale(locale);
    await rebuild(true, { width: 780, height: 330 });
    act(() => button(locale === "en" ? "Full Screen" : "전체 화면")!.click());
    const full = svg().closest("[data-mi-full]")!;
    const tabs = full?.querySelector('[role="radiogroup"]');
    expect(tabs).toBeTruthy();
    act(() => [...tabs!.querySelectorAll<HTMLButtonElement>("button")][1]!.click());
    expect(full.textContent).toContain("Terminal-Bench");
    expect(full.textContent).toContain("FrontierCode");
    act(() => full.querySelector<HTMLButtonElement>('button[aria-label]')!.click());
    expect(tab()).toBe(locale === "en" ? "Coding" : "코딩");
  });

  const touch = (type: string, points: Array<[number, number]>, time?: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY], identifier) => ({ clientX, clientY, identifier })) });
    if (time !== undefined) Object.defineProperty(event, "timeStamp", { value: time });
    act(() => svg().dispatchEvent(event));
  };
  const swipe = (from: number, to: number) => {
    touch("touchstart", [[from, 150]]);
    touch("touchmove", [[to, 150]]);
    touch("touchend", []);
  };

  it.each(["pan", "index"])("keeps a fallback chart %s off Settings back at 390 px", async (gesture) => {
    vi.useFakeTimers();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    back.mockReset();
    await rebuild(true, { width: 366, height: 330 }, true);
    expect(document.fullscreenElement).toBeFalsy();
    act(() => button("Full Screen")!.click());
    if (gesture === "pan") {
      touch("touchstart", [[100, 150], [200, 150]]);
      touch("touchmove", [[50, 150], [250, 150]]);
      touch("touchend", []);
      expect(svg().getAttribute("data-mi-zoom")).toBe("2");
    } else pick("Benchmark", "Coding");
    touch("touchstart", [[60, 150]]);
    touch("touchmove", [[320, 150]]);
    expect(host.querySelector<HTMLElement>("[data-settings-page]")!.style.transform).toBe("");
    touch("touchend", []);
    await act(async () => vi.advanceTimersByTime(300));
    expect(back).not.toHaveBeenCalled();
    expect(tab()).toBe("Intelligence");
    if (gesture === "pan") expect(svg().getAttribute("data-mi-zoom")).toBe("2");
    act(() => button("Exit Full Screen")!.click());
    const outside = host.querySelector("[data-outside-chart]")!;
    for (const [type, x] of [["touchstart", 60], ["touchmove", 320], ["touchend", 320]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: 150 }] });
      act(() => void outside.dispatchEvent(event));
    }
    await act(async () => vi.advanceTimersByTime(300));
    expect(back).toHaveBeenCalledOnce();
  });

  it("swipes between indexes without wrapping or taking a vertical drag", async () => {
    const vibrate = vi.fn();
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    await rebuild(true, { width: 780, height: 330 });
    act(() => button("Full Screen")!.click());
    // SAFETY: phone and motion checks only read .matches.
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    swipe(100, 450);
    expect(tab()).toBe("Intelligence");
    swipe(450, 100);
    expect(tab()).toBe("Coding");
    swipe(100, 450);
    expect(tab()).toBe("Intelligence");
    touch("touchstart", [[100, 100]]);
    touch("touchmove", [[140, 200]]);
    touch("touchend", []);
    expect(tab()).toBe("Intelligence");
    MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "cost").forEach((entry) => { entry.cost = entry.score; });
    pick("Benchmark", "Cost");
    swipe(450, 100);
    expect(tab()).toBe("Cost");
    expect(vibrate).toHaveBeenCalledTimes(2);
    Reflect.deleteProperty(window.navigator, "vibrate");
  });

  it("pans while zoomed and resets on index change and close", async () => {
    await rebuild(true, { width: 780, height: 330 });
    act(() => button("Full Screen")!.click());
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    touch("touchend", []);
    expect(Number(svg().getAttribute("data-mi-zoom"))).toBeGreaterThan(1);
    expect([...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].some((dot) => dot.style.opacity === "0")).toBe(true);
    swipe(450, 100);
    expect(tab()).toBe("Intelligence");
    pick("Benchmark", "Coding");
    expect(svg().getAttribute("data-mi-zoom")).toBe("1");
    act(() => button("Exit Full Screen")!.click());
    expect(svg().getAttribute("data-mi-zoom")).toBeNull();
    expect(svg().style.touchAction).not.toBe("none");
  });

  it("ignores cancelled and edge swipes", async () => {
    await rebuild(true, { width: 780, height: 330 });
    act(() => button("Full Screen")!.click());
    touch("touchstart", [[450, 150]]);
    touch("touchmove", [[100, 150]]);
    touch("touchcancel", []);
    expect(tab()).toBe("Intelligence");
    swipe(10, 450);
    expect(tab()).toBe("Intelligence");
  });

  it("opens a dot tooltip on tap and hides it on empty chart or zoom", async () => {
    await rebuild(true, { width: 780, height: 330 });
    act(() => button("Full Screen")!.click());
    const dot = badges().find((el) => el.style.opacity === "1")!;
    const [clientX, clientY] = dot.style.transform.match(/-?[\d.]+/g)!.map(Number);
    const hit = svg().querySelector('rect[fill="transparent"]')!;
    const tap = (x: number, y: number) => act(() => void hit.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y })));
    tap(clientX!, clientY!);
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
    tap(400, 10);
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    tap(clientX!, clientY!);
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    touch("touchend", []);
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("double-taps 2x and back with reduced motion instant", async () => {
    await rebuild(true, { width: 780, height: 330 });
    act(() => button("Full Screen")!.click());
    // SAFETY: phone and motion checks only read .matches.
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const tap = () => { touch("touchstart", [[250, 150]]); touch("touchend", []); };
    tap();
    tap();
    expect(svg().getAttribute("data-mi-zoom")).toBe("2");
    expect(svg().querySelector("style")?.textContent).toContain("transform 0s");
    tap();
    tap();
    expect(svg().getAttribute("data-mi-zoom")).toBe("1");
  });

  it("opens a zoomed dot tooltip after 3 px of finger jitter", async () => {
    await rebuild(true, { width: 780, height: 330 });
    act(() => button("Full Screen")!.click());
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    touch("touchend", []);
    expect(svg().getAttribute("data-mi-zoom")).toBe("2");
    const dot = badges().find((el) => el.style.opacity === "1")!;
    const [x, y] = dot.style.transform.match(/-?[\d.]+/g)!.map(Number);
    touch("touchstart", [[x!, y!]]);
    touch("touchmove", [[x! + 3, y!]]);
    touch("touchend", []);
    act(() => void svg().querySelector('rect[fill="transparent"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x! + 3, clientY: y! })));
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("opens a dot tooltip after staggered pinch lifts without resetting zoom", async () => {
    await rebuild(true, { width: 780, height: 330 });
    act(() => button("Full Screen")!.click());
    const dot = badges().find((el) => {
      const x = Number(el.style.transform.match(/-?[\d.]+/)?.[0]);
      return el.style.opacity === "1" && x > 200 && x < 500;
    })!;
    const [x, y] = dot.style.transform.match(/-?[\d.]+/g)!.map(Number) as [number, number];
    touch("touchstart", [[x - 100, y], [x, y]], 1000);
    touch("touchmove", [[x - 150, y], [x + 50, y]], 1020);
    touch("touchend", [[x + 50, y]], 1040);
    expect(Number(svg().getAttribute("data-mi-zoom"))).toBeCloseTo(2);
    touch("touchend", [], 1060);
    touch("touchstart", [[x + 50, y]], 1100);
    touch("touchend", [], 1120);
    act(() => void svg().querySelector('rect[fill="transparent"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x + 50, clientY: y })));
    expect({ zoom: Number(svg().getAttribute("data-mi-zoom")).toFixed(6), tooltip: Boolean(host.querySelector('[role="tooltip"]')) }).toEqual({ zoom: "2.000000", tooltip: true });
  });

  describe("desktop wheel zoom", () => {
    const wheel = (deltaY: number, [clientX, clientY]: [number, number], time: number) => {
      // happy-dom's WheelEvent drops clientX.
      const event = new MouseEvent("wheel", { bubbles: true, cancelable: true, clientX, clientY });
      for (const [key, value] of Object.entries({ deltaX: 0, deltaY, deltaMode: 0, timeStamp: time })) Object.defineProperty(event, key, { value });
      act(() => void svg().querySelector('rect[fill="transparent"]')!.dispatchEvent(event));
      return event;
    };
    const mouse = (target: EventTarget, type: string, [clientX, clientY]: [number, number]) =>
      act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })));
    const zoomed = () => Number(svg().getAttribute("data-mi-zoom"));
    const spot = (dot: SVGGElement) => dot.style.transform.match(/-?[\d.]+/g)!.map(Number) as [number, number];

    it("zooms on the wheel, hides the tooltip, pans, and resets on double-click and index change", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await rebuild(false, { width: 780, height: 330 });
      expect(button("Full Screen")).toBeNull();
      const dot = [...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].find((el) => el.style.opacity === "1")!;
      const [x, y] = spot(dot);
      act(() => dot.querySelector<SVGElement>("[aria-label]")!.focus());
      expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
      expect(wheel(-300, [x, y], 1000).defaultPrevented).toBe(true);
      expect(host.querySelector('[role="tooltip"]')).toBeNull();
      act(() => vi.advanceTimersByTime(200));
      expect(zoomed()).toBeGreaterThan(1);
      expect(spot(dot)[0]).toBeCloseTo(x);
      expect(spot(dot)[1]).toBeCloseTo(y);
      expect([...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].some((el) => el.style.opacity === "0")).toBe(true);
      mouse(svg().querySelector("rect[fill=transparent]")!, "mousedown", [x, y]);
      mouse(window, "mousemove", [x + 40, y]);
      mouse(window, "mouseup", [x + 40, y]);
      expect(spot(dot)[0]).toBeCloseTo(x + 40);
      // SAFETY: phone and motion checks only read .matches.
      vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("reduce") }) as MediaQueryList);
      mouse(svg(), "dblclick", [x, y]);
      expect(zoomed()).toBe(1);
      expect(svg().querySelector("style")?.textContent).toContain("transform 0s");
      wheel(-300, [x, y], 2000);
      act(() => vi.advanceTimersByTime(200));
      expect(zoomed()).toBeGreaterThan(1);
      pick("Benchmark", "Coding");
      expect(zoomed()).toBe(1);
    });

    describe("hover while the wheel zooms", () => {
      const hit = () => svg().querySelector<SVGRectElement>("rect[fill=transparent]")!;
      const tooltip = () => host.querySelector('[role="tooltip"]');
      const hover = (target: EventTarget, [clientX, clientY]: [number, number]) => mouse(target, "mousemove", [clientX, clientY]);
      let dot: SVGGElement;
      let old: [number, number];

      beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await rebuild(false, { width: 780, height: 330 });
        // happy-dom has no layout, so give the hit rect the box it has in a browser.
        hit().getBoundingClientRect = () => ({ left: Number(hit().getAttribute("x")), top: Number(hit().getAttribute("y")) }) as DOMRect;
        dot = badges().find((el) => el.style.opacity === "1")!;
        old = spot(dot);
        wheel(-300, [old[0] + 20, old[1]], 1000);
        act(() => vi.advanceTimersByTime(40));
      });

      it("opens no tooltip for a dot's old spot, then follows it to the new spot", () => {
        hover(hit(), old);
        expect(tooltip()).toBeNull();
        act(() => vi.advanceTimersByTime(200));
        expect(spot(dot)[0]).not.toBeCloseTo(old[0]);
        hover(hit(), spot(dot));
        expect(tooltip()).not.toBeNull();
      });

      it("keeps hover off through a drag that outlasts the wheel", () => {
        mouse(hit(), "mousedown", old);
        act(() => vi.advanceTimersByTime(200));
        hover(window, old);
        hover(hit(), old);
        expect(tooltip()).toBeNull();
        mouse(window, "mouseup", old);
      });
    });

    it("leaves the phone chart to the page scroll", async () => {
      await rebuild(true, { width: 366, height: 330 });
      expect(wheel(-300, [100, 100], 1000).defaultPrevented).toBe(false);
      expect(svg().getAttribute("data-mi-zoom")).toBeNull();
    });
  });
});

describe("model index provider marks", () => {
  const providers = { anthropic: "claudeAgent", openai: "codex", google: "geminiAgent", xai: "grokAgent", meta: "museAgent" } as const;
  const glyph = (element: Element) => [...element.querySelectorAll("path, rect")].map((part) => [part.tagName, part.getAttribute("d"), part.getAttribute("width")]);

  it("uses the base icon for each chart badge and the picker mark for each phone chip", async () => {
    for (const [provider, driverKind] of Object.entries(providers) as Array<[keyof typeof providers, string]>) {
      const expected = document.createElement("div");
      expected.innerHTML = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 12 }));
      await act(async () => root.render(createElement("svg", null, createElement(Badge, { provider: provider as keyof typeof providers, r: 8, clip: "test" }))));
      const icon = host.querySelector("image");
      expect(icon?.getAttribute("href")).toContain({ anthropic: "icon-45-engine-claude.png", openai: "icon-46-engine-codex.png", google: "icon-47-engine-gemini.png", xai: "icon-48-engine-grok.png", meta: "icon-49-engine-muse.png" }[provider]);
      await act(async () => root.render(createElement(ProviderChips, { providers: [provider as keyof typeof providers], value: null, onChange: () => undefined, t })));
      expect(host.querySelector("img")).toBeNull();
      expect(glyph(host)).toEqual(glyph(expected));
    }
    await act(async () => root.render(createElement("svg", null, createElement(Badge, { provider: "other", r: 8, clip: "test" }))));
    expect(host.querySelector("svg svg, image")).toBeNull();
    expect(host.querySelector('circle[style*="--mi-other"]')).not.toBeNull();
  });

  it("renders marks in the phone list and base icons in charts", async () => {
    const desktop = host.querySelector("[data-mi-badge]")!;
    expect(desktop.querySelector("svg")).toBeNull();
    expect(desktop.querySelector("image[href*='icon-']")).not.toBeNull();
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") }) as MediaQueryList);
    try {
      await mount();
      const row = host.querySelector("[data-mi-row]")!;
      expect(row.querySelector("img[src*='icon-']")).toBeNull();
      expect(row.querySelector("svg")).not.toBeNull();
      pick("Chart", "Chart");
      const dot = host.querySelector("[data-mi-dot]")!;
      expect(dot.querySelector("svg")).toBeNull();
      expect(dot.querySelector("image[href*='icon-']")).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("phone model index", () => {
  const rebuild = async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe = () => this.cb([{ contentRect: { width: 360, height: 600 } }]);
        disconnect = () => undefined;
      },
    );
    // SAFETY: isPhone only reads .matches
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("max-width") }) as MediaQueryList);
    await mount();
  };
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>("[data-mi-row]")];
  const intelligence = () => {
    const models = new Map<string, string>();
    for (const entry of MODEL_INDEX_ENTRIES) if (entry.index === "intelligence") models.set(entry.model, entry.label);
    return models;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on Ranked with one row per model at its best effort and every name whole", async () => {
    await rebuild();
    expect(chosen("Chart")).toBe("Ranked");
    const shown = rows();
    expect(shown.length).toBeGreaterThan(5);
    expect(new Set(shown.map((row) => row.dataset.miRow)).size).toBe(shown.length);
    const labels = intelligence();
    for (const row of shown) {
      const name = row.querySelector("[data-mi-name]")!;
      expect(name.textContent).toBe(labels.get(row.dataset.miRow!));
      expect(name.className).not.toMatch(/truncate|ellipsis/);
    }
    const best = Math.max(...MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence" && entry.model === shown[0]!.dataset.miRow).map((entry) => entry.score));
    expect(shown[0]!.textContent).toContain(best.toFixed(1));
    expect(host.textContent).toContain("Tap a model for every effort level");
  });

  it("opens a model's every effort on tap", async () => {
    await rebuild();
    const row = rows().find((el) => MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence" && entry.model === el.dataset.miRow).length > 2)!;
    const efforts = MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence" && entry.model === row.dataset.miRow);
    act(() => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("true");
    for (const entry of efforts) expect(row.textContent).toContain(entry.effort === "all" ? entry.score.toFixed(1) : `${entry.effort} ${entry.score.toFixed(1)}`);
  });

  it("filters by lab and keeps every lab's chip", async () => {
    await rebuild();
    const chip = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((el) => el.textContent === name)!;
    for (const name of ["All", "Anthropic", "OpenAI", "Google"]) expect(chip(name)).toBeTruthy();
    act(() => chip("Anthropic").click());
    const anthropic = new Set(MODEL_INDEX_ENTRIES.filter((entry) => entry.provider === "anthropic").map((entry) => entry.model));
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().every((row) => anthropic.has(row.dataset.miRow!))).toBe(true);
    act(() => chip("All").click());
    expect(rows().some((row) => !anthropic.has(row.dataset.miRow!))).toBe(true);
  });

  it("names more than the top 3, draws no effort line until a dot is tapped, then shows its callout and efforts", async () => {
    await rebuild();
    pick("Chart", "Chart");
    const chart = host.querySelector("[data-mi-phone-chart]")!;
    const names = [...chart.querySelectorAll("text[data-mi-name]")].map((el) => el.getAttribute("data-mi-name"));
    expect(names.length).toBeGreaterThan(3);
    expect(chart.textContent).toContain(`${names.length} named.`);
    expect(chart.querySelectorAll("[data-mi-effort], [data-mi-line], line[stroke-dasharray]")).toHaveLength(0);
    const efforts = (model: string) => MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence" && entry.model === model && entry.cost);
    const first = chart.querySelector('[aria-pressed="true"]')!.closest("[data-mi-dot]")!.getAttribute("data-mi-dot");
    const model = [...intelligence().keys()].find((id) => id !== first && efforts(id).length > 1)!;
    const dot = chart.querySelector<SVGElement>(`[data-mi-dot="${model}"] [role="button"]`)!;
    act(() => void dot.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(chart.querySelector("[data-mi-callout]")!.textContent).toContain(intelligence().get(model));
    expect(dot.getAttribute("aria-pressed")).toBe("true");
    const numbers = (text: string | null) => (text ?? "").match(/-?[\d.]+/g)!.map(Number);
    expect(numbers(chart.querySelector(`[data-mi-effort="${model}"] polyline`)!.getAttribute("points"))).toHaveLength(efforts(model).length * 2);
    expect(chart.querySelectorAll(`[data-mi-effort="${model}"] circle`)).toHaveLength(efforts(model).length - 1);
  });

  it("titles the phone Cost list with the input / output prices it shows", async () => {
    await rebuild();
    pick("Benchmark", "Cost");
    const meta = host.querySelector("[data-mi-row]")!.closest(".model-index")!.textContent!;
    expect(meta).toContain("Price per 1M, in / out");
    expect(meta).not.toContain("Blended");
  });

  it("rounds the phone chart's score ticks on a one-model lab", async () => {
    await rebuild();
    pick("Benchmark", "Design");
    pick("Chart", "Chart");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((el) => el.textContent === "xAI")!.click());
    const chart = host.querySelector("[data-mi-phone-chart] svg[aria-label]")!;
    expect(chart.getAttribute("role")).toBe("group");
    expect([...chart.querySelectorAll("text")].map((el) => el.textContent).filter((text) => /\d\.\d{3,}/.test(text ?? ""))).toEqual([]);
  });

  it("keeps the lab filter in the full screen chart", async () => {
    await rebuild();
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((el) => el.textContent === "Anthropic")!.click());
    pick("Chart", "Chart");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Full Screen"]')!.click());
    const labels = [...host.querySelectorAll('[data-mi-full] svg [aria-label][tabindex="0"]')].map((el) => el.getAttribute("aria-label")!);
    expect(labels.some((label) => label.startsWith("Claude"))).toBe(true);
    expect(labels.filter((label) => /GPT|Gemini|Grok|Muse/.test(label))).toEqual([]);
  });

  it("keeps a gap between two chart names so they never read as one", () => {
    const named = [
      { id: "gemini", text: "Gemini 4 Carbon", at: { x: 302, y: 251 } },
      { id: "opus", text: "Opus 5.5", at: { x: 321, y: 246 } },
    ];
    const placed = placeNames(named, named.map((name) => name.at), { left: 34, top: 14, right: 380, bottom: 346 });
    const [a, b] = named.map(({ id, text }) => {
      const { x, y, anchor } = placed.get(id)!;
      const w = text.length * 7;
      const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      return { left, right: left + w, top: y - 11, bottom: y + 3 };
    });
    const apart = Math.max(b!.left - a!.right, a!.left - b!.right) >= 10 || Math.max(b!.top - a!.bottom, a!.top - b!.bottom) >= 2;
    expect(apart).toBe(true);
  });
});

describe("chart layout", () => {
  type Box = { x: number; y: number; w: number; h: number };
  type Disc = { x: number; y: number; r: number };
  // The charts' own estimate when there is no canvas to measure with.
  const width = (text: string, px: number) => text.length * (px > 12 ? 7 : 6);
  const numbers = (text: string | null) => (text ?? "").match(/-?[\d.]+/g)!.map(Number);
  const hits = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const covers = (box: Box, disc: Disc) =>
    Math.hypot(Math.max(box.x, Math.min(disc.x, box.x + box.w)) - disc.x, Math.max(box.y, Math.min(disc.y, box.y + box.h)) - disc.y) < disc.r;
  const shown = (el: Element) => !/opacity:\s*0(?![.\d])/.test(el.getAttribute("style") ?? "") && el.getAttribute("opacity") !== "0";
  const radius = (el: Element) =>
    Math.max(
      0,
      ...[...el.querySelectorAll("circle, path")]
        .filter((part) => part.getAttribute("fill") !== "transparent" && [part, ...part.parentElement?.closest("[data-mi-paint]") ? [part.parentElement.closest("[data-mi-paint]")!] : []].every(shown))
        .map((part) => (part.tagName === "path" ? 4.3 : Number(part.getAttribute("r")))),
    );
  const render = async (phone: boolean, size: number) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: (entries: unknown[]) => void) {}
        observe = () => this.cb([{ contentRect: { width: size, height: 600 } }]);
        disconnect = () => undefined;
      },
    );
    // SAFETY: isPhone only reads .matches
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: phone && query.includes("max-width") }) as MediaQueryList);
    await mount();
    if (phone) pick(t("modelIndex.viewLabel"), t("modelIndex.view.chart"));
  };
  type Line = { a: { x: number; y: number }; b: { x: number; y: number }; own?: Box };
  // Liang-Barsky, as the chart uses.
  const cuts = ({ a, b }: Line, box: Box) => {
    let [t0, t1] = [0, 1];
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    for (const [p, q] of [[-dx, a.x - box.x], [dx, box.x + box.w - a.x], [-dy, a.y - box.y], [dy, box.y + box.h - a.y]] as const) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      if (p < 0) t0 = Math.max(t0, q / p);
      else t1 = Math.min(t1, q / p);
      if (t0 > t1) return false;
    }
    return true;
  };
  const clash = (labels: Box[], marks: Disc[], lines: Line[] = []) => [
    ...labels.flatMap((a, i) => labels.slice(i + 1).filter((b) => hits(a, b)).map(() => "label/label")),
    ...labels.flatMap((box) => marks.filter((disc) => covers(box, disc)).map(() => "label/marker")),
    ...marks.flatMap((a, i) => marks.slice(i + 1).filter((b) => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 0.5).map(() => "marker/marker")),
    ...lines.flatMap((line) => labels.filter((box) => box !== line.own && cuts(line, box)).map(() => "line/label")),
  ];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("overlaps no name with another name or a marker on the phone chart at 390", async () => {
    await render(true, 358);
    const chart = host.querySelector("[data-mi-phone-chart] svg[role=group]")!;
    const labels = [...chart.querySelectorAll("text[data-mi-name]")].map((el) => {
      const [x, y, w] = [Number(el.getAttribute("x")), Number(el.getAttribute("y")), width(el.textContent!, 12.5)];
      const anchor = el.getAttribute("text-anchor");
      return { x: anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x, y: y - 10, w, h: 13 };
    });
    const marks = [...chart.querySelectorAll("[data-mi-dot]")].map((el) => {
      const circle = el.querySelector("circle[cx]");
      const [x, y] = circle ? [Number(circle.getAttribute("cx")), Number(circle.getAttribute("cy"))] : numbers(el.getAttribute("transform"));
      return { x: x!, y: y!, r: radius(el) };
    });
    const efforts = [...chart.querySelectorAll("polyline")].filter((el) => el.getAttribute("stroke-opacity") !== "0").flatMap((el) => {
      const at = numbers(el.getAttribute("points"));
      return Array.from({ length: at.length / 2 - 1 }, (_, i) => ({ a: { x: at[i * 2]!, y: at[i * 2 + 1]! }, b: { x: at[i * 2 + 2]!, y: at[i * 2 + 3]! } }));
    });
    const leaders = [...chart.querySelectorAll("text[data-mi-name]")].flatMap((el, i) => {
      const line = el.parentElement?.querySelector("line");
      if (!line) return [];
      const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((name) => Number(line.getAttribute(name)));
      return [{ a: { x: x1!, y: y1! }, b: { x: x2!, y: y2! }, own: labels[i] }];
    });
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(clash(labels, marks, [...efforts, ...leaders])).toEqual([]);
  });

  it("drops a desktop pick the next benchmark does not plot instead of dimming every model", async () => {
    await render(false, 594);
    const chart = () => host.querySelector("svg[role=img]")!;
    const names = () => [...chart().querySelectorAll("text[data-mi-label]")].map((el) => el.textContent);
    let checked = false;
    for (let i = 0; !checked && i < chart().querySelectorAll("[data-mi-point]").length; i++) {
      await mount();
      const point = [...chart().querySelectorAll<SVGGElement>("[data-mi-point]")].filter((el) => el.querySelector("[data-mi-badge]"))[i];
      if (!point) break;
      const [x, y] = numbers(point.style.transform);
      act(() => chart().querySelector("rect[fill=transparent]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y })));
      const name = chart().querySelector('[data-mi-focus=""] text[data-mi-label]')?.textContent;
      if (!name) continue;
      pick("Benchmark", "Design");
      if (names().includes(name)) continue;
      expect(chart().querySelectorAll('[data-mi-focus="dim"]')).toHaveLength(0);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it("drops a phone pick the next benchmark does not plot instead of lining another model", async () => {
    await render(true, 358);
    const chart = () => host.querySelector("[data-mi-phone-chart] svg[role=group]")!;
    const design = new Set(MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "design").map((entry) => entry.model));
    const efforts = (model: string) => MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence" && entry.model === model && entry.cost).length;
    const gone = [...chart().querySelectorAll("[data-mi-dot] [role=button]")].find((el) => {
      const model = MODEL_INDEX_ENTRIES.find((entry) => entry.index === "intelligence" && el.getAttribute("aria-label")?.startsWith(`${entry.label} `))?.model;
      return model && !design.has(model) && efforts(model) > 1;
    });
    expect(gone).toBeDefined();
    act(() => gone!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(chart().querySelector("[data-mi-effort]")).not.toBeNull();
    pick("Benchmark", "Design");
    expect(chart().querySelector("[data-mi-effort]")).toBeNull();
  });

  it("keeps badges apart after pulling them inside the frame", () => {
    const [a, b] = dodge([{ x: -50, y: 50 }, { x: -10, y: 50 }], 8, { left: 0, top: 0, right: 100, bottom: 100 });
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThanOrEqual(19.9);
  });

  it("overlaps no name with another name or a marker on the desktop chart at 1440", async () => {
    await render(false, 594);
    const chart = host.querySelector("svg[role=img]")!;
    const labels = [...chart.querySelectorAll<SVGTextElement>("text[data-mi-label]")].filter(shown).map((el) => {
      const [x, y] = numbers(el.style.transform);
      return { x: x!, y: y! - 8, w: width(el.textContent!, 10.5), h: 10 };
    });
    const marks = [...chart.querySelectorAll<SVGGElement>("[data-mi-point]")]
      .filter(shown)
      .map((el) => {
        const [x, y] = numbers(el.style.transform);
        const [dx = 0, dy = 0] = el.querySelector(":scope > g[transform]") ? numbers(el.querySelector(":scope > g[transform]")!.getAttribute("transform")) : [];
        return { x: x! + dx, y: y! + dy, r: radius(el) };
      })
      .filter((disc) => disc.r > 0);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(clash(labels, marks)).toEqual([]);
  });
});
