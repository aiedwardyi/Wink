import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { type ChoiceContext, type ChoiceProvenance } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";
import { AutoRoutingHabits, type AutoHabitRow } from "./auto-routing-habits.ts";
import { AutoRoutingRules, type AutoRuleOperation, type RuleAuthorization } from "./auto-routing-rules.ts";
import { AutoRoutingState, EMPTY_AUTO_BUDGET } from "./auto-routing.ts";
import { packageAgentAsMember, parseBotPackage } from "./bot-package.ts";
import { DATA_DIR } from "./config.ts";
import { applySyncOperations, createSyncOperation, emptyProfileSyncState } from "./profile-sync.ts";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const DAY = 24 * 60 * 60_000;
let serial = 0;
function directory() { const dir = join(DATA_DIR, `auto-routing-${++serial}`); mkdirSync(dir, { recursive: true }); return dir; }
function authorization(operation: AutoRuleOperation, patch: Partial<RuleAuthorization> = {}): RuleAuthorization {
  return { authenticatedUserId: "owner", actorId: "owner", authorized: true, actionId: "current", currentActionId: "current", directUserText: "Set my Auto rule", userQuote: "Set my Auto rule", origin: "direct-user", attributed: operation.op === "setPreference" ? operation.preference ?? (operation.max ? { effort: "max" } : {}) : {}, ...patch };
}
const preference = { target: "worker" as const, taskClass: "build" as const, engine: "codex" as const, model: "gpt-6.1-sol", effort: "high" as const };
const set: AutoRuleOperation = { op: "setPreference", preference };

describe("local versioned Auto rules", () => {
  it("retains shipped base, last twenty versions, and reverts by adding a new version", () => {
    const dir = directory();
    const rules = new AutoRoutingRules(dir);
    expect(rules.current()).toEqual({ id: 0, content: { max: false, preferences: [] } });
    rules.apply(set, authorization(set));
    const first = rules.current();
    const enable: AutoRuleOperation = { op: "setPreference", max: true };
    rules.apply(enable, authorization(enable));
    const revert: AutoRuleOperation = { op: "revert", version: 1 };
    expect(rules.apply(revert, authorization(revert)).id).toBe(3);
    expect(rules.current().content).toEqual(first.content);
    const reset: AutoRuleOperation = { op: "reset" };
    for (let i = 0; i < 25; i++) rules.apply(reset, authorization(reset));
    expect(rules.versions()).toHaveLength(21);
    expect(rules.versions()[0]).toBe(0);
    expect(JSON.parse(readFileSync(rules.file, "utf8")).versions).toHaveLength(20);
    const base: AutoRuleOperation = { op: "revert", version: 0 };
    rules.apply(base, authorization(base));
    expect(new AutoRoutingRules(dir).current()).toEqual(rules.current());
    expect(rules.current().content).toEqual({ max: false, preferences: [] });
    expect(() => rules.apply(revert, authorization(revert))).toThrow("unavailable");
  });

  it("supports remove and keeps returned state detached", () => {
    const rules = new AutoRoutingRules(directory());
    rules.apply(set, authorization(set));
    rules.current().content.preferences.length = 0;
    expect(rules.current().content.preferences).toEqual([preference]);
    const remove: AutoRuleOperation = { op: "remove", target: "worker", taskClass: "build" };
    rules.apply(remove, authorization(remove));
    expect(rules.current().content.preferences).toEqual([]);
  });

  it("leaves disk and memory intact on schema, authorization and atomic write failures", () => {
    const dir = directory();
    let fail = false;
    const rules = new AutoRoutingRules(dir, (...args) => { if (fail) throw new Error("disk failure"); writeFileAtomic(...args); });
    rules.apply(set, authorization(set));
    const saved = readFileSync(rules.file, "utf8");
    const current = rules.current();
    const reset: AutoRuleOperation = { op: "reset" };
    const invalid: Partial<RuleAuthorization>[] = [{ origin: "quoted" }, { actorId: "peer" }, { authorized: false }, { actionId: "old" }, { userQuote: "" }, { directUserText: "a mention of Sol" }, { attributed: {} }];
    for (const patch of invalid) expect(() => rules.apply(set, authorization(set, patch))).toThrow();
    for (const bad of [{ op: "setPreference", max: true, preference }, { op: "setPreference" }, { op: "reset", protectedDowngrade: true }, { op: "setPreference", preference: { ...preference, model: "custom" } }, { op: "setPreference", preference: { ...preference, effort: "minimal" } }]) expect(() => {
      // @ts-expect-error Invalid serialized operations must fail without changing storage.
      rules.apply(bad, authorization(set));
    }).toThrow();
    fail = true;
    expect(() => rules.apply(reset, authorization(reset))).toThrow("disk failure");
    expect(rules.current()).toEqual(current);
    expect(readFileSync(rules.file, "utf8")).toBe(saved);
  });

  it("never treats corrupt or unsupported local state as fresh defaults", () => {
    const dir = directory();
    const file = join(dir, "auto-routing-rules.json");
    for (const content of ["{broken", '{"v":2}', '{"v":1,"current":{"id":0,"content":{"max":true,"preferences":[]}},"versions":[]}']) {
      writeFileSync(file, content);
      expect(() => new AutoRoutingRules(dir)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });
});

function observation(n: number, at = NOW, model = "gpt-6.1-sol", target: "chat" | "worker" = "worker") {
  const choiceId = n.toString(16).padStart(32, "0");
  const dimensions = { engine: "codex" as const, model, effort: "high" as const };
  const row: AutoHabitRow = { choiceId, target, taskClass: "build", ...dimensions, origin: "chat", at };
  const choice: ChoiceProvenance = { actorId: "owner", actionId: choiceId, target, taskClass: "build", origin: "chat", dimensions, userQuote: "Use this model" };
  const context: ChoiceContext = { authenticatedUserId: "owner", currentActionId: choiceId, authorized: true, target, taskClass: "build", directUserText: "Use this model for the build", intent: "choice", attributed: dimensions };
  return { row, choice, context };
}

describe("verified local habits", () => {
  it("requires three unconstrained choices on two days and expires on the rolling boundary", () => {
    const dir = directory();
    const habits = new AutoRoutingHabits(dir);
    for (const n of [1, 2]) { const o = observation(n, NOW - DAY); expect(habits.observe(o.row, o.choice, o.context, NOW, true)).toBe(true); }
    expect(habits.preference("worker", "build", NOW)).toBeUndefined();
    const third = observation(3);
    habits.observe(third.row, third.choice, third.context, NOW, true);
    expect(habits.preference("worker", "build", NOW)).toEqual(preference);
    expect(new AutoRoutingHabits(dir).preference("worker", "build", NOW)).toEqual(preference);
    expect(habits.preference("chat", "build", NOW)).toBeUndefined();
    expect(habits.preference("worker", "build", NOW + 29 * DAY)).toBeUndefined();
    expect(habits.preference("worker", "build", NOW - 2 * DAY)).toBeUndefined();
  });

  it("one contrary pick clears a habit and later evidence starts a new count", () => {
    const habits = new AutoRoutingHabits(directory());
    for (const n of [1, 2, 3]) { const o = observation(n, NOW - (n === 1 ? DAY : 0)); habits.observe(o.row, o.choice, o.context, NOW, true); }
    expect(habits.preference("worker", "build", NOW)).toEqual(preference);
    const contrary = observation(4, NOW + 1, "gpt-6.1-terra");
    habits.observe(contrary.row, contrary.choice, contrary.context, NOW + 1, true);
    expect(habits.preference("worker", "build", NOW + 1)).toBeUndefined();
    for (const n of [5, 6]) { const o = observation(n, NOW + DAY); habits.observe(o.row, o.choice, o.context, NOW + DAY, true); }
    expect(habits.preference("worker", "build", NOW + DAY)).toBeUndefined();
    const third = observation(7, NOW + 2 * DAY);
    habits.observe(third.row, third.choice, third.context, NOW + 2 * DAY, true);
    expect(habits.preference("worker", "build", NOW + 2 * DAY)).toEqual(preference);
  });

  it("deduplicates choices and excludes every unsupported attribution", () => {
    const habits = new AutoRoutingHabits(directory());
    const o = observation(1);
    expect(habits.observe(o.row, o.choice, o.context, NOW, true)).toBe(true);
    expect(habits.observe(o.row, o.choice, o.context, NOW, true)).toBe(false);
    for (const origin of ["bot", "quoted", "fallback", "sync", "import", "peer", "native-cli"] as const) {
      const next = observation(2);
      expect(habits.observe(next.row, { ...next.choice, origin }, next.context, NOW, true)).toBe(false);
    }
    const next = observation(3);
    expect(habits.observe(next.row, next.choice, next.context, NOW, false)).toBe(false);
    expect(habits.observe(next.row, next.choice, { ...next.context, intent: "hint" }, NOW, true)).toBe(false);
    expect(habits.observe({ ...next.row, choiceId: "a".repeat(32) }, next.choice, next.context, NOW, true)).toBe(false);
    expect(habits.observe({ ...next.row, at: NOW + 1 }, next.choice, next.context, NOW, true)).toBe(false);
    expect(habits.rows()).toHaveLength(1);
  });

  it("keeps a capped allowlist without paths, names or account identifiers", () => {
    const writes = vi.fn();
    const habits = new AutoRoutingHabits(directory(), writes);
    for (let n = 1; n <= 505; n++) { const o = observation(n); habits.observe(o.row, o.choice, o.context, NOW, true); }
    expect(habits.rows()).toHaveLength(500);
    expect(habits.rows()[0].choiceId).toBe(observation(6).row.choiceId);
    expect(JSON.stringify(habits.rows())).not.toMatch(/[\\/@]|acct_/);
    const o = observation(506);
    for (const extra of [{ name: "name" }, { prompt: "text" }, { account: "raw" }, { userQuote: "text" }, { model: "custom" }]) expect(() => habits.observe({ ...o.row, ...extra }, o.choice, o.context, NOW, true)).toThrow();
    expect(habits.rows()).toHaveLength(500);
  });

  it("forget is separate from reset and failed writes do not mutate habits", () => {
    const dir = directory();
    let fail = false;
    const habits = new AutoRoutingHabits(dir, (...args) => { if (fail) throw new Error("disk failure"); writeFileAtomic(...args); });
    const o = observation(1);
    habits.observe(o.row, o.choice, o.context, NOW, true);
    const rules = new AutoRoutingRules(dir);
    const reset: AutoRuleOperation = { op: "reset" };
    rules.apply(reset, authorization(reset), habits);
    expect(habits.rows()).toHaveLength(1);
    fail = true;
    const forget: AutoRuleOperation = { op: "forgetHabits" };
    expect(() => rules.apply(forget, authorization(forget), habits)).toThrow("disk failure");
    expect(habits.rows()).toHaveLength(1);
    fail = false;
    rules.apply(forget, authorization(forget), habits);
    expect(new AutoRoutingHabits(dir).rows()).toEqual([]);
  });
});

it("keeps local rules and habits outside portable profile changes and bot export", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const body = source.split("function portableSyncChanges(bot: BotRecord, folder: string): Record<string, unknown> {")[1].split("\n}\n")[0];
  const portableSyncChanges = new Function("bot", "folder", "syncAvatarAssetForBot", "syncSectionId", body);
  const bot = { name: "Fixture", modelSelection: { model: "gpt-6.1-sol", instanceId: "codex", mode: "pinned" } };
  const project = (value: typeof bot) => JSON.parse(JSON.stringify(portableSyncChanges(value, "fixture", () => null, () => null)));
  const baseline = project(bot);
  const dir = directory();
  const state = new AutoRoutingState(dir);
  state.set("bot", { enabled: true, budget: EMPTY_AUTO_BUDGET, current: { engine: "codex", model: "gpt-6-astra", effort: "high", account: "local-account", generation: 1 } });
  const rules = new AutoRoutingRules(dir);
  rules.apply(set, authorization(set));
  const habits = new AutoRoutingHabits(dir);
  const o = observation(1);
  habits.observe(o.row, o.choice, o.context, NOW, true);
  const localBot = { ...bot, autoRoutingRules: rules.current(), autoRoutingHabits: habits.rows(), autoRoute: state.get("bot") };
  expect(project(localBot)).toEqual(baseline);
  const operation = createSyncOperation({ operationId: "op-1", deviceId: "pc-a", sequence: 1, recordedAt: NOW, entity: "bot", entityId: "bot", changes: baseline });
  const imported = applySyncOperations(emptyProfileSyncState(), [operation]);
  expect(JSON.stringify(imported)).not.toMatch(/autoRoute|autoRouting|local-account|gpt-6-astra/);
  expect(new AutoRoutingState(directory()).get("bot")).toBeUndefined();
  const pkg = parseBotPackage(JSON.parse(JSON.stringify({ format: "openmaus.package", version: 1, package: { id: "fixture", release: "1.0.0", name: "Fixture", tagline: "Fixture", summary: "Fixture", category: "Test", author: { name: "Fixture" }, license: "MIT", outcomes: ["Fixture"], setupMinutes: 1,
    requirements: { apps: [], capabilities: [] }, agents: [{ key: "fixture", name: "Fixture", appearance: { color: "blue" }, autoRoute: state.get("bot"), autoRoutingRules: rules.current(), autoRoutingHabits: habits.rows() }], playbooks: [] } })));
  expect(JSON.stringify(packageAgentAsMember(pkg.package.agents[0]))).not.toMatch(/autoRoute|autoRouting|local-account/);
});
