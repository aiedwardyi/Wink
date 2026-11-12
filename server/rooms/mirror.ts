// The host's own view of a team room: each log entry, copied into the hosted
// thread from its committed value.
import type { GroupRecord, Message, Store } from "../store.ts";
import { appendRoomEntry, type RoomEntry, type RoomEntryDraft } from "./db.ts";
import { broadcastDoorEntry } from "./door-streams.ts";

type MirrorStore = Pick<Store, "appendMessage" | "messagesFor" | "bot">;

export type LocalRow = { text?: string; replyToId?: string };

function mirrorRoomEntry(store: MirrorStore, threadId: string, entry: RoomEntry, sendId?: string, local: LocalRow = {}): Message {
  const replyTo = local.replyToId ? { id: local.replyToId } : entry.replyToId && store.messagesFor(threadId).find((message) => message.roomEntryId === entry.replyToId);
  const bot = entry.author.kind === "bot" ? store.bot(entry.author.id) : undefined;
  return store.appendMessage(threadId, {
    role: entry.author.kind === "bot" ? "bot" : "user",
    kind: "text",
    text: local.text ?? entry.text,
    at: entry.at,
    author: entry.author,
    roomEntryId: entry.id,
    ...(entry.author.kind === "person" ? { origin: "person" } : {}),
    ...(entry.author.kind === "bot" ? { from: { botId: entry.author.id, name: entry.author.name, color: bot?.color ?? "" } } : {}),
    ...(replyTo ? { replyToId: replyTo.id } : {}),
    ...(sendId ? { sendId } : {}),
    ...(entry.files ? { roomFiles: entry.files } : {}),
  });
}

/** Commit one entry to the room log, then mirror that committed row, or the host's own `local` row. */
export function writeRoomEntry(store: MirrorStore, group: GroupRecord & { hosted: { roomId: string } }, draft: RoomEntryDraft, sendId?: string, local?: LocalRow) {
  const entry = appendRoomEntry(group.hosted.roomId, draft);
  broadcastDoorEntry(group.hosted.roomId, entry);
  return { entry, message: mirrorRoomEntry(store, group.threadId, entry, sendId, local) };
}
