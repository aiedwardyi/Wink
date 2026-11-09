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
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import { stopSearchCache } from "./search-cache.ts";
import { publishSearchDirt, searchDirty, searchSource } from "./search-gate.ts";
import { querySearchCache } from "./search-query.ts";
import { activityHaystack } from "./search-text.ts";
import type { Message } from "./store.ts";
import { redactToolMessage } from "./tool-detail.ts";

export { searchHaystack } from "./search-text.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

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
    CREATE INDEX IF NOT EXISTS messages_parent ON messages(thread_id, json_extract(json, '$.parentId'));
    CREATE INDEX IF NOT EXISTS messages_bot_text_at ON messages(at) WHERE role = 'bot' AND kind = 'text';
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
  `);
  return db;
}

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  void stopSearchCache();
  handle = open();
  handlePath = DB_FILE();
  searchSource(handle);
  return handle;
}

export { db as messageDatabase };

// SAFETY: Stored rows use the Message envelope; preview fields are scrubbed on every read.
const rowToMessage = (row: { json: string }): Message => redactToolMessage(JSON.parse(row.json) as Message);

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
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
    searchDirty(db(), threadId);
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
  const database = db();
  database
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  searchDirty(database, threadId, message.id);
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
  const database = db();
  database
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
  searchDirty(database, threadId, message.id);
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
    searchDirty(database, threadId);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function withMessageTransaction<T>(work: (database: DatabaseSync) => T): T {
  const database = db();
  const nested = database.isTransaction;
  database.exec(nested ? "SAVEPOINT message_write" : "BEGIN IMMEDIATE");
  try {
    const result = work(database);
    database.exec(nested ? "RELEASE message_write" : "COMMIT");
    if (!nested) publishSearchDirt();
    return result;
  } catch (error) {
    database.exec(nested ? "ROLLBACK TO message_write; RELEASE message_write" : "ROLLBACK");
    throw error;
  }
}

export interface ThreadRowPage {
  messages: Message[];
  cursor: number;
}

export function scanThreadRows(threadId: string, after = 0, limit = 256): ThreadRowPage {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
    throw new Error("Invalid thread scan page");
  }
  // SAFETY: This projection selects SQLite's rowid and the stored message JSON.
  const rows = db().prepare(
    "SELECT rowid AS cursor, json FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ?",
  ).all(threadId, after, limit) as Array<{ cursor: number; json: string }>;
  return { messages: rows.map(rowToMessage), cursor: rows.at(-1)?.cursor ?? after };
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
    const changes = Number(upsert.run(
      threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message),
    ).changes);
    if (changes) searchDirty(database, threadId, message.id);
    touched += changes;
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

export function deleteThread(threadId: string): void {
  db().prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  searchDirty(db(), threadId);
  db().prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
}

/** Drop PC-local sync notices; their children and the branch head move up to each notice's parent. */
export function removeSyncNotices(threadId: string, ids: string[]): void {
  withMessageTransaction((database) => {
    for (const id of ids) {
      const row = database.prepare("SELECT json FROM messages WHERE thread_id = ? AND id = ?").get(threadId, id);
      if (!row) continue;
      const message: Message = JSON.parse(String(row.json));
      const parent = message.parentId ?? null;
      database.prepare("UPDATE messages SET json = json_set(json, '$.parentId', ?) WHERE thread_id = ? AND json_extract(json, '$.parentId') = ?")
        .run(parent, threadId, id);
      database.prepare("UPDATE thread_state SET active_leaf_id = ? WHERE thread_id = ? AND active_leaf_id = ?").run(parent, threadId, id);
      database.prepare("DELETE FROM messages WHERE thread_id = ? AND id = ?").run(threadId, id);
      searchDirty(database, threadId);
    }
  });
}

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
 * transcripts are megabytes at most, a scan is milliseconds, and it needs
 * no FTS extension to exist. In one chat, `before` pages past that hit. */
export function searchMessages(
  query: string,
  limit = 40,
  threadId?: string,
  { before, chips = false }: { before?: string; chips?: boolean } = {},
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const database = db();
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
  const cursor = threadId && before
    ? database.prepare("SELECT at, rowid AS row FROM messages WHERE thread_id = ? AND id = ?").get(threadId, before) as { at: number; row: number } | undefined
    : undefined;
  if (before && !cursor) return [];
  const scope = threadId ? `thread_id = ?3 AND ${cursor ? "(at < ?4 OR (at = ?4 AND rowid < ?5)) AND " : ""}` : "";
  const order = threadId ? "" : "CASE WHEN kind = 'text' THEN 0 ELSE 1 END, ";
  // Text matches its text. Activity matches the fields a row can draw, then
  // the visible detail only; a default-skin chip draws its name and summary. Engine
  // summaries never match. The raw json check first spares most rows a parse.
  const gate = chips
    ? "(lower(ifnull(json_extract(json, '$.tool.name'), '')) LIKE ?1 ESCAPE '\\' OR lower(ifnull(json_extract(json, '$.tool.summary'), '')) LIKE ?1 ESCAPE '\\')"
    : `lower(json_extract(json, '$.tool.name', '$.tool.summary', '$.tool.detail.input', '$.tool.detail.output', '$.tool.detail.diff')) LIKE ?2 ESCAPE '\\'${decoded}`;
  // Sorts row ids only; the hit loop reads each row once it needs it.
  const ordered = database.prepare(
    "SELECT rowid AS row FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ?1 ESCAPE '\\' AND json_extract(json, '$.summarized') IS NOT 1) ` +
      "   OR (kind = 'activity' AND ((text IS NOT NULL AND json_extract(json, '$.comm') IS NOT NULL AND lower(text) LIKE ?1 ESCAPE '\\') " +
      `     OR (lower(json) LIKE ?2 ESCAPE '\\' AND ${gate})))) ORDER BY ${order}at DESC, rowid DESC`,
  );
  const fetch = database.prepare(
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
  const args = [pattern, like(fragment), ...(threadId ? [threadId] : []), ...(cursor ? [cursor.at, cursor.row] : [])];
  const collect = (rows: Iterable<Record<string, SQLOutputValue>>): SearchHit[] => {
    const hits: SearchHit[] = [];
    for (const { row: rowid } of rows) {
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
      };
      if (row.from_name) hit.from = row.from_name;
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  };
  return querySearchCache(database, DATA_DIR, needle, limit, ordered, args, collect) ?? collect(ordered.iterate(...args));
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
  searchSource(null);
  void stopSearchCache();
}
