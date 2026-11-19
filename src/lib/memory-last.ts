// The last memory read per bot, kept where it survives a relaunch, so the Memory page paints it
// while its fresh read is out instead of an empty frame. The fresh read always replaces it.
import { z } from "zod";

import type { MemoryTopic } from "@/components/MemoryGroups";

export interface MemoryShown {
  text: string;
  truncated: boolean;
  topics: MemoryTopic[];
}

export const MEMORY_LAST_KEY = "omb-memory-last";
// MEMORY.md runs to 256 KB, so the bots read longest ago drop out before this crowds drafts out of localStorage
export const MEMORY_LAST_MAX_CHARS = 400_000;

const entrySchema = z.object({
  botId: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  topics: z.array(z.object({ name: z.string(), bytes: z.number() })),
});

function read(): z.infer<typeof entrySchema>[] {
  try {
    const parsed = z.array(entrySchema).safeParse(JSON.parse(localStorage.getItem(MEMORY_LAST_KEY) ?? "[]"));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function lastMemory(botId: string): MemoryShown | null {
  const found = read().find((each) => each.botId === botId);
  return found ? { text: found.text, truncated: found.truncated, topics: found.topics } : null;
}

export function rememberMemory(botId: string, { text, truncated, topics }: MemoryShown): void {
  store([{ botId, text, truncated, topics: topics.map(({ name, bytes }) => ({ name, bytes })) }, ...read().filter((each) => each.botId !== botId)]);
}

/** A save from this page: the kept copy takes its text, so the next open never paints the text from before it. */
export function keepSaved(botId: string, text: string, truncated: boolean): void {
  const entries = read();
  const found = entries.find((each) => each.botId === botId);
  if (!found) return;
  store(entries.map((each) => (each === found ? { ...each, text, truncated } : each)));
}

/** Memory changed somewhere this page did not write, or the bot is gone. */
export function forgetMemory(botId: string): void {
  const entries = read();
  if (entries.some((each) => each.botId === botId)) store(entries.filter((each) => each.botId !== botId));
}

function store(entries: z.infer<typeof entrySchema>[]): void {
  let json = JSON.stringify(entries);
  while (entries.length && json.length > MEMORY_LAST_MAX_CHARS) {
    entries.pop();
    json = JSON.stringify(entries);
  }
  try {
    localStorage.setItem(MEMORY_LAST_KEY, json);
  } catch {
    /* quota / private mode - the page just waits for its read */
  }
}
