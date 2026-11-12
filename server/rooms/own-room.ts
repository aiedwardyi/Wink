// The host's own PC and its own rooms: its code opens the hosted room, never a
// second seat, and a joined copy left by an older build goes on boot.
import type { GroupRecord } from "../store.ts";
import { roomPeople } from "./db.ts";
import { inviteRoomId, removeGuest, shortCodeTarget } from "./invites.ts";
import { endJoined, joinedRooms, removeJoined } from "./joined.ts";
import { removeJoinedFiles } from "./joined-files.ts";

const CODE_ID = /^wkr1:[a-z0-9.-]{1,253}:([\w-]{1,64})\.wki_[A-Za-z0-9_-]{43}$/;

/** The group this PC hosts behind a code it handed out, long or short. */
export function ownRoomGroup(code: string, groups: readonly GroupRecord[]): string | null {
  if (!groups.some((group) => group.hosted)) return null;
  const text = code.trim();
  const id = CODE_ID.exec(text)?.[1] ?? shortCodeTarget(text)?.id;
  const roomId = id ? inviteRoomId(id) : null;
  return (roomId && groups.find((group) => group.hosted?.roomId === roomId)?.id) || null;
}

/** Only joined.db rows and the seat that join took; the hosted room's lines and files stay. */
export function dropOwnJoins(groups: readonly GroupRecord[]): string[] {
  const hosted = new Set(groups.flatMap((group) => (group.hosted ? [group.hosted.roomId] : [])));
  if (!hosted.size) return [];
  return joinedRooms().filter((room) => hosted.has(room.roomId)).flatMap((room) => {
    if (roomPeople(room.roomId).some((person) => person.id === room.me.id)) removeGuest(room.roomId, room.me.id);
    endJoined(room.roomId, "left");
    if (!removeJoined(room.roomId)) return [];
    void removeJoinedFiles(room.roomId).catch(() => {});
    return [room.roomId];
  });
}
