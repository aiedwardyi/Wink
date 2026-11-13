// Room threads ride chat sync v2 under the scope `room-<groupId>`, with the
// room's own thread ids. Bot ids inside rows travel as sync ids. Team rooms
// stay on their host.
import { applySyncedRows, withMessageTransaction } from "./message-db.ts";
import { localIdForSyncId } from "./profile-sync.ts";
import { UNTITLED_TASK, type GroupRecord, type Message, type Store, type StoreChange } from "./store.ts";
import type { SyncChange } from "./thread-sync-v2.ts";

const ROOM_SCOPE = "room-";

export const isRoomScope = (scope: string) => scope.startsWith(ROOM_SCOPE);

export interface RoomThreadsHost {
  store: Store;
  botMap(): Record<string, string>;
  /** Mints one for a live bot that has none yet. */
  syncId(botId: string): string;
  /** A peer's delete landed: the room may show another task, and its tombstone can go now. */
  deleted?(groupId: string): void;
}

export type RoomThreads = ReturnType<typeof createRoomThreads>;

const target = (group: GroupRecord) => ({ botId: group.id, botSyncId: `${ROOM_SCOPE}${group.id}` });

function mapRow(message: Message, map: (botId: string) => string | undefined): Message {
  const next = { ...message };
  const from = message.from && map(message.from.botId);
  if (from) next.from = { ...message.from!, botId: from };
  const withBot = message.comm && map(message.comm.withBotId);
  if (withBot) next.comm = { ...message.comm!, withBotId: withBot };
  const request = message.card?.routineRequest;
  const requestBot = request && map(request.botId);
  if (requestBot) next.card = { ...message.card!, routineRequest: { ...request!, botId: requestBot } };
  if (message.reactions) next.reactions = message.reactions.map((reaction) => ({ ...reaction, by: reaction.by === "user" ? "user" : map(reaction.by) ?? reaction.by }));
  return next;
}

function threadIds(group: GroupRecord): string[] {
  return [...new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])];
}

export function createRoomThreads(host: RoomThreadsHost) {
  const { store } = host;
  const room = (groupId: string) => {
    const group = store.group(groupId);
    return group && !group.hosted ? group : undefined;
  };

  function task(groupId: string, threadId: string): { title: string; createdAt: number } | undefined {
    const group = room(groupId);
    if (!group) return undefined;
    if (group.dm) return group.threadId === threadId ? { title: UNTITLED_TASK, createdAt: group.createdAt } : undefined;
    return store.groupTaskByThread(groupId, threadId);
  }

  /** A room another PC wrote to; a new task joins the list and the active task stays. */
  function apply(groupId: string, threadId: string, changes: SyncChange[]): void {
    const group = room(groupId);
    if (!group || !changes.length || (group.dm && group.threadId !== threadId)) return;
    store.applySyncImport(() => {
      if (changes.some((change) => change.kind === "delete")) {
        if (!threadIds(group).includes(threadId)) return;
        // the last thread empties here; the room goes with its tombstone
        if (!group.dm && group.tasks!.length > 1) store.deleteGroupTask(groupId, threadId);
        else store.deleteThreadRecord(threadId);
        host.deleted?.(groupId);
        return;
      }
      let record = group.dm ? undefined : store.groupTaskByThread(groupId, threadId);
      if (!group.dm && !record) {
        record = { threadId, title: UNTITLED_TASK, createdAt: 0 };
        group.tasks = [...(group.tasks ?? []), record];
      }
      const events: StoreChange[] = [];
      withMessageTransaction((db) => {
        for (const change of changes) {
          if (change.kind === "metadata" && record) {
            // SAFETY: The sync engine validates metadata before adding a change page.
            const metadata = change.value as { title: string; createdAt: number };
            record.title = metadata.title;
            record.createdAt = metadata.createdAt;
          } else if (change.kind === "row") {
            // SAFETY: The sync engine validates each row before adding a change page.
            const message = structuredClone(change.value as Message);
            const exists = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id = ?").get(threadId, message.id);
            if (!applySyncedRows(threadId, [message], undefined, db)) continue;
            events.push(exists ? { type: "message.patch", threadId, message } : { type: "message", threadId, message, imported: true });
          } else if (change.kind === "head") {
            // SAFETY: The sync engine accepts only a string or null for branch heads.
            const leaf = change.value as string | null;
            applySyncedRows(threadId, [], leaf, db);
            if (leaf) events.push({ type: "thread", threadId, activeLeafId: leaf });
          }
        }
      });
      group.tasks?.sort((a, b) => b.createdAt - a.createdAt);
      store.syncedGroupThread(groupId, threadId);
      for (const event of events) store.emit(event);
    });
  }

  return {
    target(threadId: string) {
      const group = store.groupByThread(threadId);
      return group && !group.hosted ? target(group) : null;
    },
    scopes: () => store.groups.filter((group) => !group.hosted).map(target),
    owns: (groupId: string) => Boolean(room(groupId)),
    task,
    apply,
    /** A deleted bot has no sync id to give and keeps its local one. */
    outgoing: (message: Message) => mapRow(message, (botId) => store.bot(botId) ? host.syncId(botId) : undefined),
    incoming: (message: Message) => mapRow(message, (syncId) => localIdForSyncId(host.botMap(), syncId)),
  };
}
