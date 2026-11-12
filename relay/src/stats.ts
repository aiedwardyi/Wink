// Anonymous usage stats (shared/usage-stats.ts): one JSON line per batch in
// <dataDir>/stats/YYYY-MM-DD.ndjson. No address, label or receive time is
// stored, and nothing is logged per request.

import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline as chain, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { statsEnvelopeSchema, statsEventSchema } from "../../shared/usage-stats.ts";
import { silentLogger, type Logger } from "./log.ts";

export interface StatsConfig {
  keepDays: number;
  maxDayBytes: number;
  /** Hex SHA-256 of the key that reads GET /v1/stats/day/<date>. */
  readKeySha256: string;
}

export type StatsReply = { status: number; body: { ok: true; rejected: number } | { error: string } };

export const STATS_PER_INSTALL_PER_DAY = 200;
const DAY_MS = 86_400_000;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson(\.gz)?$/;
const LINE_RE = /^\{"batch":"([a-f0-9]{32})","id":"([a-f0-9]{32})"/;
const BAD: StatsReply = { status: 400, body: { error: "bad-stats" } };
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sizeOf = (path: string) => stat(path).then((info) => info.size, () => -1);

interface Day {
  name: string;
  batches: Set<string>;
  installs: Map<string, number>;
  bytes: number;
}

export class StatsStore {
  private day: Day | undefined;
  /** The day before's batch ids, so a retry that crosses midnight is still dropped. */
  private earlier = new Set<string>();
  private hour = { count: 0, bytes: 0 };
  private writes: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private readonly dir: string;
  private readonly config: StatsConfig;
  private readonly now: () => number;
  private readonly log: Logger;

  private constructor(dir: string, config: StatsConfig, now: () => number, log: Logger) {
    this.dir = dir;
    this.config = config;
    this.now = now;
    this.log = log;
  }

  static async open(dataDir: string, config: StatsConfig, now: () => number = Date.now, log: Logger = silentLogger): Promise<StatsStore> {
    const store = new StatsStore(join(dataDir, "stats"), config, now, log);
    await mkdir(store.dir, { recursive: true, mode: 0o700 });
    await store.sweep();
    store.timer = setInterval(() => void store.tick(), 60 * 60_000);
    store.timer.unref();
    return store;
  }

  allows(key: string): boolean {
    return timingSafeEqual(createHash("sha256").update(key).digest(), Buffer.from(this.config.readKeySha256, "hex"));
  }

  /** Keeps the events this build knows; an unknown one is dropped and counted, never stored. */
  submit(raw: unknown): Promise<StatsReply> {
    const parsed = statsEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return Promise.resolve(BAD);
    const { events: sent, batch, id, ...rest } = parsed.data;
    const events = sent.flatMap((event) => {
      const known = statsEventSchema.safeParse(event);
      return known.success ? [known.data] : [];
    });
    if (events.length === 0) return Promise.resolve(BAD);
    const rejected = sent.length - events.length;
    // LINE_RE reads batch and id back from the start of the line.
    const line = `${JSON.stringify({ batch, id, ...rest, ...(rejected > 0 ? { rejected } : {}), events })}\n`;
    const bytes = Buffer.byteLength(line);
    return this.serial(async (): Promise<StatsReply> => {
      const day = await this.today();
      if (day.batches.has(batch) || this.earlier.has(batch)) return { status: 200, body: { ok: true, rejected } };
      const count = day.installs.get(id) ?? 0;
      if (count >= STATS_PER_INSTALL_PER_DAY) return { status: 429, body: { error: "stats-limit" } };
      if (day.bytes + bytes > this.config.maxDayBytes) return { status: 507, body: { error: "stats-full" } };
      await appendFile(join(this.dir, `${day.name}.ndjson`), line, { mode: 0o600 });
      day.batches.add(batch);
      day.installs.set(id, count + 1);
      day.bytes += bytes;
      this.hour.count += 1;
      this.hour.bytes += bytes;
      return { status: 200, body: { ok: true, rejected } };
    });
  }

  /** The day, gzipped, or null. A day still being written is cut at a whole line. */
  read(date: string): Promise<Readable | null> {
    return this.serial(async () => {
      const file = join(this.dir, `${date}.ndjson`);
      if ((await sizeOf(`${file}.gz`)) >= 0) return createReadStream(`${file}.gz`);
      const bytes = await sizeOf(file);
      // Not pipe(): a failed read has to end the gzip stream, not go unhandled.
      return bytes > 0 ? chain(createReadStream(file, { end: bytes - 1 }), createGzip(), () => {}) : null;
    });
  }

  /** Hourly: the one log line, then gzip finished days and delete those past keepDays. */
  tick(): Promise<void> {
    const { count, bytes } = this.hour;
    this.hour = { count: 0, bytes: 0 };
    if (count > 0) this.log.log("stats-hour", { count, bytesIn: bytes });
    return this.serial(() => this.sweep()).catch(() => this.log.log("stats-sweep-failed", {}));
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.writes;
  }

  /** Today's ids, counts and size, read back from its file after a restart. */
  private async today(): Promise<Day> {
    const name = dayOf(this.now());
    if (this.day?.name === name) return this.day;
    const day: Day = { name, batches: new Set(), installs: new Map(), bytes: 0 };
    const file = join(this.dir, `${name}.ndjson`);
    if ((await sizeOf(file)) > 0) {
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        const [, batch, id] = LINE_RE.exec(line) ?? [];
        if (batch && id) {
          day.batches.add(batch);
          day.installs.set(id, (day.installs.get(id) ?? 0) + 1);
        }
        day.bytes += Buffer.byteLength(line) + 1;
      }
    }
    this.earlier = this.day?.batches ?? new Set();
    this.day = day;
    return day;
  }

  private async sweep(): Promise<void> {
    const today = dayOf(this.now());
    const oldest = dayOf(this.now() - this.config.keepDays * DAY_MS);
    for (const name of await readdir(this.dir)) {
      const [, date, zipped] = FILE_RE.exec(name) ?? [];
      if (!date) continue;
      const file = join(this.dir, name);
      if (date < oldest) await rm(file, { force: true });
      else if (!zipped && date < today) {
        await pipeline(createReadStream(file), createGzip(), createWriteStream(`${file}.gz.tmp`, { mode: 0o600 }));
        await rename(`${file}.gz.tmp`, `${file}.gz`);
        await rm(file);
      }
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writes.then(fn);
    this.writes = result.catch(() => {});
    return result;
  }
}
