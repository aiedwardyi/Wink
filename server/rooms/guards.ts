// Where team rooms fence off today's paths. Every guard reads `group.hosted`.
import type { GroupRecord, Store } from "../store.ts";
import { roomById, roomPeople, type RoomPerson } from "./db.ts";
import { nameClash } from "./names.ts";

/** Team rooms run only on engines whose relaunches and lifetime they bound. */
const ROOM_ENGINES: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export const roomEngineAllowed = (driverKind: string | undefined) => driverKind !== undefined && ROOM_ENGINES.has(driverKind);

/** Why these bots can't be a team room's bots, if they can't. */
export function roomBotsRefusal(bots: ReadonlyArray<{ name: string; driverKind: string | undefined }>, people: readonly string[] = []): string | null {
  const off = bots.find((bot) => !roomEngineAllowed(bot.driverKind));
  if (off) return `${off.name} can only answer in team rooms on Claude or Codex`;
  const clash = nameClash(bots.map((bot) => bot.name), people);
  return clash ? `someone in this room is already called ${clash}` : null;
}

export const isHostedThread = (store: Pick<Store, "groupByThread">, threadId: string) => Boolean(store.groupByThread(threadId)?.hosted);

export type HostedRoomView = { missing: true } | { name: string; people: RoomPerson[] };

/** A hosted group restored without its rooms.db rows reads as missing, never as an empty room. */
export function hostedRoomView(hosted: NonNullable<GroupRecord["hosted"]>): HostedRoomView {
  try {
    const room = roomById(hosted.roomId);
    return room ? { name: room.name, people: roomPeople(room.id) } : { missing: true };
  } catch {
    return { missing: true };
  }
}
