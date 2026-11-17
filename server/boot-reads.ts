// Boot finders that read most of messages.db run once in a worker after the first paint; main applies the ids by key.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { MAILBOX_RECEIPT_LIMIT, MAILBOX_RECEIPT_WINDOW_MS, type ReceiptRow } from "./mailbox-receipts.ts";

export interface BootReadInput {
  dataDir: string;
  now: number;
  /** Open chats plus the threads of asks still running at the last shutdown. */
  askThreads: string[];
  /** thread-sync-v2-cutover.json's cutoverAt, or null before a cutover. */
  cutoverAt: number | null;
  /** The tool names of a v1 notice and of any conflict notice. */
  notices: { migration: string; conflict: string[] };
}

export interface BootRows {
  receipts: ReceiptRow[];
  /** Saved sync tasks with a sync_v2_notices row: their v1 notices written since the cutover and never synced. */
  migration: Array<{ threadId: string; ids: string[] }>;
  /** Eligible saved tasks with a conflict change: conflict notices on their active path. */
  conflicts: Array<{ threadId: string; notices: string[] }>;
  asks: Array<{ threadId: string; id: string; at: number }>;
  peerCards: Array<{ threadId: string; id: string }>;
  handed: Array<{ threadId: string; id: string }>;
}

const EMPTY: BootRows = { receipts: [], migration: [], conflicts: [], asks: [], peerCards: [], handed: [] };

/** Runs in boot-reads-worker.ts on its own read-only handle; never call it on the thread that serves the app. */
export function findBootRows(input: BootReadInput): BootRows {
  const file = join(input.dataDir, "messages.db");
  if (!existsSync(file)) return EMPTY;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // SAFETY: sqlite_master's name column is text.
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    if (!tables.has("messages")) return EMPTY;
    // SAFETY: The query selects a text key and the message table's typed id and time.
    // Per thread through messages_thread_at: a scan of every row reads the whole transcript file on a cold boot.
    const receipts = db.prepare("SELECT json_extract(json, '$.mailbox.key') AS key, id, at FROM messages WHERE thread_id IN (SELECT DISTINCT thread_id FROM messages) AND at >= ? AND kind = 'note' AND json_type(json, '$.mailbox.key') = 'text' ORDER BY at DESC LIMIT ?")
      .all(input.now - MAILBOX_RECEIPT_WINDOW_MS, MAILBOX_RECEIPT_LIMIT) as ReceiptRow[];
    const synced = tables.has("sync_v2_store") && tables.has("sync_v2_notices") && tables.has("sync_v2_changes") && tables.has("sync_v2_snapshot");
    // SAFETY: Both task queries select sync_v2_store's text threadId.
    const migration = synced && input.cutoverAt !== null
      ? (db.prepare("SELECT s.threadId FROM sync_v2_store s JOIN sync_v2_notices n ON n.thread = s.threadId").all() as Array<{ threadId: string }>).map(({ threadId }) => ({
        threadId,
        // SAFETY: The query selects the message table's typed id.
        ids: (db.prepare(`SELECT id FROM messages m WHERE thread_id = ? AND at >= ? AND kind = 'activity'
          AND json_extract(json, '$.tool.name') = ?
          AND NOT EXISTS (SELECT 1 FROM sync_v2_snapshot s WHERE s.thread = m.thread_id AND s.row_id = m.id)`)
          .all(threadId, input.cutoverAt, input.notices.migration) as Array<{ id: string }>).map((row) => row.id),
      }))
      : [];
    const conflicts = synced
      ? (db.prepare(`SELECT s.threadId FROM sync_v2_store s WHERE s.eligible = 1 AND EXISTS (
          SELECT 1 FROM sync_v2_changes c WHERE c.thread = s.threadId AND c.conflict = 1 AND c.cursor <= s.cursor)`).all() as Array<{ threadId: string }>).map(({ threadId }) => ({
        threadId,
        // SAFETY: The query selects the message table's typed id.
        notices: (db.prepare(`WITH RECURSIVE path(id) AS (
          SELECT active_leaf_id FROM thread_state WHERE thread_id = ?
          UNION SELECT json_extract(m.json, '$.parentId') FROM messages m JOIN path ON m.id = path.id WHERE m.thread_id = ?
        ) SELECT m.id FROM path JOIN messages m ON m.id = path.id
          WHERE m.thread_id = ? AND json_extract(m.json, '$.tool.name') IN (SELECT value FROM json_each(?)) LIMIT 16`)
          .all(threadId, threadId, threadId, JSON.stringify(input.notices.conflict)) as Array<{ id: string }>).map((row) => row.id),
      }))
      : [];
    // SAFETY: Each query selects the message table's typed ids and time.
    const asks = input.askThreads.flatMap((threadId) => (db.prepare(`SELECT id, at FROM messages WHERE thread_id = ? AND role = 'user' AND kind = 'text'
      AND json_extract(json, '$.quick.state') = 'asked'
      AND id NOT IN (SELECT json_extract(json, '$.quick.askId') FROM messages WHERE thread_id = ? AND role = 'bot' AND kind = 'text'
        AND json_extract(json, '$.quick.askId') IS NOT NULL)`).all(threadId, threadId) as Array<{ id: string; at: number }>).map((row) => ({ threadId, ...row })));
    // SAFETY: Both queries select the message table's typed thread id and id.
    const peerCards = db.prepare(`SELECT thread_id AS threadId, id FROM messages WHERE kind = 'options'
      AND json_extract(json, '$.card.requestId') IS NOT NULL AND json_extract(json, '$.card.tool') IN ('ask_bot', 'delegate_bot')`).all() as BootRows["peerCards"];
    const handed = db.prepare("SELECT thread_id AS threadId, id FROM messages WHERE json_extract(json, '$.comm.read.state') = 'handed'").all() as BootRows["handed"];
    return { receipts, migration, conflicts, asks, peerCards, handed };
  } finally {
    db.close();
  }
}

let begin!: (input: BootReadInput) => Promise<void>;
let started: Promise<void> | undefined;
const rows = new Promise<BootRows>((resolve) => {
  begin = (input) => runWorker(input).then(resolve, (error: unknown) => {
    resolve(EMPTY);
    throw error;
  });
});

/** What the boot finders found; it settles only after startBootReads, and to empty rows when the worker failed. */
export function bootReads(): Promise<BootRows> {
  return rows;
}

/** Spawns the worker once; call it from startupTiming.afterPaint so the read never competes with the first page. */
export function startBootReads(input: BootReadInput): Promise<void> {
  return started ??= begin(input);
}

function runWorker(input: BootReadInput): Promise<BootRows> {
  const source = new URL("./boot-reads-worker.ts", import.meta.url);
  const entry = existsSync(source) ? source : new URL("./boot-reads-worker.js", import.meta.url);
  const worker = new Worker(entry, { workerData: input, execArgv: entry.pathname.endsWith(".ts") ? ["--experimental-strip-types"] : [] });
  worker.unref();
  return new Promise<BootRows>((resolve, reject) => {
    worker.once("message", (reply: { rows?: BootRows; error?: string }) => (reply.rows ? resolve(reply.rows) : reject(new Error(reply.error))));
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("the boot reads stopped before they finished")));
  });
}
