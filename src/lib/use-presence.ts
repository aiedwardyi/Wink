import { useEffect, useRef, useState, type ReactNode } from "react";

import { MOTION_FAST_MS } from "./motion";
import { reducedMotion } from "./phone-swipe";

// the [data-closing] exit in motion.css runs on --motion-fast
export const PRESENCE_EXIT_MS = MOTION_FAST_MS;

export type Presence<T> = { mounted: boolean; closing: boolean; value: T };

/** Keeps a closed surface mounted, marked closing, for its exit fade; `value` holds the last open one until it unmounts. */
export function usePresence<T>(when: T, exitMs = PRESENCE_EXIT_MS): Presence<T> {
  const open = Boolean(when);
  const [shown, setShown] = useState(open);
  const last = useRef(when);
  if (open) last.current = when;
  if (open && !shown) setShown(true);
  if (!open && shown && reducedMotion()) setShown(false);
  useEffect(() => {
    if (open || !shown) return;
    const timer = setTimeout(() => setShown(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, shown, exitMs]);
  return { mounted: open || shown, closing: !open && shown, value: open || !shown ? when : last.current };
}

export function Presence({ open, children }: { open: boolean; children: (closing: boolean) => ReactNode }) {
  const { mounted, closing } = usePresence(open);
  return mounted ? children(closing) : null;
}
