// What a team room's bot reads: committed log entries only, newest last.
import type { RoomEntry } from "./db.ts";

export const WINDOW_ENTRIES = 30;
export const WINDOW_CHARS = 24_000;

function newest(entries: readonly RoomEntry[]): RoomEntry[] {
  const out: RoomEntry[] = [];
  let chars = 0;
  for (let i = entries.length - 1; i >= 0 && out.length < WINDOW_ENTRIES; i--) {
    chars += entries[i]!.text.length;
    if (chars > WINDOW_CHARS) break;
    out.unshift(entries[i]!);
  }
  return out;
}

/** A words answer sees what everyone in the room sees. */
export function wordsWindow(entries: readonly RoomEntry[]): RoomEntry[] {
  return newest(entries);
}

/** A work turn reads every member like the host, and clean bot answers to
 * them. An answer whose ask is not in `entries` is dropped. */
export function workWindow(entries: readonly RoomEntry[]): RoomEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const member = (entry: RoomEntry | undefined) => entry?.author.kind === "host" || entry?.author.kind === "person";
  return newest(entries.filter((entry) => entry.author.kind === "bot"
    ? entry.clean === true && entry.replyToId !== undefined && member(byId.get(entry.replyToId))
    : member(entry)));
}
