// Process-wide pool of speculative engine children (Grok, Muse, Gemini).
// Claude and Codex never use it. Holds no protocol code: drivers spawn and
// hand shake, the pool owns capacity, identity generations and lifetimes.
import os from "node:os";

import { canServeTurn, type WarmSession } from "./acp/warm-eligibility.ts";

export type { WarmSession };
export type WarmKey = { engine: string; instanceId: string; threadId: string };
/** `identity` is an in-memory hash; never log it. */
export type Captured = { generation: number; incarnation: string; identity: string };
export interface WarmChild {
  session: WarmSession;
  alive(): boolean;
  /** Must kill the process tree, not just signal it: closeAll stops waiting after 5 s and a parent exit reaps nothing on Windows. */
  close(reason: string): Promise<void>;
  rssProbe?(): number;
}
export interface Lease {
  key: WarmKey;
  fingerprint: string;
  captured: Captured;
  signal: AbortSignal;
  attach(child: WarmChild): void;
  /** Call before the prompt write: a lease still not ready `pendingMs` after reserve is closed, even if taken. */
  ready(): void;
  /** Idempotent. */
  release(reason: string): void;
}
export type WarmMatch = { engine?: string; instanceId?: string; incarnation?: string };

type Kind = "speculative" | "handshake";
type Entry = {
  lease: Lease;
  kind: Kind;
  state: "pending" | "idle" | "taken" | "closing";
  ready: boolean;
  stale: boolean;
  child?: WarmChild;
  generation: number;
  idleSince: number;
  since: number;
  pendingMs: number;
  /** Prepares sharing a pending lease; each releases once. */
  holders: number;
  cursor?: { value: unknown };
  close(reason: string): void;
};

export interface WarmPoolOptions {
  now?: () => number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  totalmem?: () => number;
  freemem?: () => number;
  cpus?: () => number;
  /** Measured process-tree RSS in bytes; undefined when unmeasured. */
  treeRss?: (child: WarmChild) => number | undefined;
  /** True while any live turn or turn-start claim runs, on any engine. */
  liveTurns?: () => boolean;
}

const GiB = 1024 ** 3;
const TOTAL_CAP = 3;
const ENGINE_CAP = 2;
const IDLE_TTL_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const SLEEP_GAP_MS = 150_000;
const PENDING_TTL_MS = 120_000;
const CLOSE_BOUND_MS = 5_000;

const defaultTimers = {
  setInterval(fn: () => void, ms: number) {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval(handle: unknown) { clearInterval(handle as ReturnType<typeof setInterval>); },
};

const keyOf = (key: WarmKey) => JSON.stringify([key.engine, key.instanceId, key.threadId]);
const sameCaptured = (a: Captured, b: Captured) => a.generation === b.generation && a.incarnation === b.incarnation && a.identity === b.identity;
const matches = (match: WarmMatch, entry: Entry) =>
  (match.engine === undefined || match.engine === entry.lease.key.engine)
  && (match.instanceId === undefined || match.instanceId === entry.lease.key.instanceId)
  && (match.incarnation === undefined || match.incarnation === entry.lease.captured.incarnation);

export class WarmPool {
  private entries = new Set<Entry>();
  private byKey = new Map<string, Entry>();
  private generations = new Map<string, number>();
  private holds = new Set<WarmMatch>();
  private closing = new Set<Promise<void>>();
  private paused = 0;
  private final = false;
  private timer: unknown;
  private lastSweep = 0;
  private readonly now: () => number;
  private readonly timers: NonNullable<WarmPoolOptions["timers"]>;
  private readonly totalmem: () => number;
  private readonly freemem: () => number;
  private readonly cpus: () => number;
  private readonly treeRss: (child: WarmChild) => number | undefined;
  private liveTurns: () => boolean;

  constructor(options: WarmPoolOptions = {}) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.totalmem = options.totalmem ?? os.totalmem;
    this.freemem = options.freemem ?? os.freemem;
    this.cpus = options.cpus ?? (() => os.cpus().length);
    this.treeRss = options.treeRss ?? ((child) => child.rssProbe?.());
    this.liveTurns = options.liveTurns ?? (() => false);
  }

  setLiveTurns(probe: () => boolean) { this.liveTurns = probe; }

  /** The pool's own generation for an instance; Captured uses it when the account has none. */
  generation(key: Pick<WarmKey, "engine" | "instanceId">): number {
    return (this.generations.get("") ?? 0) + (this.generations.get(`e:${key.engine}`) ?? 0) + (this.generations.get(`i:${key.instanceId}`) ?? 0);
  }

  /** A same-key reserve joins a pending lease; every caller that got it releases once. `pendingMs` bounds a prepare that never becomes ready. */
  reserve(key: WarmKey, fingerprint: string, captured: Captured, kind: Kind, opts: { pendingMs?: number } = {}): Lease | "busy" | "denied" {
    if (this.final) return "denied";
    const existing = this.byKey.get(keyOf(key));
    if (existing?.state === "taken") return "busy";
    if (this.held(key)) return "denied";
    if (existing && this.reusable(existing, fingerprint, captured)) {
      if (existing.state === "pending") existing.holders += 1;
      return existing.lease;
    }
    if (existing) this.drop(existing, "replaced");
    const among = [...this.entries].filter((entry) => entry !== existing);
    if (kind === "speculative" && !this.admits(key.engine, among)) return "denied";
    if (kind === "speculative" && this.freemem() < this.floor()) return "denied";
    return this.add(key, fingerprint, captured, kind, opts.pendingMs ?? PENDING_TTL_MS);
  }

  take(key: WarmKey, fingerprint: string, captured: Captured, resumeCursor: unknown): { hit: Lease } | { pending: Lease } | "busy" | "miss" {
    if (this.entries.size && this.now() - this.lastSweep > SLEEP_GAP_MS) {
      this.closeIdle("sleep");
      this.lastSweep = this.now();
    }
    const entry = this.byKey.get(keyOf(key));
    if (!entry) return "miss";
    if (entry.state === "taken") return "busy";
    const child = entry.child;
    if (!this.reusable(entry, fingerprint, captured) || this.held(key) || (entry.ready && !child) || (child && !canServeTurn(child.session, resumeCursor))) {
      this.drop(entry, "stale");
      return "miss";
    }
    entry.state = "taken";
    entry.cursor = { value: resumeCursor };
    return entry.ready ? { hit: entry.lease } : { pending: entry.lease };
  }

  /** Returns a taken lease to idle after its turn; a refusal releases it; a repeat offer of an idle lease is a no-op.
   * The driver marks its turn ended before offer; `session` is the child's session after the turn. */
  offer(lease: Lease, session?: WarmSession): boolean {
    const entry = this.entryOf(lease);
    if (!entry) return false;
    if (entry.state === "idle") return true;
    const others = [...this.entries].filter((other) => other !== entry);
    const ok = entry.state === "taken" && entry.ready && !entry.stale && !this.final
      && entry.child?.alive() === true && entry.generation === this.generation(lease.key) && !this.held(lease.key)
      && (entry.kind === "handshake" || this.admits(lease.key.engine, others));
    if (!ok) {
      this.drop(entry, "refused");
      return false;
    }
    if (session) entry.child!.session = session;
    entry.state = "idle";
    entry.idleSince = this.now();
    entry.holders = 1;
    entry.cursor = undefined;
    return true;
  }

  barrier(match: { engine?: string; instanceId?: string }, reason: string): () => void {
    const scope = match.instanceId !== undefined ? `i:${match.instanceId}` : match.engine !== undefined ? `e:${match.engine}` : "";
    this.generations.set(scope, (this.generations.get(scope) ?? 0) + 1);
    const hold = { ...match };
    this.holds.add(hold);
    this.invalidate(match, reason);
    return () => { this.holds.delete(hold); };
  }

  invalidate(match: WarmMatch, reason: string): void {
    for (const entry of [...this.entries]) {
      if (entry.state === "closing" || !matches(match, entry)) continue;
      if (entry.state === "taken" && entry.ready) entry.stale = true;
      else this.drop(entry, reason);
    }
  }

  yieldToWorker(reason: string): () => void {
    this.paused += 1;
    for (const entry of [...this.entries]) {
      if (entry.kind === "speculative" && entry.state !== "closing" && !(entry.state === "taken" && entry.ready)) this.drop(entry, reason);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.paused -= 1;
    };
  }

  /** Waits for tracked closes at most `boundMs` (5 s), so a hung child cannot keep the host alive. */
  async closeAll(reason: string, opts: { final?: boolean; boundMs?: number } = {}): Promise<void> {
    if (opts.final) this.final = true;
    this.invalidate({}, reason);
    if (opts.final) this.stopSweep();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((done) => {
      timer = setTimeout(() => done(true), opts.boundMs ?? CLOSE_BOUND_MS);
      timer.unref?.();
    });
    while (this.closing.size) {
      if (await Promise.race([Promise.allSettled([...this.closing]).then(() => false), expired])) break;
    }
    clearTimeout(timer);
  }

  stats() {
    const byEngine: Record<string, number> = {};
    let pending = 0, idle = 0, closing = 0, rss = 0, measured = false;
    for (const entry of this.entries) {
      if (entry.state === "taken") continue;
      byEngine[entry.lease.key.engine] = (byEngine[entry.lease.key.engine] ?? 0) + 1;
      if (entry.state === "pending") pending += 1;
      else if (entry.state === "idle") idle += 1;
      else closing += 1;
      const size = entry.child && entry.state !== "closing" ? this.treeRss(entry.child) : undefined;
      if (size !== undefined) { rss += size; measured = true; }
    }
    return { reserved: pending + idle + closing, pending, idle, closing, byEngine, ...(measured ? { rssMiB: Math.round(rss / 1024 ** 2) } : {}) };
  }

  private add(key: WarmKey, fingerprint: string, captured: Captured, kind: Kind, pendingMs: number): Lease {
    const controller = new AbortController();
    let entry!: Entry;
    const close = (reason: string) => {
      if (entry.state === "closing") return;
      entry.state = "closing";
      controller.abort(reason);
      if (this.byKey.get(keyOf(key)) === entry) this.byKey.delete(keyOf(key));
      const child = entry.child;
      if (!child) {
        this.entries.delete(entry);
        this.idleCheck();
        return;
      }
      this.closeChild(entry, child, reason);
    };
    const lease: Lease = {
      key: { ...key },
      fingerprint,
      captured: { ...captured },
      signal: controller.signal,
      attach: (child) => {
        if (entry.state === "closing" || (entry.child && entry.child !== child)) {
          this.closeChild({ ...entry, state: "closing", child }, child, "released");
          return;
        }
        entry.child = child;
        this.recheck(entry);
      },
      ready: () => {
        if (entry.state === "closing" || entry.ready) return;
        entry.ready = true;
        if (entry.state === "pending") {
          entry.state = "idle";
          entry.idleSince = this.now();
        }
        this.recheck(entry);
      },
      release: (reason) => {
        if (entry.state === "pending" && entry.holders > 1) {
          entry.holders -= 1;
          return;
        }
        close(reason);
      },
    };
    entry = { lease, kind, state: "pending", ready: false, stale: false, generation: this.generation(key), idleSince: 0, since: this.now(), pendingMs, holders: 1, close };
    this.entries.add(entry);
    this.byKey.set(keyOf(key), entry);
    this.startSweep();
    return lease;
  }

  /** Counts the child until it exits, including one attached after its lease was released. */
  private closeChild(entry: Entry, child: WarmChild, reason: string) {
    this.entries.add(entry);
    this.track(child.close(reason).finally(() => {
      this.entries.delete(entry);
      this.idleCheck();
    }));
  }

  /** A pending lease adopted by a turn serves only that turn's cursor. */
  private recheck(entry: Entry) {
    if (entry.state === "taken" && entry.cursor && entry.child && !canServeTurn(entry.child.session, entry.cursor.value)) entry.close("session mismatch");
  }

  private track(closed: Promise<void>) {
    const settled = closed.catch(() => {}).finally(() => this.closing.delete(settled));
    this.closing.add(settled);
  }

  private entryOf(lease: Lease): Entry | undefined {
    const entry = this.byKey.get(keyOf(lease.key));
    return entry?.lease === lease ? entry : undefined;
  }

  private reusable(entry: Entry, fingerprint: string, captured: Captured) {
    return entry.state !== "closing" && !entry.stale && entry.lease.fingerprint === fingerprint
      && sameCaptured(entry.lease.captured, captured) && entry.generation === this.generation(entry.lease.key)
      && (!entry.child || entry.child.alive());
  }

  private held(key: WarmKey) {
    for (const hold of this.holds) {
      if ((hold.engine === undefined || hold.engine === key.engine) && (hold.instanceId === undefined || hold.instanceId === key.instanceId)) return true;
    }
    return false;
  }

  private smaller() { return this.totalmem() < 8 * GiB || this.cpus() <= 4; }
  private floor() { return Math.max(1.5 * GiB, 0.15 * this.totalmem()); }

  private admits(engine: string, among = [...this.entries]) {
    if (this.paused || this.final) return false;
    const held = among.filter((entry) => entry.state !== "taken");
    if (this.smaller()) return held.length < 1 && !this.liveTurns() && !among.some((entry) => entry.state === "taken");
    return held.length < TOTAL_CAP && held.filter((entry) => entry.lease.key.engine === engine).length < ENGINE_CAP;
  }

  private drop(entry: Entry, reason: string) { entry.close(reason); }

  private closeIdle(reason: string) {
    for (const entry of [...this.entries]) if (entry.state === "idle") this.drop(entry, reason);
  }

  private startSweep() {
    if (this.timer !== undefined || this.final) return;
    this.lastSweep = this.now();
    this.timer = this.timers.setInterval(() => this.sweep(), SWEEP_MS);
  }

  private stopSweep() {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }

  private idleCheck() { if (!this.entries.size) this.stopSweep(); }

  private sweep() {
    const now = this.now();
    if (now - this.lastSweep > SLEEP_GAP_MS) this.closeIdle("sleep");
    this.lastSweep = now;
    for (const entry of [...this.entries]) {
      if (entry.state === "idle" && (now - entry.idleSince >= IDLE_TTL_MS || entry.child?.alive() === false)) this.drop(entry, "idle");
      else if ((entry.state === "pending" || (entry.state === "taken" && !entry.ready)) && now - entry.since >= entry.pendingMs) this.drop(entry, "pending timeout");
    }
    if (this.smaller() && (this.liveTurns() || [...this.entries].some((entry) => entry.state === "taken"))) {
      for (const entry of [...this.entries]) if (entry.kind === "speculative" && (entry.state === "idle" || entry.state === "pending")) this.drop(entry, "busy");
    }
    let short = this.floor() - this.freemem();
    if (short <= 0) return;
    const idle = [...this.entries]
      .filter((entry) => entry.state === "idle" && entry.child)
      .map((entry) => ({ entry, rss: this.treeRss(entry.child!) ?? 0 }))
      .sort((a, b) => b.rss - a.rss);
    for (const { entry, rss } of idle) {
      if (short <= 0) break;
      this.drop(entry, "memory");
      short -= rss;
    }
  }
}

export const createWarmPool = (options?: WarmPoolOptions) => new WarmPool(options);
export const warmPool = createWarmPool();
