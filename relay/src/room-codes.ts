// Short room join codes: code to PC label and expiry, one JSON line each,
// rewritten whole on each change. Never a room's secret, which stays on the PC.

import { randomInt } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { LABEL_RE, ROOM_CODE_ALPHABET, ROOM_CODE_RE, ROOM_CODE_TTL_MS } from "../../shared/relay-protocol.ts";
import { silentLogger, type Logger } from "./log.ts";
import { readText, writeAtomic } from "./team.ts";

const FILE = "room-codes";
export const ROOM_CODES_PER_LABEL = 64;
export const ROOM_CODES_MAX = 50_000;

const heldSchema = z.strictObject({ code: z.string().regex(ROOM_CODE_RE), label: z.string().regex(LABEL_RE), exp: z.int().nonnegative() });
type Held = z.infer<typeof heldSchema>;

const newCode = () => Array.from({ length: 6 }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join("");

export class RoomCodeStore {
  private readonly held = new Map<string, Held>();
  private writes: Promise<void> = Promise.resolve();
  private queued = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: Logger;

  private constructor(file: string, now: () => number, log: Logger) {
    this.file = file;
    this.now = now;
    this.log = log;
  }

  static async open(dir: string, now: () => number = Date.now, log: Logger = silentLogger): Promise<RoomCodeStore> {
    const store = new RoomCodeStore(join(dir, FILE), now, log);
    for (const line of (await readText(store.file)).split("\n")) {
      if (!line) continue;
      try {
        const parsed = heldSchema.safeParse(JSON.parse(line));
        if (parsed.success) store.held.set(parsed.data.code, parsed.data);
      } catch {}
    }
    if (store.prune()) await store.save();
    store.timer = setInterval(() => { if (store.prune()) void store.save(); }, 60_000);
    store.timer.unref();
    return store;
  }

  /** Null once the PC or the relay holds too many live codes. */
  mint(label: string): { code: string; exp: number } | null {
    this.prune();
    if (this.held.size >= ROOM_CODES_MAX) return null;
    let mine = 0;
    for (const entry of this.held.values()) if (entry.label === label) mine++;
    if (mine >= ROOM_CODES_PER_LABEL) return null;
    let code = newCode();
    while (this.held.has(code)) code = newCode();
    const entry = { code, label, exp: this.now() + ROOM_CODE_TTL_MS };
    this.held.set(code, entry);
    void this.save();
    return { code, exp: entry.exp };
  }

  lookup(code: string): string | null {
    const entry = this.held.get(code);
    return entry && entry.exp > this.now() ? entry.label : null;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.writes;
  }

  private prune(): boolean {
    const now = this.now();
    let dropped = false;
    for (const [code, entry] of this.held) {
      if (entry.exp > now) continue;
      this.held.delete(code);
      dropped = true;
    }
    return dropped;
  }

  /** Writes the state as it stands when the previous write ends, so a burst costs one rewrite. */
  private save(): Promise<void> {
    if (this.queued) return this.writes;
    this.queued = true;
    const write = this.writes.then(() => {
      this.queued = false;
      return writeAtomic(this.file, [...this.held.values()].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    });
    this.writes = write.catch(() => this.log.log("room-codes-write-failed", {}));
    return this.writes;
  }
}
