import { useEffect } from "react";

export type HoldMenu = {
  open: (pressed: HTMLElement, x: number, y: number) => boolean;
  close: () => void;
};

const touchGuards = new WeakMap<Document, () => void>();

function swallow(event: Event) {
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

// The closing menu can unmount before this touch ends and sends its compatibility click.
export function guardMenuTouch(doc: Document, released = false): () => void {
  touchGuards.get(doc)?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    for (const name of ["pointerdown", "touchstart"]) doc.removeEventListener(name, start, true);
    for (const name of ["pointerup", "pointercancel", "touchend", "touchcancel"]) doc.removeEventListener(name, end, true);
    for (const name of ["pointermove", "touchmove", "mousedown", "mouseup", "click", "contextmenu"]) doc.removeEventListener(name, swallow, true);
    doc.defaultView?.removeEventListener("blur", cleanup);
    if (touchGuards.get(doc) === cleanup) touchGuards.delete(doc);
  };
  const start = (event: Event) => {
    if (released) cleanup();
    else swallow(event);
  };
  const end = (event: Event) => {
    swallow(event);
    released = true;
    clearTimeout(timer);
    timer = setTimeout(cleanup, 1000);
  };
  for (const name of ["pointerdown", "touchstart"]) doc.addEventListener(name, start, { capture: true, passive: false });
  for (const name of ["pointerup", "pointercancel", "touchend", "touchcancel"]) doc.addEventListener(name, end, { capture: true, passive: false });
  for (const name of ["pointermove", "touchmove", "mousedown", "mouseup", "click", "contextmenu"]) doc.addEventListener(name, swallow, { capture: true, passive: false });
  doc.defaultView?.addEventListener("blur", cleanup);
  if (released) timer = setTimeout(cleanup, 1000);
  touchGuards.set(doc, cleanup);
  return cleanup;
}

export function useListMenuDismiss(selector: string, closing: boolean, onClose: () => void) {
  useEffect(() => {
    if (closing) return;
    const outside = (event: Event) => !(event.target instanceof Element) || !event.target.closest(selector);
    const onTouch = (event: Event) => {
      if (!outside(event)) return;
      guardMenuTouch(document);
      swallow(event);
      onClose();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") onTouch(event);
    };
    const onDown = (event: MouseEvent) => {
      if (outside(event)) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("touchstart", onTouch, { capture: true, passive: false });
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onClose, { capture: true, passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("touchstart", onTouch, true);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [selector, closing, onClose]);
}
