import { applicableCompaction, buildCompaction, nativeCycleMoved, planCompaction, planSummaryGrace, repairTarget, type CompactionNeeded, type NativePromptSize } from "./context-compaction.ts";
import type { ProviderInstance } from "./contracts.ts";
import type { Message, Store } from "./store.ts";
import { abortable, logSummaryCall, type SummaryCallContext } from "./summary-repair.ts";
import type { NativePrompt } from "./turn-context.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

const MAX_BUILD_RUNS = 2;
const BUILD_RETRY_MS = 10 * 60_000;
const BUILD_CALL_TIMEOUT_MS = 240_000;
const BUILD_RUN_TIMEOUT_MS = 8 * 60_000;
// Good summaries take 23-81 s, so a shorter call only delays the fallback the repair replaces later.
const INLINE_FLOOR_MS = 60_000;
// The engine's own compaction runs slower beside a build call, and a native engine never reads the row back.
const NATIVE_QUIET_MS = 2_000;
// Back-to-back turns are never quiet, so a build parked this long runs at the next settle.
const NATIVE_MAX_WAIT_MS = 30_000;
const prefixKey = (messages: Message[]) => JSON.stringify(messages.map((message) => message.kind === "screen" ? { ...message, png: undefined } : message));

type BuildInstance = Pick<ProviderInstance, "driverKind" | "generateText" | "textModel" | "textTimeoutMs">;

/** What the next send would hand prepareModelContext for this path. */
export interface SendInputs {
  instance: BuildInstance;
  contextWindow: number;
  taskRecordText: string;
  excludeIds?: ReadonlySet<string>;
  reserveTokens?: number;
  nativeAt?: number | null;
  /** the live session a job's captured prompt must still belong to */
  cursor?: unknown;
}

export interface SummaryBuildDeps {
  store: Pick<Store, "activePath" | "activeLeaf" | "messagesFor" | "appendCompaction" | "taskByThread">;
  sendInputs(botId: string, threadId: string, messages: Message[]): Promise<SendInputs | null | undefined>;
  busy(botId: string, threadId: string): boolean;
  userName(): string;
}

export interface SummaryWait {
  threadId: string;
  sendId?: string;
  mode: "skipped" | "waited";
  waitedMs: number;
  reason?: string;
}

export interface SummaryBuild {
  /** Call when a 1:1 turn settles; a path under budget returns without a provider call. */
  onSettled(botId: string, threadId: string): void;
  inflight(threadId: string): boolean;
  /** This native cycle has its summary; a real prompt that moved starts a new cycle. */
  nativeCycleBuilt(threadId: string, nativePrompt: NativePromptSize | undefined, nativeAt: number | null | undefined): boolean;
  markNativeBuilt(threadId: string, last: number): void;
  /** Waits within the inline deadline, or preserves the build for a safe grace turn. */
  settle(
    threadId: string,
    instance: Pick<ProviderInstance, "generateText" | "textTimeoutMs">,
    capMs: number,
    summarizes: () => boolean,
    options?: { sendId?: string; grace?: Parameters<typeof planSummaryGrace>[0]; onWait?: (wait: SummaryWait) => void },
  ): Promise<number>;
  /** Resolves once no build is running; a parked one stays queued. */
  idle(): Promise<void>;
  dispose(): void;
}

interface Built {
  botId: string;
  threadId: string;
  leafId: string;
  leafIndex: number;
  previousId: string | null;
  previousValue: string;
  prefix: string;
  coveredIndex: number;
  compaction: ContextCompactionV1;
  nativeLast?: number;
}

/** What a build sends, read when its turn settled: a wait changes when the call runs, never the summary. */
interface Ready {
  instance: BuildInstance;
  taskRecordText: string;
  plan: CompactionNeeded;
  nativeLast?: number;
}

interface BuildJob {
  botId: string;
  threadId: string;
  messages: Message[];
  leafId: string | null;
  /** read with `messages`: a queued job can outlast the engine's compaction, and a later size would cancel it */
  settledPrompt: NativePrompt | undefined;
  /** a native build waiting for a chat with no turn; `rests` voids the quiet timers a later settle replaced */
  ready?: Ready;
  parked?: boolean;
  parkedAt?: number;
  rests?: number;
}

interface ActiveRun {
  threadId: string;
  done: Promise<void>;
  controller: AbortController;
}

/** The deadline the send's summary call gets after waiting on a build. */
export function inlineDeadlineMs(instance: Pick<ProviderInstance, "textTimeoutMs">, waitedMs: number): number | null {
  if (instance.textTimeoutMs === undefined) return null;
  return waitedMs > 0 ? instance.textTimeoutMs - waitedMs : instance.textTimeoutMs;
}

/** The send's inline summarizer after waiting on a build: the wait comes out of the engine's deadline, and too little left means the deterministic fallback with no call. */
export function inlineSummarizer(
  instance: Pick<ProviderInstance, "generateText" | "textTimeoutMs">,
  waitedMs: number,
): ((prompt: string) => Promise<string>) | undefined {
  if (!instance.generateText) return undefined;
  if (waitedMs <= 0) return (prompt) => instance.generateText!(prompt);
  const remaining = inlineDeadlineMs(instance, waitedMs) ?? 0;
  if (remaining < INLINE_FLOOR_MS) return undefined;
  return (prompt) => instance.generateText!(prompt, { timeoutMs: remaining });
}

/** Builds the next send's summary after a turn settles, one at a time app-wide, in memory only. */
export function createSummaryBuild(deps: SummaryBuildDeps): SummaryBuild {
  const budgets = new Map<string, { runs: number; nextAt: number }>();
  const held = new Map<string, Built>();
  const queue: BuildJob[] = [];
  const graceThreads = new Set<string>();
  const nativeBuiltAt = new Map<string, number>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let active: ActiveRun | null = null;
  let disposed = false;

  const nativeCycleBuilt: SummaryBuild["nativeCycleBuilt"] = (threadId, nativePrompt, nativeAt) => {
    const builtAt = nativeBuiltAt.get(threadId);
    if (nativePrompt && nativeAt && builtAt !== undefined && nativeCycleMoved({ last: nativePrompt.last, builtAt, nativeAt })) nativeBuiltAt.delete(threadId);
    return nativeBuiltAt.has(threadId);
  };

  const eligible = (leafId: string | null) => {
    if (!leafId) return false;
    const budget = budgets.get(leafId);
    return !budget || (budget.runs < MAX_BUILD_RUNS && Date.now() >= budget.nextAt);
  };

  const drop = (built: Built, reason: string) => {
    console.info(`[summary-build] dropped ${JSON.stringify({ botId: built.botId, threadId: built.threadId, reason })}`);
  };

  // Waiting and grace sends append past the captured leaf without changing its prefix.
  const place = (built: Built, unmoved: boolean): boolean => {
    const path = deps.store.activePath(built.threadId);
    const leafHolds = unmoved && !graceThreads.has(built.threadId) ? deps.store.activeLeaf(built.threadId) === built.leafId : path[built.leafIndex]?.id === built.leafId;
    graceThreads.delete(built.threadId);
    if (!leafHolds) {
      drop(built, "leaf-moved");
      return false;
    }
    const previous = applicableCompaction(path);
    if ((previous?.messageId ?? null) !== built.previousId || JSON.stringify(previous && !("unsupported" in previous) ? previous.value : null) !== built.previousValue) {
      drop(built, "compaction-changed");
      return false;
    }
    if (prefixKey(path.slice(0, built.coveredIndex + 1)) !== built.prefix) {
      drop(built, "prefix-changed");
      return false;
    }
    deps.store.appendCompaction(built.threadId, built.compaction);
    if (built.nativeLast !== undefined) nativeBuiltAt.set(built.threadId, built.nativeLast);
    return true;
  };

  const land = (built: Built): boolean => {
    // The engine compacts at the start of its next turn, so a held row would land after that.
    if (built.nativeLast !== undefined) return place(built, false);
    if (deps.busy(built.botId, built.threadId)) {
      held.set(built.threadId, built);
      return true;
    }
    held.delete(built.threadId);
    return place(built, true);
  };

  const later = (ms: number, then: () => void) => {
    const timer = setTimeout(() => {
      retries.delete(timer);
      then();
    }, ms);
    timer.unref?.();
    retries.add(timer);
  };

  const retryLater = (botId: string, threadId: string) => later(BUILD_RETRY_MS, () => onSettled(botId, threadId));

  const unpark = (job: BuildJob) => {
    job.rests = (job.rests ?? 0) + 1;
    job.parked = false;
    pump();
  };

  /** Runs a parked build once its chat has stayed quiet; a turn that starts first keeps it parked. */
  const rest = (job: BuildJob) => {
    const rests = job.rests = (job.rests ?? 0) + 1;
    later(NATIVE_QUIET_MS, () => {
      if (job.rests === rests) unpark(job);
    });
  };

  const park = (job: BuildJob) => {
    job.parked = true;
    job.parkedAt ??= Date.now();
    queue.push(job);
    // busy is bot-wide and only this chat's own turn settles it, so a parked build keeps looking
    rest(job);
  };

  const prepare = async ({ botId, threadId, messages, leafId, settledPrompt }: BuildJob, controller: AbortController): Promise<Ready | null> => {
    if (deps.busy(botId, threadId) && !graceThreads.has(threadId)) return null;
    // a build would chain from the fallback and void its repair
    if (!leafId || !eligible(leafId) || repairTarget(messages)) return null;
    const inputs = await deps.sendInputs(botId, threadId, messages);
    if (disposed || controller.signal.aborted || !inputs?.instance.generateText) return null;
    const nativePrompt = inputs.nativeAt && settledPrompt?.cursor === inputs.cursor ? settledPrompt : undefined;
    const plan = planCompaction({
      messages,
      contextWindow: inputs.contextWindow,
      excludeIds: inputs.excludeIds,
      reserveTokens: inputs.reserveTokens,
      nativeAt: inputs.nativeAt,
      nativePrompt,
      nativeCycleBuilt: nativeCycleBuilt(threadId, nativePrompt, inputs.nativeAt),
      userName: deps.userName(),
      referenceMessages: deps.store.messagesFor(threadId),
    });
    return plan.needed ? { instance: inputs.instance, taskRecordText: inputs.taskRecordText, plan, nativeLast: nativePrompt?.last } : null;
  };

  const run = async (job: BuildJob, controller: AbortController) => {
    const { botId, threadId, messages, leafId } = job;
    const ready = job.ready ?? await prepare(job, controller);
    if (!ready || !leafId) return;
    // every settle looks idle, so only the quiet wait tells a paused chat from one whose next send is on its way
    if (ready.nativeLast !== undefined && (!job.ready || deps.busy(botId, threadId))) return park(Object.assign(job, { ready }));
    const { instance, plan } = ready;
    // the chat or its bot was deleted while this build waited
    if (job.ready && !deps.store.taskByThread(botId, threadId)) return;
    // a send that summarized for itself while this build waited: the row would be dropped after a wasted call
    if (job.ready && (applicableCompaction(deps.store.activePath(threadId))?.messageId ?? null) !== (plan.previous?.messageId ?? null)) {
      graceThreads.delete(threadId);
      return;
    }
    const coveredIndex = messages.findIndex((message) => message.id === plan.coveredThrough.id);
    const prefix = prefixKey(messages.slice(0, coveredIndex + 1));
    const previousValue = JSON.stringify(plan.previous?.value ?? null);
    const runNumber = (budgets.get(leafId)?.runs ?? 0) + 1;
    budgets.set(leafId, { runs: runNumber, nextAt: Number.POSITIVE_INFINITY });
    const timer = setTimeout(() => controller.abort(), BUILD_RUN_TIMEOUT_MS);
    const context: SummaryCallContext = {
      botId,
      threadId,
      phase: "build",
      engine: instance.driverKind,
      model: instance.textModel ?? null,
      run: runNumber,
      deadlineMs: instance.textTimeoutMs === undefined ? null : BUILD_CALL_TIMEOUT_MS,
    };
    const result = await buildCompaction({
      plan,
      messages,
      taskRecordText: ready.taskRecordText,
      signal: controller.signal,
      summarize: (prompt) =>
        abortable(instance.generateText!(prompt, { timeoutMs: BUILD_CALL_TIMEOUT_MS, signal: controller.signal }), controller.signal),
      onSummaryCall: (record) => logSummaryCall(context, record),
    }).finally(() => clearTimeout(timer));
    if (disposed) return;
    if (result.status === "ready") {
      land({ botId, threadId, leafId, leafIndex: messages.length - 1, previousId: plan.previous?.messageId ?? null, previousValue, prefix, coveredIndex, compaction: result.compaction, nativeLast: ready.nativeLast });
      return;
    }
    graceThreads.delete(threadId);
    if (runNumber >= MAX_BUILD_RUNS) return;
    budgets.set(leafId, { runs: runNumber, nextAt: Date.now() + BUILD_RETRY_MS });
    retryLater(botId, threadId);
  };

  const pump = () => {
    if (active || disposed) return;
    const at = queue.findIndex((job) => !job.parked);
    if (at < 0) return;
    const next = queue.splice(at, 1)[0]!;
    const current: ActiveRun = { threadId: next.threadId, done: Promise.resolve(), controller: new AbortController() };
    active = current;
    current.done = run(next, current.controller)
      .catch((error) => {
        console.warn(`[summary-build] run failed (${error instanceof Error ? error.name : "error"})`);
      })
      .finally(() => {
        active = null;
        pump();
      });
  };

  const onSettled = (botId: string, threadId: string) => {
    if (disposed) return;
    const pending = held.get(threadId);
    if (pending && land(pending)) return;
    const parked = queue.find((item) => item.threadId === threadId && item.parked);
    if (parked) {
      const last = deps.store.taskByThread(botId, threadId)?.nativePrompt?.last ?? Number.POSITIVE_INFINITY;
      // a smaller prompt means the engine has compacted, so the build stops waiting for quiet
      if (last < (parked.ready?.nativeLast ?? 0) || Date.now() - (parked.parkedAt ?? 0) >= NATIVE_MAX_WAIT_MS) unpark(parked);
      else rest(parked);
      return;
    }
    if (active?.threadId === threadId || queue.some((item) => item.threadId === threadId)) return;
    if (deps.busy(botId, threadId)) return;
    if (!eligible(deps.store.activeLeaf(threadId))) return;
    queue.push({ botId, threadId, messages: structuredClone(deps.store.activePath(threadId)), leafId: deps.store.activeLeaf(threadId), settledPrompt: deps.store.taskByThread(botId, threadId)?.nativePrompt });
    pump();
  };

  return {
    onSettled,
    inflight: (threadId) => active?.threadId === threadId || queue.some((item) => item.threadId === threadId),
    nativeCycleBuilt,
    markNativeBuilt: (threadId, last) => { nativeBuiltAt.set(threadId, last); },
    async settle(threadId, instance, capMs, summarizes, options) {
      const queued = queue.findIndex((item) => item.threadId === threadId);
      const current = active?.threadId === threadId ? active : null;
      if (!current && queued < 0 && !held.has(threadId)) return 0;
      const logWait = (wait: SummaryWait) => {
        if (options?.onWait) options.onWait(wait);
        else console.info(`[summary-wait] ${JSON.stringify(wait)}`);
      };
      const grace = options?.grace ? planSummaryGrace(options.grace) : null;
      // The engine compacts its own session, so the build lands under this turn instead.
      if (grace?.safe && (options?.grace?.grace.nativeAt || current || queued >= 0)) {
        graceThreads.add(threadId);
        logWait({ threadId, sendId: options?.sendId, mode: "skipped", waitedMs: 0 });
        return 0;
      }
      const started = Date.now();
      const reason = grace && !grace.safe ? grace.reason : "ordinary-compaction";
      if (queued >= 0) queue.splice(queued, 1);
      graceThreads.delete(threadId);
      if (!instance.generateText || instance.textTimeoutMs === undefined || !summarizes()) {
        current?.controller.abort();
        held.delete(threadId);
        logWait({ threadId, sendId: options?.sendId, mode: "waited", waitedMs: 0, reason });
        return 0;
      }
      let waited = 0;
      if (current) {
        const cap = setTimeout(() => current.controller.abort(), capMs);
        await current.done.finally(() => clearTimeout(cap));
        waited = Date.now() - started;
      }
      const built = held.get(threadId);
      if (built) {
        held.delete(threadId);
        place(built, false);
      }
      logWait({ threadId, sendId: options?.sendId, mode: "waited", waitedMs: waited, reason });
      return waited;
    },
    async idle() {
      while (active) await active.done;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      held.clear();
      graceThreads.clear();
      nativeBuiltAt.clear();
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      active?.controller.abort();
    },
  };
}
