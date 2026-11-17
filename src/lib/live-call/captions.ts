// Captions are a device choice, on until switched off; the old key kept its "1" and "0".
import { useSyncExternalStore } from "react";

const KEY = "wink.liveCall.captions";

const watchers = new Set<() => void>();
// Set only while the last write failed, so the choice still holds for this session.
let unsaved: boolean | undefined;

export function callCaptions(): boolean {
  if (unsaved !== undefined) return unsaved;
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setCallCaptions(next: boolean) {
  unsaved = undefined;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    unsaved = next;
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
