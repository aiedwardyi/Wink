import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import type { EffortLevel } from "../server/contracts.ts";
import { AUTO_ENGINES, AUTO_TASKS, autoDecisionEventSchema, autoOutcomeEventSchema, autoPairReason, classifyAutoTask, gridArm, selectAutoRoute, validAutoArm, verifiedChoice, type AutoArm, type AutoCandidate, type AutoEngine, type AutoSelectionInput, type AutoTask, type ChoiceContext, type ChoiceProvenance } from "./auto-routing.ts";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const LEVELS: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const C = ["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const X = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"];
const G = ["grok-4.7", "grok-4.6"];
const A = ["gemini-4-argon", "gemini-3.8-flash"].flatMap((model) => ["low", "medium", "high"].map((effort) => `${model}-${effort}`));
const M = ["muse-spark-1.3", "muse-spark-1.3-contributor"];
const ROSTER = { claudeAgent: C, codex: X, grokAgent: G, antigravityAgent: A, museAgent: M } satisfies Record<AutoEngine, string[]>;

export function autoCandidate(engine: AutoEngine, patch: Partial<AutoCandidate> = {}): AutoCandidate {
  return { engine, account: `local-${engine}`, generation: 1, currentGeneration: 1, authorized: true, signedIn: true,
    lifecycle: "ready", subscription: true, models: ROSTER[engine], effortLevels: LEVELS, tools: ["image", "files"], contextTokens: 100000,
    usage: { observedAt: new Date(NOW).toISOString(), windows: [{ id: "seven_day", usedPercent: 30, resetsAt: null }] },
    pending: 0, active: 0, loadKnown: true, headroom: 70, main: true, ...patch };
}

function input(engine: AutoEngine, kind: AutoTask, patch: Partial<AutoSelectionInput> = {}): AutoSelectionInput {
  return { target: "worker", task: { kind, risk: "low", scope: "bounded", source: "declared" }, now: NOW,
    candidates: [autoCandidate(engine)], rules: { max: false, preferences: [] }, rulesVersion: 0, ...patch };
}

type ExpectedGrid = Record<AutoEngine, Array<[string, EffortLevel]>>;
const EXPECTED = {
  claudeAgent: [[C[4], "low"], [C[3], "medium"], [C[2], "high"], [C[3], "medium"], [C[4], "medium"], [C[3], "medium"], [C[2], "high"], [C[2], "high"], [C[2], "high"], [C[2], "high"], [C[2], "high"]],
  codex: [[X[3], "low"], [X[1], "medium"], [X[1], "high"], [X[2], "medium"], [X[2], "high"], [X[2], "medium"], [X[1], "high"], [X[1], "high"], [X[1], "high"], [X[1], "high"], [X[1], "high"]],
  grokAgent: [[G[0], "medium"], [G[0], "medium"], [G[0], "high"], [G[0], "medium"], [G[0], "high"], [G[0], "medium"], [G[0], "high"], [G[0], "xhigh"], [G[0], "xhigh"], [G[0], "xhigh"], [G[0], "xhigh"]],
  antigravityAgent: [[A[3], "low"], [A[4], "medium"], [A[4], "medium"], [A[4], "medium"], [A[4], "medium"], [A[4], "medium"], [A[5], "high"], [A[5], "high"], [A[5], "high"], [A[5], "high"], [A[5], "high"]],
  museAgent: [[M[0], "low"], [M[0], "medium"], [M[0], "medium"], [M[0], "medium"], [M[0], "medium"], [M[0], "medium"], [M[0], "high"], [M[0], "high"], [M[0], "high"], [M[0], "high"], [M[0], "high"]],
} satisfies ExpectedGrid;
const SAME_FAMILY = {
  claudeAgent: [C[3], C[2], C[3], C[2], C[2], C[2], C[3], C[3], C[3], C[3], C[3]],
  codex: [X[2], X[2], X[2], X[1], X[1], X[1], X[2], X[2], X[2], X[2], X[0]],
  grokAgent: Array(11).fill(G[0]),
  antigravityAgent: [A[5], A[5], A[5], A[5], A[5], A[5], A[5], A[5], A[5], A[5], A[5]],
  museAgent: Array(11).fill(M[0]),
};
const CROSS_FAMILY = {
  claudeAgent: [X[1], X[1], G[0], X[1], X[1], X[1], X[1], X[1], X[1], X[1], X[1]],
  codex: [C[3], C[2], G[0], C[3], C[2], C[2], C[2], C[2], C[2], C[2], C[2]],
  grokAgent: [C[3], C[3], C[3], C[3], X[1], X[1], X[1], C[2], C[2], C[2], C[2]],
  antigravityAgent: [C[3], C[3], G[0], C[3], X[1], X[1], X[1], C[2], C[2], C[2], C[2]],
  museAgent: [C[3], C[3], G[0], C[3], X[1], X[1], X[1], C[2], C[2], C[2], C[2]],
};

describe("approved task grid", () => {
  for (const engine of AUTO_ENGINES) it.each(AUTO_TASKS)(`${engine} %s`, (kind) => {
    const result = selectAutoRoute(input(engine, kind));
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") expect([result.route.model, result.route.effort]).toEqual(EXPECTED[engine][AUTO_TASKS.indexOf(kind)]);
  });

  for (const engine of AUTO_ENGINES) it.each(AUTO_TASKS)(`${engine} %s review columns`, (kind) => {
    const task = { kind, risk: "low" as const, scope: "bounded" as const, reviewOf: gridArm(engine, kind) };
    const same = selectAutoRoute(input(engine, kind, { task }));
    const cross = selectAutoRoute(input(engine, kind, { task, candidates: AUTO_ENGINES.map((engine) => autoCandidate(engine)) }));
    const index = AUTO_TASKS.indexOf(kind);
    expect(same).toMatchObject({ kind: "selected", route: { model: SAME_FAMILY[engine][index], effort: "high", freshReview: true } });
    expect(cross).toMatchObject({ kind: "selected", route: { model: CROSS_FAMILY[engine][index], effort: "high", reviewLabel: "second family" } });
  });

  it.each(AUTO_ENGINES)("has a chat default and conservative unknown route for %s", (engine) => {
    expect(gridArm(engine, "chat")).toBeDefined();
    expect(selectAutoRoute(input(engine, "unknown", { task: {} }))).toMatchObject({ kind: "selected", tier: "strong", taskClass: "unknown" });
  });

  it("raises short and Korean hard asks without using length as ease", () => {
    for (const text of ["security fix", "로그인 고쳐", "보안 검토", "migration"]) expect(classifyAutoTask({ kind: "quick", risk: "low", scope: "bounded", text })).toMatchObject({ taskClass: "protected", tier: "strong" });
    for (const text of ["hard bug", "어려운 버그", "경쟁 상태"]) expect(classifyAutoTask({ kind: "quick", risk: "low", scope: "bounded", text }).tier).toBe("strong");
    for (const task of [{}, { kind: "quick" as const }, { kind: "quick" as const, risk: "low" as const, scope: "bounded" as const, conflicting: true }]) expect(classifyAutoTask(task)).toMatchObject({ tier: "strong", taskClass: "unknown" });
    for (const source of ["keyword", "unknown"] as const) expect(classifyAutoTask({ kind: "quick", risk: "low", scope: "bounded", source }).tier).toBe("strong");
  });

  it("uses approved variants for mechanical, source review and large designs", () => {
    expect(selectAutoRoute(input("codex", "edit", { task: { kind: "edit", risk: "low", scope: "mechanical" } }))).toMatchObject({ kind: "selected", route: { effort: "low" } });
    expect(selectAutoRoute(input("claudeAgent", "research", { task: { kind: "research", risk: "low", scope: "multi-source" } }))).toMatchObject({ kind: "selected", route: { model: C[3], effort: "high" } });
  });

  it("keeps the approved unknown first-chat defaults", () => {
    expect(selectAutoRoute(input("claudeAgent", "chat", { target: "chat", task: { kind: "chat", risk: "unknown" } }))).toMatchObject({ kind: "selected", tier: "strong", route: { model: C[2], effort: "medium" } });
    expect(selectAutoRoute(input("antigravityAgent", "chat", { target: "chat", task: { kind: "chat", risk: "unknown" } }))).toMatchObject({ kind: "selected", route: { model: A[5], effort: "high" } });
  });
});

describe("effort coverage and hard admission", () => {
  for (const engine of AUTO_ENGINES) for (const model of ROSTER[engine]) it.each(LEVELS)(`${model} %s has a disposition`, (effort) => {
    expect(autoPairReason(engine, model, effort)).toBeTruthy();
    expect(validAutoArm({ engine, model, effort })).toBe(engine === "antigravityAgent" ? model.endsWith(`-${effort}`) : engine === "grokAgent" ? ["low", "medium", "high", "xhigh"].includes(effort) : effort !== "minimal" || engine === "museAgent");
  });

  it.each(AUTO_ENGINES)("never guesses a custom or old model for %s", (engine) => {
    for (const model of ["custom", "gpt-5.5", "muse-spark-1.2", "gemini-3.7-flash-high", "grok-4.5"]) {
      expect(autoPairReason(engine, model, "high")).toBe("outside-approved-roster");
      expect(selectAutoRoute(input(engine, "quick", { candidates: [autoCandidate(engine, { models: [model] })] })).kind).toBe("hold");
    }
  });

  it.each<Partial<AutoCandidate>>([
    { authorized: false }, { signedIn: false }, { lifecycle: "draining" }, { lifecycle: "stopped" }, { subscription: false },
    { currentGeneration: 2 }, { effortLevels: [] }, { contextTokens: 0 }, { tools: [] },
  ])("rejects a failed capability/spend gate %j", (patch) => {
    expect(selectAutoRoute(input("codex", "build", { task: { kind: "build", risk: "low", scope: "bounded", tools: ["files"], contextTokens: 1 }, candidates: [autoCandidate("codex", patch)] })).kind).toBe("hold");
  });

  it("does not grant image or Muse workflow/subagent capability by model name", () => {
    expect(selectAutoRoute(input("codex", "creative", { candidates: [autoCandidate("codex", { tools: [] })] })).kind).toBe("hold");
    for (const tool of ["workflow", "subagents"]) expect(selectAutoRoute(input("museAgent", "build", { task: { kind: "build", risk: "low", scope: "bounded", tools: [tool] }, candidates: [autoCandidate("museAgent", { tools: [tool] })] })).kind).toBe("hold");
  });

  it("keeps Fable explicit and code-audit-only", () => {
    const pin = { engine: "claudeAgent" as const, model: C[0], effort: "high" as const };
    expect(selectAutoRoute(input("claudeAgent", "audit", { pin, pinVerified: true, task: { kind: "audit", risk: "high", scope: "bounded", codeAudit: true } }))).toMatchObject({ kind: "selected", route: pin });
    for (const codeAudit of [false, undefined]) expect(selectAutoRoute(input("claudeAgent", "audit", { pin, pinVerified: true, task: { kind: "audit", risk: "high", scope: "bounded", codeAudit } })).kind).toBe("hold");
    expect(selectAutoRoute(input("claudeAgent", "audit", { candidates: [autoCandidate("claudeAgent", { models: [C[0]] })] })).kind).toBe("hold");
  });

  it("keeps Argon explicit for big work and marks independent checking", () => {
    const pin = { engine: "antigravityAgent" as const, model: A[2] };
    expect(selectAutoRoute(input("antigravityAgent", "design", { pin, pinVerified: true }))).toMatchObject({ kind: "selected", route: { model: A[2], independentCheck: true } });
    expect(selectAutoRoute(input("antigravityAgent", "quick", { pin, pinVerified: true })).kind).toBe("hold");
    expect(selectAutoRoute(input("antigravityAgent", "bug", { candidates: [autoCandidate("antigravityAgent", { models: [A[2]] })] })).kind).toBe("hold");
  });

  it("honors verified Max independently of Grok xhigh and rejects effort/encoded-id mismatch", () => {
    const pin = { model: X[0], effort: "max" as const };
    expect(selectAutoRoute(input("codex", "bug", { pin, pinVerified: true }))).toMatchObject({ kind: "selected", route: { effort: "max" } });
    expect(selectAutoRoute(input("codex", "bug", { pin, pinVerified: true, rules: { max: true, preferences: [] } }))).toMatchObject({ kind: "selected", route: { effort: "max" } });
    expect(selectAutoRoute(input("codex", "quick", { pin, pinVerified: true, rules: { max: true, preferences: [] } }))).toMatchObject({ kind: "selected", route: { effort: "max" } });
    expect(selectAutoRoute(input("codex", "bug", { pin, pinVerified: false })).kind).toBe("hold");
    expect(selectAutoRoute(input("grokAgent", "bug"))).toMatchObject({ kind: "selected", route: { effort: "xhigh" } });
    expect(selectAutoRoute(input("antigravityAgent", "bug", { pin: { model: A[3], effort: "high" }, pinVerified: true })).kind).toBe("hold");
    expect(autoPairReason("antigravityAgent", A[3], "high")).toBe("encoded-effort-mismatch");
  });

  it("never lets a pin or habit weaken protected work", () => {
    expect(selectAutoRoute(input("codex", "protected", { pin: { model: X[3], effort: "low" }, pinVerified: true })).kind).toBe("hold");
    expect(selectAutoRoute(input("codex", "protected", { habit: { target: "worker", taskClass: "protected", engine: "codex", model: X[3], effort: "low" } }))).toMatchObject({ kind: "selected", route: { model: X[1], effort: "high" } });
  });

  it.each(AUTO_ENGINES.filter((engine) => engine !== "antigravityAgent"))("requires offered effort on every explicit %s choice", (engine) => {
    const model = gridArm(engine, "audit").model;
    for (const effort of LEVELS) expect(selectAutoRoute(input(engine, "audit", { pin: { model, effort }, pinVerified: true, rules: { max: true, preferences: [] }, candidates: [autoCandidate(engine, { effortLevels: [] })] })).kind).toBe("hold");
  });
});

describe("precedence, fallback and review", () => {
  it("honors partial pins before rules, habits and defaults", () => {
    const rules = { max: false, preferences: [{ target: "worker" as const, taskClass: "build" as const, engine: "claudeAgent" as const, model: C[3], effort: "high" as const }] };
    const habit = { target: "worker" as const, taskClass: "build" as const, engine: "codex" as const, model: X[2], effort: "medium" as const };
    const candidates = [autoCandidate("claudeAgent"), autoCandidate("codex")];
    expect(selectAutoRoute(input("codex", "build", { candidates, rules, habit }))).toMatchObject({ kind: "selected", reason: "rule", route: { model: C[3] } });
    expect(selectAutoRoute(input("codex", "build", { candidates, rules, habit, pin: { engine: "codex" }, pinVerified: true }))).toMatchObject({ kind: "selected", reason: "pin", route: { engine: "codex" } });
    expect(selectAutoRoute(input("codex", "build", { habit }))).toMatchObject({ kind: "selected", reason: "habit", route: { model: X[2] } });
    expect(selectAutoRoute(input("codex", "build", { pin: { effort: "high" }, pinVerified: true }))).toMatchObject({ kind: "selected", route: { effort: "high" } });
    expect(selectAutoRoute(input("codex", "build", { pin: { account: "missing" }, pinVerified: true })).kind).toBe("hold");
    expect(selectAutoRoute(input("codex", "build", { pin: { model: X[1] } })).kind).toBe("hold");
  });

  it("tries the same tier on another engine before one tier up", () => {
    const candidates = [autoCandidate("claudeAgent", { models: [C[3], C[2]] }), autoCandidate("codex")];
    expect(selectAutoRoute(input("claudeAgent", "quick", { candidates }))).toMatchObject({ kind: "selected", route: { engine: "codex", model: X[3], tier: "cheap" } });
    expect(selectAutoRoute(input("claudeAgent", "quick", { candidates: candidates.slice(0, 1) }))).toMatchObject({ kind: "selected", route: { model: C[2], tier: "mid" } });
    expect(selectAutoRoute(input("claudeAgent", "quick", { candidates: [autoCandidate("claudeAgent", { models: [C[3]] })] })).kind).toBe("hold");
    expect(selectAutoRoute(input("claudeAgent", "protected", { candidates: [autoCandidate("claudeAgent", { models: [C[4], C[3]] })] })).kind).toBe("hold");
  });

  it("uses load and Main only between equivalent arms", () => {
    const base = autoCandidate("codex", { account: "a", pending: 3 });
    const other = autoCandidate("codex", { account: "b", main: false });
    expect(selectAutoRoute(input("codex", "build", { candidates: [base, other] }))).toMatchObject({ kind: "selected", route: { account: "b" } });
    expect(selectAutoRoute(input("codex", "build", { candidates: [{ ...base, pending: 0 }, other] }))).toMatchObject({ kind: "selected", route: { account: "a" } });
    expect(selectAutoRoute(input("codex", "build", { candidates: [{ ...base, pending: 0, headroom: 100, usage: undefined }, other] }))).toMatchObject({ kind: "selected", route: { account: "b" } });
  });

  it("uses the grid if a preference is unavailable and does not upgrade on missing usage", () => {
    const rules = { max: false, preferences: [{ target: "worker" as const, taskClass: "build" as const, engine: "claudeAgent" as const, model: C[3], effort: "high" as const }] };
    expect(selectAutoRoute(input("codex", "build", { rules }))).toMatchObject({ kind: "selected", route: { engine: "codex" }, reason: "grid" });
    expect(selectAutoRoute(input("claudeAgent", "quick", { candidates: [autoCandidate("claudeAgent", { models: [C[3]], usage: undefined })] })).kind).toBe("hold");
    expect(selectAutoRoute(input("claudeAgent", "quick", { candidates: [autoCandidate("claudeAgent", { usage: undefined })] }))).toMatchObject({ kind: "selected", route: { model: C[4] } });
    expect(selectAutoRoute(input("antigravityAgent", "chat", { rules: { max: false, preferences: [{ target: "worker", taskClass: "chat", engine: "antigravityAgent", model: A[5] }] } }))).toMatchObject({ kind: "selected", reason: "rule", route: { model: A[5], effort: "high" } });
  });

  it("uses the approved tie criteria between Grok xhigh and opt-in Luna max alternatives", () => {
    const result = selectAutoRoute(input("codex", "bug", { rules: { max: true, preferences: [] }, candidates: [autoCandidate("codex", { models: [X[3]] }), autoCandidate("grokAgent")] }));
    expect(result).toMatchObject({ kind: "selected", route: { model: X[3], effort: "max" } });
    expect(selectAutoRoute(input("codex", "bug", { rules: { max: true, preferences: [] }, chatEngine: "grokAgent", candidates: [autoCandidate("codex", { models: [X[3]] }), autoCandidate("grokAgent")] }))).toMatchObject({ kind: "selected", route: { model: G[0], effort: "xhigh" } });
    const duplicated = autoCandidate("codex");
    expect(selectAutoRoute(input("codex", "bug", { rules: { max: true, preferences: [] }, candidates: [duplicated, duplicated] }))).toMatchObject({ kind: "selected", route: { model: X[1], effort: "high" } });
  });

  it("keeps an adequate current chat route even when the grid now prefers another arm", () => {
    const current = { engine: "codex" as const, model: X[1], effort: "high" as const, account: "local-codex", tier: "mid" as const };
    expect(selectAutoRoute(input("codex", "chat", { target: "chat", current }))).toMatchObject({ kind: "selected", reason: "sticky", route: current });
    const lower = { ...current, model: X[2], effort: "medium" as const };
    expect(selectAutoRoute(input("codex", "bug", { target: "chat", current: lower }))).toMatchObject({ kind: "selected", route: { model: X[1], tier: "strong" } });
  });

  it("never turns coding tie order into a cheap-task order", () => {
    const result = selectAutoRoute(input("claudeAgent", "quick", { candidates: [autoCandidate("claudeAgent"), autoCandidate("codex")] }));
    expect(result).toMatchObject({ kind: "selected", route: { model: C[4], effort: "low" } });
    const duplicate = autoCandidate("claudeAgent");
    const deduped = selectAutoRoute(input("claudeAgent", "quick", { candidates: [duplicate, duplicate, autoCandidate("codex")] }));
    expect(deduped).toMatchObject({ kind: "selected", route: { model: C[4] } });
  });

  it.each(AUTO_ENGINES)("labels a same-family fresh review for %s", (engine) => {
    const maker = gridArm(engine, "build");
    const result = selectAutoRoute(input(engine, "build", { task: { kind: "build", risk: "low", scope: "bounded", reviewOf: maker } }));
    const oneModel = ["antigravityAgent", "grokAgent", "museAgent"].includes(engine);
    expect(result).toMatchObject({ kind: "selected", route: { reviewLabel: oneModel ? "same model, fresh look" : "same family", freshReview: true } });
    if (result.kind === "selected" && !oneModel) expect(result.route.model).not.toBe(maker.model);
  });

  it("prefers a second engine and honors a required second family", () => {
    const reviewOf: AutoArm = { engine: "claudeAgent", model: C[2], effort: "high" };
    const task = { kind: "audit" as const, risk: "high" as const, scope: "bounded" as const, reviewOf };
    expect(selectAutoRoute(input("claudeAgent", "audit", { task, candidates: [autoCandidate("claudeAgent"), autoCandidate("codex")] }))).toMatchObject({ kind: "selected", route: { engine: "codex", reviewLabel: "second family" } });
    expect(selectAutoRoute(input("claudeAgent", "audit", { task: { ...task, requireSecondFamily: true } })).kind).toBe("hold");
  });

  it("keeps Gemini second eyes on Flash and labels same-model fallback", () => {
    const reviewOf: AutoArm = { engine: "antigravityAgent", model: A[5], effort: "high" };
    expect(selectAutoRoute(input("antigravityAgent", "architecture", { task: { kind: "architecture", risk: "high", scope: "large", reviewOf } }))).toMatchObject({ kind: "selected", route: { model: A[5], reviewLabel: "same model, fresh look" } });
    const maker: AutoArm = { engine: "codex", model: X[1], effort: "high" };
    expect(selectAutoRoute(input("codex", "build", { candidates: [autoCandidate("codex", { models: [X[1]] })], task: { kind: "build", risk: "low", scope: "bounded", reviewOf: maker } }))).toMatchObject({ kind: "selected", route: { model: X[1], reviewLabel: "same model, fresh look" } });
    expect(selectAutoRoute(input("antigravityAgent", "architecture", { task: { kind: "architecture", risk: "high", scope: "large", reviewOf: { ...reviewOf, model: A[2] } } }))).toMatchObject({ kind: "selected", route: { model: A[5], reviewLabel: "same family" } });
    expect(selectAutoRoute(input("antigravityAgent", "quick", { task: { kind: "quick", risk: "low", scope: "bounded", reviewOf: { ...reviewOf, model: A[3], effort: "low" } } }))).toMatchObject({ kind: "selected", route: { model: A[5], reviewLabel: "same model, fresh look" } });
  });
});

describe("approved cross-engine ties", () => {
  function quota(engine: AutoEngine, session: number | null, weekly: number | null): AutoCandidate {
    const windows = [];
    if (session !== null) windows.push({ id: "five_hour", usedPercent: 100 - session, resetsAt: null });
    if (weekly !== null) windows.push({ id: "seven_day", usedPercent: 100 - weekly, resetsAt: null });
    return autoCandidate(engine, { usage: { observedAt: new Date(NOW).toISOString(), windows } });
  }

  it("prefers a matching verified habit's engine before chat continuity and quota", () => {
    const habit = { target: "worker" as const, taskClass: "quick" as const, engine: "codex" as const, model: X[2], effort: "medium" as const };
    const candidates = [quota("claudeAgent", 90, 90), { ...quota("codex", 30, 10), models: [X[3]] }];
    expect(selectAutoRoute(input("claudeAgent", "quick", { habit, chatEngine: "claudeAgent", candidates }))).toMatchObject({ kind: "selected", reason: "habit", route: { engine: "codex", model: X[3] } });
    for (const unrelated of [{ ...habit, taskClass: "build" as const }, { ...habit, target: "chat" as const }]) expect(selectAutoRoute(input("claudeAgent", "quick", { habit: unrelated, candidates }))).toMatchObject({ kind: "selected", route: { engine: "claudeAgent" } });
  });

  it("prefers the existing chat engine before more quota or engine ID", () => {
    const candidates = [quota("claudeAgent", 90, 90), quota("codex", 30, 10)];
    expect(selectAutoRoute(input("codex", "quick", { chatEngine: "codex", candidates }))).toMatchObject({ kind: "selected", route: { engine: "codex" } });
    const current = { engine: "codex" as const, model: X[1], effort: "medium" as const, account: "local-codex", tier: "mid" as const };
    expect(selectAutoRoute(input("codex", "quick", { current, candidates }))).toMatchObject({ kind: "selected", route: { engine: "codex" } });
  });

  it("compares 5h room before 7d room", () => {
    expect(selectAutoRoute(input("codex", "quick", { candidates: [quota("claudeAgent", 70, 90), quota("codex", 80, 10)] }))).toMatchObject({ kind: "selected", route: { engine: "codex" } });
  });

  it("compares 7d room when 5h room ties or is missing", () => {
    for (const session of [80, null]) expect(selectAutoRoute(input("codex", "quick", { candidates: [quota("claudeAgent", session, 70), quota("codex", session, 80)] }))).toMatchObject({ kind: "selected", route: { engine: "codex" } });
  });

  it("uses stable engine IDs for new strong arms, independent of input order", () => {
    const candidates = AUTO_ENGINES.map((engine) => quota(engine, 70, 70));
    for (const ordered of [candidates, [...candidates].reverse(), [...candidates.slice(2), ...candidates.slice(0, 2)]]) expect(selectAutoRoute(input("codex", "bug", { candidates: ordered }))).toMatchObject({ kind: "selected", route: { engine: "antigravityAgent", model: A[5] } });
  });

  it("uses binding applicable caps rather than unrelated model buckets or cached scores", () => {
    const codex = quota("codex", 80, 80);
    codex.usage!.windows = [...codex.usage!.windows, { id: "spark:five_hour", usedPercent: 100, resetsAt: null }];
    expect(selectAutoRoute(input("codex", "quick", { candidates: [quota("claudeAgent", 70, 70), codex] }))).toMatchObject({ kind: "selected", route: { engine: "codex" } });
    codex.usage!.windows = [...codex.usage!.windows, { id: "gpt-6-luna:five_hour", usedPercent: 40, resetsAt: null }];
    expect(selectAutoRoute(input("codex", "quick", { candidates: [quota("claudeAgent", 70, 70), codex] }))).toMatchObject({ kind: "selected", route: { engine: "claudeAgent" } });
  });

  it("does not treat stale or missing quota as healthy headroom", () => {
    const stale = quota("claudeAgent", 99, 99);
    stale.usage!.observedAt = new Date(NOW - 300001).toISOString();
    for (const usage of [stale.usage, undefined, { observedAt: "invalid", windows: stale.usage!.windows }]) expect(selectAutoRoute(input("codex", "quick", { candidates: [{ ...stale, usage, headroom: 100 }, quota("codex", 40, 10)] }))).toMatchObject({ kind: "selected", route: { engine: "codex" } });
  });

  it("keeps hard gates and the existing coding grid ahead of tie preferences", () => {
    expect(selectAutoRoute(input("codex", "quick", { chatEngine: "codex", candidates: [quota("claudeAgent", 70, 70), quota("codex", 24, 90)] }))).toMatchObject({ kind: "selected", route: { engine: "claudeAgent" } });
    expect(selectAutoRoute(input("codex", "audit", { chatEngine: "codex", candidates: [quota("claudeAgent", 30, 10), quota("codex", 90, 90)] }))).toMatchObject({ kind: "selected", route: { engine: "claudeAgent", model: C[2] } });
  });
});

describe("current-user provenance", () => {
  const dimensions = { engine: "codex" as const, model: X[1], effort: "high" as const };
  const choice: ChoiceProvenance = { actorId: "owner", actionId: "action", target: "worker", taskClass: "build", origin: "chat", dimensions, userQuote: "Use Sol high" };
  const context: ChoiceContext = { authenticatedUserId: "owner", currentActionId: "action", authorized: true, target: "worker", taskClass: "build", directUserText: "Use Sol high for this build", intent: "choice", attributed: dimensions };

  it("accepts exact attributed quotes and authenticated picker actions", () => {
    expect(verifiedChoice(choice, context)).toBe(true);
    expect(verifiedChoice({ ...choice, origin: "ui", userQuote: undefined }, { ...context, trustedUiEventId: "action" })).toBe(true);
  });

  it.each(["bot", "quoted", "fallback", "sync", "import", "peer", "native-cli"] as const)("rejects %s attribution", (origin) => expect(verifiedChoice({ ...choice, origin }, context)).toBe(false));
  it("rejects mentions, missing dimensions, stale actions, wrong owners and ambiguous quotes", () => {
    const invalid: Partial<ChoiceContext>[] = [{ intent: "hint" }, { authorized: false }, { currentActionId: "prior" }, { authenticatedUserId: "peer" }, { target: "chat" }, { taskClass: "audit" }, { attributed: {} }, { directUserText: "quoted Sol high" }];
    for (const patch of invalid) expect(verifiedChoice(choice, { ...context, ...patch })).toBe(false);
    for (const patch of [{ userQuote: "" }, { userQuote: "Sol high?" }, { dimensions: {} }]) expect(verifiedChoice({ ...choice, ...patch }, context)).toBe(false);
  });
});

describe("minimal event contracts", () => {
  const decision = { v: 1, kind: "decision", routeId: "a".repeat(32), botRef: "b".repeat(32), at: NOW, target: "worker", taskClass: "build", risk: "low", classSource: "declared", rulesVersion: 1,
    pinned: [], habit: null, chosen: { engine: "codex", model: X[1], effort: "high", acctRef: "c".repeat(32) }, reasonCode: "grid", excluded: [], usageLeft: { session: null, weekly: null, ageSec: null } };
  it("validates only allowlisted categorical/opaque data", () => {
    const parsed = autoDecisionEventSchema.parse(decision);
    expect(JSON.stringify(parsed)).not.toMatch(/[\\/@]|acct_/);
    for (const extra of [{ label: "label" }, { request: "text" }, { path: "folder" }, { runtimeModel: X[1] }, { chosen: { ...decision.chosen, acctRef: "acct_private" } }, { excluded: Array(9).fill({ arm: { engine: "codex", model: X[1], effort: "high" }, reason: "quota" }) }]) expect(autoDecisionEventSchema.safeParse({ ...decision, ...extra }).success).toBe(false);
  });
  it("does not offer worker tokens or observed models", () => {
    const outcome = { routeId: decision.routeId, at: NOW, target: "worker", kind: "report", status: "done", durationSec: 3 };
    expect(autoOutcomeEventSchema.safeParse(outcome).success).toBe(true);
    for (const extra of [{ inputTokens: 1 }, { runtimeModel: X[1] }, { label: "task" }]) expect(autoOutcomeEventSchema.safeParse({ ...outcome, ...extra }).success).toBe(false);
  });
});

it("selects cached typed input below 5 ms p95", () => {
  const fixture = input("codex", "build", { candidates: AUTO_ENGINES.flatMap((engine) => Array.from({ length: 4 }, (_, n) => autoCandidate(engine, { account: `local-${engine}-${n}` }))) });
  for (let i = 0; i < 1000; i++) selectAutoRoute(fixture);
  const timings = Array.from({ length: 10000 }, () => { const start = performance.now(); selectAutoRoute(fixture); return performance.now() - start; }).sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95)];
  console.log(`Auto selector: 20 candidates, 10000 samples, p95=${p95.toFixed(4)} ms`);
  expect(p95).toBeLessThan(5);
});
