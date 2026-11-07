import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { autoArmSchema, autoEffortSchema, autoEngineSchema, autoTaskSchema, verifiedChoice, type AutoPreference, type AutoTarget, type AutoTask, type ChoiceContext, type ChoiceProvenance } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";

const DAY = 24 * 60 * 60_000;
const rowSchema = z.object({
  choiceId: z.string().regex(/^[a-f0-9]{16,64}$/), target: z.enum(["chat", "worker"]), taskClass: autoTaskSchema,
  engine: autoEngineSchema, model: z.string(), effort: autoEffortSchema,
  origin: z.enum(["chat", "ui"]), at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((value) => autoArmSchema.safeParse({ engine: value.engine, model: value.model, effort: value.effort }).success);
const stateSchema = z.object({ v: z.literal(1), rows: z.array(rowSchema).max(500) }).strict().refine((value) => new Set(value.rows.map((row) => row.choiceId)).size === value.rows.length);
export type AutoHabitRow = z.infer<typeof rowSchema>;
type AutoHabitState = z.infer<typeof stateSchema>;
const samePick = (a: AutoHabitRow, b: AutoHabitRow) => a.engine === b.engine && a.model === b.model && a.effort === b.effort;

export class AutoRoutingHabits {
  private state: z.infer<typeof stateSchema> = { v: 1, rows: [] };
  readonly file: string;
  private readonly write: typeof writeFileAtomic;

  constructor(dataDir: string, write = writeFileAtomic) {
    this.file = join(dataDir, "auto-routing-habits.json");
    this.write = write;
    if (existsSync(this.file)) this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  rows(): AutoHabitRow[] { return structuredClone(this.state.rows); }

  observe(row: AutoHabitRow, choice: ChoiceProvenance, context: ChoiceContext, now: number, unconstrained: boolean): boolean {
    const parsed = rowSchema.parse(row);
    if (!unconstrained || !verifiedChoice(choice, context) || context.intent !== "choice" || parsed.taskClass === "unknown"
      || parsed.choiceId !== choice.actionId || parsed.target !== choice.target || parsed.taskClass !== choice.taskClass || parsed.origin !== choice.origin
      || parsed.engine !== choice.dimensions.engine || parsed.model !== choice.dimensions.model || parsed.effort !== choice.dimensions.effort
      || parsed.at > now || parsed.at <= now - 30 * DAY || this.state.rows.some((item) => item.choiceId === parsed.choiceId)) return false;
    const rows = [...this.state.rows.filter((item) => item.at > now - 30 * DAY), parsed].sort((a, b) => a.at - b.at).slice(-500);
    this.commit({ v: 1, rows });
    return true;
  }

  preference(target: AutoTarget, taskClass: AutoTask, now: number): AutoPreference | undefined {
    const rows = this.state.rows.filter((row) => row.target === target && row.taskClass === taskClass && row.at > now - 30 * DAY && row.at <= now).sort((a, b) => a.at - b.at);
    const last = rows.at(-1);
    if (!last) return;
    let start = rows.length - 1;
    while (start > 0 && samePick(rows[start - 1], last)) start--;
    const matching = rows.slice(start);
    if (matching.length < 3 || new Set(matching.map((row) => new Date(row.at).toDateString())).size < 2) return;
    return { target, taskClass, engine: last.engine, model: last.model, effort: last.effort };
  }

  forget(): void { this.commit({ v: 1, rows: [] }); }

  drop(choiceId: string): void { this.commit({ v: 1, rows: this.state.rows.filter((row) => row.choiceId !== choiceId) }); }

  private commit(value: AutoHabitState): void {
    const next = stateSchema.parse(value);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    this.state = next;
  }
}
