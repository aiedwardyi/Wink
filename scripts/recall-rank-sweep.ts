// Recall rank sweep: seeded note copies with known answer rows, through the real index, gate and pick, with the near-tie band
// swept, inside which the newest row leads. Train picks the band; held-out (fresh topics, similar distractors, no-match asks)
// scores it against the app's own pick. Notes are synthetic; writes only to a temp folder, used as HOME and data dir.
// node --experimental-strip-types scripts/recall-rank-sweep.ts [--json <summary.json>]
// Wrong scope: another bot's copy of the rows. Superseded: an older row under the answer's own label. Stale: an older value
// written another way, which only ranking can push down. A no-match ask shows nothing or is a false recall.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { NoteFile, RecallHit } from "../server/memory-lookup.ts";

const temp = mkdtempSync(join(tmpdir(), "recall-rank-sweep-"));
const root = join(temp, "kit");
// before any server module loads: its data dir and home are read at import
process.env.HOME = process.env.USERPROFILE = temp;
process.env.OMB_DATA_DIR = join(root, "arms", "cued-after", "data");
const { buildRecallIndex, createMemoryLookup, NEAR_TIE, rankHits, searchable } = await import("../server/memory-lookup.ts");
const { userTyping } = await import("../server/memory-pass.ts");
const { DATA_DIR } = await import("../server/config.ts");
const { prepareArm } = await import("./dream-practice.ts");

const json = process.argv.indexOf("--json");
const DAY = 86_400_000;
const MAX_ROWS = 2;
const MAX_CHARS = 1_400;
const TIES = [0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];
const REPS = 20;
// rows of unrelated notes per file, two files: a modest bot's notes, so a word in a handful of rows is rare
const FILLER = 150;

const localDay = (at: number) => new Date(at).toLocaleDateString("sv-SE");
const today = localDay(Date.now());
const ago = (days: number) => localDay(Date.parse(`${today}T12:00:00`) - days * DAY);
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

type Pool = { name: string; seed: number; scopes: string[]; subjects: string[]; absent: string[]; positives: number; misses: number };
const TRAIN: Pool = {
  name: "train",
  seed: 11,
  positives: 40,
  misses: 20,
  scopes: ["atlas", "beacon", "cobalt", "dorado", "ember", "fjord", "garnet", "helix"],
  subjects: ["deploy window", "backup drive", "standup slot", "review owner", "launch city", "budget cap", "test device", "support inbox"],
  absent: ["payroll export", "wedding playlist", "tax receipts", "gym schedule", "garage door", "piano lesson"],
};
const HELD: Pool = {
  name: "held-out",
  seed: 23,
  positives: 20,
  misses: 20,
  scopes: ["juniper", "kestrel", "lumen", "mosaic", "nimbus", "orchid", "quartz", "raven"],
  subjects: ["release train", "invoice day", "demo room", "oncall phone", "print vendor", "build server", "style guide", "pricing page"],
  absent: ["dentist visit", "camping gear", "birthday cake", "car insurance", "flight upgrade", "yoga class"],
};
const VALUES = ["Tuesday morning", "Thursday noon", "Friday evening", "the east studio", "the small loft", "the blue rack", "the spare laptop", "the team handset", "the vendor in town", "the corner shop", "the grey tower", "the second floor", "Monday at ten", "the north desk"];
const NOISE = ["lunch", "harvest", "mural", "ticket", "garden", "parcel", "kiosk", "lantern", "meadow", "pebble", "quilt", "saddle", "tulip", "violin", "walnut", "yarn", "zinc", "anchor", "bramble", "canyon", "dune", "falcon", "glacier", "hazel", "island", "jasmine", "kayak", "lagoon"];

type Case = { id: string; kind: "positive" | "miss"; bot: string; other: string; files: Record<string, string>; otherFiles: Record<string, string>; ask: string; answer: string; superseded: string; stale: string[] };

function cases(pool: Pool): Case[] {
  const r = random(pool.seed);
  const noise = (count: number) => Array.from({ length: count }, () => r.one(NOISE)).join(" ");
  // every seeded row, the answer too, draws the same extra words, so length tells nothing
  const context = (row: string) => {
    const count = r.int(0, 8);
    return count ? `${row}, ${noise(count)}` : row;
  };
  const filler = () => Array.from({ length: FILLER }, (_, n) => (n % 7 === 0 ? `- ${cap(r.one(NOISE))} ${r.one(NOISE)}: ${noise(r.int(3, 8))} (${ago(r.int(1, 300))})` : `- ${cap(noise(r.int(4, 10)))}`)).join("\n");
  const made: Case[] = [];
  for (let n = 0; n < pool.positives + pool.misses; n++) {
    const kind = n < pool.positives ? "positive" : "miss";
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
    const superseded = context(`- ${cap(scope)} ${subject}: ${r.one(VALUES)}, set ${ago(answerAge + r.int(10, 200))}`);
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
    const otherFiles = { [`memory/${scope}-team.md`]: `# ${cap(scope)}\n\n- ${cap(scope)} ${subject}: ${r.one(VALUES)}, confirmed ${ago(1)}\n` };
    const missing = r.one(pool.absent);
    const ask = kind === "positive"
      ? r.one([`what is the ${scope} ${subject} now`, `remind me the ${subject} for ${scope}`, `${scope} ${subject}?`, `which ${subject} does ${scope} have these days`, `did we settle the ${scope} ${subject}`])
      : r.one([`what is the ${scope} ${missing}`, `can you draft a note about the ${missing}`, `how do I sort out the ${missing} with the ${r.one(subject.split(" "))}`, `write a short poem about the ${missing}`, `any update on the ${missing}`]);
    made.push({ id: `${pool.name}-${n}`, kind, bot: `bot-${pool.name}-${n}`, other: `bot-other-${n}`, files, otherFiles, ask, answer, superseded, stale });
  }
  return made;
}

// the seeded copy, laid out as a practice topic and set up as the cued arm the recall checks run on
function seed(item: Case) {
  const after = join(root, "practice", item.bot, "after");
  rmSync(dirname(after), { recursive: true, force: true });
  for (const [name, text] of Object.entries(item.files)) {
    if (name === "notes.md") continue;
    mkdirSync(dirname(join(after, name)), { recursive: true });
    writeFileSync(join(after, name), text);
  }
  const arm = prepareArm(root, "cued", "after", item.bot, after);
  for (const [name, text] of Object.entries(item.otherFiles)) {
    const path = join(arm.data, "workspaces", item.other, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const notes = join(arm.data, "notes.md");
  writeFileSync(notes, item.files["notes.md"]!);
  return { arm, notes };
}

const refOf = (item: Case, row: string) => {
  for (const [name, text] of Object.entries(item.files)) {
    const at = text.split("\n").indexOf(row);
    if (at >= 0) return `${name}:${at + 1}`;
  }
  throw new Error(`${item.id}: row not seeded`);
};

// the app's pick after the gate, with the near-tie band at tie
function pick(passed: RecallHit[], tie: number): RecallHit[] {
  const newest = new Map<string, RecallHit>();
  for (const hit of rankHits(passed, today, tie)) if (!newest.has(hit.topic)) newest.set(hit.topic, hit);
  const unseen = [...newest.values()];
  const picked: RecallHit[] = [];
  let chars = 0;
  for (const hit of unseen) {
    if (picked.length === MAX_ROWS || chars + hit.text.length > MAX_CHARS) break;
    picked.push(hit);
    chars += hit.text.length;
  }
  return picked;
}

const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

type Scored = { item: Case; passed: RecallHit[]; app: string[]; ms: number[] };
async function score(item: Case): Promise<Scored> {
  const { arm, notes } = seed(item);
  const workspace = join(arm.data, "workspaces", item.bot);
  const sources = readdirSync(join(workspace, "memory")).map((name) => `memory/${name}`).sort();
  const files: NoteFile[] = [
    ...sources.map((source) => ({ source, tier: 0 as const, text: readFileSync(join(workspace, source), "utf8"), mtime: statSync(join(workspace, source)).mtimeMs })),
    { source: "notes.md", tier: 1, text: readFileSync(notes, "utf8"), mtime: statSync(notes).mtimeMs },
  ];
  const index = await buildRecallIndex(files);
  const terms = index.terms(searchable(userTyping(item.ask, false)), undefined, "");
  const passed = index.possible(terms) ? index.gate(terms, index.hits(terms)) : [];
  index.close();

  const lookup = createMemoryLookup({ dataDir: DATA_DIR, notesPath: () => notes });
  await lookup.refresh(item.bot);
  const log = join(DATA_DIR, "lookup-log.jsonl");
  lookup.take(item.bot, "t", undefined, item.ask);
  await settle();
  // SAFETY: the lookup writes one JSON row per take, and this arm's log is new
  const entry = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!) as { fired: boolean; rows: Array<{ row: string }> };
  const app = entry.fired ? entry.rows.map((row) => row.row) : [];
  const ms: number[] = [];
  for (let rep = 0; rep < REPS; rep++) {
    const started = performance.now();
    lookup.take(item.bot, `t${rep}`, undefined, item.ask);
    ms.push(performance.now() - started);
  }
  await settle();
  return { item, passed, app, ms };
}

function tally(rows: Scored[], tie: number) {
  let hits = 0;
  let bad = 0;
  let stale = 0;
  let falseRecall = 0;
  const positives = rows.filter((row) => row.item.kind === "positive");
  for (const { item, passed } of rows) {
    const shown = pick(passed, tie).map((hit) => hit.ref);
    if (item.kind === "miss") {
      if (shown.length) falseRecall++;
      continue;
    }
    if (shown.includes(refOf(item, item.answer))) hits++;
    if (shown.some((ref) => ref === refOf(item, item.superseded) || ref.includes("-team.md:"))) bad++;
    if (shown.some((ref) => item.stale.some((row) => ref === refOf(item, row)))) stale++;
  }
  const crowded = positives.filter((row) => new Set(row.passed.map((hit) => hit.topic)).size > MAX_ROWS).length;
  return { hits, of: positives.length, wrongScopeOrSuperseded: bad, staleShown: stale, falseRecall, misses: rows.length - positives.length, crowded };
}

try {
  const train: Scored[] = [];
  for (const item of cases(TRAIN)) train.push(await score(item));
  const held: Scored[] = [];
  for (const item of cases(HELD)) held.push(await score(item));
  const off = [...train, ...held].filter((row) => JSON.stringify(row.app) !== JSON.stringify(pick(row.passed, NEAR_TIE).map((hit) => hit.ref)));
  if (off.length) throw new Error(`the sweep's pick differs from the app's on ${off.map((row) => row.item.id).join(", ")}`);
  const grid = TIES.map((tie) => ({ tie, train: tally(train, tie), held: tally(held, tie) }));
  const winner = [...grid].sort((a, b) => b.train.hits - a.train.hits || a.train.wrongScopeOrSuperseded - b.train.wrongScopeOrSuperseded || a.train.staleShown - b.train.staleShown || a.tie - b.tie)[0]!;
  const app = { tie: NEAR_TIE, train: tally(train, NEAR_TIE), held: tally(held, NEAR_TIE) };
  const ms = held.flatMap((row) => row.ms);
  const summary = {
    today,
    parity: { cases: train.length + held.length, mismatches: 0 },
    app,
    winner,
    change: winner.tie !== app.tie && winner.held.hits > app.held.hits && winner.held.wrongScopeOrSuperseded === 0 && winner.held.falseRecall === 0,
    lookupMs: { p50: Number(pct(ms, 0.5).toFixed(3)), p95: Number(pct(ms, 0.95).toFixed(3)), max: Number(Math.max(...ms).toFixed(3)) },
    grid,
  };
  if (json > 0 && process.argv[json + 1]) writeFileSync(process.argv[json + 1]!, `${JSON.stringify(summary, null, 1)}\n`);
  const line = (side: ReturnType<typeof tally>) => `${side.hits}/${side.of} bad ${side.wrongScopeOrSuperseded} stale ${side.staleShown} false ${side.falseRecall}/${side.misses} crowded ${side.crowded}`;
  console.log(JSON.stringify({ ...summary, grid: grid.map((row) => `${row.tie}: train ${line(row.train)} | held ${line(row.held)}`) }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
