// The idle tidy ("sleep"): once a bot has been quiet a while, merge duplicate notes and move a note a newer one
// replaced into a monthly history file. It only ever removes lines from MEMORY.md, so it cannot bring back what the user deleted.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { renameRetrying, writeFileAtomic } from "./atomic.ts";
import { decisionSpan, type NoteGenerator } from "./memory-pass.ts";
import { pickStamp } from "./picks.ts";
import { loadedMemory, memoryFileRaw, readMemoryFile, workspaceDir } from "./workspace.ts";

export const SLEEP_IDLE_MS = 30 * 60_000;
export const SLEEP_GAP_MS = 6 * 60 * 60_000;
export const SLEEP_TIMEOUT_MS = 120_000;
const PROMPT_NOTES_MAX = 32_000;
const MOVES_MAX = 20;
const STATE_FILE = "memory-sleep.json";
// beside memory/, so the history is never loaded, synced, listed or recalled
const HISTORY_DIR = "memory-history";
const HISTORY_HEAD =
  "# Memory history\n\nLines the idle tidy moved out of MEMORY.md, oldest first. Nothing here loads into the prompt; copy a line back to MEMORY.md to restore it.\n";

const refsSchema = z.array(z.string()).max(MOVES_MAX);
const tidySchema = z.object({
  duplicates: z.array(z.object({ keep: z.string(), drop: refsSchema })).max(MOVES_MAX).nullish(),
  disagree: z.array(z.tuple([z.string(), z.string()])).max(MOVES_MAX).nullish(),
});
const botStateSchema = z.object({ digest: z.string().optional(), at: z.number().optional() });
const stateSchema = z.object({ bots: z.record(z.string(), botStateSchema) });

type BotState = z.infer<typeof botStateSchema>;
/** section: the index of the heading or label the note sits under, -1 for none; alone: no line under it belongs to it. */
export type NoteLine = { at: number; text: string; date?: string; section: number; alone: boolean };
export type Why = "duplicate" | "replaced";
export type Move = { at: number; text: string; by: string; why: Why };

interface SleepLog {
  botId: string;
  notes?: number;
  sentNotes?: number;
  input?: number;
  output?: number;
  moved?: number;
  ms: number;
  result: "saved" | "none" | "conflict" | "error" | "timeout" | "cancelled";
}

export interface MemorySleepDeps {
  dataDir: string;
  /** Every bot at boot, so a tidy owed before a restart still runs. */
  bots(): string[];
  generate(botId: string): NoteGenerator | null;
  /** The bot's Auto notes switch, read live; false on a PC that does not tidy this bot. */
  enabled(botId: string): boolean;
  /** Any turn of the bot running. */
  busy(botId: string): boolean;
  /** MEMORY.md changed on disk, so an open Memory page reloads it. */
  changed(botId: string): void;
  /** The tidy saved MEMORY.md as `after`, `before` without some lines, for memory sync to rank. */
  tidied?(botId: string, before: string, after: string): void;
  now?(): number;
}

export interface MemorySleep {
  /** Call when any turn of the bot settles: the tidy waits for SLEEP_IDLE_MS of quiet. */
  onSettled(botId: string): void;
  /** Call when any turn of the bot starts: a tidy still waiting on the model stops. */
  onTurn(botId: string): void;
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

const withoutStamp = (text: string) => text.replace(STAMP, " ");
const body = (text: string) => withoutStamp(text).replace(/^\s*[-*+]\s+/, "").normalize("NFC");
/** The same text but for spacing, a full stop that ends it and the Auto Notes stamp: symbols, digits, emoji, marks, case and a closing ! all count. */
const twinKey = (text: string) => body(text).replace(/\s+/g, " ").trim().replace(/(?<=(?:^|\s)[^\s.]+)[.。]+$/u, "");
const tokens = (text: string) => body(text).split(/\s+/).map((token) => token.replace(EDGE, "")).filter(Boolean);
const negates = (token: string) => NOT_WORDS.has(token.toLowerCase()) || NOT_PARTS.test(token.toLowerCase());
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
function replaces(newer: NoteLine, older: NoteLine): boolean {
  if (!newer.date || !older.date || newer.date <= older.date) return false;
  const words = (line: NoteLine) => tokens(line.text).map((token) => token.toLowerCase());
  const [before, after] = [words(older), words(newer)];
  return before.length > 0 && before.every((word) => after.includes(word)) && after.some((word) => negates(word) && !before.includes(word));
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

/** What to move: exact twins, then up to MOVES_MAX of the model's duplicates and disagreements a strict check agrees with. Anything unsure stays, and so does a line in `movedBefore`, the twin keys history records as moved out: someone put it back. */
export function planTidy(raw: string, reply = "", movedBefore: ReadonlySet<string> = new Set()): Move[] {
  const lines = noteLines(raw);
  const notes = new Map(lines.map((line) => [ref(line), line] as const));
  const loads = loadedMemory(raw).text.split("\n").length;
  const moves: Move[] = [];
  const gone = new Set<NoteLine>();
  const kept = new Set<NoteLine>();
  let guessed = 0;
  // a twin merge is certain; a model's moves are capped per run
  const move = (line: NoteLine | undefined, by: NoteLine | undefined, why: Why, model = true) => {
    if (!line || !by || line === by || (model && guessed >= MOVES_MAX) || gone.has(line) || gone.has(by) || kept.has(line) || movedBefore.has(twinKey(line.text))) return;
    // only whole notes, under the same heading, and never in favor of a line the prompt does not load
    if (!line.alone || !by.alone || line.section !== by.section || (line.at < loads && by.at >= loads)) return;
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
    const loaded = group.filter((line) => line.at < loads);
    const pool = loaded.length ? loaded : group;
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

export const historyPath = (botId: string, now: number) => join(workspaceDir(botId), HISTORY_DIR, `${pickStamp(now).slice(0, 7)}.md`);

const quoted = (line: string) => JSON.stringify(line.replace(/^\s*[-*+]\s+/, ""));

export function historyEntry(moves: readonly Move[], now: number): string {
  const date = day(now);
  return [`## ${pickStamp(now)}`, ...moves.map(({ text, by, why }) => `- ${quoted(text)} replaced by ${quoted(by)}, ${date}${why === "duplicate" ? " (duplicate)" : ""}`)].join("\n");
}

// appended, never written over: a file that cannot be opened stops the tidy; the returned undo takes the entry back off the end
function appendHistory(path: string, entry: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let undo: () => void;
  try {
    writeFileSync(path, `${HISTORY_HEAD}\n${entry}\n`, { flag: "wx", mode: 0o600 });
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

/** The twin key of every line the history records as moved out. */
function historyKeys(botId: string): Set<string> {
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
  return keys;
}

/** History first, then MEMORY.md without the moved lines; false, with the record taken back, when another writer got to MEMORY.md first. */
function moveOut(botId: string, raw: string, revision: string, moves: readonly Move[], now: number, tidied: MemorySleepDeps["tidied"]): boolean {
  const path = join(workspaceDir(botId), "MEMORY.md");
  if (readMemoryFile(botId).revision !== revision) return false;
  const undo = appendHistory(historyPath(botId, now), historyEntry(moves, now));
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

  const digestOf = (raw: string, model: boolean) => createHash("sha256").update(JSON.stringify([raw, model])).digest("hex").slice(0, 16);

  const run = async (botId: string, signal: AbortSignal) => {
    if (!deps.enabled(botId)) return;
    if (deps.busy(botId)) return arm(botId);
    const record = bots.get(botId) ?? {};
    const raw = memoryFileRaw(botId);
    const memory = readMemoryFile(botId);
    const generate = deps.generate(botId);
    const digest = digestOf(raw, Boolean(generate));
    if (record.digest === digest) return;
    const waited = now() - (record.at ?? -Infinity);
    // a stamp ahead of the clock does not count: a wait past 2^31 ms fires at once, over and over
    if (waited >= 0 && waited < SLEEP_GAP_MS) return arm(botId, SLEEP_GAP_MS - waited);
    const started = now();
    // the gap counts from the start, so a run that fails or is cut short waits it out too
    bots.set(botId, { ...record, at: started });
    save();
    const lines = noteLines(raw);
    let used = 0;
    const shownNotes = lines.filter((line) => (used += Buffer.byteLength(line.text, "utf8") + 8) <= PROMPT_NOTES_MAX);
    const usage = { input: 0, output: 0 };
    let reply = "";
    if (generate && shownNotes.length > 1) {
      try {
        reply = await generate(tidyPrompt(shownNotes), signal, (spent) => {
          usage.input += (spent?.input ?? 0) + (spent?.cachedInput ?? 0) + (spent?.cacheCreation ?? 0);
          usage.output += spent?.output ?? 0;
        });
      } catch {
        if (!disposed) log({ botId, ms: now() - started, result: signal.aborted ? stopped(signal) : "error" });
        return;
      }
    }
    if (disposed || !deps.enabled(botId)) return;
    const base = { botId, notes: lines.length, sentNotes: shownNotes.length, ms: 0, ...usage };
    if (signal.aborted) return log({ ...base, ms: now() - started, result: stopped(signal) });
    // a turn or an editor may have written while the model ran: theirs wins, the tidy waits for the next quiet spell
    if (deps.busy(botId) || readMemoryFile(botId).revision !== memory.revision) {
      log({ ...base, ms: now() - started, result: "conflict" });
      return arm(botId);
    }
    let moves = planTidy(raw, reply);
    try {
      // only a plan that moves something reads the history, for the lines someone put back
      if (moves.length) moves = planTidy(raw, reply, historyKeys(botId));
      if (moves.length && !moveOut(botId, raw, memory.revision, moves, now(), deps.tidied)) {
        log({ ...base, ms: now() - started, result: "conflict" });
        return arm(botId);
      }
    } catch (error) {
      log({ ...base, ms: now() - started, result: "error" });
      console.warn(`[memory-sleep] write failed (${error instanceof Error ? error.name : "error"})`);
      return;
    }
    if (moves.length) deps.changed(botId);
    bots.set(botId, { at: started, digest: digestOf(memoryFileRaw(botId), Boolean(generate)) });
    save();
    log({ ...base, moved: moves.length, ms: now() - started, result: moves.length ? "saved" : "none" });
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
