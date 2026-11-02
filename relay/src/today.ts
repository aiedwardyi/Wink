import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const DAY_MS = 86_400_000;
const schema = z.strictObject({ start: z.int(), ids: z.array(z.string().regex(/^[a-f0-9]{32}$/)) });
const dayStart = (now: number) => Math.floor((now + 9 * 3_600_000) / DAY_MS) * DAY_MS - 9 * 3_600_000;

export class TodayCount {
  private held?: z.infer<typeof schema>;
  private readonly file: string;

  constructor(file: string) { this.file = file; }

  private read(): z.infer<typeof schema> {
    if (!this.held) {
      try { this.held = schema.parse(JSON.parse(readFileSync(this.file, "utf8"))); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        this.held = { start: 0, ids: [] };
      }
    }
    return this.held;
  }

  count(now: number): number {
    const held = this.read();
    return held.start === dayStart(now) ? held.ids.length : 0;
  }

  record(rows: { id: string; at: number }[], now: number): void {
    const start = dayStart(now);
    const held = this.read();
    const ids = new Set(held.start === start ? held.ids : []);
    for (const row of rows) if (row.at >= start && row.at < start + DAY_MS) ids.add(row.id);
    if (held.start === start && ids.size === held.ids.length) return;
    const next = { start, ids: [...ids] };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.file);
      this.held = next;
    } finally { rmSync(temp, { force: true }); }
  }
}
