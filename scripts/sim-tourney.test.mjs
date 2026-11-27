import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { armDiff, fileHash, LOCKED, lockedIn } from "./sim-tourney.mjs";

const TOURNEY = fileURLToPath(new URL("./sim-tourney.mjs", import.meta.url));
const BENCH = fileURLToPath(new URL("..", import.meta.url));
const temps = [];
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

describe("held-out safety", () => {
  const fair = (dir, base, arm) => ({ name: "t", base, prereg: "p", arms: [{ name: "sham", sham: true, sha: base }, { name: "fair", sha: arm("server/memory-lookup.ts") }] });

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
});

describe("pre-registration pins the bench", () => {
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
