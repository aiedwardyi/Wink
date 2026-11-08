import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { autoPreferenceSchema, autoRulesSchema, autoTaskSchema, SHIPPED_AUTO_RULES, type AutoDimensions, type AutoRules } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { AutoRoutingHabits } from "./auto-routing-habits.ts";

const versionSchema = z.object({ id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), content: autoRulesSchema }).strict();
const changeSchema = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), at: z.number().int().nonnegative(), botId: z.string().min(1),
  threadId: z.string().min(1), taskId: z.string().min(1), prior: autoRulesSchema, undone: z.boolean() }).strict();
export type AutoRuleChange = Omit<z.infer<typeof changeSchema>, "prior" | "undone">;
const stateSchema = z.object({ v: z.literal(1), current: versionSchema, versions: z.array(versionSchema).max(20), change: changeSchema.optional() }).strict().refine((value) =>
  value.versions.length > 0 && value.versions.at(-1)?.id === value.current.id
  && JSON.stringify(value.versions.at(-1)?.content) === JSON.stringify(value.current.content)
  && value.versions.every((version, i) => i === 0 || version.id > value.versions[i - 1].id));
export const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setPreference"), preference: autoPreferenceSchema.optional(), max: z.boolean().optional() }).strict().refine((value) => (value.preference !== undefined) !== (value.max !== undefined)),
  z.object({ op: z.literal("remove"), target: z.enum(["chat", "worker"]), taskClass: autoTaskSchema }).strict(),
  z.object({ op: z.literal("reset") }).strict(),
  z.object({ op: z.literal("forgetHabits") }).strict(),
  z.object({ op: z.literal("revert"), version: z.number().int().nonnegative() }).strict(),
]);
export type AutoRuleOperation = z.infer<typeof operationSchema>;
type AutoRuleResult = { id: number; sentence: string };
export type RuleAuthorization = {
  authenticatedUserId: string; actorId: string; authorized: boolean;
  actionId: string; currentActionId: string; directUserText: string; userQuote: string;
  origin: "direct-user" | "quoted" | "bot" | "sync" | "peer";
  attributed: AutoDimensions;
};

const shipped = (): z.infer<typeof stateSchema> => ({ v: 1, current: { id: 0, content: structuredClone(SHIPPED_AUTO_RULES) }, versions: [{ id: 0, content: structuredClone(SHIPPED_AUTO_RULES) }] });

export class AutoRoutingRules {
  private state = shipped();
  readonly file: string;
  private readonly write: typeof writeFileAtomic;

  constructor(dataDir: string, write = writeFileAtomic) {
    this.file = join(dataDir, "auto-routing-rules.json");
    this.write = write;
    this.reload();
  }

  reload(): void { this.state = existsSync(this.file) ? stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))) : shipped(); }

  current(): { id: number; content: AutoRules } { return structuredClone(this.state.current); }
  versions(): number[] { return [...new Set([0, ...this.state.versions.map((version) => version.id)])]; }
  lastChange(): z.infer<typeof changeSchema> | undefined { return this.state.change ? structuredClone(this.state.change) : undefined; }

  undo(change: AutoRuleChange): number {
    const prior = this.state.change;
    if (!prior || prior.undone || prior.id !== change.id || prior.botId !== change.botId || prior.threadId !== change.threadId || prior.taskId !== change.taskId) throw new Error("Auto change is no longer undoable");
    const current = { id: this.state.current.id + 1, content: prior.prior };
    this.save({ ...this.state, current, versions: [...this.state.versions, current].slice(-20), change: { ...prior, undone: true } });
    return current.id;
  }

  apply(value: AutoRuleOperation, authorization: RuleAuthorization, habits?: AutoRoutingHabits, change?: AutoRuleChange): AutoRuleResult {
    const operation = operationSchema.parse(value);
    const dimensions: AutoDimensions = operation.op === "setPreference" ? operation.preference ?? (operation.max === true ? { effort: "max" as const } : {}) : {};
    if (!authorization.authorized || !authorization.authenticatedUserId || authorization.actorId !== authorization.authenticatedUserId
      || !authorization.actionId || authorization.actionId !== authorization.currentActionId || authorization.origin !== "direct-user"
      || !authorization.userQuote.trim() || !authorization.directUserText.includes(authorization.userQuote)
      || (["engine", "model", "effort", "account"] as const).some((key) => dimensions[key] !== undefined && dimensions[key] !== authorization.attributed[key])) throw new Error("Auto rule needs a verified current user instruction");
    if (operation.op === "forgetHabits") {
      if (!habits) throw new Error("Auto habit store unavailable");
      habits.forget();
      if (change) this.save({ ...this.state, change: { ...change, prior: this.current().content, undone: false } });
      return { id: this.state.current.id, sentence: "Forgot learned Auto picks." };
    }
    let content = this.current().content;
    let sentence: string;
    if (operation.op === "reset") { content = structuredClone(SHIPPED_AUTO_RULES); sentence = "Reset Auto defaults."; }
    else if (operation.op === "revert") {
      const prior = operation.version === 0 ? SHIPPED_AUTO_RULES : this.state.versions.find((version) => version.id === operation.version)?.content;
      if (!prior) throw new Error("Auto rules version is unavailable");
      content = structuredClone(prior);
      sentence = `Restored Auto rules version ${operation.version}.`;
    } else if (operation.op === "remove") {
      content.preferences = content.preferences.filter((item) => item.target !== operation.target || item.taskClass !== operation.taskClass);
      sentence = `Removed the Auto ${operation.target} ${operation.taskClass} preference.`;
    } else if (operation.max !== undefined) {
      content.max = operation.max;
      sentence = `Auto Max is ${operation.max ? "on for difficult work" : "off"}.`;
    } else {
      const preference = operation.preference!;
      content.preferences = [...content.preferences.filter((item) => item.target !== preference.target || item.taskClass !== preference.taskClass), preference];
      sentence = `Saved the Auto ${preference.target} ${preference.taskClass} preference.`;
    }
    const current = { id: this.state.current.id + 1, content: autoRulesSchema.parse(content) };
    this.save({ v: 1, current, versions: [...this.state.versions, current].slice(-20),
      change: change ? { ...change, prior: this.current().content, undone: false } : this.state.change });
    return { id: current.id, sentence };
  }

  private save(value: z.infer<typeof stateSchema>): void {
    const next = stateSchema.parse(value);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    this.state = next;
  }
}
