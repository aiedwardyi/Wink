import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { EASE_STANDARD, MOTION_LARGE_MS } from "./motion";
import { hapticTick, lockAxis, reducedMotion, SWIPE_MOTION_MS, SWIPE_SPRING, swipeStep, type SwipeAxis } from "./phone-swipe";
import { settingsSwipeBlocked } from "./use-settings-swipe";

type Drag = { x: number; y: number; lastX: number; lastT: number; velocity: number; axis: SwipeAxis; width: number; memory: boolean; reduced: boolean };

const PASS_PX = 40;
const SWIPE_STYLE = ["transform", "transition", "will-change"];

// SAFETY: the stage renders exactly the Settings and Memory pages, in that order.
const tabPages = (stage: HTMLElement) => [...stage.children] as [HTMLElement, HTMLElement];

/** Passes between the Settings and Memory pages, the two children of `pages`, and swipes them on a phone. True while both pages must stay up. */
export function useDetailsTabs(pages: RefObject<HTMLElement | null>, phone: boolean, closing: boolean, memory: boolean, show: (memory: boolean) => void): boolean {
  const [shown, setShown] = useState(memory);
  const [paging, setPaging] = useState(false);
  if (shown !== memory) {
    setShown(memory);
    setPaging(true);
  }
  const running = useRef<Animation[]>([]);
  const swiped = useRef(false);
  const was = useRef(memory);
  const latest = useRef({ memory, show });
  useLayoutEffect(() => { latest.current = { memory, show }; });

  useLayoutEffect(() => {
    if (was.current === memory || !pages.current) return;
    was.current = memory;
    if (swiped.current) { swiped.current = false; return; }
    const [settings, map] = tabPages(pages.current);
    const incoming = memory ? map : settings, outgoing = memory ? settings : map;
    incoming.scrollTop = 0;
    if (reducedMotion() || !incoming.animate) { setPaging(false); return; }
    if (phone && running.current.length) { for (const each of running.current) each.reverse(); return; }
    for (const each of running.current) each.cancel();
    const sign = memory ? 1 : -1;
    const pass = { duration: MOTION_LARGE_MS, easing: EASE_STANDARD, fill: "both" } as const;
    const moving = [incoming.animate([{ transform: `translate3d(${sign * PASS_PX}px, 0, 0)`, opacity: 0 }, { transform: "none", opacity: 1 }], pass)];
    running.current = moving;
    void moving[0]!.finished.then(() => setPaging(false), () => undefined);
    // a wide window's cover fades the outgoing page itself; a frame late, so the commit that mounts the map doesn't also promote this page
    if (phone) requestAnimationFrame(() => {
      if (running.current === moving) moving.push(outgoing.animate([{ transform: "none", opacity: 1 }, { opacity: 0, offset: 0.5 }, { transform: `translate3d(${-sign * PASS_PX}px, 0, 0)`, opacity: 0 }], pass));
    });
  }, [memory]);

  // after the commit that hides the outgoing page, so it never flashes back at rest
  useLayoutEffect(() => {
    if (paging || !pages.current) return;
    for (const each of running.current) each.cancel();
    running.current = [];
    for (const page of tabPages(pages.current)) for (const key of SWIPE_STYLE) page.style.removeProperty(key);
  }, [paging]);

  const swipes = phone && !closing;
  useEffect(() => {
    const stage = pages.current;
    const panel = stage?.parentElement;
    if (!stage || !panel || !swipes) return;
    const [settings, map] = tabPages(stage);
    let drag: Drag | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settling = false;
    const paint = (x: number, { memory: on, width }: Drag) => {
      (on ? map : settings).style.transform = `translate3d(${x}px, 0, 0)`;
      (on ? settings : map).style.transform = `translate3d(${x + (on ? -width : width)}px, 0, 0)`;
    };
    const start = (event: TouchEvent) => {
      if (drag?.axis === "x") {
        if (event.touches.length !== 1) finish(false, event);
        return;
      }
      drag = null;
      const touch = event.touches[0];
      if (settling || event.touches.length !== 1 || !touch || !(event.target instanceof Element) || settingsSwipeBlocked(event.target)) return;
      drag = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0, axis: null, width: stage.clientWidth || window.innerWidth, memory: latest.current.memory, reduced: reducedMotion() };
    };
    const move = (event: TouchEvent) => {
      if (!drag) return;
      if (event.touches.length !== 1) { finish(false, event); return; }
      const touch = event.touches[0]!;
      const dx = touch.clientX - drag.x;
      if (!drag.axis) {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) { drag = null; return; }
        drag.axis = lockAxis(dx, touch.clientY - drag.y);
        // a right drag on Settings closes the panel, in useSettingsSwipe
        if (drag.axis === "y" || (drag.axis === "x" && dx > 0 !== drag.memory)) { drag = null; return; }
        if (!drag.axis) return;
        if (!drag.reduced) {
          settings.style.willChange = map.style.willChange = "transform";
          setPaging(true);
        }
      }
      if (event.cancelable) event.preventDefault();
      const dt = event.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = event.timeStamp;
      if (!drag.reduced) paint(drag.memory ? Math.max(0, dx) : Math.min(0, dx), drag);
    };
    const finish = (commit: boolean, event: TouchEvent) => {
      const done = drag;
      drag = null;
      if (done?.axis !== "x") return;
      // Suppress the click a touch drag can otherwise leave behind.
      if (event.cancelable && event.type !== "touchstart") event.preventDefault();
      const velocity = event.timeStamp - done.lastT > 100 ? 0 : done.velocity;
      const goes = commit && swipeStep(done.lastX - done.x, velocity, done.width) === (done.memory ? -1 : 1);
      if (goes) hapticTick();
      if (done.reduced) {
        if (goes) latest.current.show(!done.memory);
        return;
      }
      settling = true;
      const motion = `transform ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
      settings.style.transition = map.style.transition = motion;
      paint(goes ? (done.memory ? done.width : -done.width) : 0, done);
      if (goes) {
        (done.memory ? settings : map).scrollTop = 0;
        swiped.current = true;
        latest.current.show(!done.memory);
      }
      timer = setTimeout(() => {
        settling = false;
        setPaging(false);
      }, SWIPE_MOTION_MS);
    };
    const end = (event: TouchEvent) => finish(true, event);
    const cancel = (event: TouchEvent) => finish(false, event);
    panel.addEventListener("touchstart", start, { passive: true });
    panel.addEventListener("touchmove", move, { passive: false });
    panel.addEventListener("touchend", end, { passive: false });
    panel.addEventListener("touchcancel", cancel, { passive: false });
    return () => {
      clearTimeout(timer);
      panel.removeEventListener("touchstart", start);
      panel.removeEventListener("touchmove", move);
      panel.removeEventListener("touchend", end);
      panel.removeEventListener("touchcancel", cancel);
      if (settling || drag?.axis === "x") setPaging(false);
    };
  }, [pages, swipes]);

  return phone && paging;
}
