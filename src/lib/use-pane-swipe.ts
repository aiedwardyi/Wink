import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { MediaKind } from "./media-index";
import { dragOffset, hapticTick, lockAxis, neighborId, reducedMotion, SWIPE_MOTION_MS, SWIPE_SPRING, swipeBlocked, swipeStep, type SwipeAxis, type SwipeStep } from "./phone-swipe";

export type PaneTab = "show" | "media" | "check" | "map";
export type PaneSwipeTarget = { tab: PaneTab; kind?: MediaKind };
type Drag = {
  x: number; y: number; lastX: number; lastT: number; velocity: number; axis: SwipeAxis;
  width: number; reduced: boolean; nested: boolean; kind?: MediaKind; both: boolean;
  step: SwipeStep; target: PaneSwipeTarget | null; dismiss: boolean; offset: number;
  outgoing: HTMLElement | null; incoming: HTMLElement | null;
};

export function paneSwipeTarget(tabs: readonly PaneTab[], tab: PaneTab, step: SwipeStep, kind?: MediaKind, both = false): PaneSwipeTarget | null {
  if (tab === "media" && both) {
    if (step === 1 && kind === "photos") return { tab, kind: "files" };
    if (step === -1 && kind === "files") return { tab, kind: "photos" };
  }
  const id = neighborId(tabs, tab, step);
  const next = tabs.find(tab => tab === id);
  return next ? { tab: next } : null;
}

export function paneSwipeBlocked(target: Element): boolean {
  if (target.closest('.map-pane, iframe, [role="dialog"], [role="slider"], [data-media-thumb], [data-mi-zoom]')) return true;
  return swipeBlocked(target, window.innerWidth / 2);
}

export function usePaneSwipe(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  tab: PaneTab,
  tabs: readonly PaneTab[],
  choose: (next: PaneSwipeTarget) => void,
  close: () => void,
  threadId?: string,
) {
  const [preview, setPreview] = useState<PaneSwipeTarget | null>(null);
  const [highlight, setHighlight] = useState<PaneTab | null>(null);
  const active = useRef<Drag | null>(null);
  const latest = useRef({ tab, tabs, choose, close });
  const order = tabs.join(":");
  useLayoutEffect(() => { latest.current = { tab, tabs, choose, close }; });

  const paint = (drag: Drag) => {
    const panel = ref.current;
    if (!panel || drag.reduced) return;
    if (drag.dismiss) {
      panel.style.transform = `translate3d(${drag.offset}px, 0, 0)`;
      return;
    }
    if (drag.outgoing) drag.outgoing.style.transform = `translate3d(${drag.offset}px, 0, 0)`;
    if (drag.incoming) drag.incoming.style.transform = `translate3d(${drag.offset + drag.step * drag.width}px, 0, 0)`;
  };

  useLayoutEffect(() => {
    const drag = active.current;
    if (!drag || drag.axis !== "x" || drag.reduced) return;
    drag.incoming = ref.current?.querySelector<HTMLElement>("[data-pane-preview]") ?? null;
    if (drag.incoming) drag.incoming.style.willChange = "transform";
    paint(drag);
  });

  useEffect(() => {
    const panel = ref.current;
    if (!panel || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settling = false;
    let dismissed = false;
    let visual: Drag | null = null;
    const clear = () => {
      for (const node of [panel, visual?.outgoing, visual?.incoming]) {
        for (const key of ["transform", "transition", "will-change"]) node?.style.removeProperty(key);
      }
      visual = null;
    };
    const reset = () => {
      clear();
      setPreview(null);
      setHighlight(null);
    };
    const start = (event: TouchEvent) => {
      if (active.current?.axis === "x") {
        if (event.touches.length !== 1) finish(false, event);
        return;
      }
      active.current = null;
      const touch = event.touches[0];
      if (settling || event.touches.length !== 1 || !touch || !(event.target instanceof Element) || paneSwipeBlocked(event.target)) return;
      const kinds = panel.querySelector("[data-pane-current] [data-media-kinds]");
      const picked = kinds?.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.mediaKind;
      const kind = picked === "photos" || picked === "files" ? picked : undefined;
      active.current = {
        x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0, axis: null,
        width: panel.clientWidth || window.innerWidth, reduced: reducedMotion(), nested: !event.target.closest(".show-pane-head"), kind, both: Boolean(kinds),
        step: 0, target: null, dismiss: false, offset: 0, outgoing: panel.querySelector("[data-pane-current]"), incoming: null,
      };
    };
    const move = (event: TouchEvent) => {
      const drag = active.current;
      if (!drag) return;
      if (event.touches.length !== 1) { finish(false, event); return; }
      const touch = event.touches[0]!;
      const dx = touch.clientX - drag.x;
      if (!drag.axis) {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) { active.current = null; return; }
        drag.axis = lockAxis(dx, touch.clientY - drag.y);
        if (drag.axis === "y") { active.current = null; return; }
        if (!drag.axis) return;
        const current = latest.current;
        drag.step = dx < 0 ? 1 : -1;
        drag.target = paneSwipeTarget(current.tabs, current.tab, drag.step, drag.kind, drag.both && drag.nested);
        drag.dismiss = drag.step === -1 && !drag.target && current.tabs[0] === current.tab;
        visual = drag;
        if (!drag.reduced) {
          (drag.dismiss ? panel : drag.outgoing)?.style.setProperty("will-change", "transform");
          setPreview(drag.target);
        }
      }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const dt = event.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = event.timeStamp;
      const travel = drag.step === 1 ? Math.min(0, dx) : Math.max(0, dx);
      drag.offset = dragOffset(travel, Boolean(drag.target) || drag.dismiss);
      if (!drag.reduced) {
        setHighlight(Math.abs(travel) >= drag.width / 2 ? drag.target?.tab ?? null : null);
        paint(drag);
      }
    };
    const finish = (commit: boolean, event: TouchEvent) => {
      const done = active.current;
      active.current = null;
      if (done?.axis !== "x") return;
      if (event.cancelable && event.type !== "touchstart") event.preventDefault();
      event.stopPropagation();
      const velocity = event.timeStamp - done.lastT > 100 ? 0 : done.velocity;
      const goes = commit && swipeStep(done.lastX - done.x, velocity, done.width) === done.step && (done.target !== null || done.dismiss);
      if (goes) hapticTick();
      const apply = () => {
        if (goes) {
          if (done.dismiss) {
            dismissed = true;
            panel.dataset.paneDismissed = "";
            latest.current.close();
            return;
          }
          latest.current.choose(done.target!);
        }
        reset();
      };
      if (done.reduced) { apply(); return; }
      settling = true;
      setHighlight(goes ? done.target?.tab ?? null : null);
      const motion = `transform ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
      for (const node of done.dismiss ? [panel] : [done.outgoing, done.incoming]) if (node) node.style.transition = motion;
      done.offset = goes ? -done.step * done.width : 0;
      paint(done);
      timer = setTimeout(() => { settling = false; apply(); }, SWIPE_MOTION_MS);
    };
    const end = (event: TouchEvent) => finish(true, event);
    const cancel = (event: TouchEvent) => finish(false, event);
    panel.addEventListener("touchstart", start, { passive: true });
    panel.addEventListener("touchmove", move, { passive: false });
    panel.addEventListener("touchend", end, { passive: false });
    panel.addEventListener("touchcancel", cancel, { passive: false });
    return () => {
      clearTimeout(timer);
      active.current = null;
      panel.removeEventListener("touchstart", start);
      panel.removeEventListener("touchmove", move);
      panel.removeEventListener("touchend", end);
      panel.removeEventListener("touchcancel", cancel);
      if (!dismissed) reset();
    };
  }, [ref, enabled, tab, order, threadId]);

  return { preview, highlight };
}
