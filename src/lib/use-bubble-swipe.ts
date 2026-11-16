import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { BUBBLE_ARM, SWIPE_MOTION_MS, SWIPE_SPRING, bubbleSwipe, hapticTick, lockAxis, reducedMotion, swipeBlocked, type BubbleSide } from "./phone-swipe";
import { useIsPhone } from "./use-phone-swipe";

const CLICK_SWALLOW_MS = 400;

let menuOpen = false;
if (typeof window !== "undefined") window.addEventListener("orbit:message-menu", (event) => { menuOpen = event.detail; });

type Drag = { x: number; y: number; dx: number; locked: boolean; armed: BubbleSide | null };
type Row = { start: (e: TouchEvent) => void; move: (e: TouchEvent) => void; end: (e: TouchEvent) => void; cancel: () => void; click: (e: MouseEvent) => void };

const rows = new WeakMap<Element, Row>();
const lists = new Map<HTMLElement, { rows: number; off: () => void }>();

function rowOf(list: HTMLElement, target: EventTarget | null): Row | undefined {
  for (let node = target instanceof Element ? target : null; node && node !== list; node = node.parentElement) {
    const row = rows.get(node);
    if (row) return row;
  }
}

/** One passive set of listeners per list, however many rows it holds. */
function listen(list: HTMLElement): () => void {
  let held = lists.get(list);
  if (!held) {
    const start = (e: TouchEvent) => rowOf(list, e.target)?.start(e);
    const move = (e: TouchEvent) => rowOf(list, e.target)?.move(e);
    const end = (e: TouchEvent) => rowOf(list, e.target)?.end(e);
    const cancel = (e: TouchEvent) => rowOf(list, e.target)?.cancel();
    const click = (e: MouseEvent) => rowOf(list, e.target)?.click(e);
    list.addEventListener("touchstart", start, { passive: true });
    list.addEventListener("touchmove", move, { passive: true });
    list.addEventListener("touchend", end, { passive: true });
    list.addEventListener("touchcancel", cancel, { passive: true });
    list.addEventListener("click", click, true);
    held = {
      rows: 0,
      off: () => {
        list.removeEventListener("touchstart", start);
        list.removeEventListener("touchmove", move);
        list.removeEventListener("touchend", end);
        list.removeEventListener("touchcancel", cancel);
        list.removeEventListener("click", click, true);
      },
    };
    lists.set(list, held);
  }
  const own = held;
  own.rows++;
  return () => {
    if (--own.rows) return;
    own.off();
    lists.delete(list);
  };
}

interface BubbleSwipe {
  row: RefObject<HTMLElement | null>;
  bubble: RefObject<HTMLElement | null>;
  canReply: boolean;
  canTranslate: boolean;
  onReply: () => void;
  onTranslate: () => void;
}

/** Phone-only, inside a [data-swipe-list]: swipe a room row right to reply, left to translate. Sets data-swipe, data-armed and --bubble-swipe (0..1) on the row, and returns true while a swipe is on, for the icons behind the bubble. */
export function useBubbleSwipe({ row, bubble, canReply, canTranslate, onReply, onTranslate }: BubbleSwipe): boolean {
  const phone = useIsPhone();
  const [swiping, setSwiping] = useState(false);
  const latest = useRef({ canReply, canTranslate, onReply, onTranslate });
  useLayoutEffect(() => {
    latest.current = { canReply, canTranslate, onReply, onTranslate };
  });

  useEffect(() => {
    const el = row.current;
    const moving = bubble.current;
    const list = el?.closest<HTMLElement>("[data-swipe-list]");
    if (!phone || !el || !moving || !list) return;
    el.style.touchAction = "pan-y";
    let drag: Drag | null = null;
    let swallow = false;
    let swallowTimer: ReturnType<typeof setTimeout> | undefined;
    let spring: Animation | undefined;
    const mark = (side: BubbleSide | null, progress: number, armed: BubbleSide | null) => {
      if (side) {
        el.dataset.swipe = side;
        el.style.setProperty("--bubble-swipe", String(progress));
      } else {
        delete el.dataset.swipe;
        el.style.removeProperty("--bubble-swipe");
      }
      if (armed) el.dataset.armed = armed;
      else delete el.dataset.armed;
    };
    const springBack = (offset: number) => {
      moving.style.transform = "";
      if (!offset || reducedMotion() || typeof moving.animate !== "function") return;
      spring = moving.animate(
        [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
        { duration: SWIPE_MOTION_MS, easing: SWIPE_SPRING },
      );
      // cancel() rejects finished
      spring.finished.catch(() => {});
    };
    const sides = () => ({ right: latest.current.canReply, left: latest.current.canTranslate });
    const end = (fire: boolean) => {
      const done = drag;
      drag = null;
      if (!done?.locked) return;
      const { offset, armed } = bubbleSwipe(done.dx, sides());
      mark(null, 0, null);
      setSwiping(false);
      springBack(offset);
      if (fire && armed) (armed === "right" ? latest.current.onReply : latest.current.onTranslate)();
    };
    const onStart = (e: TouchEvent) => {
      end(false);
      swallow = false;
      clearTimeout(swallowTimer);
      spring?.cancel();
      spring = undefined;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || menuOpen || swipeBlocked(e.target, touch.clientX)) return;
      drag = { x: touch.clientX, y: touch.clientY, dx: 0, locked: false, armed: null };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!drag || !touch) return;
      if (e.touches.length > 1 || menuOpen) {
        end(false);
        return;
      }
      const dx = touch.clientX - drag.x;
      if (!drag.locked) {
        const axis = lockAxis(dx, touch.clientY - drag.y);
        if (axis === null) return;
        if (axis === "y") {
          drag = null;
          return;
        }
        drag.locked = true;
        setSwiping(true);
      }
      drag.dx = dx;
      const { offset, armed } = bubbleSwipe(dx, sides());
      if (armed && armed !== drag.armed) hapticTick();
      drag.armed = armed;
      if (!reducedMotion()) moving.style.transform = offset ? `translateX(${offset}px)` : "";
      mark(offset ? (offset < 0 ? "left" : "right") : null, Math.min(1, Math.abs(dx) / BUBBLE_ARM), armed);
    };
    const onEnd = (e: TouchEvent) => {
      const lifted = e.changedTouches?.[0];
      if (drag?.locked && lifted) drag.dx = lifted.clientX - drag.x;
      if (drag?.locked) {
        swallow = true;
        clearTimeout(swallowTimer);
        swallowTimer = setTimeout(() => { swallow = false; }, CLICK_SWALLOW_MS);
      }
      end(true);
    };
    const onCancel = () => end(false);
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      e.preventDefault();
      e.stopPropagation();
    };
    rows.set(el, { start: onStart, move: onMove, end: onEnd, cancel: onCancel, click: onClick });
    const off = listen(list);
    return () => {
      rows.delete(el);
      off();
      clearTimeout(swallowTimer);
      el.style.touchAction = "";
      moving.style.transform = "";
      mark(null, 0, null);
    };
  }, [phone, row, bubble]);
  return swiping;
}
