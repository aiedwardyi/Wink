import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { armDiff, fileHash, LOCKED, lockedIn, mustAlsoWin, readLabels, unlabeled, withLabels } from "./sim-tourney.mjs";

const TOURNEY = fileURLToPath(new URL("./sim-tourney.mjs", import.meta.url));
const BENCH = fileURLToPath(new URL("..", import.meta.url));
const temps = [];
const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "sim-tourney-test-"));
  temps.push(dir);
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { encoding: "utf8" }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git("init", "-q");
  put("server/memory-lookup.ts", "export const a = 1;\n");
  put("scripts/sim-rule.mjs", "export const rule = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  const arm = (path) => {
    git("checkout", "-q", "--detach", base);
    put(path, "export const cheat = 1;\n");
    git("add", "-A");
    git("commit", "-qm", `arm ${path}`);
    return git("rev-parse", "HEAD");
  };
  const rename = (from, to) => {
    git("checkout", "-q", "--detach", base);
    git("mv", from, to);
    git("commit", "-qm", `move ${from}`);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, base, arm, rename };
}
const run = (dir, spec, extra = []) => {
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
  return spawnSync(process.execPath, [TOURNEY, join(dir, "spec.json"), "--repo", dir, "--sets", join(dir, "sets"), "--ledger", join(dir, "no-ledger.mjs"), "--out", join(dir, "runs"), ...extra], { encoding: "utf8" });
};

describe("bench lock", () => {
  it("names every scorer, set and rule file an arm may not touch", () => {
    for (const path of ["scripts/recall-bench.ts", "scripts/recall-sets.ts", "scripts/recall-sets.json", "scripts/sim-rule.mjs", "scripts/sim-tourney.mjs", "scripts/sim-rule.test.mjs"]) expect(lockedIn([path])).toEqual([path]);
    expect(lockedIn(["server/memory-lookup.ts", "server/memory-lookup.test.ts"])).toEqual([]);
    expect(LOCKED.length).toBeGreaterThan(0);
  });

  it("reads an arm's changed files from git", () => {
    const { dir, base, arm } = repo();
    expect(armDiff(dir, base, arm("server/memory-lookup.ts"))).toEqual(["server/memory-lookup.ts"]);
  });

  it("refuses an arm that renames a locked file away", () => {
    const { dir, git, base, rename } = repo();
    const moved = rename("scripts/sim-rule.mjs", "scripts/rule2.mjs");
    expect(armDiff(dir, base, moved)).toContain("scripts/sim-rule.mjs");
    const out = run(dir, { name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "cheat", sha: moved }] });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("bench lock: arm cheat touches scripts/sim-rule.mjs");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  });

  for (const path of ["scripts/recall-bench.ts", "scripts/recall-sets.json", "scripts/sim-rule.mjs"]) {
    it(`refuses an arm commit touching ${path} before any worktree or score`, () => {
      const { dir, git, base, arm } = repo();
      const out = run(dir, { name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "cheat", sha: arm(path) }] });
      expect(out.status).toBe(1);
      expect(out.stderr).toContain(`bench lock: arm cheat touches ${path}`);
      expect(git("worktree", "list").split("\n")).toHaveLength(1);
    });
  }

  it("refuses an arm patch touching the sets manifest", () => {
    const { dir, git, base } = repo();
    git("checkout", "-q", "--detach", base);
    writeFileSync(join(dir, "cheat.patch"), ["diff --git a/scripts/recall-sets.json b/scripts/recall-sets.json", "new file mode 100644", "--- /dev/null", "+++ b/scripts/recall-sets.json", "@@ -0,0 +1 @@", "+{}", ""].join("\n"));
    const out = run(dir, { name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "cheat", patch: join(dir, "cheat.patch") }] });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("bench lock: arm cheat touches scripts/recall-sets.json");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("refuses a pre-registration a newer one superseded", () => {
    const { dir, base, arm } = repo();
    writeFileSync(join(dir, "ledger.json"), JSON.stringify({ bench: { prereg: [{ id: "v1" }, { id: "v2", supersedes: "v1" }] } }));
    const out = run(dir, { name: "t", base, prereg: "v1", arms: [{ name: "sham", sham: true, sha: base }, { name: "fair", sha: arm("server/memory-lookup.ts") }] });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("pre-registration v1 is superseded by v2");
  });

  it("lets a server-only arm past the lock, to the pre-registration check", () => {
    const { dir, base, arm } = repo();
    const out = run(dir, { name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "fair", sha: arm("server/memory-lookup.ts") }] });
    expect(out.status).toBe(1);
    expect(out.stderr).not.toContain("bench lock");
    expect(out.stderr).toMatch(/pre-registration/);
  });
});

const manifest = JSON.parse(readFileSync(join(BENCH, "scripts", "recall-sets.json"), "utf8"));
const pins = () => ({
  ruleHash: fileHash(join(BENCH, "scripts", "sim-rule.mjs")),
  scorerHash: fileHash(join(BENCH, "scripts", "recall-bench.ts")),
  generatorHash: fileHash(join(BENCH, "scripts", "recall-sets.ts")),
  tuning: manifest.tuning.hash,
  heldOut: manifest["held-out"].hash,
  bench: execFileSync("git", ["-C", BENCH, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
});
const filed = (dir, files) => writeFileSync(join(dir, "ledger.json"), JSON.stringify({ bench: { prereg: [{ id: "p", files }] } }));

describe("held-out safety", () => {
  const fair = (dir, base, arm) => ({ name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "fair", sha: arm("server/memory-lookup.ts") }] });
  // a stand-in held-out set the scorer refuses by hash, so the round stops at its first score
  const heldOut = (dir) => {
    mkdirSync(join(dir, "sets"));
    writeFileSync(join(dir, "sets", "held-out.json"), "{}");
    filed(dir, pins());
    writeFileSync(join(dir, "ledger.mjs"), 'import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(new URL("./calls.jsonl", import.meta.url), readFileSync(process.argv[3], "utf8").replace(/\\n/g, "") + "\\n");\n');
    return ["--on", "held-out", "--ledger", join(dir, "ledger.mjs")];
  };
  const usesOf = (dir) => JSON.parse(readFileSync(join(dir, "sets", "uses.json"), "utf8"))[manifest["held-out"].hash];
  const calls = (dir) => lines(readFileSync(join(dir, "calls.jsonl"), "utf8")).map((line) => JSON.parse(line));

  it("runs on tuning unless held-out is named, and refuses a tuning folder that holds the held-out set", () => {
    const { dir, base, arm } = repo();
    mkdirSync(join(dir, "sets"));
    writeFileSync(join(dir, "sets", "tuning.json"), "{}");
    writeFileSync(join(dir, "sets", "held-out.json"), "{}");
    const out = run(dir, fair(dir, base, arm));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("held-out.json sits in the tuning folder");
  });

  it("refuses a held-out run from a folder that holds the tuning set", () => {
    const { dir, base, arm } = repo();
    mkdirSync(join(dir, "sets"));
    writeFileSync(join(dir, "sets", "tuning.json"), "{}");
    const out = run(dir, fair(dir, base, arm), ["--on", "held-out"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("tuning.json sits in the held-out folder");
  });

  it("spends the held-out use in uses.json and the ledger before the first score, so a round that stops still counts", () => {
    const { dir, git, base, arm } = repo();
    const spec = fair(dir, base, arm);
    const extra = heldOut(dir);
    const out = run(dir, spec, extra);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("scorer failed");
    const sha = spec.arms[1].sha;
    expect(usesOf(dir).map((use) => use.arms.map((each) => [each.name, each.sha]))).toEqual([[["sham", base], ["fair", sha]]]);
    expect(calls(dir)).toMatchObject([{ started: true, prereg: "p", set: { use: 1, of: 3 }, base: { sha: base }, arms: [{ name: "sham", sham: true }, { name: "fair", sham: false, sha }] }]);
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    const again = run(dir, spec, extra);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(`arm fair ${sha.slice(0, 9)} already had its held-out run on this set`);
  });

  it("refuses a patch arm whose patch already had its held-out run, under any name", () => {
    const { dir, git, base, arm } = repo();
    const patch = join(dir, "fair.patch");
    writeFileSync(patch, `${git("diff", base, arm("server/memory-lookup.ts"))}\n`);
    git("checkout", "-q", "--detach", base);
    const extra = heldOut(dir);
    const spec = (name) => ({ name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name, patch }] });
    expect(run(dir, spec("fair"), extra).stderr).toContain("scorer failed");
    const again = run(dir, spec("renamed"), extra);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/arm renamed [0-9a-f]{9} already had its held-out run on this set/);
    expect(usesOf(dir)).toHaveLength(1);
  });
});

describe("pre-registration pins the bench", () => {
  for (const [key, stale] of [["scorerHash", "a".repeat(64)], ["generatorHash", undefined], ["heldOut", "b".repeat(64)], ["bench", "0".repeat(40)]]) {
    it(`refuses a pre-registration whose ${key} is not the bench's`, () => {
      const { dir, base, arm } = repo();
      filed(dir, { ...pins(), [key]: stale });
      const out = run(dir, { name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "fair", sha: arm("server/memory-lookup.ts") }] });
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(key === "bench" ? /names bench 0+, which is not a commit here/ : new RegExp(`names files\\.${key} `));
      expect(out.stderr).toContain("new pre-registration");
    });
  }
});

describe("sets manifest and single-judge sets", () => {
  const REAL = join(BENCH, "scripts", "recall-sets.real-v1.json");
  const real = JSON.parse(readFileSync(REAL, "utf8"));
  const spec = (base, arm) => ({ name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "fair", sha: arm("server/memory-lookup.ts"), guess: 1 }] });
  const held = (dir) => {
    mkdirSync(join(dir, "sets"));
    writeFileSync(join(dir, "sets", "held-out.json"), "{}");
    return ["--on", "held-out", "--manifest", REAL];
  };

  it("refuses a --manifest that is not a locked bench sets file", () => {
    const { dir, base, arm } = repo();
    writeFileSync(join(dir, "loose.json"), JSON.stringify(real));
    const out = run(dir, spec(base, arm), ["--manifest", join(dir, "loose.json")]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("is not a bench sets manifest");
  });

  it("pins the set hashes from --manifest, then needs each alsoWin set pinned and present before spending the held-out use", () => {
    const { dir, base, arm } = repo();
    const round = spec(base, arm);
    const extra = held(dir);
    filed(dir, pins());
    expect(run(dir, round, extra).stderr).toMatch(/names files\.tuning /);
    const files = { ...pins(), tuning: real.tuning.hash, heldOut: real["held-out"].hash };
    filed(dir, files);
    expect(run(dir, round, extra).stderr).toContain("names sides.held-out-opus undefined");
    writeFileSync(join(dir, "ledger.json"), JSON.stringify({ bench: { prereg: [{ id: "p", files, sides: { "held-out-opus": real["held-out-opus"].hash, "held-out-sol": real["held-out-sol"].hash } }] } }));
    const out = run(dir, round, extra);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("needs its alsoWin set held-out-opus");
    expect(existsSync(join(dir, "sets", "uses.json"))).toBe(false);
  });

  it("keeps a win only when every alsoWin set is a win too", () => {
    const arms = [{ name: "sham", verdict: "no gain" }, { name: "a", verdict: "win" }, { name: "b", verdict: "win" }, { name: "c", verdict: "worse" }];
    const side = (verdicts) => ({ arms: verdicts.map((verdict) => ({ verdict })) });
    const out = mustAlsoWin(arms, { opus: side(["no gain", "win", "win", "worse"]), sol: side(["no gain", "win", "promising", "no gain"]) });
    expect(out.map((arm) => [arm.name, arm.verdict])).toEqual([["sham", "no gain"], ["a", "win"], ["b", "promising"], ["c", "worse"]]);
    expect(out[2].also).toEqual({ opus: "win", sol: "promising" });
    expect(mustAlsoWin(arms, {})).toBe(arms);
  });
});

describe("row labels", () => {
  const store = (marks) => {
    const dir = mkdtempSync(join(tmpdir(), "sim-labels-test-"));
    temps.push(dir);
    writeFileSync(join(dir, "row-labels.jsonl"), marks.map((mark) => JSON.stringify(mark)).join("\n") + "\n");
    return join(dir, "row-labels.jsonl");
  };

  it("reads one mark per judge, a later line winning", () => {
    const labels = readLabels(store([{ id: "a", ref: "m.md:1", engine: "opus", mark: false }, { id: "a", ref: "m.md:1", engine: "sol", mark: true }, { id: "a", ref: "m.md:1", engine: "opus", mark: true }]));
    expect(labels.get("a\tm.md:1")).toEqual({ opus: true, sol: true });
    expect(readLabels(join(tmpdir(), "no-such-labels.jsonl")).size).toBe(0);
  });

  it("lists each shown row a judge has not labeled once, without saying which arm showed it", () => {
    const labels = readLabels(store([{ id: "a", ref: "m.md:1", engine: "opus", mark: true }, { id: "a", ref: "m.md:1", engine: "sol", mark: false }, { id: "b", ref: "m.md:2", engine: "opus", mark: false }]));
    const base = [{ id: "a", shown: ["m.md:1"] }, { id: "b", shown: [] }];
    const arm = [{ id: "a", shown: ["m.md:1", "m.md:9"] }, { id: "b", shown: ["m.md:2"] }];
    const other = [{ id: "a", shown: ["m.md:9"] }, { id: "b", shown: ["m.md:2"] }];
    const missing = unlabeled([base, arm, other], labels, ["opus", "sol"]);
    expect(missing).toHaveLength(2);
    expect(missing.map((row) => `${row.id} ${row.ref}`).sort()).toEqual(["a m.md:9", "b m.md:2"]);
    expect(Object.keys(missing[0]).sort()).toEqual(["id", "ref"]);
    expect(unlabeled([arm, base, other], labels, ["opus", "sol"])).toEqual(missing);
  });

  it("labels a row right when every judge marked it, wrong when none did, split otherwise, and refuses an unlabeled one", () => {
    const labels = readLabels(store([{ id: "a", ref: "r", engine: "opus", mark: true }, { id: "a", ref: "r", engine: "sol", mark: true }, { id: "a", ref: "s", engine: "opus", mark: true }, { id: "a", ref: "s", engine: "sol", mark: false }, { id: "a", ref: "t", engine: "opus", mark: false }, { id: "a", ref: "t", engine: "sol", mark: false }]));
    const rows = [{ id: "a", shown: ["r", "s", "t"] }];
    expect(withLabels(rows, labels, ["opus", "sol"])[0].judged).toEqual(["right", "split", "wrong"]);
    expect(withLabels(rows, labels, ["opus"])[0].judged).toEqual(["right", "right", "wrong"]);
    expect(withLabels(rows, labels, ["sol"])[0].judged).toEqual(["right", "wrong", "wrong"]);
    expect(() => withLabels([{ id: "a", shown: ["u"] }], labels, ["opus", "sol"])).toThrow(/a u has no opus \+ sol label/);
  });

  it("a set whose manifest names judges needs --labels, --judge and the judge's hash in the pre-registration before any score", () => {
    const REAL = join(BENCH, "scripts", "recall-sets.real-v1.json");
    const real = JSON.parse(readFileSync(REAL, "utf8"));
    const { dir, base, arm } = repo();
    mkdirSync(join(dir, "sets"));
    for (const name of ["tuning-opus", "tuning-sol"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, `${name}.json`), "{}");
    }
    const files = { ...pins(), tuning: real.tuning.hash, heldOut: real["held-out"].hash };
    const sides = { "tuning-opus": real["tuning-opus"].hash, "tuning-sol": real["tuning-sol"].hash };
    writeFileSync(join(dir, "ledger.json"), JSON.stringify({ bench: { prereg: [{ id: "p", files, sides }] } }));
    const spec = { name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "fair", sha: arm("server/memory-lookup.ts") }] };
    const bare = run(dir, spec, ["--manifest", REAL]);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("judge fires by row labels: pass --labels");
    writeFileSync(join(dir, "judge.mjs"), "// judge\n");
    const judged = ["--manifest", REAL, "--labels", join(dir, "row-labels.jsonl"), "--judge", join(dir, "judge.mjs")];
    expect(run(dir, spec, judged).stderr).toContain("names files.judgeHash undefined");
    writeFileSync(join(dir, "ledger.json"), JSON.stringify({ bench: { prereg: [{ id: "p", files: { ...files, judgeHash: fileHash(join(dir, "judge.mjs")) }, sides }] } }));
    const out = run(dir, spec, judged);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("scorer failed");
  });
});
