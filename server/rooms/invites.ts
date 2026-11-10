// Team room invites and guest keys, in rooms.db beside db.ts's tables. Secrets
// and keys live only as SHA-256 digests, and a key works only while its person
// row exists. Every call is synchronous, so no two joins race one invite.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../config.ts";
import { newId } from "../contracts.ts";
import { RateLimiter } from "../phone-auth.ts";
import { MAX_PAIRING_ATTEMPTS, sameText, sha256 } from "../phone-devices.ts";
import { RoomError, roomById, type RoomLevel, type RoomPerson } from "./db.ts";
import { checkedRoomName } from "./names.ts";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_PEOPLE = 20;
const JOINS_PER_MINUTE = 20;
const SECRET_PREFIX = "wki_";
const KEY_PREFIX = "wkg_";
const MAX_CREDENTIAL_LENGTH = 128;

export interface RoomInvite {
  id: string;
  name: string;
  level: RoomLevel;
  createdAt: number;
  expiresAt: number;
}

type JoinError = "busy" | "no-invite" | "wrong-secret" | "too-many-tries" | "room-full" | "name-taken";
export type JoinResult = { ok: true; roomId: string; person: RoomPerson; key: string } | { ok: false; error: JoinError };

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

const joins = new RateLimiter(JOINS_PER_MINUTE, 60_000, () => Date.now(), 1);

/** Swaps a live invite for a person and their guest key, in one transaction. */
export function joinRoom(inviteId: string, secret: string, taken: readonly string[]): JoinResult {
  if (!joins.take("join")) return { ok: false, error: "busy" };
  return transaction((database): JoinResult => {
    pruneExpired(database);
    const invite = database.prepare("SELECT * FROM invites WHERE id = ?").get(inviteId) as InviteRow | undefined;
    if (!invite) return { ok: false, error: "no-invite" };
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
    return { ok: true, roomId: invite.room_id, person, key };
  });
}

/** The room and person a guest key belongs to, or null once either the key or the person is gone. */
export function guestByKey(key: string): { roomId: string; person: RoomPerson } | null {
  if (!key.startsWith(KEY_PREFIX) || key.length > MAX_CREDENTIAL_LENGTH) return null;
  const row = db().prepare(`
    SELECT p.room_id, p.id, p.name, p.level, p.joined_at FROM guest_keys k
    JOIN people p ON p.room_id = k.room_id AND p.id = k.person_id WHERE k.hash = ?
  `).get(sha256(key)) as { room_id: string; id: string; name: string; level: RoomLevel; joined_at: number } | undefined;
  return row ? { roomId: row.room_id, person: { id: row.id, name: row.name, level: row.level, joinedAt: row.joined_at } } : null;
}

export function revokeGuestKeys(roomId: string, personId: string): boolean {
  return db().prepare("DELETE FROM guest_keys WHERE room_id = ? AND person_id = ?").run(roomId, personId).changes > 0;
}
