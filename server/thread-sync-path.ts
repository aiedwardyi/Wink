import type { DatabaseSync } from "node:sqlite";

import type { Message } from "./store.ts";
import type { SyncChange } from "./thread-sync-v2.ts";
import { redactToolMessage } from "./tool-detail.ts";

export function syncPathChanged(db: DatabaseSync, threadId: string, changes: SyncChange[]): boolean {
  if (!changes.some((change) => change.kind === "row" || change.kind === "head")) return false;
  const leaf = db.prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?").get(threadId)?.active_leaf_id ?? null;
  const head = changes.findLast((change) => change.kind === "head");
  if (head && head.value !== leaf) return true;
  const affected = new Set<string>();
  const prior = db.prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?");
  const child = db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND json_extract(json, '$.parentId') = ? LIMIT 1");
  for (const change of changes) {
    if (change.kind !== "row") continue;
    // SAFETY: The sync engine validates each row before adding a change page.
    const message = change.value as Message;
    const stored = prior.get(threadId, message.id);
    if (stored) {
      if (stored.json !== JSON.stringify(redactToolMessage(message))) affected.add(message.id);
    } else if (message.id === leaf || child.get(threadId, message.id)) {
      // A new row can repair a missing ancestor without moving the head.
      affected.add(message.id);
    }
  }
  if (!affected.size) return false;
  return Boolean(db.prepare(`WITH RECURSIVE active(id) AS (
    SELECT ?
    UNION SELECT json_extract(m.json, '$.parentId') FROM active a
      CROSS JOIN messages m ON m.thread_id = ? AND m.id = a.id
  ) SELECT 1 FROM active WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .get(leaf, threadId, JSON.stringify([...affected])));
}
