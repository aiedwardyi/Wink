// Frozen recall sets for the bench (scripts/sim-tourney.mjs): seeded synthetic note copies with known answer rows, from the
// recall-rank-sweep generator. Rows are dated off a fixed anchor so a set is the same bytes on any day; hashes live in recall-sets.json.
// The held-out pool (seed and words) and both set files stay outside the repo; only the tuning pool is here.
// node --experimental-strip-types scripts/recall-sets.ts make <sets dir> [--reseed]
import { createHash, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MANIFEST = fileURLToPath(new URL("./recall-sets.json", import.meta.url));
export const ANCHOR = "2026-11-27";
const DAY = 86_400_000;

export type Pool = { name: string; seed: number; anchor: string; scopes: string[]; subjects: string[]; absent: string[]; positives: number; misses: number; guards: number };
export type Case = {
  id: string;
  kind: "positive" | "miss" | "guard";
  family: number;
  bot: string;
  other: string;
  files: Record<string, string>;
  otherFiles: Record<string, string>;
  ask: string;
  answer: string;
  superseded: string;
  stale: string[];
  /** real-traffic sets: every judged answer row's ref, the turn's time, and the notes as of it by name in the set's snapshots */
  answers?: string[];
  at?: number;
  snapshot?: string;
};

export const TUNING: Pool = {
  name: "tuning",
  seed: 11,
  anchor: ANCHOR,
  positives: 800,
  misses: 500,
  guards: 200,
  scopes: ["atlas", "beacon", "cobalt", "dorado", "ember", "fjord", "garnet", "helix", "indigo", "jetty", "krypton", "larch", "marlin", "nectar", "onyx", "pylon", "quasar", "rhombus", "sierra", "tundra", "umber", "vortex", "willow", "xenon"],
  subjects: ["deploy window", "backup drive", "standup slot", "review owner", "launch city", "budget cap", "test device", "support inbox", "release notes", "vendor contract", "staging server", "travel budget", "design review", "hiring panel", "office printer", "sprint length", "metrics dashboard", "legal contact", "chat channel", "shipping carrier", "color palette", "code freeze", "offsite venue", "data retention"],
  absent: ["payroll export", "wedding playlist", "tax receipts", "gym schedule", "garage door", "piano lesson", "pet groomer", "ski rental", "book club", "plumbing quote"],
};

const VALUES = ["Tuesday morning", "Thursday noon", "Friday evening", "the east studio", "the small loft", "the blue rack", "the spare laptop", "the team handset", "the vendor in town", "the corner shop", "the grey tower", "the second floor", "Monday at ten", "the north desk"];
const NOISE = ["lunch", "harvest", "mural", "ticket", "garden", "parcel", "kiosk", "lantern", "meadow", "pebble", "quilt", "saddle", "tulip", "violin", "walnut", "yarn", "zinc", "anchor", "bramble", "canyon", "dune", "falcon", "glacier", "hazel", "island", "jasmine", "kayak", "lagoon"];
// rows of unrelated notes per file, two files: a modest bot's notes, so a word in a handful of rows is rare
const FILLER = 150;
const cap = (word: string) => word[0]!.toUpperCase() + word.slice(1);

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const one = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  return { next, int, one };
}

export function cases(pool: Pool): Case[] {
  const r = random(pool.seed);
  const ago = (days: number) => new Date(Date.parse(`${pool.anchor}T12:00:00Z`) - days * DAY).toISOString().slice(0, 10);
  const noise = (count: number) => Array.from({ length: count }, () => r.one(NOISE)).join(" ");
  // every seeded row, the answer too, draws the same extra words, so length tells nothing
  const context = (row: string) => {
    const count = r.int(0, 8);
    return count ? `${row}, ${noise(count)}` : row;
  };
  const filler = () => Array.from({ length: FILLER }, (_, n) => (n % 7 === 0 ? `- ${cap(r.one(NOISE))} ${r.one(NOISE)}: ${noise(r.int(3, 8))} (${ago(r.int(1, 300))})` : `- ${cap(noise(r.int(4, 10)))}`)).join("\n");
  const kinds: Case["kind"][] = [...Array<Case["kind"]>(pool.positives).fill("positive"), ...Array<Case["kind"]>(pool.misses).fill("miss"), ...Array<Case["kind"]>(pool.guards).fill("guard")];
  for (let at = kinds.length - 1; at > 0; at--) {
    const swap = Math.floor(r.next() * (at + 1));
    [kinds[at], kinds[swap]] = [kinds[swap]!, kinds[at]!];
  }
  return kinds.map((kind, n) => {
    const scope = pool.scopes[n % pool.scopes.length]!;
    const subject = pool.subjects[(Math.floor(n / pool.scopes.length) + n) % pool.subjects.length]!;
    const other = r.one(pool.scopes.filter((each) => each !== scope));
    const answerAge = r.int(2, 120);
    const own: string[] = [];
    const others: string[] = [];
    const stale: string[] = [];
    const answer = context(r.one([
      `- ${cap(scope)} ${subject}: ${r.one(VALUES)}, confirmed ${ago(answerAge)}`,
      `- ${cap(scope)} ${subject}: ${r.one(VALUES)} from ${ago(answerAge)} on`,
      `- ${cap(scope)} ${subject}: now ${r.one(VALUES)} (${ago(answerAge)})`,
    ]));
    // a guard item's older value repeats the ask's words, so only the newest-per-label rule keeps it out
    const superseded = kind === "guard"
      ? `- ${cap(scope)} ${subject}: ${r.one(VALUES)}, set ${ago(answerAge + r.int(10, 200))}, the ${scope} ${subject} we settled`
      : context(`- ${cap(scope)} ${subject}: ${r.one(VALUES)}, set ${ago(answerAge + r.int(10, 200))}`);
    own.push(superseded, answer);
    for (let left = r.int(3, 6); left > 0; left--) {
      const roll = r.next();
      if (roll < 0.35) {
        const row = context(r.one([
          `- Moved the ${scope} ${subject} to ${r.one(VALUES)} after the ${noise(2)} (${ago(answerAge + r.int(5, 200))})`,
          `- ${cap(scope)} first used ${r.one(VALUES)} for the ${subject}, ${ago(answerAge + r.int(5, 200))}`,
          `- Old plan for the ${scope} ${subject} was ${r.one(VALUES)} (${ago(answerAge + r.int(5, 200))})`,
        ]));
        own.push(row);
        stale.push(row);
      } else if (roll < 0.75) {
        own.push(context(r.one([
          `- ${cap(scope)} ${subject} checklist: ${noise(r.int(2, 6))} before each run (${ago(r.int(1, 240))})`,
          `- Asked who keeps the ${scope} ${subject} notes, ${noise(r.int(1, 4))} (${ago(r.int(1, 240))})`,
          `- ${cap(scope)} ${subject} came up in the ${noise(1)} review, no change (${ago(r.int(1, 240))})`,
        ])));
      } else {
        others.push(context(`- ${cap(other)} ${subject}: ${r.one(VALUES)} (${ago(r.int(1, 240))})`));
      }
    }
    // a random order, so the answer's line tells nothing
    own.sort(() => r.next() - 0.5);
    const files = {
      "MEMORY.md": `# Memory\n\n- Prefers short replies\n- ${cap(scope)} details: memory/${scope}.md, read before ${scope} work\n`,
      [`memory/${scope}.md`]: `# ${cap(scope)}\n\n${own.join("\n")}\n`,
      "memory/misc.md": `# Misc\n\n${filler()}\n`,
      "notes.md": `# Notes\n\n${filler()}\n`,
      [`memory/${other}.md`]: `# ${cap(other)}\n\n${others.join("\n")}\n`,
    };
    // another bot's copy, newest of all: lookup is per bot, so a row from it is wrong scope
    const otherFiles = { [`memory/${scope}-team.md`]: `# ${cap(scope)}\n\n- ${cap(scope)} ${subject}: ${r.one(VALUES)}, confirmed ${ago(1)}${kind === "guard" ? `, the ${scope} ${subject} we settled` : ""}\n` };
    const missing = r.one(pool.absent);
    const family = r.int(0, 4);
    const ask = kind === "miss"
      ? [`what is the ${scope} ${missing}`, `can you draft a note about the ${missing}`, `how do I sort out the ${missing} with the ${r.one(subject.split(" "))}`, `write a short poem about the ${missing}`, `any update on the ${missing}`][family]!
      : [`what is the ${scope} ${subject} now`, `remind me the ${subject} for ${scope}`, `${scope} ${subject}?`, `which ${subject} does ${scope} have these days`, `did we settle the ${scope} ${subject}`][family]!;
    return { id: `${pool.name}-${n}`, kind, family, bot: `bot-${pool.name}-${n}`, other: `bot-other-${n}`, files, otherFiles, ask, answer, superseded, stale };
  });
}

export const setFile = (pool: Pool) => `${JSON.stringify({ name: pool.name, anchor: pool.anchor, counts: { positives: pool.positives, misses: pool.misses, guards: pool.guards }, cases: cases(pool) })}\n`;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export const refOf = (item: Case, row: string) => {
  for (const [name, text] of Object.entries(item.files)) {
    const at = text.split("\n").indexOf(row);
    if (at >= 0) return `${name}:${at + 1}`;
  }
  throw new Error(`${item.id}: row not seeded`);
};

/** What the rows a lookup showed mean for this case; a no-match ask is judged by whether anything showed. */
export function judgeCase(item: Case, shown: string[]) {
  const want = item.kind === "miss" ? [] : (item.answers ?? [refOf(item, item.answer)]);
  return {
    hit: shown.some((ref) => want.includes(ref)),
    wrongScope: shown.some((ref) => ref.includes("-team.md:")),
    superseded: item.kind !== "miss" && Boolean(item.superseded) && shown.includes(refOf(item, item.superseded)),
    stale: item.stale.some((row) => shown.includes(refOf(item, row))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, dir] = process.argv.slice(2);
  if (command !== "make" || !dir) throw new Error("usage: node --experimental-strip-types scripts/recall-sets.ts make <sets dir> [--reseed]");
  const reseed = process.argv.includes("--reseed");
  const poolFile = join(dir, "held-out.pool.json");
  if (!existsSync(poolFile)) throw new Error(`${poolFile} is missing: write the held-out pool (name, anchor, counts, scopes, subjects, absent) there first`);
  // SAFETY: the pool file is written by hand once in the Pool shape, and only this command rewrites it
  const held = JSON.parse(readFileSync(poolFile, "utf8")) as Pool;
  if (reseed || !held.seed) {
    held.seed = randomInt(1, 2 ** 31);
    writeFileSync(poolFile, `${JSON.stringify(held, null, 1)}\n`);
  }
  const manifest: Record<string, { hash: string; cases: number; positives: number; misses: number; guards: number; anchor: string }> = reseed ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
  for (const pool of reseed ? [held] : [TUNING, held]) {
    const path = join(dir, `${pool.name}.json`);
    if (existsSync(path) && !reseed) throw new Error(`${path} exists: sets are made once; --reseed makes a fresh held-out set`);
    const text = setFile(pool);
    writeFileSync(path, text);
    manifest[pool.name] = { hash: sha256(text), cases: pool.positives + pool.misses + pool.guards, positives: pool.positives, misses: pool.misses, guards: pool.guards, anchor: pool.anchor };
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(JSON.stringify(manifest, null, 1));
}
