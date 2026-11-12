// A hosted room's parts of Media: the folder notice and the space used.
import { useSyncExternalStore } from "react";

import { formatSize } from "@/lib/composer-attachments";
import { useI18n } from "@/lib/i18n";
import type { RoomFile } from "@/lib/team-rooms";

/** The room's `/files` answer; a failed list has no sizes. */
export type RoomFiles = { files: RoomFile[]; used?: number; capacity?: number; error: string | null };

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${Number((bytes / 1024 ** 3).toFixed(2))} GB` : formatSize(bytes);

let removed = 0;
const watchers = new Set<() => void>();
const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

/** Counts deletes, so Media lists the room again after one. */
export const useRoomFilesRemoved = () => useSyncExternalStore(watch, () => removed);

export function roomFileRemoved() {
  removed++;
  for (const watcher of watchers) watcher();
}

export function RoomFilesNotice({ list }: { list: RoomFiles }) {
  const { t } = useI18n();
  return list.error ? <p role="alert" className="mb-2 px-2 pt-1 text-[12px] text-danger">{t("teamRoom.folderError")}</p> : null;
}

export function RoomMedia({ list }: { list: RoomFiles }) {
  const { t } = useI18n();
  return list.capacity !== undefined ? <p className="px-2 pb-1 pt-3 text-center text-[11.5px] tabular-nums text-ink-secondary">{t("teamRoom.filesUsed", { used: size(list.used ?? 0), total: size(list.capacity) })}</p> : null;
}
