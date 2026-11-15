import { useEffect, useRef, type RefObject } from "react";
import { useI18n } from "@/lib/i18n";

const copy = { en: "Resize the code view", ko: "코드 보기 크기 조절" };
const KEY = "omb-map-split";
const REST = 120;
const STEP = 24;

export function MapSplit({ target }: { target: RefObject<HTMLElement | null> }) {
  const { locale } = useI18n();
  const drag = useRef<{ y: number; from: number; min: number; max: number; to: number; frame: number } | null>(null);
  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY));
    if (saved > 0) target.current?.style.setProperty("--map-split", `${saved}%`);
  }, [target]);

  // Read once per drag: every later move only writes the one variable.
  const bounds = (handle: HTMLElement) => {
    const top = target.current;
    if (!top) return null;
    const from = top.getBoundingClientRect().height;
    const min = Number.parseFloat(getComputedStyle(top).minHeight) || 0;
    const room = handle.parentElement?.querySelector<HTMLElement>(":scope > .map-code")?.clientHeight ?? 0;
    return { from, min, max: Math.max(min, Math.min(top.scrollHeight + top.offsetHeight - top.clientHeight, from + room - REST)) };
  };
  const keep = (height: number) => {
    const top = target.current;
    const pane = top?.parentElement?.clientHeight;
    if (!top || !pane) return;
    const share = (height / pane * 100).toFixed(1);
    top.style.setProperty("--map-split", `${share}%`);
    localStorage.setItem(KEY, share);
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
    if (now.to !== now.from) keep(now.to);
  };

  return <div role="separator" aria-orientation="horizontal" aria-label={copy[locale]} tabIndex={0}
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
      now.frame ||= requestAnimationFrame(() => { now.frame = 0; target.current?.style.setProperty("--map-split", `${now.to}px`); });
    }}
    onPointerUp={event => end(event.currentTarget)}
    onPointerCancel={event => end(event.currentTarget)}
    onLostPointerCapture={event => end(event.currentTarget)}
    onKeyDown={event => {
      const by = event.key === "ArrowDown" ? STEP : event.key === "ArrowUp" ? -STEP : 0;
      const box = by && bounds(event.currentTarget);
      if (!box) return;
      event.preventDefault();
      keep(Math.max(box.min, Math.min(box.max, box.from + by)));
    }}
  />;
}
