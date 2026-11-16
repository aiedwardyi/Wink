import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { BOTTOM_FOLLOW_THRESHOLD } from "./bottom-follow";

// viewports of scrollback loaded ahead of the reader, so a steady scroll up never waits at the top
const LEAD = "200%";

/** Runs `load` when the top row comes within a couple of viewports; a new `at` (rows landed) re-arms it.
 * A failed load leaves `at` as it was, so it never loops; the next try waits for the row to come back into range. */
export function useOlderOnScroll(scrollRef: RefObject<HTMLElement | null>, at: string, enabled: boolean, follow: boolean, load: () => void) {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const latest = useRef(load);
  useLayoutEffect(() => { latest.current = load; });
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !row || !enabled || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.at(-1)?.isIntersecting) return;
      // a short tail followed at the bottom is not reading back
      if (follow && root.scrollHeight - root.scrollTop - root.clientHeight < BOTTOM_FOLLOW_THRESHOLD) return;
      latest.current();
    }, { root, rootMargin: `${LEAD} 0px 0px 0px` });
    observer.observe(row);
    return () => observer.disconnect();
  }, [scrollRef, row, enabled, follow, at]);
  return setRow;
}
