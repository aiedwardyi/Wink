import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { SidebarSide } from "./sidebar-preferences";
import {
  PHONE_QUERY,
  SWIPE_MOTION_MS,
  SWIPE_SPRING,
  dragOffset,
  drawerOffset,
  drawerSwipeCloses,
  hapticTick,
  isPhone,
  lockAxis,
  neighborId,
  reducedMotion,
  sheetSwipeCloses,
  swipeBlocked,
  swipeBlockedInput,
  swipeStep,
  type SwipeAxis,
  type SwipeStep,
} from "./phone-swipe";

type Drag = {
  x: number;
  y: number;
  lastX: number;
  lastT: number;
  velocity: number;
  axis: SwipeAxis;
  ids: string[];
};

const TAP_ENTER_PX = 32;
const FLICK_STILL_MS = 100;

function settle(stages: (HTMLElement | null | undefined)[], from: number, to: number, opacity = 1) {
  const animations: Animation[] = [];
  for (const stage of stages) {
    if (!stage) continue;
    stage.style.transform = to ? `translateX(${to}px)` : "";
    if (reducedMotion() || typeof stage.animate !== "function") continue;
    animations.push(stage.animate(
      [{ transform: `translateX(${from}px)`, opacity }, { transform: `translateX(${to}px)`, opacity: 1 }],
      { duration: SWIPE_MOTION_MS, easing: SWIPE_SPRING },
    ));
  }
  return animations;
}

export type PhoneSwipePeek = { from: string; id: string; step: SwipeStep };

/** Phone-only paging between the chats `order` lists. `rider` moves with the stage; `onPeek` retains the neighbor through the spring. */
export function usePhoneSwipe(
  botId: string | undefined,
  enabled: boolean,
  select: (id: string) => void,
  rider: RefObject<HTMLElement | null> | undefined,
  order: () => string[],
  onPeek?: (peek: PhoneSwipePeek | null) => void,
): (node: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const stage = useCallback((node: HTMLElement | null) => setEl(node), []);

  const enterFrom = useRef<number | null>(null);
  const landed = useRef<string | null>(null);
  const shownBot = useRef(botId);
  const latest = useRef({ botId, select, order, onPeek });
  const resetMotion = useRef(() => {});
  useLayoutEffect(() => {
    latest.current = { botId, select, order, onPeek };
  });

  useLayoutEffect(() => {
    const from = shownBot.current;
    shownBot.current = botId;
    if (!from || !botId || from === botId || !el || !isPhone()) return;
    hapticTick();
    resetMotion.current();
    if (landed.current === botId) {
      landed.current = null;
      return;
    }
    landed.current = null;
    if (enterFrom.current !== null) {
      settle([el, rider?.current], enterFrom.current, 0);
      enterFrom.current = null;
      return;
    }
    const ids = latest.current.order();
    const dir = Math.sign(ids.indexOf(botId) - ids.indexOf(from));
    settle([el, rider?.current], ids.includes(from) && ids.includes(botId) ? dir * TAP_ENTER_PX : 0, 0, 0);
  }, [botId, el, rider]);

  const hasBot = Boolean(botId);
  useEffect(() => {
    if (!el || !hasBot || !enabled) return;
    let drag: Drag | null = null;
    let startX = 0;
    let width = 0;
    let peek: PhoneSwipePeek | null = null;
    let frame = 0;
    let offset = 0;
    let animations: Animation[] = [];
    let motion = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stages = () => [el, rider?.current];
    const move = (transform: string) => {
      for (const stage of stages()) if (stage) stage.style.transform = transform;
    };
    const paint = () => {
      frame = 0;
      move(offset ? `translateX(${offset}px)` : "");
    };
    const showPeek = (id: string | null, step: SwipeStep) => {
      const from = latest.current.botId;
      if ((peek?.id ?? null) === id && (!id || peek?.from === from)) return;
      peek = id && from ? { from, id, step } : null;
      latest.current.onPeek?.(peek);
    };
    const stopMotion = () => {
      motion++;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      frame = 0;
      for (const animation of animations) animation.cancel();
      animations = [];
    };
    const clear = () => {
      stopMotion();
      drag = null;
      offset = 0;
      move("");
      for (const stage of stages()) stage?.style.removeProperty("will-change");
      showPeek(null, 0);
    };
    resetMotion.current = clear;
    const spring = (from: number, to: number, done: () => void) => {
      stopMotion();
      const version = motion;
      const finish = () => {
        if (version !== motion) return;
        for (const animation of animations) animation.cancel();
        animations = [];
        done();
      };
      offset = to;
      animations = settle(stages(), from, to);
      // Some animate implementations lack the finished promise and need the timer fallback.
      if (animations.length && animations.every((animation) => animation.finished)) {
        void Promise.all(animations.map((animation) => animation.finished)).then(finish, () => {});
      } else if (animations.length) {
        timer = setTimeout(finish, SWIPE_MOTION_MS);
      } else {
        finish();
      }
    };
    const preview = (dx: number) => {
      const step = dx === 0 ? 0 : dx < 0 ? 1 : -1;
      const id = neighborId(drag!.ids, latest.current.botId ?? "", step);
      showPeek(id, step);
      offset = dragOffset(dx, id !== null);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      const bubble = e.target instanceof Element && e.target.closest("[data-bubble-swipe]");
      if (e.touches.length !== 1 || !touch || !isPhone() || bubble || swipeBlocked(e.target, touch.clientX)) {
        clear();
        return;
      }
      // A new gesture catches the spring where it is, before cancelling its animation.
      const transform = animations.length ? getComputedStyle(el).transform : "";
      const matrix = transform.match(/^matrix(3d)?\((.+)\)$/);
      const caught = matrix ? Number(matrix[2].split(",")[matrix[1] ? 12 : 4]) || 0 : 0;
      stopMotion();
      offset = caught;
      move(caught ? `translateX(${caught}px)` : "");
      width = el.clientWidth || window.innerWidth;
      stages().forEach((stage) => stage?.getAnimations?.().forEach((animation) => animation.cancel()));
      const ids = latest.current.order();
      const canMove = neighborId(ids, latest.current.botId ?? "", caught < 0 ? 1 : -1) !== null;
      startX = touch.clientX;
      drag = { x: touch.clientX - caught * (canMove ? 1 : 3), y: touch.clientY, lastX: touch.clientX, lastT: e.timeStamp, velocity: 0, axis: null, ids };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!drag || !touch) return;
      if (e.touches.length !== 1) {
        finish(false);
        return;
      }
      const dx = touch.clientX - drag.x;
      const horizontal = drag.axis === "x";
      drag.axis ??= lockAxis(touch.clientX - startX, touch.clientY - drag.y);
      if (drag.axis !== "x") {
        if (drag.axis === "y") {
          drag = null;
          if (offset) spring(offset, 0, clear);
          else clear();
        }
        return;
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = e.timeStamp;
      preview(dx);
      if (horizontal) return;
      for (const stage of stages()) if (stage) stage.style.willChange = "transform";
      // The lock frame moves in the handler and never waits for the neighbor to mount.
      cancelAnimationFrame(frame);
      paint();
    };
    const finish = (commit: boolean) => {
      if (!drag) return;
      if (drag.axis !== "x") {
        drag = null;
        if (offset) spring(offset, 0, clear);
        else clear();
        return;
      }
      const { botId: current = "", select: go } = latest.current;
      const dx = drag.lastX - drag.x;
      const step = commit ? swipeStep(dx, drag.velocity, width) : 0;
      const target = neighborId(drag.ids, current, step);
      const canMove = neighborId(drag.ids, current, dx < 0 ? 1 : -1) !== null;
      const from = dragOffset(dx, canMove);
      drag = null;
      if (!target) {
        spring(from, 0, clear);
        return;
      }
      if (latest.current.onPeek) {
        spring(from, -step * width, () => {
          // Rebase the retained page before removing the outgoing one or yielding a paint.
          flushSync(() => {
            landed.current = target;
            go(target);
            showPeek(null, 0);
          });
          if (landed.current === target) {
            landed.current = null;
            clear();
          }
        });
        return;
      }
      enterFrom.current = dx + step * width;
      stopMotion();
      offset = 0;
      move("");
      go(target);
    };
    const onEnd = () => finish(true);
    const onCancel = () => finish(false);
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    const media = window.matchMedia?.(PHONE_QUERY);
    const onResize = () => {
      if (!isPhone() || (drag || animations.length || frame) && (el.clientWidth || window.innerWidth) !== width) clear();
    };
    media?.addEventListener?.("change", onResize);
    window.addEventListener("resize", onResize);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      media?.removeEventListener?.("change", onResize);
      window.removeEventListener("resize", onResize);
      clear();
      resetMotion.current = () => {};
    };
  }, [el, hasBot, enabled, rider]);

  return stage;
}

/** Reactive isPhone: true while below the breakpoint, so below-md controls can hide with it. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    const flip = () => setPhone(isPhone());
    media?.addEventListener?.("change", flip);
    return () => media?.removeEventListener?.("change", flip);
  }, []);
  return phone;
}

type DrawerDrag = Omit<Drag, "ids"> & { drawer: HTMLElement; scrim: HTMLElement | null };

const DRAWER_STYLE = ["translate", "opacity", "transition"];

function clearDrawerStyle(...els: (HTMLElement | null)[]) {
  for (const node of els) for (const key of DRAWER_STYLE) node?.style.removeProperty(key);
}

/** Phone-only swipe on the open drawer or its scrim toward the drawer's edge, closing it through `close`. The returned ref goes on their shared parent. */
export function useDrawerSwipe(open: boolean, side: SidebarSide, close: () => void): (node: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const shell = useCallback((node: HTMLElement | null) => setEl(node), []);
  const latest = useRef({ side, close });
  useLayoutEffect(() => {
    latest.current = { side, close };
  });

  useEffect(() => {
    if (!el || !open) return;
    const drawer = el.querySelector<HTMLElement>("[data-phone-drawer]");
    const scrim = el.querySelector<HTMLElement>("[data-phone-drawer-scrim]");
    if (!drawer) return;
    let drag: DrawerDrag | null = null;
    let springTimer: ReturnType<typeof setTimeout> | undefined;
    const onStart = (e: TouchEvent) => {
      clearTimeout(springTimer);
      clearDrawerStyle(drawer, scrim);
      drag = null;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || !isPhone() || !(e.target instanceof Node)) return;
      if (!drawer.contains(e.target) && !scrim?.contains(e.target)) return;
      if (swipeBlocked(e.target, touch.clientX)) return;
      drag = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastT: e.timeStamp, velocity: 0, axis: null, drawer, scrim };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.x;
      drag.axis ??= lockAxis(dx, touch.clientY - drag.y);
      if (drag.axis !== "x") {
        if (drag.axis === "y") drag = null;
        return;
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientX - drag.lastX) / dt;
      drag.lastX = touch.clientX;
      drag.lastT = e.timeStamp;
      if (reducedMotion()) return;
      const offset = drawerOffset(dx, latest.current.side);
      drawer.style.transition = "none";
      drawer.style.translate = `${offset}px`;
      if (scrim) {
        scrim.style.transition = "none";
        scrim.style.opacity = String(1 - Math.abs(offset) / (drawer.offsetWidth || window.innerWidth));
      }
    };
    const finish = (commit: boolean, e: TouchEvent) => {
      if (drag?.axis !== "x") {
        drag = null;
        return;
      }
      // cancelling the touchend is what keeps a drag from ending in a click
      if (e.cancelable) e.preventDefault();
      const { side: edge, close: shut } = latest.current;
      const width = drawer.offsetWidth || window.innerWidth;
      const closes = commit && drawerSwipeCloses(drag.lastX - drag.x, drag.velocity, width, edge);
      drag = null;
      if (reducedMotion()) {
        clearDrawerStyle(drawer, scrim);
      } else {
        const motion = `${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
        drawer.style.transition = `translate ${motion}`;
        drawer.style.translate = closes ? (edge === "left" ? "-100%" : "100%") : "0px";
        if (scrim) {
          scrim.style.transition = `opacity ${motion}`;
          scrim.style.opacity = closes ? "0" : "1";
        }
        if (!closes) springTimer = setTimeout(() => clearDrawerStyle(drawer, scrim), SWIPE_MOTION_MS);
      }
      if (!closes) return;
      hapticTick();
      shut();
    };
    const onEnd = (e: TouchEvent) => finish(true, e);
    const onCancel = (e: TouchEvent) => finish(false, e);
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onCancel);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      clearTimeout(springTimer);
      // the closed class already sits where a swipe-close left the drawer, so this never jumps
      clearDrawerStyle(drawer, scrim);
    };
  }, [el, open]);

  return shell;
}

type SheetDrag = { x: number; y: number; lastY: number; lastT: number; velocity: number; pulling: boolean };

/** Swipe down on the open bottom sheet in `sheetRef` to close it through `close`. A scrolled list in it scrolls first: the sheet drags only from the list's top. */
export function useSheetSwipe(sheetRef: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  const latest = useRef(close);
  useLayoutEffect(() => {
    latest.current = close;
  });

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !open) return;
    const clear = () => {
      sheet.style.removeProperty("translate");
      sheet.style.removeProperty("transition");
    };
    // a reopen mid-close gets back the sheet a swipe let go of lower down
    clear();
    let drag: SheetDrag | null = null;
    let springTimer: ReturnType<typeof setTimeout> | undefined;
    const onStart = (e: TouchEvent) => {
      clearTimeout(springTimer);
      clear();
      drag = null;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || !(e.target instanceof Element)) return;
      if (swipeBlockedInput(e.target)) return;
      for (let node: Element | null = e.target; node && node !== sheet.parentElement; node = node.parentElement) {
        if (node.scrollTop > 0) return;
      }
      drag = { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, lastT: e.timeStamp, velocity: 0, pulling: false };
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!drag || !touch) return;
      const dx = touch.clientX - drag.x;
      const dy = touch.clientY - drag.y;
      if (!drag.pulling) {
        const axis = lockAxis(dx, dy);
        if (axis === "x" || (axis === "y" && dy < 0)) {
          drag = null;
          return;
        }
        drag.pulling = axis === "y";
        if (!drag.pulling) return;
      }
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.velocity = (touch.clientY - drag.lastY) / dt;
      drag.lastY = touch.clientY;
      drag.lastT = e.timeStamp;
      if (drag.pulling && !reducedMotion()) sheet.style.translate = `0 ${Math.max(0, dy)}px`;
    };
    const finish = (commit: boolean, e: TouchEvent) => {
      const done = drag;
      drag = null;
      if (!done?.pulling) return;
      // cancelling the touchend is what keeps a drag from ending in a click
      if (e.cancelable) e.preventDefault();
      // a finger that stopped before lifting is no flick
      const velocity = e.timeStamp - done.lastT > FLICK_STILL_MS ? 0 : done.velocity;
      if (commit && sheetSwipeCloses(done.lastY - done.y, velocity, sheet.offsetHeight)) {
        // the exit fade plays from where the finger let go
        latest.current();
        return;
      }
      if (reducedMotion()) return;
      sheet.style.transition = `translate ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`;
      sheet.style.translate = "0 0";
      springTimer = setTimeout(clear, SWIPE_MOTION_MS);
    };
    const onEnd = (e: TouchEvent) => finish(true, e);
    const onCancel = (e: TouchEvent) => finish(false, e);
    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd);
    sheet.addEventListener("touchcancel", onCancel);
    return () => {
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onCancel);
      clearTimeout(springTimer);
    };
  }, [sheetRef, open]);
}
