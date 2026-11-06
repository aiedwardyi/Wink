import { describe, expect, it, vi } from "vitest";

import { createWarmPool, type Lease, type WarmChild, type WarmPoolOptions, type WarmSession } from "./warm-pool.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const captured = { generation: 0, incarnation: "grok-1", identity: "auth-hash" };
const key = (threadId: string, engine = "grokAgent") => ({ engine, instanceId: engine, threadId });

function fixture(options: Partial<WarmPoolOptions> = {}) {
  let now = 1_000_000;
  let tick: (() => void) | undefined;
  const mem = { total: 32 * GiB, free: 16 * GiB, cpus: 16 };
  const pool = createWarmPool({
    now: () => now,
    timers: { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; } },
    totalmem: () => mem.total,
    freemem: () => mem.free,
    cpus: () => mem.cpus,
    ...options,
  });
  return {
    pool,
    mem,
    skip(ms: number) { now += ms; },
    pass(ms: number) {
      for (let spent = 0; spent < ms; spent += 60_000) {
        now += 60_000;
        tick?.();
      }
    },
    reserve(threadId: string, engine?: string, kind: "speculative" | "handshake" = "speculative") {
      return pool.reserve(key(threadId, engine), "fp", captured, kind);
    },
  };
}

function child(session: WarmSession = { kind: "fresh" }, rss?: number) {
  let alive = true;
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  let held = false;
  const handle = {
    session,
    alive: () => alive,
    close: vi.fn(async (_reason: string) => {
      alive = false;
      if (held) await exited;
    }),
    ...(rss === undefined ? {} : { rssProbe: () => rss }),
    holdExit() { held = true; },
    exit,
  };
  return handle satisfies WarmChild;
}

function ready(lease: Lease | "busy" | "denied", made = child()) {
  if (typeof lease === "string") throw new Error(`expected a lease, got ${lease}`);
  lease.attach(made);
  lease.ready();
  return { lease, child: made };
}

const asLease = (lease: Lease | "busy" | "denied") => {
  if (typeof lease === "string") throw new Error(`expected a lease, got ${lease}`);
  return lease;
};

describe("warm pool", () => {
  it("a matching guess joins a kept session without marking it", () => {
    const { pool, reserve } = fixture();
    const kept = ready(reserve("t1"));
    expect(pool.reserve(key("t1"), "fp", captured, "speculative", { focus: true })).toBe(kept.lease);
    expect(pool.reserve(key("t1"), "other", captured, "speculative", { focus: true })).toBe("busy");
    expect(kept.child.close).not.toHaveBeenCalled();
  });

  it("an offer drops guesses rather than being refused", () => {
    const { pool, reserve } = fixture();
    const kept = ready(reserve("kept"));
    pool.take(key("kept"), "fp", captured, undefined);
    const guesses = ["t1", "t2"].map((id) => ready(pool.reserve(key(id), "fp", captured, "speculative", { focus: true })));
    expect(pool.offer(kept.lease)).toBe(true);
    for (const guess of guesses) expect(guess.child.close).toHaveBeenCalledWith("yield");
    expect(kept.child.close).not.toHaveBeenCalled();
  });

  it("a reserve under the floor counts guess memory and drops guesses", () => {
    const { pool, mem } = fixture();
    const guess = ready(pool.reserve(key("guess"), "fp", captured, "speculative", { focus: true }), child({ kind: "fresh" }, 2 * GiB));
    mem.free = 4 * GiB;
    expect(typeof pool.reserve(key("retained"), "fp", captured, "speculative")).toBe("object");
    expect(guess.child.close).toHaveBeenCalledWith("yield");
  });

  it("unknown guess memory never admits a reserve below the floor", () => {
    const { pool, mem } = fixture();
    const guess = ready(pool.reserve(key("guess"), "fp", captured, "speculative", { focus: true }));
    mem.free = 4 * GiB;
    expect(pool.reserve(key("retained"), "fp", captured, "speculative")).toBe("denied");
    expect(guess.child.close).not.toHaveBeenCalled();
    expect(pool.reserve(key("other", "museAgent"), "fp", captured, "speculative", { focus: true })).toBe("denied");
  });

  it.each([undefined, 128 * MiB])("a denied retain at capacity keeps guesses with RSS %s", (rss) => {
    const { pool, mem } = fixture();
    const guesses = ["t1", "t2"].map((id) => ready(
      pool.reserve(key(id), "fp", captured, "speculative", { focus: true }), child({ kind: "fresh" }, rss),
    ));
    mem.free = 4 * GiB;
    expect(pool.reserve(key("retained"), "fp", captured, "speculative")).toBe("denied");
    for (const [index, guess] of guesses.entries()) {
      expect(guess.child.close).not.toHaveBeenCalled();
      expect(guess.lease.signal.aborted).toBe(false);
      expect(pool.take(key(`t${index + 1}`), "fp", captured, undefined)).toEqual({ hit: guess.lease });
    }
  });

  it("a retain drops guesses after capacity and memory checks both pass", () => {
    const { pool, mem } = fixture();
    const guesses = ["t1", "t2"].map((id) => ready(
      pool.reserve(key(id), "fp", captured, "speculative", { focus: true }), child({ kind: "fresh" }, 512 * MiB),
    ));
    mem.free = 4 * GiB;
    expect(typeof pool.reserve(key("retained"), "fp", captured, "speculative")).toBe("object");
    for (const guess of guesses) expect(guess.child.close).toHaveBeenCalledWith("yield");
  });

  it.each([false, true])("memory pressure evicts guesses first (pending %s)", (pending) => {
    const { pool, reserve, mem, pass } = fixture();
    const kept = ready(reserve("kept"), child({ kind: "fresh" }, 2 * GiB));
    const lease = asLease(pool.reserve(key("guess"), "fp", captured, "speculative", { focus: true }));
    const guessed = child({ kind: "fresh" }, GiB);
    lease.attach(guessed);
    if (!pending) lease.ready();
    mem.free = 4 * GiB;
    pass(60_000);
    expect(guessed.close).toHaveBeenCalledWith("memory");
    expect(kept.child.close).not.toHaveBeenCalled();
  });

  it("a taken guess is kept like any session", () => {
    const { pool } = fixture();
    const guess = ready(pool.reserve(key("guess"), "fp", captured, "speculative", { focus: true }));
    expect(pool.take(key("guess"), "fp", captured, undefined)).toEqual({ hit: guess.lease });
    expect(pool.offer(guess.lease)).toBe(true);
    expect(pool.reserve(key("guess"), "other", captured, "speculative", { focus: true })).toBe("busy");
    expect(guess.child.close).not.toHaveBeenCalled();
  });

  it.each([[32, 16, false], [7, 16, true], [8, 4, true], [8, 5, false]])("smallerPc follows memory %i GiB and %i CPUs", (total, cpus, expected) => {
    const { pool } = fixture({ totalmem: () => total * GiB, cpus: () => cpus });
    expect(pool.smallerPc()).toBe(expected);
  });

  it("a guess never replaces a kept session", () => {
    const { pool, reserve } = fixture();
    const kept = ready(reserve("t1"));
    expect(pool.reserve(key("t1"), "other", captured, "speculative", { focus: true })).toBe("busy");
    expect(kept.child.close).not.toHaveBeenCalled();
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ hit: kept.lease });
  });

  it("a retain reserve drops guesses rather than being denied", () => {
    const { pool } = fixture();
    const guesses = ["t1", "t2"].map((id) => ready(pool.reserve(key(id), "fp", captured, "speculative", { focus: true })));
    const retained = pool.reserve(key("t3"), "fp", captured, "speculative");
    expect(typeof retained).toBe("object");
    for (const guess of guesses) expect(guess.child.close).toHaveBeenCalledWith("yield");
  });

  it("concurrent reserves take the cap before spawning", () => {
    const { reserve } = fixture();
    const first = [reserve("t1"), reserve("t2"), reserve("t3")];
    expect(first.map((lease) => typeof lease)).toEqual(["object", "object", "string"]);
    expect(first[2]).toBe("denied");
    expect(reserve("t4", "museAgent")).not.toBe("denied");
    expect(reserve("t5", "museAgent")).toBe("denied");
    expect(reserve("t6", "antigravityAgent")).toBe("denied");
  });

  it("busy take cannot fall through to another spawn", () => {
    const { pool, reserve } = fixture();
    const { lease } = ready(reserve("t1"));
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ hit: lease });
    expect(pool.take(key("t1"), "fp", captured, undefined)).toBe("busy");
    expect(reserve("t1")).toBe("busy");
  });

  it("invalidating a never-ready prepare closes its existing child", () => {
    const { pool, reserve } = fixture();
    const lease = asLease(reserve("t1"));
    const made = child();
    lease.attach(made);
    pool.invalidate({ engine: "grokAgent" }, "sign-out");
    expect(lease.signal.aborted).toBe(true);
    expect(made.close).toHaveBeenCalledTimes(1);
    expect(pool.take(key("t1"), "fp", captured, undefined)).toBe("miss");
  });

  it("Stop cancels adoption before readiness", async () => {
    const { pool, reserve } = fixture();
    const lease = asLease(reserve("t1"));
    const made = child();
    lease.attach(made);
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ pending: lease });
    lease.release("stop");
    lease.ready();
    expect(lease.signal.aborted).toBe(true);
    expect(pool.offer(lease)).toBe(false);
    expect(pool.take(key("t1"), "fp", captured, undefined)).toBe("miss");
    expect(made.close).toHaveBeenCalledTimes(1);
    await pool.closeAll("test");
    expect(pool.stats().reserved).toBe(0);
  });

  it("old callbacks cannot release a replacement lease", () => {
    const { pool, reserve } = fixture();
    const old = asLease(reserve("t1"));
    old.release("failed");
    const next = asLease(reserve("t1"));
    expect(next).not.toBe(old);
    const late = child();
    old.release("late");
    old.attach(late);
    old.ready();
    expect(pool.offer(old)).toBe(false);
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(next.signal.aborted).toBe(false);
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ pending: next });
  });

  it("failed setup releases exactly once", async () => {
    const { pool, reserve } = fixture();
    const lease = asLease(reserve("t1"));
    const made = child();
    lease.attach(made);
    lease.release("spawn failed");
    lease.release("spawn failed");
    expect(made.close).toHaveBeenCalledTimes(1);
    await pool.closeAll("test");
    expect(pool.stats().reserved).toBe(0);
    expect([reserve("t2"), reserve("t3", "museAgent"), reserve("t4", "museAgent")]).not.toContain("denied");
  });

  it("old instance disposal preserves replacement reservations", () => {
    const { pool } = fixture();
    const old = asLease(pool.reserve(key("t1"), "fp", { ...captured, incarnation: "grok-1" }, "speculative"));
    const next = asLease(pool.reserve(key("t2"), "fp", { ...captured, incarnation: "grok-2" }, "speculative"));
    pool.invalidate({ instanceId: "grokAgent", incarnation: "grok-1" }, "dispose");
    expect(old.signal.aborted).toBe(true);
    expect(next.signal.aborted).toBe(false);
    expect(pool.take(key("t2"), "fp", { ...captured, incarnation: "grok-2" }, undefined)).toEqual({ pending: next });
  });

  it("pending, idle, closing and handshake children all count", async () => {
    const { pool, reserve } = fixture();
    asLease(reserve("pending", "grokAgent"));
    ready(reserve("idle", "museAgent"));
    const closing = asLease(reserve("closing", "antigravityAgent"));
    const slow = child();
    slow.holdExit();
    closing.attach(slow);
    closing.release("done");
    const handshake = asLease(reserve("handshake", "museAgent", "handshake"));
    expect(pool.stats()).toMatchObject({ reserved: 4, pending: 2, idle: 1, closing: 1 });
    expect(reserve("next", "antigravityAgent")).toBe("denied");
    slow.exit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pool.stats().closing).toBe(0);
    expect(reserve("next", "antigravityAgent")).toBe("denied");
    handshake.release("done");
    expect(reserve("next", "antigravityAgent")).not.toBe("denied");
  });

  it("many tabs share one lease", () => {
    const { pool, reserve } = fixture();
    const tabs = [reserve("t1"), reserve("t1"), reserve("t1")];
    expect(new Set(tabs).size).toBe(1);
    expect(pool.stats().reserved).toBe(1);
  });

  it("a healthy same-key child is not evicted for a repeat prepare", () => {
    const { pool, reserve } = fixture();
    const { lease, child: made } = ready(reserve("t1"));
    expect(reserve("t1")).toBe(lease);
    expect(made.close).not.toHaveBeenCalled();
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ hit: lease });
  });

  it("smaller-PC mode keeps 1 and none during a live turn", () => {
    let live = false;
    const small = fixture({ liveTurns: () => live });
    small.mem.total = 6 * GiB;
    small.mem.free = 3 * GiB;
    const only = asLease(small.reserve("t1"));
    expect(small.reserve("t2", "museAgent")).toBe("denied");
    only.release("done");
    live = true;
    expect(small.reserve("t2", "museAgent")).toBe("denied");
    live = false;
    const { child: made } = ready(small.reserve("t2", "museAgent"));
    live = true;
    small.pass(60_000);
    expect(made.close).toHaveBeenCalledTimes(1);

    const fewCores = fixture();
    fewCores.mem.cpus = 4;
    const { lease } = ready(fewCores.reserve("t1"));
    expect(fewCores.pool.take(key("t1"), "fp", captured, undefined)).toEqual({ hit: lease });
    expect(fewCores.reserve("t2", "museAgent")).toBe("denied");
  });

  it("memory pressure evicts the largest child", () => {
    const { pool, mem, reserve, pass } = fixture();
    const small = ready(reserve("t1"), child({ kind: "fresh" }, 100 * MiB));
    const large = ready(reserve("t2"), child({ kind: "fresh" }, 300 * MiB));
    const mid = ready(reserve("t3", "museAgent"), child({ kind: "fresh" }, 200 * MiB));
    expect(pool.stats().rssMiB).toBe(600);
    mem.free = 0.15 * mem.total - 250 * MiB;
    pass(60_000);
    expect(large.child.close).toHaveBeenCalledTimes(1);
    expect(mid.child.close).not.toHaveBeenCalled();
    expect(small.child.close).not.toHaveBeenCalled();
    expect(reserve("t4", "antigravityAgent")).toBe("denied");
  });

  it("yieldToWorker closes idle and cancels pending without awaiting", () => {
    const { pool, reserve } = fixture();
    const idle = ready(reserve("t1"));
    const pending = asLease(reserve("t2", "museAgent"));
    const resume = pool.yieldToWorker("worker launch");
    expect(typeof resume).toBe("function");
    expect(idle.child.close).toHaveBeenCalledTimes(1);
    expect(pending.signal.aborted).toBe(true);
    expect(reserve("t3")).toBe("denied");
    resume();
    resume();
    expect(reserve("t3")).not.toBe("denied");
    const again = pool.yieldToWorker("second launch");
    expect(reserve("t4", "museAgent")).toBe("denied");
    again();
  });

  it("a stale sweep closes idle children at take", () => {
    const { pool, reserve, skip } = fixture();
    const { child: made } = ready(reserve("t1"));
    skip(151_000);
    expect(pool.take(key("t1"), "fp", captured, undefined)).toBe("miss");
    expect(made.close).toHaveBeenCalledTimes(1);
  });

  it("closes idle children after 10 minutes", () => {
    const { reserve, pass } = fixture();
    const { child: made } = ready(reserve("t1"));
    pass(9 * 60_000);
    expect(made.close).not.toHaveBeenCalled();
    pass(60_000);
    expect(made.close).toHaveBeenCalledTimes(1);
  });

  it("refuses offers after the final closeAll", async () => {
    const { pool, reserve } = fixture();
    const { lease, child: made } = ready(reserve("t1"));
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ hit: lease });
    await pool.closeAll("exit", { final: true });
    expect(pool.offer(lease)).toBe(false);
    expect(made.close).toHaveBeenCalledTimes(1);
    expect(reserve("t2")).toBe("denied");
    expect(reserve("t3", "museAgent", "handshake")).toBe("denied");
  });

  it("never closes a child in use", async () => {
    const { pool, mem, reserve, pass, skip } = fixture();
    const { lease, child: made } = ready(reserve("t1"), child({ kind: "loaded", id: "sess-1" }, 500 * MiB));
    expect(pool.take(key("t1"), "fp", captured, "sess-1")).toEqual({ hit: lease });
    pass(15 * 60_000);
    mem.free = 0;
    pass(60_000);
    skip(200_000);
    expect(pool.take(key("t1"), "fp", captured, "sess-1")).toBe("busy");
    pool.yieldToWorker("worker launch")();
    pool.barrier({ engine: "grokAgent" }, "sign-out")();
    pool.invalidate({ instanceId: "grokAgent" }, "dispose");
    await pool.closeAll("reload");
    expect(made.close).not.toHaveBeenCalled();
    expect(lease.signal.aborted).toBe(false);
    expect(pool.offer(lease)).toBe(false);
    expect(made.close).toHaveBeenCalledTimes(1);
  });

  it("a barrier blocks adoption until resolved and moves the generation", () => {
    const { pool, reserve } = fixture();
    const { lease } = ready(reserve("t1"));
    const before = pool.generation(key("t1"));
    const resolve = pool.barrier({ instanceId: "grokAgent" }, "sign-in");
    expect(pool.generation(key("t1"))).toBe(before + 1);
    expect(lease.signal.aborted).toBe(true);
    expect(reserve("t1")).toBe("denied");
    expect(pool.take(key("t1"), "fp", captured, undefined)).toBe("miss");
    expect(reserve("t2", "museAgent")).not.toBe("denied");
    resolve();
    const next = ready(reserve("t1"));
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ hit: next.lease });
  });

  it("a loaded child serves only its own cursor at take", () => {
    const { pool, reserve } = fixture();
    const { child: made } = ready(reserve("t1"), child({ kind: "loaded", id: "sess-1" }));
    expect(pool.take(key("t1"), "fp", captured, "sess-2")).toBe("miss");
    expect(made.close).toHaveBeenCalledTimes(1);
  });

  it("closeAll stops waiting for a child whose close never settles", async () => {
    const { pool, reserve } = fixture();
    const hung = child();
    hung.holdExit();
    ready(reserve("t1"), hung);
    const result = await Promise.race([
      pool.closeAll("exit", { final: true, boundMs: 20 }).then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(result).toBe("closed");
    expect(hung.close).toHaveBeenCalledTimes(1);
  });

  it("a pending adoption releases a child made for another session", () => {
    const { pool, reserve } = fixture();
    const wrong = asLease(reserve("t1"));
    expect(pool.take(key("t1"), "fp", captured, "sess-B")).toEqual({ pending: wrong });
    const other = child({ kind: "loaded", id: "sess-A" });
    wrong.attach(other);
    wrong.ready();
    expect(wrong.signal.aborted).toBe(true);
    expect(other.close).toHaveBeenCalledTimes(1);
    expect(pool.offer(wrong)).toBe(false);

    const right = asLease(reserve("t2"));
    expect(pool.take(key("t2"), "fp", captured, "sess-B")).toEqual({ pending: right });
    ready(right, child({ kind: "loaded", id: "sess-B" }));
    expect(right.signal.aborted).toBe(false);
    expect(pool.offer(right)).toBe(true);
  });

  it("a joiner's release does not abort the owner's prepare", () => {
    const { reserve } = fixture();
    const owner = asLease(reserve("t1"));
    const joiner = asLease(reserve("t1"));
    expect(joiner).toBe(owner);
    joiner.release("tab closed");
    const made = child();
    owner.attach(made);
    expect(owner.signal.aborted).toBe(false);
    expect(made.close).not.toHaveBeenCalled();
    owner.release("spawn failed");
    expect(owner.signal.aborted).toBe(true);
    expect(made.close).toHaveBeenCalledTimes(1);
  });

  it("a prepare that never becomes ready expires and frees its slot", () => {
    const small = fixture();
    small.mem.total = 6 * GiB;
    small.mem.free = 3 * GiB;
    const stuck = asLease(small.reserve("t1"));
    small.pass(60_000);
    expect(stuck.signal.aborted).toBe(false);
    small.pass(60_000);
    expect(stuck.signal.aborted).toBe(true);
    expect(small.pool.stats().reserved).toBe(0);
    expect(small.reserve("t2", "museAgent")).not.toBe("denied");
  });

  it("an adopted prepare that never becomes ready expires", () => {
    const { pool, reserve, pass } = fixture();
    const stuck = asLease(reserve("t1"));
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ pending: stuck });
    pass(60_000);
    expect(stuck.signal.aborted).toBe(false);
    pass(60_000);
    expect(stuck.signal.aborted).toBe(true);
    expect(pool.take(key("t1"), "fp", captured, undefined)).toBe("miss");
  });

  it("a same-key replace is not denied by its own closing child", () => {
    const small = fixture();
    small.mem.total = 6 * GiB;
    small.mem.free = 3 * GiB;
    const slow = child();
    slow.holdExit();
    ready(small.pool.reserve(key("t1"), "fp-old", captured, "speculative"), slow);
    expect(typeof small.pool.reserve(key("t1"), "fp-new", captured, "speculative")).toBe("object");
    expect(small.pool.stats()).toMatchObject({ pending: 1, closing: 1 });
    slow.exit();
  });

  it("offer records the child's session after the turn", () => {
    const { pool, reserve } = fixture();
    const { lease, child: made } = ready(reserve("t1"));
    expect(pool.take(key("t1"), "fp", captured, undefined)).toEqual({ hit: lease });
    expect(pool.offer(lease, { kind: "loaded", id: "sess-1" })).toBe(true);
    expect(pool.take(key("t1"), "fp", captured, "sess-1")).toEqual({ hit: lease });
    expect(made.close).not.toHaveBeenCalled();
  });

  it("a child attached after its lease was released counts until it exits", async () => {
    const { pool, reserve } = fixture();
    const first = asLease(reserve("t1"));
    first.release("stop");
    const late = child();
    late.holdExit();
    first.attach(late);
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(pool.stats().closing).toBe(1);
    asLease(reserve("t2"));
    expect(reserve("t3")).toBe("denied");
    late.exit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(reserve("t3")).not.toBe("denied");
  });
});
