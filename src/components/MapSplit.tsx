import { useEffect, useRef, type RefObject } from "react";
import { useI18n } from "@/lib/i18n";

const copy = { en: { code: "Resize the code view", rows: "Resize the file tree" }, ko: { code: "코드 보기 크기 조절", rows: "파일 트리 크기 조절" } };
const KEY = "omb-map-split";
const ROWS = "omb-map-rows";
const REST = 120;
const STEP = 24;
type Box = { from: number; min: number; max: number; below?: HTMLElement; tall?: number };

// rows: the line above the Git rows, which give or take what the tree gains or loses.
export function MapSplit({ target, rows = false }: { target: RefObject<HTMLElement | null>; rows?: boolean }) {
  const { locale } = useI18n();
  const drag = useRef<Box & { y: number; to: number; frame: number } | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY));
    if (saved > 0) target.current?.style.setProperty("--map-split", `${saved}%`);
    const share = rows ? Number(localStorage.getItem(ROWS)) : 0;
    if (share > 0) target.current?.parentElement?.style.setProperty("--map-rows", `${share}%`);
  }, [target, rows]);

  // Read once per drag: every later move only writes the size variables.
  const bounds = (handle: HTMLElement): Box | null => {
    const top = target.current;
    if (!top) return null;
    const from = top.getBoundingClientRect().height;
    const min = Number.parseFloat(getComputedStyle(top).minHeight) || 0;
    const full = top.scrollHeight + top.offsetHeight - top.clientHeight;
    if (!rows) {
      const room = handle.parentElement?.querySelector<HTMLElement>(":scope > .map-code")?.clientHeight ?? 0;
      return { from, min, max: Math.max(min, Math.min(full, from + room - REST)) };
    }
    const below = handle.nextElementSibling;
    const list = below?.querySelector<HTMLElement>(".map-flow-list");
    if (!(below instanceof HTMLElement) || !list) return null;
    // The rows keep one row, and take back only what they hide: never empty space.
    const row = list.firstElementChild?.getBoundingClientRect().height ?? 0;
    return { from, below, tall: below.getBoundingClientRect().height, min: Math.max(min, from - list.scrollHeight + list.clientHeight), max: Math.max(min, Math.min(full, from + list.clientHeight - row)) };
  };
  const keep = (height: number, box: Box) => {
    const top = target.current;
    const pane = top?.parentElement;
    if (!top || !pane?.clientHeight) return;
    const share = (height / pane.clientHeight * 100).toFixed(1);
    top.style.setProperty("--map-split", `${share}%`);
    localStorage.setItem(KEY, share);
    if (!box.below || box.tall === undefined) return;
    const rest = ((box.tall + box.from - height) / pane.clientHeight * 100).toFixed(1);
    pane.style.setProperty("--map-rows", `${rest}%`);
    box.below.style.removeProperty("--map-rows");
    localStorage.setItem(ROWS, rest);
  };
  // The rows and the code move as layers while dragging: without it every frame repaints them.
  const lift = (handle: HTMLElement, on: boolean) => {
    for (const part of handle.parentElement?.children ?? []) if (part !== target.current && part instanceof HTMLElement) part.style.willChange = on ? "transform" : "";
  };
  const end = (handle: HTMLElement) => {
    const now = drag.current;
    if (!now) return;
    drag.current = null;
    cancelAnimationFrame(now.frame);
    handle.removeAttribute("data-drag");
    lift(handle, false);
    if (now.to !== now.from) keep(now.to, now);
  };

  return <div role="separator" aria-orientation="horizontal" aria-label={copy[locale][rows ? "rows" : "code"]} tabIndex={0} data-rows={rows || undefined}
    className="map-split relative z-[2] -my-[3px] h-1.5 shrink-0 cursor-row-resize touch-none hover:bg-accent/40 focus-visible:bg-accent/60 data-[drag]:bg-accent/60"
    onPointerDown={event => {
      const box = event.button === 0 && bounds(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.currentTarget.setAttribute("data-drag", "");
      lift(event.currentTarget, true);
      drag.current = { ...box, y: event.clientY, to: box.from, frame: 0 };
    }}
    onPointerMove={event => {
      const now = drag.current;
      if (!now) return;
      now.to = Math.max(now.min, Math.min(now.max, now.from + event.clientY - now.y));
      now.frame ||= requestAnimationFrame(() => {
        now.frame = 0;
        target.current?.style.setProperty("--map-split", `${now.to}px`);
        if (now.tall !== undefined) now.below?.style.setProperty("--map-rows", `${now.tall + now.from - now.to}px`);
      });
    }}
    onPointerUp={event => end(event.currentTarget)}
    onPointerCancel={event => end(event.currentTarget)}
    onLostPointerCapture={event => end(event.currentTarget)}
    onKeyDown={event => {
      const by = event.key === "ArrowDown" ? STEP : event.key === "ArrowUp" ? -STEP : 0;
      const box = by && bounds(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      keep(Math.max(box.min, Math.min(box.max, box.from + by)), box);
    }}
  />;
}
