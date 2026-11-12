// Every message into a team room: the host's through the normal send route,
// a person's through the door. The host's line is only committed here: the
// normal group turn answers it. A person's wakes one bot, at most, with an ask.
import { roomResponder } from "../../shared/room-routing.ts";
import type { Message } from "../store.ts";
import { alertWhenUnread, roomLineText } from "./alerts.ts";
import { committedRoomText, roomEntry, roomPeople, RoomError, type RoomAuthor, type RoomEntry } from "./db.ts";
import { ownRoomFiles } from "./files.ts";
import { writeRoomEntry, type LocalRow } from "./mirror.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { askById, createAsk, roomAskDeps, runAsk, sendRefusal, spend, type HostedGroup } from "./asks.ts";

export type RoomSender = { kind: "host" } | { kind: "person"; id: string };

const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

export function hostedSend(group: HostedGroup, sender: RoomSender, text: string, replyToId?: string, sendId?: string, fileIds: readonly string[] = [], local?: LocalRow) {
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
  const route = (soloWakes = true) => roomResponder(committedRoomText(author.kind, text), bots, [hostName(), ...people.map((candidate) => candidate.name)], quote?.author.kind === "bot" ? quote.author.id : undefined, soloWakes);
  let bot = !person || peopleOnlyRoom(roomId) ? null : route();
  if (person) {
    let refusal = sendRefusal(roomId, person.id, bot ? "work" : null);
    // An untagged line to the only bot is still chat when that bot can't take it.
    if (refusal && bot && !route(false)) {
      bot = null;
      refusal = sendRefusal(roomId, person.id, null);
    }
    if (refusal) throw statusError(429, refusal);
  }
  const { entry, message } = writeRoomEntry(store, group, { author, text, ...(quote ? { replyToId: quote.id } : {}), ...(files.length ? { files } : {}) }, sendId, local);
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

/** The host's local file tags as words teammates can read. */
const roomCopy = (text: string) => text
  .replace(/<attached-image\s[^>]*>/g, "[image]")
  .replace(/<attached-file\s[^>]*>/g, (tag) => `[file: ${/\sname="([^"]*)"/.exec(tag)?.[1] ?? "file"}]`);

/** The host's line from the group box. In a bot group the thread row keeps the full text for the bots; the room gets a capped copy. */
export function hostSend(group: HostedGroup, text: string, replyTo?: Pick<Message, "id" | "roomEntryId">, sendId?: string) {
  const full = !peopleOnlyRoom(group.hosted.roomId);
  return hostedSend(group, { kind: "host" }, full ? roomCopy(text) : text, replyTo?.roomEntryId, sendId, [], { ...(full ? { text } : {}), ...(replyTo ? { replyToId: replyTo.id } : {}) });
}

/** A quote is clean when the host, a Trusted person or a clean bot answer wrote it. */
function cleanQuote(quote: RoomEntry | null, people: ReturnType<typeof roomPeople>): boolean {
  if (!quote || quote.author.kind === "host") return true;
  if (quote.author.kind === "bot") return quote.clean === true;
  return people.some((person) => person.id === quote.author.id && person.level === "trusted");
}
