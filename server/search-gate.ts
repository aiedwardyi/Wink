import type { DatabaseSync } from "node:sqlite";

// Residual: a second server's write landing during chat-sync activity is attributed to sync and caught at next launch.

interface Dirt {
  threads: Set<string>;
  keys: Map<string, Set<string>>;
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

const empty = (): Dirt => ({ threads: new Set(), keys: new Map() });

let source: DatabaseSync | null = null;
let version: number | null = null;
let epoch = 0;
let generation = 0;
let full = true;
let committed = empty();
let pending = empty();
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
  committed = empty();
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
  // an untrusted cache is revalidated whole, so its dirt is not kept
  if (!full) {
    for (const threadId of pending.threads) committed.threads.add(threadId);
    for (const [threadId, ids] of pending.keys) {
      const into = committed.keys.get(threadId);
      if (into) for (const id of ids) into.add(id);
      else committed.keys.set(threadId, ids);
    }
  }
  pending = empty();
  epoch++;
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
    trusted: !full && !committed.threads.size && !committed.keys.size,
    threads: new Set(committed.threads),
    keys: new Map([...committed.keys].map(([threadId, ids]) => [threadId, new Set(ids)])),
  };
}

/** A cache built from the state at (epoch, generation) is current only if nothing committed, reopened or wrote from outside since. */
export function ackSearchCache(builtEpoch: number, builtGeneration: number): boolean {
  sample();
  if (!source || builtEpoch !== epoch || builtGeneration !== generation) return false;
  full = false;
  committed = empty();
  return true;
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
