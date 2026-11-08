// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { ActivityCard } from "./ActivityCard";

afterEach(() => { vi.unstubAllGlobals(); });

async function renderCard(counts: number[], start = "2026-05-10") {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const body = { start, counts, streak: 1, busiest: { day: start, count: Math.max(...counts) }, total };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(ActivityCard))));
  return { host, unmount: () => act(async () => root.unmount()) };
}

const weeks = (fill: (day: number) => number) => Array.from({ length: 182 }, (_, day) => fill(day));

it("spreads small days across shades when one day spikes", async () => {
  const { host, unmount } = await renderCard(weeks((day) => (day === 100 ? 212 : day % 3 === 0 ? 0 : (day % 20) + 1)));
  try {
    const squares = [...host.querySelectorAll<HTMLElement>("[aria-hidden] > div:last-child > span")];
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
