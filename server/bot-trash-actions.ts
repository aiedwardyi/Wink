// Recently deleted, as the server offers it: the list, Delete, Restore, Empty now and the 30-day timer.
import { restoreBot, trashBot, type TrashSyncHost } from "./bot-trash-sync.ts";
import type { BotRecord } from "./store.ts";

const DAY = 86_400_000;
export const TRASH_KEEP_MS = 30 * DAY;

export interface TrashedBot extends Pick<BotRecord, "id" | "name" | "color" | "mascotStyle" | "avatarUrl" | "avatarCrop"> {
  daysLeft: number;
}

/** Whole days left, rounded up, never below 1. */
export const trashDaysLeft = (arrivedAt: number, now: number) => Math.max(1, Math.ceil((arrivedAt + TRASH_KEEP_MS - now) / DAY));

export function createBotTrashActions(deps: {
  host: () => TrashSyncHost;
  /** Empty now writes the permanent delete through the same queue Delete used. */
  queueDeletes: (syncIds: string[]) => void;
  /** True while sync is on and has not finished a pass in this run: the timer waits so a Restore elsewhere wins. */
  awaitingSync: () => boolean;
}) {
  const trashed = () => deps.host().store.trash.entries.filter((entry) => entry.step === "trashed");
  return {
    list(): TrashedBot[] {
      const now = deps.host().now();
      return trashed()
        .sort((left, right) => right.arrivedAt - left.arrivedAt)
        .map(({ record, arrivedAt }) => ({
          id: record.id, name: record.name, color: record.color, mascotStyle: record.mascotStyle,
          avatarUrl: record.avatarUrl, avatarCrop: record.avatarCrop, daysLeft: trashDaysLeft(arrivedAt, now),
        }));
    },
    trash: (botId: string) => trashBot(deps.host(), botId),
    restore: (botId: string): BotRecord => restoreBot(deps.host(), botId),
    emptyNow(botIds?: readonly string[]): number {
      const host = deps.host();
      const entries = trashed().filter((entry) => !botIds || botIds.includes(entry.record.id));
      if (!entries.length) return 0;
      const botMap = host.settings().botMap;
      const syncIds = entries.flatMap((entry) => {
        const syncId = entry.syncId ?? botMap[entry.record.id];
        return syncId ? [syncId] : [];
      });
      host.trash.empty(entries.map((entry) => entry.record.id), { tellOthers: true });
      if (syncIds.length) deps.queueDeletes(syncIds);
      return entries.length;
    },
    emptyExpired(): number {
      if (deps.awaitingSync()) return 0;
      const host = deps.host();
      const now = host.now();
      const ids = trashed().filter((entry) => now - entry.arrivedAt >= TRASH_KEEP_MS).map((entry) => entry.record.id);
      if (ids.length) host.trash.empty(ids, { tellOthers: false });
      return ids.length;
    },
  };
}

export type BotTrashActions = ReturnType<typeof createBotTrashActions>;
