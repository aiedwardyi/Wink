import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { autoArmSchema, autoEffortSchema, autoEngineSchema } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";
import { engineIsFresh } from "./turn-context.ts";

const HOUR = 60 * 60_000;
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const moveSchema = z.object({ sendId: z.string().min(1), at: time, reason: z.enum(["discretionary", "limit"]) }).strict();
export const autoBudgetSchema = z.object({
  lastSeenAt: time, moves: z.array(moveSchema), sends: z.array(z.string().min(1)),
}).strict().refine((value) => new Set(value.sends).size === value.sends.length && new Set(value.moves.map((move) => move.sendId)).size === value.moves.length
  && value.moves.every((move) => move.at <= value.lastSeenAt && value.sends.includes(move.sendId)));
export type AutoBudget = z.infer<typeof autoBudgetSchema>;
type AutoMoveResult = { allowed: boolean; state: AutoBudget; reason?: "clock-rollback" | "duplicate-send" | "daily-budget" | "six-hour-budget" };
type AutoSwitchEstimate = { futureSavings: number | null; warmReread: number | null; coldReplay: number | null; comparableQuality: boolean };
type AutoSwitchCost = { fresh: boolean; costOnlyMove: boolean };
type ChatLimitDecision = { warn: boolean; nextSend: boolean };
export const EMPTY_AUTO_BUDGET: AutoBudget = { lastSeenAt: 0, moves: [], sends: [] };
export type AutoBoundary = {
  firstSend: boolean; idleMs: number; compacted: boolean;
  busy: boolean; toolCall: boolean; backgroundJob: boolean; unfinishedReply: boolean;
  queued: boolean; steerOrJoin: boolean; pendingApproval: boolean;
};

export function autoBreak(input: AutoBoundary): "first" | "idle" | "compaction" | null {
  if (input.busy || input.toolCall || input.backgroundJob || input.unfinishedReply || input.queued || input.steerOrJoin || input.pendingApproval) return null;
  if (input.firstSend) return "first";
  if (input.compacted) return "compaction";
  return Number.isFinite(input.idleMs) && input.idleMs >= HOUR ? "idle" : null;
}

// Persist returned state before dispatch, including denials that advance the clock.
export function reserveAutoMove(state: AutoBudget, input: { now: number; sendId: string; reason: "discretionary" | "limit"; firstSelection?: boolean }): AutoMoveResult {
  const prior = autoBudgetSchema.parse(state);
  time.parse(input.now);
  if (input.now < prior.lastSeenAt) return { allowed: false, state: prior, reason: "clock-rollback" };
  if (!input.sendId || prior.sends.includes(input.sendId)) return { allowed: false, state: prior, reason: "duplicate-send" };
  const current = { ...prior, lastSeenAt: input.now };
  if (input.firstSelection && !prior.sends.length) return { allowed: true, state: { ...current, sends: [...prior.sends, input.sendId] } };
  const recent = prior.moves.filter((move) => input.now - move.at < 24 * HOUR);
  if (input.reason === "discretionary" && recent.some((move) => move.reason === "discretionary")) return { allowed: false, state: current, reason: "daily-budget" };
  if (recent.filter((move) => input.now - move.at < 6 * HOUR).length >= 2) return { allowed: false, state: current, reason: "six-hour-budget" };
  return { allowed: true, state: { lastSeenAt: input.now, moves: [...recent, { sendId: input.sendId, at: input.now, reason: input.reason }], sends: [...prior.sends, input.sendId] } };
}

export function autoSwitchCost(input: Parameters<typeof engineIsFresh>[0], estimate: AutoSwitchEstimate): AutoSwitchCost {
  const fresh = engineIsFresh(input);
  const cost = fresh ? estimate.coldReplay : estimate.warmReread;
  return { fresh, costOnlyMove: estimate.comparableQuality && cost !== null && Number.isFinite(cost) && cost >= 0
    && estimate.futureSavings !== null && Number.isFinite(estimate.futureSavings) && estimate.futureSavings > 2 * cost };
}

export function chatLimitMove(windows: readonly { usedPercent: number; resetsAt: number | null }[], now: number): ChatLimitDecision {
  const low = windows.filter((window) => Number.isFinite(window.usedPercent) && window.usedPercent > 90);
  const binding = low.filter((window) => window.usedPercent >= 97);
  const unknown = binding.some((window) => window.resetsAt === null || !Number.isFinite(window.resetsAt));
  return { warn: low.length > 0, nextSend: binding.length > 0 && (unknown ? binding.some((window) => window.usedPercent >= 100 && (window.resetsAt === null || !Number.isFinite(window.resetsAt))) : Math.max(...binding.map((window) => window.resetsAt!)) - now > 30 * 60_000) };
}

const localRouteSchema = z.object({
  engine: autoEngineSchema, model: z.string(), effort: autoEffortSchema,
  account: z.string().min(1), generation: z.number().int().nonnegative(),
  tier: z.enum(["cheap", "mid", "strong"]).optional(),
}).strict().refine((value) => autoArmSchema.safeParse({ engine: value.engine, model: value.model, effort: value.effort }).success);
const botSchema = z.object({
  enabled: z.boolean(), budget: autoBudgetSchema, current: localRouteSchema.optional(), previous: localRouteSchema.optional(),
  acceptedRequestId: z.string().min(1).optional(),
}).strict();
const stateSchema = z.object({ v: z.literal(1), bots: z.record(z.string().min(1), botSchema) }).strict();
export type LocalAutoBot = z.infer<typeof botSchema>;

export class AutoRoutingState {
  private state: z.infer<typeof stateSchema> = { v: 1, bots: {} };
  readonly file: string;
  private readonly write: typeof writeFileAtomic;

  constructor(dataDir: string, write = writeFileAtomic) {
    this.file = join(dataDir, "auto-routing-state.json");
    this.write = write;
    if (existsSync(this.file)) this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  get(botId: string): LocalAutoBot | undefined { return Object.hasOwn(this.state.bots, botId) ? structuredClone(this.state.bots[botId]) : undefined; }

  set(botId: string, value: LocalAutoBot): void {
    const previous = this.get(botId)?.budget;
    if (previous && (value.budget.lastSeenAt < previous.lastSeenAt || previous.sends.some((id) => !value.budget.sends.includes(id))
      || previous.moves.some((move) => value.budget.lastSeenAt - move.at < 24 * HOUR && !value.budget.moves.some((next) => next.sendId === move.sendId && next.at === move.at && next.reason === move.reason)))) throw new Error("Auto switch budget cannot be reset");
    const next = stateSchema.parse({ v: 1, bots: { ...this.state.bots, [botId]: botSchema.parse(value) } });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    this.state = next;
  }
}
