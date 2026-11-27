import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cases, judgeCase, MANIFEST, refOf, setFile, sha256, TUNING } from "./recall-sets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BENCH = fileURLToPath(new URL("./recall-bench.ts", import.meta.url));
const TINY = { ...TUNING, name: "tiny", seed: 5, positives: 8, misses: 4, guards: 3 };
const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function kit() {
  const dir = mkdtempSync(join(tmpdir(), "recall-bench-test-"));
  temps.push(dir);
  const text = setFile(TINY);
  writeFileSync(join(dir, "tiny.json"), text);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tiny: { hash: sha256(text) } }));
  return dir;
}
const bench = (dir, extra = []) => {
  const { VITEST: _vitest, ...env } = process.env;
  return spawnSync(process.execPath, ["--experimental-strip-types", BENCH, "--root", ROOT, "--sets", dir, "--set", "tiny", "--manifest", join(dir, "manifest.json"), "--out", join(dir, "out.json"), ...extra], { encoding: "utf8", env: { ...env, TMP: dir, TEMP: dir, TMPDIR: dir } });
};

describe("case judge", () => {
  const [item] = cases(TINY).filter((each) => each.kind === "positive");
  it("names a hit, a superseded row, another bot's row and a stale row", () => {
    expect(judgeCase(item, [refOf(item, item.answer)])).toEqual({ hit: true, wrongScope: false, superseded: false, stale: false });
    expect(judgeCase(item, [refOf(item, item.superseded)])).toMatchObject({ hit: false, superseded: true });
    expect(judgeCase(item, ["memory/x-team.md:3"])).toMatchObject({ hit: false, wrongScope: true });
    if (item.stale.length) expect(judgeCase(item, [refOf(item, item.stale[0])])).toMatchObject({ stale: true });
  });
  it("sets are the same bytes every run, with the counts asked for", () => {
    expect(setFile(TINY)).toBe(setFile(TINY));
    const kinds = cases(TINY).map((each) => each.kind);
    expect([kinds.filter((k) => k === "positive").length, kinds.filter((k) => k === "miss").length, kinds.filter((k) => k === "guard").length]).toEqual([8, 4, 3]);
  });
  it("the checked-in tuning hash is what the generator makes", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(sha256(setFile(TUNING))).toBe(manifest.tuning.hash);
    expect(manifest.tuning.cases).toBe(1500);
    expect(manifest["held-out"]).toMatchObject({ positives: 450, misses: 300, guards: 100 });
  });
});

describe("scorer", () => {
  it("scores a frozen set through the real lookup, at parity with the pick it replicates", () => {
    const dir = kit();
    const run = bench(dir, ["--parity", "15"]);
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
    expect(out.parity).toEqual({ checked: 15, mismatches: 0 });
    const byId = new Map(cases(TINY).map((each) => [each.id, each]));
    expect(out.rows).toHaveLength(15);
    for (const row of out.rows) expect({ hit: row.hit, wrongScope: row.wrongScope, superseded: row.superseded, stale: row.stale }).toEqual(judgeCase(byId.get(row.id), row.shown));
    expect(out.totals.hits).toBeGreaterThan(0);
    expect(out.totals.hits).toBe(out.rows.filter((row) => row.kind === "positive" && row.hit).length);
  });

  it("refuses a set whose bytes do not match the manifest hash", () => {
    const dir = kit();
    writeFileSync(join(dir, "tiny.json"), readFileSync(join(dir, "tiny.json"), "utf8").replace("Prefers short replies", "Prefers long replies"));
    const run = bench(dir);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/hash/);
  });
});
