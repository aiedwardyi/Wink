import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { attachedImages, eligibleRow, quotes, userTyping } from "./memory-pass.ts";
import { holdSources, replyTurns, sharedSources, validatePickBinding } from "./pick-sources.ts";
import { entryTime, type PickEntry } from "./picks.ts";
import type { BotRecord, Message, Store } from "./store.ts";

type Match = { thread: string; message: Message };

const hasPictures = (entry: PickEntry) => Boolean(entry.picture || entry.overPictures.length);
const exactTime = (entry: PickEntry) => entry.at ?? (/:\d{2}\.\d{3}(?: \(\d+\))?$/.test(entry.id) ? entryTime(entry) : undefined);
const sourceKey = (thread: string | undefined, id: string) => JSON.stringify([thread, id]);
const minuteOf = (entry: PickEntry) => !entry.binding && !entry.messageId && exactTime(entry) === undefined && /^\d{4}-\d\d-\d\d \d\d:\d\d(?: \(\d+\))?$/.test(entry.id) ? entryTime(entry) : undefined;
const pictureClaim = ({ path, caption }: { path: string; caption?: string }) => caption ? `${path} (${caption})` : path;

export function timelinePicks(entries: PickEntry[], bot: BotRecord, store: Pick<Store, "groups" | "messagesFor">): PickEntry[] {
  const pending = entries.filter((entry) => entry.binding === "unbound" || (!entry.binding && (entry.messageId || hasPictures(entry) || entry.files.length)));
  if (!pending.length) return soleSources(entries);

  const precise = pending.filter((entry) => entry.binding !== "unbound" && exactTime(entry) !== undefined);
  const loose = pending.filter((entry) => minuteOf(entry) !== undefined);
  const times = new Set(precise.map(exactTime));
  const minutes = new Set(loose.map(minuteOf));
  const threads = new Set(precise.flatMap(({ thread }) => thread ? [thread] : []));
  if ([...precise, ...loose].some(({ thread }) => !thread)) {
    threads.add(bot.threadId);
    for (const task of bot.tasks ?? []) threads.add(task.threadId);
    for (const room of store.groups) {
      if (!room.memberIds.includes(bot.id)) continue;
      threads.add(room.threadId);
      for (const task of room.tasks ?? []) threads.add(task.threadId);
    }
  }
  const byTime = new Map<string, Match | null>();
  const byId = new Map<string, Match | null>();
  const byMinute = new Map<string, Match | null>();
  const add = (map: Map<string, Match | null>, key: string, match: Match) => map.set(key, map.has(key) ? null : match);
  const rows = new Map<string, Message[]>();
  for (const thread of threads) {
    const messages = store.messagesFor(thread);
    rows.set(thread, messages);
    for (const message of messages) {
      const at = message.actedAt ?? message.at;
      const minute = at - (at % 60_000);
      if ((!times.has(at) && !minutes.has(minute)) || !eligibleRow(message)) continue;
      const match = { thread, message };
      if (times.has(at)) {
        add(byTime, sourceKey(thread, String(at)), match);
        add(byTime, sourceKey(undefined, String(at)), match);
        add(byId, sourceKey(thread, message.id), match);
      }
      if (minutes.has(minute)) {
        add(byMinute, sourceKey(thread, String(minute)), match);
        add(byMinute, sourceKey(undefined, String(minute)), match);
      }
    }
  }
  const replies = new Map<string, string[]>();
  const claimed = new Set(entries.flatMap((entry) => entry.binding === "verified" && entry.messageId ? [sourceKey(entry.thread, entry.messageId)] : []));
  const duplicate = new Set<string>();
  const matches = pending.map((entry) => {
    const time = exactTime(entry);
    const minute = minuteOf(entry);
    if (entry.binding === "unbound" || (time === undefined && minute === undefined)) return undefined;
    const match = entry.messageId ? byId.get(sourceKey(entry.thread, entry.messageId))
      : time === undefined ? byMinute.get(sourceKey(entry.thread, String(minute))) : byTime.get(sourceKey(entry.thread, String(time)));
    if (!match || (entry.said !== undefined && !quotes(userTyping(match.message.text ?? ""), entry.said))) return undefined;
    const key = sourceKey(match.thread, match.message.id);
    if (claimed.has(key)) duplicate.add(key);
    claimed.add(key);
    if (entry.questionId || hasPictures(entry)) {
      const ids = replies.get(match.thread) ?? [];
      ids.push(match.message.id);
      replies.set(match.thread, ids);
    }
    return match;
  });
  const turns = new Map([...replies].map(([thread, ids]) => [thread, replyTurns(rows.get(thread)!, ids, join(DATA_DIR, "attachments"))]));
  for (const [i, entry] of pending.entries()) {
    const match = matches[i];
    const unique = match && !duplicate.has(sourceKey(match.thread, match.message.id));
    const binding = validatePickBinding({
      ...entry, at: exactTime(entry), picture: entry.picture && pictureClaim(entry.picture), overPictures: entry.overPictures.map(pictureClaim),
    }, unique && match ? {
      ...turns.get(match.thread)?.get(match.message.id), id: match.message.id, thread: match.thread,
      at: match.message.actedAt ?? match.message.at, files: entry.files.length ? attachedImages(match.message.text ?? "") : [],
    } : undefined);
    entry.picture = binding?.picture;
    entry.overPictures = binding?.overPictures ?? [];
    entry.files = binding?.files ?? [];
    if (binding) entry.thread = binding.thread;
    else if (entry.messageId || entry.binding === "unbound" || entry.at !== undefined) {
      delete entry.at;
      entry.binding = "unbound";
    }
  }
  return soleSources(entries);
}

function soleSources(entries: PickEntry[]): PickEntry[] {
  for (const entry of sharedSources(entries)) holdSources(entry);
  return entries;
}
