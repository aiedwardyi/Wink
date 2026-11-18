import { attachedImages } from "./memory-pass.ts";
import { entryTime, type PickEntry } from "./picks.ts";
import type { BotRecord, Message, Store } from "./store.ts";

type Match = { thread: string; message: Message };

export function timelinePicks(entries: PickEntry[], bot: BotRecord, store: Pick<Store, "groups" | "messagesFor">): PickEntry[] {
  const legacy = entries.filter((entry) => !entry.messageId && (entry.picture || entry.overPictures.length || entry.files.length));
  if (!legacy.length) return entries;

  const times = new Set(legacy.map(entryTime));
  const threads = new Set(legacy.flatMap(({ thread }) => thread ? [thread] : []));
  if (legacy.some(({ thread }) => !thread)) {
    threads.add(bot.threadId);
    for (const task of bot.tasks ?? []) threads.add(task.threadId);
    for (const room of store.groups) {
      if (!room.memberIds.includes(bot.id)) continue;
      threads.add(room.threadId);
      for (const task of room.tasks ?? []) threads.add(task.threadId);
    }
  }
  const byThread = new Map<string, Map<number, Match | null>>();
  const all = new Map<number, Match | null>();
  const add = (map: Map<number, Match | null>, time: number, match: Match) => map.set(time, map.has(time) ? null : match);
  for (const thread of threads) {
    const local = new Map<number, Match | null>();
    byThread.set(thread, local);
    for (const message of store.messagesFor(thread)) {
      const time = message.actedAt ?? message.at;
      if (!times.has(time) || message.role !== "user" || message.kind !== "text" || message.from) continue;
      const match = { thread, message };
      add(local, time, match);
      add(all, time, match);
    }
  }
  const attachments = new Map<Match, Set<string>>();
  for (const entry of legacy) {
    const time = entryTime(entry);
    const match = (entry.at !== undefined || entry.id.includes(":")) && (entry.thread ? byThread.get(entry.thread)?.get(time) : all.get(time));
    if (!match) {
      delete entry.picture;
      entry.overPictures = [];
      entry.files = [];
      continue;
    }
    entry.thread = match.thread;
    if (entry.files.length) {
      const paths = attachments.get(match) ?? new Set(attachedImages(match.message.text ?? "").map((path) => path.toLowerCase()));
      attachments.set(match, paths);
      entry.files = entry.files.filter((path) => paths.has(path.toLowerCase()));
    }
  }
  return entries;
}
