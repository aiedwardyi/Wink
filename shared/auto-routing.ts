import { z } from "zod";

import type { EffortLevel } from "../server/contracts.ts";
import { isEffortOffered } from "./model-effort.ts";
import { assessUsage, type UsageEvidence } from "./usage-windows.ts";

export const AUTO_ENGINES = ["claudeAgent", "codex", "grokAgent", "antigravityAgent", "museAgent"] as const;
export const AUTO_TASKS = ["quick", "chat", "writing", "creative", "research", "edit", "build", "bug", "architecture", "design", "audit"] as const;
export type AutoEngine = (typeof AUTO_ENGINES)[number];
export type AutoTask = (typeof AUTO_TASKS)[number] | "protected" | "unknown";
export type AutoTier = "cheap" | "mid" | "strong";
export type AutoTarget = "chat" | "worker";
export type AutoArm = { engine: AutoEngine; model: string; effort: EffortLevel };
export type TaskData = {
  kind?: AutoTask; risk?: "low" | "high" | "protected" | "unknown";
  scope?: "bounded" | "mechanical" | "multi-source" | "large" | "unknown";
  source?: "declared" | "keyword" | "unknown"; conflicting?: boolean; text?: string;
  tools?: readonly string[]; contextTokens?: number; codeAudit?: boolean;
  reviewOf?: AutoArm; requireSecondFamily?: boolean;
};

export const TASK_TIERS: Readonly<Record<AutoTask, AutoTier>> = Object.freeze({
  quick: "cheap", chat: "mid", writing: "mid", creative: "mid", research: "cheap", edit: "mid", build: "mid",
  bug: "strong", architecture: "strong", design: "strong", audit: "strong", protected: "strong", unknown: "strong",
});
export const AUTO_INVARIANTS = Object.freeze({
  meteredFallback: false, protectedDowngrade: false, automaticFable: false, interruptWork: false, extraModelCalls: 0,
});

const MODELS = {
  claudeAgent: ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
  grokAgent: ["grok-4.7", "grok-4.6"],
  antigravityAgent: ["gemini-4-argon", "gemini-3.8-flash"],
  museAgent: ["muse-spark-1.3", "muse-spark-1.3-contributor"],
} satisfies Record<AutoEngine, readonly string[]>;
type AutoEffortMap = Record<string, readonly EffortLevel[]>;
const AUTO_EFFORTS = new Map<string, readonly EffortLevel[]>(Object.entries({
  "claude-opus-5-5": ["medium", "high", "max"], "claude-sonnet-5-5": ["medium", "high"], "claude-haiku-5-5": ["low", "medium"],
  "gpt-6-astra": ["high", "xhigh", "max"], "gpt-6.1-sol": ["medium", "high", "max"],
  "gpt-6.1-terra": ["low", "medium", "high"], "gpt-6-luna": ["low", "medium", "high", "max"],
  "grok-4.7": ["medium", "high", "xhigh"], "grok-4.6": ["low", "medium", "high", "xhigh"],
  "gemini-3.8-flash": ["low", "medium", "high"], "muse-spark-1.3": ["low", "medium", "high"],
  "muse-spark-1.3-contributor": ["high", "xhigh", "max"],
} satisfies AutoEffortMap));

export function baseAutoModel(engine: AutoEngine, model: string): string {
  return engine === "antigravityAgent" ? model.replace(/-(low|medium|high)$/, "") : model;
}

export function autoPairReason(engine: AutoEngine, model: string, effort: EffortLevel): string {
  const base = baseAutoModel(engine, model);
  if (!MODELS[engine].includes(base)) return "outside-approved-roster";
  if (engine === "antigravityAgent" && !["low", "medium", "high"].includes(effort)) return "not-offered";
  if (engine === "antigravityAgent" && model !== base && model !== `${base}-${effort}`) return "encoded-effort-mismatch";
  if (engine === "grokAgent" && (effort === "max" || effort === "minimal")) return "not-offered";
  if (effort === "minimal") return engine === "museAgent" ? "below-approved-grid" : "not-offered";
  if (base.startsWith("claude-fable-")) return "explicit-code-audit-only";
  if (base === "gemini-4-argon") return "explicit-big-job-or-big-review-only";
  if (!AUTO_EFFORTS.get(base)?.includes(effort)) return "no-approved-task-cell";
  return effort === "max" ? "difficult-task-max-opt-in" : "approved-task-or-review-cell";
}

export function validAutoArm(arm: AutoArm): boolean {
  const base = baseAutoModel(arm.engine, arm.model);
  if (!MODELS[arm.engine].includes(base)) return false;
  if (arm.engine === "antigravityAgent") return ["low", "medium", "high"].includes(arm.effort) && arm.model === `${base}-${arm.effort}`;
  if (arm.engine === "grokAgent") return ["low", "medium", "high", "xhigh"].includes(arm.effort);
  if (arm.effort === "minimal") return arm.engine === "museAgent";
  return ["low", "medium", "high", "xhigh", "max"].includes(arm.effort);
}

export const autoEngineSchema = z.enum(AUTO_ENGINES);
export const autoEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export const autoArmSchema = z.object({ engine: autoEngineSchema, model: z.string(), effort: autoEffortSchema }).strict().refine(validAutoArm);
export const autoTaskSchema = z.enum([...AUTO_TASKS, "protected", "unknown"]);
const opaqueId = z.string().regex(/^[a-f0-9]{16,64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const autoPreferenceSchema = z.object({
  target: z.enum(["chat", "worker"]), taskClass: autoTaskSchema,
  engine: z.enum(AUTO_ENGINES).optional(), model: z.string().optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  requireSecondFamily: z.literal(true).optional(),
}).strict().refine((value) => {
  if (!value.engine && !value.requireSecondFamily) return false;
  if (value.model && (!value.engine || !MODELS[value.engine].includes(baseAutoModel(value.engine, value.model)))) return false;
  if (value.effort && !value.model) return false;
  if (value.model && value.engine && value.effort && !validAutoArm({ engine: value.engine, model: value.model, effort: value.effort })) return false;
  return true;
});
export type AutoPreference = z.infer<typeof autoPreferenceSchema>;
export const autoRulesSchema = z.object({ max: z.boolean(), preferences: z.array(autoPreferenceSchema).max(100) }).strict().refine((value) =>
  new Set(value.preferences.map((item) => `${item.target}:${item.taskClass}`)).size === value.preferences.length);
export type AutoRules = z.infer<typeof autoRulesSchema>;
const shippedPreferences: AutoPreference[] = [];
Object.freeze(shippedPreferences);
export const SHIPPED_AUTO_RULES: Readonly<AutoRules> = Object.freeze({ max: false, preferences: shippedPreferences });

type AutoTaskClassification = { taskClass: AutoTask; tier: AutoTier; source: "declared" | "keyword" | "unknown" };
export function classifyAutoTask(data: TaskData = {}): AutoTaskClassification {
  if (/sign[ -]?in|security|migration|release|보안|로그인|마이그레이션|출시/i.test(data.text ?? "") || data.risk === "protected") return { taskClass: "protected", tier: "strong", source: data.risk === "protected" ? data.source ?? "declared" : "keyword" };
  if (data.conflicting || !data.kind || !data.risk || data.risk === "unknown" || !data.scope || data.scope === "unknown"
    || data.source === "unknown" || (data.source === "keyword" && data.risk !== "high" && TASK_TIERS[data.kind] !== "strong")) return { taskClass: "unknown", tier: "strong", source: "unknown" };
  const hard = data.risk === "high" || /hard bug|architecture|audit|race condition|아키텍처|감사|경쟁 상태|어려운 버그/i.test(data.text ?? "");
  return { taskClass: data.kind, tier: hard ? "strong" : data.kind === "research" && data.scope !== "bounded" ? "mid" : TASK_TIERS[data.kind], source: hard && data.risk !== "high" ? "keyword" : data.source ?? "declared" };
}

function arm(engine: AutoEngine, model: string, effort: EffortLevel): AutoArm {
  return { engine, model: engine === "antigravityAgent" ? `${model}-${effort}` : model, effort };
}

export function gridArm(engine: AutoEngine, taskClass: AutoTask, tier = TASK_TIERS[taskClass], scope: TaskData["scope"] = "bounded"): AutoArm {
  const strong = tier === "strong";
  if (engine === "claudeAgent") {
    if (taskClass === "chat") return arm(engine, strong ? "claude-opus-5-5" : "claude-sonnet-5-5", "medium");
    if (strong) return arm(engine, "claude-opus-5-5", "high");
    if (taskClass === "quick" || (taskClass === "research" && tier === "cheap")) return arm(engine, "claude-haiku-5-5", taskClass === "quick" && scope === "bounded" ? "low" : "medium");
    return arm(engine, "claude-sonnet-5-5", ["writing", "creative"].includes(taskClass) ? "medium" : "high");
  }
  if (engine === "codex") {
    if (taskClass === "chat") return arm(engine, "gpt-6.1-sol", "medium");
    if (["bug", "architecture", "protected", "unknown"].includes(taskClass) || (strong && !["build", "design", "audit", "chat", "writing"].includes(taskClass))) return arm(engine, "gpt-6-astra", taskClass === "architecture" && scope === "large" ? "xhigh" : "high");
    if (taskClass === "quick") return arm(engine, "gpt-6-luna", "low");
    if (taskClass === "research") return arm(engine, "gpt-6-luna", scope === "bounded" ? "medium" : "high");
    if (taskClass === "creative" || taskClass === "edit") return arm(engine, "gpt-6.1-terra", scope === "mechanical" ? "low" : "medium");
    return arm(engine, "gpt-6.1-sol", ["chat", "writing"].includes(taskClass) && !strong ? "medium" : "high");
  }
  if (engine === "grokAgent") {
    if (taskClass === "chat") return arm(engine, "grok-4.6", "medium");
    if (strong) return arm(engine, "grok-4.7", ["design", "build", "writing", "research", "quick", "creative"].includes(taskClass) ? "high" : "xhigh");
    if (taskClass === "quick") return arm(engine, "grok-4.6", "low");
    if (taskClass === "edit") return arm(engine, "grok-4.6", "high");
    return arm(engine, "grok-4.7", taskClass === "creative" ? "medium" : "high");
  }
  if (engine === "antigravityAgent") return arm(engine, "gemini-3.8-flash", strong ? "high" : taskClass === "quick" ? "low" : ["chat", "writing", "creative"].includes(taskClass) ? "medium" : "high");
  if (taskClass === "chat") return arm(engine, "muse-spark-1.3", "medium");
  if (strong || ["edit", "build"].includes(taskClass)) return arm(engine, "muse-spark-1.3-contributor", taskClass === "architecture" && scope === "large" ? "xhigh" : "high");
  return arm(engine, "muse-spark-1.3", taskClass === "quick" ? "low" : taskClass === "research" ? "high" : "medium");
}

export type AutoDimensions = Partial<AutoArm> & { account?: string };
export type ChoiceProvenance = {
  actorId: string; actionId: string; target: AutoTarget; taskClass: AutoTask;
  origin: "ui" | "chat" | "bot" | "quoted" | "fallback" | "sync" | "import" | "peer" | "native-cli";
  dimensions: AutoDimensions; userQuote?: string;
};
// Built by the authenticated controller, never from model/tool arguments.
export type ChoiceContext = {
  authenticatedUserId: string; currentActionId: string; authorized: boolean;
  target: AutoTarget; taskClass: AutoTask; directUserText?: string;
  intent: "choice" | "rule" | "hint"; attributed: AutoDimensions; trustedUiEventId?: string;
};

export function verifiedChoice(choice: ChoiceProvenance, context: ChoiceContext): boolean {
  if (!context.authorized || !context.authenticatedUserId || choice.actorId !== context.authenticatedUserId || !choice.actionId || choice.actionId !== context.currentActionId
    || choice.target !== context.target || choice.taskClass !== context.taskClass || context.intent === "hint") return false;
  let dimensions = 0;
  for (const key of ["engine", "model", "effort", "account"] as const) {
    const value = choice.dimensions[key];
    if (value === undefined) continue;
    if (!value || context.attributed[key] !== value) return false;
    dimensions++;
  }
  if (!dimensions) return false;
  if (choice.origin === "ui") return context.trustedUiEventId === choice.actionId;
  return choice.origin === "chat" && choice.userQuote !== undefined && choice.userQuote.trim().length > 0
    && (context.directUserText ?? "").includes(choice.userQuote);
}

export type AutoCandidate = {
  engine: AutoEngine; account: string; generation: number; currentGeneration: number;
  authorized: boolean; signedIn: boolean; lifecycle: "ready" | "draining" | "stopped";
  subscription: boolean; models: readonly string[]; effortLevels: readonly EffortLevel[];
  tools: readonly string[]; contextTokens: number; usage?: UsageEvidence; priorUsage?: UsageEvidence;
  pending: number; active: number; loadKnown: boolean; headroom?: number; main: boolean;
};
// Admission and pinVerified are controller evidence, never model-supplied flags.
export type AutoSelectionInput = {
  target: AutoTarget; task?: TaskData; now: number; candidates: readonly AutoCandidate[];
  rules: AutoRules; rulesVersion: number; habit?: AutoPreference;
  pin?: AutoDimensions; pinVerified?: boolean; current?: AutoArm & { account: string; tier: AutoTier };
};
export type AutoRoute = AutoArm & { account: string; generation: number; tier: AutoTier; reviewLabel?: "second family" | "same family" | "same model, fresh look"; freshReview?: boolean; independentCheck?: boolean };
export type AutoDecision = {
  rulesVersion: number; taskClass: AutoTask; tier: AutoTier;
} & ({ kind: "selected"; route: AutoRoute; reason: "pin" | "rule" | "habit" | "grid" | "sticky" }
  | { kind: "pending"; reason: "equivalent-arms" | "review-choice"; choices: AutoRoute[] }
  | { kind: "hold"; reason: "unverified-pin" | "pin-unavailable" | "no-eligible-route" | "independent-review-required" });

const BIG_JOBS = new Set<AutoTask>(["architecture", "audit", "design"]);
const CODING = new Set<AutoTask>(["edit", "build", "bug", "architecture", "design", "audit", "protected"]);
const CODE_ORDER = ["claude-opus-5-5", "gpt-6.1-sol", "claude-sonnet-5-5", "gpt-6.1-terra"];

function reviewArm(engine: AutoEngine, taskClass: AutoTask, maker: AutoArm, tier: AutoTier): AutoArm {
  if (engine === maker.engine) {
    if (engine === "claudeAgent") {
      const preferred = taskClass === "quick" ? "claude-sonnet-5-5" : ["bug", "architecture", "design", "audit", "protected"].includes(taskClass) ? "claude-sonnet-5-5" : "claude-opus-5-5";
      return arm(engine, maker.model === preferred ? preferred === "claude-opus-5-5" ? "claude-sonnet-5-5" : "claude-opus-5-5" : preferred, "high");
    }
    if (engine === "codex") {
      const preferred = taskClass === "audit" ? "gpt-6-astra" : ["quick", "chat", "writing", "build", "design"].includes(taskClass) ? "gpt-6.1-terra" : "gpt-6.1-sol";
      return arm(engine, maker.model === preferred ? preferred === "gpt-6.1-sol" ? "gpt-6.1-terra" : "gpt-6.1-sol" : preferred, "high");
    }
    if (engine === "grokAgent") return arm(engine, maker.model === "grok-4.7" ? "grok-4.6" : "grok-4.7", "high");
    if (engine === "antigravityAgent") return arm(engine, BIG_JOBS.has(taskClass) && baseAutoModel(engine, maker.model) !== "gemini-4-argon" ? "gemini-4-argon" : "gemini-3.8-flash", "high");
    return arm(engine, maker.model === "muse-spark-1.3-contributor" ? "muse-spark-1.3" : "muse-spark-1.3-contributor", "high");
  }
  if (taskClass === "writing" && engine === "grokAgent") return arm(engine, "grok-4.7", "high");
  if (engine === "claudeAgent") return arm(engine, maker.engine === "codex" ? ["quick", "creative"].includes(taskClass) ? "claude-sonnet-5-5" : "claude-opus-5-5" : tier === "strong" ? "claude-opus-5-5" : "claude-sonnet-5-5", "high");
  if (engine === "codex") return arm(engine, "gpt-6.1-sol", "high");
  return gridArm(engine, taskClass, "strong");
}

function preferredReviewEngine(taskClass: AutoTask, maker: AutoEngine): AutoEngine {
  if (taskClass === "writing" && maker !== "grokAgent") return "grokAgent";
  if (maker === "claudeAgent") return "codex";
  if (maker === "codex") return "claudeAgent";
  return ["research", "edit", "build"].includes(taskClass) ? "codex" : "claudeAgent";
}

export function selectAutoRoute(input: AutoSelectionInput): AutoDecision {
  const task = input.task ?? {};
  const classified = classifyAutoTask(task);
  const { taskClass, tier } = classified;
  const result = { rulesVersion: input.rulesVersion, taskClass, tier };
  if (input.pin && !input.pinVerified) return { ...result, kind: "hold", reason: "unverified-pin" };
  const rule = input.rules.preferences.find((item) => item.target === input.target && item.taskClass === taskClass);
  const habit = input.habit?.target === input.target && input.habit.taskClass === taskClass ? input.habit : undefined;
  const preference = rule ?? habit;
  const dimensions: AutoDimensions = input.pin ?? {};
  const exact = Boolean(input.pin?.model || input.pin?.effort || input.pin?.engine || input.pin?.account);
  const maker = task.reviewOf;
  const gridClass = input.target === "chat" && task.kind === "chat" && taskClass === "unknown" ? "chat" : taskClass;
  const routes: AutoRoute[] = [];
  const seenRoutes = new Set<string>();
  const tiers: AutoTier[] = tier === "cheap" ? ["cheap", "mid"] : tier === "mid" ? ["mid", "strong"] : ["strong"];
  for (const candidateTier of tiers) {
    for (const candidate of input.candidates) {
      if (!candidate.authorized || !candidate.signedIn || candidate.lifecycle !== "ready" || !candidate.subscription || candidate.generation !== candidate.currentGeneration
        || (dimensions.engine && dimensions.engine !== candidate.engine) || (dimensions.account && dimensions.account !== candidate.account)) continue;
      if (candidate.engine === "museAgent" && task.tools?.some((tool) => tool === "subagents" || tool === "workflow")) continue;
      const arms = [maker ? reviewArm(candidate.engine, taskClass, maker, tier) : gridArm(candidate.engine, candidateTier === tier ? gridClass : candidateTier === "mid" ? "build" : "unknown", candidateTier, task.scope)];
      const current = input.current;
      if (input.target === "chat" && current && !exact && !rule && !habit && !maker && candidateTier === tier
        && current.account === candidate.account && current.engine === candidate.engine
        && ["cheap", "mid", "strong"].indexOf(current.tier) >= ["cheap", "mid", "strong"].indexOf(tier)
        && autoPairReason(current.engine, current.model, current.effort) === "approved-task-or-review-cell") arms.unshift({ engine: current.engine, model: current.model, effort: current.effort });
      if (preference?.engine === candidate.engine && preference.model && (!dimensions.model || dimensions.model === preference.model)) {
        const preferred = { ...arms[0], model: preference.model, effort: preference.effort ?? arms[0].effort };
        if (candidate.engine === "antigravityAgent" && !preference.effort) {
          const encoded = /-(low|medium|high)$/.exec(preference.model)?.[1];
          if (encoded === "low" || encoded === "medium" || encoded === "high") preferred.effort = encoded;
        }
        if (preferred.model !== arms[0].model || preferred.effort !== arms[0].effort) arms.unshift(preferred);
      }
      if (!maker && candidate.engine === "codex" && input.rules.max && tier === "strong" && ["bug", "audit"].includes(taskClass) && !dimensions.model) arms.push(arm("codex", "gpt-6-luna", "max"));
      for (const chosen of arms) {
        if (dimensions.model) chosen.model = dimensions.model;
        if (dimensions.effort) chosen.effort = dimensions.effort;
        if (candidate.engine === "antigravityAgent" && dimensions.model && !dimensions.effort) {
          const encoded = /-(low|medium|high)$/.exec(dimensions.model)?.[1];
          if (encoded === "low" || encoded === "medium" || encoded === "high") chosen.effort = encoded;
        }
        if (candidate.engine === "antigravityAgent" && dimensions.effort && !dimensions.model) chosen.model = `${baseAutoModel(candidate.engine, chosen.model)}-${dimensions.effort}`;
        if (!validAutoArm(chosen) || !candidate.models.includes(chosen.model)) continue;
        if (candidate.engine !== "antigravityAgent" && !isEffortOffered(candidate.engine, chosen.model, chosen.effort, candidate.effortLevels)) continue;
        if (chosen.model.startsWith("claude-fable-") && (!dimensions.model || !exact || taskClass !== "audit" || !task.codeAudit)) continue;
        const argon = chosen.model.startsWith("gemini-4-argon-");
        if (argon && !(maker && BIG_JOBS.has(taskClass)) && !(exact && dimensions.model && (BIG_JOBS.has(taskClass) || task.scope === "large"))) continue;
        if (chosen.effort === "max" && (!input.rules.max || tier !== "strong" || !["bug", "audit"].includes(taskClass))) continue;
        if ((taskClass === "protected" || taskClass === "unknown") && gridClass !== "chat" && !maker && ![
          "claude-opus-5-5", "gpt-6-astra", "gpt-6.1-sol", "grok-4.7", "gemini-3.8-flash-high", "gemini-4-argon-high", "muse-spark-1.3-contributor",
        ].includes(chosen.model)) continue;
        if ((taskClass === "protected" || taskClass === "unknown") && gridClass !== "chat" && !["high", "xhigh", "max"].includes(chosen.effort)) continue;
        if (task.tools?.some((tool) => !candidate.tools.includes(tool)) || ((taskClass === "creative" || task.kind === "creative") && !candidate.tools.includes("image")) || (task.contextTokens ?? 0) > candidate.contextTokens) continue;
        const usage = assessUsage(candidate.engine, chosen.model, candidate.usage, input.now, candidate.priorUsage);
        if (usage === "low" || (usage === "unknown" && candidateTier !== tier)) continue;
        let reviewLabel: AutoRoute["reviewLabel"];
        if (maker) {
          reviewLabel = candidate.engine !== maker.engine ? "second family" : baseAutoModel(candidate.engine, chosen.model) !== baseAutoModel(maker.engine, maker.model) ? "same family" : "same model, fresh look";
          if ((task.requireSecondFamily || rule?.requireSecondFamily) && reviewLabel !== "second family") continue;
        }
        const route: AutoRoute = { ...chosen, account: candidate.account, generation: candidate.generation, tier: candidateTier };
        if (current && route.account === current.account && route.engine === current.engine && route.model === current.model && route.effort === current.effort) route.tier = current.tier;
        if (reviewLabel) { route.reviewLabel = reviewLabel; route.freshReview = true; }
        if (argon) route.independentCheck = true;
        const key = JSON.stringify([route.engine, route.account, route.generation, route.model, route.effort]);
        if (seenRoutes.has(key)) break;
        seenRoutes.add(key);
        routes.push(route);
        break;
      }
    }
    if (routes.length) break;
  }
  if (!routes.length && maker && !exact && !(task.requireSecondFamily || rule?.requireSecondFamily)) {
    const fallback = selectAutoRoute({ ...input, task: { ...task, reviewOf: undefined }, pin: maker, pinVerified: true });
    if (fallback.kind === "selected") return { ...fallback, route: { ...fallback.route, reviewLabel: "same model, fresh look", freshReview: true } };
  }
  if (!routes.length) return { ...result, kind: "hold", reason: exact ? "pin-unavailable" : "no-eligible-route" };
  let choices = routes;
  const preferred = choices.filter((route) => route.engine === preference?.engine && (!preference.model || route.model === preference.model) && (!preference.effort || route.effort === preference.effort));
  if (preferred.length) choices = preferred;
  if (maker) {
    const external = choices.filter((route) => route.engine !== maker.engine);
    if (external.length) choices = external;
    const preferred = choices.filter((route) => route.engine === preferredReviewEngine(taskClass, maker.engine));
    if (preferred.length) choices = preferred;
  }
  if (input.target === "chat" && input.current && !exact && !rule && !habit && !maker) {
    const current = choices.find((route) => route.account === input.current!.account && route.model === input.current!.model && route.effort === input.current!.effort && route.engine === input.current!.engine);
    if (current) return { ...result, kind: "selected", route: current, reason: "sticky" };
  }
  const models = new Set(choices.map((route) => `${route.engine}:${route.model}:${route.effort}`));
  if (models.size > 1 && CODING.has(taskClass) && choices.every((route) => CODE_ORDER.includes(route.model) || route.model === "grok-4.7" && route.effort === "xhigh" || route.model === "gpt-6-luna" && route.effort === "max")) {
    const rank = (route: AutoRoute) => CODE_ORDER.includes(route.model) ? CODE_ORDER.indexOf(route.model) : CODE_ORDER.length;
    const best = Math.min(...choices.map(rank));
    choices = choices.filter((route) => rank(route) === best);
  }
  if (new Set(choices.map((route) => `${route.engine}:${route.model}:${route.effort}`)).size > 1) return { ...result, kind: "pending", reason: maker ? "review-choice" : "equivalent-arms", choices };
  const score = (route: AutoRoute) => {
    const candidate = input.candidates.find((item) => item.account === route.account && item.engine === route.engine)!;
    return candidate.loadKnown && Number.isFinite(candidate.headroom) && assessUsage(route.engine, route.model, candidate.usage, input.now, candidate.priorUsage) === "ready"
      ? candidate.headroom! - 5 * (candidate.pending + candidate.active) : -Infinity;
  };
  choices.sort((a, b) => (score(b) - score(a) || Number(input.candidates.find((item) => item.account === b.account)?.main) - Number(input.candidates.find((item) => item.account === a.account)?.main) || a.account.localeCompare(b.account)));
  const usedPreference = choices[0].engine === preference?.engine && (!preference.model || choices[0].model === preference.model) && (!preference.effort || choices[0].effort === preference.effort);
  return { ...result, kind: "selected", route: choices[0], reason: exact ? "pin" : usedPreference && rule ? "rule" : usedPreference && habit ? "habit" : "grid" };
}

const eventBase = { routeId: opaqueId, at: time };
const decisionBase = {
  ...eventBase, v: z.literal(1), kind: z.literal("decision"), botRef: opaqueId, taskClass: autoTaskSchema,
  risk: z.enum(["low", "high", "protected", "unknown"]), classSource: z.enum(["declared", "keyword", "unknown"]), rulesVersion: time,
  pinned: z.array(z.enum(["engine", "model", "effort", "account"])).max(4), habit: autoTaskSchema.nullable(),
  reasonCode: z.enum(["pin", "rule", "habit", "grid", "sticky", "limit"]),
  excluded: z.array(z.object({ arm: autoArmSchema, reason: z.enum(["quota", "capability", "spend", "unavailable", "pin", "review"]) }).strict()).max(8),
  usageLeft: z.object({ session: z.number().min(0).max(100).nullable(), weekly: z.number().min(0).max(100).nullable(), ageSec: z.number().nonnegative().nullable() }).strict(),
};
const chosenSchema = z.object({ engine: z.enum(AUTO_ENGINES), model: z.string(), effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]), acctRef: opaqueId }).strict().refine(validAutoArm);
export const autoDecisionEventSchema = z.discriminatedUnion("target", [
  z.object({ ...decisionBase, chosen: chosenSchema, target: z.literal("worker"), pane8: z.string().regex(/^[a-f0-9]{8}$/).optional() }).strict(),
  z.object({ ...decisionBase, chosen: chosenSchema, target: z.literal("chat"), breakType: z.enum(["first", "idle", "compaction", "limit"]), budgetLeft: z.number().int().min(0).max(2), warm: z.boolean() }).strict(),
]);
const outcomeBase = { ...eventBase, kind: z.enum(["report", "limit", "stalled", "closed", "override"]), status: z.enum(["done", "failed", "blocked"]).nullable(), durationSec: z.number().nonnegative().nullable() };
const measurement = z.number().nonnegative().nullable();
export const autoOutcomeEventSchema = z.discriminatedUnion("target", [
  z.object({ ...outcomeBase, target: z.literal("worker") }).strict(),
  z.object({ ...outcomeBase, target: z.literal("chat"), inputTokens: measurement, cachedTokens: measurement, outputTokens: measurement, firstAnswerMs: measurement }).strict(),
]);
export type AutoDecisionEvent = z.infer<typeof autoDecisionEventSchema>;
export type AutoOutcomeEvent = z.infer<typeof autoOutcomeEventSchema>;
