// One night's model spend in counts: dream-practice\ledger\<date>.json. The week cap adds the six nights before it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const NIGHT_CAP = 350_000;
export const WEEK_CAP = 2_450_000;
// the largest fresh check turn in all 111 rot-check-2 rows, turn and grade
export const RESERVE_SEED = 66_000;
// the mean fresh check turn in rot-check-2 (DESIGN-v4 2.1)
export const TURN_SEED = 35_700;
export const CALL_KINDS = ["tidy", "plan", "item", "check", "grade", "rewrite"] as const;
export type CallKind = (typeof CALL_KINDS)[number];
export type Usage = { fresh: number; processed: number };

const count = z.number().int().nonnegative();
const tally = z.object({ calls: count, fresh: count, processed: count }).strict();
export const ledgerSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reserve: count,
  turns: z.object({ count, fresh: count }).strict(),
  kinds: z.object({ tidy: tally, plan: tally, item: tally, check: tally, grade: tally, rewrite: tally }).strict(),
}).strict();
export const kindsSchema = ledgerSchema.pick({ kinds: true });
export type LedgerData = z.infer<typeof ledgerSchema>;

const dayBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
const read = (file: string) => (existsSync(file) ? ledgerSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))) : null);

export class Ledger {
  readonly file: string;
  readonly data: LedgerData;
  readonly week: number;

  constructor(dir: string, date: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${date}.json`);
    const before = Array.from({ length: 6 }, (_, at) => read(join(dir, `${dayBefore(date, at + 1)}.json`)));
    const seen = before.flatMap((night) => (night?.success ? [night.data] : []));
    const today = read(this.file);
    this.data = today?.success
      ? today.data
      : { date, reserve: Math.max(RESERVE_SEED, ...seen.map((night) => night.reserve)), turns: { count: 0, fresh: 0 }, kinds: kindsSchema.parse({ kinds: Object.fromEntries(CALL_KINDS.map((kind) => [kind, { calls: 0, fresh: 0, processed: 0 }])) }).kinds };
    this.week = seen.reduce((sum, night) => sum + Ledger.fresh(night), 0);
    this.save();
  }

  static fresh(data: LedgerData) {
    return CALL_KINDS.reduce((sum, kind) => sum + data.kinds[kind].fresh, 0);
  }

  get night(): Usage {
    return { fresh: Ledger.fresh(this.data), processed: CALL_KINDS.reduce((sum, kind) => sum + this.data.kinds[kind].processed, 0) };
  }

  left() {
    return Math.max(0, Math.min(NIGHT_CAP - this.night.fresh, WEEK_CAP - this.week - this.night.fresh));
  }

  /** A check turn starts only while the largest fresh turn seen is still left. */
  turnFits() {
    return this.left() >= this.data.reserve;
  }

  /** A pair starts only when its 6 turns can finish tonight: 5 typical turns and the reserve for the last. */
  pairFits() {
    const mean = this.data.turns.count ? this.data.turns.fresh / this.data.turns.count : TURN_SEED;
    return this.left() >= 5 * mean + this.data.reserve;
  }

  /** A cleaner call starts only if its prompt estimate and output cap are left. */
  callFits(promptChars: number, outputCap: number) {
    return this.left() >= Math.ceil(promptChars / 4) + outputCap;
  }

  add(kind: CallKind, usage: Usage) {
    const row = this.data.kinds[kind];
    row.calls += 1;
    row.fresh += usage.fresh;
    row.processed += usage.processed;
    this.save();
  }

  /** A check turn with its grade: raises the reserve when it is the largest seen. */
  turn(fresh: number) {
    this.data.turns.count += 1;
    this.data.turns.fresh += fresh;
    this.data.reserve = Math.max(this.data.reserve, fresh);
    this.save();
  }

  save() {
    writeFileSync(this.file, `${JSON.stringify(ledgerSchema.parse(this.data))}\n`);
  }
}
