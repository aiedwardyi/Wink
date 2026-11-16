// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { showSelectHandles, type SelectHandles } from "./select-handles";

const COPY = { width: 64, height: 36 };

let handles: SelectHandles | null = null;

afterEach(() => {
  handles?.remove();
  handles = null;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const box = (el: Element, rect: { x?: number; y?: number; width?: number; height?: number }) =>
  Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => DOMRect.fromRect({ width: 392, ...rect }) });

function show(opts: { rowTop: number; contentBottom: number; lines: Array<{ x: number; y: number; width: number }> }) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 392 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(COPY.width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(COPY.height);
  const rects = opts.lines.map((line) => DOMRect.fromRect({ ...line, height: 20 }));
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(Object.assign(rects, { item: (i: number) => rects[i] ?? null }));

  const transcript = document.createElement("div");
  transcript.setAttribute("data-orbit-transcript", "");
  const row = document.createElement("div");
  const content = document.createElement("p");
  content.textContent = "a long message with words picked out of its middle";
  row.append(content);
  transcript.append(row);
  document.body.append(transcript);
  box(transcript, { y: 56, height: 788 });
  box(row, { y: opts.rowTop, height: opts.contentBottom - opts.rowTop });
  box(content, { y: opts.rowTop + 20, height: opts.contentBottom - opts.rowTop - 20 });

  const range = document.createRange();
  range.setStart(content.firstChild!, 2);
  range.setEnd(content.firstChild!, 6);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  handles = showSelectHandles(row, content, "Copy", () => {});
  const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(document.querySelector<HTMLElement>("[data-select-copy]")!.style.transform)!;
  return { left: Number(x), top: Number(y), rects };
}

describe("select handles Copy", () => {
  it("sits just above a mid-message selection in a long message", () => {
    for (const [rowTop, contentBottom] of [[120, 1400], [-900, 700]]) {
      const { left, top, rects } = show({ rowTop, contentBottom, lines: [{ x: 100, y: 500, width: 80 }] });
      expect(top).toBe(500 - COPY.height - 8);
      expect(rects[0]!.top - (top + COPY.height)).toBeLessThanOrEqual(60);
      expect(left + COPY.width / 2).toBe(140);
      handles?.remove();
    }
  });

  it("centers on every selected line", () => {
    const { left, top } = show({ rowTop: 120, contentBottom: 1400, lines: [{ x: 200, y: 400, width: 180 }, { x: 12, y: 420, width: 100 }] });
    expect(top).toBe(400 - COPY.height - 8);
    expect(left + COPY.width / 2).toBe((12 + 380) / 2);
  });

  it("goes below the last line and its handle when the header covers the room above", () => {
    const { top, rects } = show({ rowTop: 40, contentBottom: 800, lines: [{ x: 100, y: 70, width: 80 }, { x: 12, y: 90, width: 60 }] });
    expect(top).toBe(110 + 44 + 8);
    expect(top - rects[1]!.bottom).toBeLessThanOrEqual(60);
  });

  it("stays on screen while the selection scrolls off it", () => {
    expect(show({ rowTop: -900, contentBottom: 700, lines: [{ x: 100, y: -200, width: 80 }] }).top).toBe(56 + 8);
    handles?.remove();
    expect(show({ rowTop: 120, contentBottom: 1400, lines: [{ x: 100, y: 1200, width: 80 }] }).top).toBe(844 - 8 - COPY.height);
  });

  it("takes the top of the transcript when a selection fills the screen", () => {
    expect(show({ rowTop: 40, contentBottom: 1400, lines: [{ x: 100, y: 70, width: 80 }, { x: 12, y: 820, width: 60 }] }).top).toBe(56 + 8);
  });

  it("stays inside a zoomed, panned visual viewport", () => {
    const view = Object.assign(new EventTarget(), { offsetLeft: 196, offsetTop: 0, width: 196, height: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: view });
    try {
      expect(show({ rowTop: 120, contentBottom: 1400, lines: [{ x: 60, y: 500, width: 80 }] }).left).toBe(196 + 8);
      handles?.remove();
      expect(show({ rowTop: 120, contentBottom: 1400, lines: [{ x: 372, y: 500, width: 20 }] }).left).toBe(392 - COPY.width - 8);
    } finally {
      delete (window as { visualViewport?: unknown }).visualViewport;
    }
  });

  it("clamps to the screen edges", () => {
    expect(show({ rowTop: 120, contentBottom: 1400, lines: [{ x: 0, y: 500, width: 20 }] }).left).toBe(8);
    handles?.remove();
    expect(show({ rowTop: 120, contentBottom: 1400, lines: [{ x: 372, y: 500, width: 20 }] }).left).toBe(392 - COPY.width - 8);
  });
});
