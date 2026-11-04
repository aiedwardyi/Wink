// Numbers and lines ease; they never jump. Reduced motion snaps.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { reducedMotion } from "@/lib/phone-swipe";

export function useEased(target: number, ms = 650): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (reducedMotion() || Math.abs(current.current - target) < 0.001) {
      current.current = target;
      setValue(target);
      return;
    }
    const from = current.current;
    const start = performance.now();
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (performance.now() - start) / ms);
      const next = from + (target - from) * (1 - (1 - p) ** 3);
      current.current = next;
      setValue(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(Math.floor(node.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Advance of one mono glyph in this element's font (braille and box glyphs share it). */
export function useCharWidth<T extends HTMLElement>(ref: React.RefObject<T | null>, fallback = 7.8) {
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(40);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    node.append(probe);
    const measured = probe.getBoundingClientRect().width / 40;
    probe.remove();
    if (measured > 0) setW(measured);
  }, [ref]);
  return w;
}
