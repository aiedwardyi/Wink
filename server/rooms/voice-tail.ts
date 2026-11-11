import type { CallRoom } from "../../shared/live-call.ts";
import { estimateContextTokens } from "../context-compaction.ts";
import { recentRoomEntries, roomById, roomPeople } from "./db.ts";
import { joinedEntries, joinedRoom } from "./joined.ts";

export type RoomVoiceTail = { name: string; caller: string; people: string[]; tail: string };
const ROOM_TOKENS = 2_000;

export function roomTail(room: CallRoom, host: string): RoomVoiceTail | undefined {
  const joined = room.kind === "joined" ? joinedRoom(room.id) : null;
  const hosted = room.kind === "host" ? roomById(room.id) : null;
  if (!hosted && (!joined?.state || joined.status !== "joined")) return undefined;
  const entries = hosted ? recentRoomEntries(room.id, 2_000) : joinedEntries(room.id, 2_000);
  const lines: string[] = [];
  let used = 0;
  for (const entry of entries.reverse()) {
    const text = [entry.text, ...(entry.files ?? []).map((file) => file.name)].filter(Boolean).join(" ");
    const line = `${entry.author.name}: ${text}`;
    used += estimateContextTokens([{ text: line }]);
    if (used > ROOM_TOKENS) break;
    lines.push(line);
  }
  return {
    name: hosted?.name ?? joined!.state!.roomName,
    caller: hosted ? host : joined!.me.name,
    people: hosted ? [host, ...roomPeople(room.id).map((person) => person.name)] : [joined!.state!.host, ...joined!.state!.people.map((person) => person.name)],
    tail: lines.join("\n"),
  };
}
