import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cases, judgeCase, MANIFEST, refOf, setFile, sha256, TUNING } from "./recall-sets.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BENCH = fileURLToPath(new URL("./recall-bench.ts", import.meta.url));
const TINY = { ...TUNING, name: "tiny", seed: 5, positives: 8, misses: 4, guards: 3 };
const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    // unlink the shared node_modules first, so the cleanup never walks into it
    if (existsSync(join(dir, "node_modules"))) unlinkSync(join(dir, "node_modules"));
    rmSync(dir, { recursive: true, force: true });
  }
});

function kit() {
  const dir = mkdtempSync(join(tmpdir(), "recall-bench-test-"));
  temps.push(dir);
  const text = setFile(TINY);
  writeFileSync(join(dir, "tiny.json"), text);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tiny: { hash: sha256(text) } }));
  return dir;
}
const bench = (dir, extra = [], root = ROOT) => {
  const { VITEST: _vitest, ...env } = process.env;
  return spawnSync(process.execPath, ["--experimental-strip-types", BENCH, "--root", root, "--sets", dir, "--set", "tiny", "--manifest", join(dir, "manifest.json"), "--out", join(dir, "out.json"), ...extra], { encoding: "utf8", env: { ...env, TMP: dir, TEMP: dir, TMPDIR: dir } });
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

// an arm checkout: the files the scorer loads from this repo, with one edit to the lookup, as a patch arm would make it
function arm(from, to) {
  const dir = mkdtempSync(join(tmpdir(), "recall-bench-arm-"));
  temps.push(dir);
  const todo = ["server/memory-lookup.ts", "server/memory-pass.ts", "server/config.ts", "package.json"].map((path) => join(ROOT, path));
  for (const seen = new Set(); todo.length; ) {
    const path = todo.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    mkdirSync(dirname(join(dir, relative(ROOT, path))), { recursive: true });
    cpSync(path, join(dir, relative(ROOT, path)));
    if (path.endsWith(".ts")) for (const [, spec] of readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) todo.push(resolve(dirname(path), spec));
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  const lookup = join(dir, "server", "memory-lookup.ts");
  const text = readFileSync(lookup, "utf8");
  expect(text).toContain(from);
  writeFileSync(lookup, text.replace(from, to));
  return dir;
}
const scored = (dir, root) => {
  const run = bench(dir, [], root);
  expect(run.status, run.stderr).toBe(0);
  return new Map(JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).rows.map((row) => [row.id, row.shown]));
};

describe("scorer reads only what the bot gets", () => {
  it("judges the top 2 rows: an arm that shows or logs more rows scores the same as the base", () => {
    const dir = kit();
    const base = scored(dir, ROOT);
    for (const [from, to] of [["const MAX_ROWS = 2;", "const MAX_ROWS = 5;"], ["entry.rows = logged(picked);", "entry.rows = logged(unseen);"]]) {
      const rows = scored(dir, arm(from, to));
      for (const [id, shown] of rows) {
        expect(shown.length).toBeLessThanOrEqual(2);
        expect(shown, `${to} ${id}`).toEqual(base.get(id));
      }
    }
  }, 120_000);

  it("fails an arm whose take() text does not carry the rows it logged", () => {
    const dir = kit();
    const run = bench(dir, [], arm("...picked.map((hit) =>", "...picked.slice(1).map((hit) =>"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/take\(\) gave the bot/);
  }, 60_000);
});
