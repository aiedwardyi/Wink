// Every message into a team room: the host's through the normal send route,
// a person's through the door. The host's line is only committed here: the
// normal group turn answers it. A person's wakes one bot, at most, with an ask.
import { roomResponder } from "../../shared/room-routing.ts";
import type { Message } from "../store.ts";
import { alertWhenUnread, roomLineText } from "./alerts.ts";
import { committedRoomText, roomEntry, roomPeople, RoomError, type RoomAuthor, type RoomEntry, type RoomPerson } from "./db.ts";
import { ownRoomFiles } from "./files.ts";
import { writeRoomEntry, type LocalRow } from "./mirror.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { askById, createAsk, roomAskDeps, runAsk, sendRefusal, spend, type HostedGroup } from "./asks.ts";
import { teamBots, type TeamBot } from "./team-bots.ts";

export type RoomSender = { kind: "host" } | { kind: "person"; id: string };

const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

export function hostedSend(group: HostedGroup, sender: RoomSender, text: string, replyToId?: string, sendId?: string, fileIds: readonly string[] = [], local?: LocalRow) {
  const { store, hostName } = roomAskDeps();
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
  // Teammates' bots answer only on their owners' PCs, so their names and lines wake none here.
  const roomBots = teamBots(roomId);
  const quotesRoomBot = roomBots.some((roomBot) => roomBot.id === quote?.author.id) || Boolean(quote?.author.owner);
  const nonWaking = [hostName(), ...people.map((candidate) => candidate.name), ...roomBots.map((roomBot) => roomBot.name)];
  let bot = !person || peopleOnlyRoom(roomId) ? null : roomResponder(committedRoomText(author.kind, text), bots, nonWaking, quote?.author.kind === "bot" ? quote.author.id : undefined, !quotesRoomBot);
  if (person) {
    let refusal = sendRefusal(roomId, person.id, bot ? "work" : null);
    const solo = Boolean(refusal && bot && bots.length === 1);
    // The only bot takes a line after its current turn, tagged or not, like a 1:1 queue.
    if (solo) refusal = sendRefusal(roomId, person.id, "work", true);
    // A line to the only bot is still chat when that bot can't take it.
    if (refusal && solo) {
      bot = null;
      refusal = sendRefusal(roomId, person.id, null);
    }
    if (refusal) throw statusError(429, refusal);
  }
  const { entry, message } = writeRoomEntry(store, group, { author, text, ...(quote ? { replyToId: quote.id } : {}), ...(files.length ? { files } : {}) }, sendId, local);
  if (person) markPersonLine(group, person, entry, person.name);
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

function markPersonLine(group: HostedGroup, person: RoomPerson, entry: RoomEntry, name: string): void {
  const { store, alert } = roomAskDeps();
  spend(group.hosted.roomId, person.id, "message");
  store.patchGroup(group.id, { unread: true });
  const line = { chat: group.id, threadId: group.threadId, room: group.name, name, text: roomLineText(entry.text, entry.files) };
  alertWhenUnread(line, () => store.group(group.id)?.unread === true, alert);
}

/** A teammate's bot answer from its owner's PC: counted as the owner's line, and it wakes no bot. */
export function teamBotSend(group: HostedGroup, owner: RoomPerson, bot: TeamBot, text: string, replyToId?: string, sendId?: string): RoomEntry {
  const roomId = group.hosted.roomId;
  const quote = replyToId === undefined ? null : roomEntry(roomId, replyToId);
  if (replyToId !== undefined && !quote) throw new RoomError(404, "no such message in this room");
  const refusal = sendRefusal(roomId, owner.id, null);
  if (refusal) throw statusError(429, refusal);
  const author: RoomAuthor = { kind: "bot", id: bot.id, name: bot.name, owner: owner.id };
  const { entry } = writeRoomEntry(roomAskDeps().store, group, { author, text, ...(quote ? { replyToId: quote.id } : {}) }, sendId);
  markPersonLine(group, owner, entry, bot.name);
  return entry;
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
