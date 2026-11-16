// Lays a month-grouped timeline out in fixed rows, so the full height is known at once
// and only what is near the screen mounts.
import { useLayoutEffect, useMemo, useState, type RefObject } from "react";

import type { MediaMonth } from "./media-index";

/** The scroller's padding, the gap between cells, a month head, a file row. */
export const PAD = 6;
export const GAP = 6;
export const HEAD = 34;
export const FILE_ROW = 52;

export interface GridMonth extends MediaMonth {
  top: number;
  height: number;
}

export interface GridLayout {
  columns: number;
  cell: number;
  height: number;
  months: GridMonth[];
}

/** Three columns on a narrow pane, then as many ~140px cells as fit. */
export function gridLayout(months: readonly MediaMonth[], width: number): GridLayout {
  const columns = width < 420 ? 3 : Math.max(4, Math.floor(width / 140));
  const cell = (width - GAP * (columns - 1)) / columns;
  let top = 0;
  const laid = months.map((month) => {
    const height = HEAD + Math.ceil(month.images.length / columns) * (cell + GAP) + month.files.length * FILE_ROW;
    const placed = { ...month, top, height };
    top += height;
    return placed;
  });
  return { columns, cell, height: top, months: laid };
}

/** The month whose rows are at `y`, for the drag bubble. */
export function monthAt(layout: GridLayout, y: number): GridMonth | undefined {
  const { months } = layout;
  let low = 0;
  let high = months.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (months[mid]!.top <= y) low = mid;
    else high = mid - 1;
  }
  return months[low];
}

/** The layout plus the band to mount: the screen and one screen either side, moved in half-screen steps. */
export function useMediaGrid(scroller: RefObject<HTMLElement | null>, months: readonly MediaMonth[]) {
  const [view, setView] = useState({ width: 0, height: 0, step: 0 });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      // A closing pane shrinks with its exit; laying out again would reflow the grid under it.
      if (el.closest("[data-closing]")) return;
      const width = el.clientWidth - PAD * 2;
      const height = el.clientHeight;
      const step = height > 0 ? Math.floor(el.scrollTop / (height / 2)) : 0;
      setView((was) => was.width === width && was.height === height && was.step === step ? was : { width, height, step });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [scroller]);

  const layout = useMemo(() => gridLayout(view.width > 0 ? months : [], view.width), [months, view.width]);
  const top = view.step * view.height / 2 - PAD;
  return { layout, viewport: view.height, from: top - view.height, to: top + view.height * 2 };
}
