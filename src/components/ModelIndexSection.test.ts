import "./ProfileFields.test-dom.ts";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, applyLocale, localeTag } from "@/lib/i18n";
import { useSettingsSwipe } from "@/lib/use-settings-swipe";
import { MODEL_INDEX_ENTRIES, MODEL_INDEX_SOURCES } from "../../shared/model-index-data.ts";

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { instances: [] }, dispatch: () => undefined }),
}));

import { ModelIndexSection } from "./ModelIndexSection";

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
    expect(kept()).toEqual([true]);
    act(() => argon().focus());
    expect(kept()).toEqual([true, true]);
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

  it("gives phones a taller plot than desktop at the same width, never a shorter one", async () => {
    const svgHeight = () => Number(host.querySelector("svg[role=img]")?.getAttribute("height"));
    const media = vi.spyOn(window, "matchMedia");
    const heights = async (width: number) => {
      // SAFETY: the chart reads only `matches` from its media queries.
      media.mockReturnValue({ matches: false } as MediaQueryList);
      await rebuild(width);
      const desktop = svgHeight();
      // SAFETY: the chart reads only `matches` from its media queries.
      media.mockImplementation((query) => ({ matches: query.includes("max-width") }) as MediaQueryList);
      await rebuild(width);
      return { desktop, phone: svgHeight() };
    };
    try {
      const narrow = await heights(294);
      expect(narrow.phone - narrow.desktop).toBeGreaterThanOrEqual(30);
      const wide = await heights(640);
      expect(wide.phone).toBe(wide.desktop);
    } finally {
      media.mockRestore();
    }
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
  };
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const svg = () => host.querySelector<SVGSVGElement>("svg[role=img]")!;
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
    const dot = [...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].find((el) => el.style.opacity === "1")!;
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
    const dot = [...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].find((el) => el.style.opacity === "1")!;
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
    const dot = [...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].find((el) => {
      const x = Number(el.style.transform.match(/-?[\d.]+/)?.[0]);
      return el.style.opacity === "1" && x > 200 && x < 500;
    })!;
    const [x, y] = dot.style.transform.match(/-?[\d.]+/g)!.map(Number) as [number, number];
    touch("touchstart", [[x - 100, y], [x, y]], 1000);
    touch("touchmove", [[x - 150, y], [x + 50, y]], 1020);
    touch("touchend", [[x + 50, y]], 1040);
    expect(svg().getAttribute("data-mi-zoom")).toBe("2");
    touch("touchend", [], 1060);
    touch("touchstart", [[x + 50, y]], 1100);
    touch("touchend", [], 1120);
    act(() => void svg().querySelector('rect[fill="transparent"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x + 50, clientY: y })));
    expect({ zoom: svg().getAttribute("data-mi-zoom"), tooltip: Boolean(host.querySelector('[role="tooltip"]')) }).toEqual({ zoom: "2", tooltip: true });
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
        dot = [...svg().querySelectorAll<SVGGElement>("[data-mi-point]")].find((el) => el.style.opacity === "1")!;
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
