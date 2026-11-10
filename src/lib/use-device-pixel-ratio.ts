import { useSyncExternalStore } from "react";

const ratio = () => window.devicePixelRatio || 1;

function subscribe(changed: () => void) {
  const off = new AbortController();
  // A resolution query fires once, when the ratio leaves it, so each change watches the new ratio.
  const watch = (now = ratio()) => window.matchMedia?.(`(resolution: ${now}dppx)`).addEventListener?.("change", () => {
    if (ratio() === now) return;
    watch();
    changed();
  }, { once: true, signal: off.signal });
  watch();
  return () => off.abort();
}

/** Device pixels per CSS pixel, updated on zoom and on a move to another display. */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, ratio, () => 1);
}
