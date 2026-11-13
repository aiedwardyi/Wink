// A shared bot group's runtime: what the answering bot is told about who
// asked, and the one room entry each finished turn leaves for every viewer.
import type { Message, Store } from "../store.ts";
import { askById, settleAsk, type HostedGroup, type RoomAsk } from "./asks.ts";
import { appendRoomEntry, committedRoomText, roomEntry, roomPeople } from "./db.ts";
import { broadcastDoorEntry } from "./door-streams.ts";
import { teamBots } from "./team-bots.ts";

/** The turn's last line to the bot: the teammates and words it answers, in order, so a delayed turn never answers the host's task instead. */
export function askNote(askId: string | undefined, botName: string, riders: readonly RoomAsk[] = []): string {
  const ask = askId ? askById(askId) : null;
  const asked = (ask ? [ask, ...riders] : []).flatMap((row) => roomEntry(row.roomId, row.entryId) ?? []);
  if (!asked.length) return `(Reply to the conversation above as ${JSON.stringify(botName)}.)`;
  const lines = asked.map((entry) => `${JSON.stringify(entry.author.name)} asked you: ${JSON.stringify(entry.text)}`).join(". Then ");
  return `(${lines}. Reply to them as ${JSON.stringify(botName)}.)`;
}

export function teammatesLine(group: { hosted?: { roomId: string } }): string {
  if (!group.hosted) return "";
  try {
    const people = roomPeople(group.hosted.roomId);
    const names = people.map((person) => person.name);
    const line = names.length ? `Teammates in this room: ${names.join(", ")}.` : "";
    const bots = teamBots(group.hosted.roomId).flatMap((bot) => {
      const owner = people.find((person) => person.id === bot.owner);
      return owner ? [`${JSON.stringify(bot.name)} (${JSON.stringify(owner.name)})`] : [];
    });
    return [line, bots.length && `Team bots (owner): ${bots.join(", ")}. Only their owner can ask them. Post a handoff plan here; ask its owner to @ it; never wait for it to join or reply first. Unlisted @names reach no one.`].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

const shown = (message: Message, botId: string) =>
  message.role === "bot" && message.kind === "text" && message.from?.botId === botId && !message.summarized && !message.queued && !message.quick && !message.comm && Boolean(message.text?.trim());

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
