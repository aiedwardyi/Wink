// Event-loop stalls with their start and length. Stats keep only a bucket; the cold-open record
// names the ones an open sat behind, so a slow open with a fast handler can be told apart.
import { performance } from "node:perf_hooks";

export const LOOP_STALL_MIN_MS = 1_000;
const TICK_MS = 1_000;
const KEEP = 64;
// A gap of minutes is the PC waking from sleep, not a stall.
const SLEEP_MS = 2 * 60_000;

export interface LoopStall {
  /** Wall time the loop stopped answering. */
  start: number;
  ms: number;
}

const stalls: LoopStall[] = [];
const listeners = new Set<(stall: LoopStall) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Idempotent; the tick never keeps the process alive. */
export function watchLoopStalls(): void {
  if (timer) return;
  let tick = performance.now();
  timer = setInterval(() => {
    const late = performance.now() - tick - TICK_MS;
    tick += late + TICK_MS;
    if (late < LOOP_STALL_MIN_MS || late >= SLEEP_MS) return;
    const ms = Math.round(late);
    const stall = { start: Date.now() - ms, ms };
    stalls.push(stall);
    if (stalls.length > KEEP) stalls.shift();
    for (const listener of listeners) listener(stall);
  }, TICK_MS);
  timer.unref();
}

export function onLoopStall(listener: (stall: LoopStall) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A 1 s tick sees a stall up to TICK_MS after it began, so the earliest possible start counts.
export function loopStallsDuring(from: number, to: number): LoopStall[] {
  return stalls.filter((stall) => stall.start - TICK_MS < to && stall.start + stall.ms > from);
}
