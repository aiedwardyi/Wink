// The host's own view of a team room: each log entry, copied into the hosted
// thread from its committed value.
import type { GroupRecord, Message, Store } from "../store.ts";
import { appendRoomEntry, type RoomEntry, type RoomEntryDraft } from "./db.ts";

type MirrorStore = Pick<Store, "appendMessage" | "messagesFor" | "bot">;

function mirrorRoomEntry(store: MirrorStore, threadId: string, entry: RoomEntry): Message {
  const replyTo = entry.replyToId && store.messagesFor(threadId).find((message) => message.roomEntryId === entry.replyToId);
  const bot = entry.author.kind === "bot" ? store.bot(entry.author.id) : undefined;
  return store.appendMessage(threadId, {
    role: entry.author.kind === "bot" ? "bot" : "user",
    kind: "text",
    text: entry.text,
    at: entry.at,
    author: entry.author,
    roomEntryId: entry.id,
    ...(entry.author.kind === "person" ? { origin: "person" } : {}),
    ...(entry.author.kind === "bot" ? { from: { botId: entry.author.id, name: entry.author.name, color: bot?.color ?? "" } } : {}),
    ...(replyTo ? { replyToId: replyTo.id } : {}),
  });
}

/** Commit one entry to the room log, then mirror that committed row. */
export function writeRoomEntry(store: MirrorStore, group: GroupRecord & { hosted: { roomId: string } }, draft: RoomEntryDraft) {
  const entry = appendRoomEntry(group.hosted.roomId, draft);
  return { entry, message: mirrorRoomEntry(store, group.threadId, entry) };
}
