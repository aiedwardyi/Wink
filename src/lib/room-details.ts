// Which section Room details opens at: the header faces land on Bots or People.
import { useSyncExternalStore } from "react";

import type { Action } from "@/state/store";

export type RoomDetailsSection = "people" | "bots" | "room";

interface RoomDetailsTarget {
  section: RoomDetailsSection;
  nonce: number;
}

let target: RoomDetailsTarget = { section: "people", nonce: 0 };
const watchers = new Set<() => void>();
const subscribe = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

export function openRoomDetails(dispatch: (action: Action) => void, section: RoomDetailsSection = "people") {
  target = { section, nonce: target.nonce + 1 };
  for (const watcher of watchers) watcher();
  dispatch({ type: "toggleSettings", open: true });
}

export const useRoomDetailsTarget = () => useSyncExternalStore(subscribe, () => target);
