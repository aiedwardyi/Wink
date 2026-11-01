import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { lockAxis, type SwipeAxis } from "./phone-swipe";

const SWIPE_PX = 40;
const HOLD_MS = 600;
const WAIT_MS = 500;

type Moves = { step: (dir: number) => void; shift: (dir: number) => void };
type Drag = { id: number; x: number; y: number; at: number; axis: SwipeAxis; shifted: boolean; held: boolean; anchor?: number };

/** A swipe turns one model at any speed; a drag held 600 ms turns one more per pitch. A horizontal swipe moves effort one notch. */
export function useDialTouch(ref: RefObject<HTMLElement | null>, index: number, pitch: number, moves: Moves): void {
  const latest = useRef({ moves, pitch });
  latest.current = { moves, pitch };
  // Model steps asked for, steps landed and the one still rendering.
  const spin = useRef({ goal: 0, done: 0, pending: 0, sent: 0, run: () => {} });

  useLayoutEffect(() => {
    const state = spin.current;
    if (!state.pending) return;
    state.done += state.pending;
    state.pending = 0;
    state.run();
  }, [index]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const state = spin.current;
    let drag: Drag | null = null;
    let frame = 0;
    let dragged = false;

    const tick = (now: number) => {
      frame = 0;
      if (state.pending && now - state.sent > WAIT_MS) {
        state.pending = 0;
        state.goal = state.done;
      }
      if (!state.pending && state.goal !== state.done) {
        state.pending = Math.sign(state.goal - state.done);
        state.sent = now;
        latest.current.moves.step(state.pending);
      }
      if (state.pending) frame = requestAnimationFrame(tick);
    };
    const run = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    state.run = run;
    const turn = (steps: number) => {
      state.goal += steps;
      run();
    };

    const onDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button) return;
      dragged = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), axis: null, shifted: false, held: false };
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== drag?.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.axis) {
        drag.axis = lockAxis(dx, dy);
        if (!drag.axis) return;
        dragged = true;
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }
      if (drag.axis === "x") {
        if (drag.shifted || Math.abs(dx) < SWIPE_PX) return;
        drag.shifted = true;
        latest.current.moves.shift(-Math.sign(dx));
        return;
      }
      // Travel from before the hold never counts, so a fast swipe that rests still turns one model.
      if (!drag.held && performance.now() - drag.at >= HOLD_MS) {
        drag.held = true;
        if (drag.anchor !== undefined) drag.anchor = event.clientY;
      }
      if (drag.anchor === undefined) {
        if (Math.abs(dy) < SWIPE_PX) return;
        drag.anchor = event.clientY;
        turn(-Math.sign(dy));
      } else if (drag.held) {
        const steps = Math.trunc((event.clientY - drag.anchor) / latest.current.pitch);
        drag.anchor += steps * latest.current.pitch;
        if (steps) turn(-steps);
      }
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId === drag?.id) drag = null;
    };
    const onClick = (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.stopPropagation();
      event.preventDefault();
    };
    // The picker's own touch stepper and the phone sidebar swipe listen above the dial.
    const hold = (event: TouchEvent) => event.stopPropagation();

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    el.addEventListener("touchstart", hold, { passive: true });
    el.addEventListener("touchmove", hold, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("touchstart", hold);
      el.removeEventListener("touchmove", hold);
    };
  }, [ref]);
}
