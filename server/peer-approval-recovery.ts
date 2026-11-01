import { messageDatabase } from "./message-db.ts";
import type { Message } from "./store.ts";

export function stalePeerThreads(threadIds: string[], pending: (requestId: string) => boolean): Set<string> {
  const threads = new Set<string>();
  if (!threadIds.length) return threads;
  const rows = messageDatabase().prepare(`
    SELECT thread_id AS threadId, json_extract(json, '$.card') AS card
    FROM messages
    WHERE thread_id IN (SELECT value FROM json_each(?))
      AND json_extract(json, '$.card.tool') IN ('ask_bot', 'delegate_bot')
    ORDER BY rowid
  `).all(JSON.stringify(threadIds));
  for (const row of rows) {
    const card = JSON.parse(String(row.card)) as NonNullable<Message["card"]>;
    // SQLite truth tests coerce strings and containers differently from JavaScript.
    if (card.requestId && !card.answered && !card.dismissed && !pending(card.requestId)) {
      threads.add(String(row.threadId));
    }
  }
  return threads;
}
