import type { DatabaseSync } from "node:sqlite";

export function syncPathStamp(db: DatabaseSync, threadId: string): string {
  return JSON.stringify(db.prepare(`WITH RECURSIVE active(id) AS (
    SELECT active_leaf_id FROM thread_state WHERE thread_id = ?
    UNION SELECT json_extract(m.json, '$.parentId') FROM active a
      JOIN messages m ON m.thread_id = ? AND m.id = a.id
  ) SELECT a.id, m.json FROM active a
    LEFT JOIN messages m ON m.thread_id = ? AND m.id = a.id ORDER BY a.id`)
    .all(threadId, threadId, threadId));
}
