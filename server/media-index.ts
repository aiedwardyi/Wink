// The Media tab's index of one chat: every picture and file on the active path,
// newest first and each once, columnar so thousands of files stay light on the wire.
import { stat } from "node:fs/promises";

import { mediaKey, messageRefs, showKind } from "../src/lib/chat-media.ts";

import { readMediaRows, type MediaRow } from "./media-rows.ts";
import type { Store } from "./store.ts";

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
  pages: MediaIndex[];
  cursors: Set<string>;
  cursor: string | null;
  seen: Set<string>;
  dirty?: true;
  sizes: Map<string, Promise<number | null>>;
}

function readPage(threadId: string, cached: HeldIndex, limit: number): MediaIndex {
  const start = cached.cursor;
  const { rows, next } = readMediaRows(threadId, start, limit);
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

export function createMediaIndex(store: Pick<Store, "activeLeaf" | "onChange">) {
  const held = new Map<string, HeldIndex>();
  let count = 0;
  store.onChange((change) => {
    if (!("threadId" in change)) return;
    const cached = held.get(change.threadId);
    if (change.type === "thread.deleted") held.delete(change.threadId);
    else if (cached) {
      cached.dirty = true;
      cached.sizes.clear();
    }
  });
  return {
    list(threadId: string, v?: string | null): MediaIndex | { v: string } {
      let cached = held.get(threadId);
      if (!cached || cached.dirty) {
        const next = { v: `${boot}.${++count}`, cursor: store.activeLeaf(threadId), cursors: new Set<string>(), pages: [], seen: new Set<string>(), sizes: new Map() };
        const page = readPage(threadId, next, FIRST_ROWS);
        const prior = cached?.pages[0];
        if (cached && prior && !prior.next && !page.next && same(prior, page)) cached.dirty = undefined;
        else cached = next;
      }
      held.delete(threadId);
      held.set(threadId, cached);
      if (held.size > HELD) held.delete(held.keys().next().value!);
      return v === cached.v ? { v } : cached.pages[0]!;
    },
    page(threadId: string, v: string | null, n: number): MediaIndex | null {
      const cached = held.get(threadId);
      if (!cached || cached.v !== v) return null;
      return cached.pages[n] ?? (n === cached.pages.length && cached.cursor ? readPage(threadId, cached, OLDER_ROWS) : null);
    },
    async size(threadId: string, v: string | null, slot: number, n = 0): Promise<number | null> {
      const cached = held.get(threadId);
      const page = cached?.pages[n];
      if (!page || cached.v !== v || !Number.isSafeInteger(slot)) return null;
      const ref = page.ref[slot];
      // A UNC path would authenticate to a remote host.
      if (!ref || page.kind[slot] !== "l" || showKind(ref) === "image" || /^[\\/]{2}/.test(ref)) return null;
      const key = `${n}:${slot}`;
      let size = cached.sizes.get(key);
      if (!size) {
        size = stat(ref).then((info) => info.isFile() ? info.size : null, () => null);
        cached.sizes.set(key, size);
      }
      return size;
    },
  };
}
