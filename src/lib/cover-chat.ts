import { useLayoutEffect, useState, type RefObject } from "react";

// marginLeft cancels the closing slide's column handback: a cover holds no column
type Cover = { left: number; right: number; marginLeft: 0 };

/** Left and right insets that lay an aside over the chat area, beside the sidebar on either edge. */
export function useCoverChat(panel: RefObject<HTMLElement | null>, on: boolean, closing = false): Cover | undefined {
  const [inset, setInset] = useState<Cover>();
  useLayoutEffect(() => {
    const shell = panel.current?.parentElement;
    if (!on || !shell) { setInset(undefined); return; }
    const side = shell.querySelector<HTMLElement>("[data-phone-drawer]");
    const wide = window.matchMedia("(min-width: 48rem)");
    const measure = () => {
      if (!wide.matches) { setInset(undefined); return; }
      const box = shell.getBoundingClientRect();
      const bar = side?.getBoundingClientRect();
      if (!bar?.width) setInset({ left: 0, right: 0, marginLeft: 0 });
      else if (bar.left - box.left < box.right - bar.right) setInset({ left: bar.right - box.left, right: 0, marginLeft: 0 });
      else setInset({ left: 0, right: box.right - bar.left, marginLeft: 0 });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    if (side) observer.observe(side);
    measure();
    return () => observer.disconnect();
  }, [on, panel]);
  // painted over is not out of reach: the chat would still take Tab and screen reader focus
  useLayoutEffect(() => {
    const chat = panel.current?.previousElementSibling;
    if (!inset || closing || !(chat instanceof HTMLElement) || chat.matches("[data-phone-drawer]") || chat.querySelector("[data-phone-drawer]")) return;
    chat.inert = true;
    chat.style.visibility = "hidden";
    return () => { chat.inert = false; chat.style.visibility = ""; };
  }, [inset, closing, panel]);
  return inset;
}
