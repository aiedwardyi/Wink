import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { experimentalAgents, slimStaticText } from "./drivers/tool-catalog.ts";
import { collectTurnTraces } from "../scripts/turn-trace-collector.mjs";
import { currentTurnTrace, holdTurnTrace, observeTraceEvent, recordToolSchemas, startTurnTimer, startTurnTrace, traceClaimedTurn, traceHelperCall, tracePart, traceRuntimeEvent } from "./turn-timing.ts";

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

describe("hosted trace across a late send", () => {
  const dir = join(tmpdir(), `orbit-turn-timing-late-${process.pid}`);
  const file = join(dir, "turn-traces.jsonl");
  const prevTiming = process.env.ORBIT_TURN_TIMING;
  const prevData = process.env.OMB_DATA_DIR;
  const rows = () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const event = (type: string, turnId: string, extra: object = {}) => ({ type, threadId: "thread", turnId, ...extra }) as never;
  const claim = async (turnId: string, send: ((trace: NonNullable<ReturnType<typeof currentTurnTrace>>) => Promise<void>) | null, release = true) => {
    let detached: Promise<void> = Promise.resolve();
    await traceClaimedTurn({ botId: "bot", threadId: "thread", sendId: turnId }, async () => {
      const trace = currentTurnTrace()!;
      if (!send) return "early";
      const done = release ? holdTurnTrace(trace) : undefined;
      detached = (async () => { await new Promise((resolve) => setImmediate(resolve)); await send(trace); })().catch(() => {}).finally(() => done?.());
      return "started";
    });
    await detached;
  };

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
    if (existsSync(file)) unlinkSync(file);
  });

  it("writes provider stages to the one row of a send that starts after the claim returns", async () => {
    await claim("t1", async (trace) => {
      trace.assembled("system", "input");
      trace.identify({ threadId: "thread", turnId: "t1", engine: "codex" });
      trace.span("memory_read", "topics")();
      trace.span("retirement_wait")();
      trace.span("spawn", "cold", 0)();
      trace.rpc("initialize", 1, 0)("reply");
      trace.rpc("thread/start", 2, 0)("reply");
      trace.rpc("turn/start", 3, 0)("reply");
      traceRuntimeEvent(event("content.delta", "t1", { streamKind: "assistant_text", delta: "hi" }), () => {});
      trace.mark("native_completion");
      trace.request("r1", { input: 3, output: 1 });
      traceRuntimeEvent(event("turn.completed", "t1", { ok: true, usage: { input: 3, output: 1 } }), () => {});
      observeTraceEvent(event("turn.completed", "t1", { ok: true, usage: { input: 3, output: 1 } }));
    });
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row.reason).toBe("completed");
    expect(Object.keys(row.marks)).toEqual(expect.arrayContaining(["first_event", "first_visible_text", "native_completion", "driver_completion"]));
    for (const phase of ["spawn", "initialize", "start", "dispatch", "first_event"]) {
      expect(row.spans.find((span: { phase: string }) => span.phase === phase)).toMatchObject({ start: expect.any(Number), end: expect.any(Number) });
    }
    const [summary] = collectTurnTraces(rows());
    expect(summary).toMatchObject({ incomplete: false, unknownPhases: [] });
  });

  it.each([
    ["an early return", null, true, "no-provider-turn"],
    ["a joined turn with no send", async () => {}, true, "no-provider-turn"],
    ["a dropped detached task", async () => {}, true, "no-provider-turn"],
    ["a failed send", async (trace: { identify: (patch: object) => void; finish: (reason: string) => void }) => {
      trace.identify({ threadId: "thread", turnId: "t2" });
      trace.finish("send-failed");
      throw new Error("send failed");
    }, true, "send-failed"],
  ] as const)("closes the trace once for %s", async (_name, send, release, reason) => {
    await claim("t2", send as never, release);
    expect(rows().map((row) => row.reason)).toEqual([reason]);
  });

  it("ends prompt_build when a held send fails before the prompt is assembled", async () => {
    await claim("t3", async (trace) => { trace.finish("send-failed"); });
    expect(rows()[0].spans.find((span: { phase: string }) => span.phase === "prompt_build")).toMatchObject({ end: expect.any(Number) });
  });

  it("does not grow the live map over 1,000 turns of every path", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `turn-${i}`);
    for (const [i, turnId] of ids.entries()) {
      await claim(turnId, [null, async () => {}, async (trace: { identify: (patch: object) => void; finish: (reason: string) => void }) => { trace.identify({ threadId: "thread", turnId }); trace.finish("send-failed"); }][i % 3] as never);
    }
    expect(rows()).toHaveLength(1000);
    // a leaked entry would hand back its finished trace, whose finish writes nothing
    for (const turnId of ids) startTurnTrace({ threadId: "thread", turnId })!.finish();
    expect(rows()).toHaveLength(2000);
  });
});

describe("flags off", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const section = (from: string, to: string) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    if (start < 0 || end < start) throw new Error(`Missing section: ${from}`);
    return source.slice(start, end);
  };
  const names = ["ORBIT_TURN_TIMING", "ORBIT_WINK_TOOL_CATALOG", "ORBIT_WINK_STATIC_SLIM"];
  const saved = names.map((name) => process.env[name]);

  beforeEach(() => { for (const name of names) delete process.env[name]; });
  afterEach(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));

  const stub = (name: string): unknown => new Proxy(() => name, {
    get: (_t, key) => key === Symbol.toPrimitive ? () => name : key === "map" ? () => [] : key === "length" ? 0 : stub(`${name}.${String(key)}`),
    apply: () => name,
  });
  const scope = {
    tracePart, slimStaticText, privateWorkspace: true, canMessage: true, tagged: [], opts: {}, cfg: {},
    integrations: {}, instance: { driverKind: "claudeAgent" }, SHOW_IMAGE_GUIDANCE: "show. To create a new image, call generate_image.",
  } as Record<string | symbol, unknown>;
  const build = (body: string) => {
    const run = new Function(`${ts.transpileModule(`function run(scope) { with (scope) { ${body} } }`, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
    }).outputText}\nreturn run;`)() as (scope: object) => string;
    return run(new Proxy(scope, {
      has: (target, key) => key in target || (typeof key === "string" && !(key in globalThis)),
      get: (target, key) => key === Symbol.unscopables ? undefined : key in target ? target[key] : stub(String(key)),
    }));
  };

  it("builds the real system prompt as the untraced source does", () => {
    const head = "        const system =\n";
    const system = section(head, "\n        // a rewound, Orbit-compacted").slice(head.length);
    const image = section("      const showImagePrompt =", "\n");
    const untraced = (code: string) => code.replace(/tracePart\("\w+", (.*)\) \+$/gm, "($1) +").replace(/slimStaticText\((\w+), [\w.]+\)/, "$1");
    expect(untraced(system)).not.toContain("tracePart");
    const wrapped = build(`${image}\nconst system = ${system};\nreturn system;`);
    expect(wrapped).toBe(build(`${untraced(image)}\nconst system = ${untraced(system)};\nreturn system;`));
    expect(wrapped).toContain("call generate_image.");
  });

  it("leaves the turn flow, mount and static text alone", async () => {
    const mount = { command: "node", args: ["a"], env: { A: "1" } };
    expect(await traceClaimedTurn({ botId: "b" }, async () => currentTurnTrace())).toBeUndefined();
    expect(experimentalAgents(mount)).toBe(mount);
    expect(slimStaticText("x To create a new image, call generate_image.", "codex")).toBe("x To create a new image, call generate_image.");
  });
});
