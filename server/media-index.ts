// The Media tab's index of one chat: every picture and file on the active path,
// newest first and each once, columnar so thousands of files stay light on the wire.
import { mediaKey, messageRefs, type MediaRef } from "../src/lib/chat-media.ts";

import type { Message, Store } from "./store.ts";

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
}

type MediaList = Omit<MediaIndex, "v">;

// held per chat; the least recently asked go first
const HELD = 16;
const boot = Date.now().toString(36);
const refsOf = new WeakMap<Message, MediaRef[]>();

export function buildMediaIndex(threadId: string, path: readonly Message[]): MediaList {
  const index: MediaList = { ids: [], at: [], kind: "", name: [], ref: [] };
  const seen = new Set<string>();
  for (let i = path.length - 1; i >= 0; i--) {
    const message = path[i]!;
    let refs = refsOf.get(message);
    if (!refs) refsOf.set(message, refs = messageRefs(message));
    for (const ref of refs) {
      const key = mediaKey(threadId, ref);
      if (seen.has(key)) continue;
      seen.add(key);
      index.ids.push(message.id);
      index.at.push(Math.floor(message.at / 1000));
      index.kind += ref.kind;
      index.name.push(ref.name);
      index.ref.push(ref.ref);
    }
  }
  return index;
}

function same(a: MediaList, b: MediaList): boolean {
  return a.ids.length === b.ids.length && a.kind === b.kind && (["ids", "at", "name", "ref"] as const).every((column) => a[column].every((value, n) => value === b[column][n]));
}

/** Builds a chat's index on its first ask and again only after that chat changes. */
export function createMediaIndex(store: Pick<Store, "activePath" | "onChange">) {
  const held = new Map<string, MediaIndex>();
  const dirty = new Set<string>();
  let count = 0;
  store.onChange((change) => {
    if (!("threadId" in change) || !held.has(change.threadId)) return;
    if (change.type === "thread.deleted") held.delete(change.threadId);
    else dirty.add(change.threadId);
  });
  return (threadId: string, v?: string | null): MediaIndex | { v: string } => {
    let index = held.get(threadId);
    if (!index || dirty.has(threadId)) {
      dirty.delete(threadId);
      const list = buildMediaIndex(threadId, store.activePath(threadId));
      if (!index || !same(index, list)) index = { v: `${boot}.${++count}`, ...list };
    }
    held.delete(threadId);
    held.set(threadId, index);
    if (held.size > HELD) held.delete(held.keys().next().value!);
    return v === index.v ? { v: index.v } : index;
  };
}
