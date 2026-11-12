// Every message into a team room: the host's through the normal send route,
// a person's through the door. The host's line is only committed here: the
// normal group turn answers it. A person's wakes one bot, at most, with an ask.
import { roomResponder } from "../../shared/room-routing.ts";
import { alertWhenUnread, roomLineText } from "./alerts.ts";
import { committedRoomText, roomEntry, roomPeople, RoomError, type RoomAuthor, type RoomEntry } from "./db.ts";
import { ownRoomFiles } from "./files.ts";
import { writeRoomEntry } from "./mirror.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { askById, createAsk, roomAskDeps, runAsk, sendRefusal, spend, type HostedGroup } from "./asks.ts";

export type RoomSender = { kind: "host" } | { kind: "person"; id: string };

const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

export function hostedSend(group: HostedGroup, sender: RoomSender, text: string, replyToId?: string, sendId?: string, fileIds: readonly string[] = []) {
  const { store, hostName, alert } = roomAskDeps();
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
  const bot = !person || peopleOnlyRoom(roomId) ? null : roomResponder(committedRoomText(author.kind, text), bots, people.map((candidate) => candidate.name), quote?.author.kind === "bot" ? quote.author.id : undefined);
  if (person) {
    const refusal = sendRefusal(roomId, person.id, bot ? "work" : null);
    if (refusal) throw statusError(429, refusal);
  }
  const { entry, message } = writeRoomEntry(store, group, { author, text, ...(quote ? { replyToId: quote.id } : {}), ...(files.length ? { files } : {}) }, sendId);
  if (person) {
    spend(roomId, person.id, "message");
    store.patchGroup(group.id, { unread: true });
    const line = { chat: group.id, threadId: group.threadId, room: group.name, name: person.name, text: roomLineText(entry.text, entry.files) };
    alertWhenUnread(line, () => store.group(group.id)?.unread === true, alert);
  }
  if (!bot || !person) return { entry, message, ask: null };
  const ask = createAsk({
    roomId,
    threadId: group.threadId,
    botId: bot.id,
    asker: { kind: "person", id: person.id },
    entryId: entry.id,
    ...(quote ? { quoteId: quote.id } : {}),
    grant: "work",
    clean: person.level === "trusted" && cleanQuote(quote, people),
  });
  runAsk(ask);
  return { entry, message, ask: askById(ask.id) };
}

/** A quote is clean when the host, a Trusted person or a clean bot answer wrote it. */
function cleanQuote(quote: RoomEntry | null, people: ReturnType<typeof roomPeople>): boolean {
  if (!quote || quote.author.kind === "host") return true;
  if (quote.author.kind === "bot") return quote.clean === true;
  return people.some((person) => person.id === quote.author.id && person.level === "trusted");
}
