// Boot reads of threads the store has not loaded, from their newest rows, so opening the app parses no whole transcript.
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { offscreenLimit } from "./chat-tail.ts";
import type { TailRead, TailReply, TailRequest } from "./cold-thread-worker.ts";
import { lastRowid, messageDbFile, threadOver, type ThreadRows } from "./message-db.ts";
import { paneReason, type PaneLine } from "../shared/pane-note.ts";
import type { Message, Store } from "./store.ts";

type Tail = ThreadRows & { options: Message[] };

type Read = <R extends TailRead>(request: R) => Promise<TailReply<R>>;

let reader: Read | undefined;
// its own worker: Map's scans of a long chat would hold up the chat pages queued behind them
let scans: Read | undefined;

/** Spawns cold-thread-worker.ts: on a cold disk a 237k-row chat's tail held the thread that serves the app ~800 ms. */
function startReader(): Read {
  const source = new URL("./cold-thread-worker.ts", import.meta.url);
  const entry = existsSync(source) ? source : new URL("./cold-thread-worker.js", import.meta.url);
  const worker = new Worker(entry, { execArgv: entry.pathname.endsWith(".ts") ? ["--experimental-strip-types"] : [] });
  worker.unref();
  const waiting = new Map<number, { resolve: (value: TailReply<TailRead>) => void; reject: (error: Error) => void }>();
  let next = 0;
  worker.on("message", (reply: { id: number; value?: TailReply<TailRead>; error?: string }) => {
    const wait = waiting.get(reply.id);
    waiting.delete(reply.id);
    if (reply.value) wait?.resolve(reply.value);
    else wait?.reject(new Error(reply.error));
  });
  const read: Read = <R extends TailRead>(request: R) => new Promise<TailReply<R>>((resolve, reject) => {
    const id = ++next;
    // SAFETY: the worker answers each request with the reply its kind names.
    waiting.set(id, { resolve: (value) => resolve(value as TailReply<R>), reject });
    worker.postMessage({ ...request, id, file: messageDbFile() } satisfies TailRequest);
  });
  const stopped = (error: Error) => {
    if (reader === read) reader = undefined;
    if (scans === read) scans = undefined;
    for (const wait of waiting.values()) wait.reject(error);
    waiting.clear();
  };
  worker.once("error", stopped);
  worker.once("exit", () => stopped(new Error("the cold thread reader stopped")));
  return read;
}

/** The newest `count` rows, chained as Store.thread() chains legacy rows; the oldest stays unchained unless all rows came back. */
function chained(tail: Tail, count: number): Tail {
  let previous: string | null | undefined = tail.messages.length < count ? null : undefined;
  for (const message of tail.messages) {
    if (message.parentId === undefined && previous !== undefined) message.parentId = previous;
    previous = message.id;
  }
  return tail;
}

/** The rows messagePage would send, or null when the store must answer (loaded, or no rows here so a legacy file imports). */
export async function chatListPage(
  store: Pick<Store, "loaded">,
  threadId: string,
  limit: number,
  offscreen?: { unread?: boolean; readAt?: number },
): Promise<{ messages: Message[]; hasMore: boolean } | null> {
  if (store.loaded(threadId)) return null;
  let tail: Tail;
  try {
    // one row past the page: offscreenLimit compares the first page row's parent with it
    tail = await (reader ??= startReader())({ threadId, count: limit + 1 });
  } catch (error) {
    console.error("cold page read failed; the store answers", threadId, error);
    return null;
  }
  // a write during the read loaded the chat, and its newest rows may not be saved yet
  if (store.loaded(threadId) || !tail.messages.length) return null;
  const { messages, options, activeLeafId } = chained(tail, limit + 1);
  const rows = offscreen ? offscreenLimit(messages, limit, offscreen, activeLeafId || messages.at(-1)!.id, options) : limit;
  const start = Math.max(0, messages.length - rows);
  return { messages: messages.slice(start), hasMore: start > 0 };
}

// per chat, its write rows read while no row is added: each Map refresh asks again
const writeRows = new Map<string, { cursor: number; rows: Promise<Message[]> }>();

/** The rows that wrote files, or null when the store must answer (loaded, no rows here, or the read failed). */
export async function coldWriteRows(store: Pick<Store, "loaded">, threadId: string): Promise<Message[] | null> {
  if (store.loaded(threadId)) return null;
  const cursor = lastRowid(threadId);
  if (cursor === undefined) return null;
  let read = writeRows.get(threadId);
  if (read?.cursor !== cursor) {
    read = { cursor, rows: (scans ??= startReader())({ threadId, writes: true }).then((tail) => tail.messages) };
    writeRows.set(threadId, read);
  }
  let rows: Message[];
  try {
    rows = await read.rows;
  } catch (error) {
    if (writeRows.get(threadId) === read) writeRows.delete(threadId);
    console.error("cold write rows read failed; the store answers", threadId, error);
    return null;
  }
  // a write during the read loaded the chat, and its newest rows may not be saved yet
  return store.loaded(threadId) ? null : rows;
}

// per chat, the reason lines since the lowest cutoff asked while no row is added: a clean pane's cutoff is 0, so its read decodes every note
const noteLines = new Map<string, { cursor: number; since: number; lines: Promise<PaneLine[]> }>();

/** A Map row's reason from an unloaded chat, or null when the store must answer (loaded, no rows here, or the read failed). */
export async function coldPaneReason(store: Pick<Store, "loaded">, threadId: string, sessionId: string, since: number): Promise<string | undefined | null> {
  if (store.loaded(threadId)) return null;
  const cursor = lastRowid(threadId);
  if (cursor === undefined) return null;
  let read = noteLines.get(threadId);
  if (!read || read.cursor !== cursor || read.since > since) {
    read = { cursor, since, lines: (scans ??= startReader())({ threadId, notesSince: since }) };
    noteLines.set(threadId, read);
  }
  let lines: PaneLine[];
  try {
    lines = await read.lines;
  } catch (error) {
    if (noteLines.get(threadId) === read) noteLines.delete(threadId);
    console.error("cold pane reason read failed; the store answers", threadId, error);
    return null;
  }
  // a write during the read loaded the chat, and its newest rows may not be saved yet
  return store.loaded(threadId) ? null : paneReason(lines, sessionId, since);
}

/** Chats past this many rows keep their tail page until a write or an older page loads them: a 237k-row chat took 3 s. */
export const WARM_ROW_CAP = 5_000;

/** Loads the chats' transcripts after the first paint, one per task and the open chat first, so a switch or send rarely waits on a load. */
export function warmChats(
  store: Pick<Store, "loaded" | "warm">,
  chats: () => ReadonlyArray<{ id: string; threadId: string }>,
  afterPaint: (start: () => Promise<void>) => void,
): (open: string) => void {
  let first: string | undefined;
  // each chat once: the thread cache may evict a warmed chat, and warming it again would never end
  const tried = new Set<string>();
  const next = () => {
    const cold = chats().filter((chat) => !store.loaded(chat.threadId) && !tried.has(chat.threadId));
    return cold.find((chat) => chat.id === first) ?? cold[0];
  };
  const warm = async () => {
    for (let chat = next(); chat; chat = next()) {
      tried.add(chat.threadId);
      await new Promise((resolve) => setImmediate(resolve));
      try {
        if (!store.loaded(chat.threadId) && !threadOver(chat.threadId, WARM_ROW_CAP)) store.warm(chat.threadId);
      } catch (error) {
        // a failed thread stays cold, and loads (or fails) on its own request
        console.error("warm chats failed", chat.threadId, error);
      }
    }
  };
  // not awaited: the warm stays out of the startup line's checks time
  afterPaint(async () => void warm());
  return (open) => { first ??= open; };
}
