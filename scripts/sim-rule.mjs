// Bench rule (SIM-TOURNEY, pre-registered in the pick ledger): one held-out run per arm against the base, paired on the same items.
// A win needs Holm p < 0.05 over every arm, a top-2 gain of at least 5 points, clean guards, and a sham that does not win.
export const RULE = { alpha: 0.05, minGain: 0.05, falseRecallBound: 0.01, confidence: 0.95 };

// log C(n, k) by summing logs, so 0.5^n never underflows on a large set
function logChoose(n, k) {
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/** Exact two-sided McNemar on the discordant pairs: b lost by the arm, c gained. */
export function mcnemar(b, c) {
  const n = b + c;
  if (!n) return 1;
  const low = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= low; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

export function holm(ps) {
  const order = ps.map((p, at) => ({ p, at })).sort((x, y) => x.p - y.p);
  const out = Array.from({ length: ps.length });
  let running = 0;
  order.forEach(({ p, at }, rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    out[at] = running;
  });
  return out;
}

const binomCdf = (k, n, p) => {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return sum;
};

/** One-sided Clopper-Pearson upper bound on a rate seen k times in n. */
export function upperBound(k, n, confidence = RULE.confidence) {
  if (k >= n) return 1;
  const alpha = 1 - confidence;
  if (k === 0) return 1 - alpha ** (1 / n);
  let low = k / n;
  let high = 1;
  for (let step = 0; step < 100; step++) {
    const mid = (low + high) / 2;
    if (binomCdf(k, n, mid) > alpha) low = mid;
    else high = mid;
  }
  return high;
}

const count = (rows, test) => rows.filter(test).length;

/** base and each arm's rows: { id, kind: positive | miss | guard, shown, hit, wrongScope, superseded }, the same ids in the same order. */
export function judge({ base, arms }) {
  if (arms.filter((arm) => arm.sham).length !== 1) throw new Error("a round needs exactly one sham arm");
  const ids = base.map((row) => row.id).join("\n");
  for (const arm of arms) if (arm.rows.map((row) => row.id).join("\n") !== ids) throw new Error(`arm ${arm.name} scored other items than the base`);
  const positives = count(base, (row) => row.kind === "positive");
  const misses = count(base, (row) => row.kind === "miss");
  const scored = arms.map((arm) => {
    let b = 0;
    let c = 0;
    const guards = { wrongScope: 0, superseded: 0, mustHold: 0, falseRecall: 0 };
    arm.rows.forEach((row, at) => {
      const was = base[at];
      if (row.kind === "positive" && was.hit !== row.hit) {
        if (row.hit) c++;
        else b++;
      }
      if (row.wrongScope && !was.wrongScope) guards.wrongScope++;
      if (row.superseded && !was.superseded) guards.superseded++;
      if (row.kind === "guard" && was.hit && !row.hit) guards.mustHold++;
      if (row.kind === "miss" && row.shown.length) guards.falseRecall++;
    });
    const falseRecallBound = misses ? upperBound(guards.falseRecall, misses) : 1;
    const clean = !guards.wrongScope && !guards.superseded && !guards.mustHold && falseRecallBound <= RULE.falseRecallBound;
    const hits = count(arm.rows, (row) => row.kind === "positive" && row.hit);
    return { name: arm.name, sham: Boolean(arm.sham), of: positives, baseHits: count(base, (row) => row.kind === "positive" && row.hit), hits, gain: (c - b) / positives, b, c, p: mcnemar(b, c), guards: { ...guards, falseRecallBound, clean } };
  });
  const adjusted = holm(scored.map((arm) => arm.p));
  const ruled = scored.map((arm, at) => {
    const pHolm = adjusted[at];
    const significant = pHolm < RULE.alpha;
    let verdict;
    if (!arm.guards.clean || (significant && arm.b > arm.c)) verdict = "worse";
    else if (significant && arm.c > arm.b && arm.gain >= RULE.minGain) verdict = "win";
    else if (arm.c > arm.b) verdict = "promising";
    else verdict = "no gain";
    return { ...arm, pHolm, verdict };
  });
  const voided = ruled.some((arm) => arm.sham && arm.verdict === "win");
  return { void: voided, arms: voided ? ruled.map((arm) => (arm.verdict === "win" ? { ...arm, verdict: "promising" } : arm)) : ruled };
}
