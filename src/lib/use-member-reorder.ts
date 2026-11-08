import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

import { hapticTick, reducedMotion, SWIPE_MOTION_MS, SWIPE_SPRING } from "./phone-swipe";
import { moveMember } from "./room-members";
import { LONG_PRESS_MS, LONG_PRESS_SLOP, SCROLL_EDGE, SCROLL_STEP } from "./use-touch-drag";

const SLIDE = `translate ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
const LIFT = "scale 150ms ease-out, box-shadow 150ms ease-out";
const LIFTED = { scale: "1.2", boxShadow: "0 8px 24px rgb(0 0 0 / 0.35)" };

// A copy of the lifted picture drawn over the page, standing in for it while the row clips.
type Ghost = { el: HTMLElement; copy: HTMLElement; left: number; top: number };

type Press = {
  id: string;
  el: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  lastX: number;
  scrollLeft: number;
  maxScroll: number;
  frame: number;
  lifted: boolean;
  ghost: Ghost | null;
  centers: number[];
  to: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  unbind: () => void;
};

/** Where a picture whose center sits at `x` lands among the other pictures' centers. */
export function rosterSlot(centers: number[], from: number, x: number): number {
  return centers.filter((center, i) => i !== from && center < x).length;
}

const centerOf = (el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  return rect.left + rect.width / 2;
};

/** Drag `[data-member-id]` pictures inside the row to reorder them: mouse drags at once, touch after a long press, Alt+Left/Right from the keyboard. */
export function useMemberReorder(ids: string[], onReorder: (next: string[], id: string) => void) {
  const rowRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const swallowClick = useRef(false);
  const drawnAt = useRef<Map<string, number> | null>(null);
  const focusId = useRef<string | null>(null);
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  const landing = useRef<Ghost | null>(null);
  const latest = useRef({ ids, onReorder });
  useLayoutEffect(() => {
    latest.current = { ids, onReorder };
  });

  const pictures = () => [...(rowRef.current?.querySelectorAll<HTMLElement>("[data-member-id]") ?? [])];

  const dropGhost = () => {
    landing.current?.copy.remove();
    landing.current?.el.style.removeProperty("opacity");
    landing.current = null;
  };

  // slide every picture from where it was drawn to its new place
  const settle = () => {
    const from = drawnAt.current;
    drawnAt.current = null;
    if (!from) return;
    const els = pictures();
    const still = reducedMotion();
    for (const el of els) {
      el.style.transition = "none";
      el.style.translate = "";
    }
    const ghost = landing.current;
    const to = ghost?.el.getBoundingClientRect();
    for (const el of els) {
      const old = from.get(el.dataset.memberId!);
      if (old !== undefined && !still) el.style.translate = `${old - centerOf(el)}px 0`;
    }
    rowRef.current?.getBoundingClientRect();
    for (const el of els) {
      el.style.transition = still ? "" : `${SLIDE}, ${LIFT}`;
      for (const key of ["translate", "scale", "box-shadow", "cursor"]) el.style.removeProperty(key);
    }
    if (ghost && to) {
      Object.assign(ghost.copy.style, { transition: still ? "" : `${SLIDE}, ${LIFT}`, translate: `${to.left - ghost.left}px ${to.top - ghost.top}px`, scale: "", boxShadow: "" });
    }
    clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      for (const el of els) for (const key of ["transition", "z-index"]) el.style.removeProperty(key);
      dropGhost();
    }, still ? 0 : SWIPE_MOTION_MS);
  };

  const commit = (id: string, to: number) => {
    const { ids, onReorder } = latest.current;
    drawnAt.current = new Map(pictures().map((el) => [el.dataset.memberId!, centerOf(el)]));
    const next = moveMember(ids, id, to);
    if (next.every((other, i) => other === ids[i])) {
      settle();
      return false;
    }
    onReorder(next, id);
    return true;
  };

  const order = ids.join("\n");
  useLayoutEffect(() => {
    settle();
    const id = focusId.current;
    focusId.current = null;
    if (id) pictures().find((el) => el.dataset.memberId === id)?.focus();
  }, [order]);

  // leaving the room mid-drag drops the drag without saving
  useEffect(
    () => () => {
      const p = press.current;
      press.current = null;
      clearTimeout(p?.timer);
      if (p) cancelAnimationFrame(p.frame);
      p?.unbind();
      p?.ghost?.copy.remove();
      clearTimeout(settling.current);
      dropGhost();
    },
    [],
  );

  useEffect(() => {
    const row = rowRef.current;
    const onMove = (event: TouchEvent) => {
      if (press.current?.lifted) event.preventDefault();
    };
    row?.addEventListener("touchmove", onMove, { passive: false });
    return () => row?.removeEventListener("touchmove", onMove);
  }, []);

  const lift = (p: Press) => {
    clearTimeout(settling.current);
    dropGhost();
    p.lifted = true;
    p.centers = pictures().map(centerOf);
    for (const el of pictures()) el.style.transition = el === p.el ? LIFT : SLIDE;
    const row = rowRef.current;
    if (row && /auto|scroll|hidden|clip/.test(getComputedStyle(row).overflowX)) {
      // the phone row scrolls, so it clips anything that pokes out of it
      const { left, top } = p.el.getBoundingClientRect();
      const copy = p.el.cloneNode(true) as HTMLElement;
      copy.removeAttribute("data-member-id");
      copy.setAttribute("aria-hidden", "true");
      copy.inert = true;
      Object.assign(copy.style, { position: "fixed", left: `${left}px`, top: `${top}px`, margin: "0", zIndex: "50", pointerEvents: "none", transition: LIFT });
      p.el.ownerDocument.body.append(copy);
      copy.getBoundingClientRect();
      Object.assign(copy.style, LIFTED);
      Object.assign(p.el.style, { opacity: "0", cursor: "grabbing" });
      p.ghost = { el: p.el, copy, left, top };
    } else {
      Object.assign(p.el.style, { zIndex: "20", cursor: "grabbing", ...LIFTED });
    }
    hapticTick();
    const tick = () => {
      if (press.current !== p) return;
      const row = rowRef.current;
      if (row && row.clientWidth > 0 && p.maxScroll > 0) {
        const rect = row.getBoundingClientRect();
        const edge = Math.min(SCROLL_EDGE, rect.width / 3);
        const step = p.lastX < rect.left + edge ? -SCROLL_STEP : p.lastX > rect.right - edge ? SCROLL_STEP : 0;
        const before = row.scrollLeft;
        row.scrollLeft = Math.max(0, Math.min(p.maxScroll, before + step));
        if (row.scrollLeft !== before) follow(p, p.lastX);
      }
      p.frame = requestAnimationFrame(tick);
    };
    p.frame = requestAnimationFrame(tick);
  };

  const follow = (p: Press, x: number) => {
    const { ids } = latest.current;
    const from = ids.indexOf(p.id);
    const dx = x - p.x + (rowRef.current?.scrollLeft ?? 0) - p.scrollLeft;
    p.el.style.translate = `${dx}px 0`;
    if (p.ghost) p.ghost.copy.style.translate = `${x - p.x}px 0`;
    const to = rosterSlot(p.centers, from, p.centers[from]! + dx);
    if (to === p.to) return;
    p.to = to;
    const live = moveMember(ids, p.id, to);
    pictures().forEach((el, i) => {
      if (el !== p.el) el.style.translate = `${p.centers[live.indexOf(el.dataset.memberId!)]! - p.centers[i]!}px 0`;
    });
  };

  const end = (drop: boolean) => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    clearTimeout(p.timer);
    cancelAnimationFrame(p.frame);
    p.unbind();
    if (!p.lifted) return;
    swallowClick.current = true;
    landing.current = p.ghost;
    commit(p.id, drop ? p.to : latest.current.ids.indexOf(p.id));
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    swallowClick.current = false;
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-member-id]") : null;
    const id = el?.dataset.memberId;
    if (press.current || !el || !id || event.button !== 0 || latest.current.ids.length < 2) return;
    const touch = event.pointerType === "touch";
    const win = el.ownerDocument.defaultView ?? window;
    const p: Press = {
      id,
      el,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      scrollLeft: rowRef.current?.scrollLeft ?? 0,
      maxScroll: Math.max(0, (rowRef.current?.scrollWidth ?? 0) - (rowRef.current?.clientWidth ?? 0)),
      frame: 0,
      lifted: false,
      ghost: null,
      centers: [],
      to: latest.current.ids.indexOf(id),
      timer: touch ? setTimeout(() => lift(p), LONG_PRESS_MS) : undefined,
      unbind: () => {},
    };
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== p.pointerId) return;
      const far = Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP;
      if (!p.lifted) {
        if (!far) return;
        if (touch) {
          swallowClick.current = true;
          return end(false);
        }
        lift(p);
      }
      e.preventDefault();
      p.lastX = e.clientX;
      follow(p, e.clientX);
    };
    const onUp = (e: globalThis.PointerEvent) => e.pointerId === p.pointerId && end(true);
    const onCancel = (e: globalThis.PointerEvent) => e.pointerId === p.pointerId && end(false);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && p.lifted) end(false);
    };
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
    win.addEventListener("pointercancel", onCancel);
    win.addEventListener("keydown", onKey);
    p.unbind = () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      win.removeEventListener("pointercancel", onCancel);
      win.removeEventListener("keydown", onKey);
    };
    press.current = p;
  };

  // a drag ends in a click on the picture, which would open the members panel
  const onClickCapture = (event: MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onContextMenu = (event: MouseEvent) => {
    if (press.current) event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const id = event.currentTarget.dataset.memberId;
    if (!id || !event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    if (commit(id, latest.current.ids.indexOf(id) + (event.key === "ArrowLeft" ? -1 : 1))) focusId.current = id;
  };

  return { rowRef, onPointerDown, onClickCapture, onContextMenu, onKeyDown };
}
