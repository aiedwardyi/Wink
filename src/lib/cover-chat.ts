import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { EASE_EXIT, EASE_STANDARD, MOTION_FAST_MS, MOTION_LARGE_MS, MOTION_MODERATE_MS } from "./motion";
import { reducedMotion } from "./phone-swipe";

const PANEL = 400;
// kept by hand: document.getAnimations() would flush style for the whole page
const sweeps = new WeakMap<HTMLElement, Animation[]>();

// only the ::before backdrop scales and the content fades, so nothing re-lays out mid-motion
function sweep(aside: HTMLElement, from: number, to: number, fade: "in" | "out") {
  const cancel = () => { for (const each of sweeps.get(aside) ?? []) each.cancel(); sweeps.delete(aside); };
  cancel();
  const kids = [...aside.children] as HTMLElement[];
  if (reducedMotion()) {
    if (fade === "in") sweeps.set(aside, kids.map((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST_MS, easing: EASE_STANDARD })));
    return Promise.resolve();
  }
  aside.dataset.coverMotion = "";
  const out = fade === "out";
  // a close only has the Presence exit to run in
  const layer = aside.animate([{ transform: `scaleX(${from})` }, { transform: `scaleX(${to})` }], {
    pseudoElement: "::before", duration: out ? MOTION_FAST_MS : MOTION_LARGE_MS, easing: out ? EASE_EXIT : EASE_STANDARD, fill: "forwards",
  });
  sweeps.set(aside, [layer, ...kids.map((el) => el.animate(out ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }], {
    duration: out ? MOTION_FAST_MS : MOTION_MODERATE_MS, delay: out ? 0 : MOTION_LARGE_MS - MOTION_MODERATE_MS, easing: out ? EASE_EXIT : EASE_STANDARD, fill: "both",
  }))]);
  return layer.finished.then(
    // a close keeps its end frame: undoing it would paint the whole panel once more before it unmounts
    () => { if (out) return; delete aside.dataset.coverMotion; cancel(); },
    () => undefined,
  );
}

/** Lays the panel over the chat by a negative margin, so the chat keeps its width and never re-lays out. */
export function useCoverChat(panel: RefObject<HTMLElement | null>, on: boolean, closing = false): CSSProperties | undefined {
  const [chat, setChat] = useState(0);
  const shown = useRef(0);
  const painted = useRef(false);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => { painted.current = true; });
    return () => cancelAnimationFrame(frame);
  }, []);
  useLayoutEffect(() => {
    // a closing panel gives the chat its column back; measuring that would widen the panel as it leaves
    if (closing) return;
    const before = panel.current?.previousElementSibling;
    if (!on || !(before instanceof HTMLElement) || before.matches("[data-phone-drawer]") || before.querySelector("[data-phone-drawer]")) { setChat(0); return; }
    const wide = window.matchMedia("(min-width: 48rem)");
    const measure = () => setChat(wide.matches ? before.offsetWidth : 0);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(before);
    return () => observer.disconnect();
  }, [on, panel, closing]);
  // painted over is not out of reach: the chat would still take Tab and screen reader focus.
  // It is hidden by one write once the sweep has covered it: inert or visibility would
  // restyle the whole chat, content-visibility skips it.
  useLayoutEffect(() => {
    const aside = panel.current;
    const before = aside?.previousElementSibling;
    const was = shown.current;
    shown.current = closing ? 0 : chat;
    if (!aside || !(before instanceof HTMLElement)) return;
    if (closing) {
      if (was) void sweep(aside, 1, 0, "out");
      return;
    }
    if (!chat) {
      if (was && painted.current) void sweep(aside, (PANEL + was) / PANEL, 1, "in");
      return;
    }
    let live = true;
    const hide = () => { if (live) before.style.contentVisibility = "hidden"; };
    if (was) hide();
    else void sweep(aside, painted.current ? PANEL / (PANEL + chat) : 0, 1, "in").then(hide);
    return () => { live = false; before.style.contentVisibility = ""; };
  }, [Boolean(chat), closing, panel]);
  if (!chat) return undefined;
  return closing ? { width: PANEL + chat, marginLeft: -(PANEL + chat), animation: "none" } : { width: PANEL + chat, marginLeft: -chat };
}
