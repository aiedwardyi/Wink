// Every message into a team room: the host's through the normal send route,
// a person's through the door. The host's line is only committed here: the
// normal group turn answers it. A person's wakes one bot, at most, with an ask.
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";

import { botChain, CHAIN_LINES, handoffTarget, republishWhenLapsed, type ChainLapses } from "../../shared/bot-chain.ts";
import { roomResponder } from "../../shared/room-routing.ts";
import { sharableLocalFile } from "../attachments.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { alertWhenUnread, roomLineText, type RoomAlert } from "./alerts.ts";
import { broadcastDoorEntry, broadcastDoorStop } from "./door-streams.ts";
import { appendRoomEntry, committedRoomText, recentRoomEntries, roomById, roomEntry, roomPeople, RoomError, type RoomAuthor, type RoomEntry, type RoomPerson } from "./db.ts";
import { copyRoomFile, discardUnpostedRoomFile, MAX_MESSAGE_FILES, ownRoomFiles } from "./files.ts";
import { writeRoomEntry, type LocalRow } from "./mirror.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { askById, createAsk, roomAskDeps, roomAsks, runAsk, type HostedGroup } from "./asks.ts";
import { teamBots, type TeamBot } from "./team-bots.ts";

export type RoomSender = { kind: "host" } | { kind: "person"; id: string };

/** Rooms whose bot lines wake no bot until a person or the host speaks again. */
const stopped = new Set<string>();
/** This run's start: a handoff line from before it is no longer pending. */
const BOOT = Date.now();
const lapses: ChainLapses = new Map();
const alerts = new Map<string, RoomAlert>();

const groupBots = (group: HostedGroup) => group.memberIds.flatMap((id) => {
  const bot = roomAskDeps().store.bot(id);
  return bot && !bot.hidden ? [bot] : [];
});

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
  const bots = groupBots(group);
  // Teammates' bots answer only on their owners' PCs, so their names and lines wake none here.
  const roomBots = teamBots(roomId);
  const quotesRoomBot = roomBots.some((roomBot) => roomBot.id === quote?.author.id) || Boolean(quote?.author.owner);
  const nonWaking = [hostName(), ...people.map((candidate) => candidate.name)];
  const bot = !person || peopleOnlyRoom(roomId) ? null : roomResponder(committedRoomText(author.kind, text), bots, nonWaking, quote?.author.kind === "bot" ? quote.author.id : undefined, !quotesRoomBot, roomBots.map((roomBot) => roomBot.name));
  const ended = !person && liveBotChain(group) > 0;
  const { entry, message } = writeRoomEntry(store, group, { author, text, ...(quote ? { replyToId: quote.id } : {}), ...(files.length ? { files } : {}) }, sendId, local);
  stopped.delete(roomId);
  // the host's line ends a handoff; republish the group so its strip clears
  if (ended) store.patchGroup(group.id, {});
  if (person) markPersonLine(group, entry, person.name);
  if (!bot || !person) return { entry, message, ask: null };
  const ask = createAsk({
    roomId,
    threadId: group.threadId,
    botId: bot.id,
    asker: { kind: "person", id: person.id },
    entryId: entry.id,
    ...(quote ? { quoteId: quote.id } : {}),
    grant: "work",
    clean: cleanQuote(quote),
  });
  runAsk(ask);
  return { entry, message, ask: askById(ask.id) };
}

function markPersonLine(group: HostedGroup, entry: RoomEntry, name: string, ping = true): void {
  const { store, alert } = roomAskDeps();
  store.patchGroup(group.id, { unread: true });
  const line = { chat: group.id, threadId: group.threadId, room: group.name, name, text: roomLineText(entry.text, entry.files) };
  if (ping) alertWhenUnread(line, () => store.group(group.id)?.unread === true, alert, undefined, alerts);
}

/** Room Stop ends a bot chain here and on every joined PC. */
export function stopBotChain(roomId: string): void {
  stopped.add(roomId);
  broadcastDoorStop(roomId);
}

/** Bot lines in the room's live handoff, for the strip; 0 when none is live or Stop ended it. */
export function liveBotChain(group: HostedGroup): number {
  const roomId = group.hosted.roomId;
  if (stopped.has(roomId)) return 0;
  try {
    const { store, hostName } = roomAskDeps();
    const lines = recentRoomEntries(roomId, CHAIN_LINES);
    const last = lines.at(-1);
    const hostBots = groupBots(group);
    const working = (botId: string) => {
      // a teammate's bot works on its owner's PC
      if (!hostBots.some((bot) => bot.id === botId)) return null;
      if (group.busyBotId === botId || roomAsks(roomId, ["queued", "running"]).some((ask) => ask.botId === botId)) return true;
      // a host bot's @ starts its hop a moment after the line; a teammate's bot's ask is made with it
      return hostBots.some((bot) => bot.id === last?.author.id) ? null : false;
    };
    const turn = botChain(lines, [...hostBots, ...teamBots(roomId)], [hostName(), ...roomPeople(roomId).map((person) => person.name)], { working, since: BOOT });
    if (turn && last) republishWhenLapsed(lapses, roomId, last.at, () => store.patchGroup(group.id, {}));
    return turn;
  } catch {
    // group state goes out before room asks are configured, and for a missing room
    return 0;
  }
}

/** A teammate's bot answer from its owner's PC: counted as the owner's line, with `fileIds` the owner uploaded. Its @ to a host bot asks under the owner. */
export function teamBotSend(group: HostedGroup, owner: RoomPerson, bot: TeamBot, text: string, replyToId?: string, sendId?: string, fileIds: readonly string[] = []): RoomEntry {
  const roomId = group.hosted.roomId;
  const quote = replyToId === undefined ? null : roomEntry(roomId, replyToId);
  if (replyToId !== undefined && !quote) throw new RoomError(404, "no such message in this room");
  const files = fileIds.length ? ownRoomFiles(roomId, owner.id, fileIds) : [];
  const author: RoomAuthor = { kind: "bot", id: bot.id, name: bot.name, owner: owner.id };
  const { entry } = writeRoomEntry(roomAskDeps().store, group, { author, text, ...(quote ? { replyToId: quote.id } : {}), ...(files.length ? { files } : {}) }, sendId);
  const people = roomPeople(roomId);
  const bots = groupBots(group);
  const tagged = handoffTarget(entry, [...bots, ...teamBots(roomId)], [roomAskDeps().hostName(), ...people.map((person) => person.name)]);
  // a handoff pings no one; the line that closes it does
  markPersonLine(group, entry, bot.name, !tagged);
  const hit = stopped.has(roomId) || peopleOnlyRoom(roomId) ? null : tagged;
  const asked = bots.find((candidate) => candidate.id === hit?.id);
  if (asked) {
    runAsk(createAsk({
      roomId,
      threadId: group.threadId,
      botId: asked.id,
      asker: { kind: "person", id: owner.id },
      entryId: entry.id,
      ...(quote ? { quoteId: quote.id } : {}),
      grant: "work",
      clean: cleanQuote(quote),
    }));
  }
  return entry;
}

/** The host's local file tags as words teammates can read. */
const roomCopy = (text: string) => text
  .replace(/<attached-image\s[^>]*>/g, "[image]")
  .replace(/<attached-file\s[^>]*>/g, (tag) => `[file: ${/\sname="([^"]*)"/.exec(tag)?.[1] ?? "file"}]`);

const LOCAL_TAG = /<attached-(image|file)\s+path="([^"]*)"((?:\s+[a-z]+="[^"]*")*)\s*\/?>/g;
const ENTITY: Record<string, string> = { quot: "\"", lt: "<", gt: ">", amp: "&" };
const attribute = (value = "") => value.replace(/&(?:#(\d+)|(\w+));/g, (entity, code?: string, name?: string) => (code ? String.fromCharCode(Number(code)) : ENTITY[name!] ?? entity));

/** A tag's file when the composer could have attached it; a typed or pasted tag for any other path is only words. */
function sharable(group: HostedGroup, path: string, copy = ""): string | null {
  const roots = [group.cwd, ...groupBots(group).map((bot) => bot.cwd)].filter((root): root is string => Boolean(root));
  try {
    return sharableLocalFile(path, roots).path;
  } catch {
    // a desktop file outside the projects goes as the composer's upload of it, unless the file itself is private
    if (!copy) return null;
  }
  try {
    sharableLocalFile(path, [homedir(), ...roots]);
    return sharableLocalFile(copy, []).path;
  } catch {
    return null;
  }
}

/** The host's attached pictures and files in order; a big picture's smaller copy is not one of them. */
function localFiles(text: string): Array<{ path: string; name: string; copy: string }> {
  const tags = [...text.matchAll(LOCAL_TAG)].map(([, kind, path, rest]) => ({
    file: kind === "file",
    path: attribute(path),
    name: attribute(/\sname="([^"]*)"/.exec(rest!)?.[1]),
    preview: attribute(/\spreview="([^"]*)"/.exec(rest!)?.[1]),
    copy: attribute(/\scopy="([^"]*)"/.exec(rest!)?.[1]),
  }));
  const previews = new Set(tags.map((tag) => tag.preview));
  return tags
    .filter((tag) => tag.path && (tag.file || !previews.has(tag.path)))
    .map(({ path, name, copy }) => ({ path, name: name || path.split(/[\\/]/).pop()!, copy }));
}

/** Copies the host's attached files into a room with people and bots, as a teammate's upload; a retry of `sendId` reuses them. */
export async function hostRoomFiles(group: HostedGroup, text: string, sendId?: string): Promise<string[]> {
  if (peopleOnlyRoom(group.hosted.roomId)) return [];
  const files = localFiles(text).flatMap((file) => {
    const path = sharable(group, file.path, file.copy);
    return path ? [{ ...file, path }] : [];
  });
  if (files.length > MAX_MESSAGE_FILES) throw Object.assign(new RoomError(400, `at most ${MAX_MESSAGE_FILES} files per message`), { code: "ROOM_FILE" });
  const ids: string[] = [];
  for (const [at, file] of files.entries()) {
    const uploadId = sendId ? createHash("sha256").update(`${sendId}\n${at}\n${file.path}`).digest("base64url") : randomBytes(18).toString("base64url");
    try {
      ids.push((await copyRoomFile(file.path, group.hosted.roomId, { owner: "host", name: file.name, uploadId })).id);
    } catch (error) {
      throw Object.assign(error as Error, { code: "ROOM_FILE", file: file.name });
    }
  }
  return ids;
}

export function captureHostBotPicture(store: Pick<Store, "groupByThread" | "messagesFor">, bot: BotRecord, threadId: string, interrupted: () => boolean) {
  const group = store.groupByThread(threadId);
  if (!group?.hosted || group.threadId !== threadId || !roomById(group.hosted.roomId) || peopleOnlyRoom(group.hosted.roomId)) return null;
  const roomId = group.hosted.roomId;
  const ask = roomAsks(roomId, ["running", "stopping"]).find((candidate) => candidate.threadId === threadId && candidate.botId === bot.id);
  const check = () => {
    if (interrupted() || (ask && askById(ask.id)?.state !== "running")) throw new RoomError(409, "the turn was stopped");
    return true;
  };
  return async (path: string, name: string, caption: string) => {
    check();
    const file = await copyRoomFile(path, roomId, { owner: "host", name, uploadId: randomBytes(18).toString("base64url"), still: check });
    try {
      check();
      const entry = appendRoomEntry(roomId, {
        author: { kind: "bot", id: bot.id, name: bot.name }, text: caption, files: [file],
        ...(ask ? { replyToId: ask.entryId, askId: ask.id, grant: ask.grant, clean: ask.clean } : {}),
      });
      broadcastDoorEntry(roomId, entry);
      const replyToId = ask ? store.messagesFor(threadId).find((message) => message.roomEntryId === ask.entryId)?.id : undefined;
      return { roomEntryId: entry.id, roomFiles: [file], replyToId, url: `/api/rooms/${roomId}/files/${file.id}/preview` };
    } catch (error) {
      discardUnpostedRoomFile(roomId, file.id);
      throw error;
    }
  };
}

/** The host's line from the group box. In a bot group the thread row keeps the full text for the bots; the room gets a capped copy, with `fileIds` from hostRoomFiles in place of the tags. */
export function hostSend(group: HostedGroup, text: string, replyTo?: Pick<Message, "id" | "roomEntryId">, sendId?: string, fileIds: readonly string[] = []) {
  const full = !peopleOnlyRoom(group.hosted.roomId);
  const room = !full ? text : fileIds.length ? text.replace(LOCAL_TAG, (tag, _kind, path: string, rest: string) => (sharable(group, attribute(path), attribute(/\scopy="([^"]*)"/.exec(rest)?.[1])) ? "" : roomCopy(tag))).trim() : roomCopy(text);
  return hostedSend(group, { kind: "host" }, room, replyTo?.roomEntryId, sendId, fileIds, { ...(full ? { text } : {}), ...(replyTo ? { replyToId: replyTo.id } : {}) });
}

/** Every member's line counts like the host's; a bot's quote is clean when its answer was. */
const cleanQuote = (quote: RoomEntry | null) => quote?.author.kind !== "bot" || quote.clean === true;
