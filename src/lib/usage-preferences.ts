import { useSyncExternalStore } from "react";

export type UsageMode = "used" | "remaining";
const KEY = "omb-usage-mode";
const watchers = new Set<() => void>();

function readUsageMode(): UsageMode {
  try {
    return localStorage.getItem(KEY) === "used" ? "used" : "remaining";
  } catch {
    return "remaining";
  }
}

let mode = readUsageMode();

export function setUsageMode(value: UsageMode) {
  mode = value;
  try { localStorage.setItem(KEY, value); } catch { /* Keep the session choice. */ }
  watchers.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export function useUsageMode() {
  return useSyncExternalStore(subscribe, () => mode, () => mode);
}
