// Captions are a device choice, on until switched off; the old key kept its "1" and "0".
import { useSyncExternalStore } from "react";

const KEY = "wink.liveCall.captions";

const watchers = new Set<() => void>();
// Only read while storage is unavailable.
let session = true;

export function callCaptions(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return session;
  }
}

export function setCallCaptions(next: boolean) {
  session = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* The choice still applies for this session. */
  }
  for (const fn of [...watchers]) fn();
}

export function useCallCaptions(): boolean {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => { watchers.delete(fn); };
    },
    callCaptions,
    callCaptions,
  );
}
