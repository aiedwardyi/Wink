import type { Message } from "./store.ts";

// Loaded transcripts, least recently used first; one budget over their stored size, since a 237k-row chat holds ~146 MB.
/** Stored JSON chars; the heap holds ~1.45x that (Wink: 108M chars, 146 MB; Pokkey: 61M, 85 MB), so about 175 MB. */
export const THREAD_CACHE_CHARS = 120 * 2 ** 20;
/** Turns and panes go back to the chats they just used; evicting those would reload a big chat on the next send. */
const KEEP_NEWEST = 2;

/** A row's share of the budget, in the units readThread counts. */
export const rowChars = (message: Message): number => JSON.stringify(message).length;

type Entry<T> = { state: T; chars: number };

/** Rows change only through push/put/reset here, so every write is weighed. */
export class ThreadCache<T extends { readonly messages: readonly Message[] }> {
  private entries = new Map<string, Entry<T>>();
  private chars: number;
  /** Threads a running turn writes to; never evicted. */
  private busy: () => ReadonlySet<string>;

  constructor(chars: number, busy: () => ReadonlySet<string>) {
    this.chars = chars;
    this.busy = busy;
  }

  /** A use: the thread becomes the newest. */
  get(threadId: string): T | undefined {
    const entry = this.entries.get(threadId);
    if (!entry) return undefined;
    this.entries.delete(threadId);
    this.entries.set(threadId, entry);
    return entry.state;
  }

  /** A look that is not a use. */
  peek(threadId: string): T | undefined {
    return this.entries.get(threadId)?.state;
  }

  has(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  delete(threadId: string): void {
    this.entries.delete(threadId);
  }

  /** A loaded thread, as the newest; `chars` is its stored size. */
  set(threadId: string, state: T, chars: number): void {
    this.entries.delete(threadId);
    this.entries.set(threadId, { state, chars });
    this.trim();
  }

  /** A warmed thread, kept only in spare room and as the least recent, so warming never pushes out a chat in use. */
  offer(threadId: string, state: T, chars: number): boolean {
    if (this.entries.has(threadId) || this.total() + chars > this.chars) return false;
    this.entries = new Map([[threadId, { state, chars }], ...this.entries]);
    return true;
  }

  push(threadId: string, message: Message): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    this.rows(entry).push(message);
    entry.chars += rowChars(message);
    this.trim();
  }

  /** Undoes a push whose write failed. */
  pop(threadId: string): void {
    const entry = this.entries.get(threadId);
    const message = entry && this.rows(entry).pop();
    if (message) entry.chars -= rowChars(message);
  }

  put(threadId: string, index: number, message: Message): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    entry.chars += rowChars(message) - rowChars(entry.state.messages[index]!);
    this.rows(entry)[index] = message;
    this.trim();
  }

  reset(threadId: string, messages: Message[]): void {
    const entry = this.entries.get(threadId);
    if (!entry) return;
    const rows = this.rows(entry);
    rows.length = 0;
    for (const message of messages) rows.push(message);
    entry.chars = messages.reduce((sum, message) => sum + rowChars(message), 0);
    this.trim();
  }

  private rows(entry: Entry<T>): Message[] {
    // SAFETY: cached arrays are plain arrays; readonly only keeps writers outside the cache from skipping the weighing.
    return entry.state.messages as Message[];
  }

  private total(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.chars;
    return total;
  }

  trim(): void {
    let total = this.total();
    if (total <= this.chars) return;
    const keep = new Set([...this.entries.keys()].slice(-KEEP_NEWEST));
    const busy = this.busy();
    for (const [id, entry] of this.entries) {
      if (total <= this.chars) break;
      if (keep.has(id) || busy.has(id)) continue;
      this.entries.delete(id);
      total -= entry.chars;
    }
  }
}
