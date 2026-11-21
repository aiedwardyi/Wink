// Boot reads of threads the store has not loaded, from their newest rows, so opening the app parses no whole transcript.
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { offscreenLimit } from "./chat-tail.ts";
import type { TailRead, TailReply, TailRequest } from "./cold-thread-worker.ts";
import { messageDbFile, messageTransactionEnd, onMessageChange, readMessage, rowCursor, rowToMessage, scanThreadRows, storedHead, threadOver, threadVersion, type ThreadRows } from "./message-db.ts";
import { paneReason, type PaneLine } from "../shared/pane-note.ts";
import type { Message, Store } from "./store.ts";
import { rowChars } from "./thread-cache.ts";

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

/** The page messagePage would send before `before`, or null when the store must answer (loaded, an unknown cursor, or the read failed). */
export async function coldPageBefore(store: Pick<Store, "loaded">, threadId: string, before: string, limit: number): Promise<{ messages: Message[]; hasMore: boolean } | null> {
  await committed();
  if (store.loaded(threadId)) return null;
  const cursor = rowCursor(threadId, before);
  if (cursor === undefined) return null;
  let page: Tail;
  try {
    // one row past the page: chained gives the oldest its parent with it
    page = await (reader ??= startReader())({ threadId, before: cursor, count: limit + 1 });
  } catch (error) {
    console.error("cold older page read failed; the store answers", threadId, error);
    return null;
  }
  // a write during the read loaded the chat
  if (store.loaded(threadId)) return null;
  const { messages } = chained(page, limit + 1);
  const start = Math.max(0, messages.length - limit);
  return { messages: messages.slice(start), hasMore: start > 0 };
}

// per unloaded chat, Map's reads of one version of it: each Map refresh asks again, a change to its rows or a load drops them, and the two chats read last keep theirs
type ColdReads = { version: string; writes?: Promise<Message[]>; notes?: { since: number; lines: Promise<PaneLine[]> } };
const coldReads = new Map<string, ColdReads>();
let dropOnChange: (() => void) | undefined;

function readsOf(threadId: string, version: string): ColdReads {
  dropOnChange ??= onMessageChange((changed) => coldReads.delete(changed));
  let reads = coldReads.get(threadId);
  coldReads.delete(threadId);
  if (reads?.version !== version) reads = { version };
  coldReads.set(threadId, reads);
  for (const older of coldReads.keys()) if (coldReads.size > 2) coldReads.delete(older);
  return reads;
}

// Store emits inside a sync pull's transaction, and the worker's handle reads none of its rows until it commits
async function committed(): Promise<void> {
  const ended = messageTransactionEnd();
  if (ended) await ended;
}

/** The rows that wrote files, or null when the store must answer (loaded, no rows here, or the read failed). */
export async function coldWriteRows(store: Pick<Store, "loaded">, threadId: string): Promise<Message[] | null> {
  await committed();
  if (store.loaded(threadId)) return null;
  const version = threadVersion(threadId);
  if (version === undefined) return null;
  const reads = readsOf(threadId, version);
  const read = reads.writes ??= (scans ??= startReader())({ threadId, writes: true }).then((tail) => tail.messages);
  let rows: Message[];
  try {
    rows = await read;
  } catch (error) {
    if (reads.writes === read) delete reads.writes;
    console.error("cold write rows read failed; the store answers", threadId, error);
    return null;
  }
  // a write during the read loaded the chat, and its newest rows may not be saved yet
  return store.loaded(threadId) ? null : rows;
}

/** A Map row's reason from an unloaded chat, or null when the store must answer (loaded, no rows here, or the read failed). */
export async function coldPaneReason(store: Pick<Store, "loaded">, threadId: string, sessionId: string, since: number): Promise<string | undefined | null> {
  await committed();
  if (store.loaded(threadId)) return null;
  const version = threadVersion(threadId);
  if (version === undefined) return null;
  const reads = readsOf(threadId, version);
  // the lowest cutoff asked serves every later one: a clean pane's cutoff is 0, so its read decodes every note
  if (!reads.notes || reads.notes.since > since) reads.notes = { since, lines: (scans ??= startReader())({ threadId, notesSince: since }) };
  const read = reads.notes;
  let lines: PaneLine[];
  try {
    lines = await read.lines;
  } catch (error) {
    if (reads.notes === read) delete reads.notes;
    console.error("cold pane reason read failed; the store answers", threadId, error);
    return null;
  }
  // a write during the read loaded the chat, and its newest rows may not be saved yet
  return store.loaded(threadId) ? null : paneReason(lines, sessionId, since);
}

const loads = new Map<string, Promise<void>>();

/** The load coldLoad has in flight for a chat, if any. */
export function coldLoading(threadId: string): Promise<void> | undefined {
  return loads.get(threadId);
}

// per unloaded chat, its user rows' sendIds up to a rowid: Map reads them before its first frame, so a send while the chat loads dedupes by key
type SendIds = { cursor: number; ids: Map<string, string> };
const sendIdReads = new Map<string, { ids: Promise<SendIds | null>; stale: boolean }>();
let staleOnDelete: (() => void) | undefined;

/** Reads an unloaded chat's sendIds on the reader, beside the scans Map's frame waits on. */
export function coldSendIds(store: Pick<Store, "loaded">, threadId: string): void {
  if (store.loaded(threadId) || sendIdReads.get(threadId)?.stale === false) return;
  // a deleted top row frees its rowid, and a row inserted there would sit behind the cursor
  staleOnDelete ??= onMessageChange((thread, _id, deleted) => {
    const read = sendIdReads.get(thread);
    if (read && deleted) read.stale = true;
  });
  const ids = committed()
    .then(() => (reader ??= startReader())({ threadId, sendIds: true }))
    .then(({ cursor, rows }) => {
      const first = new Map<string, string>();
      for (const row of rows) if (!first.has(row.sendId)) first.set(row.sendId, row.id);
      return { cursor, ids: first };
    })
    .catch((error) => {
      console.error("cold sendId read failed; a send there reads the chat", threadId, error);
      return null;
    });
  sendIdReads.delete(threadId);
  sendIdReads.set(threadId, { ids, stale: false });
  for (const older of sendIdReads.keys()) if (sendIdReads.size > 2) sendIdReads.delete(older);
}

/** The row a send was first accepted as: the store's when the chat is loaded, else by key from Map's sendId read and the rows stored since, else from the chat once a load under way lands. */
export async function sentRow(store: Pick<Store, "loaded" | "messagesFor" | "row">, threadId: string, sendId: string): Promise<Message | undefined> {
  const read = store.loaded(threadId) ? undefined : sendIdReads.get(threadId);
  const known = await read?.ids;
  if (known && !read!.stale && !store.loaded(threadId)) {
    const id = known.ids.get(sendId);
    const keyed = id === undefined ? undefined : store.row(threadId, id);
    if (keyed) return keyed;
    // a full page since the read means it is too old to finish here
    const since = scanThreadRows(threadId, known.cursor, 1024);
    if (since.messages.length < 1024) return since.messages.find((message) => message.sendId === sendId);
  }
  const loading = loads.get(threadId);
  if (loading) await loading;
  return store.messagesFor(threadId).find((message) => message.sendId === sendId);
}

/** Loads an unloaded chat into the store, a worker reading its pages and this thread parsing one per turn: else the first send after Map's cold read reads it all at once. */
export function coldLoad(store: Pick<Store, "adopt" | "loaded">, threadId: string): Promise<void> {
  let load = loads.get(threadId);
  if (!load) {
    load = loadPages(store, threadId)
      .catch((error) => console.error("cold chat load failed; the store loads it when used", threadId, error))
      .finally(() => loads.delete(threadId));
    loads.set(threadId, load);
  }
  return load;
}

async function loadPages(store: Pick<Store, "adopt" | "loaded">, threadId: string): Promise<void> {
  // only this handle writes rows (a peer's land through applySyncChanges), so its updates and deletes are all the pages can miss
  const changed = new Set<string>();
  // a new row takes the table's top rowid + 1, so once a page's last row is deleted an insert can land behind the cursor
  const deletedAt = new Map<string, number>();
  let deletes = 0;
  const stop = onMessageChange((thread, id, deleted) => {
    if (thread !== threadId) return;
    changed.add(id);
    if (deleted) deletedAt.set(id, ++deletes);
  });
  try {
    const messages: Message[] = [];
    const at = new Map<string, number>();
    // a row's index to the index of its later copy, or to itself once deleted
    const gone = new Map<number, number>();
    let chars = 0;
    const take = (message: Message) => {
      const index = messages.push(message) - 1;
      const was = at.get(message.id);
      if (was !== undefined) gone.set(was, index);
      at.set(message.id, index);
    };
    const pages: Array<{ after: number; asked: number; length: number; chars: number; last: string }> = [];
    let cursor = 0;
    const rewind = (from: number) => {
      const { after, length, chars: before } = pages[from]!;
      for (let index = length; index < messages.length; index++) if (at.get(messages[index]!.id) === index) at.delete(messages[index]!.id);
      for (const [was, index] of gone) {
        if (index < length) continue;
        gone.delete(was);
        if (was < length) at.set(messages[was]!.id, was);
      }
      messages.length = length;
      pages.length = from;
      chars = before;
      cursor = after;
    };
    for (;;) {
      const asked = deletes;
      const page = await (reader ??= startReader())({ threadId, after: cursor });
      if (store.loaded(threadId) || changed.size > 1024) return;
      if (page.length) {
        const length = messages.length;
        const before = chars;
        for (const row of page) {
          take(rowToMessage(row));
          chars += row.json.length;
        }
        pages.push({ after: cursor, asked, length, chars: before, last: messages.at(-1)!.id });
        cursor = page.at(-1)!.cursor;
      }
      // read again from the first page whose last row was deleted after it was asked for
      const from = pages.findIndex((read) => (deletedAt.get(read.last) ?? 0) > read.asked);
      if (from >= 0) rewind(from);
      else if (!page.length) break;
    }
    // rows added since the worker's last page
    for (let tail = scanThreadRows(threadId, cursor, 1024); tail.messages.length; tail = scanThreadRows(threadId, tail.cursor, 1024)) {
      for (const message of tail.messages) {
        take(message);
        chars += rowChars(message);
        changed.delete(message.id);
      }
    }
    for (const id of changed) {
      const index = at.get(id);
      if (index === undefined) continue;
      const message = readMessage(threadId, id);
      if (message) messages[index] = message;
      else gone.set(index, index);
    }
    const activeLeafId = storedHead(threadId);
    if (activeLeafId === undefined) return;
    store.adopt(threadId, { messages: gone.size ? messages.filter((_, index) => !gone.has(index)) : messages, activeLeafId, chars });
    coldReads.delete(threadId);
    sendIdReads.delete(threadId);
  } finally {
    stop();
  }
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
