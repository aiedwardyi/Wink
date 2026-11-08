// Env-gated turn timing for latency diagnosis.
// ORBIT_TURN_TIMING=1 appends one JSON line per turn to <DATA_DIR>/turn-timing.jsonl.
// Inert when unset/off.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

type Phase = "prompt_build" | "memory_read" | "hooks" | "spawn" | "retirement_wait" | "initialize" | "resume" | "start" | "dispatch" | "first_event" | "completion" | "note_wait" | "background_pass";
type Part = "system" | "memory" | "playbook" | "notes" | "tool_schemas" | "history" | "current_input" | "tool_output";
type Usage = { input: number; output: number; cachedInput?: number; cacheCreation?: number };
type Identity = { botId?: string; threadId?: string; sendId?: string; messageId?: string; turnId?: string; nativeSessionId?: string; nativeTurnId?: string; batchId?: string; sourceMessageIds?: string[]; sourceSendIds?: string[]; engine?: string };
type Span = { phase: Phase; start: number | null; end: number | null; reason?: string; attempt?: number; requestId?: string | number };
type Count = { chars: number | null; coverage: "observed" | "native-owned" | "unknown" };

export type UsageObserver = (usage: Usage | undefined, requestId?: string) => void;
export type TurnTrace = {
  identify(patch: Identity): void;
  span(phase: Phase, reason?: string, attempt?: number): (reason?: string) => void;
  rpc(method: string, id: number, attempt: number): (reason?: string) => void;
  unknown(phase: Phase, reason: string): void;
  mark(name: string): void;
  part(kind: Part, text: string): string;
  input(current: string, notes: string[], taskState?: string, systemUpdate?: string): void;
  assembled(system: string, text: string, history?: string): void;
  delivered(route: string, parts: () => Partial<Record<Part, string>>): void;
  request(id: string | undefined, usage: Usage | undefined, nested?: boolean): void;
  codexUsage(turnId: string | undefined, usage: { total?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }; last?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } }, active: boolean): void;
  reconcile(usage: Usage | undefined): void;
  finish(reason?: string): void;
};

const context = new AsyncLocalStorage<TurnTrace>();
const live = new Map<string, TurnTrace>();
const hosted = new WeakSet<TurnTrace>();
const identities = new WeakMap<TurnTrace, Identity>();
const claims = new WeakMap<TurnTrace, { end: () => void; held: boolean }>();
let sequence = 0;

export function currentTurnTrace(): TurnTrace | undefined {
  return enabled() ? context.getStore() : undefined;
}

export function tracePart(kind: Part, text: string): string {
  return currentTurnTrace()?.part(kind, text) ?? text;
}

export function recordToolSchemas(tools: () => Array<{ name: string }>): void {
  if (!enabled()) return;
  try {
    const surface = tools();
    const row = { version: 2, kind: "tool_schemas", ts: new Date().toISOString(), pid: process.pid, monotonicOrigin: performance.timeOrigin, atMs: performance.now(), botId: process.env.OMB_BOT_ID, threadId: process.env.OMB_THREAD_ID, count: surface.length, chars: JSON.stringify(surface).length, units: "UTF-16", coverage: "MCP-serialized", names: surface.map((tool) => tool.name) };
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(join(dataDir(), "turn-traces.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
  } catch {}
}

export function startTurnTrace(identity: Identity | (() => Identity), options: { now?: () => number; write?: (row: unknown) => void; hosted?: boolean } = {}): TurnTrace | undefined {
  if (!enabled()) return;
  const initial = typeof identity === "function" ? identity() : identity;
  const existing = initial.threadId && initial.turnId ? live.get(`${initial.threadId}:${initial.turnId}`) : undefined;
  if (existing) return existing;
  const now = options.now ?? (() => performance.now());
  const start = now();
  const utc = new Date().toISOString();
  const traceId = `${process.pid}:${++sequence}`;
  const spans: Span[] = [];
  const marks: Record<string, number> = {};
  const systemParts: Array<{ kind: Part; text: string }> = [];
  let inputParts: Array<{ kind: Part; text: string }> | undefined;
  let taskState: string | undefined;
  const deliveries: Array<{ route: string; parts: Record<Part, Count>; durableTaskStateChars: number | null }> = [];
  const requests = new Map<string, { id: string | null; usage: Usage | null; nested: boolean }>();
  const snapshots = new Set<string>();
  let baseline: Usage | undefined;
  let latest: Usage | undefined;
  let assembled: Record<Part, Count> | undefined;
  let result: Usage | undefined;
  let finished = false;
  let info = { ...initial };
  const elapsed = () => now() - start;
  const parts = (values: Partial<Record<Part, string>>): Record<Part, Count> => {
    const result = Object.fromEntries(
      (["system", "memory", "playbook", "notes", "tool_schemas", "history", "current_input", "tool_output"] as Part[])
        .map((kind) => [kind, { chars: null, coverage: "native-owned" }]),
    ) as Record<Part, Count>;
    const add = (kind: Part, chars: number) => { result[kind] = { chars: (result[kind].chars ?? 0) + chars, coverage: "observed" }; };
    for (const [key, text] of Object.entries(values) as Array<[Part, string]>) {
      const split = key === "system" ? systemParts : key === "current_input" ? inputParts : undefined;
      if (!split?.length) { add(key, text.length); continue; }
      const taken: Array<{ start: number; end: number }> = [];
      for (const segment of split) {
        add(segment.kind, 0);
        if (!segment.text) continue;
        const start = text.lastIndexOf(segment.text);
        const end = start + segment.text.length;
        if (start < 0 || taken.some((range) => start < range.end && end > range.start)) continue;
        taken.push({ start, end });
        add(segment.kind, segment.text.length);
      }
      add(key === "current_input" ? "history" : "system", text.length - taken.reduce((sum, range) => sum + range.end - range.start, 0));
    }
    return result;
  };
  const trace: TurnTrace = {
    identify(patch) {
      info = { ...info, ...patch };
      identities.set(trace, info);
      if (!finished && info.threadId && info.turnId) live.set(`${info.threadId}:${info.turnId}`, trace);
    },
    span(phase, reason, attempt) {
      const span: Span = { phase, start: elapsed(), end: null, ...(reason ? { reason } : {}), ...(attempt === undefined ? {} : { attempt }) };
      spans.push(span);
      return (endReason) => {
        if (finished || span.end !== null) return;
        span.end = elapsed();
        if (endReason) span.reason = endReason;
      };
    },
    rpc(method, id, attempt) {
      const phase = ({ initialize: "initialize", "thread/resume": "resume", "thread/start": "start", "turn/start": "dispatch" } as const)[method as "initialize"];
      if (!phase) return () => {};
      const end = trace.span(phase, method, attempt);
      spans[spans.length - 1]!.requestId = id;
      return end;
    },
    unknown(phase, reason) { spans.push({ phase, start: null, end: null, reason }); },
    mark(name) {
      if (finished || marks[name] !== undefined) return;
      marks[name] = elapsed();
      if (name === "first_event" || name === "native_completion") spans.push({ phase: name === "first_event" ? "first_event" : "completion", start: marks[name]!, end: marks[name]! });
    },
    part(kind, text) {
      systemParts.push({ kind, text });
      return text;
    },
    input(current, notes, state, systemUpdate) {
      inputParts = [{ kind: "current_input", text: current }, ...notes.map((text) => ({ kind: "notes" as const, text })), { kind: "system", text: systemUpdate ?? "" }];
      taskState = state;
    },
    assembled(system, text, history) {
      for (const span of spans) if (span.phase === "prompt_build" && span.end === null) span.end = elapsed();
      assembled = parts({ system, current_input: text, ...(history === undefined ? {} : { history }) });
    },
    delivered(route, values) {
      try {
        const value = values();
        deliveries.push({ route, parts: parts(value), durableTaskStateChars: taskState ? Object.values(value).some((text) => text.includes(taskState!)) ? taskState.length : 0 : null });
      } catch {}
    },
    request(id, usage, nested = false) {
      // Missing request identity cannot establish distinct model calls.
      const key = `${nested}:${id ?? "unknown"}`;
      requests.set(key, { id: id ?? null, usage: usage ?? null, nested });
    },
    codexUsage(turnId, usage, active) {
      const convert = (value: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }): Usage => ({ input: value.inputTokens ?? 0, output: value.outputTokens ?? 0, ...(value.cachedInputTokens === undefined ? {} : { cachedInput: value.cachedInputTokens }) });
      if (!active) {
        if (usage.total && !latest) baseline = convert(usage.total);
        return;
      }
      if (!usage.total) {
        trace.request(undefined, usage.last ? convert(usage.last) : undefined);
        return;
      }
      const key = JSON.stringify([turnId, usage.total]);
      if (snapshots.has(key)) return;
      snapshots.add(key);
      if (usage.total) latest = convert(usage.total);
      if (!baseline && latest && usage.last) {
        const last = convert(usage.last);
        baseline = { input: latest.input - last.input, output: latest.output - last.output, ...(latest.cachedInput === undefined ? {} : { cachedInput: latest.cachedInput - (last.cachedInput ?? 0) }) };
      }
      trace.request(`${turnId ?? "unknown"}:${snapshots.size}`, usage.last ? convert(usage.last) : undefined);
    },
    reconcile(usage) { result = usage; },
    finish(reason = "settled") {
      if (finished) return;
      finished = true;
      if (info.threadId && info.turnId) live.delete(`${info.threadId}:${info.turnId}`);
      const required: Phase[] = ["prompt_build", "memory_read", "hooks", "spawn", "retirement_wait", "initialize", "resume", "start", "dispatch", "first_event", "completion", "note_wait"];
      for (const phase of required) if (!spans.some((span) => span.phase === phase)) spans.push({ phase, start: null, end: null, reason: phase === "hooks" ? "CLI-owned/unobservable" : phase === "note_wait" ? "runner-owned/unobservable" : "unobserved" });
      const row = { version: 2, ts: utc, pid: process.pid, monotonicOrigin: performance.timeOrigin, startMs: start, traceId, ...info, reason, units: "UTF-16", spans, marks, endpoints: { nativeTerminal: marks.native_completion ?? null, driverCompletion: marks.driver_completion ?? null, harnessPublished: marks.harness_persisted_published ?? null, runnerReceipt: null, runnerCoverage: "runner-owned/unobservable" }, assembled: assembled ?? null, deliveries, requests: [...requests.values()], reconciliation: { result: result ?? null, baseline: baseline ?? null, latest: latest ?? null, delta: baseline && latest ? { input: latest.input - baseline.input, output: latest.output - baseline.output } : null }, nativeInstructions: { chars: null, coverage: "native-owned" } };
      try {
        if (options.write) options.write(row);
        else {
          mkdirSync(dataDir(), { recursive: true });
          appendFileSync(join(dataDir(), "turn-traces.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
        }
      } catch {}
    },
  };
  if (options.hosted) hosted.add(trace);
  identities.set(trace, info);
  return trace;
}

export async function traceHelperCall<T>(engine: string, observer: UsageObserver | undefined, work: (onUsage?: UsageObserver) => Promise<T>): Promise<T> {
  if (!enabled() || observer) return work(observer);
  const parent = context.getStore();
  const owner = parent ? identities.get(parent) : undefined;
  const trace = startTurnTrace(() => ({ engine, botId: owner?.botId, threadId: owner?.threadId, batchId: `${process.pid}:helper:${++sequence}`, sourceMessageIds: owner?.messageId ? [owner.messageId] : [], sourceSendIds: owner?.sendId ? [owner.sendId] : [] }))!;
  const end = trace.span("background_pass", "helper");
  let request = 0;
  let reason = "helper-failed";
  try {
    const result = await work((usage, id) => { request++; trace.request(id ?? `helper:${request}`, usage); });
    reason = "helper-settled";
    return result;
  } finally {
    if (!request) trace.request("helper:unknown", undefined);
    end();
    trace.finish(reason);
  }
}

function closeUnstarted(trace: TurnTrace): void {
  claims.get(trace)?.end();
  if (![...live.values()].includes(trace)) trace.finish("no-provider-turn");
}

/** Keeps a claimed trace open past the claim for a send that runs later; call the result when that send settles. */
export function holdTurnTrace(trace: TurnTrace | undefined): (() => void) | undefined {
  const claim = trace && claims.get(trace);
  if (!trace || !claim) return;
  claim.held = true;
  return () => closeUnstarted(trace);
}

export async function traceClaimedTurn<T>(identity: Identity | (() => Identity), work: () => Promise<T>): Promise<T> {
  const trace = startTurnTrace(identity, { hosted: true });
  if (!trace) return work();
  const claim = { end: trace.span("prompt_build"), held: false };
  claims.set(trace, claim);
  try { return await context.run(trace, work); }
  catch (error) { claim.end(); trace.finish("preparation-failed"); throw error; }
  finally { if (!claim.held) closeUnstarted(trace); }
}

export function traceRuntimeEvent(event: RuntimeEvent, publish: () => void): void {
  if (!enabled()) return publish();
  const trace = live.get(`${event.threadId}:${event.turnId}`);
  if (trace) {
    if (event.type === "content.delta") {
      trace.mark("first_event");
      if (event.streamKind === "assistant_text" && event.delta) trace.mark("first_visible_text");
    }
    if (event.type === "session.started" && typeof event.sessionId === "string") trace.identify({ nativeSessionId: event.sessionId });
    if (event.type === "turn.completed") {
      trace.mark("driver_completion");
      trace.reconcile(event.usage);
    }
  }
  publish();
  if (trace && !hosted.has(trace) && event.type === "turn.completed") trace.finish(event.ok ? "completed" : "failed");
}

export function observeTraceEvent(event: RuntimeEvent): void {
  if (!enabled()) return;
  const trace = live.get(`${event.threadId}:${event.turnId}`);
  if (!trace) return;
  if (event.type === "session.started" && typeof event.sessionId === "string") trace.identify({ nativeSessionId: event.sessionId });
  if (event.type === "turn.completed") {
    trace.mark("harness_persisted_published");
    trace.reconcile(event.usage);
    trace.finish(event.ok ? "completed" : "failed");
  }
}

export type TurnTimingMarks = {
  engine?: string;
  model?: string;
  effort?: string | number | null;
  botId?: string;
  systemPromptChars?: number;
  mcpServerCount?: number;
  argsLength?: number;
  reusedSession?: boolean;
  /** Create-time spawn+initialize(+auth) borrowed; session/new still runs. */
  reusedHandshake?: boolean;
};

type Ms = number | null;

export type TurnTimer = {
  mark(name: "dispatch" | "cliProbed" | "spawnOrReuse" | "cliReady" | "firstVisible" | "turnDone"): void;
  setMeta(patch: Partial<TurnTimingMarks>): void;
  finish(extra?: Partial<TurnTimingMarks>): void;
};

function enabled(): boolean {
  const v = process.env.ORBIT_TURN_TIMING;
  return v === "1" || v === "true";
}

function dataDir(): string {
  return process.env.OMB_DATA_DIR ?? DATA_DIR;
}

function timingPath(): string {
  return join(dataDir(), "turn-timing.jsonl");
}

/** Start a turn timer. Returns a no-op timer when ORBIT_TURN_TIMING is off. */
export function startTurnTimer(meta: TurnTimingMarks = {}): TurnTimer {
  if (!enabled()) {
    return {
      mark() {},
      setMeta() {},
      finish() {},
    };
  }
  const t0 = performance.now();
  const marks: Record<string, Ms> = {
    dispatchMs: null,
    cliProbedMs: null,
    spawnOrReuseMs: null,
    cliReadyMs: null,
    firstVisibleMs: null,
    turnDoneMs: null,
  };
  let info: TurnTimingMarks = { ...meta };
  let finished = false;

  return {
    mark(name) {
      if (finished) return;
      const key =
        name === "dispatch"
          ? "dispatchMs"
          : name === "cliProbed"
            ? "cliProbedMs"
            : name === "spawnOrReuse"
              ? "spawnOrReuseMs"
              : name === "cliReady"
                ? "cliReadyMs"
                : name === "firstVisible"
                  ? "firstVisibleMs"
                  : "turnDoneMs";
      if (marks[key] == null) marks[key] = Math.round(performance.now() - t0);
    },
    setMeta(patch) {
      info = { ...info, ...patch };
    },
    finish(extra) {
      if (finished) return;
      finished = true;
      if (marks.turnDoneMs == null) marks.turnDoneMs = Math.round(performance.now() - t0);
      if (extra) info = { ...info, ...extra };
      try {
        mkdirSync(dataDir(), { recursive: true });
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          ...info,
          ...marks,
        });
        appendFileSync(timingPath(), `${line}\n`, "utf8");
      } catch {
        // Timing must never break a turn.
      }
    },
  };
}
