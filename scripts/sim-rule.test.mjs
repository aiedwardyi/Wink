import { describe, expect, it } from "vitest";

import { holm, judge, mcnemar } from "./sim-rule.mjs";

// exact two-sided binomial in BigInt, independent of the float walk under test
function exact(b, c) {
  const n = b + c;
  if (!n) return 1;
  let coef = 1n;
  let tail = 0n;
  for (let i = 0; i <= Math.min(b, c); i++) {
    tail += coef;
    coef = (coef * BigInt(n - i)) / BigInt(i + 1);
  }
  return Math.min(1, (2 * Number(tail)) / Number(2n ** BigInt(n)));
}

const items = (kind, count, fields = {}) => Array.from({ length: count }, (_, n) => ({ id: `${kind}-${n}`, kind, shown: [], hit: false, wrongScope: false, superseded: false, ...fields }));
// 450 positives, 300 no-match, 100 guard items, base hits 380 positives and every guard item
const base = () => [...items("positive", 380, { hit: true, shown: ["a"] }), ...items("positive", 70).map((row, n) => ({ ...row, id: `positive-${380 + n}` })), ...items("miss", 300), ...items("guard", 100, { hit: true, shown: ["a"] })];
const flip = (rows, ids, patch) => rows.map((row) => (ids.includes(row.id) ? { ...row, ...patch } : row));
const range = (from, count) => Array.from({ length: count }, (_, n) => `positive-${from + n}`);

describe("exact McNemar", () => {
  it("matches known tables", () => {
    expect(mcnemar(0, 2)).toBeCloseTo(0.5, 12);
    expect(mcnemar(1, 9)).toBeCloseTo(0.021484375, 12);
    expect(mcnemar(0, 6)).toBeCloseTo(0.03125, 12);
    expect(mcnemar(5, 5)).toBe(1);
    expect(mcnemar(0, 0)).toBe(1);
    expect(mcnemar(9, 1)).toBe(mcnemar(1, 9));
  });

  it("agrees with an exact BigInt sum up to the held-out size", () => {
    for (const [b, c] of [[10, 30], [3, 27], [40, 62], [100, 140], [200, 250], [0, 450], [225, 225]]) {
      const want = exact(b, c);
      expect(Math.abs(mcnemar(b, c) - want)).toBeLessThanOrEqual(want * 1e-9);
    }
  });
});

describe("Holm", () => {
  it("adjusts in step-down order and keeps the input order", () => {
    const adjusted = holm([0.01, 0.04, 0.03, 0.005]);
    [0.03, 0.06, 0.06, 0.02].forEach((want, at) => expect(adjusted[at]).toBeCloseTo(want, 12));
    expect(holm([0.5, 0.9])).toEqual([1, 1]);
    expect(holm([])).toEqual([]);
  });
});

describe("round verdicts", () => {
  const sham = { name: "sham", sham: true, rows: base() };

  it("a clear gain with clean guards wins; the sham ties", () => {
    const round = judge({ base: base(), arms: [sham, { name: "up", rows: flip(base(), range(380, 30), { hit: true, shown: ["a"] }) }] });
    expect(round.void).toBe(false);
    expect(round.arms.map((arm) => arm.verdict)).toEqual(["no gain", "win"]);
    expect(round.arms[1]).toMatchObject({ b: 0, c: 30, gain: 30 / 450 });
  });

  it("a significant gain under 5 points is only promising", () => {
    const round = judge({ base: base(), arms: [sham, { name: "small", rows: flip(base(), range(380, 20), { hit: true, shown: ["a"] }) }] });
    expect(round.arms[1].pHolm).toBeLessThan(0.05);
    expect(round.arms[1].verdict).toBe("promising");
  });

  it("one new superseded row, wrong-scope row, must-hold miss or false recall is worse, whatever the gain", () => {
    const up = flip(base(), range(380, 40), { hit: true, shown: ["a"] });
    const broken = [
      flip(up, ["positive-0"], { superseded: true }),
      flip(up, ["positive-1"], { wrongScope: true }),
      flip(up, ["guard-0"], { hit: false, shown: [] }),
      flip(up, ["miss-0"], { shown: ["x"] }),
    ];
    const round = judge({ base: base(), arms: [sham, ...broken.map((rows, n) => ({ name: `broken-${n}`, rows }))] });
    expect(round.arms.slice(1).map((arm) => arm.verdict)).toEqual(["worse", "worse", "worse", "worse"]);
  });

  it("a no-match row the base already shows is not new: the sham ties and a gain still wins; a new one is worse", () => {
    const shows = (rows) => flip(rows, ["miss-0", "miss-1", "miss-2"], { shown: ["x"] });
    const up = shows(flip(base(), range(380, 30), { hit: true, shown: ["a"] }));
    const round = judge({ base: shows(base()), arms: [{ ...sham, rows: shows(base()) }, { name: "up", rows: up }, { name: "more", rows: flip(up, ["miss-3"], { shown: ["y"] }) }] });
    expect(round.arms.map((arm) => arm.verdict)).toEqual(["no gain", "win", "worse"]);
    expect(round.arms.map((arm) => arm.guards.falseRecall)).toEqual([0, 0, 1]);
  });

  it("positives tagged with an answer-row cluster count once per cluster, so one note line cannot carry a win", () => {
    const tagged = (rows, cluster) => rows.map((row) => (row.kind === "positive" ? { ...row, cluster: cluster(Number(row.id.split("-")[1])) } : row));
    const oneLine = (n) => (n >= 380 && n < 410 ? "r-one" : `r-${n}`);
    const round = judge({ base: tagged(base(), oneLine), arms: [{ ...sham, rows: tagged(base(), oneLine) }, { name: "one-line", rows: tagged(flip(base(), range(380, 30), { hit: true, shown: ["a"] }), oneLine) }, { name: "spread", rows: tagged(flip(base(), range(380, 30), { hit: true, shown: ["a"] }), (n) => `r-${n}`) }] });
    expect(round.arms.map((arm) => [arm.name, arm.b, arm.c, arm.verdict])).toEqual([["sham", 0, 0, "no gain"], ["one-line", 0, 1, "promising"], ["spread", 0, 30, "win"]]);
    expect(round.arms[1].asks).toEqual({ b: 0, c: 30 });
    expect(round.arms[1].gain).toBeCloseTo(30 / 450);
  });

  it("a significant loss is worse", () => {
    const round = judge({ base: base(), arms: [sham, { name: "reversed", rows: flip(base(), range(0, 60), { hit: false, shown: ["b"] }) }] });
    expect(round.arms[1]).toMatchObject({ b: 60, c: 0, verdict: "worse" });
  });

  it("a sham that wins voids the round and no arm is a win", () => {
    const up = flip(base(), range(380, 30), { hit: true, shown: ["a"] });
    const round = judge({ base: base(), arms: [{ ...sham, rows: up }, { name: "up", rows: up }] });
    expect(round.void).toBe(true);
    expect(round.arms.map((arm) => arm.verdict)).toEqual(["promising", "promising"]);
  });

  it("Holm runs over every arm in the round", () => {
    const mid = flip(base(), range(380, 30), { hit: true, shown: ["a"] });
    const loose = flip(mid, range(0, 12), { hit: false, shown: ["b"] });
    const alone = judge({ base: base(), arms: [sham, { name: "a", rows: loose }] }).arms[1];
    const crowd = judge({ base: base(), arms: [sham, { name: "a", rows: loose }, { name: "b", rows: base() }, { name: "c", rows: base() }] }).arms[1];
    expect(crowd.pHolm).toBeGreaterThan(alone.pHolm);
    expect(crowd.p).toBe(alone.p);
  });

  it("needs exactly one sham and the same items in every arm", () => {
    expect(() => judge({ base: base(), arms: [{ name: "a", rows: base() }] })).toThrow(/one sham/);
    expect(() => judge({ base: base(), arms: [sham, { name: "a", rows: base().slice(1) }] })).toThrow(/items/);
  });
});

describe("added-fire precision (real-v1c)", () => {
  // 100 positives, base hits 10; 900 no-match asks, base shows a wrong row on 60: base precision 10/70
  const real = () => [...items("positive", 10, { hit: true, shown: ["a"], judged: ["right"] }), ...items("positive", 90).map((row, n) => ({ ...row, id: `positive-${10 + n}` })), ...items("miss", 60, { shown: ["x"], judged: ["wrong"] }), ...items("miss", 840).map((row, n) => ({ ...row, id: `miss-${60 + n}` }))];
  const gain = (rows) => flip(rows, range(10, 30), { hit: true, shown: ["a"], judged: ["right"] });
  const misses = (from, count) => Array.from({ length: count }, (_, n) => `miss-${from + n}`);
  const sham = () => ({ name: "sham", sham: true, rows: real() });

  it("an arm adding a correct row the pool never showed, on a no-match ask, is not worse", () => {
    const round = judge({ base: real(), arms: [sham(), { name: "found", rows: flip(gain(real()), ["miss-60"], { shown: ["new"], judged: ["right"] }) }] });
    expect(round.arms[1].verdict).toBe("win");
    expect(round.arms[1].guards.precision).toMatchObject({ added: 31, right: 31, wrong: 0, unjudged: 0 });
  });

  it("added fires at least as precise as the base pass; less precise ones are worse", () => {
    const precise = flip(gain(real()), misses(60, 100), { shown: ["y"], judged: ["wrong"] });
    const junk = flip(gain(real()), misses(60, 200), { shown: ["y"], judged: ["wrong"] });
    const round = judge({ base: real(), arms: [sham(), { name: "precise", rows: precise }, { name: "junk", rows: junk }] });
    expect(round.arms.map((arm) => [arm.name, arm.verdict])).toEqual([["sham", "no gain"], ["precise", "win"], ["junk", "worse"]]);
    expect(round.arms[1].guards.precision).toMatchObject({ added: 130, right: 30, wrong: 100, floor: 10 / 70 });
    expect(round.arms[2].guards.precision.precision).toBeCloseTo(30 / 230);
    expect(round.arms[2].guards.falseRecall).toBe(200);
  });

  it("a fire is right if any shown row is right, and one with a split row and no right row is left out", () => {
    const rows = flip(flip(gain(real()), misses(60, 200), { shown: ["y"], judged: ["split"] }), ["miss-260"], { shown: ["y", "z"], judged: ["wrong", "right"] });
    const arm = judge({ base: real(), arms: [sham(), { name: "split", rows }] }).arms[1];
    expect(arm.guards.precision).toMatchObject({ added: 231, right: 31, wrong: 0, unjudged: 200 });
    expect(arm.verdict).toBe("win");
  });
});
