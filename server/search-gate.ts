import type { DatabaseSync } from "node:sqlite";

// Residual: a second server's write landing during chat-sync activity is attributed to sync and caught at next launch.

interface Dirt {
  threads: Set<string>;
  keys: Map<string, Set<string>>;
}

/** The epoch each dirty thread or key was last published at. */
interface Stamped {
  threads: Map<string, number>;
  keys: Map<string, Map<string, number>>;
}

export interface SearchCacheState {
  epoch: number;
  generation: number;
  /** the whole cache needs revalidation */
  full: boolean;
  trusted: boolean;
  threads: Set<string>;
  keys: Map<string, Set<string>>;
}

// Past this many dirty threads and keys a full pass is cheaper than catching up.
const MAX_DIRT = 10_000;

const empty = (): Dirt => ({ threads: new Set(), keys: new Map() });
const stamped = (): Stamped => ({ threads: new Map(), keys: new Map() });

let source: DatabaseSync | null = null;
let version: number | null = null;
let epoch = 0;
let generation = 0;
let full = true;
let committed = stamped();
let size = 0;
let pending = empty();
let onDirt: (() => void) | null = null;
let syncRequests = 0;
let syncSince = false;

/** message-db's live handle, or null once closed. Either way the cache starts over. */
export function searchSource(database: DatabaseSync | null): void {
  source = database;
  version = null;
  untrustSearchCache();
}

export function untrustSearchCache(): void {
  generation++;
  full = true;
  committed = stamped();
  size = 0;
}

/** Call after a statement that wrote messages: an autocommit publishes now, a transaction at its outermost COMMIT. */
export function searchDirty(database: DatabaseSync, threadId: string, id?: string): void {
  if (id === undefined) pending.threads.add(threadId);
  else {
    const ids = pending.keys.get(threadId);
    if (ids) ids.add(id);
    else pending.keys.set(threadId, new Set([id]));
  }
  if (!database.isTransaction) publishSearchDirt();
}

/** Call right after the outermost COMMIT. */
export function publishSearchDirt(): void {
  if (!pending.threads.size && !pending.keys.size) return;
  const { threads, keys } = pending;
  pending = empty();
  epoch++;
  // with no worker to catch up, an untrusted cache is revalidated whole, so its dirt is not kept
  if (!full || onDirt) keep(threads, keys);
  onDirt?.();
}

function keep(threads: Set<string>, keys: Map<string, Set<string>>): void {
  for (const threadId of threads) if (!stamp(committed.threads, threadId)) return;
  for (const [threadId, ids] of keys) {
    let into = committed.keys.get(threadId);
    if (!into) committed.keys.set(threadId, (into = new Map()));
    for (const id of ids) if (!stamp(into, id)) return;
  }
}

function stamp(into: Map<string, number>, key: string): boolean {
  if (!into.has(key) && ++size > MAX_DIRT) {
    untrustSearchCache();
    return false;
  }
  into.set(key, epoch);
  return true;
}

// data_version moves only for other connections' commits, and only compares on the same live handle.
function sample(): void {
  if (!source) return;
  const now = Number(source.prepare("PRAGMA data_version").get()!.data_version);
  if (version !== null && now !== version && !syncSince) untrustSearchCache();
  version = now;
  syncSince = syncRequests > 0;
}

export function searchCacheState(): SearchCacheState {
  sample();
  return {
    epoch,
    generation,
    full,
    trusted: !full && !size,
    threads: new Set(committed.threads.keys()),
    keys: new Map([...committed.keys].map(([threadId, ids]) => [threadId, new Set(ids.keys())])),
  };
}

/** Work posted at (epoch, generation) covers the dirt stamped up to that epoch, unless a reopen or outside write came since. True once no dirt is left. */
export function ackSearchCache(builtEpoch: number, builtGeneration: number): boolean {
  sample();
  if (!source || builtGeneration !== generation) return false;
  full = false;
  for (const [threadId, at] of committed.threads) {
    if (at <= builtEpoch && committed.threads.delete(threadId)) size--;
  }
  for (const [threadId, ids] of committed.keys) {
    for (const [id, at] of ids) if (at <= builtEpoch && ids.delete(id)) size--;
    if (!ids.size) committed.keys.delete(threadId);
  }
  return !size;
}

/** The running search worker's catch-up trigger, or null. Called after each publish, outside any transaction. */
export function onSearchDirt(listener: (() => void) | null): void {
  onDirt = listener;
}

/** Chat sync's worker commits on its own connection; it counts as busy until the returned call. */
export function syncRequestStarted(): () => void {
  syncRequests++;
  syncSince = true;
  let open = true;
  return () => {
    if (open) syncRequests--;
    open = false;
  };
}
