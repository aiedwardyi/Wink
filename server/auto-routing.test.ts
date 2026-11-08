import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { autoBreak, autoSwitchCost, AutoRoutingState, chatLimitMove, EMPTY_AUTO_BUDGET, reserveAutoMove, type AutoBoundary } from "./auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const HOUR = 60 * 60_000;
let serial = 0;
function directory() { const dir = join(DATA_DIR, `auto-state-${++serial}`); mkdirSync(dir, { recursive: true }); return dir; }
const idle: AutoBoundary = { firstSend: false, idleMs: HOUR, compacted: false, busy: false, toolCall: false, backgroundJob: false, unfinishedReply: false, queued: false, steerOrJoin: false, pendingApproval: false };

describe("safe chat boundaries", () => {
  it("allows only first send, idle sixty minutes and already-needed compaction", () => {
    expect(autoBreak({ ...idle, idleMs: HOUR - 1 })).toBeNull();
    expect(autoBreak(idle)).toBe("idle");
    expect(autoBreak({ ...idle, firstSend: true, idleMs: 0 })).toBe("first");
    expect(autoBreak({ ...idle, compacted: true, idleMs: 0 })).toBe("compaction");
    expect(autoBreak({ ...idle, idleMs: NaN })).toBeNull();
  });
  it.each(["busy", "toolCall", "backgroundJob", "unfinishedReply", "queued", "steerOrJoin", "pendingApproval"])("defers all boundaries during %s", (key) => expect(autoBreak({ ...idle, firstSend: true, compacted: true, [key]: true })).toBeNull());
});

describe("durable switch budgets", () => {
  it("allows one discretionary move per rolling day and two total per six hours", () => {
    const first = reserveAutoMove(EMPTY_AUTO_BUDGET, { now: NOW, sendId: "first", reason: "discretionary", firstSelection: true });
    expect(first.state.moves).toHaveLength(0);
    const optional = reserveAutoMove(first.state, { now: NOW + 1, sendId: "optional", reason: "discretionary" });
    expect(optional.allowed).toBe(true);
    expect(reserveAutoMove(optional.state, { now: NOW + 2, sendId: "optional-2", reason: "discretionary" })).toMatchObject({ allowed: false, reason: "daily-budget" });
    const accountOnly = reserveAutoMove(optional.state, { now: NOW + 2, sendId: "account-only", reason: "limit" });
    expect(accountOnly.allowed).toBe(true);
    expect(reserveAutoMove(accountOnly.state, { now: NOW + 3, sendId: "third", reason: "limit" })).toMatchObject({ allowed: false, reason: "six-hour-budget" });
    expect(reserveAutoMove(accountOnly.state, { now: NOW + 6 * HOUR + 1, sendId: "later", reason: "limit" }).allowed).toBe(true);
    expect(reserveAutoMove(accountOnly.state, { now: NOW + 24 * HOUR + 1, sendId: "tomorrow", reason: "discretionary" }).allowed).toBe(true);
  });

  it("counts failed reservations and rejects duplicate sends and clock rollback across restart", () => {
    const dir = directory();
    const store = new AutoRoutingState(dir);
    const reserved = reserveAutoMove(EMPTY_AUTO_BUDGET, { now: NOW, sendId: "send", reason: "limit" });
    store.set("bot", { enabled: true, budget: reserved.state });
    const reopened = new AutoRoutingState(dir).get("bot")!;
    expect(reserveAutoMove(reopened.budget, { now: NOW, sendId: "send", reason: "limit" })).toMatchObject({ allowed: false, reason: "duplicate-send" });
    expect(reserveAutoMove(reopened.budget, { now: NOW - HOUR, sendId: "rollback", reason: "limit" })).toMatchObject({ allowed: false, reason: "clock-rollback" });
    expect(reserveAutoMove(reopened.budget, { now: NOW + 30 * HOUR, sendId: "send", reason: "limit" }).allowed).toBe(false);
    const second = reserveAutoMove(reopened.budget, { now: NOW + 1, sendId: "failed-attempt", reason: "limit" });
    expect(reserveAutoMove(second.state, { now: NOW + 2, sendId: "retry", reason: "limit" }).allowed).toBe(false);
    expect(() => store.set("bot", { enabled: true, budget: EMPTY_AUTO_BUDGET })).toThrow("cannot be reset");
  });
});

describe("actual freshness and switch cost", () => {
  const base = { instanceId: "same", model: "new", lastInstanceId: "same", lastModel: "old", sessionModelSwitch: "in-session" as const, resumeCursors: { same: "cursor" }, transcript: [], hasPriorUserTurn: true };
  const estimates = { futureSavings: 21, warmReread: 10, coldReplay: 30, comparableQuality: true };
  it("uses engineIsFresh for supported warm, unsupported, account and engine moves", () => {
    expect(autoSwitchCost(base, estimates)).toEqual({ fresh: false, costOnlyMove: true });
    expect(autoSwitchCost({ ...base, sessionModelSwitch: "unsupported" }, estimates)).toEqual({ fresh: true, costOnlyMove: false });
    expect(autoSwitchCost({ ...base, instanceId: "another-account" }, estimates)).toEqual({ fresh: true, costOnlyMove: false });
    expect(autoSwitchCost({ ...base, instanceId: "another-engine" }, estimates).fresh).toBe(true);
    expect(autoSwitchCost({ ...base, resumeCursor: false }, estimates).fresh).toBe(true);
  });
  it("requires comparable quality and more than twice known replay cost", () => {
    for (const patch of [{ futureSavings: null }, { warmReread: null }, { futureSavings: NaN }, { warmReread: -1 }, { futureSavings: 20 }, { comparableQuality: false }]) expect(autoSwitchCost(base, { ...estimates, ...patch }).costOnlyMove).toBe(false);
  });
});

describe("approved chat quota boundaries", () => {
  it("warns below ten and only permits the approved next-send exceptions", () => {
    expect(chatLimitMove([{ usedPercent: 90, resetsAt: null }], NOW)).toEqual({ warn: false, nextSend: false });
    expect(chatLimitMove([{ usedPercent: 91, resetsAt: NOW + HOUR }], NOW)).toEqual({ warn: true, nextSend: false });
    expect(chatLimitMove([{ usedPercent: 97, resetsAt: NOW + HOUR / 2 }], NOW).nextSend).toBe(false);
    expect(chatLimitMove([{ usedPercent: 97, resetsAt: NOW + HOUR / 2 + 1 }], NOW).nextSend).toBe(true);
    expect(chatLimitMove([{ usedPercent: 97, resetsAt: null }], NOW).nextSend).toBe(false);
    expect(chatLimitMove([{ usedPercent: 100, resetsAt: null }], NOW).nextSend).toBe(true);
    expect(chatLimitMove([{ usedPercent: 100, resetsAt: NOW - 1 }], NOW).nextSend).toBe(false);
    expect(chatLimitMove([{ usedPercent: 99, resetsAt: NOW + HOUR / 4 }, { usedPercent: 100, resetsAt: NOW + HOUR }], NOW).nextSend).toBe(true);
  });
});

it("stores routes locally without altering portable selection, and fails closed on storage errors", () => {
  const dir = directory();
  let fail = false;
  const store = new AutoRoutingState(dir, (...args) => { if (fail) throw new Error("disk failure"); writeFileAtomic(...args); });
  expect(store.get("existing")).toBeUndefined();
  const portable = { name: "Fixture", model: "gpt-6.1-sol", instanceId: "codex", modelMode: "pinned" };
  const before = structuredClone(portable);
  const route = { engine: "codex" as const, model: "gpt-6-astra", effort: "high" as const, account: "local-account", generation: 1 };
  store.set("bot", { enabled: true, current: route, acceptedRequestId: "request", budget: EMPTY_AUTO_BUDGET });
  expect(portable).toEqual(before);
  expect(new AutoRoutingState(dir).get("bot")).toEqual(store.get("bot"));
  expect(new AutoRoutingState(directory()).get("bot")).toBeUndefined();
  fail = true;
  expect(() => store.set("bot", { enabled: false, budget: EMPTY_AUTO_BUDGET })).toThrow("disk failure");
  expect(store.get("bot")!.enabled).toBe(true);
  const file = store.file;
  writeFileSync(file, "{broken");
  expect(() => new AutoRoutingState(dir)).toThrow();
  expect(readFileSync(file, "utf8")).toBe("{broken");
});
