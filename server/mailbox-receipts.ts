import { createHash } from "node:crypto";

export const MAILBOX_RECEIPT_LIMIT = 10_000;
export const MAILBOX_RECEIPT_WINDOW_MS = 7 * 86_400_000;
type Scope = { pane: string; bot: string; teacher: string };
type Accepted = { ok: true; id?: string; deferred?: boolean };
export type ReceiptRow = { key: string; id: string; at: number };

/** `rows` are the stored receipts newest first, found off the main thread (boot-reads.ts); keyed mail waits for them. */
export function createMailboxReceipts(rows: Promise<ReceiptRow[]>, now = Date.now) {
  const seen = new Map<string, { result: Accepted; at: number }>();
  const pending = new Map<string, Promise<Accepted>>();
  const loaded = rows.then((found) => {
    for (const row of found.toReversed()) seen.set(row.key, { result: { ok: true, id: row.id }, at: row.at });
  });
  const prune = () => {
    for (const [key, value] of seen) {
      if (seen.size <= MAILBOX_RECEIPT_LIMIT && value.at >= now() - MAILBOX_RECEIPT_WINDOW_MS) break;
      seen.delete(key);
    }
  };
  const accept = async (scope: Scope, messageId: string | undefined, write: (key?: string) => Promise<Accepted>, finishDeferred = false): Promise<Accepted> => {
    if (!messageId) return write();
    await loaded;
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
