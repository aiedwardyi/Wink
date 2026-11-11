// rooms.db: team rooms this PC hosts, their people and the append-only room
// log. PC-local, never synced or backed up. Opened only once a hosted room
// exists, so a Wink with no team room never creates the file.
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redactSecretsInText } from "../../shared/redact.ts";
import { DATA_DIR } from "../config.ts";
import { newId } from "../contracts.ts";
import { checkedRoomName } from "./names.ts";

export type RoomLevel = "chat" | "ask" | "trusted";
export type RoomGrant = "words" | "work";

export interface RoomAuthor {
  kind: "host" | "person" | "bot";
  id: string;
  name: string;
}

export interface RoomRecord {
  id: string;
  name: string;
  createdAt: number;
}

export interface RoomPerson {
  id: string;
  name: string;
  level: RoomLevel;
  joinedAt: number;
}

/** A picture or file on a room entry; the bytes live in room-files. */
export interface RoomFile {
  id: string;
  name: string;
  type: string;
  bytes: number;
  sha256: string;
}

export interface RoomEntry {
  seq: number;
  id: string;
  at: number;
  author: RoomAuthor;
  text: string;
  replyToId?: string;
  askId?: string;
  grant?: RoomGrant;
  clean?: boolean;
  files?: RoomFile[];
}

export type RoomEntryDraft = Omit<RoomEntry, "seq" | "id" | "at">;

export const PERSON_TEXT_MAX = 4_000;
export const BOT_TEXT_MAX = 20_000;

export class RoomError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const DB_FILE = () => join(DATA_DIR, "rooms.db");

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
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people (
      room_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      level TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, id)
    );
    CREATE TABLE IF NOT EXISTS translations (
      room_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (room_id, entry_id, lang)
    );
    CREATE TRIGGER IF NOT EXISTS room_translations_delete AFTER DELETE ON rooms
    BEGIN DELETE FROM translations WHERE room_id = OLD.id; END;
    CREATE TABLE IF NOT EXISTS log (
      room_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL UNIQUE,
      at INTEGER NOT NULL,
      author_kind TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to_id TEXT,
      ask_id TEXT,
      grant_kind TEXT,
      clean INTEGER,
      files TEXT,
      PRIMARY KEY (room_id, seq)
    );
    CREATE TRIGGER IF NOT EXISTS log_append_only BEFORE UPDATE ON log
    BEGIN SELECT RAISE(ABORT, 'the room log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS log_no_delete BEFORE DELETE ON log
    BEGIN SELECT RAISE(ABORT, 'the room log is append-only'); END;
  `);
  if (!(db.prepare("PRAGMA table_info(log)").all() as Array<{ name: string }>).some((column) => column.name === "files")) {
    db.exec("ALTER TABLE log ADD COLUMN files TEXT");
  }
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

export function closeRoomsDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}

export function createRoom(name: string): RoomRecord {
  const room = { id: newId(), name, createdAt: Date.now() };
  db().prepare("INSERT INTO rooms (id, name, created_at) VALUES (?, ?, ?)").run(room.id, room.name, room.createdAt);
  return room;
}

export function roomById(id: string): RoomRecord | null {
  const row = db().prepare("SELECT id, name, created_at FROM rooms WHERE id = ?").get(id) as
    | { id: string; name: string; created_at: number }
    | undefined;
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
}

export function roomPeople(roomId: string): RoomPerson[] {
  const rows = db().prepare("SELECT id, name, level, joined_at FROM people WHERE room_id = ? ORDER BY joined_at, rowid").all(roomId) as
    Array<{ id: string; name: string; level: RoomLevel; joined_at: number }>;
  return rows.map((row) => ({ id: row.id, name: row.name, level: row.level, joinedAt: row.joined_at }));
}

/** `taken` is the host's and the bots' names; people are checked here. */
export function addPerson(roomId: string, name: unknown, level: RoomLevel, taken: readonly string[]): RoomPerson {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!roomById(roomId)) throw new RoomError(404, "no such room");
    const checked = checkedRoomName(name, [...taken, ...roomPeople(roomId).map((person) => person.name)]);
    if (!checked.ok) throw new RoomError(400, checked.error);
    const person = { id: newId(), name: checked.name, level, joinedAt: Date.now() };
    database.prepare("INSERT INTO people (room_id, id, name, level, joined_at) VALUES (?, ?, ?, ?, ?)")
      .run(roomId, person.id, person.name, person.level, person.joinedAt);
    database.exec("COMMIT");
    return person;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

type LogRow = {
  seq: number; id: string; at: number; author_kind: RoomAuthor["kind"]; author_id: string; author_name: string; text: string;
  reply_to_id: string | null; ask_id: string | null; grant_kind: RoomGrant | null; clean: number | null; files: string | null;
};

const LOG_COLUMNS = "seq, id, at, author_kind, author_id, author_name, text, reply_to_id, ask_id, grant_kind, clean, files";

const rowToEntry = (row: LogRow): RoomEntry => ({
  seq: row.seq,
  id: row.id,
  at: row.at,
  author: { kind: row.author_kind, id: row.author_id, name: row.author_name },
  text: row.text,
  ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
  ...(row.ask_id ? { askId: row.ask_id } : {}),
  ...(row.grant_kind ? { grant: row.grant_kind } : {}),
  ...(row.clean === null ? {} : { clean: row.clean === 1 }),
  ...(row.files ? { files: JSON.parse(row.files) as RoomFile[] } : {}),
});

export function roomEntry(roomId: string, id: string): RoomEntry | null {
  const row = db().prepare(`SELECT ${LOG_COLUMNS} FROM log WHERE room_id = ? AND id = ?`).get(roomId, id) as LogRow | undefined;
  return row ? rowToEntry(row) : null;
}

export function roomTranslation(roomId: string, entryId: string, lang: string): string | undefined {
  return (db().prepare("SELECT text FROM translations WHERE room_id = ? AND entry_id = ? AND lang = ?")
    .get(roomId, entryId, lang) as { text: string } | undefined)?.text;
}

export function saveRoomTranslation(roomId: string, entryId: string, lang: string, text: string): void {
  db().prepare("INSERT OR IGNORE INTO translations (room_id, entry_id, lang, text, at) VALUES (?, ?, ?, ?, ?)")
    .run(roomId, entryId, lang, text, Date.now());
}

/** The newest `limit` entries, oldest first. */
export function recentRoomEntries(roomId: string, limit: number): RoomEntry[] {
  const rows = db().prepare(`SELECT ${LOG_COLUMNS} FROM log WHERE room_id = ? ORDER BY seq DESC LIMIT ?`).all(roomId, limit) as LogRow[];
  return rows.reverse().map(rowToEntry);
}

/** Entries after `after`, oldest first, at most `limit`. */
export function roomEntriesAfter(roomId: string, after: number, limit: number): RoomEntry[] {
  const rows = db().prepare(`SELECT ${LOG_COLUMNS} FROM log WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(roomId, after, limit) as LogRow[];
  return rows.map(rowToEntry);
}

const ATTACHED = /<attached-/i;

/** Line ends and control characters normalized, edges trimmed. */
const cleanText = (text: string) =>
  text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();

/** The text exactly as committed: what every reader of the room sees. */
export function committedRoomText(author: RoomAuthor["kind"], text: string): string {
  const clean = cleanText(text);
  if (author !== "bot") {
    if (ATTACHED.test(clean)) throw new RoomError(400, "team rooms don't take attachments");
    return clean.slice(0, PERSON_TEXT_MAX);
  }
  // Mask before the cap, so the cut can never leave half a secret unmasked.
  return redactSecretsInText(clean.replace(/<(attached-)/gi, "[$1")).slice(0, BOT_TEXT_MAX);
}

/** The only insert into the room log. Entries are never updated. */
export function appendRoomEntry(roomId: string, draft: RoomEntryDraft): RoomEntry {
  const text = committedRoomText(draft.author.kind, draft.text);
  if (!text && !draft.files?.length) throw new RoomError(400, "message is empty");
  if (!roomById(roomId)) throw new RoomError(404, "no such room");
  if (draft.replyToId !== undefined && !roomEntry(roomId, draft.replyToId)) throw new RoomError(404, "no such message in this room");
  const row = db().prepare(`
    INSERT INTO log (room_id, seq, id, at, author_kind, author_id, author_name, text, reply_to_id, ask_id, grant_kind, clean, files)
    VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM log WHERE room_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${LOG_COLUMNS}
  `).get(
    roomId, roomId, newId(), Date.now(), draft.author.kind, draft.author.id, draft.author.name, text,
    draft.replyToId ?? null, draft.askId ?? null, draft.grant ?? null, draft.clean === undefined ? null : Number(draft.clean),
    draft.files?.length ? JSON.stringify(draft.files) : null,
  ) as LogRow;
  return rowToEntry(row);
}
