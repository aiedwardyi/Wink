import { randomBytes } from "node:crypto";
import { z } from "zod";

import { autoEffortSchema, autoTaskSchema, type AutoDimensions } from "../shared/auto-routing.ts";
import { names, ruleAuthorization, userChoice, userWords, type AttributionSource } from "./auto-routing-attrib.ts";
import type { AutoRoutingHabits } from "./auto-routing-habits.ts";
import { operationSchema, type AutoRoutingRules } from "./auto-routing-rules.ts";
import { autoPickSchema, EMPTY_AUTO_BUDGET, type AutoRoutingState } from "./auto-routing.ts";

const inputSchema = z.object({ op: z.enum(["pick", "setPreference", "remove", "reset", "forgetHabits", "revert", "inspect", "undo"]),
  target: z.enum(["chat", "worker"]).optional(), taskClass: autoTaskSchema.optional(), model: z.string().optional(), effort: autoEffortSchema.optional(),
  max: z.boolean().optional(), requireSecondFamily: z.literal(true).optional(), version: z.number().int().nonnegative().optional(), quote: z.string().min(1).max(4096),
}).strict();
export type AutoChangePayload = { id: string; kind: "pick" | "rules" | "undo"; undoable: boolean; target: "worker"; dimensions?: AutoDimensions; sentence?: string };
type Deps = {
  state: AutoRoutingState; rules: AutoRoutingRules; habits: AutoRoutingHabits;
  source(botId: string, threadId: string): AttributionSource;
  taskId(botId: string, threadId: string): string | undefined;
  emit(botId: string, threadId: string, row: AutoChangePayload): void;
  now?: () => number;
};

export function createAutoRoutingOperations(deps: Deps) {
  const newest = (botId: string, threadId: string, taskId: string) => {
    const pick = deps.state.get(botId)?.pickChanges?.[threadId];
    const rule = deps.rules.lastChange();
    const changes = [pick && { ...pick, kind: "pick" as const, botId }, rule && { ...rule, kind: "rules" as const }]
      .filter((row) => row && row.botId === botId && row.threadId === threadId && row.taskId === taskId);
    return changes.sort((a, b) => b!.at - a!.at)[0];
  };
  const undo = (botId: string, threadId: string, taskId: string, id: string) => {
    const row = newest(botId, threadId, taskId);
    if (!row || row.id !== id || row.undone) throw new Error("Auto change is no longer undoable");
    let dimensions: AutoDimensions | undefined;
    if (row.kind === "pick") {
      deps.habits.drop(row.id);
      dimensions = deps.state.undoPick(botId, threadId, taskId, row.id);
    } else deps.rules.undo({ id: row.id, at: row.at, botId, threadId, taskId });
    deps.emit(botId, threadId, { id: row.id, kind: "undo", undoable: false, target: "worker", dimensions });
    return { applied: true };
  };
  return {
    setEnabled(botId: string, enabled: boolean): void {
      const bot = deps.state.get(botId) ?? { enabled: false, budget: structuredClone(EMPTY_AUTO_BUDGET) };
      deps.state.set(botId, { ...bot, enabled });
    },
    undo(botId: string, threadId: string, id: string) {
      const taskId = deps.taskId(botId, threadId);
      if (!taskId) throw new Error("Auto task is unavailable");
      return undo(botId, threadId, taskId, id);
    },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The tool payload is parsed here before any state change.
    tool(botId: string, threadId: string, input: unknown) {
      const parsed = inputSchema.safeParse(input);
      const hint = { applied: false, hint: "Auto needs a matching instruction in this live user turn." };
      if (!parsed.success || !deps.state.get(botId)?.enabled) return hint;
      const op = parsed.data;
      const allowed = {
        pick: ["op", "quote", "target", "taskClass", "model", "effort"],
        setPreference: ["op", "quote", "target", "taskClass", "model", "effort", "max", "requireSecondFamily"],
        remove: ["op", "quote", "target", "taskClass"], revert: ["op", "quote", "version"],
        reset: ["op", "quote"], forgetHabits: ["op", "quote"], inspect: ["op", "quote"], undo: ["op", "quote"],
      };
      if (Object.keys(op).some((key) => !allowed[op.op].includes(key))
        || (op.max !== undefined && (op.model !== undefined || op.effort !== undefined || op.requireSecondFamily !== undefined))) return hint;
      const source = deps.source(botId, threadId);
      const words = userWords(source);
      const taskId = deps.taskId(botId, threadId);
      if (!taskId || !op.quote.trim() || !words.includes(op.quote)) return hint;
      if (op.target === "chat") return { applied: false, hint: "Chat Auto picks are not enabled yet." };
      if (op.op === "inspect") return { applied: false, rules: deps.rules.current(), pick: deps.state.pick(botId, threadId, taskId) };
      if (op.op === "undo") {
        const row = newest(botId, threadId, taskId);
        if (!row) return hint;
        return undo(botId, threadId, taskId, row.id);
      }
      const named = names(op.quote);
      const dimensions: AutoDimensions = {};
      if (op.model) { dimensions.model = op.model; dimensions.engine = named.engine; }
      if (op.effort) dimensions.effort = op.effort;
      const id = randomBytes(16).toString("hex");
      const at = Math.max((deps.now ?? Date.now)(), (newest(botId, threadId, taskId)?.at ?? 0) + 1);
      if (op.op === "pick") {
        const pick = autoPickSchema.safeParse(dimensions);
        if (!pick.success || !userChoice(source, "worker", op.taskClass ?? "unknown", op.quote, pick.data)) return hint;
        deps.state.keepPick(botId, threadId, taskId, pick.data, id, at);
        deps.emit(botId, threadId, { id, kind: "pick", target: "worker", dimensions: pick.data, undoable: true });
        return { applied: true };
      }
      const preference = { target: op.target, taskClass: op.taskClass, ...dimensions, requireSecondFamily: op.requireSecondFamily };
      const operation = operationSchema.safeParse(op.op === "setPreference"
        ? { op: op.op, ...(op.max !== undefined ? { max: op.max } : { preference }) }
        : op.op === "remove" ? { op: op.op, target: op.target, taskClass: op.taskClass }
        : op.op === "revert" ? { op: op.op, version: op.version } : { op: op.op });
      if (!operation.success) return hint;
      let result;
      try { result = deps.rules.apply(operation.data, ruleAuthorization(source, operation.data, op.quote), deps.habits, { id, at, botId, threadId, taskId }); }
      catch { return hint; }
      deps.emit(botId, threadId, { id, kind: "rules", target: "worker", sentence: result.sentence, undoable: true });
      return { applied: true };
    },
  };
}
