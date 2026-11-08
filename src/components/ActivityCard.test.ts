// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { ActivityCard, resetActivity } from "./ActivityCard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetActivity();
  localStorage.clear();
  persistPreference("en");
});

const activityOf = (counts: number[], start = "2026-05-10") => {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return { start, counts, streak: 1, busiest: { day: start, count: Math.max(...counts) }, total };
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

it.each([
  ["en", "Since Jun 2025", ["Day Streak", "Best Day", "Total Replies"]],
  ["ko", "2025년 6월부터", ["연속 일수", "최고의 날", "총 답변"]],
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
