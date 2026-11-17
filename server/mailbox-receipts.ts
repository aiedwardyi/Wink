import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { messageDatabase } from "./message-db.ts";

export const MAILBOX_RECEIPT_LIMIT = 10_000;
const WEEK = 7 * 86_400_000;
type Scope = { pane: string; bot: string; teacher: string };
type Accepted = { ok: true; id?: string; deferred?: boolean };

export function createMailboxReceipts(database: () => DatabaseSync = messageDatabase, now = Date.now) {
  const seen = new Map<string, { result: Accepted; at: number }>();
  const pending = new Map<string, Promise<Accepted>>();
  // SAFETY: The query selects a text key and the message table's typed id and time.
  // Per thread through messages_thread_at: a scan of every row reads the whole transcript file on a cold boot.
  const rows = database().prepare("SELECT json_extract(json, '$.mailbox.key') AS key, id, at FROM messages WHERE thread_id IN (SELECT DISTINCT thread_id FROM messages) AND at >= ? AND kind = 'note' AND json_type(json, '$.mailbox.key') = 'text' ORDER BY at DESC LIMIT ?").all(now() - WEEK, MAILBOX_RECEIPT_LIMIT) as Array<{ key: string; id: string; at: number }>;
  for (const row of rows.toReversed()) seen.set(row.key, { result: { ok: true, id: row.id }, at: row.at });
  const prune = () => {
    for (const [key, value] of seen) {
      if (seen.size <= MAILBOX_RECEIPT_LIMIT && value.at >= now() - WEEK) break;
      seen.delete(key);
    }
  };
  const accept = async (scope: Scope, messageId: string | undefined, write: (key?: string) => Promise<Accepted>, finishDeferred = false): Promise<Accepted> => {
    if (!messageId) return write();
    prune();
    const key = createHash("sha256").update(`${scope.pane}:${scope.bot}:${scope.teacher}:${messageId}`).digest("hex");
    const inflight = pending.get(key);
    if (inflight) {
      const result = await inflight;
      return finishDeferred && result.deferred ? accept(scope, messageId, write, true) : result;
    }
    const existing = seen.get(key);
    if (existing && !(finishDeferred && existing.result.deferred)) return existing.result;
    const accepting = (async () => {
      try {
        const result = await write(key);
        seen.delete(key);
        seen.set(key, { result, at: now() });
        prune();
        return result;
      } finally { pending.delete(key); }
    })();
    pending.set(key, accepting);
    return accepting;
  };
  return { accept };
}
