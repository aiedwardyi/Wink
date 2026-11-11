// Share: a group gets a room, its recent chat carried in, then its one code.
// The seed is one rooms.db transaction that also records which thread row
// became which entry, so a retry or restart reuses that room and never
// imports twice. Joins are kept here too, for the host's join lines.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { json } from "../http-helpers.ts";
import type { GroupRecord, Message, Store } from "../store.ts";
import { appendRoomEntry, committedRoomText, createRoom, roomById, roomsDatabase, type RoomAuthor, type RoomPerson } from "./db.ts";
import { roomCode } from "./invites.ts";
import { markPeopleOnly } from "./people-only.ts";

/** The carry: the active task's newest lines, the same window as a snapshot. */
export const SHARED_LINES = 200;

const ROUTE = /^\/api\/groups\/([\w-]{1,64})\/share$/;
const ATTACHED = /<\/?attached-[^>]*>/gi;

const withoutAttachments = (text: string): string => {
  const next = text.replace(ATTACHED, "");
  return next === text ? text : withoutAttachments(next);
};

export interface ShareDeps {
  store: Pick<Store, "group" | "activePath" | "messagesFor" | "patchMessage" | "patchGroup">;
  hostName(): string;
  /** This PC's relay host, null while it has none. */
  relayHost(): string | null;
  groupIsWorking(group: GroupRecord): boolean;
}

export type Shared = { roomId: string; code: string; carried: number };

export type RoomJoin = { personId: string; name: string; at: number };

const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

function tables(db: DatabaseSync): DatabaseSync {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_shares (
      group_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_imports (
      room_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      PRIMARY KEY (room_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS room_joins (
      room_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      name TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (room_id, person_id)
    );
  `);
  return db;
}

/** Who said a row, as the room log names them; null for rows that are no one's chat. */
function authorOf(message: Message, hostName: string): RoomAuthor | null {
  if (message.author) return message.author;
  if (message.role === "bot") return message.from ? { kind: "bot", id: message.from.botId, name: message.from.name } : null;
  return message.origin ? null : { kind: "host", id: "host", name: hostName };
}

/** Settled, shown chat text on the visible branch, tags for local files removed whole. */
export function sharedHistory(path: readonly Message[], hostName: string): Array<{ message: Message; author: RoomAuthor; text: string }> {
  const lines: Array<{ message: Message; author: RoomAuthor; text: string }> = [];
  for (const message of path) {
    if (message.kind !== "text" || (message.role === "bot" && message.summarized) || message.queued || message.quick || message.comm) continue;
    const author = authorOf(message, hostName);
    if (!author) continue;
    let text: string;
    try {
      text = committedRoomText(author.kind, withoutAttachments(message.text ?? ""));
    } catch {
      continue;
    }
    if (text) lines.push({ message, author, text });
  }
  return lines.slice(-SHARED_LINES);
}

function seed(db: DatabaseSync, group: GroupRecord, path: readonly Message[], hostName: string): string {
  const lines = sharedHistory(path, hostName);
  db.exec("BEGIN IMMEDIATE");
  try {
    const room = createRoom(group.name);
    // A group with no bots stays the people-only room it was.
    if (!group.memberIds.length) markPeopleOnly(db, room.id);
    const entryOf = new Map<string, string>();
    const link = db.prepare("INSERT INTO room_imports (room_id, message_id, entry_id) VALUES (?, ?, ?)");
    for (const { message, author, text } of lines) {
      const replyToId = message.replyToId ? entryOf.get(message.replyToId) : undefined;
      const entry = appendRoomEntry(room.id, { author, text, ...(replyToId ? { replyToId } : {}) }, message.at);
      entryOf.set(message.id, entry.id);
      link.run(room.id, message.id, entry.id);
    }
    db.prepare("INSERT OR REPLACE INTO group_shares (group_id, room_id, thread_id) VALUES (?, ?, ?)").run(group.id, room.id, group.threadId);
    db.exec("COMMIT");
    return room.id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Share a group, or hand back its code. Synchronous, so two Invites can't interleave. */
export function shareGroup(deps: ShareDeps, groupId: string): Shared {
  const { store } = deps;
  const group = store.group(groupId);
  if (!group) throw statusError(404, "no such group");
  if (group.dm) throw statusError(400, "bot-to-bot channels can't be shared");
  const relayHost = deps.relayHost();
  if (!relayHost) throw statusError(409, "phone access is off");
  const db = tables(roomsDatabase());
  const live = group.hosted && roomById(group.hosted.roomId) ? group.hosted.roomId : null;
  const earlier = db.prepare("SELECT room_id, thread_id FROM group_shares WHERE group_id = ?").get(group.id) as { room_id: string; thread_id: string } | undefined;
  const reuse = earlier && earlier.thread_id === group.threadId && roomById(earlier.room_id) ? earlier.room_id : null;
  if (!live && !reuse && deps.groupIsWorking(group)) throw statusError(409, "this group is working - finish that turn first");
  const roomId = live ?? reuse ?? seed(db, group, store.activePath(group.threadId), deps.hostName());
  const imports = db.prepare("SELECT message_id, entry_id FROM room_imports WHERE room_id = ?").all(roomId) as Array<{ message_id: string; entry_id: string }>;
  const rows = new Map(store.messagesFor(group.threadId).map((message) => [message.id, message]));
  for (const { message_id, entry_id } of imports) {
    if (rows.get(message_id)?.roomEntryId !== entry_id) store.patchMessage(group.threadId, message_id, { roomEntryId: entry_id });
  }
  if (group.hosted?.roomId !== roomId) store.patchGroup(group.id, { hosted: { roomId } });
  const code = roomCode(roomId);
  return { roomId, code: `wkr1:${relayHost}:${code.id}.${code.secret}`, carried: imports.length };
}

/** Kept once per person, so a rejoin from the same PC adds no second line. */
export function recordRoomJoin(roomId: string, person: RoomPerson): void {
  tables(roomsDatabase()).prepare("INSERT OR IGNORE INTO room_joins (room_id, person_id, name, at) VALUES (?, ?, ?, ?)").run(roomId, person.id, person.name, person.joinedAt);
}

export function roomJoins(roomId: string): RoomJoin[] {
  const rows = tables(roomsDatabase()).prepare("SELECT person_id, name, at FROM room_joins WHERE room_id = ? ORDER BY at, rowid").all(roomId) as Array<{ person_id: string; name: string; at: number }>;
  return rows.map((row) => ({ personId: row.person_id, name: row.name, at: row.at }));
}

/** POST /api/groups/:id/share. Local only, owner only. False when the path isn't ours. */
export async function shareRoute(
  _req: IncomingMessage, res: ServerResponse, method: string, path: string,
  deps: ShareDeps & { botCaller: boolean; publicGroupState(group: GroupRecord): unknown },
): Promise<boolean> {
  const route = ROUTE.exec(path);
  if (!route) return false;
  if (method !== "POST") json(res, 404, { error: "not found" });
  else if (deps.botCaller) json(res, 403, { error: "forbidden" });
  else {
    try {
      const shared = shareGroup(deps, route[1]!);
      json(res, 200, { ...shared, group: deps.publicGroupState(deps.store.group(route[1]!)!) });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === undefined) throw error;
      json(res, status, { error: (error as Error).message });
    }
  }
  return true;
}
