// The bell in each room: the rooms this device keeps quiet, by chat id (group id or `joined:<roomId>`).
import { useSyncExternalStore } from "react";

export const ROOM_ALERTS_OFF_KEY = "openmausbot.roomAlertsOff.v1";

const watchers = new Set<() => void>();
let cached: { raw: string | null; list: string[] } | null = null;

export function roomAlertsOff(): string[] {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(ROOM_ALERTS_OFF_KEY) ?? null;
  } catch {
    // Storage blocked: every room alerts.
  }
  if (cached?.raw === raw) return cached.list;
  let list: string[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((chat): chat is string => typeof chat === "string");
  } catch {
    // Corrupt: start over with every room on.
  }
  cached = { raw, list };
  return list;
}

export function setRoomAlerts(chat: string, on: boolean): void {
  const rest = roomAlertsOff().filter((each) => each !== chat);
  try {
    globalThis.localStorage?.setItem(ROOM_ALERTS_OFF_KEY, JSON.stringify(on ? rest : [...rest, chat]));
  } catch {
    return;
  }
  for (const watcher of [...watchers]) watcher();
}

const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

export function useRoomAlertsOn(chat: string): boolean {
  return !useSyncExternalStore(watch, roomAlertsOff).includes(chat);
}
