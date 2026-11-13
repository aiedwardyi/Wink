// Boot recovery's view of a thread's quick asks, read in SQLite so the transcript is not loaded.
import { lastMessageAt, messageDatabase } from "./message-db.ts";
import type { Message } from "./store.ts";

type QuickRow = Pick<Message, "id" | "quick">;

/** Asks that no answer row names. */
export function unansweredAsks(rows: readonly QuickRow[]): Set<string> {
  const answered = new Set(rows.map((row) => row.quick?.askId));
  return new Set(rows.filter((row) => row.quick?.state === "asked" && !answered.has(row.id)).map((row) => row.id));
}

/** The same from the stored rows, or null when the thread has none here (a legacy file imports on load). */
export function storedUnansweredAsks(threadId: string): Set<string> | null {
  // Asks and answers are only ever text rows, and JSON.stringify always writes the key as "quick":.
  // SAFETY: This SELECT list is the row id and two json_extract values, TEXT or NULL.
  const rows = messageDatabase().prepare(
    "SELECT id, json_extract(json, '$.quick.state') AS state, json_extract(json, '$.quick.askId') AS askId FROM messages " +
      "WHERE thread_id = ? AND kind = 'text' AND instr(json, '\"quick\":') > 0",
  ).all(threadId) as Array<{ id: string; state: NonNullable<Message["quick"]>["state"]; askId: string | null }>;
  if (!rows.length && lastMessageAt(threadId) === null) return null;
  return unansweredAsks(rows.map(({ id, state, askId }) => ({ id, quick: { state, askId: askId ?? undefined } })));
}
