// Dreaming's wrong-note check: lines the owner typed since the last pass, each paired with the notes it may prove wrong, read by both
// dream judges. A fix both agree on that passes the code gates is only listed; it changes MEMORY.md once the user OKs that one item.
import { z } from "zod";

import { eventDays, factsSurvive, neverMoves, type DreamJudges } from "./dream-judge.ts";
import { cleanerSkip, sha8 } from "./memory-clean.ts";
import { buildRecallIndex, searchable, skipped as recallSkipped } from "./memory-lookup.ts";
import { decisionSpan, eligibleRow, quotes, userTyping, type NoteGenerator } from "./memory-pass.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import { negates, noteLines, tokens, type NoteLine } from "./memory-sleep.ts";
import { pickStamp } from "./picks.ts";
import { redactRoomMemory } from "./redact.ts";
import type { Message } from "./store.ts";

export const WRONG_PAIRS_MAX = 30;
export const WRONG_PROMPT_MAX = 32 * 1024;
const EXCERPT_MAX = 480;
const NEAR_HITS = 8;
const YIELD_EVERY = 25;
const FLAGS_MAX = 60;
const TURN_WEIGHT = [1, 1.25, 1.5];
const CLAUSE = /[,;.!?\n]+|\s(?:and|but|or|so)\s|\s-\s/;
const PROMPT_TAGS = /<\/?(?:pairs|pair|note|line)\b[^>]*>/gi;
const BULLET = /^([-*+])\s/;
// someone else's words inside the owner's line
const SPOKEN = /"[^"\n]+"|“[^”\n]+”|「[^」\n]+」|«[^»\n]+»/g;
// an instruction that holds from now on, not a fact a newer line can turn
const STANDING = /^(?:use|reply|answer|write|keep|call|ask|send|show|put|add|avoid|prefer|check|run|make|give|start|stop|treat)\b|\b(?:every|each time|whenever|from now on|by default)\b/i;

/** guarded: the line may hold a login or code, so no judge reads it; it still counts as a later word on a note. */
export type OwnerRow = { thread: string; id: string; at: number; text: string; guarded?: true };
/** When Auto Notes saved a batch of notes, and what its receipt says it saved. */
export type SavedNotes = { at: number; text: string };
export type FixItem = {
  op: "fix"; target: string; text: string; by: string; why: "wrong"; listOnly: boolean;
  evidence: { thread: string; message: string; at: number; quote: string };
  /** set once the user OKs it: where the new line went, which copy of it, the heading above it and the old line's ending, so Undo puts the old bytes back on that line only */
  done?: FixDone;
  /** when an OK found a newer owner line about the note, or its own line no longer stating the new value alone; it never takes an OK again */
  outdated?: number;
};
export type FixDone = { at: number; line: number; cr: boolean; nth: number; count: number; heading: string; id: string; undoneAt?: number };
export type JudgeLog = { input: number; output: number; ms: number };
type Pair = { note: NoteLine; row: OwnerRow; sentence: string; turning: number; score: number };
type Wrong = { note: string; message: string; quote: string; fix: string };

const replySchema = z.object({ wrong: z.array(z.object({ note: z.string(), message: z.string(), quote: z.string(), fix: z.string() })).max(FLAGS_MAX) });

const day = (at: number) => pickStamp(at).slice(0, 10);
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
// the day a note was written: its stamp, else the first day it names
const noted = (note: NoteLine, today: string) => note.date ?? eventDays(note.text, today)[0];
const plain = (line: string) => line.replace(/\r$/, "");
const body = (text: string) => text.replace(/^\s*[-*+]\s+/, "").replace(/\s*\(noted \d{4}-\d{2}-\d{2}\)\s*$/, "").trim();
const lowWords = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** The owner's own typing in these rows after `since`; a line that may hold a login or code is marked guarded. */
export function ownerRows(thread: string, messages: readonly Message[], since: number): OwnerRow[] {
  return messages.flatMap((message) => {
    if (message.at <= since || !eligibleRow(message)) return [];
    // a message cut whole as sensitive still counts as a later word on a note, read here only
    const safe = userTyping(message.text);
    const text = safe.trim() ? safe : userTyping(message.text, false);
    if (!text.trim()) return [];
    const row: OwnerRow = { thread, id: message.id, at: message.at, text };
    if (text !== safe || cleanerSkip(text)) row.guarded = true;
    return [row];
  });
}

/** The Auto Notes receipts in these rows. */
export function savedNotes(messages: readonly Message[]): SavedNotes[] {
  return messages.flatMap((message) => message.kind === "activity" && message.tool?.name === MEMORY_SAVE_TOOL && message.tool.spoken ? [{ at: message.at, text: message.tool.spoken }] : []);
}

/** The notes a fix may target: top-level bullets and the decisions, never one that may hold a login or code. */
export function fixTargets(raw: string): Map<number, NoteLine> {
  const all = raw.split("\n").map(plain);
  const span = decisionSpan(all);
  const decisions: NoteLine[] = span ? all.flatMap((text, at) => (at > span[0] && at < span[1] && BULLET.test(text) ? [{ at, text, section: span[0], alone: true }] : [])) : [];
  return new Map([...noteLines(raw), ...decisions].filter((line) => !cleanerSkip(line.text)).map((line) => [line.at, line]));
}

const stem = (word: string) => (word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, "") : word).slice(0, 6);
const content = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !recallSkipped(word) && !/^\d+$/.test(word)).map(stem));
const NUMBER = /\d+(?:[.,:/-]\d+)*/g;
// a line's subject words, as the pairing weighs them, and its numbers whole, so 9.50 and 2.1 count
const wordsOf = (text: string) => new Set([...content(text), ...(text.match(NUMBER) ?? [])]);
const shares = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].some((word) => b.has(word));

/** The line names a word of the note's subject: it is a later word on that note, whatever it says. */
export function touches(note: string, line: string): boolean {
  return shares(wordsOf(body(note)), wordsOf(line));
}

/** A line can propose the fix only when it holds a word only the fix has and none only the old note has: "January, not March" keeps January. */
export function proposes(note: string, by: string, line: string): boolean {
  const [old, next, words] = [wordsOf(body(note)), wordsOf(body(by)), wordsOf(line)];
  const gone = [...old].filter((word) => !next.has(word));
  const added = [...next].filter((word) => !old.has(word));
  return gone.length > 0 && !gone.some((word) => words.has(word)) && added.some((word) => words.has(word));
}

/** An owner line after the fix's own line names the note or the fix, so the fix waits for a pass that reads it. */
export function outdated(item: Pick<FixItem, "text" | "by" | "evidence">, rows: readonly OwnerRow[]): boolean {
  return rows.some((row) => row.id !== item.evidence.message && row.at >= item.evidence.at && (touches(item.text, row.text) || touches(item.by, row.text)));
}

/** Each note a line may show wrong, best first, paired with every owner line that names it, oldest first. */
export async function wrongPairs(raw: string, notes: ReadonlyMap<number, NoteLine>, all: readonly OwnerRow[], signal?: AbortSignal): Promise<Pair[]> {
  const rows = all.filter((row) => !row.guarded);
  if (!rows.length || !notes.size) return [];
  const noteWords = new Map([...notes.values()].map((line) => [line.at, content(line.text)]));
  const counts = new Map<string, number>();
  for (const words of noteWords.values()) for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const idf = (word: string) => Math.log(1 + notes.size / (1 + (counts.get(word) ?? 0)));
  // how much of the note's subject the clause names, rare shared words weighing most; doubled when a turning word sits within 3 words of one, as in "groups not rooms"
  const overlap = (clause: string, note: NoteLine, groups: string[][]) => {
    const said = new Set([...content(clause), ...groups.filter((options) => !recallSkipped(options[0]!)).flat().map(stem)]);
    const shared = [...noteWords.get(note.at)!].filter((word) => said.has(word));
    const weight = shared.reduce((sum, word) => sum + Math.max(0, idf(word)), 0);
    const list = tokens(clause).map((token) => token.toLowerCase());
    const turned = list.some((token, at) => negates(token) && list.slice(Math.max(0, at - 3), at + 4).some((near) => shared.includes(stem(near.replace(/[^\p{L}\p{N}]/gu, "")))));
    return turned ? weight * 2 : weight;
  };
  const index = await buildRecallIndex([{ source: "MEMORY.md", tier: 0, text: raw, mtime: Date.now() }]);
  const found = new Map<string, Pair>();
  try {
    for (const [count, row] of rows.entries()) {
      if (count % YIELD_EVERY === YIELD_EVERY - 1) {
        await yieldLoop();
        if (signal?.aborted) throw signal.reason;
      }
      const turnsRow = tokens(row.text).some(negates);
      // the whole line, each clause, and each two clauses side by side
      const parts = row.text.split(CLAUSE).map((each) => each.trim()).filter(Boolean);
      const sentences = [...new Set([row.text, ...parts, ...parts.slice(1).map((each, at) => `${parts[at]} ${each}`)])].filter((each) => each.length >= 12);
      for (const sentence of sentences) {
        const terms = index.terms(searchable(sentence));
        const turns = tokens(sentence).some(negates);
        // a line that says a note is wrong rarely repeats its words, so a turning clause skips recall's coverage gate
        if (!terms.list.length || (!turns && !index.possible(terms))) continue;
        const hits = index.hits(terms);
        // recall's gate finds the notes that repeat a line; a wrong note says the same subject in other words, so a turning clause also pairs with its top hits
        for (const hit of new Set([...index.gate(terms, hits), ...(turns ? hits.slice(0, NEAR_HITS) : [])])) {
          const note = notes.get(Number(hit.ref.split(":").at(-1)) - 1);
          if (!note) continue;
          const key = `${note.at}\0${row.id}`;
          const turning = turns ? 2 : turnsRow ? 1 : 0;
          const score = overlap(sentence, note, terms.groups);
          const old = found.get(key);
          if (score > 0 && (!old || turning > old.turning || (turning === old.turning && score > old.score))) found.set(key, { note, row, sentence, turning, score });
        }
      }
    }
  } finally {
    index.close();
  }
  const weighed = (pair: Pair) => pair.score * TURN_WEIGHT[pair.turning]!;
  // a guarded line never reaches a judge; planWrong still counts it as a later word on the note
  const said = [...rows].sort((a, b) => a.at - b.at).map((row) => ({ row, words: wordsOf(row.text) }));
  // each note with every line from its day on that names it, oldest first; only the newest can propose, so a note goes only when that line is a match
  const groups = [...new Set([...found.values()].map((pair) => pair.note))].flatMap((note) => {
    const subject = wordsOf(body(note.text));
    const lines = said.filter(({ row, words }) => (!note.date || day(row.at) >= note.date) && (found.has(`${note.at}\0${row.id}`) || shares(subject, words))).map(({ row }) => row);
    const newest = found.get(`${note.at}\0${lines.at(-1)?.id}`);
    return newest ? [{ newest, pairs: lines.map((row) => found.get(`${note.at}\0${row.id}`) ?? { note, row, sentence: row.text, turning: 0, score: 0 }) }] : [];
  });
  return groups.sort((a, b) => weighed(b.newest) - weighed(a.newest) || b.newest.row.at - a.newest.row.at).flatMap((group) => group.pairs);
}

const excerpt = (pair: Pair) => {
  const { text } = pair.row;
  if (text.length <= EXCERPT_MAX) return text;
  const at = Math.max(0, text.indexOf(pair.sentence) - 120);
  return text.slice(at, at + EXCERPT_MAX);
};
const clean = (text: string) => text.replace(PROMPT_TAGS, " ");

/** Up to WRONG_PAIRS_MAX pairs inside WRONG_PROMPT_MAX bytes, each note with all its lines or none; refs names each sent pair by its M ref. */
export function wrongPrompt(pairs: readonly Pair[], today: string) {
  const head = [
    `Today is ${today}. You check a bot's notes against lines its owner typed later. Only the owner's lines are evidence.`,
    "Each PAIR is one note (L<n>, with the day it was written when known) and one owner line (M<n>, with its time) that may be about it.",
    "The pairs for one note come oldest line first. Only the newest line about a note can show it wrong: when it restates the note, takes a change back or says nothing new, the note stands.",
    "Flag a note only when the owner line clearly states that the note is wrong now: same subject, and the two cannot both be true. A line that asks, guesses, jokes, agrees, adds a detail, narrows the scope or talks about something else is not evidence. No evidence is not wrong. When unsure, leave it out.",
    "For each flag: note (L<n>), message (M<n>), quote (3 to 25 words copied exactly from that owner line, the part that shows the note is wrong), fix (the note rewritten as one line that agrees with the quote and keeps the rest of the note).",
    'Reply with JSON only: {"wrong": [{"note": "L9", "message": "M3", "quote": "...", "fix": "..."}]}, or {"wrong": []} when nothing qualifies.',
    "",
    "<pairs>",
  ];
  const body: string[] = [];
  const refs = new Map<string, Pair>();
  let size = Buffer.byteLength(head.join("\n")) + 20;
  const groups = new Map<number, Pair[]>();
  for (const pair of pairs) groups.set(pair.note.at, [...(groups.get(pair.note.at) ?? []), pair]);
  for (const group of groups.values()) {
    if (refs.size + group.length > WRONG_PAIRS_MAX) continue;
    const blocks = group.map((pair, index) => {
      const ref = `M${refs.size + index + 1}`;
      return { ref, pair, text: `PAIR\nL${pair.note.at + 1} (written ${noted(pair.note, today) ?? "unknown"}): ${clean(pair.note.text)}\n${ref} (${pickStamp(pair.row.at).slice(0, 16)}): ${clean(excerpt(pair))}\n` };
    });
    const bytes = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text) + 1, 0);
    if (size + bytes > WRONG_PROMPT_MAX) continue;
    size += bytes;
    for (const block of blocks) {
      body.push(block.text);
      refs.set(block.ref, block.pair);
    }
  }
  return { prompt: [...head, ...body, "</pairs>"].join("\n"), refs };
}

/** The judge's flags; null when the reply is not the JSON asked for. */
export function parseWrong(output: string): Wrong[] | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const parsed = replySchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data.wrong : null;
  } catch {
    return null;
  }
}

// one quote holds the other, or they share a run of 4 words
const sameQuote = (a: string, b: string) => {
  const [x, y] = [lowWords(a), lowWords(b)];
  const [sx, sy] = [x.join(" "), ` ${y.join(" ")} `];
  if (sx.includes(y.join(" ")) || sy.includes(` ${sx} `)) return true;
  for (let at = 0; at + 4 <= x.length; at++) if (sy.includes(` ${x.slice(at, at + 4).join(" ")} `)) return true;
  return false;
};

/** The fix as one line, with the old line's bullet. */
export function fixLine(old: string, by: string): string {
  const line = by.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const mark = BULLET.exec(old)?.[1];
  return mark && !BULLET.test(line) ? `${mark} ${line}` : line;
}

/** Only a hand edit: no stamp to order it by, lines under it, a line no judge may move, or a standing instruction. */
export function handOnly(note: NoteLine, all: readonly string[]): boolean {
  return !note.date || !note.alone || neverMoves(note, all) || STANDING.test(body(note.text));
}

// the quote as the owner typed it: quotes() folds case and spacing; none when it sits in someone else's quoted words
function typedSpan(text: string, quote: string): string | null {
  const found = new RegExp(quote.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "iu").exec(text);
  if (!found) return null;
  const end = found.index + found[0].length;
  return [...text.matchAll(SPOKEN)].some((spoken) => spoken.index < end && found.index < spoken.index + spoken[0].length) ? null : found[0];
}

export type Rejected = { note: number; message: string; why: string };
/** rows: every owner line the pass read, guarded ones too. */
export type WrongContext = { all: readonly string[]; today: string; written(note: NoteLine): number | undefined; rows: readonly OwnerRow[] };

/** Flags both judges agree on that pass the code gates, as items; nothing is applied. */
export function planWrong(a: readonly Wrong[], b: readonly Wrong[], refs: ReadonlyMap<string, Pair>, context: WrongContext) {
  const items: FixItem[] = [];
  const rejected: Rejected[] = [];
  // the lines sent with each note, a recall match that names none of its words included
  const sent = new Map<number, OwnerRow[]>();
  for (const pair of refs.values()) sent.set(pair.note.at, [...(sent.get(pair.note.at) ?? []), pair.row]);
  for (const one of a) {
    const pair = refs.get(one.message);
    // a flag names the note it was paired with, never one from another pair
    if (!pair || one.note !== `L${pair.note.at + 1}`) continue;
    const { note, row } = pair;
    const target = `note:${sha8(note.text)}`;
    // the newest owner line that agrees wins, whatever order the judge listed it in
    const held = items.findIndex((item) => item.target === target);
    if (held >= 0 && items[held]!.evidence.at >= row.at) continue;
    const no = (why: string) => rejected.push({ note: note.at + 1, message: row.id, why });
    const other = b.find((each) => each.note === one.note && each.message === one.message);
    if (!other) {
      no("one judge only");
      continue;
    }
    if (!quotes(row.text, one.quote) || !quotes(row.text, other.quote)) {
      no("quote not word for word in that row");
      continue;
    }
    if (!sameQuote(one.quote, other.quote)) {
      no("judges quote different words");
      continue;
    }
    const written = noted(note, context.today);
    // the same day orders by time: the owner's line after the Auto Notes save that wrote the note
    const saved = written === day(row.at) ? context.written(note) : undefined;
    if (written && (day(row.at) < written || (day(row.at) === written && (saved === undefined || row.at <= saved)))) {
      no("row not after the note");
      continue;
    }
    const quote = typedSpan(row.text, lowWords(one.quote).length <= lowWords(other.quote).length ? one.quote : other.quote);
    if (!quote) {
      no("quote is not the owner's own typing");
      continue;
    }
    const days = eventDays(note.text, context.today);
    const said = eventDays(row.text, context.today);
    if (days.length && said.length && !said.some((each) => days.includes(each))) {
      no("row is about another day's event");
      continue;
    }
    const by = [one.fix, other.fix].map((fix) => fixLine(note.text, fix)).find((fix) => body(fix) && fix !== note.text && factsSurvive(fix, [note.text, row.text]) && redactRoomMemory(fix) === fix);
    if (!by || redactRoomMemory(note.text) !== note.text) {
      no("fix not grounded in the old line and the quote");
      continue;
    }
    const item: FixItem = {
      op: "fix", target, text: note.text, by, why: "wrong", listOnly: handOnly(note, context.all),
      evidence: { thread: row.thread, message: row.id, at: row.at, quote },
    };
    // only the newest line about the note or the fix may propose, and only one that drops the old value
    if (outdated(item, context.rows) || sent.get(note.at)!.some((each) => each.id !== row.id && each.at >= row.at)) {
      no("a later row is about it");
      continue;
    }
    if (!proposes(note.text, by, row.text)) {
      no("row still holds the old value or not the new one");
      continue;
    }
    if (held >= 0) items[held] = item;
    else items.push(item);
  }
  return { items, rejected };
}

/** When Auto Notes saved this note: the first receipt on its stamp day that names it. */
export function writtenAt(saved: readonly SavedNotes[]) {
  return (note: NoteLine) => {
    const text = body(note.text).toLowerCase();
    return text && note.date ? saved.filter((each) => day(each.at) === note.date && each.text.toLowerCase().includes(text)).map((each) => each.at).sort((p, q) => p - q)[0] : undefined;
  };
}

/** judged: the notes both judges read against a newer owner line this pass, fixed or not. */
export type WrongCheck = { state: "checked" | "no-model"; items: FixItem[]; judged: string[]; pairs: number; bytes: number; logs: Partial<Record<keyof DreamJudges, JudgeLog>>; reason?: string };

/** One pass: pair, ask both judges once, keep what both agree on and the gates pass. */
export async function checkWrong(input: { raw: string; rows: readonly OwnerRow[]; saved: readonly SavedNotes[]; judges: DreamJudges; today: string; signal: AbortSignal; now(): number }): Promise<WrongCheck> {
  const logs: WrongCheck["logs"] = {};
  const notes = fixTargets(input.raw);
  const { prompt, refs } = wrongPrompt(await wrongPairs(input.raw, notes, input.rows, input.signal), input.today);
  const none: FixItem[] = [];
  const judged: string[] = [];
  const base = { items: none, judged, pairs: refs.size, bytes: refs.size ? Buffer.byteLength(prompt) : 0, logs };
  if (!refs.size) return { state: "checked", ...base };
  const { claude, gemini } = input.judges;
  if (!claude || !gemini) return { state: "no-model", ...base, reason: `${[!claude && "claude", !gemini && "gemini"].filter(Boolean).join(" and ")} judge unavailable` };
  const ask = async (name: keyof DreamJudges, generate: NoteGenerator) => {
    const spent: JudgeLog = { input: 0, output: 0, ms: 0 };
    logs[name] = spent;
    const started = input.now();
    try {
      return parseWrong(await generate(prompt, input.signal, (usage) => {
        spent.input += usage?.input ?? 0;
        spent.output += usage?.output ?? 0;
      }));
    } finally {
      spent.ms = input.now() - started;
    }
  };
  const [a, b] = await Promise.allSettled([ask("claude", claude), ask("gemini", gemini)]);
  if (input.signal.aborted) throw input.signal.reason;
  if (a.status === "rejected" || b.status === "rejected" || !a.value || !b.value) {
    const failed = a.status === "rejected" || (a.status === "fulfilled" && !a.value) ? a : b;
    return { state: "no-model", ...base, reason: `${failed === a ? "claude" : "gemini"} judge ${failed.status === "rejected" ? "failed" : "reply unreadable"}` };
  }
  const all = input.raw.split("\n").map(plain);
  return { state: "checked", ...base, judged: [...new Set([...refs.values()].map((pair) => `note:${sha8(pair.note.text)}`))], items: planWrong(a.value, b.value, refs, { all, today: input.today, written: writtenAt(input.saved), rows: input.rows }).items };
}

// the lines that read as the fix, and the heading above one
const copies = (lines: readonly string[], by: string) => lines.flatMap((line, index) => (plain(line) === by ? [index] : []));
const headingAbove = (lines: readonly string[], at: number) => lines.slice(0, at).map(plain).findLast((line) => line.startsWith("#")) ?? "";

/** raw with the note's one line swapped for its fix, its own line ending kept; null unless the line is there exactly once and still takes an OK. */
export function applyFix(raw: string, item: Pick<FixItem, "target" | "by">): ({ text: string } & Omit<FixDone, "at" | "id" | "undoneAt">) | null {
  const lines = raw.split("\n");
  const at = lines.flatMap((line, index) => (`note:${sha8(plain(line))}` === item.target ? [index] : []));
  if (at.length !== 1) return null;
  // the line may have moved under a pinned heading or taken lines under it since it was listed
  const note = fixTargets(raw).get(at[0]!);
  if (!note || handOnly(note, lines.map(plain))) return null;
  const cr = lines[at[0]!]!.endsWith("\r");
  lines[at[0]!] = item.by + (cr ? "\r" : "");
  const same = copies(lines, item.by);
  return { text: lines.join("\n"), line: at[0]!, cr, nth: same.indexOf(at[0]!), count: same.length, heading: headingAbove(lines, at[0]!) };
}

/** raw with the fixed line back to the old one, byte for byte; changed when no line reads as the fix, conflict when which one is ours is unclear, so every copy stays. */
export function undoFix(raw: string, item: Pick<FixItem, "text" | "by" | "done">): { text: string } | { error: "changed" | "conflict" } {
  if (!item.done) return { error: "changed" };
  const lines = raw.split("\n");
  const same = copies(lines, item.by);
  if (!same.length) return { error: "changed" };
  const at = same[item.done.nth];
  // a copy came or went since the OK, or ours moved under another heading
  if (same.length !== item.done.count || at === undefined || headingAbove(lines, at) !== item.done.heading) return { error: "conflict" };
  lines[at] = item.text + (item.done.cr ? "\r" : "");
  return { text: lines.join("\n") };
}
