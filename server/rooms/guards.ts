// Where team rooms fence off today's paths. Every guard reads `group.hosted`,
// never the teamRooms flag, so a hosted room stays closed with the flag off.
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

export const hostedThreadIds = (store: Pick<Store, "groups">) => store.groups.flatMap((group) => (group.hosted ? [group.threadId] : []));

/** A broadcast frame about a hosted room, which the iPhone never gets. */
export function hostedFrame(store: Pick<Store, "group" | "groupByThread">, payload: Record<string, any>): boolean {
  if (payload.hosted === true || payload.group?.hosted || (typeof payload.groupId === "string" && store.group(payload.groupId)?.hosted)) return true;
  const threadId = payload.threadId ?? payload.event?.threadId ?? payload.notification?.threadId;
  return typeof threadId === "string" && isHostedThread(store, threadId);
}

/** A relay request aimed at a hosted room's routes. */
export function hostedRelayTarget(store: Pick<Store, "group" | "groupByThread">, path: string): boolean {
  const group = /^\/api\/groups\/([\w-]+)/.exec(path)?.[1];
  if (group) return Boolean(store.group(group)?.hosted);
  const thread = /^\/api\/threads\/([\w-]+)/.exec(path)?.[1];
  return thread !== undefined && isHostedThread(store, thread);
}

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
