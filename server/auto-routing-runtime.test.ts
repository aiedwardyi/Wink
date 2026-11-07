import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SHIPPED_AUTO_RULES, type AutoEngine } from "../shared/auto-routing.ts";
import { writeFileAtomic } from "./atomic.ts";
import { AutoRoutingEvents } from "./auto-routing-events.ts";
import { AutoRoutingRuntime, type AutoWorkerCandidate, type AutoWorkerRow, type AutoWorkerTurn } from "./auto-routing-runtime.ts";
import { DATA_DIR } from "./config.ts";
import type { AttributionSource } from "./auto-routing-attrib.ts";

let serial = 0;
const now = Date.now();
const task = { kind: "build" as const, risk: "low" as const, scope: "bounded" as const, source: "declared" as const };
type FixtureState = { turn: AutoWorkerTurn; candidates: AutoWorkerCandidate[]; enabled: boolean; valid: boolean; at: number; source?: AttributionSource };
function directory() { const dir = join(DATA_DIR, `auto-workers-${++serial}`); mkdirSync(dir, { recursive: true }); return dir; }
function candidate(account = "codex", patch: Partial<AutoWorkerCandidate> = {}): AutoWorkerCandidate {
  return { engine: "codex", account, generation: 0, currentGeneration: 0, authorized: true, signedIn: true,
    lifecycle: "ready", subscription: true, models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"],
    effortLevels: ["low", "medium", "high", "xhigh"], tools: ["files"], contextTokens: 100000,
    usage: { observedAt: new Date(now).toISOString(), windows: [{ id: "five_hour", usedPercent: 20, resetsAt: null }] },
    externalActive: 0, loadKnown: true, headroom: 80, main: true, ...patch };
}
function fixture(write = writeFileAtomic) {
  const dir = directory();
  const turn: AutoWorkerTurn = { id: "action" };
  const state: FixtureState = { turn, candidates: [candidate()], enabled: true, valid: true, at: now };
  const events = { decision: vi.fn(() => true), outcome: vi.fn(() => true) };
  const deps = { enabled: () => state.enabled, turn: () => state.turn, rules: () => ({ id: 0, content: structuredClone(SHIPPED_AUTO_RULES) }),
    candidates: () => state.candidates, valid: () => state.valid, refresh: vi.fn(async () => {}), events, now: () => state.at,
    source: () => state.source! };
  const runtime = new AutoRoutingRuntime(dir, deps, write);
  const request = () => ({ requestId: randomUUID(), botId: "bot", task });
  return { dir, state, events, deps, runtime, request };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function running(f: ReturnType<typeof fixture>) {
  const result = await f.runtime.prepare(f.request(), async () => "argv");
  if (result.kind !== "ready") throw new Error("Expected prepared route");
  f.runtime.claim(result.row.routeId);
  f.runtime.accepted(result.row.routeId, randomUUID());
  return result.row;
}

describe("Auto worker reservations", () => {
  it("reserves before asynchronous preparation and scores pending workers", async () => {
    const f = fixture();
    f.state.candidates.push(candidate("other", { main: false }));
    const gate = deferred();
    const first = f.runtime.prepare(f.request(), async () => { await gate.promise; return "first"; });
    expect(f.runtime.candidates().map((row) => row.pending)).toEqual([1, 0]);
    const second = await f.runtime.prepare(f.request(), async () => "second");
    expect(second.kind === "ready" && second.row.route.account).toBe("other");
    gate.resolve();
    expect((await first).kind).toBe("ready");
  });

  it("never prepares a duplicate request, including after reload", async () => {
    const f = fixture();
    const request = f.request();
    const prepare = vi.fn(async () => "argv");
    const result = await f.runtime.prepare(request, prepare);
    expect((await f.runtime.prepare(request, prepare)).kind).toBe("existing");
    expect((await new AutoRoutingRuntime(f.dir, f.deps).prepare(request, prepare)).kind).toBe("existing");
    expect((await f.runtime.prepare({ ...request, botId: "other" }, prepare))).toEqual({ kind: "hold", reason: "request-owner-mismatch" });
    expect(result.kind).toBe("ready");
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("allows at most one native acceptance claim", async () => {
    const f = fixture();
    const result = await f.runtime.prepare(f.request(), async () => "argv");
    if (result.kind !== "ready") throw new Error("Expected ready");
    const claimed = f.runtime.claim(result.row.routeId);
    expect(claimed.nativeId).toBe(result.row.nativeId);
    expect(() => f.runtime.claim(result.row.routeId)).toThrow("unavailable");
    f.runtime.accepted(result.row.routeId, "pane");
    f.runtime.accepted(result.row.routeId, "pane");
    expect(() => f.runtime.accepted(result.row.routeId, "another-pane")).toThrow("unavailable");
    expect(f.runtime.candidates()[0]).toMatchObject({ active: 1, pending: 0 });
  });

  it("retains uncertain acceptance and running counts across restart", async () => {
    const f = fixture();
    const result = await f.runtime.prepare(f.request(), async () => "argv");
    if (result.kind !== "ready") throw new Error("Expected ready");
    f.runtime.claim(result.row.routeId);
    const restored = new AutoRoutingRuntime(f.dir, f.deps);
    expect(restored.rows()[0]).toMatchObject({ stage: "unknown", nativeId: result.row.nativeId });
    expect(restored.candidates()[0]).toMatchObject({ active: 1, loadKnown: false });
    expect(() => restored.claim(result.row.routeId)).toThrow("unavailable");
    await running(f);
    expect(new AutoRoutingRuntime(f.dir, f.deps).candidates()[0].active).toBe(2);
  });

  it("re-resolves once before acceptance and preserves native identity", async () => {
    const f = fixture();
    f.state.candidates.push(candidate("other", { main: false }));
    let preparations = 0;
    const nativeIds: string[] = [];
    const prepare = vi.fn(async (row: AutoWorkerRow) => {
      nativeIds.push(row.nativeId);
      if (++preparations === 1) f.state.candidates[0].signedIn = false;
      return "argv";
    });
    const result = await f.runtime.prepare(f.request(), prepare);
    expect(result.kind === "ready" && result.row).toMatchObject({ attempts: 2, route: { account: "other" } });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(new Set(nativeIds).size).toBe(1);
    expect(f.runtime.candidates().map((row) => row.pending)).toEqual([0, 1]);
  });

  it("recovers uncertain acceptance only by its exact native identity", async () => {
    const f = fixture();
    const result = await f.runtime.prepare(f.request(), async () => "argv");
    if (result.kind !== "ready") throw new Error("Expected ready");
    f.runtime.claim(result.row.routeId);
    f.runtime.uncertain(result.row.routeId);
    expect(() => f.runtime.recovered(result.row.routeId, randomUUID(), "pane")).toThrow("identity");
    f.runtime.recovered(result.row.routeId, result.row.nativeId, "pane");
    expect(f.runtime.rows()[0]).toMatchObject({ stage: "running", paneId: "pane", nativeId: result.row.nativeId });
  });

  it("releases a definite native rejection without retrying", async () => {
    const f = fixture();
    const request = f.request();
    const result = await f.runtime.prepare(request, async () => "argv");
    if (result.kind !== "ready") throw new Error("Expected ready");
    f.runtime.claim(result.row.routeId);
    f.runtime.rejected(result.row.routeId);
    f.runtime.rejected(result.row.routeId);
    expect(f.runtime.candidates()[0].active).toBe(0);
    const prepare = vi.fn(async () => "argv");
    expect((await f.runtime.prepare(request, prepare)).kind).toBe("existing");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not retry after the second invalidation", async () => {
    const f = fixture();
    const prepare = vi.fn(async () => { f.state.valid = false; return "argv"; });
    expect(await f.runtime.prepare(f.request(), prepare)).toEqual({ kind: "hold", reason: "route-invalidated" });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.runtime.candidates()[0].pending).toBe(0);
  });

  it("drops pending routes on identity invalidation while leaving running routes intact", async () => {
    const f = fixture();
    const live = await running(f);
    const gate = deferred();
    const preparing = f.runtime.prepare(f.request(), async () => { await gate.promise; return "argv"; });
    f.runtime.invalidate("codex");
    gate.resolve();
    expect(await preparing).toEqual({ kind: "hold", reason: "route-invalidated" });
    expect(f.runtime.rows().find((row) => row.routeId === live.routeId)?.stage).toBe("running");
    expect(f.runtime.candidates()[0]).toMatchObject({ active: 1, pending: 0 });
  });

  it.each(["turn", "generation", "enabled"] as const)("refuses a late %s change", async (change) => {
    const f = fixture();
    const result = await f.runtime.prepare(f.request(), async () => "argv");
    if (result.kind !== "ready") throw new Error("Expected ready");
    if (change === "turn") f.state.turn = { id: "action" };
    if (change === "generation") f.state.candidates[0].currentGeneration++;
    if (change === "enabled") f.state.enabled = false;
    expect(() => f.runtime.claim(result.row.routeId)).toThrow("unavailable");
    expect(f.runtime.candidates()[0].pending).toBe(0);
  });

  it("does not interpret a stalled note as completion and releases each final outcome once", async () => {
    const f = fixture();
    const row = await running(f);
    f.runtime.outcome(row.routeId, "stalled");
    expect(f.runtime.candidates()[0].active).toBe(1);
    f.runtime.outcome(row.routeId, "report", "done");
    f.runtime.outcome(row.routeId, "closed");
    expect(f.runtime.candidates()[0].active).toBe(0);
    expect(f.events.outcome).toHaveBeenCalledTimes(2);
  });

  it("fails before preparation when reservation cannot be saved", async () => {
    let fail = false;
    const f = fixture((...args) => { if (fail) throw new Error("disk failure"); writeFileAtomic(...args); });
    fail = true;
    const prepare = vi.fn(async () => "argv");
    await expect(f.runtime.prepare(f.request(), prepare)).rejects.toThrow("disk failure");
    expect(prepare).not.toHaveBeenCalled();
    expect(f.runtime.rows()).toEqual([]);
  });

  it("releases a failed preparation and never retries its request id", async () => {
    const f = fixture();
    const request = f.request();
    await expect(f.runtime.prepare(request, async () => { throw new Error("preparation failed"); })).rejects.toThrow("preparation failed");
    expect(f.runtime.candidates()[0].pending).toBe(0);
    const prepare = vi.fn(async () => "argv");
    expect((await f.runtime.prepare(request, prepare)).kind).toBe("existing");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps a failed acceptance save uncertain after restart", async () => {
    let fail = false;
    const f = fixture((...args) => { if (fail) throw new Error("disk failure"); writeFileAtomic(...args); });
    const request = f.request();
    const result = await f.runtime.prepare(request, async () => "argv");
    if (result.kind !== "ready") throw new Error("Expected ready");
    f.runtime.claim(result.row.routeId);
    fail = true;
    expect(() => f.runtime.accepted(result.row.routeId, "pane")).toThrow("disk failure");
    fail = false;
    const restored = new AutoRoutingRuntime(f.dir, f.deps);
    expect(restored.rows()[0].stage).toBe("unknown");
    const prepare = vi.fn(async () => "argv");
    expect((await restored.prepare(request, prepare)).kind).toBe("existing");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("refuses corrupt state instead of treating requests as new", () => {
    const f = fixture();
    writeFileSync(join(f.dir, "auto-routing-workers.json"), "{broken");
    expect(() => new AutoRoutingRuntime(f.dir, f.deps)).toThrow();
  });

  it("refuses missing worker state instead of accepting a second spawn", async () => {
    const f = fixture();
    await running(f);
    unlinkSync(join(f.dir, "auto-routing-workers.json"));
    expect(() => new AutoRoutingRuntime(f.dir, f.deps)).toThrow("state is missing");
  });

  it.each<[AutoEngine, string]>([
    ["claudeAgent", "claude-sonnet-5-5"], ["codex", "gpt-6.1-sol"], ["grokAgent", "grok-4.7"],
    ["antigravityAgent", "gemini-3.8-flash-high"], ["museAgent", "muse-spark-1.3-contributor"],
  ])("prepares a base %s instance with zero managed accounts", async (engine, model) => {
    const f = fixture();
    f.state.candidates = [candidate(engine, { engine, models: [model] })];
    const result = await f.runtime.prepare(f.request(), async () => "argv");
    expect(result.kind === "ready" && result.row.route).toMatchObject({ engine, model, generation: 0 });
  });

  it.each(["signedIn", "authorized", "subscription"] as const)("does not relax %s for missing telemetry", async (field) => {
    const f = fixture();
    f.state.candidates[0] = candidate("codex", { usage: undefined, [field]: false });
    const prepare = vi.fn(async () => "argv");
    expect((await f.runtime.prepare(f.request(), prepare)).kind).toBe("hold");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not turn a repeated quota hold into an override", async () => {
    const f = fixture();
    f.state.candidates[0].usage!.windows = [{ id: "five_hour", usedPercent: 90, resetsAt: null }];
    const prepare = vi.fn(async () => "argv");
    for (let i = 0; i < 3; i++) expect((await f.runtime.prepare(f.request(), prepare)).kind).toBe("hold");
    expect(prepare).not.toHaveBeenCalled();
    expect(f.runtime.rows()).toEqual([]);
  });

  it("checks pins against controller attribution and preserves unspecified dimensions", async () => {
    const f = fixture();
    const request = { ...f.request(), pin: { model: "gpt-6.1-sol", userQuote: "Sol" } };
    expect(await f.runtime.prepare(request, async () => "argv")).toEqual({ kind: "hold", reason: "unverified-pin" });
    f.state.source = { botId: "bot", threadId: "thread", ownerId: "owner", authorized: true,
      turn: { botId: "bot", threadId: "thread", turnId: "action", owner: "user", depth: 0, rootId: null, userKeys: ["typed"], nowWatch: [] },
      messages: [{ id: "typed", role: "user", kind: "text", text: "Use Sol", at: now }] };
    expect((await f.runtime.prepare({ ...request, pin: { ...request.pin, userQuote: "Opus" } }, async () => "argv")).kind).toBe("hold");
    const result = await f.runtime.prepare(request, async () => "argv");
    expect(result.kind === "ready" && result.row.route).toMatchObject({ engine: "codex", model: "gpt-6.1-sol", effort: "high" });
  });

  it("uses the task's kept pick when a later spawn supplies no pin", async () => {
    const f = fixture();
    const runtime = new AutoRoutingRuntime(f.dir, { ...f.deps, kept: () => ({ engine: "codex", model: "gpt-6.1-terra" }) });
    const result = await runtime.prepare(f.request(), async () => "argv");
    expect(result.kind === "ready" && result.row.route).toMatchObject({ engine: "codex", model: "gpt-6.1-terra", effort: "high" });
  });

  it("bypasses young-cache LIMIT, persists exhaustion and coalesces refresh", async () => {
    const f = fixture();
    const first = await running(f);
    const second = await running(f);
    const gate = deferred();
    f.deps.refresh.mockImplementation(() => gate.promise);
    f.runtime.outcome(first.routeId, "limit", "blocked");
    f.runtime.outcome(second.routeId, "limit", "blocked");
    await Promise.resolve();
    expect(f.deps.refresh).toHaveBeenCalledTimes(1);
    const prepare = vi.fn(async () => "argv");
    expect((await new AutoRoutingRuntime(f.dir, f.deps).prepare(f.request(), prepare)).kind).toBe("hold");
    expect(prepare).not.toHaveBeenCalled();
    f.state.at++;
    f.state.candidates[0].usage!.observedAt = new Date(f.state.at).toISOString();
    expect((await f.runtime.prepare(f.request(), prepare)).kind).toBe("ready");
    gate.resolve();
  });

  it("marks missing event coverage without retrying preparation", async () => {
    const f = fixture();
    f.events.decision.mockReturnValue(false);
    const request = f.request();
    const prepare = vi.fn(async () => "argv");
    const result = await f.runtime.prepare(request, prepare);
    expect(result.kind === "ready" && result.row.coverageMissing).toBe(true);
    expect((await f.runtime.prepare(request, prepare)).kind).toBe("existing");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("minimal Auto worker events", () => {
  it("joins decisions and outcomes without raw identities or task text", async () => {
    const f = fixture();
    const events = new AutoRoutingEvents(f.dir);
    const runtime = new AutoRoutingRuntime(directory(), { ...f.deps, events });
    const result = await runtime.prepare({ ...f.request(), botId: "private-bot", task: { ...task, text: "private task C:/private/file.md" } }, async () => "argv");
    if (result.kind !== "ready") throw new Error("Expected ready");
    runtime.claim(result.row.routeId);
    runtime.accepted(result.row.routeId, "private-pane");
    runtime.outcome(result.row.routeId, "report", "done");
    const text = readFileSync(join(f.dir, "auto-routing-events.jsonl"), "utf8");
    for (const value of ["private-bot", "private-pane", "private task", "C:/private", '"account":', '"label":']) expect(text).not.toContain(value);
    const rows = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows[0].routeId).toBe(rows[1].routeId);
    expect(rows[0].botRef).toBe(rows[1].botRef);
    expect(rows[1].pane8).toHaveLength(8);
    expect(new AutoRoutingEvents(f.dir).ref("private-bot")).toBe(events.ref("private-bot"));
  });

  it("records missing coverage when appending events fails", () => {
    const events = new AutoRoutingEvents(directory(), () => { throw new Error("disk failure"); });
    expect(events.outcome({ routeId: "a".repeat(32), botId: "bot", at: now }, "closed", null, now)).toBe(false);
    expect(events.coverageMissing).toBe(true);
  });
});
