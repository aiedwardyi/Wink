// Where team rooms fence off today's paths. Every guard reads `group.hosted`.
import type { GroupRecord, RoomNotice, Store } from "../store.ts";
import { noticeText, roomById, roomEntry, roomPeople, type RoomPerson } from "./db.ts";
import { barredPeople } from "./invites.ts";
import { nameClash } from "./names.ts";
import { roomJoins, type RoomJoin } from "./share.ts";
import { teamBots, type TeamBot } from "./team-bots.ts";

/** Why these bots can't be a team room's bots, if they can't. */
export function roomBotsRefusal(bots: ReadonlyArray<{ name: string }>, people: readonly string[] = []): string | null {
  const clash = nameClash(bots.map((bot) => bot.name), people);
  return clash ? `someone in this room is already called ${clash}` : null;
}

export const isHostedThread = (store: Pick<Store, "groupByThread">, threadId: string) => Boolean(store.groupByThread(threadId)?.hosted);

/** The owner's linked files stay open on a shared group's older tasks; only the shared thread is closed. */
export const linkedFilesClosed = (group: GroupRecord | undefined, threadId: string) => Boolean(group?.hosted) && group!.threadId === threadId;

export type HostedRoomView = { missing: true } | { name: string; people: RoomPerson[]; joins: RoomJoin[]; teamBots: TeamBot[]; removed?: Array<{ id: string; name: string }>; noticeText?: string };

/** A hosted group restored without its rooms.db rows reads as missing, never as an empty room. */
export function hostedRoomView(hosted: NonNullable<GroupRecord["hosted"]>, notice?: RoomNotice): HostedRoomView {
  try {
    const room = roomById(hosted.roomId);
    if (!room) return { missing: true };
    const joins = roomJoins(room.id);
    const names = new Map(joins.map((join) => [join.personId, join.name]));
    const removed = barredPeople(room.id).flatMap((id) => (names.has(id) ? [{ id, name: names.get(id)! }] : []));
    const pinned = notice && roomEntry(room.id, notice.entryId)?.text;
    return { name: room.name, people: roomPeople(room.id), joins, teamBots: teamBots(room.id), ...(removed.length ? { removed } : {}), ...(pinned && pinned !== noticeText(pinned) ? { noticeText: pinned } : {}) };
  } catch {
    return { missing: true };
  }
}
