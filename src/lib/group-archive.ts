// A shared group's older task, open to read only. The group itself stays on its shared thread.
import { useSyncExternalStore } from "react";

import type { Action, Group, Message } from "@/state/store-types";

export interface GroupArchive {
  groupId: string;
  threadId: string;
  messages: Message[];
}

let archive: GroupArchive | null = null;
const watchers = new Set<() => void>();

function set(next: GroupArchive | null) {
  if (next === archive) return;
  archive = next;
  for (const watcher of [...watchers]) watcher();
}

const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

/** A task the server opened: a shared group's goes here, any other group switches to it. */
export function showGroupTask(view: Group, dispatch: (action: Action) => void): void {
  if (view.hosted) set({ groupId: view.id, threadId: view.threadId, messages: view.messages ?? [] });
  else dispatch({ type: "groupPatched", group: view });
}

export const closeGroupArchive = () => set(null);

export function useGroupArchive(groupId: string): GroupArchive | null {
  const open = useSyncExternalStore(watch, () => archive);
  return open?.groupId === groupId ? open : null;
}
