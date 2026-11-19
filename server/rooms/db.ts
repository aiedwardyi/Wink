// rooms.db: team rooms this PC hosts, their people and the append-only room
// log. PC-local, never synced or backed up. Opened only once a hosted room
// exists, so a Wink with no team room never creates the file.
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redactSecretsInText } from "../../shared/redact.ts";
import { DATA_DIR } from "../config.ts";
import { newId } from "../contracts.ts";
import { checkedRoomName, joinerName } from "./names.ts";

export type RoomGrant = "words" | "work";

export interface RoomAuthor {
  kind: "host" | "person" | "bot";
  id: string;
  name: string;
  /** The person whose own bot this is, on a teammate's PC. */
  owner?: string;
}

export interface RoomRecord {
  id: string;
  name: string;
  createdAt: number;
}

export interface RoomPerson {
  id: string;
  name: string;
  joinedAt: number;
  /** The host's "Can make bots work" switch: off, their requests run read-only. */
  works: boolean;
  host?: true;
}

/** A picture or file on a room entry; the bytes live in room-files. */
export interface RoomFile {
  id: string;
  name: string;
  type: string;
  bytes: number;
  sha256: string;
  deleted?: boolean;
}

export interface RoomEntry {
  seq: number;
  id: string;
  at: number;
  author: RoomAuthor;
  seat?: string;
  text: string;
  replyToId?: string;
  askId?: string;
  grant?: RoomGrant;
  clean?: boolean;
  files?: RoomFile[];
}

export type RoomEntryDraft = Omit<RoomEntry, "seq" | "id" | "at">;

export const PERSON_TEXT_MAX = 4_000;
// Every joiner build parses entry text up to this; one longer line fails their whole snapshot.
export const ROOM_TEXT_MAX = 20_000;

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
      -- retired: every member is a full collaborator; older files keep it NOT NULL
      level TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, id)
    );
    CREATE TABLE IF NOT EXISTS room_host_seats (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      PRIMARY KEY (room_id, person_id)
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
    CREATE TABLE IF NOT EXISTS room_file_deletions (
      room_id TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (room_id, id)
    );
    CREATE TRIGGER IF NOT EXISTS log_append_only BEFORE UPDATE ON log
    BEGIN SELECT RAISE(ABORT, 'the room log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS log_no_delete BEFORE DELETE ON log
    BEGIN SELECT RAISE(ABORT, 'the room log is append-only'); END;
  `);
  const columns = (db.prepare("PRAGMA table_info(log)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("files")) db.exec("ALTER TABLE log ADD COLUMN files TEXT");
  if (!columns.includes("author_owner")) db.exec("ALTER TABLE log ADD COLUMN author_owner TEXT");
  if (!columns.includes("author_seat")) db.exec("ALTER TABLE log ADD COLUMN author_seat TEXT");
  // DEFAULT 1 keeps everyone already in a room at full power; every join inserts 0.
  if (!(db.prepare("PRAGMA table_info(people)").all() as Array<{ name: string }>).some((column) => column.name === "works")) {
    db.exec("ALTER TABLE people ADD COLUMN works INTEGER NOT NULL DEFAULT 1");
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

/** The open rooms.db handle, for tables kept beside the log in one transaction. */
export const roomsDatabase = (): DatabaseSync => db();

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

export function roomHostSeats(roomId: string): string[] {
  return (db().prepare("SELECT person_id FROM room_host_seats WHERE room_id = ? ORDER BY person_id").all(roomId) as Array<{ person_id: string }>).map((row) => row.person_id);
}

export function roomPeople(roomId: string, includeHostSeats = false): RoomPerson[] {
  const rows = db().prepare(`
    SELECT p.id, p.name, p.joined_at, p.works, h.person_id AS host FROM people p
    LEFT JOIN room_host_seats h ON h.room_id = p.room_id AND h.person_id = p.id
    WHERE p.room_id = ? AND (? OR h.person_id IS NULL) ORDER BY p.joined_at, p.rowid
  `).all(roomId, Number(includeHostSeats)) as Array<{ id: string; name: string; joined_at: number; works: number; host: string | null }>;
  return rows.map((row) => ({ id: row.id, name: row.name, joinedAt: row.joined_at, works: row.works === 1, ...(row.host ? { host: true as const } : {}) }));
}

/** Host only: whether this person's requests may make the room's bots work. */
export function setPersonWorks(roomId: string, personId: string, on: boolean): boolean {
  return db().prepare("UPDATE people SET works = ? WHERE room_id = ? AND id = ?").run(Number(on), roomId, personId).changes > 0;
}

export function renameRoomPerson(roomId: string, personId: string, value: string, taken: readonly string[]): string {
  const name = joinerName(value, [...taken, ...roomPeople(roomId).filter((person) => person.id !== personId).map((person) => person.name)]);
  db().prepare("UPDATE people SET name = ? WHERE room_id = ? AND id = ?").run(name, roomId, personId);
  return name;
}

/** `taken` is the host's and the bots' names; people are checked here. */
export function addPerson(roomId: string, name: unknown, taken: readonly string[]): RoomPerson {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!roomById(roomId)) throw new RoomError(404, "no such room");
    const checked = checkedRoomName(name, [...taken, ...roomPeople(roomId).map((person) => person.name)]);
    if (!checked.ok) throw new RoomError(400, checked.error);
    const person = { id: newId(), name: checked.name, joinedAt: Date.now(), works: false };
    database.prepare("INSERT INTO people (room_id, id, name, level, joined_at, works) VALUES (?, ?, ?, 'member', ?, 0)")
      .run(roomId, person.id, person.name, person.joinedAt);
    database.exec("COMMIT");
    return person;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

type LogRow = {
  seq: number; id: string; at: number; author_kind: RoomAuthor["kind"]; author_id: string; author_name: string; text: string;
  reply_to_id: string | null; ask_id: string | null; grant_kind: RoomGrant | null; clean: number | null; files: string | null; author_owner: string | null;
  host_name?: string | null;
  author_seat: string | null;
};

const LOG_COLUMNS = "seq, id, at, author_kind, author_id, author_name, text, reply_to_id, ask_id, grant_kind, clean, files, author_owner, author_seat";
const READ_LOG_COLUMNS = `${LOG_COLUMNS}, (SELECT host_name FROM room_host_seats WHERE room_id = log.room_id AND person_id = log.author_id AND log.author_kind = 'person') AS host_name`;

const rowToEntry = (row: LogRow): RoomEntry => ({
  seq: row.seq,
  id: row.id,
  at: row.at,
  author: row.host_name ? { kind: "host", id: "host", name: row.host_name } : { kind: row.author_kind, id: row.author_id, name: row.author_name, ...(row.author_owner ? { owner: row.author_owner } : {}) },
  ...(row.host_name ? { seat: row.author_id } : row.author_seat ? { seat: row.author_seat } : {}),
  text: row.text,
  ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
  ...(row.ask_id ? { askId: row.ask_id } : {}),
  ...(row.grant_kind ? { grant: row.grant_kind } : {}),
  ...(row.clean === null ? {} : { clean: row.clean === 1 }),
  ...(row.files ? { files: (JSON.parse(row.files) as RoomFile[]).map((file) => ({
    ...file,
    ...(db().prepare("SELECT 1 FROM room_file_deletions WHERE id = ? AND room_id = (SELECT room_id FROM log WHERE id = ?)").get(file.id, row.id) ? { deleted: true } : {}),
  })) } : {}),
});

export function roomEntry(roomId: string, id: string): RoomEntry | null {
  const row = db().prepare(`SELECT ${READ_LOG_COLUMNS} FROM log WHERE room_id = ? AND id = ?`).get(roomId, id) as LogRow | undefined;
  return row ? rowToEntry(row) : null;
}

const NOTICE_CHARS = 300;

/** A pinned line's text rides in every state push, so only a preview; the line itself has the rest. */
export const noticeText = (text: string): string =>
  text.length > NOTICE_CHARS ? `${text.slice(0, NOTICE_CHARS).replace(/[\uD800-\uDBFF]$/, "")}…` : text;

export function roomTranslation(roomId: string, entryId: string, lang: string): string | undefined {
  return (db().prepare("SELECT text FROM translations WHERE room_id = ? AND entry_id = ? AND lang = ?")
    .get(roomId, entryId, lang) as { text: string } | undefined)?.text;
}

export function saveRoomTranslation(roomId: string, entryId: string, lang: string, text: string): void {
  db().prepare("INSERT OR IGNORE INTO translations (room_id, entry_id, lang, text, at) VALUES (?, ?, ?, ?, ?)")
    .run(roomId, entryId, lang, text, Date.now());
}

/** The newest `limit` entries, oldest first. */
export function recentRoomEntries(roomId: string, limit: number, before = Number.MAX_SAFE_INTEGER): RoomEntry[] {
  const rows = db().prepare(`SELECT ${READ_LOG_COLUMNS} FROM log WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`).all(roomId, before, limit) as LogRow[];
  return rows.reverse().map(rowToEntry);
}

/** Entries after `after`, oldest first, at most `limit`. */
export function roomEntriesAfter(roomId: string, after: number, limit: number): RoomEntry[] {
  const rows = db().prepare(`SELECT ${READ_LOG_COLUMNS} FROM log WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(roomId, after, limit) as LogRow[];
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
    return clean.slice(0, author === "host" ? ROOM_TEXT_MAX : PERSON_TEXT_MAX);
  }
  // Mask before the cap, so the cut can never leave half a secret unmasked.
  return redactSecretsInText(clean.replace(/<(attached-)/gi, "[$1")).slice(0, ROOM_TEXT_MAX);
}

/** The only insert into the room log. Entries are never updated. `at` is set only for carried history. */
export function appendRoomEntry(roomId: string, draft: RoomEntryDraft, at = Date.now()): RoomEntry {
  const text = committedRoomText(draft.author.kind, draft.text);
  if (!text && !draft.files?.length) throw new RoomError(400, "message is empty");
  if (!roomById(roomId)) throw new RoomError(404, "no such room");
  if (draft.replyToId !== undefined && !roomEntry(roomId, draft.replyToId)) throw new RoomError(404, "no such message in this room");
  const row = db().prepare(`
    INSERT INTO log (room_id, seq, id, at, author_kind, author_id, author_name, text, reply_to_id, ask_id, grant_kind, clean, files, author_owner, author_seat)
    VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM log WHERE room_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${LOG_COLUMNS}
  `).get(
    roomId, roomId, newId(), at, draft.author.kind, draft.author.id, draft.author.name, text,
    draft.replyToId ?? null, draft.askId ?? null, draft.grant ?? null, draft.clean === undefined ? null : Number(draft.clean),
    draft.files?.length ? JSON.stringify(draft.files) : null, draft.author.owner ?? null, draft.seat ?? null,
  ) as LogRow;
  return rowToEntry(row);
}
