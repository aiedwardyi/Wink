// The idle tidy ("sleep"): once a bot has been quiet a while, merge duplicate notes and asks and move a note a newer one
// replaced into a monthly history file. It only ever removes lines from MEMORY.md, so it cannot bring back what the user deleted.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { contentWords, decisionSpan, sameStem, type NoteGenerator } from "./memory-pass.ts";
import { pickStamp } from "./picks.ts";
import { isOpenAsk, type TaskAsk } from "./task-asks.ts";
import { ensureWorkspace, memoryFileRaw, readMemoryFile, readMemoryTopic, saveMemoryFile } from "./workspace.ts";

export const SLEEP_IDLE_MS = 30 * 60_000;
export const SLEEP_GAP_MS = 6 * 60 * 60_000;
export const SLEEP_TIMEOUT_MS = 120_000;
const PROMPT_NOTES_MAX = 32_000;
const PROMPT_ASKS_MAX = 32_000;
const MOVES_MAX = 20;
const SHARED = 0.5;
const STATE_FILE = "memory-sleep.json";
const HISTORY_HEAD =
  "# Memory history\n\nLines the idle tidy moved out of MEMORY.md and asks it closed, oldest first. Nothing here loads into the prompt; copy a line back to MEMORY.md to restore it.\n";

const refsSchema = z.array(z.string()).max(MOVES_MAX);
const tidySchema = z.object({
  duplicates: z.array(z.object({ keep: z.string(), drop: refsSchema })).max(MOVES_MAX).nullish(),
  disagree: z.array(z.tuple([z.string(), z.string()])).max(MOVES_MAX).nullish(),
});
const botStateSchema = z.object({ digest: z.string().optional(), at: z.number().optional(), notice: z.string().optional(), flagged: z.array(z.string()).optional() });
const stateSchema = z.object({ bots: z.record(z.string(), botStateSchema) });

type BotState = z.infer<typeof botStateSchema>;
export type NoteLine = { at: number; text: string; date?: string };
export type Why = "duplicate" | "replaced";
export type Tidy = {
  notes: Array<{ at: number; text: string; by: string; why: Why }>;
  asks: Array<{ ask: TaskAsk; by: TaskAsk; why: Why }>;
  flagged: Array<[string, string]>;
};

interface SleepLog {
  botId: string;
  notes?: number;
  sentNotes?: number;
  asks?: number;
  sentAsks?: number;
  input?: number;
  output?: number;
  moved?: number;
  closed?: number;
  flagged?: number;
  ms: number;
  result: "saved" | "none" | "conflict" | "error";
}

export interface MemorySleepDeps {
  dataDir: string;
  /** Every bot at boot, so a tidy owed before a restart still runs. */
  bots(): string[];
  generate(botId: string): NoteGenerator | null;
  /** The bot's Auto notes switch, read live. */
  enabled(botId: string): boolean;
  /** Any turn of the bot running. */
  busy(botId: string): boolean;
  /** The open asks on the bot's own chat. */
  asks(botId: string): { threadId: string; asks: readonly TaskAsk[] } | null;
  /** Saves what change returns; null saves nothing. */
  saveAsks(threadId: string, change: (asks: readonly TaskAsk[]) => TaskAsk[] | null): void;
  now?(): number;
}

export interface MemorySleep {
  /** Call when any turn of the bot settles: the tidy waits for SLEEP_IDLE_MS of quiet. */
  onSettled(botId: string): void;
  /** What the last tidy changed, once; "" when nothing waits. */
  take(botId: string): string;
  idle(): Promise<void>;
  dispose(): void;
}

const BULLET = /^[-*+]\s+\S/;
const FENCE = /^\s*(?:```|~~~)/;
const STAMP = /\(noted (\d{4}-\d{2}-\d{2})\)/;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NEGATION = /(?:^|[^\p{L}])(?:not|no|never|don't|dont|without|avoid|stop)(?![\p{L}])/iu;
const PROMPT_TAGS = /<\/?(?:notes|asks)\b[^>]*>/gi;
const STATUS_RANK = { building: 0, "waiting-for-user": 1, open: 2, done: 3, declined: 3 } satisfies Record<TaskAsk["status"], number>;

const withoutStamp = (text: string) => text.replace(STAMP, " ");
/** Same words in the same order, whatever the case, punctuation or Auto Notes stamp. */
const plain = (text: string) => (withoutStamp(text).replace(/^\s*[-*+]\s+/, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
const literals = (text: string) =>
  withoutStamp(text).toLowerCase().split(/\s+/).map((token) => token.replace(/^[("'`]+|[)"'`,;:.!?]+$/g, "")).filter((token) => token.length > 1 && /[\d\\/.@:]/.test(token));
const ref = (line: NoteLine) => `L${line.at + 1}`;
const day = (now: number) => pickStamp(now).slice(0, 10);

/** MEMORY.md's top-level bullets outside code and the Auto Notes decisions, each with its date: the Auto Notes stamp, else the last date it names. */
export function noteLines(raw: string): NoteLine[] {
  const lines = raw.split("\n");
  const span = decisionSpan(lines);
  let fenced = false;
  return lines.flatMap((line, at) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return [];
    }
    const text = line.replace(/\r$/, "");
    if (fenced || !BULLET.test(text) || (span && at > span[0] && at < span[1])) return [];
    const date = STAMP.exec(text)?.[1] ?? text.match(DATE)?.at(-1);
    return [date ? { at, text, date } : { at, text }];
  });
}

/** keep says all drop says: most of its words, every number, path and name in it, and the same yes or no. */
export function covers(keep: string, drop: string): boolean {
  const need = contentWords(withoutStamp(drop));
  const have = contentWords(withoutStamp(keep));
  if (!need.length) return false;
  const hits = need.filter((word) => have.some((other) => sameStem(word, other))).length;
  const kept = withoutStamp(keep).toLowerCase();
  return hits / need.length >= SHARED && literals(drop).every((literal) => kept.includes(literal)) && NEGATION.test(drop) === NEGATION.test(keep);
}

const related = (a: string, b: string) => contentWords(withoutStamp(a)).some((word) => contentWords(withoutStamp(b)).some((other) => sameStem(word, other)));
const better = (a: TaskAsk, b: TaskAsk) =>
  STATUS_RANK[a.status] - STATUS_RANK[b.status] || Number(Boolean(b.ref)) - Number(Boolean(a.ref)) || a.at - b.at;

export function tidyPrompt(notes: NoteLine[], asks: readonly TaskAsk[]): string {
  const clean = (text: string) => text.replace(PROMPT_TAGS, " ");
  return [
    "You tidy a bot's notes and its list of the user's open asks. Find only two things:",
    "- duplicates: entries that say the same thing. keep is the one that says it best; drop lists the ones it fully covers.",
    "- disagree: two entries about the same thing that cannot both be true now, like a preference the user later changed.",
    "Compare notes with notes (L ids) and asks with asks (A ids). Entries that add different details are not duplicates. Never judge which side is right.",
    'Reply with JSON only: {"duplicates": [{"keep": "L3", "drop": ["L9"]}], "disagree": [["L4", "L12"]]}, or {"duplicates": [], "disagree": []} when nothing qualifies.',
    "",
    "NOTES:",
    "<notes>",
    ...notes.map((line) => `${ref(line)}: ${clean(line.text)}`),
    "</notes>",
    "",
    "OPEN ASKS:",
    "<asks>",
    ...asks.map((ask) => `${ask.id}: ${clean(ask.ask)}`),
    "</asks>",
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

/** What to move: every same-word duplicate, then up to MOVES_MAX of the model's duplicates and disagreements that pass the checks. A disagreement moves the older line only when both are dated; otherwise both stay, flagged. */
export function planTidy(raw: string, asks: readonly TaskAsk[], reply = ""): Tidy {
  const lines = noteLines(raw);
  const notes = new Map(lines.map((line) => [ref(line), line] as const));
  const open = new Map(asks.filter((ask) => isOpenAsk(ask) && ask.kind !== "question").map((ask) => [ask.id, ask] as const));
  const tidy: Tidy = { notes: [], asks: [], flagged: [] };
  const gone = new Set<string>();
  const kept = new Set<string>();
  let guessed = 0;
  // same-word merges are certain; a model's moves are capped per run
  const move = (drop: string, keep: string, why: Why, model = true) => {
    if ((model && guessed >= MOVES_MAX) || drop === keep || gone.has(drop) || gone.has(keep) || kept.has(drop)) return;
    const [line, by] = [notes.get(drop), notes.get(keep)];
    const [ask, over] = [open.get(drop), open.get(keep)];
    if (line && by) tidy.notes.push({ at: line.at, text: line.text, by: by.text, why });
    else if (ask && over) tidy.asks.push({ ask, by: over, why });
    else return;
    if (model) guessed += 1;
    gone.add(drop);
    kept.add(keep);
  };
  const first = new Map<string, string>();
  for (const line of lines) {
    const key = `L ${plain(line.text)}`;
    if (key === "L ") continue;
    const earlier = first.get(key);
    if (earlier) move(ref(line), earlier, "duplicate", false);
    else first.set(key, ref(line));
  }
  const sameAsk = new Map<string, TaskAsk>();
  for (const ask of [...open.values()].sort(better)) {
    const key = plain(ask.ask);
    const earlier = sameAsk.get(key);
    if (earlier) move(ask.id, earlier.id, "duplicate", false);
    else if (key) sameAsk.set(key, ask);
  }
  const { duplicates, disagree } = parseTidy(reply);
  for (const { keep, drop } of duplicates ?? []) {
    for (const each of drop) {
      const [line, by] = [notes.get(each), notes.get(keep)];
      if (line && by && covers(by.text, line.text)) move(each, keep, "duplicate");
      const [ask, over] = [open.get(each), open.get(keep)];
      if (ask && over && (covers(over.ask, ask.ask) || covers(ask.ask, over.ask))) {
        const [win, lose] = better(over, ask) <= 0 ? [over, ask] : [ask, over];
        move(lose.id, win.id, "duplicate");
      }
    }
  }
  for (const [a, b] of disagree ?? []) {
    const [x, y] = [notes.get(a), notes.get(b)];
    if (x && y && x !== y && related(x.text, y.text) && !gone.has(a) && !gone.has(b)) {
      if (x.date && y.date && x.date !== y.date) {
        const [older, newer] = x.date < y.date ? [a, b] : [b, a];
        move(older, newer, "replaced");
      } else if (!tidy.flagged.some(([p, q]) => (p === x.text && q === y.text) || (p === y.text && q === x.text))) {
        tidy.flagged.push([x.text, y.text]);
      }
    }
    const [p, q] = [open.get(a), open.get(b)];
    if (p && q && p !== q && related(p.ask, q.ask)) {
      const [older, newer] = p.at <= q.at ? [p, q] : [q, p];
      move(older.id, newer.id, "replaced");
    }
  }
  return tidy;
}

/** raw without the lines at these indexes; nothing is ever added. */
export function withoutLines(raw: string, at: readonly number[]): string {
  const drop = new Set(at);
  return raw.split("\n").filter((_, index) => !drop.has(index)).join("\n");
}

export const historyFile = (now: number) => `history-${pickStamp(now).slice(0, 7)}.md`;

const quoted = (line: string) => JSON.stringify(line.replace(/^\s*[-*+]\s+/, ""));
const askText = (ask: TaskAsk) => `${ask.id} ${JSON.stringify(ask.ask)}`;

export function historyEntry(tidy: Tidy, now: number): string {
  const date = day(now);
  const why = (reason: Why) => (reason === "duplicate" ? " (duplicate)" : "");
  return [
    `## ${pickStamp(now)}`,
    ...tidy.notes.map(({ text, by, why: reason }) => `- ${quoted(text)} replaced by ${quoted(by)}, ${date}${why(reason)}`),
    ...tidy.asks.map(({ ask, by, why: reason }) => `- Ask ${askText(ask)} (${ask.status}${ask.ref ? `, ${ask.ref}` : ""}) replaced by ${askText(by)}, ${date}${why(reason)}`),
    ...tidy.flagged.map(([a, b]) => `- May disagree, both kept in MEMORY.md: ${quoted(a)} / ${quoted(b)}`),
  ].join("\n");
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function tidyNotice(tidy: Tidy, file: string): string {
  const notes = (why: Why) => tidy.notes.filter((move) => move.why === why).length;
  const asks = (why: Why) => tidy.asks.filter((move) => move.why === why).map(({ ask, by }) => `${ask.id} into ${by.id}`);
  const parts = [
    notes("duplicate") ? `merged ${count(notes("duplicate"), "duplicate note")}` : "",
    notes("replaced") ? `moved out ${count(notes("replaced"), "note")} a newer one replaced` : "",
    asks("duplicate").length ? `closed duplicate asks ${asks("duplicate").join(", ")}` : "",
    asks("replaced").length ? `closed replaced asks ${asks("replaced").join(", ")}` : "",
    tidy.flagged.length ? `${count(tidy.flagged.length, "pair")} of notes may disagree, both kept; ask the user which is right` : "",
  ].filter(Boolean);
  return parts.length ? `[Memory tidied while idle: ${parts.join("; ")}. Old lines and pairs: memory/${file}.]` : "";
}

/** Closes each planned ask still open with the same words, as merged into or replaced by one still open. */
export function closeAsks(current: readonly TaskAsk[], moves: Tidy["asks"], now: number): TaskAsk[] | null {
  const live = new Map(current.filter(isOpenAsk).map((ask) => [ask.id, ask] as const));
  const closing = new Map(
    moves.filter(({ ask, by }) => live.get(ask.id)?.ask === ask.ask && live.get(by.id)?.ask === by.ask).map((move) => [move.ask.id, move] as const),
  );
  if (!closing.size) return null;
  return current.map((ask) => {
    const move = closing.get(ask.id);
    return move ? { ...ask, status: "declined" as const, ref: `${move.why === "duplicate" ? "merged into" : "replaced by"} ${move.by.id}`, changedAt: now } : ask;
  });
}

const pairKey = ([a, b]: [string, string]) => createHash("sha256").update(JSON.stringify([a, b].sort())).digest("hex").slice(0, 16);

/** Tidies each bot's MEMORY.md and asks once it has been quiet SLEEP_IDLE_MS, only when either changed since its last tidy, at most once per SLEEP_GAP_MS. Never on the reply path. */
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

  const digestOf = (raw: string, asks: readonly TaskAsk[], model: boolean) =>
    createHash("sha256").update(JSON.stringify([raw, asks.filter(isOpenAsk).map(({ id, ask, status }) => [id, ask, status]), model])).digest("hex").slice(0, 16);

  const run = async (botId: string, signal: AbortSignal) => {
    if (!deps.enabled(botId)) return;
    if (deps.busy(botId)) return arm(botId);
    const record = bots.get(botId) ?? {};
    const raw = memoryFileRaw(botId);
    const memory = readMemoryFile(botId);
    const book = deps.asks(botId);
    const generate = deps.generate(botId);
    const digest = digestOf(raw, book?.asks ?? [], Boolean(generate));
    if (record.digest === digest) return;
    if (record.at !== undefined && now() - record.at < SLEEP_GAP_MS) return arm(botId, record.at + SLEEP_GAP_MS - now());
    const started = now();
    const lines = noteLines(raw);
    const open = (book?.asks ?? []).filter((ask) => isOpenAsk(ask) && ask.kind !== "question");
    let used = 0;
    const shownNotes = lines.filter((line) => (used += Buffer.byteLength(line.text, "utf8") + 8) <= PROMPT_NOTES_MAX);
    used = 0;
    const shownAsks = open.filter((ask) => (used += Buffer.byteLength(ask.ask, "utf8") + 12) <= PROMPT_ASKS_MAX);
    const usage = { input: 0, output: 0 };
    let reply = "";
    if (generate && shownNotes.length + shownAsks.length > 1) {
      try {
        reply = await generate(tidyPrompt(shownNotes, shownAsks), signal, (spent) => {
          usage.input += (spent?.input ?? 0) + (spent?.cachedInput ?? 0) + (spent?.cacheCreation ?? 0);
          usage.output += spent?.output ?? 0;
        });
      } catch {
        if (!disposed && !signal.aborted) log({ botId, ms: now() - started, result: "error" });
        return;
      }
    }
    if (disposed || signal.aborted || !deps.enabled(botId)) return;
    const base = { botId, notes: lines.length, sentNotes: shownNotes.length, asks: open.length, sentAsks: shownAsks.length, ms: 0, ...usage };
    // a turn or an editor may have written while the model ran: theirs wins, the tidy waits for the next quiet spell
    if (deps.busy(botId) || readMemoryFile(botId).revision !== memory.revision) {
      log({ ...base, ms: now() - started, result: "conflict" });
      return arm(botId);
    }
    const tidy = planTidy(raw, deps.asks(botId)?.asks ?? [], reply);
    const known = new Set(record.flagged ?? []);
    const flagged = tidy.flagged.map(pairKey);
    const fresh: Tidy = { ...tidy, flagged: tidy.flagged.filter((pair) => !known.has(pairKey(pair))) };
    const next: BotState = { ...record, at: now() };
    if (flagged.length) next.flagged = flagged;
    else delete next.flagged;
    if (fresh.notes.length || fresh.asks.length || fresh.flagged.length) {
      const file = historyFile(now());
      try {
        const history = readMemoryTopic(botId, file) ?? HISTORY_HEAD;
        // history first: a line leaves MEMORY.md only once its copy is on disk
        writeFileAtomic(join(ensureWorkspace(botId), "memory", file), `${history.trimEnd()}\n\n${historyEntry(fresh, now())}\n`, { mode: 0o600 });
        if (fresh.notes.length && saveMemoryFile(botId, withoutLines(raw, fresh.notes.map(({ at }) => at)), memory.revision).conflict) {
          log({ ...base, ms: now() - started, result: "conflict" });
          return arm(botId);
        }
      } catch (error) {
        log({ ...base, ms: now() - started, result: "error" });
        console.warn(`[memory-sleep] write failed (${error instanceof Error ? error.name : "error"})`);
        return;
      }
      if (fresh.asks.length && book) deps.saveAsks(book.threadId, (current) => closeAsks(current, fresh.asks, now()));
      const notice = tidyNotice(fresh, file);
      next.notice = record.notice ? `${record.notice} ${notice}` : notice;
    }
    next.digest = digestOf(memoryFileRaw(botId), deps.asks(botId)?.asks ?? [], Boolean(generate));
    bots.set(botId, next);
    save();
    log({ ...base, moved: fresh.notes.length, closed: fresh.asks.length, flagged: fresh.flagged.length, ms: now() - started, result: fresh.notes.length || fresh.asks.length || fresh.flagged.length ? "saved" : "none" });
  };

  const pump = () => {
    if (running || disposed) return;
    const botId = queue.shift();
    if (!botId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLEEP_TIMEOUT_MS);
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

  for (const botId of deps.bots()) arm(botId);

  return {
    onSettled: (botId) => arm(botId),
    take(botId) {
      const record = bots.get(botId);
      if (!record?.notice) return "";
      const { notice, ...rest } = record;
      bots.set(botId, rest);
      save();
      return notice;
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
