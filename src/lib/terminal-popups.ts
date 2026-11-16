import { useSyncExternalStore } from "react";
import { trackSetting } from "./usage-stats";

export const TERMINAL_POPUPS_KEY = "omb-terminal-popups";
const watchers = new Set<() => void>();

function readTerminalPopups(): boolean {
  try {
    return localStorage.getItem(TERMINAL_POPUPS_KEY) === "on";
  } catch {
    return false;
  }
}

let on = readTerminalPopups();

export function terminalPopupsEnabled(): boolean {
  return on;
}

export function saveTerminalPopups(value: boolean): void {
  trackSetting("terminalAlerts", on ? "on" : "off", value ? "on" : "off", "settings", TERMINAL_POPUPS_KEY);
  on = value;
  try {
    localStorage.setItem(TERMINAL_POPUPS_KEY, value ? "on" : "off");
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export function useTerminalPopups(): boolean {
  return useSyncExternalStore(subscribe, terminalPopupsEnabled, terminalPopupsEnabled);
}
