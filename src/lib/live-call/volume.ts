// Call volume belongs to the device, not the bot: a phone held to the ear wants less than desk speakers.
import { useSyncExternalStore } from "react";

const KEY = "omb-call-volume";
export const CALL_VOLUME = { min: 0.1, max: 1, step: 0.05 } as const;

const watchers = new Set<() => void>();
let volume = read();

function read(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return saved >= CALL_VOLUME.min && saved <= CALL_VOLUME.max ? saved : 1;
  } catch {
    return 1;
  }
}

export function callVolume(): number {
  return volume;
}

export function setCallVolume(next: number) {
  volume = Math.min(CALL_VOLUME.max, Math.max(CALL_VOLUME.min, next));
  try {
    localStorage.setItem(KEY, String(volume));
  } catch {
    /* The level still applies for this session. */
  }
  for (const fn of [...watchers]) fn();
}

export function useCallVolume(): number {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => { watchers.delete(fn); };
    },
    callVolume,
    callVolume,
  );
}
