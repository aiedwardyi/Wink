import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { autoPreferenceSchema, autoRulesSchema, autoTaskSchema, SHIPPED_AUTO_RULES, type AutoRules } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { AutoRoutingHabits } from "./auto-routing-habits.ts";

const versionSchema = z.object({ id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), content: autoRulesSchema }).strict();
const stateSchema = z.object({ v: z.literal(1), current: versionSchema, versions: z.array(versionSchema).max(20) }).strict().refine((value) =>
  value.versions.length > 0 && value.versions.at(-1)?.id === value.current.id
  && JSON.stringify(value.versions.at(-1)?.content) === JSON.stringify(value.current.content)
  && value.versions.every((version, i) => i === 0 || version.id > value.versions[i - 1].id));
const operationSchema = z.discriminatedUnion("op", [
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
  attributedOperation: AutoRuleOperation;
};

export class AutoRoutingRules {
  private state: z.infer<typeof stateSchema> = { v: 1, current: { id: 0, content: structuredClone(SHIPPED_AUTO_RULES) }, versions: [{ id: 0, content: structuredClone(SHIPPED_AUTO_RULES) }] };
  readonly file: string;
  private readonly write: typeof writeFileAtomic;

  constructor(dataDir: string, write = writeFileAtomic) {
    this.file = join(dataDir, "auto-routing-rules.json");
    this.write = write;
    if (existsSync(this.file)) this.state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  current(): { id: number; content: AutoRules } { return structuredClone(this.state.current); }
  versions(): number[] { return [...new Set([0, ...this.state.versions.map((version) => version.id)])]; }

  apply(value: AutoRuleOperation, authorization: RuleAuthorization, habits?: AutoRoutingHabits): AutoRuleResult {
    const operation = operationSchema.parse(value);
    const attributed = operationSchema.parse(authorization.attributedOperation);
    if (!authorization.authorized || !authorization.authenticatedUserId || authorization.actorId !== authorization.authenticatedUserId
      || !authorization.actionId || authorization.actionId !== authorization.currentActionId || authorization.origin !== "direct-user"
      || !authorization.userQuote.trim() || !authorization.directUserText.includes(authorization.userQuote)
      || JSON.stringify(operation) !== JSON.stringify(attributed)) throw new Error("Auto rule needs a verified current user instruction");
    if (operation.op === "forgetHabits") {
      if (!habits) throw new Error("Auto habit store unavailable");
      habits.forget();
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
    const next = stateSchema.parse({ v: 1, current, versions: [...this.state.versions, current].slice(-20) });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    this.state = next;
    return { id: current.id, sentence };
  }
}
