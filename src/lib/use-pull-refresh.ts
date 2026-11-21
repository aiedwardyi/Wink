import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { hapticTick, lockAxis, reducedMotion, SWIPE_MOTION_MS, SWIPE_SPRING } from "./phone-swipe";

export const PULL_RESIST = 0.5;
export const PULL_THRESHOLD = 64;
export const PULL_MAX = 112;
export const PULL_HOLD = 56;
// a fast local answer would otherwise flash the spinner
export const PULL_MIN_MS = 450;
const BADGE = 36;
const BLOCKED = 'textarea, input, select, [contenteditable="true"], [data-no-swipe]';

type Drag = { x: number; y: number; pulling: boolean; offset: number; buzzed: boolean; reduced: boolean };

/** Pull down at the top of `ref` to refresh: the first child follows the finger and `badge` (its first child spins once armed) rides above it. */
export function usePullRefresh(ref: RefObject<HTMLElement | null>, badgeRef: RefObject<HTMLElement | null>, enabled: boolean, refresh: () => Promise<void> | void): void {
  const latest = useRef(refresh);
  useLayoutEffect(() => { latest.current = refresh; });

  useEffect(() => {
    const scroller = ref.current;
    const content = scroller?.firstElementChild;
    const badge = badgeRef.current;
    const wheel = badge?.firstElementChild;
    if (!scroller || !(content instanceof HTMLElement) || !badge || !(wheel instanceof HTMLElement) || !enabled) return;
    let drag: Drag | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let dirty = false;
    let alive = true;
    // a footgun: without this the browser's own pull-to-refresh or glow takes the gesture
    scroller.style.overscrollBehaviorY = "contain";
    const clear = () => {
      for (const key of ["transform", "transition"]) content.style.removeProperty(key);
      for (const key of ["transform", "opacity", "transition"]) badge.style.removeProperty(key);
      wheel.style.removeProperty("transform");
      delete badge.dataset.spin;
      dirty = false;
    };
    const paint = (offset: number, spin = false) => {
      dirty = true;
      content.style.transform = `translate3d(0, ${offset}px, 0)`;
      badge.style.opacity = String(Math.min(1, offset / (PULL_THRESHOLD * 0.6)));
      badge.style.transform = `translate3d(0, ${offset / 2 - BADGE / 2}px, 0)`;
      wheel.style.transform = spin ? "" : `rotate(${(offset / PULL_THRESHOLD) * 270}deg)`;
    };
    const ease = () => {
      const motion = `${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
      for (const node of [content, badge]) node.style.transition = `transform ${motion}, opacity ${motion}`;
    };
    const springBack = (reduced: boolean) => {
      delete badge.dataset.spin;
      if (reduced) { busy = false; clear(); return; }
      ease();
      paint(0);
      timer = setTimeout(() => { busy = false; clear(); }, SWIPE_MOTION_MS);
    };
    const start = (event: TouchEvent) => {
      if (drag?.pulling && event.touches.length !== 1) { finish(false, event); return; }
      drag = null;
      const touch = event.touches[0];
      if (busy || event.touches.length !== 1 || !touch || !(event.target instanceof Element) || scroller.scrollTop > 0) return;
      if (event.target.closest(BLOCKED)) return;
      drag = { x: touch.clientX, y: touch.clientY, pulling: false, offset: 0, buzzed: false, reduced: reducedMotion() };
    };
    const move = (event: TouchEvent) => {
      if (!drag) return;
      if (event.touches.length !== 1) { finish(false, event); return; }
      const touch = event.touches[0]!;
      const dy = touch.clientY - drag.y;
      if (!drag.pulling) {
        if (scroller.scrollTop > 0) { drag = null; return; }
        const axis = lockAxis(touch.clientX - drag.x, dy);
        if (!axis) return;
        if (axis === "x" || dy < 0) { drag = null; return; }
        drag.pulling = true;
        clearTimeout(timer);
        clear();
      }
      if (event.cancelable) event.preventDefault();
      drag.offset = Math.min(PULL_MAX, Math.max(0, dy) * PULL_RESIST);
      if (drag.offset >= PULL_THRESHOLD && !drag.buzzed) {
        drag.buzzed = true;
        hapticTick();
      }
      if (!drag.reduced) paint(drag.offset);
    };
    const finish = (commit: boolean, event: TouchEvent) => {
      const done = drag;
      drag = null;
      if (!done?.pulling) return;
      // Suppress the click a touch drag can otherwise leave behind.
      if (event.cancelable && event.type !== "touchstart") event.preventDefault();
      if (!commit || done.offset < PULL_THRESHOLD) { springBack(done.reduced); return; }
      busy = true;
      badge.dataset.spin = "";
      if (!done.reduced) ease();
      paint(PULL_HOLD, true);
      const minimum = new Promise((resolve) => { timer = setTimeout(resolve, PULL_MIN_MS); });
      void Promise.all([Promise.resolve().then(() => latest.current()).catch(() => {}), minimum]).then(() => { if (alive) springBack(done.reduced); });
    };
    const end = (event: TouchEvent) => finish(true, event);
    const cancel = (event: TouchEvent) => finish(false, event);
    scroller.addEventListener("touchstart", start, { passive: true });
    scroller.addEventListener("touchmove", move, { passive: false });
    scroller.addEventListener("touchend", end, { passive: false });
    scroller.addEventListener("touchcancel", cancel, { passive: false });
    return () => {
      alive = false;
      clearTimeout(timer);
      scroller.removeEventListener("touchstart", start);
      scroller.removeEventListener("touchmove", move);
      scroller.removeEventListener("touchend", end);
      scroller.removeEventListener("touchcancel", cancel);
      scroller.style.removeProperty("overscroll-behavior-y");
      if (dirty) clear();
    };
  }, [ref, badgeRef, enabled]);
}
