// Loaded transcripts, least recently used first; a 237k-row chat holds ~146 MB, so their rows share one budget.
/** About 175 MB of rows; a chat over it alone still loads, and stays while it is one of the newest. */
export const THREAD_CACHE_ROWS = 300_000;
/** Turns and panes go back to the chats they just used; evicting those would reload a big chat on the next send. */
const KEEP_NEWEST = 2;

export class ThreadCache<T extends { messages: readonly unknown[] }> {
  private entries = new Map<string, T>();
  private rows: number;
  /** Threads a running turn writes to; never evicted. */
  private busy: () => ReadonlySet<string>;

  constructor(rows: number, busy: () => ReadonlySet<string>) {
    this.rows = rows;
    this.busy = busy;
  }

  /** A use: the thread becomes the newest. */
  get(threadId: string): T | undefined {
    const entry = this.entries.get(threadId);
    if (entry) this.touch(threadId, entry);
    return entry;
  }

  /** A look that is not a use. */
  peek(threadId: string): T | undefined {
    return this.entries.get(threadId);
  }

  has(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  delete(threadId: string): void {
    this.entries.delete(threadId);
  }

  set(threadId: string, entry: T): void {
    this.touch(threadId, entry);
  }

  private touch(threadId: string, entry: T): void {
    this.entries.delete(threadId);
    this.entries.set(threadId, entry);
    this.trim();
  }

  /** Recounted on every use: appends and synced rows grow the cached arrays without telling the cache. */
  private trim(): void {
    let total = 0;
    for (const loaded of this.entries.values()) total += loaded.messages.length;
    if (total <= this.rows) return;
    const keep = new Set([...this.entries.keys()].slice(-KEEP_NEWEST));
    const busy = this.busy();
    for (const [id, loaded] of this.entries) {
      if (total <= this.rows) break;
      if (keep.has(id) || busy.has(id)) continue;
      this.entries.delete(id);
      total -= loaded.messages.length;
    }
  }
}
