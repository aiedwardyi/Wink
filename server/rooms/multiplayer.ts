// A shared bot group's runtime: what the answering bot is told about who
// asked, and the one room entry each finished turn leaves for every viewer.
import type { Message, Store } from "../store.ts";
import { askById, settleAsk, type HostedGroup } from "./asks.ts";
import { appendRoomEntry, committedRoomText, roomEntry, roomPeople } from "./db.ts";
import { broadcastDoorEntry } from "./door-streams.ts";

/** The turn's last line to the bot: the teammate and words it answers, so a delayed turn never answers the host's task instead. */
export function askNote(askId: string | undefined, botName: string): string {
  const ask = askId ? askById(askId) : null;
  const asked = ask ? roomEntry(ask.roomId, ask.entryId) : null;
  return asked ? `(${asked.author.name} asked you: "${asked.text}". Reply to them as ${botName}.)` : `(Reply to the conversation above as ${botName}.)`;
}

export function teammatesLine(group: { hosted?: { roomId: string } }): string {
  if (!group.hosted) return "";
  try {
    const names = roomPeople(group.hosted.roomId).map((person) => person.name);
    return names.length ? `Teammates in this room: ${names.join(", ")}.` : "";
  } catch {
    return "";
  }
}

const shown = (message: Message, botId: string) =>
  message.role === "bot" && message.kind === "text" && message.from?.botId === botId && !message.summarized && !message.queued && !message.quick && !message.comm && !message.roomEntryId && Boolean(message.text?.trim());

/** A settled turn's shown words as one bot entry. Its thread row is linked by `roomEntryId`, never copied. */
export function publishTurnAnswer(store: Pick<Store, "messagesFor" | "patchMessage">, group: HostedGroup, threadId: string, bot: { id: string; name: string }, since: number, askId?: string): void {
  if (threadId !== group.threadId) return;
  const rows = store.messagesFor(threadId).slice(since).filter((message) => shown(message, bot.id));
  const text = committedRoomText("bot", rows.map((row) => row.text).join("\n\n"));
  const ask = askId ? settleAsk(askId, Boolean(text)) : null;
  if (!text || (askId && !ask)) return;
  const entry = appendRoomEntry(group.hosted.roomId, {
    author: { kind: "bot", id: bot.id, name: bot.name },
    text,
    ...(ask ? { replyToId: ask.entryId, askId: ask.id, grant: "work" as const, clean: ask.clean } : {}),
  });
  broadcastDoorEntry(group.hosted.roomId, entry);
  store.patchMessage(threadId, rows.at(-1)!.id, { roomEntryId: entry.id });
}
