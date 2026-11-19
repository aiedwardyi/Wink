// The Media tab's index of one chat: every picture and file on the active path,
// newest first and each once, columnar so thousands of files stay light on the wire.
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";

import { mediaKey, messageRefs, showKind } from "../src/lib/chat-media.ts";

import { readMediaRows, type MediaRow } from "./media-rows.ts";
import { messageDbFile } from "./message-db.ts";
import type { Message, Store } from "./store.ts";

export interface MediaIndex {
  /** An unchanged chat answers with `{ v }` alone. */
  v: string;
  head?: string;
  next?: number;
  ids: string[];
  /** Seconds. */
  at: number[];
  /** One MediaRef kind letter per file. */
  kind: string;
  name: string[];
  ref: string[];
  /** Bytes from the attach tag. Linked file sizes are read on demand. */
  size: Array<number | null>;
}

type MediaList = Omit<MediaIndex, "v" | "head" | "next">;

// held per chat; the least recently asked go first
const HELD = 16;
const FIRST_ROWS = 256;
const OLDER_ROWS = 2048;
const boot = Date.now().toString(36);

export function buildMediaIndex(threadId: string, newestFirst: Iterable<MediaRow>, seen = new Set<string>()): MediaList {
  const index: MediaList = { ids: [], at: [], kind: "", name: [], ref: [], size: [] };
  for (const message of newestFirst) {
    for (const ref of messageRefs(message)) {
      const key = mediaKey(threadId, ref);
      if (seen.has(key)) continue;
      seen.add(key);
      index.ids.push(message.id);
      index.at.push(Math.floor(message.at / 1000));
      index.kind += ref.kind;
      index.name.push(ref.name);
      index.ref.push(ref.ref);
      index.size.push(ref.size ?? null);
    }
  }
  return index;
}

function same(a: MediaList, b: MediaList): boolean {
  return a.ids.length === b.ids.length && a.kind === b.kind && (["ids", "at", "name", "ref", "size"] as const).every((column) => a[column].every((value, n) => value === b[column][n]));
}

interface HeldIndex {
  v: string;
  leaf: string | null;
  plainParent?: string | null;
  pages: MediaIndex[];
  cursors: Set<string>;
  cursor: string | null;
  seen: Set<string>;
  dirty?: true;
  completion?: Promise<MediaIndex[]>;
  sizes: Map<string, Promise<number | null>>;
  legacy?: MediaIndex;
  legacyLoad?: Promise<MediaIndex>;
}

function mightShowMedia({ image, kind, role, text }: MediaRow): boolean {
  return Boolean(image || (kind === "text" && text && (role === "user" ? text.includes("<attached-") : text.includes("](") || text.includes("![") || (text.includes("`") && text.includes("(")))));
}

type Rows = Pick<Store, "loaded" | "activePath">;
const pathAt = new WeakMap<readonly Message[], Map<string, number>>();

/** readMediaRows from a chat already in memory, or undefined when the cursor left its active path. */
function pathRows(path: readonly Message[], cursor: string, limit: number): { rows: MediaRow[]; next: string | null } | undefined {
  let at = pathAt.get(path);
  if (!at) pathAt.set(path, at = new Map(path.map((message, n) => [message.id, n])));
  const end = at.get(cursor);
  return end === undefined ? undefined : { rows: path.slice(Math.max(0, end - limit + 1), end + 1).reverse(), next: path[end - limit]?.id ?? null };
}

function readPage(store: Rows, threadId: string, cached: HeldIndex, limit: number, database?: DatabaseSync): MediaIndex {
  const start = cached.cursor;
  // An open chat is in memory already; walking a big one on disk took 12 s over 127 pages.
  const { rows, next } = (start && store.loaded(threadId) && pathRows(store.activePath(threadId), start, limit)) || readMediaRows(threadId, start, limit, database);
  if (start) cached.cursors.add(start);
  cached.cursor = next && !cached.cursors.has(next) ? next : null;
  const page: MediaIndex = { v: cached.v, ...buildMediaIndex(threadId, rows, cached.seen) };
  if (cached.cursor) {
    if (cached.pages.length === 0 && start) page.head = start;
    page.next = cached.pages.length + 1;
  } else {
    cached.cursors.clear();
    cached.seen.clear();
  }
  cached.pages.push(page);
  return page;
}

function readSize(cached: HeldIndex, n: number, slot: number, page = cached.pages[n]): Promise<number | null> {
  const ref = page?.ref[slot];
  // A UNC path would authenticate to a remote host.
  if (!ref || page.kind[slot] !== "l" || showKind(ref) === "image" || /^[\\/]{2}/.test(ref)) return Promise.resolve(null);
  const key = `${n}:${slot}`;
  let size = cached.sizes.get(key);
  if (!size) {
    size = stat(ref).then((info) => info.isFile() ? info.size : null, () => null);
    cached.sizes.set(key, size);
  }
  return size;
}

export function createMediaIndex(store: Pick<Store, "activeLeaf" | "onChange"> & Rows) {
  const held = new Map<string, HeldIndex>();
  let count = 0;
  store.onChange((change) => {
    if (!("threadId" in change) || change.type === "task.packet") return;
    if (change.type === "thread.deleted") { held.delete(change.threadId); return; }
    const cached = held.get(change.threadId);
    if (!cached) return;
    cached.sizes.clear();
    cached.legacyLoad = undefined;
    if (cached.dirty) return;
    if (change.type === "message" && !change.imported && change.message.parentId === cached.leaf && !mightShowMedia(change.message)) {
      cached.plainParent = cached.leaf;
      cached.leaf = change.message.id;
      return;
    }
    if (change.type === "message.patch" && cached.plainParent !== undefined && change.message.id === cached.leaf
      && change.message.parentId === cached.plainParent && !mightShowMedia(change.message)) return;
    cached.dirty = true;
  });

  function current(threadId: string): HeldIndex {
    let cached = held.get(threadId);
    if (!cached || cached.dirty) {
      const leaf = store.activeLeaf(threadId);
      const next: HeldIndex = {
        v: `${boot}.${++count}`, leaf, cursor: leaf, cursors: new Set(), pages: [], seen: new Set(), sizes: new Map(), legacy: cached?.legacy,
      };
      const page = readPage(store, threadId, next, FIRST_ROWS);
      const prior = cached?.pages[0];
      if (cached && prior && !prior.next && !page.next && same(prior, page)) {
        cached.dirty = undefined;
        cached.leaf = leaf;
        cached.plainParent = undefined;
      } else cached = next;
    }
    held.delete(threadId);
    held.set(threadId, cached);
    if (held.size > HELD) held.delete(held.keys().next().value!);
    return cached;
  }

  async function readRemaining(threadId: string, cached: HeldIndex): Promise<MediaIndex[]> {
    const full = { ...cached, pages: cached.pages.slice(), cursors: new Set(cached.cursors), seen: new Set(cached.seen) };
    const database = new DatabaseSync(messageDbFile(), { readOnly: true });
    try {
      // Pin the rows to one revision while chat writes run between pages.
      database.exec("BEGIN");
      while (full.cursor) {
        readPage(store, threadId, full, OLDER_ROWS, database);
        if (full.cursor) await yieldLoop();
      }
      return full.pages;
    } finally {
      database.close();
    }
  }

  function complete(threadId: string, cached: HeldIndex): Promise<MediaIndex[]> {
    if (!cached.cursor) return Promise.resolve(cached.pages);
    return cached.completion ??= readRemaining(threadId, cached).then((pages) => {
      if (!cached.dirty) {
        cached.pages = pages;
        cached.cursor = null;
        cached.cursors.clear();
        cached.seen.clear();
      }
      return pages;
    }).finally(() => { cached.completion = undefined; });
  }

  return {
    list(threadId: string, v?: string | null): MediaIndex | { v: string } {
      const cached = current(threadId);
      return v === cached.v ? { v } : cached.pages[0]!;
    },
    page(threadId: string, v: string | null, n: number): MediaIndex | null {
      const cached = held.get(threadId);
      if (!cached || cached.dirty || cached.v !== v) return null;
      return cached.pages[n] ?? (n === cached.pages.length && cached.cursor ? readPage(store, threadId, cached, OLDER_ROWS) : null);
    },
    snapshot(threadId: string): Promise<MediaIndex[]> {
      return complete(threadId, current(threadId));
    },
    async legacy(threadId: string, v: string | null): Promise<MediaIndex | { v: string }> {
      const cached = current(threadId);
      if (!cached.legacyLoad) {
        const pending = complete(threadId, cached).then(async (pages) => {
          const size = await Promise.all(pages.flatMap((page, n) => page.size.map((size, slot) => size ?? readSize(cached, n, slot, page))));
          const list: MediaList = {
            ids: pages.flatMap((page) => page.ids), at: pages.flatMap((page) => page.at), kind: pages.map((page) => page.kind).join(""),
            name: pages.flatMap((page) => page.name), ref: pages.flatMap((page) => page.ref), size,
          };
          const index = cached.legacy && same(cached.legacy, list) ? cached.legacy : { v: `${boot}.full.${++count}`, ...list };
          if (cached.legacyLoad === pending) cached.legacy = index;
          return index;
        }).catch((error) => {
          if (cached.legacyLoad === pending) cached.legacyLoad = undefined;
          throw error;
        });
        cached.legacyLoad = pending;
      }
      const index = await cached.legacyLoad;
      return index.v === v ? { v } : index;
    },
    async size(threadId: string, v: string | null, slot: number, n = 0): Promise<number | null | undefined> {
      const cached = held.get(threadId);
      if (!cached || cached.v !== v || !cached.pages[n]) return undefined;
      return Number.isSafeInteger(slot) ? readSize(cached, n, slot) : null;
    },
  };
}
