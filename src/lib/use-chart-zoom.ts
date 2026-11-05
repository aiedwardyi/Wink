import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FULL_ZOOM, doubleTapZoom, inZoom, panZoom, zoomAt, type ChartSpot, type ChartZoom } from "./chart-zoom";
import { PHONE_QUERY, SWIPE_MOTION_MS, SWIPE_SLOP, SWIPE_SPRING, hapticTick, lockAxis, reducedMotion, swipeBlocked, swipeStep, type SwipeAxis } from "./phone-swipe";

type Plot = { left: number; right: number; top: number; bottom: number };
type Drag = { start: ChartSpot; last: ChartSpot; time: number; velocity: number; axis: SwipeAxis; pan: boolean; blocked: boolean; afterPinch?: boolean };
type Pinch = { zoom: ChartZoom; distance: number; center: ChartSpot };

export function useChartZoom(
  ref: RefObject<SVGSVGElement | null>,
  enabled: boolean,
  index: string,
  plot: Plot,
  swipe: (step: -1 | 1) => boolean,
  hide: () => void,
) {
  const [zoom, setZoom] = useState(FULL_ZOOM);
  const [motion, setMotion] = useState<string>();
  const current = useRef(FULL_ZOOM);
  const latest = useRef({ plot, swipe, hide, zoom: enabled ? zoom : undefined });
  const suppress = useRef(false);
  useLayoutEffect(() => { latest.current = { plot, swipe, hide, zoom: enabled ? zoom : undefined }; });

  useLayoutEffect(() => {
    current.current = FULL_ZOOM;
    setZoom(FULL_ZOOM);
    setMotion(undefined);
    suppress.current = false;
  }, [enabled, index]);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    // SAFETY: hapticTick only reads matchMedia/navigator; full-screen phones can exceed the width breakpoint.
    const phoneWindow = {
      matchMedia: (query: string) => query === PHONE_QUERY ? { matches: true } : window.matchMedia(query),
      navigator: window.navigator,
    } as typeof window;
    let drag: Drag | null = null;
    let pinch: Pinch | null = null;
    let tap: { point: ChartSpot; time: number } | null = null;
    let frame = 0;
    let origin = current.current;
    let moving = false;
    let dots: SVGGElement[] = [];
    let labels: SVGTextElement[] = [];
    let lines: SVGGElement[] = [];
    const point = (touch: Touch): ChartSpot => ({ x: touch.clientX, y: touch.clientY });
    const center = (a: ChartSpot, b: ChartSpot): ChartSpot => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const distance = (a: ChartSpot, b: ChartSpot) => Math.hypot(a.x - b.x, a.y - b.y);
    const anchor = (spot: ChartSpot): ChartSpot => {
      const box = el.getBoundingClientRect();
      const { left, right, top, bottom } = latest.current.plot;
      return { x: (spot.x - box.left - left) / (right - left), y: (spot.y - box.top - top) / (bottom - top) };
    };
    const delta = (a: ChartSpot, b: ChartSpot): ChartSpot => {
      const { left, right, top, bottom } = latest.current.plot;
      return { x: (a.x - b.x) / (right - left), y: (a.y - b.y) / (bottom - top) };
    };
    // Keep layout off gesture frames; settle re-places ticks and labels.
    const paint = () => {
      frame = 0;
      const next = current.current;
      const { left, right, top, bottom } = latest.current.plot;
      const scale = next.scale / origin.scale;
      const dx = left * (1 - scale) + (origin.x - next.x) * next.scale * (right - left);
      const dy = top * (1 - scale) + (origin.y - next.y) * next.scale * (bottom - top);
      el.setAttribute("data-mi-zoom", String(next.scale));
      for (const dot of dots) {
        const x = Number(dot.dataset.miX), y = Number(dot.dataset.miY);
        dot.style.transform = `translate(${left + (x - next.x) * next.scale * (right - left)}px, ${top + (y - next.y) * next.scale * (bottom - top)}px)`;
        dot.style.opacity = inZoom(next, { x, y }) ? "1" : "0";
      }
      for (const label of labels) label.style.transform = `translate(${Number(label.dataset.miX) * scale + dx}px, ${Number(label.dataset.miY) * scale + dy}px)`;
      for (const line of lines) line.setAttribute("transform", `matrix(${scale} 0 0 ${scale} ${dx} ${dy})`);
    };
    const settle = () => {
      if (!moving) return;
      if (frame) {
        cancelAnimationFrame(frame);
        paint();
      }
      moving = false;
      for (const line of lines) line.removeAttribute("transform");
      el.removeAttribute("data-mi-gesture");
      setMotion("0s");
      setZoom({ ...current.current });
    };
    const update = (next: ChartZoom, animate = false) => {
      if (!animate && !moving) {
        origin = current.current;
        moving = true;
        dots = [...el.querySelectorAll<SVGGElement>("[data-mi-point]")];
        labels = [...el.querySelectorAll<SVGTextElement>("[data-mi-label]")];
        lines = [...el.querySelectorAll<SVGGElement>("[data-mi-live-lines]")];
        el.setAttribute("data-mi-gesture", "");
        latest.current.hide();
      }
      current.current = next;
      if (animate) {
        setMotion(reducedMotion() ? "0s" : `${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`);
        setZoom(next);
        latest.current.hide();
      } else if (!frame) frame = requestAnimationFrame(paint);
    };
    const onStart = (e: TouchEvent) => {
      const first = e.touches[0];
      if (!first) return;
      if (e.touches.length === 2) {
        const a = point(first), b = point(e.touches[1]!);
        pinch = { zoom: current.current, distance: distance(a, b), center: center(a, b) };
        drag = null;
        tap = null;
        suppress.current = true;
        latest.current.hide();
      } else if (e.touches.length === 1) {
        const spot = point(first);
        drag = { start: spot, last: spot, time: e.timeStamp, velocity: 0, axis: null, pan: current.current.scale > 1, blocked: swipeBlocked(e.target, spot.x) };
        suppress.current = false;
      } else {
        settle();
        drag = null;
        pinch = null;
        tap = null;
        suppress.current = true;
      }
    };
    const onMove = (e: TouchEvent) => {
      const first = e.touches[0];
      if (!first) return;
      if (pinch && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const a = point(first), b = point(e.touches[1]!);
        const mid = center(a, b);
        update(panZoom(zoomAt(pinch.zoom, pinch.zoom.scale * distance(a, b) / Math.max(1, pinch.distance), anchor(pinch.center)), delta(mid, pinch.center)));
        return;
      }
      if (!drag || e.touches.length !== 1) return;
      const spot = point(first);
      const dx = spot.x - drag.start.x;
      drag.axis ??= lockAxis(dx, spot.y - drag.start.y);
      if (drag.pan ? moving || distance(drag.start, spot) >= SWIPE_SLOP : drag.axis === "x") {
        if (e.cancelable) e.preventDefault();
        suppress.current = true;
        tap = null;
        if (drag.pan) update(panZoom(current.current, delta(spot, drag.last)));
        else latest.current.hide();
      }
      const elapsed = e.timeStamp - drag.time;
      if (elapsed > 0) drag.velocity = (spot.x - drag.last.x) / elapsed;
      drag.last = spot;
      drag.time = e.timeStamp;
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        pinch = null;
        settle();
        const remaining = e.touches[0];
        const spot = remaining && point(remaining);
        drag = spot ? { start: spot, last: spot, time: e.timeStamp, velocity: 0, axis: null, pan: true, blocked: true, afterPinch: true } : null;
        return;
      }
      if (!drag || e.touches.length) return;
      const ended = drag;
      drag = null;
      settle();
      if (!ended.afterPinch && ended.axis === null && distance(ended.start, ended.last) < SWIPE_SLOP) {
        if (tap && e.timeStamp - tap.time < 300 && distance(tap.point, ended.last) < 24) {
          if (e.cancelable) e.preventDefault();
          suppress.current = true;
          update(doubleTapZoom(current.current, anchor(ended.last)), true);
          tap = null;
        } else tap = { point: ended.last, time: e.timeStamp };
        return;
      }
      if (ended.pan || ended.blocked || ended.axis !== "x") return;
      const velocity = e.timeStamp - ended.time > 100 ? 0 : ended.velocity;
      const step = swipeStep(ended.last.x - ended.start.x, velocity, el.clientWidth || window.innerWidth);
      if (step && latest.current.swipe(step)) hapticTick(phoneWindow);
    };
    const onCancel = () => { settle(); drag = null; pinch = null; tap = null; suppress.current = true; };
    const onClick = (e: MouseEvent) => {
      if (!suppress.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", onCancel);
    el.addEventListener("click", onClick, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      const { plot: { left, right, top, bottom }, zoom = FULL_ZOOM } = latest.current;
      if (latest.current.zoom) el.setAttribute("data-mi-zoom", String(zoom.scale));
      else el.removeAttribute("data-mi-zoom");
      for (const dot of dots) {
        const x = Number(dot.dataset.miX), y = Number(dot.dataset.miY);
        dot.style.transform = `translate(${left + (x - zoom.x) * zoom.scale * (right - left)}px, ${top + (y - zoom.y) * zoom.scale * (bottom - top)}px)`;
        dot.style.opacity = inZoom(zoom, { x, y }) ? "1" : "0";
      }
      for (const label of labels) label.style.transform = `translate(${Number(label.dataset.miX)}px, ${Number(label.dataset.miY)}px)`;
      for (const line of lines) line.removeAttribute("transform");
      el.removeAttribute("data-mi-gesture");
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      el.removeEventListener("click", onClick, true);
    };
  }, [ref, enabled, index]);

  const css = `
    ${motion ? `
      [data-mi-zoom] [data-mi-move] { transition: transform ${motion}, opacity ${motion}; }
      [data-mi-zoom] [data-mi-line] { transition: d ${motion}, opacity ${motion}; }
      [data-mi-zoom] [data-mi-enter], [data-mi-zoom] [data-mi-rise] { animation: none; }
    ` : ""}
    [data-mi-gesture] [data-mi-move], [data-mi-gesture] [data-mi-line] { transition: none; }
    [data-mi-live-lines] path { vector-effect: non-scaling-stroke; }
  `;
  return { zoom: enabled ? zoom : FULL_ZOOM, css, suppress };
}
