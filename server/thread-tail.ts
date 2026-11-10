// A chat list page needs only a thread's newest rows; parsing its whole history first is most of a cold open.
import { messageDatabase, rowToMessage, type ThreadRows } from "./message-db.ts";

/** Newest `limit` rows plus the one before them, or null when only a full load gives the same page. */
export function readThreadTail(threadId: string, limit: number): ThreadRows | null {
  const database = messageDatabase();
  const rows = database
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?")
    .all(threadId, limit + 1) as Array<{ json: string }>;
  // no rows may still be a legacy JSON thread, which only readThread imports
  if (!rows.length) return null;
  const messages = rows.reverse().map(rowToMessage);
  // Same chaining as Store.thread; a row with an unknown parent is never sent.
  let prev: string | null | undefined = rows.length > limit ? undefined : null;
  for (const message of messages) {
    if (message.parentId === undefined && prev !== undefined) message.parentId = prev;
    prev = message.id;
  }
  const state = database
    .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
    .get(threadId) as { active_leaf_id: string | null } | undefined;
  const activeLeafId = state?.active_leaf_id || messages.at(-1)!.id;
  // a leaf on an old branch can sit anywhere in the thread
  return messages.some((message) => message.id === activeLeafId) ? { messages, activeLeafId } : null;
}
