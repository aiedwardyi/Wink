// joined.db: team rooms this PC joined on someone else's PC. Never groups, so
// no bot, routine or continuation here ever sees host content. The guest key
// lives only in this file and is dropped once the room ends.
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../config.ts";

export interface JoinedEntry {
  seq: number;
  id: string;
  at: number;
  author: { kind: "host" | "person" | "bot"; id: string; name: string };
  text: string;
  replyToId?: string;
  files?: JoinedFile[];
  /** `by` as the door sends it: "host", "person:<id>" or "bot:<id>". */
  reactions?: JoinedMark[];
}

export interface JoinedMark {
  emoji: string;
  by: string;
}

export interface JoinedFile {
  id: string;
  name: string;
  type: string;
  bytes: number;
  sha256: string;
  deleted?: boolean;
}

export interface JoinedState {
  version: number;
  picture?: string;
  notice?: { entryId: string; by: string; at: number; text?: string };
  roomName: string;
  instructions: string;
  host: string;
  me: { id: string; name: string };
  people: Array<{ id: string; name: string }>;
  bots: Array<{ id: string; name: string; color: string }>;
}

/** `removed` and `left` rooms are read-only. */
export type JoinedStatus = "joined" | "removed" | "left";

export interface JoinedRoom {
  roomId: string;
  relayHost: string;
  me: { id: string; name: string };
  status: JoinedStatus;
  state: JoinedState | null;
  joinedAt: number;
}

type RoomRow = {
  room_id: string; relay_host: string; person_id: string; person_name: string; status: JoinedStatus; state: string | null; joined_at: number;
};

const DB_FILE = () => join(DATA_DIR, "joined.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS joined (
      room_id TEXT PRIMARY KEY,
      relay_host TEXT NOT NULL,
      person_id TEXT NOT NULL,
      person_name TEXT NOT NULL,
      key TEXT,
      status TEXT NOT NULL,
      state TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      cursor INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      room_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (room_id, seq)
    );
    CREATE TABLE IF NOT EXISTS joined_codes (
      room_id TEXT PRIMARY KEY,
      code TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_reads (
      room_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sent_names (
      room_id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_counts (
      room_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_id ON entries(room_id, json_extract(body, '$.id'));
    CREATE TABLE IF NOT EXISTS translations (
      room_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (room_id, entry_id, lang)
    );
    CREATE TRIGGER IF NOT EXISTS joined_translations_delete AFTER DELETE ON joined
    BEGIN DELETE FROM translations WHERE room_id = OLD.room_id; END;
    CREATE TABLE IF NOT EXISTS reactions (
      room_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      marks TEXT NOT NULL,
      PRIMARY KEY (room_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS pictures (
      room_id TEXT NOT NULL,
      id TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (room_id, id)
    );
  `);
  return db;
}

function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

export function closeJoinedDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}

function transaction<T>(work: (database: DatabaseSync) => T): T {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const COLUMNS = "room_id, relay_host, person_id, person_name, status, state, joined_at";

const rowToRoom = (row: RoomRow): JoinedRoom => ({
  roomId: row.room_id,
  relayHost: row.relay_host,
  me: { id: row.person_id, name: row.person_name },
  status: row.status,
  state: row.state ? ({ bots: [], ...JSON.parse(row.state) } as JoinedState) : null,
  joinedAt: row.joined_at,
});

/** A fresh join replaces any earlier copy of the room. */
export function saveJoined(roomId: string, relayHost: string, me: { id: string; name: string }, key: string, code?: string): JoinedRoom {
  const joinedAt = Date.now();
  transaction((database) => {
    database.prepare("DELETE FROM entries WHERE room_id = ?").run(roomId);
    database.prepare("DELETE FROM room_reads WHERE room_id = ?").run(roomId);
    database.prepare("DELETE FROM sent_names WHERE room_id = ?").run(roomId);
    database.prepare("DELETE FROM deleted_counts WHERE room_id = ?").run(roomId);
    database.prepare("DELETE FROM translations WHERE room_id = ?").run(roomId);
    database.prepare("DELETE FROM reactions WHERE room_id = ?").run(roomId);
    database.prepare(`
      INSERT OR REPLACE INTO joined (room_id, relay_host, person_id, person_name, key, status, state, version, cursor, joined_at)
      VALUES (?, ?, ?, ?, ?, 'joined', NULL, 0, 0, ?)
    `).run(roomId, relayHost, me.id, me.name, key, joinedAt);
    if (code) database.prepare("INSERT OR REPLACE INTO joined_codes (room_id, code) VALUES (?, ?)").run(roomId, code);
  });
  return { roomId, relayHost, me, status: "joined", state: null, joinedAt };
}

export function joinedRooms(): JoinedRoom[] {
  return (db().prepare(`SELECT ${COLUMNS} FROM joined ORDER BY joined_at, rowid`).all() as RoomRow[]).map(rowToRoom);
}

export function joinedRoom(roomId: string): JoinedRoom | null {
  const row = db().prepare(`SELECT ${COLUMNS} FROM joined WHERE room_id = ?`).get(roomId) as RoomRow | undefined;
  return row ? rowToRoom(row) : null;
}

export function joinedSentName(roomId: string): string | null {
  return (db().prepare("SELECT name FROM sent_names WHERE room_id = ?").get(roomId) as { name: string } | undefined)?.name ?? null;
}

export function setJoinedSentName(roomId: string, name: string): void {
  db().prepare("INSERT OR REPLACE INTO sent_names (room_id, name) VALUES (?, ?)").run(roomId, name);
}

/** How many of the host's file deletions this PC has applied, so a reconnect asks only for newer ones. */
export function joinedDeletedCount(roomId: string): number {
  return (db().prepare("SELECT count FROM deleted_counts WHERE room_id = ?").get(roomId) as { count: number } | undefined)?.count ?? 0;
}

export function setJoinedDeletedCount(roomId: string, count: number): void {
  db().prepare("INSERT OR REPLACE INTO deleted_counts (room_id, count) VALUES (?, ?)").run(roomId, count);
}

/** Only the guest client reads this. */
export function joinedKey(roomId: string): { relayHost: string; key: string } | null {
  const row = db().prepare("SELECT relay_host, key FROM joined WHERE room_id = ? AND status = 'joined' AND key IS NOT NULL").get(roomId) as
    | { relay_host: string; key: string }
    | undefined;
  return row ? { relayHost: row.relay_host, key: row.key } : null;
}

/** Same-seq entries are kept as held. Only snapshot and stream move `cursor`: a send reply can be ahead of unseen entries. */
export function addJoinedEntries(roomId: string, entries: readonly JoinedEntry[], cursor?: number): number {
  return transaction((database) => {
    const insert = database.prepare("INSERT OR IGNORE INTO entries (room_id, seq, body) VALUES (?, ?, ?)");
    let added = 0;
    for (const entry of entries) added += Number(insert.run(roomId, entry.seq, JSON.stringify(entry)).changes);
    if (cursor !== undefined) database.prepare("UPDATE joined SET cursor = MAX(cursor, ?) WHERE room_id = ?").run(cursor, roomId);
    return added;
  });
}

/** Flags the host's deleted files on every held entry; the count of entries changed. */
export function markJoinedFilesDeleted(roomId: string, ids: readonly string[]): number {
  const gone = new Set(ids);
  return transaction((database) => {
    const rows = database.prepare(`
      SELECT DISTINCT entries.seq, entries.body FROM entries, json_each(entries.body, '$.files') AS file
      WHERE entries.room_id = ? AND json_extract(file.value, '$.id') IN (SELECT value FROM json_each(?))
    `).all(roomId, JSON.stringify(ids)) as Array<{ seq: number; body: string }>;
    const update = database.prepare("UPDATE entries SET body = ? WHERE room_id = ? AND seq = ?");
    let changed = 0;
    for (const row of rows) {
      const entry = JSON.parse(row.body) as JoinedEntry;
      if (!entry.files?.some((file) => gone.has(file.id) && !file.deleted)) continue;
      update.run(JSON.stringify({ ...entry, files: entry.files.map((file) => (gone.has(file.id) ? { ...file, deleted: true } : file)) }), roomId, row.seq);
      changed += 1;
    }
    return changed;
  });
}

/** Drops the local copy, so the next connect starts from a snapshot. Translations stay: an entry id never changes text. */
export function resetJoined(roomId: string): void {
  transaction((database) => {
    database.prepare("DELETE FROM entries WHERE room_id = ?").run(roomId);
    database.prepare("UPDATE joined SET state = NULL, version = 0, cursor = 0 WHERE room_id = ?").run(roomId);
  });
}

/** The newest `limit` entries below `before`, oldest first, each with its reactions. */
export function joinedEntries(roomId: string, limit: number, before = Number.MAX_SAFE_INTEGER): JoinedEntry[] {
  const rows = db().prepare(`
    SELECT entries.body, reactions.marks FROM entries
    LEFT JOIN reactions ON reactions.room_id = entries.room_id AND reactions.entry_id = json_extract(entries.body, '$.id')
    WHERE entries.room_id = ? AND entries.seq < ? ORDER BY entries.seq DESC LIMIT ?
  `).all(roomId, before, limit) as Array<{ body: string; marks: string | null }>;
  return rows.reverse().map((row) => {
    const entry = botLine(JSON.parse(row.body) as JoinedEntry);
    return row.marks ? { ...entry, reactions: JSON.parse(row.marks) as JoinedMark[] } : entry;
  });
}

/** A `reset` set replaces every line's marks; otherwise only the lines listed. */
export function setJoinedReactions(roomId: string, lines: ReadonlyArray<{ id: string; marks: JoinedMark[] }>, reset = false): void {
  transaction((database) => {
    if (reset) database.prepare("DELETE FROM reactions WHERE room_id = ?").run(roomId);
    const put = database.prepare("INSERT OR REPLACE INTO reactions (room_id, entry_id, marks) VALUES (?, ?, ?)");
    const drop = database.prepare("DELETE FROM reactions WHERE room_id = ? AND entry_id = ?");
    for (const line of lines) {
      if (line.marks.length) put.run(roomId, line.id, JSON.stringify(line.marks));
      else drop.run(roomId, line.id);
    }
  });
}

// A copy held from before bot lines stored each bot as the host's person alias.
function botLine(entry: JoinedEntry): JoinedEntry {
  const { author } = entry;
  return author.kind === "person" && author.id.startsWith("bot-") ? { ...entry, author: { kind: "bot", id: author.id.slice(4), name: author.name } } : entry;
}

export function joinedSummary(room: JoinedRoom): { unread: number; lastEntry?: JoinedEntry } {
  const { unread } = db().prepare(`
    SELECT COUNT(*) AS unread FROM entries
    WHERE room_id = ? AND seq > COALESCE((SELECT seq FROM room_reads WHERE room_id = ?), 0)
      AND NOT (json_extract(body, '$.author.kind') = 'person' AND json_extract(body, '$.author.id') = ?)
  `).get(room.roomId, room.roomId, room.me.id) as { unread: number };
  const lastEntry = joinedEntries(room.roomId, 1)[0];
  return { unread, ...(lastEntry ? { lastEntry } : {}) };
}

export function readJoined(roomId: string, seq: number): boolean {
  return db().prepare(`
    INSERT INTO room_reads (room_id, seq) VALUES (?, ?)
    ON CONFLICT(room_id) DO UPDATE SET seq = excluded.seq WHERE excluded.seq > room_reads.seq
  `).run(roomId, seq).changes > 0;
}

export function joinedEntry(roomId: string, entryId: string): JoinedEntry | null {
  const row = db().prepare("SELECT body FROM entries WHERE room_id = ? AND json_extract(body, '$.id') = ? LIMIT 1")
    .get(roomId, entryId) as { body: string } | undefined;
  return row ? JSON.parse(row.body) as JoinedEntry : null;
}

export function joinedTranslation(roomId: string, entryId: string, lang: string): string | undefined {
  return (db().prepare("SELECT text FROM translations WHERE room_id = ? AND entry_id = ? AND lang = ?")
    .get(roomId, entryId, lang) as { text: string } | undefined)?.text;
}

export function saveJoinedTranslation(roomId: string, entryId: string, lang: string, text: string): void {
  db().prepare("INSERT OR IGNORE INTO translations (room_id, entry_id, lang, text, at) VALUES (?, ?, ?, ?, ?)")
    .run(roomId, entryId, lang, text, Date.now());
}

/** A file some held entry of this room carries; nothing else can be fetched. */
export function joinedFile(roomId: string, fileId: string): JoinedFile | null {
  const row = db().prepare(`
    SELECT file.value AS file FROM entries, json_each(entries.body, '$.files') AS file
    WHERE entries.room_id = ? AND json_extract(file.value, '$.id') = ? LIMIT 1
  `).get(roomId, fileId) as { file: string } | undefined;
  const file = row ? (JSON.parse(row.file) as JoinedFile) : null;
  return file?.deleted ? null : file;
}

export function joinedPictureFile(roomId: string): JoinedFile | null {
  const id = joinedRoom(roomId)?.state?.picture;
  if (!id) return null;
  const row = db().prepare("SELECT body FROM pictures WHERE room_id = ? AND id = ?").get(roomId, id) as { body: string } | undefined;
  return row ? JSON.parse(row.body) as JoinedFile : null;
}

export function keepJoinedPicture(roomId: string, file: JoinedFile): void {
  db().prepare("INSERT OR REPLACE INTO pictures (room_id, id, body) VALUES (?, ?, ?)").run(roomId, file.id, JSON.stringify(file));
}

/** The seq the stream resumes after. */
export function joinedCursor(roomId: string): number {
  return (db().prepare("SELECT cursor FROM joined WHERE room_id = ?").get(roomId) as { cursor: number } | undefined)?.cursor ?? 0;
}

/** Keeps the highest version; an older state is ignored, and a held state without bots takes them at its version. */
export function setJoinedState(roomId: string, state: JoinedState): boolean {
  return db().prepare("UPDATE joined SET state = ?, version = ?, person_name = ? WHERE room_id = ? AND status = 'joined' AND (version < ? OR (version = ? AND json_extract(state, '$.bots') IS NULL))")
    .run(JSON.stringify(state), state.version, state.me.name, roomId, state.version, state.version).changes > 0;
}

/** Read-only from here on; the key is gone. */
export function endJoined(roomId: string, status: "removed" | "left"): boolean {
  return db().prepare("UPDATE joined SET status = ?, key = NULL WHERE room_id = ? AND status = 'joined'").run(status, roomId).changes > 0;
}

export function joinedCode(roomId: string): string | null {
  return (db().prepare("SELECT code FROM joined_codes WHERE room_id = ?").get(roomId) as { code: string } | undefined)?.code ?? null;
}

export function removeJoined(roomId: string): boolean {
  return transaction((database) => {
    const removed = database.prepare("DELETE FROM joined WHERE room_id = ? AND status != 'joined'").run(roomId).changes > 0;
    if (removed) {
      database.prepare("DELETE FROM entries WHERE room_id = ?").run(roomId);
      database.prepare("DELETE FROM room_reads WHERE room_id = ?").run(roomId);
      database.prepare("DELETE FROM joined_codes WHERE room_id = ?").run(roomId);
      database.prepare("DELETE FROM sent_names WHERE room_id = ?").run(roomId);
      database.prepare("DELETE FROM deleted_counts WHERE room_id = ?").run(roomId);
      database.prepare("DELETE FROM reactions WHERE room_id = ?").run(roomId);
    }
    return removed;
  });
}
