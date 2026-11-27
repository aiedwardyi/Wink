// Offline recall tourney: spec -> one worktree per arm at a frozen sha -> scripts/recall-bench.ts -> scripts/sim-rule.mjs ->
// result.json, and on held-out a pick-ledger entry. The scorer, sets and rule run from this checkout; an arm may only change app code.
// node scripts/sim-tourney.mjs <spec.json> --sets <dir> --ledger <ledger.mjs> [--on held-out|tuning] [--out <dir>] [--repo <dir>] [--keep]
// spec: { name, base, prereg, arms: [{ name, sha } | { name, patch }, ...] }, exactly one arm with sham: true
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { judge, RULE } from "./sim-rule.mjs";

const BENCH = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const LOCKED = ["scripts/recall-bench.", "scripts/recall-sets.", "scripts/sim-rule.", "scripts/sim-tourney."];
export const USES = 3;
const PARITY = 100;

export const lockedIn = (paths) => paths.filter((path) => LOCKED.some((prefix) => path.startsWith(prefix)));
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
export const armDiff = (repo, base, sha) => lines(git(repo, "diff", "--name-only", base, sha));
// CRLF checkouts hash the same as the committed file
export const fileHash = (path) => createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex");

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};

function lockCheck(name, paths) {
  const hit = lockedIn(paths);
  if (hit.length) refuse(`bench lock: arm ${name} touches ${hit.join(", ")}. Arms change app code only; the scorer, sets and rule are frozen on the bench.`);
}

function worktree(repo, dir, sha) {
  git(repo, "worktree", "add", "--detach", "--quiet", dir, sha);
  const modules = join(repo, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, join(dir, "node_modules"), "junction");
}

function dropWorktree(repo, dir) {
  // unlink the junction first, so removing the worktree never walks into the shared node_modules
  if (existsSync(join(dir, "node_modules"))) unlinkSync(join(dir, "node_modules"));
  git(repo, "worktree", "remove", "--force", dir);
}

function score(root, on, sets, out, parity) {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(BENCH, "scripts", "recall-bench.ts"), "--root", root, "--sets", sets, "--set", on, "--out", out, "--parity", String(parity)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (run.status !== 0) refuse(`scorer failed on ${root}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

export function tourney({ spec, on = "held-out", sets, ledger, out = join(sets, "..", "runs"), repo = BENCH, keep = false, today = new Date().toLocaleDateString("sv-SE") }) {
  if (!["held-out", "tuning"].includes(on)) refuse(`--on is held-out or tuning, not ${on}`);
  if (!spec.name || !spec.base || !spec.prereg || !Array.isArray(spec.arms) || !spec.arms.length) refuse("spec needs name, base, prereg and arms");
  if (spec.arms.filter((arm) => arm.sham).length !== 1) refuse("spec needs exactly one sham arm");
  if (new Set(spec.arms.map((arm) => arm.name)).size !== spec.arms.length || spec.arms.some((arm) => !/^[\w-]+$/.test(arm.name ?? "") || arm.name === "base")) refuse("arm names must be unique words, not base");
  const base = git(repo, "rev-parse", `${spec.base}^{commit}`);
  const arms = spec.arms.map((arm) => {
    if (arm.sha) {
      const sha = git(repo, "rev-parse", `${arm.sha}^{commit}`);
      const diff = armDiff(repo, base, sha);
      lockCheck(arm.name, diff);
      return { ...arm, sha, diff };
    }
    if (!arm.patch) refuse(`arm ${arm.name} needs a sha or a patch`);
    const patch = resolve(arm.patch);
    lockCheck(arm.name, lines(git(repo, "apply", "--numstat", patch)).map((line) => line.split("\t")[2]));
    return { ...arm, patch };
  });

  const ledgerJson = join(dirname(resolve(ledger)), "ledger.json");
  const ruleHash = fileHash(join(BENCH, "scripts", "sim-rule.mjs"));
  const filed = existsSync(ledgerJson) ? (JSON.parse(readFileSync(ledgerJson, "utf8")).bench?.prereg ?? []) : [];
  const prereg = filed.find((entry) => entry.id === spec.prereg);
  if (!prereg) refuse(`no pre-registration ${spec.prereg} in ${ledgerJson}: file the rule first with node ledger.mjs prereg <file.json>`);
  const newer = filed.find((entry) => entry.supersedes === spec.prereg);
  if (newer) refuse(`pre-registration ${spec.prereg} is superseded by ${newer.id}: name ${newer.id} in the spec`);
  if (prereg.files?.ruleHash !== ruleHash) refuse(`pre-registration ${spec.prereg} names rule sha256 ${prereg.files?.ruleHash}, but scripts/sim-rule.mjs is ${ruleHash}: a changed rule needs a new pre-registration`);

  const manifest = JSON.parse(readFileSync(join(BENCH, "scripts", "recall-sets.json"), "utf8"));
  const hash = manifest[on]?.hash;
  const usesFile = join(sets, "uses.json");
  const uses = existsSync(usesFile) ? JSON.parse(readFileSync(usesFile, "utf8")) : {};
  const used = uses[hash] ?? [];
  if (on === "held-out") {
    if (used.length >= USES) refuse(`held-out ${hash.slice(0, 12)} has had ${used.length} runs: reseed it (recall-sets.ts make <sets> --reseed) and file a new pre-registration`);
    const seen = new Set(used.flatMap((run) => run.arms.filter((arm) => !arm.sham).map((arm) => arm.sha)));
    for (const arm of arms) if (arm.sha && !arm.sham && seen.has(arm.sha)) refuse(`arm ${arm.name} ${arm.sha.slice(0, 9)} already had its held-out run on this set`);
  }

  const run = `${spec.name}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  const dir = join(resolve(out), run);
  mkdirSync(join(dir, "wt"), { recursive: true });
  const trees = [];
  try {
    const tree = (name, sha) => {
      const path = join(dir, "wt", name);
      worktree(repo, path, sha);
      trees.push(path);
      return path;
    };
    const baseRoot = tree("base", base);
    const ready = arms.map((arm) => {
      if (!arm.patch) return { ...arm, root: tree(arm.name, arm.sha) };
      const root = tree(arm.name, base);
      git(root, "apply", "--whitespace=nowarn", arm.patch);
      git(root, "add", "-A");
      git(root, "-c", "user.name=sim-tourney", "-c", "user.email=sim-tourney@localhost", "commit", "--quiet", "--no-verify", "-m", `arm ${arm.name}`);
      const sha = git(root, "rev-parse", "HEAD");
      git(repo, "update-ref", `refs/sim-tourney/${run}/${arm.name}`, sha);
      const diff = armDiff(repo, base, sha);
      lockCheck(arm.name, diff);
      return { ...arm, sha, diff, root };
    });
    const baseScore = score(baseRoot, on, sets, join(dir, "base.json"), PARITY);
    if (baseScore.parity.mismatches || baseScore.parity.checked < Math.min(PARITY, baseScore.totals.cases)) refuse(`bench parity ${baseScore.parity.checked - baseScore.parity.mismatches}/${baseScore.parity.checked} with the base lookup: the scorer no longer reads the real pick`);
    const scored = ready.map((arm) => ({ ...arm, score: score(arm.root, on, sets, join(dir, `${arm.name}.json`), 0) }));
    const round = judge({ base: baseScore.rows, arms: scored.map((arm) => ({ name: arm.name, sham: arm.sham, rows: arm.score.rows })) });
    const result = {
      run,
      date: today,
      on,
      set: { name: on, hash, use: on === "held-out" ? used.length + 1 : null, of: USES },
      prereg: spec.prereg,
      bench: git(BENCH, "rev-parse", "HEAD"),
      ruleHash,
      rule: RULE,
      base: { sha: base, totals: baseScore.totals, parity: baseScore.parity, lookupMs: baseScore.lookupMs },
      void: round.void,
      arms: scored.map((arm, at) => ({ name: arm.name, sham: Boolean(arm.sham), sha: arm.sha, patch: arm.patch, diff: arm.diff, totals: arm.score.totals, lookupMs: arm.score.lookupMs, ...round.arms[at] })),
    };
    writeFileSync(join(dir, "result.json"), `${JSON.stringify(result, null, 1)}\n`);
    if (on === "held-out") {
      uses[hash] = [...used, { run, date: today, arms: result.arms.map(({ name, sham, sha }) => ({ name, sham, sha })) }];
      writeFileSync(usesFile, `${JSON.stringify(uses, null, 1)}\n`);
      execFileSync(process.execPath, [resolve(ledger), "tourney", join(dir, "result.json")], { stdio: "inherit" });
    }
    return { dir, result };
  } finally {
    if (!keep) for (const path of trees.reverse()) dropWorktree(repo, path);
  }
}

const line = (result) => [
  `${result.run} on ${result.on} ${result.set.hash.slice(0, 12)}${result.set.use ? ` (use ${result.set.use}/${result.set.of})` : ""}, base ${result.base.sha.slice(0, 9)} ${result.base.totals.hits}/${result.base.totals.positives}, parity ${result.base.parity.checked - result.base.parity.mismatches}/${result.base.parity.checked}${result.void ? ", VOID: the sham won" : ""}`,
  ...result.arms.map((arm) => `  ${arm.name}${arm.sham ? " (sham)" : ""} ${arm.sha.slice(0, 9)}: ${arm.hits}/${arm.of} (b ${arm.b}, c ${arm.c}, gain ${(arm.gain * 100).toFixed(1)} pts, p ${arm.p.toPrecision(3)}, Holm ${arm.pHolm.toPrecision(3)}), guards: wrong-scope ${arm.guards.wrongScope}, superseded ${arm.guards.superseded}, must-hold ${arm.guards.mustHold}, new false recall ${arm.guards.falseRecall} (shown on ${arm.totals.falseRecall}/${arm.totals.misses}) -> ${arm.verdict}`),
].join("\n");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: opt, positionals: [specFile] } = parseArgs({ allowPositionals: true, options: { on: { type: "string", default: "held-out" }, sets: { type: "string" }, ledger: { type: "string" }, out: { type: "string" }, repo: { type: "string" }, keep: { type: "boolean", default: false } } });
  try {
    if (!specFile) refuse("usage: node scripts/sim-tourney.mjs <spec.json> --sets <dir> --ledger <ledger.mjs> [--on held-out|tuning] [--out <dir>] [--repo <dir>] [--keep]");
    const spec = JSON.parse(readFileSync(specFile, "utf8"));
    // a spec's patch paths are relative to the spec
    for (const arm of spec.arms ?? []) if (arm.patch) arm.patch = resolve(dirname(specFile), arm.patch);
    const { dir, result } = tourney({ spec, on: opt.on, sets: opt.sets ?? refuse("--sets <dir> is required"), ledger: opt.ledger ?? refuse("--ledger <ledger.mjs> is required"), out: opt.out, repo: opt.repo ? resolve(opt.repo) : undefined, keep: opt.keep });
    console.log(line(result));
    console.log(join(dir, "result.json"));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
