import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { BUBBLE_ARM, SWIPE_MOTION_MS, SWIPE_SPRING, bubbleSwipe, hapticTick, lockAxis, reducedMotion, swipeBlocked, type BubbleSide } from "./phone-swipe";
import { useIsPhone } from "./use-phone-swipe";

const CLICK_SWALLOW_MS = 400;

let menuOpen = false;
if (typeof window !== "undefined") window.addEventListener("orbit:message-menu", (event) => { menuOpen = event.detail; });

type Drag = { x: number; y: number; dx: number; locked: boolean; armed: BubbleSide | null };

interface BubbleSwipe {
  row: RefObject<HTMLElement | null>;
  bubble: RefObject<HTMLElement | null>;
  canReply: boolean;
  canTranslate: boolean;
  onReply: () => void;
  onTranslate: () => void;
}

/** Phone-only: swipe a room row right to reply, left to translate. Sets data-swipe, data-armed and --bubble-swipe (0..1) on the row for the icons behind the bubble. */
export function useBubbleSwipe({ row, bubble, canReply, canTranslate, onReply, onTranslate }: BubbleSwipe): void {
  const phone = useIsPhone();
  const latest = useRef({ canReply, canTranslate, onReply, onTranslate });
  useLayoutEffect(() => {
    latest.current = { canReply, canTranslate, onReply, onTranslate };
  });

  useEffect(() => {
    const el = row.current;
    const moving = bubble.current;
    if (!phone || !el || !moving) return;
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
    };
    const sides = () => ({ right: latest.current.canReply, left: latest.current.canTranslate });
    const end = (fire: boolean) => {
      const done = drag;
      drag = null;
      if (!done?.locked) return;
      const { offset, armed } = bubbleSwipe(done.dx, sides());
      mark(null, 0, null);
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
      }
      if (e.cancelable) e.preventDefault();
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
        // cancelling the touchend keeps a drag from ending in a click
        if (e.cancelable) e.preventDefault();
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
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      el.removeEventListener("click", onClick, true);
      clearTimeout(swallowTimer);
      el.style.touchAction = "";
      moving.style.transform = "";
      mark(null, 0, null);
    };
  }, [phone, row, bubble]);
}
