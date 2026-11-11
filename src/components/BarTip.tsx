import { useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "@/lib/tooltip-position";
import { PLAIN_TOOLTIP_CLASS } from "@/lib/tooltips";

/** The tip floats over the panel, so opening it never grows the scroll area. */
export function useBarTip() {
  const [tip, setTip] = useState<{ text: string; anchor: DOMRect } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tip) return;
    const close = () => setTip(null);
    document.addEventListener("scroll", close, true);
    return () => document.removeEventListener("scroll", close, true);
  }, [tip]);
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const box = placeTooltip({ anchor: tip.anchor, size: el.getBoundingClientRect(), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    el.style.top = `${box.top}px`;
    el.style.left = `${box.left}px`;
    el.style.visibility = "visible";
  }, [tip]);
  const open = (text: string) => (event: SyntheticEvent<HTMLElement>) => setTip({ text, anchor: event.currentTarget.getBoundingClientRect() });
  const close = () => setTip(null);
  const props = (text: string) => ({ onMouseEnter: open(text), onMouseLeave: close, onFocus: open(text), onBlur: close, onClick: open(text) });
  const node = tip && createPortal(
    <div ref={tipRef} data-bar-tip="" role="tooltip" className={PLAIN_TOOLTIP_CLASS} style={{ top: 0, left: 0, visibility: "hidden" }}>
      {tip.text}
    </div>,
    document.body,
  );
  return { props, node };
}
