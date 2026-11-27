// The idle tidy ("sleep"): once a bot has been quiet a while, two judges of different makers flag repeats, replaced notes and
// past one-offs, and a line both flag that passes the code gates moves into memory/dreamed.md, where recall still finds it.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { renameRetrying, writeFileAtomic } from "./atomic.ts";
import { anchored, DREAMED_FILE, DREAMED_HEAD, dreamedEntry, dreamedKeys, dreamedPath, markUndone, putBack, type ArchivedMove } from "./dream-archive.ts";
import { agreed, dreamPrompt, parseDream, planDream, type DreamJudges, type Flag } from "./dream-judge.ts";
import { decisionSpan, type NoteGenerator } from "./memory-pass.ts";
import type { DreamAsks, DryFixes, DryNotes } from "./dream-live.ts";
import { pickStamp } from "./picks.ts";
import { loadedMemory, memoryFileRaw, rawRevision, readMemoryFile, saveMemoryFile, workspaceDir } from "./workspace.ts";

export const SLEEP_IDLE_MS = 30 * 60_000;
export const SLEEP_GAP_MS = 6 * 60 * 60_000;
export const SLEEP_TIMEOUT_MS = 120_000;
const PROMPT_NOTES_MAX = 32_000;
const MOVES_MAX = 20;
const STATE_FILE = "memory-sleep.json";
// where older builds moved lines; its records still mark what someone put back
const HISTORY_DIR = "memory-history";

const refsSchema = z.array(z.string()).max(MOVES_MAX);
const tidySchema = z.object({
  duplicates: z.array(z.object({ keep: z.string(), drop: refsSchema })).max(MOVES_MAX).nullish(),
  disagree: z.array(z.tuple([z.string(), z.string()])).max(MOVES_MAX).nullish(),
});
const movedSchema = z.object({ at: z.number(), text: z.string(), by: z.string(), why: z.enum(["duplicate", "replaced", "expired"]), after: z.string().nullable(), cr: z.boolean(), left: z.number() });
const runSchema = z.object({ runId: z.string(), at: z.number(), beforeBytes: z.number(), afterBytes: z.number(), moves: z.array(movedSchema), undoneAt: z.number().optional() });
const botStateSchema = z.object({ digest: z.string().optional(), at: z.number().optional(), run: runSchema.optional() });
const stateSchema = z.object({ bots: z.record(z.string(), botStateSchema) });

type BotState = z.infer<typeof botStateSchema>;
type JudgeLog = { input: number; output: number; ms: number };
export type UndoResult = { ok: true; revision: string; restored: number; skipped: number } | { ok: false; error: "no-run" | "not-newest" | "undone" | "busy" };
export type MemoryCleanRun = {
  runId: string; at: number; files: string[]; beforeBytes: number; afterBytes: number; merged: number; replaced: number; moved: number; undoneAt: number | null; undoable: boolean;
};
/** section: the index of the heading or label the note sits under, -1 for none; alone: no line under it belongs to it. */
export type NoteLine = { at: number; text: string; date?: string; section: number; alone: boolean };
export type Why = "duplicate" | "replaced" | "expired";
export type Move = { at: number; text: string; by: string; why: Why };

interface SleepLog {
  botId: string;
  notes?: number;
  sentNotes?: number;
  input?: number;
  output?: number;
  moved?: number;
  ms: number;
  judges?: Partial<Record<keyof DreamJudges, JudgeLog>>;
  /** Why nothing moved: a judge missing, failed or unreadable. */
  reason?: string;
  result: "saved" | "none" | "conflict" | "error" | "timeout" | "cancelled" | "dry" | "unjudged";
  mode?: "dry";
  wouldMove?: number;
  closes?: number;
  asked?: number;
  fellOut?: number;
  threads?: number;
  skipped?: number;
  unchecked?: number;
  fixes?: { state: DryFixes["state"]; pairs?: number; bytes?: number; items: number; input: number; output: number; judges?: DryFixes["judges"]; reason?: string };
}

export interface MemorySleepDeps {
  dataDir: string;
  /** Every bot at boot, so a tidy owed before a restart still runs. */
  bots(): string[];
  /** Dreaming's mode, read again just before a move: only a bot set to live moves lines, every other bot dreams dry. */
  live(botId: string): boolean;
  /** Both must answer for anything to move; never one alone. */
  judges(botId: string): DreamJudges;
  /** The bot's Auto notes switch, read live; false on a PC that does not tidy this bot. */
  enabled(botId: string): boolean;
  /** Any turn of the bot running. */
  busy(botId: string): boolean;
  /** MEMORY.md or its dry plan changed on disk, so an open Memory page reloads it. */
  changed(botId: string): void;
  /** The tidy saved MEMORY.md as `after`, `before` without some lines, for memory sync to rank. */
  tidied?(botId: string, before: string, after: string): void;
  /** A live run archived `count` lines: the bot's morning line. */
  archived?(botId: string, run: { runId: string; count: number }): void;
  /** Dreaming (dream-live.ts): a dry bot's pass plans its asks and notes and writes nothing else. */
  dream?: {
    asks(botId: string, signal: AbortSignal): Promise<DreamAsks | null>;
    /** The wrong-note check over the owner's lines since the last pass; null judges: notes are not checked on this PC. */
    fixes(botId: string, judges: DreamJudges | null, signal: AbortSignal): Promise<DryFixes>;
    plan(botId: string, at: number, notes: DryNotes, asks: DreamAsks, fixes?: DryFixes): void;
  };
  now?(): number;
}

export interface MemorySleep {
  /** Call when any turn of the bot settles: the tidy waits for SLEEP_IDLE_MS of quiet. */
  onSettled(botId: string): void;
  /** Call when any turn of the bot starts: a tidy still waiting on the model stops. */
  onTurn(botId: string): void;
  /** The newest live run, as the Memory row and the morning line read it. */
  latest(botId: string): MemoryCleanRun | null;
  /** Puts every line of the newest run back; the archive keeps them, so they never move again. */
  undo(botId: string, runId: string): UndoResult;
  idle(): Promise<void>;
  dispose(): void;
}

const BULLET = /^[-*+]\s+\S/;
const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(?:```|~~~)/;
const STAMP = /\(noted (\d{4}-\d{2}-\d{2})\)/;
const PROMPT_TAGS = /<\/?notes\b[^>]*>/gi;
// quotes, brackets and closing punctuation around a word; anything inside it (C++, -5%, jo.smith@) counts
const EDGE = /^["'`“‘([{«「『（]+|["'`”’)\]}»」』）,;:.!?。、，！？：；]+$/gu;
// words that turn or qualify what the rest of a note says
const NOT_WORDS = new Set(
  (
    "not no never none nothing nobody neither nor cannot without dont doesnt didnt isnt arent wasnt werent wont cant couldnt shouldnt wouldnt hasnt havent hadnt " +
    "used formerly former previously anymore ex until except unless instead rather but however although though over than less versus vs " +
    "avoid avoids avoided stop stops stopped quit quits maybe perhaps unsure wrong false cancelled canceled outdated " +
    "nicht kein keine keinen keiner nie niemals ohne niet geen nooit zonder pas jamais sans aucun aucune nunca sin ni jamás tampoco " +
    "não nao sem nem non mai senza né не нет без никогда ни 안 못 말고 아님 tidak bukan tanpa jangan belum không chưa chẳng değil yok hiç"
  ).split(" "),
);
const NOT_PARTS = /n['’]t$|않|없|아니|못|ない|ません|ず$|ぬ$|不|没|沒|别|別|無|无|非|未|勿|莫|ไม่|नहीं|मत|बिना/u;
// a hedge or a scope word narrows a newer note rather than turning the older one, and a hedged note is not sure enough to retire a fact
const HEDGES = new Set("maybe perhaps unsure but over than except unless".split(" "));

const withoutStamp = (text: string) => text.replace(STAMP, " ");
const body = (text: string) => withoutStamp(text).replace(/^\s*[-*+]\s+/, "").normalize("NFC");
/** The same text but for spacing, a full stop that ends it and the Auto Notes stamp: symbols, digits, emoji, marks, case and a closing ! all count. */
export const twinKey = (text: string) => body(text).replace(/\s+/g, " ").trim().replace(/(?<=(?:^|\s)[^\s.]+)[.。]+$/u, "");
export const tokens = (text: string) => body(text).split(/\s+/).map((token) => token.replace(EDGE, "")).filter(Boolean);
export const negates = (token: string) => NOT_WORDS.has(token.toLowerCase()) || NOT_PARTS.test(token.toLowerCase());
const ref = (line: NoteLine) => `L${line.at + 1}`;
const day = (now: number) => pickStamp(now).slice(0, 10);

// an indented line under the bullet, or text straight after it, is part of the same note
function alone(lines: string[], at: number): boolean {
  const next = lines[at + 1];
  if (next === undefined || BULLET.test(next) || HEADING.test(next)) return true;
  if (next.trim()) return false;
  const after = lines.slice(at + 2).find((line) => line.trim());
  return after === undefined || !/^\s/.test(after);
}

/** MEMORY.md's top-level bullets outside code and the Auto Notes decisions, each with the date its Auto Notes stamp gives. */
export function noteLines(raw: string): NoteLine[] {
  const lines = raw.split("\n").map((line) => line.replace(/\r$/, ""));
  const span = decisionSpan(lines);
  let fenced = false;
  let section = -1;
  return lines.flatMap((text, at) => {
    if (FENCE.test(text)) {
      fenced = !fenced;
      return [];
    }
    if (fenced) return [];
    // a heading or a label (**Name**, Name:, - Name:): what the bullets after it belong to
    if (/^\S/.test(text) && (!BULLET.test(text) || /:\s*$/.test(text))) section = at;
    if (!BULLET.test(text) || (span && at > span[0] && at < span[1])) return [];
    const note: NoteLine = { at, text, section, alone: alone(lines, at) };
    const date = STAMP.exec(text)?.[1];
    if (date) note.date = date;
    return [note];
  });
}

/** keep says all drop says: keep starts with drop's words, and what it adds turns none of them. */
export function holds(keep: string, drop: string): boolean {
  const [have, need] = [tokens(keep), tokens(drop)];
  return need.length > 0 && need.length <= have.length && need.every((token, index) => have[index] === token) && !have.slice(need.length).some(negates);
}

/** newer replaced older: Auto Notes stamped both, newer is later, and it says every word of older again with a word that turns it. A swapped word (peanuts, shellfish) is two notes that can both hold. */
export function replaces(newer: NoteLine, older: NoteLine): boolean {
  if (!newer.date || !older.date || newer.date <= older.date) return false;
  const words = (line: NoteLine) => tokens(line.text).map((token) => token.toLowerCase());
  const [before, after] = [words(older), words(newer)];
  const added = after.filter((word) => !before.includes(word));
  return before.length > 0 && before.every((word) => after.includes(word)) && !added.some((word) => HEDGES.has(word)) && added.some(negates);
}

export function tidyPrompt(notes: NoteLine[]): string {
  const clean = (text: string) => text.replace(PROMPT_TAGS, " ");
  return [
    "You tidy a bot's notes. Find only two things:",
    "- duplicates: notes that say the same thing. keep is the one that says it best; drop lists the ones it fully covers.",
    "- disagree: two notes about the same thing that cannot both be true now, like a preference the user later changed.",
    "Notes that add different details are not duplicates, and two notes that can both be true do not disagree. When unsure, leave them out. Never judge which side is right.",
    'Reply with JSON only: {"duplicates": [{"keep": "L3", "drop": ["L9"]}], "disagree": [["L4", "L12"]]}, or {"duplicates": [], "disagree": []} when nothing qualifies.',
    "",
    "NOTES:",
    "<notes>",
    ...notes.map((line) => `${ref(line)}: ${clean(line.text)}`),
    "</notes>",
  ].join("\n");
}

export function parseTidy(output: string): z.infer<typeof tidySchema> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return {};
  try {
    const parsed = tidySchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The head and the newest lines load; only the cut middle does not. */
export function loadWindow(raw: string) {
  const view = loadedMemory(raw);
  const head = view.text.split("\n").length;
  const all = raw.split("\n");
  const tail = view.newest === undefined ? Infinity : (all.at(-1) === "" ? all.length - 1 : all.length) - view.newest.split("\n").length;
  return { head, loaded: (line: NoteLine) => line.at < head || line.at >= tail };
}

/** What to move: exact twins, then up to MOVES_MAX of the model's duplicates and disagreements a strict check agrees with. Anything unsure stays, and so does a line in `movedBefore`, the twin keys history records as moved out: someone put it back. */
export function planTidy(raw: string, reply = "", movedBefore: ReadonlySet<string> = new Set()): Move[] {
  const lines = noteLines(raw);
  const notes = new Map(lines.map((line) => [ref(line), line] as const));
  const { head, loaded } = loadWindow(raw);
  const moves: Move[] = [];
  const gone = new Set<NoteLine>();
  const kept = new Set<NoteLine>();
  let guessed = 0;
  // a twin merge is certain; a model's moves are capped per run
  const move = (line: NoteLine | undefined, by: NoteLine | undefined, why: Why, model = true) => {
    if (!line || !by || line === by || (model && guessed >= MOVES_MAX) || gone.has(line) || gone.has(by) || kept.has(line) || movedBefore.has(twinKey(line.text))) return;
    // only whole notes, under the same heading, and never in favor of a line the prompt does not load; a head duplicate stays, since the newest lines roll out
    if (!line.alone || !by.alone || line.section !== by.section || (loaded(line) && !loaded(by)) || (why === "duplicate" && line.at < head && by.at >= head)) return;
    moves.push({ at: line.at, text: line.text, by: by.text, why });
    if (model) guessed += 1;
    gone.add(line);
    kept.add(by);
  };
  const twins = new Map<string, NoteLine[]>();
  for (const line of lines) {
    const text = twinKey(line.text);
    const key = `${line.section} ${text}`;
    if (text) twins.set(key, [...(twins.get(key) ?? []), line]);
  }
  for (const group of twins.values()) {
    const top = group.filter((line) => line.at < head);
    const shown = top.length ? top : group.filter(loaded);
    const pool = shown.length ? shown : group;
    // the newest: notes are appended, so the last copy, unless an earlier one carries a later stamp
    const keep = pool.reduce((best, line) => (best.date && line.date && best.date > line.date ? best : line));
    // an undated copy away from the others may mean something where it sits, like a step done twice or a note under a bullet used as a label
    const together = (line: NoteLine) => lines.every((each) => each.at < Math.min(line.at, keep.at) || each.at > Math.max(line.at, keep.at) || group.includes(each));
    for (const line of group) if (line.date || keep.date || together(line)) move(line, keep, "duplicate", false);
  }
  const { duplicates, disagree } = parseTidy(reply);
  for (const { keep, drop } of duplicates ?? []) {
    const by = notes.get(keep);
    for (const each of drop) {
      const line = notes.get(each);
      // only a later note folds in an earlier one: an older or undated line may narrow what the later one says
      if (line?.date && by?.date && by.date > line.date && holds(by.text, line.text)) move(line, by, "duplicate");
    }
  }
  for (const [a, b] of disagree ?? []) {
    const [x, y] = [notes.get(a), notes.get(b)];
    if (x && y && replaces(y, x)) move(x, y, "replaced");
    else if (x && y && replaces(x, y)) move(y, x, "replaced");
  }
  return moves.sort((p, q) => p.at - q.at);
}

/** raw without the lines at these indexes; nothing is ever added. */
export function withoutLines(raw: string, at: readonly number[]): string {
  const drop = new Set(at);
  return raw.split("\n").filter((_, index) => !drop.has(index)).join("\n");
}

// appended, never written over: a file that cannot be opened stops the tidy; the returned undo takes the entry back off the end
export function appendArchive(path: string, entry: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let undo: () => void;
  try {
    writeFileSync(path, `${DREAMED_HEAD}\n${entry}\n`, { flag: "wx", mode: 0o600 });
    undo = () => rmSync(path, { force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const size = statSync(path).size;
    appendFileSync(path, `\n${entry}\n`);
    undo = () => truncateSync(path, size);
  }
  return () => {
    try {
      undo();
    } catch {
      // a record left behind repeats a move, it loses nothing
    }
  };
}

const MOVED = /^- ("(?:[^"\\\n]|\\.)*") replaced by /gm;

/** The twin key of every line the archive or an older build's history records as moved out. */
function movedKeys(botId: string): Set<string> {
  const dir = join(workspaceDir(botId), HISTORY_DIR);
  const keys = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const name of names.filter((each) => /^\d{4}-\d{2}\.md$/.test(each))) {
    for (const [, json] of readFileSync(join(dir, name), "utf8").matchAll(MOVED)) {
      try {
        keys.add(twinKey(JSON.parse(json!)));
      } catch {
        // a line someone edited by hand
      }
    }
  }
  for (const key of dreamedKeys(botId)) keys.add(key);
  return keys;
}

/** The archive first, then MEMORY.md without the moved lines; false, with the record taken back, when another writer got to MEMORY.md first. */
function moveOut(botId: string, raw: string, revision: string, runId: string, moves: readonly Move[], now: number, tidied: MemorySleepDeps["tidied"]): boolean {
  const path = join(workspaceDir(botId), "MEMORY.md");
  if (readMemoryFile(botId).revision !== revision) return false;
  const undo = appendArchive(dreamedPath(botId), dreamedEntry(runId, moves, now));
  const text = withoutLines(raw, moves.map(({ at }) => at));
  // the file the save replaces: another program's save that landed first, in place or by a rename of its own, is in it
  const held = `${path}.${randomUUID()}.held`;
  try {
    writeFileAtomic(path, text, { mode: 0o600, keep: held });
  } catch (error) {
    rmSync(held, { force: true });
    undo();
    throw error;
  }
  let landed: boolean;
  try {
    landed = readFileSync(held, "utf8") !== raw;
    if (landed) renameRetrying(held, path);
  } catch (error) {
    console.warn(`[memory-sleep] could not check or put back a save made during the tidy; it is in ${held}`);
    throw error;
  }
  if (landed) {
    undo();
    return false;
  }
  tidied?.(botId, raw, text);
  rmSync(held, { force: true });
  return true;
}

const stopped = (signal: AbortSignal) => (signal.reason === "cancelled" ? "cancelled" : "timeout");

/** Tidies each bot's MEMORY.md once it has been quiet SLEEP_IDLE_MS, only when it changed since its last tidy, at most once per SLEEP_GAP_MS. Never on the reply path. */
export function createMemorySleep(deps: MemorySleepDeps): MemorySleep {
  const now = deps.now ?? Date.now;
  const statePath = join(deps.dataDir, STATE_FILE);
  const bots = new Map<string, BotState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: string[] = [];
  let running: { botId: string; done: Promise<void>; controller: AbortController } | undefined;
  let disposed = false;

  try {
    for (const [botId, record] of Object.entries(stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8"))).bots)) bots.set(botId, record);
  } catch {
    // first run or unreadable: start empty
  }

  const save = () => {
    try {
      writeFileAtomic(statePath, `${JSON.stringify({ bots: Object.fromEntries(bots) })}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[memory-sleep] state save failed (${error instanceof Error ? error.name : "error"})`);
    }
  };
  const log = (fields: SleepLog) => console.info(`[memory-sleep] ${JSON.stringify(fields)}`);

  const arm = (botId: string, wait = SLEEP_IDLE_MS) => {
    if (disposed) return;
    clearTimeout(timers.get(botId));
    const timer = setTimeout(() => {
      timers.delete(botId);
      if (!queue.includes(botId)) queue.push(botId);
      pump();
    }, wait);
    timer.unref?.();
    timers.set(botId, timer);
  };

  // the day counts: a one-off note expires without MEMORY.md changing
  const digestOf = (raw: string, dry = false) => createHash("sha256").update(JSON.stringify(dry ? [raw, "pair", day(now()), "dry"] : [raw, "pair", day(now())])).digest("hex").slice(0, 16);

  // both judges read the same notes at once; flags is null, with the reason, unless both answered with what was asked
  const judge = async (botId: string, lines: NoteLine[], signal: AbortSignal) => {
    let used = 0;
    const shownNotes = lines.filter((line) => (used += Buffer.byteLength(line.text, "utf8") + 8) <= PROMPT_NOTES_MAX);
    const judges = deps.judges(botId);
    const logs: Partial<Record<keyof DreamJudges, JudgeLog>> = {};
    const missing = (Object.keys(judges) as (keyof DreamJudges)[]).filter((name) => !judges[name]);
    if (missing.length) return { shownNotes, logs, flags: null, reason: `${missing.join(" and ")} judge unavailable` };
    if (shownNotes.length < 2) return { shownNotes, logs, flags: [] as Flag[] };
    const today = day(now());
    const prompt = dreamPrompt(shownNotes, today);
    const ask = async (name: keyof DreamJudges, generate: NoteGenerator) => {
      const spent: JudgeLog = { input: 0, output: 0, ms: 0 };
      logs[name] = spent;
      const started = now();
      try {
        return parseDream(await generate(prompt, signal, (usage) => {
          spent.input += usage?.input ?? 0;
          spent.output += usage?.output ?? 0;
        }), shownNotes, today);
      } finally {
        spent.ms = now() - started;
      }
    };
    const [claude, gemini] = await Promise.allSettled([ask("claude", judges.claude!), ask("gemini", judges.gemini!)]);
    if (signal.aborted) throw signal.reason;
    const failed = ([["claude", claude], ["gemini", gemini]] as const).find(([, result]) => result.status === "rejected" || result.value === null);
    if (failed) return { shownNotes, logs, flags: null, reason: `${failed[0]} judge ${failed[1].status === "rejected" ? "failed" : "reply unreadable"}` };
    return { shownNotes, logs, flags: agreed((claude as PromiseFulfilledResult<Flag[]>).value, (gemini as PromiseFulfilledResult<Flag[]>).value) };
  };
  const spent = (logs: Partial<Record<keyof DreamJudges, JudgeLog>>) => ({
    input: Object.values(logs).reduce((sum, each) => sum + each.input, 0),
    output: Object.values(logs).reduce((sum, each) => sum + each.output, 0),
    judges: logs,
  });
  // only a plan that moves something reads the archive, for the lines someone put back
  const planMoves = (botId: string, raw: string, flags: Flag[]) => {
    const moves = planDream(raw, flags, day(now()));
    return moves.length ? planDream(raw, flags, day(now()), movedKeys(botId)) : moves;
  };

  // dry: the moves Sleep would make, with MEMORY.md and the archive untouched
  const dryNotes = async (botId: string, signal: AbortSignal, before: string | undefined): Promise<DryNotes & { digest?: string; fields?: Partial<SleepLog> }> => {
    if (!deps.enabled(botId)) return { state: "off-here", moves: [] };
    const raw = memoryFileRaw(botId);
    const memory = readMemoryFile(botId);
    const digest = digestOf(raw, true);
    if (before === digest) return { state: "unchanged", moves: [] };
    const lines = noteLines(raw);
    let asked: Awaited<ReturnType<typeof judge>>;
    try {
      asked = await judge(botId, lines, signal);
    } catch {
      return { state: signal.aborted ? "stopped" : "error", moves: [] };
    }
    const fields = { notes: lines.length, sentNotes: asked.shownNotes.length, ...spent(asked.logs), ...(asked.reason ? { reason: asked.reason } : {}) };
    if (!asked.flags) return { state: "no-model", moves: [], fields };
    if (deps.busy(botId) || readMemoryFile(botId).revision !== memory.revision) return { state: "conflict", moves: [], fields };
    return { state: "checked", moves: planMoves(botId, raw, asked.flags), digest, fields };
  };

  const dryRun = async (botId: string, signal: AbortSignal, dream: NonNullable<MemorySleepDeps["dream"]>) => {
    if (deps.busy(botId)) return arm(botId);
    const record = bots.get(botId) ?? {};
    const waited = now() - (record.at ?? -Infinity);
    if (waited >= 0 && waited < SLEEP_GAP_MS) return arm(botId, SLEEP_GAP_MS - waited);
    const started = now();
    bots.set(botId, { ...record, at: started });
    save();
    // asks first: they have no model step, so a turn that stops the notes part loses none of them
    const asks = await dream.asks(botId, signal);
    if (disposed) return;
    if (!asks) return log({ botId, mode: "dry", ms: now() - started, result: signal.aborted ? stopped(signal) : "error" });
    const notes = await dryNotes(botId, signal, record.digest);
    if (disposed) return;
    const fixes = await dream.fixes(botId, deps.enabled(botId) ? deps.judges(botId) : null, signal);
    if (disposed) return;
    dream.plan(botId, started, { state: notes.state, moves: notes.moves }, asks, fixes);
    deps.changed(botId);
    if (notes.digest) {
      bots.set(botId, { ...bots.get(botId), at: started, digest: notes.digest });
      save();
    }
    const count = (op: string) => asks.items.filter((item) => item.op === op).length;
    const fixed = Object.values(fixes.judges ?? {});
    const fixLog = { state: fixes.state, pairs: fixes.pairs, bytes: fixes.bytes, items: fixes.items.length, input: fixed.reduce((sum, each) => sum + each.input, 0), output: fixed.reduce((sum, each) => sum + each.output, 0), judges: fixes.judges, reason: fixes.reason };
    log({ botId, mode: "dry", ...notes.fields, fixes: fixLog, wouldMove: notes.moves.length, closes: count("close"), asked: count("ask"), fellOut: count("fall-out"), threads: asks.threads, skipped: asks.skipped, unchecked: asks.unchecked, ms: now() - started, result: "dry" });
  };

  const run = async (botId: string, signal: AbortSignal) => {
    if (!deps.live(botId)) return deps.dream ? dryRun(botId, signal, deps.dream) : undefined;
    if (!deps.enabled(botId)) return;
    if (deps.busy(botId)) return arm(botId);
    const record = bots.get(botId) ?? {};
    const raw = memoryFileRaw(botId);
    const memory = readMemoryFile(botId);
    const digest = digestOf(raw);
    if (record.digest === digest) return;
    const waited = now() - (record.at ?? -Infinity);
    // a stamp ahead of the clock does not count: a wait past 2^31 ms fires at once, over and over
    if (waited >= 0 && waited < SLEEP_GAP_MS) return arm(botId, SLEEP_GAP_MS - waited);
    const started = now();
    // the gap counts from the start, so a run that fails or is cut short waits it out too
    bots.set(botId, { ...record, at: started });
    save();
    const lines = noteLines(raw);
    let asked: Awaited<ReturnType<typeof judge>>;
    try {
      asked = await judge(botId, lines, signal);
    } catch {
      if (!disposed) log({ botId, ms: now() - started, result: signal.aborted ? stopped(signal) : "error" });
      return;
    }
    if (disposed || !deps.enabled(botId)) return;
    const base = { botId, notes: lines.length, sentNotes: asked.shownNotes.length, ms: 0, ...spent(asked.logs) };
    // one judge alone never moves a line, so the night passes and the next quiet spell asks both again
    if (!asked.flags) return log({ ...base, reason: asked.reason, ms: now() - started, result: "unjudged" });
    // a turn or an editor may have written while the judges ran: theirs wins, the tidy waits for the next quiet spell
    if (deps.busy(botId) || readMemoryFile(botId).revision !== memory.revision) {
      log({ ...base, ms: now() - started, result: "conflict" });
      return arm(botId);
    }
    if (!deps.live(botId)) return log({ ...base, ms: now() - started, result: "dry" });
    let moves: Move[];
    let runId = "";
    try {
      moves = planMoves(botId, raw, asked.flags);
      // the same moves on the same day get the same id, so two PCs that make them write the same archive
      runId = createHash("sha256").update(JSON.stringify([day(now()), moves.map(({ text }) => text)])).digest("hex").slice(0, 16);
      if (moves.length && !moveOut(botId, raw, memory.revision, runId, moves, now(), deps.tidied)) {
        log({ ...base, ms: now() - started, result: "conflict" });
        return arm(botId);
      }
    } catch (error) {
      log({ ...base, ms: now() - started, result: "error" });
      console.warn(`[memory-sleep] write failed (${error instanceof Error ? error.name : "error"})`);
      return;
    }
    const after = memoryFileRaw(botId);
    const kept = moves.length
      ? { runId, at: started, beforeBytes: Buffer.byteLength(raw), afterBytes: Buffer.byteLength(after), moves: anchored(raw, moves) }
      : record.run;
    bots.set(botId, { at: started, digest: digestOf(after), ...(kept ? { run: kept } : {}) });
    save();
    if (moves.length) {
      deps.changed(botId);
      deps.archived?.(botId, { runId, count: moves.length });
    }
    log({ ...base, moved: moves.length, ms: now() - started, result: moves.length ? "saved" : "none" });
  };

  const latest = (botId: string): MemoryCleanRun | null => {
    const last = bots.get(botId)?.run;
    if (!last) return null;
    const count = (why: Move["why"]) => last.moves.filter((move) => move.why === why).length;
    return {
      runId: last.runId, at: last.at, files: ["MEMORY.md", DREAMED_FILE], beforeBytes: last.beforeBytes, afterBytes: last.afterBytes,
      merged: count("duplicate"), replaced: count("replaced"), moved: last.moves.length, undoneAt: last.undoneAt ?? null, undoable: last.undoneAt === undefined,
    };
  };

  const undo = (botId: string, runId: string): UndoResult => {
    const record = bots.get(botId);
    const last = record?.run;
    if (!record || !last) return { ok: false, error: "no-run" };
    if (last.runId !== runId) return { ok: false, error: "not-newest" };
    if (last.undoneAt !== undefined) return { ok: false, error: "undone" };
    if (running?.botId === botId || deps.busy(botId)) return { ok: false, error: "busy" };
    const raw = memoryFileRaw(botId);
    const back = putBack(raw, last.moves as ArchivedMove[]);
    if (back.restored) {
      const saved = saveMemoryFile(botId, back.text, rawRevision(raw));
      if (saved.conflict) return { ok: false, error: "busy" };
    }
    try {
      const path = dreamedPath(botId);
      writeFileAtomic(path, markUndone(readFileSync(path, "utf8"), runId, now()), { mode: 0o600 });
    } catch {
      // the lines are back either way; the heading only says so
    }
    const at = now();
    // the new text is this run's undo, not a change to judge again tonight
    bots.set(botId, { ...record, digest: digestOf(memoryFileRaw(botId)), run: { ...last, undoneAt: at } });
    save();
    deps.changed(botId);
    return { ok: true, revision: readMemoryFile(botId).revision, restored: back.restored, skipped: back.skipped };
  };

  const pump = () => {
    if (running || disposed) return;
    const botId = queue.shift();
    if (!botId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), SLEEP_TIMEOUT_MS);
    timer.unref?.();
    const pass = { botId, controller, done: Promise.resolve() };
    running = pass;
    pass.done = run(botId, controller.signal)
      .catch((error) => console.warn(`[memory-sleep] tidy failed (${error instanceof Error ? error.name : "error"})`))
      .finally(() => {
        clearTimeout(timer);
        running = undefined;
        pump();
      });
  };

  // a restart spreads the bots over the gap rather than asking the model for every one of them at once
  const all = deps.bots();
  all.forEach((botId, index) => arm(botId, SLEEP_IDLE_MS + Math.floor((index * SLEEP_GAP_MS) / all.length)));

  return {
    latest,
    undo,
    onSettled: (botId) => arm(botId),
    onTurn(botId) {
      if (running?.botId === botId) running.controller.abort("cancelled");
    },
    async idle() {
      while (running) await running.done;
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      queue.length = 0;
      running?.controller.abort();
    },
  };
}
