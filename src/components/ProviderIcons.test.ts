import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClaudeMark, claudeFit, claudeViewBox, GeminiMark, MuseMark, ProviderMark, QwenMark } from "./ProviderIcons";


describe("ProviderMark", () => {
  it.each(["grok", "grokAgent"])("renders the Grok mark as an SVG for %s", (driverKind) => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 18 }));

    expect(markup).toContain("<svg");
    expect(markup).toContain("viewBox=\"0 0 24 24\"");
    expect(markup).toContain("M9.27 15.29");
    expect(markup).not.toContain(">G</span>");
  });

  it("renders the Muse mark with a thin margin so it sits level with the other marks", () => {
    const markup = renderToStaticMarkup(createElement(MuseMark, { size: 14 }));
    expect(markup).toContain("<svg");
    expect(markup).toContain("viewBox=\"2.5 2.5 19 19\"");
    expect(markup).toContain("M4 20V4h3.2");
  });

  it("serves the padded Muse mark for museAgent", () => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind: "museAgent", size: 14 }));
    expect(markup).toContain("viewBox=\"2.5 2.5 19 19\"");
  });

  it.each([
    "grok",
    "grokAgent",
    "claudeAgent",
    "codex",
    "geminiAgent",
    "antigravityAgent",
    "museAgent",
    "kimiAgent",
    "qwenAgent",
    "boxAgent",
  ])("pins the %s mark to its size so row overflow cannot squish it", (driverKind) => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 14 }));
    expect(markup).toContain("<svg");
    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
    expect(markup).toContain("shrink-0");
    // Decorative beside a visible label: hidden from assistive technology.
    expect(markup).toContain("aria-hidden");
  });
});

describe("ClaudeMark", () => {
  const rects = (markup: string) =>
    [...markup.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((m) => m.slice(1).map(Number));

  it("draws the claude bot as crisp pixel rects in the claude orange, not the starburst", () => {
    const markup = renderToStaticMarkup(createElement(ProviderMark, { driverKind: "claudeAgent", size: 16 }));
    expect(markup).toContain('shape-rendering="crispEdges"');
    expect(markup).toContain("fill-[#d97757]");
    expect(markup).not.toContain("<path");
    expect(rects(markup)).toEqual([
      [3, 0, 13, 2],
      [3, 2, 2, 2],
      [6, 2, 7, 2],
      [14, 2, 2, 2],
      [1, 4, 17, 2],
      [3, 6, 13, 2],
      [3, 8, 1, 2],
      [5, 8, 1, 2],
      [13, 8, 1, 2],
      [15, 8, 1, 2],
    ]);
  });

  it("fills the eye gaps only where --claude-eye is set", () => {
    const markup = renderToStaticMarkup(createElement(ClaudeMark, { size: 16 }));
    const eyes = [...markup.matchAll(/<rect fill="currentColor" color="var\(--claude-eye, transparent\)" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)];
    expect(eyes.map((m) => m.slice(1).map(Number))).toEqual([
      [5, 2, 1, 2],
      [13, 2, 1, 2],
    ]);
  });

  const viewBox = (size: number) =>
    renderToStaticMarkup(createElement(ClaudeMark, { size })).match(/viewBox="(\S+) (\S+) (\S+) (\S+)"/)!.slice(1).map(Number);

  it.each([14, 16, 17])("keeps one css px per bot column at %i px so the eyes and legs survive at ratio 1", (size) => {
    const markup = renderToStaticMarkup(createElement(ClaudeMark, { size }));
    expect(markup).toContain("overflow-visible");
    expect(viewBox(size)[2]).toBe(size);
  });

  it.each([
    [14, 1, 1],
    [14, 1.25, 1],
    [14, 1.5, 1],
    [14, 1.75, 2],
    [14, 2, 2],
    [18, 1, 1],
    [20, 1.25, 1],
    [72, 1, 4],
    [72, 1.25, 5],
    [72, 1.5, 6],
    [72, 2, 8],
  ])("gives every bot column the same whole device px at %i px and ratio %d", (size, ratio, device) => {
    const [x, y, w, h] = claudeViewBox(size, ratio);
    expect(h).toBe(w);
    expect((size * ratio) / w).toBeCloseTo(device, 9);
    expect(x * device).toBeCloseTo(Math.round(x * device), 9);
    expect(y * device).toBeCloseTo(Math.round(y * device), 9);
    expect(Math.abs(x + w / 2 - 9.5) * device).toBeLessThanOrEqual(0.5);
    expect(Math.abs(y + h / 2 - 5) * device).toBeLessThanOrEqual(0.5);
  });

  it.each([14, 16])("keeps the %i px bot at its ratio 1 size on a ratio 2 screen", (size) => {
    expect(claudeViewBox(size, 2)[2]).toBe(claudeViewBox(size, 1)[2]);
  });
});

describe("claudeFit", () => {
  // body runs, then the eye gaps, as [x, y, w, h] on the grid
  const grid = [[3, 0, 13, 2], [3, 2, 2, 2], [6, 2, 7, 2], [14, 2, 2, 2], [1, 4, 17, 2], [3, 6, 13, 2], [3, 8, 1, 2], [5, 8, 1, 2], [13, 8, 1, 2], [15, 8, 1, 2], [5, 2, 1, 2], [13, 2, 1, 2]] as const;
  const fitted = (size: number, ratio: number) => {
    const place = claudeFit(size, ratio);
    const rects = grid.map(([x, y, w, h]) => place(x, y, w, h));
    return { rects, left: Math.min(...rects.map((r) => r.x)), right: Math.max(...rects.map((r) => r.x + r.width)) };
  };

  it.each([1.25, 1.5, 1.75])("matches the width of the other logos at ratio %d", (ratio) => {
    for (const size of [14, 16, 18, 20, 24]) {
      const { left, right } = fitted(size, ratio);
      expect((right - left) / (size * ratio)).toBeGreaterThan(0.9);
      expect((right - left) / (size * ratio)).toBeLessThan(1.1);
    }
  });

  it.each([1.25, 1.5, 1.75])("mirrors every rect about the center column at ratio %d", (ratio) => {
    for (const size of [14, 16, 18, 20, 24]) {
      const { rects, left, right } = fitted(size, ratio);
      for (const r of rects) expect(rects).toContainEqual({ ...r, x: left + right - r.x - r.width });
    }
  });

  it.each([1.25, 1.5, 1.75])("keeps every column at least one device px at ratio %d", (ratio) => {
    for (const size of [14, 16, 18, 20, 24]) {
      for (const r of fitted(size, ratio).rects) expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe.each([
  ["GeminiMark", GeminiMark],
  ["QwenMark", QwenMark],
])("%s", (_name, Mark) => {
  it("gives each rendered copy its own gradient, so a hidden first copy cannot blank the second", () => {
    const markup = renderToStaticMarkup(createElement(Fragment, null, createElement(Mark, {}), createElement(Mark, {})));
    const svgs = markup.split("</svg>").slice(0, 2);
    const ids = svgs.map((svg) => svg.match(/<linearGradient id="([^"]+)"/)![1]);
    expect(ids[0]).not.toBe(ids[1]);
    svgs.forEach((svg, i) => expect(svg).toContain(`fill="url(#${ids[i]})"`));
  });
});
