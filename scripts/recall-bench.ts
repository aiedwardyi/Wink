// Recall bench scorer (from scripts/recall-rank-sweep.ts): every case of a frozen set through one checkout's real lookup, top-2
// rows read from its lookup log and judged against the known answer. --parity N also replays the first N cases through the
// index, gate and the review-base pick, and counts where the real lookup differs. Writes only to a temp HOME and data dir.
// node --experimental-strip-types scripts/recall-bench.ts --root <checkout> --sets <dir> --set <name> --out <json> [--parity N]
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { NoteFile, RecallHit } from "../server/memory-lookup.ts";
import { type Case, judgeCase, MANIFEST, sha256 } from "./recall-sets.ts";

const { values: opt } = parseArgs({ options: { root: { type: "string" }, sets: { type: "string" }, set: { type: "string" }, out: { type: "string" }, parity: { type: "string", default: "0" }, manifest: { type: "string", default: MANIFEST } } });
if (!opt.root || !opt.sets || !opt.set || !opt.out) throw new Error("usage: recall-bench.ts --root <checkout> --sets <dir> --set <name> --out <json> [--parity N]");
const root = resolve(opt.root);
const MAX_ROWS = 2;
const MAX_CHARS = 1_400;

const text = readFileSync(join(opt.sets, `${opt.set}.json`), "utf8");
// SAFETY: recall-sets.ts writes the manifest as set name -> { hash, ... }
const want = (JSON.parse(readFileSync(opt.manifest, "utf8")) as Record<string, { hash: string } | undefined>)[opt.set]?.hash;
const hash = sha256(text);
if (hash !== want) throw new Error(`set ${opt.set} hash ${hash} is not the manifest's ${want ?? "(none)"}: sets are frozen; remake them only with recall-sets.ts --reseed`);
// SAFETY: the bytes match the manifest hash, so this is the file setFile() wrote
const set = JSON.parse(text) as { anchor: string; cases: Case[] };
const noon = Date.parse(`${set.anchor}T12:00:00Z`);

const temp = mkdtempSync(join(tmpdir(), "recall-bench-"));
// before any server module loads: its data dir and home are read at import
process.env.HOME = process.env.USERPROFILE = temp;
process.env.OMB_DATA_DIR = join(temp, "data");
const from = (path: string) => pathToFileURL(join(root, path)).href;
// SAFETY: --root is a checkout of this repo, so its server modules have these exports; an arm that drops one fails at the call
const [{ buildRecallIndex, createMemoryLookup, searchable }, { userTyping }, { DATA_DIR }] = (await Promise.all([import(from("server/memory-lookup.ts")), import(from("server/memory-pass.ts")), import(from("server/config.ts"))])) as [
  typeof import("../server/memory-lookup.ts"),
  typeof import("../server/memory-pass.ts"),
  typeof import("../server/config.ts"),
];

const put = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  // rows without a date take the file's day, so files carry the set's anchor
  utimesSync(path, noon / 1000, noon / 1000);
};

function seed(item: Case) {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const workspace = join(DATA_DIR, "workspaces", item.bot);
  for (const [name, body] of Object.entries(item.files)) if (name !== "notes.md") put(join(workspace, name), body);
  for (const [name, body] of Object.entries(item.otherFiles)) put(join(DATA_DIR, "workspaces", item.other, name), body);
  const notes = join(DATA_DIR, "notes.md");
  put(notes, item.files["notes.md"]!);
  return { workspace, notes };
}

// the review-base pick after the gate: a topic's first passed row, tier first, then the caps
function pick(passed: RecallHit[]): RecallHit[] {
  const newest = new Map<string, RecallHit>();
  for (const hit of passed) if (!newest.has(hit.topic)) newest.set(hit.topic, hit);
  const picked: RecallHit[] = [];
  let chars = 0;
  for (const hit of [...newest.values()].sort((a, b) => a.tier - b.tier)) {
    if (picked.length === MAX_ROWS || chars + hit.text.length > MAX_CHARS) break;
    picked.push(hit);
    chars += hit.text.length;
  }
  return picked;
}

async function replay(item: Case, workspace: string, notes: string) {
  const sources = readdirSync(join(workspace, "memory")).map((name) => `memory/${name}`).sort();
  const files: NoteFile[] = [
    ...sources.map((source) => ({ source, tier: 0 as const, text: readFileSync(join(workspace, source), "utf8"), mtime: statSync(join(workspace, source)).mtimeMs })),
    { source: "notes.md", tier: 1, text: readFileSync(notes, "utf8"), mtime: statSync(notes).mtimeMs },
  ];
  const index = await buildRecallIndex(files);
  const terms = index.terms(searchable(userTyping(item.ask, false)), undefined, "");
  const passed = index.possible(terms) ? index.gate(terms, index.hits(terms)) : [];
  index.close();
  return pick(passed).map((hit) => hit.ref);
}

const settle = async () => {
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
};
const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;

try {
  const parity = Number(opt.parity);
  const rows: Array<{ id: string; kind: Case["kind"]; family: number; shown: string[] } & ReturnType<typeof judgeCase>> = [];
  const ms: number[] = [];
  const mismatched: string[] = [];
  for (const [at, item] of set.cases.entries()) {
    const { workspace, notes } = seed(item);
    const lookup = createMemoryLookup({ dataDir: DATA_DIR, notesPath: () => notes, now: () => noon });
    await lookup.refresh(item.bot);
    const started = performance.now();
    lookup.take(item.bot, "t", undefined, item.ask);
    ms.push(performance.now() - started);
    await settle();
    // SAFETY: the lookup writes one JSON row per take, and the data dir is new for each case
    const entry = JSON.parse(readFileSync(join(DATA_DIR, "lookup-log.jsonl"), "utf8").trim().split("\n")[0]!) as { fired: boolean; rows: Array<{ row: string }> };
    const shown = entry.fired ? entry.rows.map((row) => row.row) : [];
    if (at < parity && JSON.stringify(await replay(item, workspace, notes)) !== JSON.stringify(shown)) mismatched.push(item.id);
    rows.push({ id: item.id, kind: item.kind, family: item.family, shown, ...judgeCase(item, shown) });
    if ((at + 1) % 250 === 0) console.error(`${opt.set}: ${at + 1}/${set.cases.length}`);
  }
  const of = (kind: Case["kind"]) => rows.filter((row) => row.kind === kind);
  const totals = {
    cases: rows.length,
    positives: of("positive").length,
    hits: of("positive").filter((row) => row.hit).length,
    misses: of("miss").length,
    falseRecall: of("miss").filter((row) => row.shown.length).length,
    guards: of("guard").length,
    guardHits: of("guard").filter((row) => row.hit).length,
    wrongScope: rows.filter((row) => row.wrongScope).length,
    superseded: rows.filter((row) => row.superseded).length,
    stale: rows.filter((row) => row.stale).length,
  };
  const out = { set: opt.set, hash, root, parity: { checked: Math.min(parity, rows.length), mismatches: mismatched.length }, mismatched, totals, lookupMs: { p50: Number(pct(ms, 0.5).toFixed(3)), p95: Number(pct(ms, 0.95).toFixed(3)) }, rows };
  writeFileSync(opt.out, `${JSON.stringify(out)}\n`);
  console.log(JSON.stringify({ ...out, rows: undefined }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
