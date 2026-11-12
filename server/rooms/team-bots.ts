// Teammates' own bots in a hosted room. Each runs on its owner's PC and posts
// through the door under an id this PC mints; only its owner may post as it.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { roomsDatabase, RoomError } from "./db.ts";
import { checkedRoomName } from "./names.ts";

export interface TeamBot {
  id: string;
  owner: string;
  name: string;
  color: string;
}

export const TEAM_BOTS_PER_PERSON = 5;

const ready = new WeakSet<DatabaseSync>();

function db(): DatabaseSync {
  const database = roomsDatabase();
  if (!ready.has(database)) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS room_bots (
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (room_id, id)
      );
    `);
    ready.add(database);
  }
  return database;
}

export function teamBots(roomId: string): TeamBot[] {
  return db().prepare("SELECT id, owner, name, color FROM room_bots WHERE room_id = ? ORDER BY at, rowid").all(roomId) as unknown as TeamBot[];
}

export const teamBot = (roomId: string, id: string): TeamBot | null => teamBots(roomId).find((bot) => bot.id === id) ?? null;

/** `taken` is every other name in the room. */
export function addTeamBot(roomId: string, owner: string, name: unknown, color: unknown, taken: readonly string[]): TeamBot {
  const bots = teamBots(roomId);
  if (bots.filter((bot) => bot.owner === owner).length >= TEAM_BOTS_PER_PERSON) throw new RoomError(409, "too many bots");
  const checked = checkedRoomName(name, [...taken, ...bots.map((bot) => bot.name)]);
  if (!checked.ok) throw new RoomError(409, checked.error);
  // Teammate PCs read ids as [\w-]{1,64}.
  const bot = { id: `tb-${randomBytes(12).toString("base64url")}`, owner, name: checked.name, color: typeof color === "string" && /^[\w#-]{1,32}$/.test(color) ? color : "" };
  db().prepare("INSERT INTO room_bots (room_id, id, owner, name, color, at) VALUES (?, ?, ?, ?, ?, ?)").run(roomId, bot.id, owner, bot.name, bot.color, Date.now());
  return bot;
}

/** Only that owner's bot when `owner` is given; the host removes any. */
export function removeTeamBot(roomId: string, id: string, owner?: string): boolean {
  return owner === undefined
    ? db().prepare("DELETE FROM room_bots WHERE room_id = ? AND id = ?").run(roomId, id).changes > 0
    : db().prepare("DELETE FROM room_bots WHERE room_id = ? AND id = ? AND owner = ?").run(roomId, id, owner).changes > 0;
}

export function removePersonTeamBots(roomId: string, owner: string): boolean {
  return db().prepare("DELETE FROM room_bots WHERE room_id = ? AND owner = ?").run(roomId, owner).changes > 0;
}
