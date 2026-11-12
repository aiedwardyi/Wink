// Team room invites, room codes and guest keys, in rooms.db beside db.ts's tables.
// Invite secrets and keys live only as SHA-256 digests; a room code is kept whole
// so the host can show it again. A key works only while its person row exists.
// Every call is synchronous, so no two joins race one invite.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";

import { ROOM_CODE_RE } from "../../shared/relay-protocol.ts";
import { DATA_DIR } from "../config.ts";
import { newId } from "../contracts.ts";
import { RateLimiter } from "../phone-auth.ts";
import { MAX_PAIRING_ATTEMPTS, sameText, sha256 } from "../phone-devices.ts";
import { RoomError, roomById, type RoomLevel, type RoomPerson } from "./db.ts";
import { endDoorPerson } from "./door-streams.ts";
import { checkedRoomName, joinerName } from "./names.ts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const SHORT_CODE_REFRESH_MS = 24 * 60 * 60_000;
const MAX_PEOPLE = 20;
const JOINS_PER_MINUTE = 20;
const SECRET_PREFIX = "wki_";
const KEY_PREFIX = "wkg_";
const MAX_CREDENTIAL_LENGTH = 128;
const DEVICE = /^[\w-]{16,64}$/;

export interface RoomInvite {
  id: string;
  name: string;
  level: RoomLevel;
  createdAt: number;
  expiresAt: number;
}

type JoinError = "busy" | "no-invite" | "wrong-secret" | "too-many-tries" | "room-full" | "name-taken" | "bad-code" | "removed";
export type JoinResult = { ok: true; roomId: string; person: RoomPerson; key: string } | { ok: false; error: JoinError };

/** Who is knocking, from their own Wink. `device` stays the same on their PC. */
export type Joiner = { name?: unknown; device?: unknown };

type InviteRow = {
  id: string; room_id: string; name: string; level: RoomLevel; secret_hash: string; created_at: number; expires_at: number; tries_left: number;
};

const DB_FILE = () => join(DATA_DIR, "rooms.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  // db.ts owns the file, its mode and WAL, and the rooms and people tables.
  roomById("");
  const db = new DatabaseSync(DB_FILE());
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      level TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      tries_left INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guest_keys (
      hash TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS guest_keys_person ON guest_keys(room_id, person_id);
    CREATE TABLE IF NOT EXISTS room_codes (
      room_id TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      secret TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_devices (
      room_id TEXT NOT NULL,
      device TEXT NOT NULL,
      person_id TEXT NOT NULL,
      removed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, device)
    );
    CREATE TABLE IF NOT EXISTS short_codes (
      code TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      code_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
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

export function closeInvitesDb(): void {
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

const pruneExpired = (database: DatabaseSync) => database.prepare("DELETE FROM invites WHERE expires_at <= ?").run(Date.now());

const peopleNames = (database: DatabaseSync, roomId: string) =>
  (database.prepare("SELECT name FROM people WHERE room_id = ?").all(roomId) as Array<{ name: string }>).map((row) => row.name);

const newCredential = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

/** `taken` is the host's and the bots' names. The secret is returned once and never stored. */
export function createInvite(roomId: string, name: unknown, level: RoomLevel, taken: readonly string[]): { invite: RoomInvite; secret: string } {
  return transaction((database) => {
    if (!database.prepare("SELECT 1 FROM rooms WHERE id = ?").get(roomId)) throw new RoomError(404, "no such room");
    pruneExpired(database);
    const pending = (database.prepare("SELECT name FROM invites WHERE room_id = ?").all(roomId) as Array<{ name: string }>).map((row) => row.name);
    const checked = checkedRoomName(name, [...taken, ...peopleNames(database, roomId), ...pending]);
    if (!checked.ok) throw new RoomError(400, checked.error);
    const now = Date.now();
    const invite = { id: newId(), name: checked.name, level, createdAt: now, expiresAt: now + INVITE_TTL_MS };
    const secret = newCredential(SECRET_PREFIX);
    database.prepare(`
      INSERT INTO invites (id, room_id, name, level, secret_hash, created_at, expires_at, tries_left) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(invite.id, roomId, invite.name, level, sha256(secret), invite.createdAt, invite.expiresAt, MAX_PAIRING_ATTEMPTS);
    return { invite, secret };
  });
}

export function roomInvites(roomId: string): RoomInvite[] {
  const database = db();
  pruneExpired(database);
  const rows = database.prepare("SELECT * FROM invites WHERE room_id = ? ORDER BY created_at, rowid").all(roomId) as InviteRow[];
  return rows.map((row) => ({ id: row.id, name: row.name, level: row.level, createdAt: row.created_at, expiresAt: row.expires_at }));
}

export function cancelInvite(roomId: string, inviteId: string): boolean {
  return db().prepare("DELETE FROM invites WHERE room_id = ? AND id = ?").run(roomId, inviteId).changes > 0;
}

/** The room's one code: it joins anyone, any number of times, while the room is served. */
export function roomCode(roomId: string): { id: string; secret: string } {
  const database = db();
  database.prepare("INSERT OR IGNORE INTO room_codes (room_id, id, secret) VALUES (?, ?, ?)").run(roomId, newId(), newCredential(SECRET_PREFIX));
  const row = database.prepare("SELECT id, secret FROM room_codes WHERE room_id = ?").get(roomId) as { id: string; secret: string };
  return { id: row.id, secret: row.secret };
}

/** The room's short code with a day or more left, else a fresh one from `mint`, else null. */
export async function shortRoomCode(roomId: string, mint: () => Promise<{ code: string; exp: number } | null>): Promise<string | null> {
  const { id } = roomCode(roomId);
  const live = db().prepare("SELECT code FROM short_codes WHERE room_id = ? AND code_id = ? AND expires_at > ? ORDER BY expires_at DESC")
    .get(roomId, id, Date.now() + SHORT_CODE_REFRESH_MS) as { code: string } | undefined;
  if (live) return live.code;
  const minted = await mint();
  if (!minted || !ROOM_CODE_RE.test(minted.code)) return null;
  const database = db();
  const code = roomCode(roomId);
  database.prepare("DELETE FROM short_codes WHERE expires_at <= ?").run(Date.now());
  database.prepare("INSERT OR REPLACE INTO short_codes (code, room_id, code_id, expires_at) VALUES (?, ?, ?, ?)")
    .run(minted.code, roomId, code.id, Math.min(minted.exp, Date.now() + INVITE_TTL_MS));
  return minted.code;
}

/** The room code a live short code stands for. Gone once Remove retires that room code. */
export function shortCodeTarget(text: string): { id: string; secret: string } | null {
  const code = text.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) return null;
  const row = db().prepare(`
    SELECT c.id, c.secret FROM short_codes s JOIN room_codes c ON c.room_id = s.room_id AND c.id = s.code_id
    WHERE s.code = ? AND s.expires_at > ?
  `).get(code, Date.now()) as { id: string; secret: string } | undefined;
  return row ? { id: row.id, secret: row.secret } : null;
}

/** One person per PC: the same device back while still in the room gets a fresh key, not a second seat. */
function joinByRoomCode(database: DatabaseSync, codeId: string, secret: string, taken: readonly string[], joiner: Joiner): JoinResult {
  const code = database.prepare("SELECT room_id, secret FROM room_codes WHERE id = ?").get(codeId) as { room_id: string; secret: string } | undefined;
  if (!code) return { ok: false, error: "no-invite" };
  if (!sameText(sha256(code.secret), sha256(secret))) return { ok: false, error: "wrong-secret" };
  if (typeof joiner.device !== "string" || !DEVICE.test(joiner.device)) return { ok: false, error: "bad-code" };
  const roomId = code.room_id;
  const seen = database.prepare("SELECT person_id, removed FROM room_devices WHERE room_id = ? AND device = ?").get(roomId, joiner.device) as
    | { person_id: string; removed: number }
    | undefined;
  if (seen?.removed) return { ok: false, error: "removed" };
  const back = seen && (database.prepare("SELECT id, name, level, joined_at FROM people WHERE room_id = ? AND id = ?").get(roomId, seen.person_id) as
    | { id: string; name: string; level: RoomLevel; joined_at: number }
    | undefined);
  let person: RoomPerson;
  if (back) {
    person = { id: back.id, name: back.name, level: back.level, joinedAt: back.joined_at };
    database.prepare("DELETE FROM guest_keys WHERE room_id = ? AND person_id = ?").run(roomId, person.id);
  } else {
    const people = peopleNames(database, roomId);
    if (people.length >= MAX_PEOPLE) return { ok: false, error: "room-full" };
    person = { id: newId(), name: joinerName(joiner.name, [...taken, ...people]), level: "chat", joinedAt: Date.now() };
    database.prepare("INSERT INTO people (room_id, id, name, level, joined_at) VALUES (?, ?, ?, ?, ?)").run(roomId, person.id, person.name, person.level, person.joinedAt);
    database.prepare("INSERT OR REPLACE INTO room_devices (room_id, device, person_id) VALUES (?, ?, ?)").run(roomId, joiner.device, person.id);
  }
  const key = newCredential(KEY_PREFIX);
  database.prepare("INSERT INTO guest_keys (hash, room_id, person_id, created_at) VALUES (?, ?, ?, ?)").run(sha256(key), roomId, person.id, Date.now());
  return { ok: true, roomId, person, key };
}

const joins = new RateLimiter(JOINS_PER_MINUTE, 60_000, () => Date.now(), 1);

/** Swaps a live invite, or the room code, for a person and their guest key, in one transaction. */
export function joinRoom(inviteId: string, secret: string, taken: readonly string[], joiner: Joiner = {}): JoinResult {
  if (!joins.take("join")) return { ok: false, error: "busy" };
  const result = transaction((database): JoinResult => {
    pruneExpired(database);
    const invite = database.prepare("SELECT * FROM invites WHERE id = ?").get(inviteId) as InviteRow | undefined;
    if (!invite) return joinByRoomCode(database, inviteId, secret, taken, joiner);
    if (!sameText(invite.secret_hash, sha256(secret.length <= MAX_CREDENTIAL_LENGTH ? secret : ""))) {
      if (invite.tries_left > 1) {
        database.prepare("UPDATE invites SET tries_left = tries_left - 1 WHERE id = ?").run(invite.id);
        return { ok: false, error: "wrong-secret" };
      }
      database.prepare("DELETE FROM invites WHERE id = ?").run(invite.id);
      return { ok: false, error: "too-many-tries" };
    }
    const people = peopleNames(database, invite.room_id);
    if (people.length >= MAX_PEOPLE) return { ok: false, error: "room-full" };
    if (!checkedRoomName(invite.name, [...taken, ...people]).ok) return { ok: false, error: "name-taken" };
    const person = { id: newId(), name: invite.name, level: invite.level, joinedAt: Date.now() };
    const key = newCredential(KEY_PREFIX);
    database.prepare("INSERT INTO people (room_id, id, name, level, joined_at) VALUES (?, ?, ?, ?, ?)")
      .run(invite.room_id, person.id, person.name, person.level, person.joinedAt);
    database.prepare("DELETE FROM invites WHERE id = ?").run(invite.id);
    database.prepare("INSERT INTO guest_keys (hash, room_id, person_id, created_at) VALUES (?, ?, ?, ?)")
      .run(sha256(key), invite.room_id, person.id, person.joinedAt);
    if (typeof joiner.device === "string" && DEVICE.test(joiner.device)) {
      database.prepare("INSERT OR REPLACE INTO room_devices (room_id, device, person_id) VALUES (?, ?, ?)").run(invite.room_id, joiner.device, person.id);
    }
    return { ok: true, roomId: invite.room_id, person, key };
  });
  if (result.ok) endDoorPerson(result.roomId, result.person.id);
  return result;
}

/** The room and person a guest key belongs to, or null once either the key or the person is gone. */
export function guestByKey(key: string, device?: string | string[]): { roomId: string; person: RoomPerson } | null {
  if (!key.startsWith(KEY_PREFIX) || key.length > MAX_CREDENTIAL_LENGTH) return null;
  const database = db();
  const row = database.prepare(`
    SELECT p.room_id, p.id, p.name, p.level, p.joined_at FROM guest_keys k
    JOIN people p ON p.room_id = k.room_id AND p.id = k.person_id WHERE k.hash = ?
  `).get(sha256(key)) as { room_id: string; id: string; name: string; level: RoomLevel; joined_at: number } | undefined;
  if (row && typeof device === "string" && DEVICE.test(device)) {
    database.prepare("INSERT OR IGNORE INTO room_devices (room_id, device, person_id) VALUES (?, ?, ?)").run(row.room_id, device, row.id);
  }
  return row ? { roomId: row.room_id, person: { id: row.id, name: row.name, level: row.level, joinedAt: row.joined_at } } : null;
}

/** The room a live invite or room code is for, without spending a try. */
export function inviteRoomId(inviteId: string): string | null {
  const row = db().prepare("SELECT room_id FROM invites WHERE id = ? AND expires_at > ? UNION ALL SELECT room_id FROM room_codes WHERE id = ?")
    .get(inviteId, Date.now(), inviteId) as { room_id: string } | undefined;
  return row?.room_id ?? null;
}

/** Host Remove: that person's PC can't come back with the room code. Leave never calls this. */
export function barRoomPerson(roomId: string, personId: string): void {
  transaction((database) => {
    const barred = database.prepare("UPDATE room_devices SET removed = 1 WHERE room_id = ? AND person_id = ?").run(roomId, personId);
    if (!barred.changes) database.prepare("DELETE FROM room_codes WHERE room_id = ?").run(roomId);
  });
}

export function revokeGuestKeys(roomId: string, personId: string): boolean {
  const revoked = db().prepare("DELETE FROM guest_keys WHERE room_id = ? AND person_id = ?").run(roomId, personId).changes > 0;
  endDoorPerson(roomId, personId);
  return revoked;
}

/** Remove or Leave: the person and their keys go in one transaction, then their streams and sockets. */
export function removeGuest(roomId: string, personId: string, keep?: Duplex): boolean {
  const removed = transaction((database) => {
    database.prepare("DELETE FROM guest_keys WHERE room_id = ? AND person_id = ?").run(roomId, personId);
    return database.prepare("DELETE FROM people WHERE room_id = ? AND id = ?").run(roomId, personId).changes > 0;
  });
  endDoorPerson(roomId, personId, keep);
  return removed;
}
