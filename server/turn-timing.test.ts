import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentTurnTrace, recordToolSchemas, startTurnTimer, startTurnTrace, traceClaimedTurn, traceHelperCall } from "./turn-timing.ts";

describe("turn-timing", () => {
  const dir = join(tmpdir(), `orbit-turn-timing-${process.pid}`);
  const prevTiming = process.env.ORBIT_TURN_TIMING;
  const prevData = process.env.OMB_DATA_DIR;

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    process.env.OMB_DATA_DIR = dir;
    process.env.ORBIT_TURN_TIMING = "1";
  });

  afterEach(() => {
    if (prevTiming === undefined) delete process.env.ORBIT_TURN_TIMING;
    else process.env.ORBIT_TURN_TIMING = prevTiming;
    if (prevData === undefined) delete process.env.OMB_DATA_DIR;
    else process.env.OMB_DATA_DIR = prevData;
    for (const name of ["turn-timing.jsonl", "turn-traces.jsonl"]) {
      const path = join(dir, name);
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("is a no-op when ORBIT_TURN_TIMING is off", () => {
    process.env.ORBIT_TURN_TIMING = "0";
    const t = startTurnTimer({ engine: "grok" });
    t.mark("dispatch");
    t.finish();
    expect(existsSync(join(dir, "turn-timing.jsonl"))).toBe(false);
  });

  it("appends one JSON line with ms marks when enabled", () => {
    const t = startTurnTimer({ engine: "grok", model: "grok-4", effort: "low", botId: "b1" });
    t.mark("dispatch");
    t.mark("spawnOrReuse");
    t.mark("cliReady");
    t.mark("firstVisible");
    t.mark("turnDone");
    t.finish({ mcpServerCount: 0, argsLength: 12, systemPromptChars: 100 });
    // DATA_DIR is captured at config import time from OMB_DATA_DIR — may be process default
    // when config loaded earlier. Prefer reading via env data dir OR default ~/.orbit if test isolation failed.
    const candidates = [join(dir, "turn-timing.jsonl"), join(process.env.OMB_DATA_DIR ?? dir, "turn-timing.jsonl")];
    const path = candidates.find((p) => existsSync(p));
    expect(path, "timing file written").toBeTruthy();
    const row = JSON.parse(readFileSync(path!, "utf8").trim());
    expect(row.engine).toBe("grok");
    expect(row.model).toBe("grok-4");
    expect(typeof row.dispatchMs).toBe("number");
    expect(typeof row.firstVisibleMs).toBe("number");
    expect(typeof row.turnDoneMs).toBe("number");
    expect(row.systemPromptChars).toBe(100);
  });

  it("does not evaluate identity, clock or writer with tracing off", () => {
    process.env.ORBIT_TURN_TIMING = "0";
    const identity = vi.fn(() => ({ botId: "private" }));
    const now = vi.fn(() => 0);
    const write = vi.fn();
    expect(startTurnTrace(identity, { now, write })).toBeUndefined();
    expect(identity).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    const schemas = vi.fn(() => []);
    recordToolSchemas(schemas);
    expect(schemas).not.toHaveBeenCalled();
  });

  it("keeps overlapping phases inclusive and flushes once on failure", () => {
    let now = 10;
    const write = vi.fn();
    const trace = startTurnTrace({ sendId: "send", threadId: "thread" }, { now: () => now, write })!;
    const build = trace.span("prompt_build");
    now = 12;
    const read = trace.span("memory_read");
    now = 15;
    read("missing");
    now = 20;
    build();
    trace.finish("cancelled");
    trace.finish();
    const row = write.mock.calls[0]![0];
    expect(write).toHaveBeenCalledTimes(1);
    expect(row.spans).toContainEqual({ phase: "prompt_build", start: 0, end: 10 });
    expect(row.spans).toContainEqual({ phase: "memory_read", start: 2, end: 5, reason: "missing" });
    expect(row.spans).toContainEqual({ phase: "hooks", start: null, end: null, reason: "CLI-owned/unobservable" });
    expect(row.reason).toBe("cancelled");
  });

  it("counts disjoint assembled and delivered parts without retaining contents", () => {
    const write = vi.fn();
    const trace = startTurnTrace({}, { write })!;
    const memory = trace.part("memory", "secret-memory");
    const playbook = trace.part("playbook", "worker");
    trace.input("hello", ["notice"], "task");
    trace.assembled(`system${memory}${playbook}`, "tasknoticehello");
    trace.delivered("start", () => ({ system: `system${memory}${playbook}` }));
    trace.delivered("resume-input", () => ({ current_input: "tasknoticehello" }));
    trace.finish();
    const row = write.mock.calls[0]![0];
    expect(row.assembled.system.chars).toBe(6);
    expect(row.assembled.memory.chars).toBe(13);
    expect(row.assembled.playbook.chars).toBe(6);
    expect(row.assembled.notes.chars).toBe(6);
    expect(row.assembled.current_input.chars).toBe(5);
    expect(row.assembled.history.chars).toBe(4);
    expect(row.deliveries[1].parts.system.chars).toBe(0);
    expect(row.deliveries[1].durableTaskStateChars).toBe(4);
    expect(JSON.stringify(row)).not.toContain("secret-memory");
    expect(row.nativeInstructions).toEqual({ chars: null, coverage: "native-owned" });
  });

  it("deduplicates request identities and keeps nested usage outside foreground sums", () => {
    const write = vi.fn();
    const trace = startTurnTrace({}, { write })!;
    trace.request("request", { input: 30, output: 1, cachedInput: 20, cacheCreation: 5 });
    trace.request("request", { input: 30, output: 2, cachedInput: 20, cacheCreation: 5 });
    trace.request("agent", { input: 10, output: 1 }, true);
    trace.reconcile({ input: 30, output: 2 });
    trace.finish();
    const row = write.mock.calls[0]![0];
    expect(row.requests).toHaveLength(2);
    expect(row.requests[0].usage.output).toBe(2);
    expect(row.requests[1].nested).toBe(true);
    expect(row.reconciliation.result).toEqual({ input: 30, output: 2 });
  });

  it("deduplicates Codex snapshots and excludes restored spend", () => {
    const write = vi.fn();
    const trace = startTurnTrace({}, { write })!;
    trace.codexUsage("old", { total: { inputTokens: 100, outputTokens: 10 } }, false);
    const usage = { total: { inputTokens: 140, outputTokens: 15 }, last: { inputTokens: 40, outputTokens: 5 } };
    trace.codexUsage("new", usage, true);
    trace.codexUsage("new", usage, true);
    trace.finish();
    const row = write.mock.calls[0]![0];
    expect(row.requests).toHaveLength(1);
    expect(row.reconciliation.delta).toEqual({ input: 40, output: 5 });
  });

  it("closes failed and retried RPC spans with their attempt and request IDs", () => {
    const write = vi.fn();
    const trace = startTurnTrace({}, { write })!;
    trace.rpc("thread/resume", 2, 0)("error");
    trace.rpc("thread/start", 3, 0)("reply");
    trace.rpc("initialize", 1, 1)("reply");
    trace.finish();
    expect(write.mock.calls[0]![0].spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "resume", reason: "error", attempt: 0, requestId: 2 }),
      expect.objectContaining({ phase: "start", reason: "reply", attempt: 0, requestId: 3 }),
      expect.objectContaining({ phase: "initialize", attempt: 1, requestId: 1 }),
    ]));
  });

  it("preserves return values and isolates concurrent preparation contexts", async () => {
    const seen: unknown[] = [];
    await Promise.all(["a", "b"].map((botId) => traceClaimedTurn({ botId }, async () => {
      const trace = currentTurnTrace();
      await Promise.resolve();
      expect(currentTurnTrace()).toBe(trace);
      seen.push(trace);
      return botId;
    })));
    expect(seen[0]).not.toBe(seen[1]);
    expect(currentTurnTrace()).toBeUndefined();
  });

  it("never fails the caller when the trace sink fails", () => {
    const trace = startTurnTrace({}, { write: () => { throw new Error("disk full"); } })!;
    expect(() => trace.finish()).not.toThrow();
  });

  it("attributes helper retries to their source without another inference", async () => {
    const work = vi.fn(async (onUsage?: (usage: undefined, id?: string) => void) => {
      onUsage?.(undefined, "attempt-1");
      onUsage?.(undefined, "attempt-2");
      return "unchanged helper text";
    });
    const text = await traceClaimedTurn({ botId: "bot", threadId: "thread", sendId: "send", messageId: "message" }, () => traceHelperCall("claude", undefined, work));
    expect(text).toBe("unchanged helper text");
    expect(work).toHaveBeenCalledTimes(1);
    const rows = readFileSync(join(dir, "turn-traces.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const helper = rows.find((row) => row.batchId);
    expect(helper).toMatchObject({ botId: "bot", threadId: "thread", sourceSendIds: ["send"], sourceMessageIds: ["message"], requests: [{ id: "attempt-1", usage: null, nested: false }, { id: "attempt-2", usage: null, nested: false }] });
    expect(helper.endpoints.runnerReceipt).toBeNull();
  });
});
