// People-only team rooms: people talk, no bot works. The mode follows the
// roster, a hosted room with no bots, in a rooms.db table of its own.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../config.ts";
import { createRoom, roomById, type RoomRecord } from "./db.ts";

export const PEOPLE_ONLY_LINE = "a people-only room has no bots";

const DB_FILE = () => join(DATA_DIR, "rooms.db");

const TABLE = "CREATE TABLE IF NOT EXISTS people_only_rooms (room_id TEXT PRIMARY KEY)";

// Opened per call: a held handle would outlive closeRoomsDb and keep the file locked.
function withDb<T>(run: (db: DatabaseSync) => T): T {
  // db.ts owns the file, its mode and WAL.
  roomById("");
  const db = new DatabaseSync(DB_FILE());
  try {
    db.exec(TABLE);
    return run(db);
  } finally {
    db.close();
  }
}

/** On the caller's connection, so a share can lock a room in its own transaction. */
export function markPeopleOnly(db: DatabaseSync, roomId: string): void {
  db.exec(TABLE);
  db.prepare("INSERT INTO people_only_rooms (room_id) VALUES (?)").run(roomId);
}

export function createPeopleOnlyRoom(name: string): RoomRecord {
  const room = createRoom(name);
  withDb((db) => markPeopleOnly(db, room.id));
  return room;
}

export function setPeopleOnly(roomId: string, on: boolean): void {
  withDb((db) => db.prepare(on ? "INSERT OR IGNORE INTO people_only_rooms (room_id) VALUES (?)" : "DELETE FROM people_only_rooms WHERE room_id = ?").run(roomId));
}

/** Unreadable counts as people-only, so a broken rooms.db starts no bot work. */
export function peopleOnlyRoom(roomId: string): boolean {
  try {
    return withDb((db) => db.prepare("SELECT 1 FROM people_only_rooms WHERE room_id = ?").get(roomId) !== undefined);
  } catch {
    return true;
  }
}

export function peopleOnlyRoster(value: unknown): { ok: true; memberIds: string[] } | { ok: false; error: string } {
  return value === undefined || (Array.isArray(value) && value.length === 0) ? { ok: true, memberIds: [] } : { ok: false, error: PEOPLE_ONLY_LINE };
}
