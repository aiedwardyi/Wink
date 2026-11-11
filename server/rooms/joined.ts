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
  author: { kind: "host" | "person"; id: string; name: string };
  text: string;
  replyToId?: string;
  files?: JoinedFile[];
}

export interface JoinedFile {
  id: string;
  name: string;
  type: string;
  bytes: number;
  sha256: string;
}

export interface JoinedState {
  version: number;
  roomName: string;
  instructions: string;
  host: string;
  me: { id: string; name: string };
  people: Array<{ id: string; name: string }>;
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
  state: row.state ? (JSON.parse(row.state) as JoinedState) : null,
  joinedAt: row.joined_at,
});

/** A fresh join replaces any earlier copy of the room. */
export function saveJoined(roomId: string, relayHost: string, me: { id: string; name: string }, key: string, code?: string): JoinedRoom {
  const joinedAt = Date.now();
  transaction((database) => {
    database.prepare("DELETE FROM entries WHERE room_id = ?").run(roomId);
    database.prepare("DELETE FROM room_reads WHERE room_id = ?").run(roomId);
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

/** Drops the local copy, so the next connect starts from a snapshot. */
export function resetJoined(roomId: string): void {
  transaction((database) => {
    database.prepare("DELETE FROM entries WHERE room_id = ?").run(roomId);
    database.prepare("UPDATE joined SET state = NULL, version = 0, cursor = 0 WHERE room_id = ?").run(roomId);
  });
}

/** The newest `limit` entries, oldest first. */
export function joinedEntries(roomId: string, limit: number): JoinedEntry[] {
  const rows = db().prepare("SELECT body FROM entries WHERE room_id = ? ORDER BY seq DESC LIMIT ?").all(roomId, limit) as Array<{ body: string }>;
  return rows.reverse().map((row) => JSON.parse(row.body) as JoinedEntry);
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

/** A file some held entry of this room carries; nothing else can be fetched. */
export function joinedFile(roomId: string, fileId: string): JoinedFile | null {
  const row = db().prepare(`
    SELECT file.value AS file FROM entries, json_each(entries.body, '$.files') AS file
    WHERE entries.room_id = ? AND json_extract(file.value, '$.id') = ? LIMIT 1
  `).get(roomId, fileId) as { file: string } | undefined;
  return row ? (JSON.parse(row.file) as JoinedFile) : null;
}

/** The seq the stream resumes after. */
export function joinedCursor(roomId: string): number {
  return (db().prepare("SELECT cursor FROM joined WHERE room_id = ?").get(roomId) as { cursor: number } | undefined)?.cursor ?? 0;
}

/** Keeps the highest version; an older state is ignored. */
export function setJoinedState(roomId: string, state: JoinedState): boolean {
  return db().prepare("UPDATE joined SET state = ?, version = ? WHERE room_id = ? AND status = 'joined' AND version < ?")
    .run(JSON.stringify(state), state.version, roomId, state.version).changes > 0;
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
    }
    return removed;
  });
}
