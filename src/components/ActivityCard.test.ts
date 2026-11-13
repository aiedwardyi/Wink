// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RIPPLE_GAP_MS } from "@/lib/activity-glitter";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { ActivityCard, engineShares, resetActivity, warmActivity } from "./ActivityCard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetActivity();
  localStorage.clear();
  persistPreference("en");
});

const activityOf = (counts: number[], start = "2026-05-10") => {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return { start, counts, busiest: { day: start, count: Math.max(...counts) }, total, workers: 12, engines: [{ engine: "claudeAgent", count: total }] };
};

function mount(waved?: { current: boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(I18nProvider, null, createElement(ActivityCard, { waved }))));
  return { host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

async function renderCard(counts: number[], start = "2026-05-10") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(activityOf(counts, start)))));
  const card = mount();
  await act(async () => {});
  return card;
}

const weeks = (fill: (day: number) => number) => Array.from({ length: 182 }, (_, day) => fill(day));
const squaresOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-day]")];

it("spreads small days across shades when one day spikes", async () => {
  const { host, unmount } = await renderCard(weeks((day) => (day === 100 ? 212 : day % 3 === 0 ? 0 : (day % 20) + 1)));
  try {
    const squares = squaresOf(host);
    const shades = new Set(squares.filter((_, day) => day !== 100 && day % 3 !== 0).map((square) => square.className.match(/bg-accent(\/\d+)?/)![0]));
    expect(shades.size).toBeGreaterThanOrEqual(3);
    expect(squares[100]!.classList.contains("bg-accent")).toBe(true);
    expect(squares[0]!.className).toContain("bg-control");
  } finally {
    await unmount();
  }
});

it.each(["2026-05-10", "2026-05-03", "2026-05-17", "2026-04-26"])("labels the current month without overlap from %s", async (start) => {
  const { host, unmount } = await renderCard(weeks(() => 1), start);
  try {
    const labels = [...host.querySelectorAll<HTMLElement>("[aria-hidden] > div:first-child > span")];
    const spans = labels.map((label) => {
      const [from, span] = label.style.gridColumn.split(" / span ").map(Number);
      return { from: from!, to: from! + span!, text: label.textContent };
    });
    for (const [index, span] of spans.entries()) {
      expect(span.to).toBeLessThanOrEqual(27);
      if (index) expect(span.from).toBeGreaterThanOrEqual(spans[index - 1]!.to);
    }
    const last = new Date(`${start}T00:00:00`);
    last.setDate(last.getDate() + 25 * 7);
    expect(spans.at(-1)!.text).toBe(new Intl.DateTimeFormat("en", { month: "short" }).format(last));
  } finally {
    await unmount();
  }
});

it("paints the last result on the first frame and refreshes behind it", async () => {
  localStorage.setItem("omb-activity", JSON.stringify(activityOf(weeks((day) => (day === 7 ? 9 : 0)))));
  let answer!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
  const { host, unmount } = mount();
  try {
    expect(squaresOf(host)[7]!.className).toContain("bg-accent");
    expect(host.textContent).toContain("Best Day");
    await act(async () => answer(new Response(JSON.stringify(activityOf(weeks((day) => (day === 8 ? 4 : 0)))))));
    expect(squaresOf(host)[7]!.className).toContain("bg-control");
    expect(squaresOf(host)[8]!.className).toContain("bg-accent");
    expect(JSON.parse(localStorage.getItem("omb-activity")!).counts[8]).toBe(4);
  } finally {
    await unmount();
  }
});

it("paints warmed numbers on the first open with nothing saved", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(activityOf(weeks((day) => (day === 7 ? 9 : 0)))))));
  await warmActivity();
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const { host, unmount } = mount();
  try {
    expect(squaresOf(host)[7]!.className).toContain("bg-accent");
    expect(host.querySelector(".invisible")).toBeNull();
    expect(host.textContent).toContain("Best Day");
  } finally {
    await unmount();
  }
});

it("holds the card's place with an empty grid before the first answer", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const { host, unmount } = mount();
  try {
    expect(host.textContent).toContain("Activity");
    const squares = squaresOf(host);
    expect(squares.length).toBeGreaterThan(26 * 6);
    expect(squares.every((square) => square.className.includes("bg-control"))).toBe(true);
  } finally {
    await unmount();
  }
});

it("skips a broken saved result and hides the card when the server has none", async () => {
  localStorage.setItem("omb-activity", JSON.stringify({ counts: [1, 2] }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const { host, unmount } = mount();
  try {
    expect(squaresOf(host).every((square) => square.className.includes("bg-control"))).toBe(true);
    await act(async () => {});
    expect(host.textContent).toBe("");
  } finally {
    await unmount();
  }
});

it("treats an array start as broken, saved or fetched", async () => {
  const broken = { ...activityOf(weeks(() => 1)), start: ["2026-05-10"] };
  localStorage.setItem("omb-activity", JSON.stringify(broken));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(broken))));
  const { host, unmount } = mount();
  try {
    expect(squaresOf(host).every((square) => square.className.includes("bg-control"))).toBe(true);
    await act(async () => {});
    expect(host.textContent).toBe("");
    expect(localStorage.getItem("omb-activity")).toBe(JSON.stringify(broken));
  } finally {
    await unmount();
  }
});

it.each([
  ["en", 7, "May 17 · 923 replies"],
  ["en", 8, "May 18 · No replies"],
  ["en", 9, "May 19 · 1 reply"],
  ["ko", 7, "5월 17일 · 답변 923개"],
  ["ko", 8, "5월 18일 · 답변 없음"],
] as const)("tips a hovered day in %s", async (locale, day, text) => {
  persistPreference(locale);
  const { host, unmount } = await renderCard(weeks((index) => (index === 7 ? 923 : index === 9 ? 1 : 0)));
  try {
    const square = squaresOf(host)[day]!;
    await act(async () => square.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
    expect(document.querySelector("[data-activity-tip]")?.textContent).toBe(text);
    expect(square.className).toContain("scale-125");
    await act(async () => square.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })));
    expect(document.querySelector("[data-activity-tip]")).toBeNull();
  } finally {
    await unmount();
  }
});

it("shows a tapped day's tip until a tap lands elsewhere", async () => {
  const { host, unmount } = await renderCard(weeks((day) => (day === 7 ? 923 : 0)));
  try {
    await act(async () => squaresOf(host)[7]!.click());
    expect(document.querySelector("[data-activity-tip]")?.textContent).toBe("May 17 · 923 replies");
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })));
    expect(document.querySelector("[data-activity-tip]")).toBeNull();
  } finally {
    await unmount();
  }
});

it("waves once per Settings open when the card remounts", async () => {
  const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => undefined);
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(activityOf(weeks(() => 1))))));
  localStorage.setItem("omb-activity", JSON.stringify(activityOf(weeks(() => 1))));
  try {
    const waved = { current: false };
    let card = mount(waved);
    await act(async () => {});
    expect(animate).toHaveBeenCalled();
    await card.unmount();
    animate.mockClear();
    card = mount(waved);
    await act(async () => {});
    expect(animate).not.toHaveBeenCalled();
    await card.unmount();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("settles each square down with one glint inside 700 ms, and not at all under reduced motion", async () => {
  const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => undefined);
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
  const matchMedia = (reduce: boolean) => vi.fn((query: string) => ({ matches: reduce && query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  try {
    vi.stubGlobal("matchMedia", matchMedia(false));
    localStorage.setItem("omb-activity", JSON.stringify(activityOf(weeks(() => 1))));
    let card = await renderCard(weeks(() => 1));
    const calls = animate.mock.calls;
    expect(calls.length).toBe(squaresOf(card.host).length);
    expect(Math.max(...calls.map(([, { delay = 0, duration = 0 }]) => delay + Number(duration)))).toBeLessThanOrEqual(700);
    expect(calls[0]![1].delay).toBe(0);
    expect(calls[7]![1].delay).toBeGreaterThan(0);
    expect(calls[0]![0][0]).toMatchObject({ opacity: 0.35, transform: "translateY(-3px)" });
    expect(calls[0]![0].at(-1)).toMatchObject({ opacity: 1, transform: "none" });
    expect(calls[0]![0].some(({ filter }) => filter !== "brightness(1)")).toBe(true);
    await card.unmount();
    animate.mockClear();
    vi.stubGlobal("matchMedia", matchMedia(true));
    card = await renderCard(weeks(() => 1));
    expect(animate).not.toHaveBeenCalled();
    await card.unmount();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("keeps the glint gentle on a light skin so pale squares stay visible", async () => {
  const animate = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => undefined);
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  localStorage.setItem("omb-skin", "wink-day");
  try {
    const card = await renderCard(weeks(() => 1));
    expect(animate.mock.calls[0]![0].map(({ filter }) => filter)).toContain("brightness(1.05)");
    await card.unmount();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

const over = (square: HTMLElement, pointerType = "mouse") => act(async () => square.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType })));
const shadeOf = (square: HTMLElement) => square.className.match(/bg-(control|accent(\/\d+)?)/)![0];
const ACCENT = "#336699";
const SHEEN = "rgb(184,201,219)";

async function glitterCard({ reduce = false, skin = "" } = {}) {
  const fills: { day: number; light: number; color: string; at: number }[] = [];
  const paint = { box: [0, 0], lit: 0 };
  const ctx = {
    fillStyle: "",
    globalAlpha: 1,
    clearRect() { paint.lit = 0; },
    beginPath() {},
    roundRect(x: number, y: number) { paint.box = [x, y]; },
    fill() {
      paint.lit++;
      fills.push({ day: (paint.box[0]! / 10) * 7 + paint.box[1]! / 10, light: ctx.globalAlpha, color: ctx.fillStyle, at: performance.now() });
    },
  };
  const getContext = vi.fn(() => ctx);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: getContext, configurable: true, writable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 260, 70));
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: reduce && query.includes("reduce"), addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(activityOf(weeks((day) => (day === 80 ? 923 : day % 5)))))));
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("getComputedStyle", () => ({ columnGap: "0px", rowGap: "0px", getPropertyValue: () => ACCENT }));
  if (skin) localStorage.setItem("omb-skin", skin);
  const card = mount({ current: true });
  await act(async () => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  let mounted = true;
  const unmount = async () => {
    if (mounted) await card.unmount();
    mounted = false;
  };
  const restore = async () => {
    await unmount();
    vi.useRealTimers();
    Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  };
  const frames = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  return { host: card.host, fills, paint, getContext, frames, unmount, restore };
}

it("ripples out from a hovered square and leaves every square as it was", async () => {
  const { host, fills, paint, frames, restore } = await glitterCard();
  try {
    const squares = squaresOf(host);
    const shades = squares.map(shadeOf);
    expect(new Set(shades).size).toBe(5);
    await over(squares[80]!);
    expect(document.querySelector("[data-activity-tip]")?.textContent).toBe("Jul 29 · 923 replies");
    await frames(1000);
    const first = (day: number) => fills.find((fill) => fill.day === day)!.at;
    expect(first(80 - 7)).toBeGreaterThan(first(80));
    expect(first(80 - 21)).toBeGreaterThan(first(80 - 7));
    expect(fills.some((fill) => fill.day === 80 - 49)).toBe(true);
    expect(fills.some((fill) => fill.day === 80 - 56)).toBe(false);
    expect(fills.every((fill) => fill.light > 0 && fill.light <= 1 && fill.color === SHEEN)).toBe(true);
    expect(paint.lit).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(squares.map(shadeOf)).toEqual(shades);
    expect(host.querySelector("[data-day][style], [data-day] > *")).toBeNull();
  } finally {
    await restore();
  }
});

it("ripples once per gap and never restarts a glint in flight", async () => {
  const { host, fills, frames, restore } = await glitterCard();
  try {
    const squares = squaresOf(host);
    const lit = (day: number) => fills.filter((fill) => fill.day === day);
    await over(squares[80]!);
    await frames(RIPPLE_GAP_MS - 1);
    await over(squares[94]!);
    await frames(1);
    await over(squares[73]!);
    await frames(2000);
    expect(lit(94 + 49)).toEqual([]);
    expect(lit(73 - 49).length).toBeGreaterThan(0);
    expect(lit(80).at(-1)!.at - lit(80)[0]!.at).toBeLessThan(420);
    const drawn = fills.length;
    await over(squares[80]!);
    await frames(2000);
    expect(fills.length).toBeGreaterThan(drawn);
  } finally {
    await restore();
  }
});

it("does nothing between touches", async () => {
  const { host, fills, getContext, frames, restore } = await glitterCard();
  try {
    await frames(10_000);
    expect(getContext).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await over(squaresOf(host)[80]!);
    expect(vi.getTimerCount()).toBe(1);
    await frames(2000);
    const drawn = fills.length;
    expect(drawn).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    await frames(10_000);
    expect(fills.length).toBe(drawn);
  } finally {
    await restore();
  }
});

it("stops drawing once the card is gone", async () => {
  const { host, fills, frames, unmount, restore } = await glitterCard();
  try {
    await over(squaresOf(host)[80]!);
    await frames(48);
    const drawn = fills.length;
    expect(drawn).toBeGreaterThan(0);
    await unmount();
    await frames(2000);
    expect(fills.length).toBe(drawn);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await restore();
  }
});

it("keeps the squares still under reduced motion and still tips the day", async () => {
  const { host, fills, getContext, frames, restore } = await glitterCard({ reduce: true });
  try {
    await over(squaresOf(host)[80]!);
    await frames(1000);
    expect(getContext).not.toHaveBeenCalled();
    expect(fills).toEqual([]);
    expect(document.querySelector("[data-activity-tip]")?.textContent).toBe("Jul 29 · 923 replies");
  } finally {
    await restore();
  }
});

it("ripples under a finger and lets a drag reach the next square", async () => {
  const { host, fills, frames, restore } = await glitterCard();
  try {
    const square = squaresOf(host)[80]!;
    const release = vi.fn();
    Object.assign(square, { hasPointerCapture: () => true, releasePointerCapture: release });
    await over(square, "touch");
    await frames(32);
    expect(fills.some((fill) => fill.day === 80)).toBe(true);
    expect(document.querySelector("[data-activity-tip]")).toBeNull();
    await act(async () => square.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 7 })));
    expect(release).toHaveBeenCalledWith(7);
  } finally {
    await restore();
  }
});

it("deepens pale squares on a light skin instead of washing them out", async () => {
  const { host, fills, frames, restore } = await glitterCard({ skin: "wink-day" });
  try {
    const squares = squaresOf(host);
    await over(squares[80]!);
    await frames(1000);
    const colors = (full: boolean) => new Set(fills.filter((fill) => /bg-accent(\/75)?$/.test(shadeOf(squares[fill.day]!)) === full).map((fill) => fill.color));
    expect([...colors(false)]).toEqual([ACCENT]);
    expect([...colors(true)]).toEqual([SHEEN]);
  } finally {
    await restore();
  }
});

it.each([
  ["en", "Since Jun 2025", ["Most workers at once", "Best Day", "Total Replies"]],
  ["ko", "2025년 6월부터", ["최대 동시 작업자", "최고의 날", "총 답변"]],
] as const)("keeps the first day on the total's hover in %s", async (locale, title, labels) => {
  persistPreference(locale);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...activityOf(weeks(() => 2)), since: "2025-06-03", total: 24317 }))));
  const { host, unmount } = mount();
  await act(async () => {});
  try {
    const total = [...host.querySelectorAll<HTMLElement>("[title]")];
    expect(total.map((el) => [el.textContent, el.title])).toEqual([["24,317", title]]);
    for (const label of labels) expect(host.textContent).toContain(label);
    expect(host.textContent).not.toContain(title);
  } finally {
    await unmount();
  }
});

it("shows the most workers at once where the streak was", async () => {
  const { host, unmount } = await renderCard(weeks(() => 2));
  try {
    expect(host.textContent).not.toContain("Day Streak");
    expect(host.textContent).toContain("12Most workers at once");
  } finally {
    await unmount();
  }
});

it.each([
  [[], []],
  [[{ engine: "codex", count: 0 }], []],
  [[{ engine: "claudeAgent", count: 5 }], [["Claude", "100%"]]],
  [[{ engine: "codex", count: 1 }, { engine: "claudeAgent", count: 1 }], [["Claude", "50%"], ["OpenAI", "50%"]]],
  [[{ engine: "antigravityAgent", count: 2 }, { engine: "geminiAgent", count: 1 }, { engine: "museAgent", count: 1 }, { engine: "claudeAgent", count: 996 }], [["Claude", "100%"], ["Gemini", "<1%"], ["Muse", "<1%"]]],
  [[{ engine: "claudeAgent", count: 72 }, { engine: "codex", count: 14 }, { engine: "grokAgent", count: 8 }, { engine: "geminiAgent", count: 4 }, { engine: "museAgent", count: 2 }], [["Claude", "72%"], ["OpenAI", "14%"], ["Grok", "8%"], ["Gemini", "4%"], ["Muse", "2%"]]],
] as const)("shares %j by engine, biggest first", (engines, shares) => {
  expect(engineShares([...engines]).map(({ name, share }) => [name, share])).toEqual(shares);
});

it("lists every engine under the squares, and no row with no replies", async () => {
  const engines = [{ engine: "codex", count: 1400 }, { engine: "claudeAgent", count: 7200 }, { engine: "grokAgent", count: 800 }, { engine: "geminiAgent", count: 400 }, { engine: "museAgent", count: 200 }];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...activityOf(weeks(() => 2)), engines }))));
  const { host, unmount } = mount();
  await act(async () => {});
  try {
    const row = host.querySelector<HTMLElement>("[data-activity-engines]")!;
    expect([...row.children].map((item) => [item.textContent, item.querySelectorAll("svg").length])).toEqual([["Claude72%", 1], ["OpenAI14%", 1], ["Grok8%", 1], ["Gemini4%", 1], ["Muse2%", 1]]);
  } finally {
    await unmount();
  }
  resetActivity();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...activityOf(weeks(() => 2)), engines: [] }))));
  const empty = mount();
  await act(async () => {});
  try {
    expect(empty.host.querySelector("[data-activity-engines]")).toBeNull();
  } finally {
    await empty.unmount();
  }
});
