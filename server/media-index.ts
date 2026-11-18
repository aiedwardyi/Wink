// The Media tab's index of one chat: every picture and file on the active path,
// newest first and each once, columnar so thousands of files stay light on the wire.
import { stat } from "node:fs/promises";

import { mediaKey, messageRefs, showKind } from "../src/lib/chat-media.ts";

import { mediaRows, type MediaRow } from "./media-rows.ts";
import type { Store } from "./store.ts";

export interface MediaIndex {
  /** Moves only when the list does, so an unchanged chat answers with `{ v }` alone. */
  v: string;
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

type MediaList = Omit<MediaIndex, "v">;

// held per chat; the least recently asked go first
const HELD = 16;
const boot = Date.now().toString(36);

export function buildMediaIndex(threadId: string, newestFirst: Iterable<MediaRow>): MediaList {
  const index: MediaList = { ids: [], at: [], kind: "", name: [], ref: [], size: [] };
  const seen = new Set<string>();
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
  index: MediaIndex;
  dirty?: true;
  sizes: Map<number, Promise<number | null>>;
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
        const list = buildMediaIndex(threadId, mediaRows(threadId, store.activeLeaf(threadId)));
        if (cached && same(cached.index, list)) cached.dirty = undefined;
        else cached = { index: { v: `${boot}.${++count}`, ...list }, sizes: new Map() };
      }
      held.delete(threadId);
      held.set(threadId, cached);
      if (held.size > HELD) held.delete(held.keys().next().value!);
      return v === cached.index.v ? { v } : cached.index;
    },
    async size(threadId: string, v: string | null, slot: number): Promise<number | null> {
      const cached = held.get(threadId);
      if (!cached || cached.index.v !== v || !Number.isSafeInteger(slot)) return null;
      const ref = cached.index.ref[slot];
      // A UNC path would authenticate to a remote host.
      if (!ref || cached.index.kind[slot] !== "l" || showKind(ref) === "image" || /^[\\/]{2}/.test(ref)) return null;
      let size = cached.sizes.get(slot);
      if (!size) {
        size = stat(ref).then((info) => info.isFile() ? info.size : null, () => null);
        cached.sizes.set(slot, size);
      }
      return size;
    },
  };
}
