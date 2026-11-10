// Every message into a team room: the host's through the normal send route,
// a person's through the door. Plain lines cost nothing; one bot, at most,
// gets an ask.
import { roomResponder } from "../../shared/room-routing.ts";
import { committedRoomText, roomEntry, roomPeople, RoomError, type RoomAuthor, type RoomEntry, type RoomGrant, type RoomLevel } from "./db.ts";
import { roomEngineAllowed } from "./guards.ts";
import { ownRoomFiles } from "./files.ts";
import { writeRoomEntry } from "./mirror.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { askById, beginEnd, createAsk, engineLine, roomAskDeps, runAsk, sendRefusal, spend, type HostedGroup } from "./asks.ts";

export type RoomSender = { kind: "host" } | { kind: "person"; id: string };

const GRANTS: Record<RoomLevel, RoomGrant | "held"> = { trusted: "work", ask: "held", chat: "words" };

const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

export function hostedSend(group: HostedGroup, sender: RoomSender, text: string, replyToId?: string, sendId?: string, fileIds: readonly string[] = []) {
  const { store, teamRooms, hostName, driverKind } = roomAskDeps();
  if (!teamRooms()) throw new RoomError(409, "team rooms are off");
  const roomId = group.hosted.roomId;
  const people = roomPeople(roomId);
  const person = sender.kind === "person" ? people.find((candidate) => candidate.id === sender.id) : undefined;
  if (sender.kind === "person" && !person) throw new RoomError(404, "you're not in this room");
  const author: RoomAuthor = person ? { kind: "person", id: person.id, name: person.name } : { kind: "host", id: "host", name: hostName() };
  const quote = replyToId === undefined ? null : roomEntry(roomId, replyToId);
  if (replyToId !== undefined && !quote) throw new RoomError(404, "no such message in this room");
  const files = fileIds.length ? ownRoomFiles(roomId, person?.id ?? "host", fileIds) : [];
  const bots = group.memberIds.flatMap((id) => {
    const bot = store.bot(id);
    return bot && !bot.hidden ? [bot] : [];
  });
  const bot = peopleOnlyRoom(roomId) ? null : roomResponder(committedRoomText(author.kind, text), bots, people.map((candidate) => candidate.name), quote?.author.kind === "bot" ? quote.author.id : undefined);
  const grant = person ? GRANTS[person.level] : "work";
  if (person) {
    const refusal = sendRefusal(roomId, person.id, bot ? grant : null);
    if (refusal) throw statusError(429, refusal);
  }
  const { entry, message } = writeRoomEntry(store, group, { author, text, ...(quote ? { replyToId: quote.id } : {}), ...(files.length ? { files } : {}) }, sendId);
  if (person) {
    spend(roomId, person.id, "message");
    store.patchGroup(group.id, { unread: true });
  }
  if (!bot) return { entry, message, ask: null };
  const ask = createAsk({
    roomId,
    threadId: group.threadId,
    botId: bot.id,
    asker: person ? { kind: "person", id: person.id } : { kind: "host", id: "host" },
    entryId: entry.id,
    ...(quote ? { quoteId: quote.id } : {}),
    ...(grant === "held" ? {} : { grant }),
    clean: (!person || person.level === "trusted") && cleanQuote(quote, people),
  });
  if (!roomEngineAllowed(driverKind(bot.id))) beginEnd(ask.id, "failed", engineLine(bot.name));
  else if (ask.state === "queued") runAsk(ask);
  return { entry, message, ask: askById(ask.id) };
}

/** A quote is clean when the host, a Trusted person or a clean bot answer wrote it. */
function cleanQuote(quote: RoomEntry | null, people: ReturnType<typeof roomPeople>): boolean {
  if (!quote || quote.author.kind === "host") return true;
  if (quote.author.kind === "bot") return quote.clean === true;
  return people.some((person) => person.id === quote.author.id && person.level === "trusted");
}
