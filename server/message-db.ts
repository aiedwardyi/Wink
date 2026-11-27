// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { termVerb } from "../shared/tool-verb.ts";

import { DATA_DIR } from "./config.ts";
import type { Message } from "./store.ts";
import { redactToolMessage } from "./tool-detail.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;
let opened = 0;
// never cleared: a thread deleted and re-created can reuse its rowids, so only this count tells the two apart
const changes = new Map<string, number>();
let transactionKeys = 0;
const changeListeners = new Set<(threadId: string, id: string, deleted: boolean) => void>();

function open(): DatabaseSync {
  const file = DB_FILE();
  // Transcripts can contain private conversations and tool output. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask.
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS messages_thread_at ON messages(thread_id, at);
    CREATE INDEX IF NOT EXISTS messages_options ON messages(thread_id) WHERE kind = 'options';
    CREATE INDEX IF NOT EXISTS messages_handed ON messages(thread_id) WHERE json_extract(json, '$.comm.read.state') = 'handed';
    CREATE INDEX IF NOT EXISTS messages_parent ON messages(thread_id, json_extract(json, '$.parentId'));
    CREATE INDEX IF NOT EXISTS messages_bot_text_at ON messages(at) WHERE role = 'bot' AND kind = 'text';
    CREATE INDEX IF NOT EXISTS messages_bot_engine ON messages(thread_id, json_extract(json, '$.from.botId'), json_extract(json, '$.engine')) WHERE role = 'bot' AND kind = 'text';
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
  `);
  db.function("message_changed", (threadId, id, deleted) => {
    changes.set(String(threadId), (changes.get(String(threadId)) ?? 0) + 1);
    for (const listener of changeListeners) listener(String(threadId), String(id), deleted === 1);
    return null;
  });
  // An insert raises its thread's newest rowid; an insert trigger would slow a 237k-row import from 1.6 to 4.5 s.
  db.exec(`
    CREATE TEMP TRIGGER message_updated AFTER UPDATE ON main.messages BEGIN
      SELECT message_changed(old.thread_id, old.id, 0);
      SELECT message_changed(new.thread_id, new.id, 0) WHERE new.thread_id IS NOT old.thread_id OR new.id IS NOT old.id;
    END;
    CREATE TEMP TRIGGER message_deleted AFTER DELETE ON main.messages BEGIN SELECT message_changed(old.thread_id, old.id, 1); END;
  `);
  opened++;
  return db;
}

/** Calls `listener` inside each statement on this process's handle that updates or deletes a row (`deleted` for a delete), so one that throws fails the write. */
export function onMessageChange(listener: (threadId: string, id: string, deleted: boolean) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

export { db as messageDatabase, DB_FILE as messageDbFile };

/** Its own read-only handle, for the backup worker: no import, no schema change, no write. */
export function openThreadExport(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  const rows = database.prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid");
  const leaf = database.prepare("SELECT active_leaf_id AS id FROM thread_state WHERE thread_id = ?");
  return {
    threadIds: () => (database.prepare("SELECT DISTINCT thread_id AS id FROM messages").all() as Array<{ id: string }>).map((row) => row.id),
    rows: (threadId: string) => rows.iterate(threadId) as Iterable<{ json: string }>,
    activeLeafId: (threadId: string) => (leaf.get(threadId) as { id: string | null } | undefined)?.id ?? null,
    close: () => database.close(),
  };
}

export function rowToMessage(row: { json: string }): Message {
  // SAFETY: Stored rows use the Message envelope; preview fields are scrubbed on every read.
  return redactToolMessage(JSON.parse(row.json) as Message);
}

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch; `chars` is the rows' stored JSON size, which the thread cache weighs. */
export function readThread(threadId: string, legacyFile: string): ThreadRows & { chars: number } {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null, chars: rows.reduce((sum, row) => sum + row.json.length, 0) };
  }
  const legacy = importLegacy(threadId, legacyFile);
  return { ...legacy, chars: legacy.messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0) };
}

/** The head Store.thread() would pick without loading the thread, or undefined when it has no rows here; `kept`, while that row exists, stands in for the newest row when no head is stored. */
export function storedHead(threadId: string, kept?: string | null): string | null | undefined {
  // SAFETY: Each subquery selects one TEXT column, or NULL when it finds no row.
  const row = db().prepare(
    "SELECT (SELECT active_leaf_id FROM thread_state WHERE thread_id = ?1) AS leaf, " +
      "(SELECT id FROM messages WHERE thread_id = ?1 AND id = ?2) AS kept, " +
      "(SELECT id FROM messages WHERE thread_id = ?1 ORDER BY rowid DESC LIMIT 1) AS last",
  ).get(threadId, kept ?? null) as { leaf: string | null; kept: string | null; last: string | null };
  return row.last === null ? undefined : row.leaf || row.kept || row.last;
}

/** A key that moves with every committed change to a thread's rows, or undefined when it has no rows here; key cached reads of a thread on it. */
export function threadVersion(threadId: string): string | undefined {
  // SAFETY: MAX(rowid) returns one integer row, NULL for no rows.
  const row = db().prepare("SELECT MAX(rowid) AS cursor FROM messages WHERE thread_id = ?").get(threadId) as { cursor: number | null };
  if (row.cursor === null) return undefined;
  // other handles see none of an open transaction's writes, so a read keyed inside one must match no key after it ends
  if (db().isTransaction) return `open:${++transactionKeys}`;
  // SAFETY: PRAGMA data_version returns one integer row; it moves when another connection commits.
  const other = db().prepare("PRAGMA data_version").get() as { data_version: number };
  return `${opened}:${other.data_version}:${row.cursor}:${changes.get(threadId) ?? 0}`;
}

/** Whether a thread has more than `cap` rows; counts at most cap + 1 index entries. */
export function threadOver(threadId: string, cap: number): boolean {
  // SAFETY: COUNT(*) returns one integer row.
  const row = db().prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE thread_id = ? LIMIT ?)").get(threadId, cap + 1) as { n: number };
  return row.n > cap;
}

/** The newest `count` rows in insertion order, the options rows before them, and the stored head; cold-thread-worker.ts runs it on its own handle. */
export function threadTailOn(handle: DatabaseSync, threadId: string, count: number): ThreadRows & { options: Message[] } {
  // SAFETY: This projection selects SQLite's rowid and the stored message JSON.
  const rows = handle
    .prepare("SELECT rowid AS cursor, json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?")
    .all(threadId, count) as Array<{ cursor: number; json: string }>;
  const oldest = rows.at(-1)?.cursor ?? 0;
  // SAFETY: This projection selects the stored message JSON.
  const options = handle
    .prepare("SELECT json FROM messages WHERE thread_id = ? AND kind = 'options' AND rowid < ? ORDER BY rowid")
    .all(threadId, oldest) as Array<{ json: string }>;
  // SAFETY: thread_state.active_leaf_id is a nullable TEXT column.
  const state = handle
    .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
    .get(threadId) as { active_leaf_id: string | null } | undefined;
  return { messages: rows.reverse().map(rowToMessage), options: options.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
}

/** A stored row's rowid, or undefined when the row is not stored here. */
export function rowCursor(threadId: string, id: string): number | undefined {
  // SAFETY: This projection selects SQLite's rowid.
  const row = db().prepare("SELECT rowid AS cursor FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id) as { cursor: number } | undefined;
  return row?.cursor;
}

/** The `count` stored rows before a rowid, oldest first; cold-thread-worker.ts runs it on its own handle. */
export function threadPageBeforeOn(handle: DatabaseSync, threadId: string, before: number, count: number): ThreadRows & { options: Message[] } {
  // SAFETY: This projection selects the stored message JSON.
  const rows = handle
    .prepare("SELECT json FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
    .all(threadId, before, count) as Array<{ json: string }>;
  return { messages: rows.reverse().map(rowToMessage), options: [], activeLeafId: null };
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId }; // fresh thread
  }
  if (Array.isArray(raw)) messages = raw as Message[]; // pre-branching flat file
  else if (raw && typeof raw === "object") {
    messages = ((raw as { messages?: Message[] }).messages ?? []) as Message[];
    activeLeafId = (raw as { activeLeafId?: string | null }).activeLeafId ?? null;
  }
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  messages = messages.map(redactToolMessage);
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

export function insertMessage(threadId: string, message: Message): void {
  message = redactToolMessage(message);
  db()
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  withMessageTransaction(() => {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
  });
}

export function updateMessage(threadId: string, message: Message): void {
  message = redactToolMessage(message);
  db()
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

/** Swap a thread's whole transcript and branch head in one transaction. */
export function replaceThread(threadId: string, messages: Message[], activeLeafId: string | null): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    for (const message of messages) insertMessage(threadId, message);
    setActiveLeaf(threadId, activeLeafId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// the outermost withMessageTransaction open now; its end promise is made when a reader first waits on it
let transaction: { ended?: Promise<void>; end?: () => void } | undefined;

export function withMessageTransaction<T>(work: (database: DatabaseSync) => T): T {
  const database = db();
  const nested = database.isTransaction;
  database.exec(nested ? "SAVEPOINT message_write" : "BEGIN IMMEDIATE");
  if (!nested) transaction = {};
  try {
    const result = work(database);
    database.exec(nested ? "RELEASE message_write" : "COMMIT");
    return result;
  } catch (error) {
    database.exec(nested ? "ROLLBACK TO message_write; RELEASE message_write" : "ROLLBACK");
    throw error;
  } finally {
    if (!nested) {
      transaction?.end?.();
      transaction = undefined;
    }
  }
}

/** Settles once the open withMessageTransaction commits or rolls back, or undefined outside one: another handle reads none of its writes before then. */
export function messageTransactionEnd(): Promise<void> | undefined {
  const open = transaction;
  if (!open) return undefined;
  return open.ended ??= new Promise((resolve) => {
    open.end = resolve;
  });
}

export type SendIdRows = { cursor: number; rows: Array<{ id: string; sendId: string }> };

export interface ThreadRowPage {
  messages: Message[];
  cursor: number;
}

export function scanThreadRows(threadId: string, after = 0, limit = 256): ThreadRowPage {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
    throw new Error("Invalid thread scan page");
  }
  const rows = threadRowsOn(db(), threadId, after, limit);
  return { messages: rows.map(rowToMessage), cursor: rows.at(-1)?.cursor ?? after };
}

/** A thread's stored rows past `after`, oldest first and unparsed; cold-thread-worker.ts runs it on its own handle. */
export function threadRowsOn(handle: DatabaseSync, threadId: string, after: number, limit: number): Array<{ cursor: number; json: string }> {
  // SAFETY: This projection selects SQLite's rowid and the stored message JSON.
  return handle.prepare(
    "SELECT rowid AS cursor, json FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?",
  ).all(threadId, after, limit) as Array<{ cursor: number; json: string }>;
}

/** Pass the transaction handle to commit rows and their sync outbox together. */
export function applySyncedRows(
  threadId: string,
  messages: readonly Message[],
  activeLeafId?: string | null,
  database?: DatabaseSync,
): number {
  if (!database) return withMessageTransaction((transaction) => applySyncedRows(threadId, messages, activeLeafId, transaction));
  const upsert = database.prepare(
    "INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(thread_id, id) DO UPDATE SET at = excluded.at, role = excluded.role, kind = excluded.kind, " +
      "text = excluded.text, json = excluded.json WHERE messages.json != excluded.json",
  );
  let touched = 0;
  for (const source of messages) {
    const message = redactToolMessage(source);
    touched += Number(upsert.run(
      threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message),
    ).changes);
  }
  if (activeLeafId !== undefined) {
    touched += Number(database.prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id " +
        "WHERE thread_state.active_leaf_id IS NOT excluded.active_leaf_id",
    ).run(threadId, activeLeafId).changes);
  }
  return touched;
}

const MARKDOWN_LINK_MARKS = ["](", "]:"] as const;
const FILE_TAG_MARKS = ["<file:", "<attached-file"] as const;
export const LINK_MARKS = [...MARKDOWN_LINK_MARKS, ...FILE_TAG_MARKS] as const;

/** Rows with link syntax, oldest first. */
export function linkRows(threadId: string): Array<{ id: string; role: string; text: string; fromBotId: string | null }> {
  // instr and JSON quoting preserve the suffix after a NUL, where LIKE and node:sqlite's TEXT result stop.
  // SAFETY: id, role and textJson are TEXT, fromBotId is nullable TEXT.
  const rows = db().prepare(
    "SELECT id, role, json_quote(text) AS textJson, json_extract(json, '$.from.botId') AS fromBotId " +
      "FROM messages WHERE thread_id = ? AND (instr(text, ?) OR instr(text, ?) " +
      "OR (instr(text, '<') AND (instr(lower(text), ?) OR instr(lower(text), ?)))) ORDER BY rowid",
  ).all(threadId, ...MARKDOWN_LINK_MARKS, ...FILE_TAG_MARKS) as Array<{ id: string; role: string; textJson: string; fromBotId: string | null }>;
  return rows.map(({ textJson, ...row }) => ({ ...row, text: JSON.parse(textJson) }));
}

/** One stored row by key, without loading its thread. */
export function readMessage(threadId: string, id: string): Message | undefined {
  // SAFETY: This projection selects the stored message JSON.
  const row = db().prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id) as { json: string } | undefined;
  return row && rowToMessage(row);
}

/** The active path newest first, one row at a time, or null when there are no stored rows; `kept` as storedHead takes it. */
export function activePathBack(threadId: string, kept?: string | null): Iterable<Message> | null {
  const leaf = storedHead(threadId, kept);
  if (!leaf) return null;
  const database = db();
  const row = database.prepare("SELECT rowid AS position, json FROM messages WHERE thread_id = ? AND id = ?");
  return (function* () {
    const seen = new Set<string>();
    let previous: StatementSync | undefined;
    for (let id: string | null | undefined = leaf; id && !seen.has(id); ) {
      seen.add(id);
      const found = row.get(threadId, id) as { position: number; json: string } | undefined;
      if (!found) return;
      const message = rowToMessage(found);
      // Flat legacy rows omit parentId. An explicit null ends the branch.
      if (message.parentId === undefined) {
        previous ??= database.prepare("SELECT id FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1");
        const prior = previous.get(threadId, found.position) as { id: string } | undefined;
        message.parentId = prior?.id ?? null;
      }
      yield message;
      id = message.parentId;
    }
  })();
}

/** The last thread whose stored active path was walked, keyed on its head and version so a search per keystroke walks it once. */
let storedPath: { threadId: string; key: string; ids: Set<string> } | undefined;

/** Which of `ids` sit on the stored active path, read from the parent and id indexes alone: the rows themselves (pictures and all) are never read. `kept` as storedHead takes it. */
export function onStoredPath(threadId: string, ids: readonly string[], kept?: string | null): Set<string> {
  const head = storedHead(threadId, kept);
  if (!head) return new Set();
  const key = `${head}:${threadVersion(threadId)}`;
  if (storedPath?.threadId !== threadId || storedPath.key !== key) {
    const database = db();
    // SAFETY: These projections select SQLite's rowid with the message's parentId or id TEXT, both covered by an index.
    const parents = database.prepare("SELECT rowid AS position, json_extract(json, '$.parentId') AS parent FROM messages WHERE thread_id = ?").all(threadId) as Array<{ position: number; parent: string | null }>;
    const rows = database.prepare("SELECT rowid AS position, id FROM messages WHERE thread_id = ?").all(threadId) as Array<{ position: number; id: string }>;
    // flat legacy rows omit parentId and follow the row stored before them, as activePathBack reads them; an explicit null ends the branch
    // SAFETY: This projection selects SQLite's rowid.
    const flat = new Set((database.prepare("SELECT rowid AS position FROM messages WHERE thread_id = ? AND json_extract(json, '$.parentId') IS NULL AND json_type(json, '$.parentId') IS NULL").all(threadId) as Array<{ position: number }>).map((row) => row.position));
    const parentAt = new Map(parents.map((row) => [row.position, row.parent]));
    const positionOf = new Map(rows.map((row) => [row.id, row.position]));
    const stored = flat.size ? rows.sort((a, b) => a.position - b.position) : rows;
    const indexAt = flat.size ? new Map(stored.map((row, index) => [row.position, index])) : undefined;
    const path = new Set<string>();
    for (let id: string | null | undefined = head; id && !path.has(id);) {
      const position = positionOf.get(id);
      if (position === undefined) break;
      path.add(id);
      id = flat.has(position) ? stored[indexAt!.get(position)! - 1]?.id : parentAt.get(position);
    }
    storedPath = { threadId, key, ids: path };
  }
  const path = storedPath.ids;
  return new Set(ids.filter((id) => path.has(id)));
}

/** The rows messageWindow slices from messagesFor(threadId) around `id`, read by key without loading the thread; null when no stored row has that id. */
export function storedWindow(threadId: string, id: string, limit: number): { messages: Message[]; hasMore: boolean } | null {
  const database = db();
  // SAFETY: This projection selects SQLite's rowid.
  const target = database.prepare("SELECT rowid AS position FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id) as { position: number } | undefined;
  if (!target) return null;
  if (limit < 1) return { messages: [], hasMore: true };
  type Row = { id: string; json: string };
  // SAFETY: These projections select the message id and its stored JSON.
  const newer = database.prepare("SELECT id, json FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid LIMIT ?").all(threadId, target.position, limit) as Row[];
  // half the page before the row, more when the chat ends sooner; one extra row tells whether older ones remain
  const wanted = Math.max(Math.floor((limit - 1) / 2), limit - newer.length);
  const older = database.prepare("SELECT id, json FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?").all(threadId, target.position, wanted + 1) as Row[];
  const shown = older.slice(0, wanted).reverse();
  // flat legacy rows chain to the row stored before them, as a loaded thread chains them
  let prev = older[shown.length]?.id ?? null;
  const messages = [...shown, ...newer.slice(0, limit - shown.length)].map((row) => {
    const message = rowToMessage(row);
    if (message.parentId === undefined) message.parentId = prev;
    prev = message.id;
    return message;
  });
  return { messages, hasMore: older.length > shown.length };
}

/** A thread's rows newest first, parsed only as far as the caller reads. */
export function rowsBack(threadId: string): Iterable<Message> {
  // SAFETY: This projection selects the stored message JSON.
  const rows = db().prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC").iterate(threadId) as Iterable<{ json: string }>;
  return (function* () {
    for (const row of rows) yield rowToMessage(row);
  })();
}

/** The rowid of a thread's newest stored row, or 0 when it has none here. */
export function lastCursor(threadId: string): number {
  // SAFETY: MAX(rowid) returns one integer row, NULL for no rows.
  const row = db().prepare("SELECT MAX(rowid) AS cursor FROM messages WHERE thread_id = ?").get(threadId) as { cursor: number | null };
  return row.cursor ?? 0;
}

/** A thread's note rows newest first, parsed only as far as the caller reads. */
export function notesBack(threadId: string): Iterable<Message> {
  return notesBackOn(db(), threadId);
}

/** notesBack on another handle: boot-reads.ts reads the same rows on its worker's own connection. */
export function notesBackOn(handle: DatabaseSync, threadId: string): Iterable<Message> {
  // SAFETY: This projection selects the stored message JSON.
  const rows = handle.prepare("SELECT json FROM messages WHERE thread_id = ? AND kind = 'note' ORDER BY rowid DESC").iterate(threadId) as Iterable<{ json: string }>;
  return (function* () {
    for (const row of rows) yield rowToMessage(row);
  })();
}

/** A thread's note rows stamped at or after `at`, newest first: a pane edited after every note reads none; cold-thread-worker.ts runs it on its own handle. */
export function notesSinceOn(handle: DatabaseSync, threadId: string, at: number): Iterable<Message> {
  // SAFETY: This projection selects the stored message JSON.
  const rows = handle.prepare("SELECT json FROM messages INDEXED BY messages_thread_at WHERE thread_id = ? AND kind = 'note' AND at >= ? ORDER BY rowid DESC").iterate(threadId, at) as Iterable<{ json: string }>;
  return (function* () {
    for (const row of rows) yield rowToMessage(row);
  })();
}

/** A thread's options rows, oldest first, from their index. */
/** The user's text rows and one tool's activity rows in a chat from `at` on, oldest first. */
export function typedSince(threadId: string, at: number, tool: string): Message[] {
  // SAFETY: This projection selects the stored message JSON.
  const rows = db().prepare("SELECT json FROM messages INDEXED BY messages_thread_at WHERE thread_id = ? AND at >= ? AND ((role = 'user' AND kind = 'text') OR (kind = 'activity' AND json_extract(json, '$.tool.name') = ?)) ORDER BY at, rowid").all(threadId, at, tool) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

export function optionRows(threadId: string): Message[] {
  // SAFETY: This projection selects the stored message JSON.
  const rows = db().prepare("SELECT json FROM messages WHERE thread_id = ? AND kind = 'options' ORDER BY rowid").all(threadId) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** A thread's stored rows that record file writes, oldest first; cold-thread-worker.ts runs it on its own handle. No index: building one locks out every write for seconds on a 3 GB database. */
export function writeRowsOn(handle: DatabaseSync, threadId: string): Message[] {
  // SAFETY: This projection selects the stored message JSON.
  const rows = handle.prepare("SELECT json FROM messages WHERE thread_id = ? AND kind = 'activity' AND json_extract(json, '$.tool.writes') IS NOT NULL ORDER BY rowid").all(threadId) as Array<{ json: string }>;
  return rows.map(rowToMessage);
}

/** A thread's top rowid and the sendIds of its user rows up to it, oldest first; cold-thread-worker.ts runs it on its own handle. */
export function sendIdsOn(handle: DatabaseSync, threadId: string): SendIdRows {
  // SAFETY: An aggregate always yields one row, whose cursor is null for an empty thread.
  const top = handle.prepare("SELECT MAX(rowid) AS cursor FROM messages WHERE thread_id = ?").get(threadId) as { cursor: number | null } | undefined;
  const cursor = top?.cursor ?? 0;
  // SAFETY: This projection selects the row id and the sendId string it carries.
  const rows = handle.prepare(
    "SELECT id, json_extract(json, '$.sendId') AS sendId FROM messages WHERE thread_id = ? AND rowid <= ? AND role = 'user' AND json_extract(json, '$.sendId') IS NOT NULL ORDER BY rowid",
  ).all(threadId, cursor) as SendIdRows["rows"];
  return { cursor, rows };
}

/** The newest stamp a send is clocked past, by sendClock's rule over every stored row: a row's time, or the later acted time of a row that did not wait. */
export function newestStampOn(handle: DatabaseSync, threadId: string): number {
  // SAFETY: Two aggregates always yield one row; each is null for an empty thread.
  const row = handle.prepare(
    "SELECT MAX(at) AS at, MAX(CASE WHEN json_type(json, '$.actedAt') IN ('integer', 'real') AND COALESCE(json_type(json, '$.waited'), 'null') IN ('null', 'false') THEN json_extract(json, '$.actedAt') END) AS acted FROM messages WHERE thread_id = ?",
  ).get(threadId) as { at: number | null; acted: number | null } | undefined;
  return Math.max(0, row?.at ?? 0, row?.acted ?? 0);
}

/** A chat's unanswered quick asks on its active path, as quick-ask.ts recovers them after a restart. */
export function quickAsksOn(handle: DatabaseSync, threadId: string): Array<{ id: string; at: number }> {
  // SAFETY: The query selects the message table's typed ids and time.
  const found = handle.prepare(`SELECT id, at FROM messages WHERE thread_id = ? AND role = 'user' AND kind = 'text'
    AND json_extract(json, '$.quick.state') = 'asked'
    AND id NOT IN (SELECT json_extract(json, '$.quick.askId') FROM messages WHERE thread_id = ? AND role = 'bot' AND kind = 'text'
      AND json_extract(json, '$.quick.askId') IS NOT NULL)`).all(threadId, threadId) as Array<{ id: string; at: number }>;
  // without a saved leaf main reads the path whole (Store.activePath), so every ask stays
  if (!found.length || !handle.prepare("SELECT 1 FROM thread_state WHERE thread_id = ? AND active_leaf_id IS NOT NULL").get(threadId)) return found;
  // only asks on the active path: main walks back until it sees each one, so an ask on a dropped branch would walk it to the root
  // SAFETY: The query selects the message table's typed id.
  const onPath = new Set((handle.prepare(`WITH RECURSIVE path(id) AS (
      SELECT active_leaf_id FROM thread_state WHERE thread_id = ?
      UNION SELECT json_extract(m.json, '$.parentId') FROM messages m JOIN path ON m.id = path.id WHERE m.thread_id = ?
    ) SELECT id FROM path WHERE id IN (SELECT value FROM json_each(?))`).all(threadId, threadId, JSON.stringify(found.map((row) => row.id))) as Array<{ id: string }>).map((row) => row.id));
  return found.filter((row) => onPath.has(row.id));
}

/** Newest message time without loading the transcript. */
export function lastMessageAt(threadId: string): number | null {
  const row = db().prepare("SELECT MAX(at) AS at FROM messages WHERE thread_id = ?").get(threadId) as { at: number | null } | undefined;
  return row?.at ?? null;
}

/** Bot text replies between each pair of neighboring bounds. */
export function botRepliesPerDay(bounds: readonly number[]): number[] {
  // SAFETY: This SELECT list is one COUNT per day.
  const rows = db().prepare(
    "WITH day AS (SELECT value AS start, LEAD(value) OVER (ORDER BY key) AS end FROM json_each(?)) " +
      "SELECT (SELECT COUNT(*) FROM messages WHERE role = 'bot' AND kind = 'text' AND at >= start AND at < end) AS count " +
      "FROM day WHERE end IS NOT NULL ORDER BY start",
  ).all(JSON.stringify(bounds)) as Array<{ count: number }>;
  return rows.map((row) => row.count);
}

/** Time of the first bot text reply, or null before any. */
export function firstBotReplyAt(): number | null {
  // SAFETY: This SELECT list is one MIN over an INTEGER column.
  const row = db().prepare("SELECT MIN(at) AS at FROM messages WHERE role = 'bot' AND kind = 'text'").get() as { at: number | null } | undefined;
  return row?.at ?? null;
}

/** Bot text replies grouped by thread, room speaker and engine tag, all time. */
export function botRepliesByEngine(): Array<{ threadId: string; botId: string | null; engine: string | null; count: number }> {
  // SAFETY: This SELECT list is three text keys and one COUNT.
  return db().prepare(
    "SELECT thread_id AS threadId, json_extract(json, '$.from.botId') AS botId, json_extract(json, '$.engine') AS engine, COUNT(*) AS count " +
      "FROM messages WHERE role = 'bot' AND kind = 'text' GROUP BY 1, 2, 3",
  ).all() as Array<{ threadId: string; botId: string | null; engine: string | null; count: number }>;
}

export function deleteThread(threadId: string): void {
  db().prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  db().prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
}

/** A hit's at and rowid: an in-chat find page past it starts there even once its row is gone. */
export type FindPlace = { at: number; row: number };

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** copies of the query in the haystack; find steps through each */
  matches: number;
  /** room messages: which member said it */
  from?: string;
  /** with `at`, where the row sits in its chat: a find page goes on from there even once the row is gone */
  row: number;
}

// Same header and detail block the terminal row draws. Search must not outrun it.
const INPUT_HEADERS = new Set(["Bash", "Update", "Write"]);

type ToolBody = NonNullable<Message["tool"]>;
type ToolDetail = NonNullable<ToolBody["detail"]>;

function shownArgs(verb: string, summary: string | undefined, detail: ToolDetail | undefined, fallback?: string): string | undefined {
  return (INPUT_HEADERS.has(verb) ? detail?.input ?? summary : summary ?? detail?.input) ?? fallback;
}

/** Detail text the terminal row draws: header input, then the visible output or diff lines. */
function shownDetailLines(tool: ToolBody): string[] {
  const detail = tool.detail;
  const lines: string[] = [];
  const args = shownArgs(termVerb(tool.verb ?? tool.name), tool.summary, detail, tool.verb ? tool.name : undefined);
  if (args && (args === detail?.input || args === tool.summary)) lines.push(args);
  if (!detail || detail.outputHidden) return lines;
  const diff = tool.ok !== false && detail.diff?.length ? detail.diff : undefined;
  const body = diff ?? detail.output;
  if (!body?.length) return lines;
  if (!detail.more && diff && detail.input && !lines.includes(detail.input)) lines.push(detail.input);
  for (const line of body) {
    lines.push(diff && (line[0] === "+" || line[0] === "-") ? `${line[0]} ${line.slice(1)}` : line);
  }
  return lines;
}

/** Text a find hit may quote. Activity rows include only detail the terminal row draws; `chips` rows draw the name and summary. */
export function searchHaystack(message: Pick<Message, "kind" | "text" | "tool" | "comm">, chips = false): string {
  if (message.kind !== "activity") return message.text ?? "";
  const tool = message.tool;
  if (!tool?.name) return "";
  const lines = chips ? (tool.summary ? [tool.summary] : []) : shownDetailLines(tool);
  // a comm chip draws its message body under the label
  const detail = message.comm && message.text ? [...lines, message.text] : lines;
  return detail.length ? `${tool.name}\n${detail.join("\n")}` : tool.name;
}

/** Visible detail text for one activity hit, from the tool object SQLite extracted. `body` is a comm chip's text. */
function activityHaystack(toolJson: string | null, body: string | null, chips: boolean): string {
  if (!toolJson) return "";
  // SAFETY: tool_json is the $.tool object from a stored Message envelope.
  const tool = redactToolMessage({ tool: JSON.parse(toolJson) as ToolBody }).tool;
  const shown = searchHaystack({ kind: "activity", tool }, chips);
  return shown && body ? `${shown}\n${body}` : shown;
}

/** Window around the first case-insensitive hit, with offsets after whitespace folding. */
export function searchSnippet(haystack: string, needle: string): Pick<SearchHit, "snippet" | "matchStart" | "matchLength" | "matches"> {
  const lower = haystack.toLowerCase();
  const hitAt = Math.max(0, lower.indexOf(needle));
  let matches = 0;
  for (let at = lower.indexOf(needle); needle && at >= 0; at = lower.indexOf(needle, at + needle.length)) matches++;
  const start = Math.max(0, hitAt - 60);
  const end = Math.min(haystack.length, hitAt + needle.length + 90);
  const head = start > 0 ? "…" : "";
  const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  const snippet = head + body + (end < haystack.length ? "…" : "");
  const folded = needle.replace(/\s+/g, " ");
  const matchStart = snippet.toLowerCase().indexOf(folded);
  return {
    snippet,
    matchStart: matchStart < 0 ? head.length : matchStart,
    matchLength: matchStart < 0 ? 0 : folded.length,
    matches,
  };
}

/** Case-insensitive substring search. Across chats, text messages rank
 * ahead of tool rows so a real line is not crowded out by newer paths that
 * repeat it; inside one chat (find bar) it stays newest first, so next and
 * previous follow the transcript. One ordered LIKE scan, deliberately: local
 * transcripts are usually megabytes, and it needs no FTS extension to exist;
 * a gigabyte chat scans for seconds, so an in-chat find runs off the server
 * thread (searchMessagesOn). In one chat, `before` pages past that hit, at
 * its `place` when given, and `ids` limits the scan to those rows.
 * `skip` threads never count toward `limit`. */
export function searchMessages(
  query: string,
  limit = 40,
  threadId?: string,
  options: { before?: string; place?: FindPlace; chips?: boolean; skip?: ReadonlySet<string>; ids?: readonly string[] } = {},
): SearchHit[] {
  return searchMessagesOn(db(), query, limit, threadId, options);
}

/** searchMessages on `handle`; cold-thread-worker.ts runs an in-chat find on its own handle, since a gigabyte chat scans for seconds. */
export function searchMessagesOn(
  handle: DatabaseSync,
  query: string,
  limit = 40,
  threadId?: string,
  { before, place, chips = false, skip, ids }: { before?: string; place?: FindPlace; chips?: boolean; skip?: ReadonlySet<string>; ids?: readonly string[] } = {},
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const like = (text: string) => `%${text.replace(/([\\%_])/g, "\\$1")}%`;
  const pattern = like(needle);
  // The gate reads the shown fields as JSON without keys, so it can only match a run JSON never escapes.
  // oxlint-disable-next-line no-control-regex -- JSON escapes control characters
  const fragment = needle.split(/[\s"\\\x00-\x1f\x7f]+/).reduce((longest, run) => (run.length > longest.length ? run : longest), "");
  // A fragment that can match JSON syntax also needs the decoded check, or every row reaches the visible check.
  const decoded = !fragment || /[[\],]/.test(fragment) || "null".includes(fragment)
    ? " AND (lower(ifnull(json_extract(json, '$.tool.name'), '')) LIKE ?1 ESCAPE '\\' " +
      "   OR lower(ifnull(json_extract(json, '$.tool.summary'), '')) LIKE ?1 ESCAPE '\\' " +
      "   OR lower(ifnull(json_extract(json, '$.tool.detail.input'), '')) LIKE ?1 ESCAPE '\\' " +
      "   OR EXISTS (SELECT 1 FROM json_each(messages.json, '$.tool.detail.output') WHERE lower(value) LIKE ?1 ESCAPE '\\') " +
      // diff lines draw as "+ line", so match them the way they show
      "   OR EXISTS (SELECT 1 FROM json_each(messages.json, '$.tool.detail.diff') " +
      "     WHERE lower(CASE WHEN substr(value, 1, 1) IN ('+', '-') THEN substr(value, 1, 1) || ' ' || substr(value, 2) ELSE value END) LIKE ?1 ESCAPE '\\'))"
    : "";
  // SAFETY: This projection selects at and SQLite's rowid.
  const cursor = !threadId || !before ? undefined
    : place ?? handle.prepare("SELECT at, rowid AS row FROM messages WHERE thread_id = ? AND id = ?").get(threadId, before) as { at: number; row: number } | undefined;
  if (before && !cursor) return [];
  const after = cursor ? "(at < ?4 OR (at = ?4 AND rowid < ?5)) AND " : "";
  // `ids` reads just those rows by key: the unary + keeps SQLite off the chat's (thread_id, at) index, which walks every row
  const scope = !threadId ? ""
    : ids ? `+thread_id = ?3 AND rowid IN (SELECT rowid FROM messages WHERE thread_id = ?3 AND id IN (SELECT value FROM json_each(?${cursor ? 6 : 4}))) AND ${after}`
    : `thread_id = ?3 AND ${after}`;
  const order = threadId ? "" : "CASE WHEN kind = 'text' THEN 0 ELSE 1 END, ";
  // Text matches its text. Activity matches the fields a row can draw, then
  // the visible detail only; a default-skin chip draws its name and summary. Engine
  // summaries never match. The raw json check first spares most rows a parse.
  const gate = chips
    ? "(lower(ifnull(json_extract(json, '$.tool.name'), '')) LIKE ?1 ESCAPE '\\' OR lower(ifnull(json_extract(json, '$.tool.summary'), '')) LIKE ?1 ESCAPE '\\')"
    : `lower(json_extract(json, '$.tool.name', '$.tool.summary', '$.tool.detail.input', '$.tool.detail.output', '$.tool.detail.diff')) LIKE ?2 ESCAPE '\\'${decoded}`;
  // Sorts row ids only; the hit loop reads each row once it needs it.
  const ordered = handle.prepare(
    "SELECT rowid AS row, thread_id FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ?1 ESCAPE '\\' AND json_extract(json, '$.summarized') IS NOT 1) ` +
      "   OR (kind = 'activity' AND ((text IS NOT NULL AND json_extract(json, '$.comm') IS NOT NULL AND lower(text) LIKE ?1 ESCAPE '\\') " +
      `     OR (lower(json) LIKE ?2 ESCAPE '\\' AND ${gate})))) ORDER BY ${order}at DESC, rowid DESC`,
  );
  const fetch = handle.prepare(
    "SELECT thread_id, id, at, role, kind, CASE WHEN kind != 'activity' OR json_extract(json, '$.comm') IS NOT NULL THEN text END AS text, " +
      "CASE WHEN kind = 'activity' THEN json_extract(json, '$.tool') END AS tool_json, json_extract(json, '$.from.name') AS from_name FROM messages WHERE rowid = ?",
  );
  type Row = {
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_json: string | null;
    from_name: string | null;
  };
  const hits: SearchHit[] = [];
  const args = [pattern, like(fragment), ...(threadId ? [threadId] : []), ...(cursor ? [cursor.at, cursor.row] : []), ...(threadId && ids ? [JSON.stringify(ids)] : [])];
  const rows = ordered.iterate(...args);
  for (const { row: rowid, thread_id } of rows) {
    if (skip?.has(String(thread_id))) continue;
    // SAFETY: This SELECT list is thread_id, id, at, role, kind, text, tool_json, from_name.
    const row = fetch.get(rowid) as Row;
    const haystack = row.kind === "activity" ? activityHaystack(row.tool_json, row.text, chips) : (row.text ?? "");
    if (row.kind === "activity" && !haystack.toLowerCase().includes(needle)) continue;
    const hit: SearchHit = {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      ...searchSnippet(haystack, needle),
      row: Number(rowid),
    };
    if (row.from_name) hit.from = row.from_name;
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
