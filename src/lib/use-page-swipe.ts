import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { lockAxis, swipeStep, type SwipeStep } from "./phone-swipe";

type Drag = { x: number; y: number; lastX: number; lastT: number; velocity: number; axis: ReturnType<typeof lockAxis> };

/** A one finger horizontal swipe on `ref` calls `turn` with 1 (swiped left) or -1 (swiped right). Vertical drags and pinches are left to the browser. */
export function usePageSwipe(ref: RefObject<HTMLElement | null>, turn: (step: SwipeStep) => void): void {
  const latest = useRef(turn);
  useLayoutEffect(() => { latest.current = turn; });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let drag: Drag | null = null;
    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      drag = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0, axis: null } : null;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!drag || !touch) return;
      if (event.touches.length !== 1) { drag = null; return; }
      const dt = event.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = event.timeStamp;
      drag.axis ??= lockAxis(touch.clientX - drag.x, touch.clientY - drag.y);
    };
    const end = (event: TouchEvent) => {
      const done = drag;
      drag = null;
      // A pinched-in page pans instead of turning.
      if (done?.axis !== "x" || (window.visualViewport?.scale ?? 1) > 1.01) return;
      const velocity = event.timeStamp - done.lastT > 100 ? 0 : done.velocity;
      const step = swipeStep(done.lastX - done.x, velocity, node.clientWidth || window.innerWidth);
      if (step) latest.current(step);
    };
    const cancel = () => { drag = null; };
    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchmove", move, { passive: true });
    node.addEventListener("touchend", end, { passive: true });
    node.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", cancel);
    };
  }, [ref]);
}
