// Bench rule (SIM-TOURNEY, pre-registered in the pick ledger): one held-out run per arm against the base, paired on the same items.
// A win needs Holm p < 0.05 over every arm, a top-2 gain of at least 5 points, no guard row the base did not already show, and a sham that does not win.
export const RULE = { alpha: 0.05, minGain: 0.05 };

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

const count = (rows, test) => rows.filter(test).length;

/** base and each arm's rows: { id, kind: positive | miss | guard, shown, hit, wrongScope, superseded }, the same ids in the same order. */
export function judge({ base, arms }) {
  if (arms.filter((arm) => arm.sham).length !== 1) throw new Error("a round needs exactly one sham arm");
  const ids = base.map((row) => row.id).join("\n");
  for (const arm of arms) if (arm.rows.map((row) => row.id).join("\n") !== ids) throw new Error(`arm ${arm.name} scored other items than the base`);
  const positives = count(base, (row) => row.kind === "positive");
  const scored = arms.map((arm) => {
    let b = 0;
    let c = 0;
    const guards = { wrongScope: 0, superseded: 0, mustHold: 0, falseRecall: 0 };
    // a real-traffic positive carries its answer-row cluster: the paired test counts each cluster once by its net change, so one note line or bot cannot carry a win
    const votes = new Map();
    const asks = { b: 0, c: 0 };
    arm.rows.forEach((row, at) => {
      const was = base[at];
      if (row.kind === "positive" && was.hit !== row.hit) {
        asks[row.hit ? "c" : "b"]++;
        if (row.cluster !== undefined) votes.set(row.cluster, (votes.get(row.cluster) ?? 0) + (row.hit ? 1 : -1));
        else if (row.hit) c++;
        else b++;
      }
      if (row.wrongScope && !was.wrongScope) guards.wrongScope++;
      if (row.superseded && !was.superseded) guards.superseded++;
      if (row.kind === "guard" && was.hit && !row.hit) guards.mustHold++;
      if (row.kind === "miss" && row.shown.length && !was.shown.length) guards.falseRecall++;
    });
    for (const net of votes.values()) {
      if (net > 0) c++;
      if (net < 0) b++;
    }
    const clustered = base.some((row) => row.cluster !== undefined);
    const clean = !guards.wrongScope && !guards.superseded && !guards.mustHold && !guards.falseRecall;
    const hits = count(arm.rows, (row) => row.kind === "positive" && row.hit);
    return { name: arm.name, sham: Boolean(arm.sham), of: positives, baseHits: count(base, (row) => row.kind === "positive" && row.hit), hits, gain: (asks.c - asks.b) / positives, b, c, ...(clustered ? { asks } : {}), p: mcnemar(b, c), guards: { ...guards, clean } };
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
