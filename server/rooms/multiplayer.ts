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

/** A teammate's ask as a lane may hand it off: who asked, in their own words. */
export function laneAsk(askId: string): { asker: string; ask: string } | null {
  const ask = askById(askId);
  const entry = ask && roomEntry(ask.roomId, ask.entryId);
  return entry ? { asker: entry.author.name, ask: entry.text } : null;
}

/** `refusal` is what the bot says when someone read-only asks it to do more than read. */
export const collabLine = (refusal: string) =>
  `Any member's request here is collab work for this team: help them as you would your owner. Someone read-only may ask you to read, explain and answer, but not to change files, run commands, use connected apps or ask other bots; instead of trying, tell them plainly: "${refusal}"`;

export const COLLAB_LINE = collabLine("The host has to turn this on for you.");

export const REACH_LINE = "Each is on its owner's PC; only @ here reaches it.";

export function teammatesLine(group: { hosted?: { roomId: string } }): string {
  if (!group.hosted) return "";
  try {
    const people = roomPeople(group.hosted.roomId);
    const names = people.map((person) => (person.works ? person.name : `${person.name} (read-only)`));
    const line = names.length ? `Teammates in this room: ${names.join(", ")}. ${COLLAB_LINE}` : "";
    const bots = teamBots(group.hosted.roomId).flatMap((bot) => {
      const owner = people.find((person) => person.id === bot.owner);
      return owner ? [`${JSON.stringify(bot.name)} (${JSON.stringify(owner.name)})`] : [];
    });
    return [line, bots.length && `Team bots (owner): ${bots.join(", ")}. ${REACH_LINE} @ one only to hand it real work, never just to thank or confirm; it answers here. When the job is done, say so and tag no bot. Unlisted @names reach no one.`].filter(Boolean).join("\n");
  } catch {
    return "";
  }
}

// a row already linked is a room line of its own, like an ask's "Cancelled."
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
