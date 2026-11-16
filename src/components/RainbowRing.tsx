import { useLayoutEffect, useRef } from "react";

// An absolute child sits on the frame's padding box; the inset reaches out over each skin's border.
export function RainbowRing({ theme }: { theme: boolean }) {
  const ring = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ring.current;
    const frame = el?.parentElement;
    if (!el || !frame) return;
    const fit = () => {
      const s = getComputedStyle(frame);
      el.style.inset = `-${s.borderTopWidth} -${s.borderRightWidth} -${s.borderBottomWidth} -${s.borderLeftWidth}`;
    };
    fit();
    const appearance = new MutationObserver(fit);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-shape"] });
    return () => appearance.disconnect();
  }, []);
  return (
    <span ref={ring} aria-hidden data-orbit-rainbow={theme ? "theme" : ""}>
      <span />
    </span>
  );
}
