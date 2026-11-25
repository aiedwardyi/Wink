// The Media tab's index of one chat: every picture and file on the active path,
// newest first and each once, columnar so thousands of files stay light on the wire.
import { stat } from "node:fs/promises";

import { mediaKey, messageRefs, showKind, type MediaRef } from "../src/lib/chat-media.ts";

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
  /** Bytes, when the attach tag or the disk says. */
  size: Array<number | null>;
}

type MediaList = Omit<MediaIndex, "v">;

// held per chat; the least recently asked go first
const HELD = 16;
const boot = Date.now().toString(36);
const refsOf = new WeakMap<Message, MediaRef[]>();
// rows read between turns: a 208k-row chat's list held the server ~150 ms in one go
const SLICE = 4096;

export async function buildMediaIndex(threadId: string, path: readonly Message[]): Promise<MediaList> {
  const index: MediaList = { ids: [], at: [], kind: "", name: [], ref: [], size: [] };
  const seen = new Set<string>();
  for (let i = path.length - 1; i >= 0; i--) {
    if (i % SLICE === 0 && i) await new Promise((resolve) => setImmediate(resolve));
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
      index.size.push(ref.size ?? null);
    }
  }
  return index;
}

function same(a: MediaList, b: MediaList): boolean {
  return a.ids.length === b.ids.length && a.kind === b.kind && (["ids", "at", "name", "ref", "size"] as const).every((column) => a[column].every((value, n) => value === b[column][n]));
}

async function linkedSizes(list: MediaList): Promise<MediaList> {
  await Promise.all(list.ref.map(async (ref, n) => {
    // a UNC path would authenticate to a remote host
    if (list.kind[n] !== "l" || showKind(ref) === "image" || /^[\\/]{2}/.test(ref)) return;
    list.size[n] = await stat(ref).then((info) => info.isFile() ? info.size : null, () => null);
  }));
  return list;
}

/** Builds a chat's index on its first ask and again only after that chat changes; a held index answers without reading the chat. */
export function createMediaIndex(store: Pick<Store, "activePath" | "onChange">, pathOf: (threadId: string) => readonly Message[] | Promise<readonly Message[]> = (threadId) => store.activePath(threadId)) {
  const held = new Map<string, MediaIndex>();
  const dirty = new Set<string>();
  const building = new Set<string>();
  // the build each held index came from, so a slower older build never replaces a newer one
  const builtBy = new WeakMap<MediaIndex, number>();
  let builds = 0;
  let count = 0;
  store.onChange((change) => {
    if (!("threadId" in change) || !(held.has(change.threadId) || building.has(change.threadId))) return;
    if (change.type === "thread.deleted") held.delete(change.threadId);
    else dirty.add(change.threadId);
  });
  return async (threadId: string, v?: string | null): Promise<MediaIndex | { v: string }> => {
    let index = held.get(threadId);
    if (!index || dirty.has(threadId)) {
      dirty.delete(threadId);
      building.add(threadId);
      const build = ++builds;
      const list = await Promise.resolve(pathOf(threadId)).then((path) => buildMediaIndex(threadId, path)).then(linkedSizes).finally(() => building.delete(threadId));
      index = held.get(threadId);
      if (!index || (builtBy.get(index) ?? 0) < build) {
        if (!index || !same(index, list)) index = { v: `${boot}.${++count}`, ...list };
        builtBy.set(index, build);
      }
    }
    held.delete(threadId);
    held.set(threadId, index);
    if (held.size > HELD) held.delete(held.keys().next().value!);
    return v === index.v ? { v: index.v } : index;
  };
}
