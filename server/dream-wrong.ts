// Dreaming's wrong-note check: the owner's newest message, paired with the notes it may prove wrong, read whole by both dream judges.
// A fix both agree on that passes the code gates is only listed; it changes MEMORY.md once the user OKs that one item, and only while
// the owner has written nothing since. No code reads a later line to guess whether it takes a fix back.
import { z } from "zod";

import { eventDays, factsSurvive, neverMoves, type DreamJudges } from "./dream-judge.ts";
import { cleanerSkip, sha256, sha8 } from "./memory-clean.ts";
import { buildRecallIndex, searchable, skipped as recallSkipped } from "./memory-lookup.ts";
import { decisionSpan, eligibleRow, quotes, userTyping, type NoteGenerator } from "./memory-pass.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import type { UserMark } from "./message-db.ts";
import { negates, noteLines, tokens, type NoteLine } from "./memory-sleep.ts";
import { pickStamp } from "./picks.ts";
import { redactRoomMemory } from "./redact.ts";
import type { Message } from "./store.ts";

export const WRONG_PAIRS_MAX = 30;
export const WRONG_PROMPT_MAX = 32 * 1024;
// the longest message a judge reads; a longer one never proposes
const WHOLE_MAX = 480;
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

/** guarded: the line may hold a login or code, so no judge reads it. whole: the judges read the message as typed, every word. */
export type OwnerRow = { thread: string; id: string; at: number; text: string; guarded?: true; whole?: true };
/** When Auto Notes saved a batch of notes, and what its receipt says it saved. */
export type SavedNotes = { at: number; text: string };
export type FixItem = {
  op: "fix"; target: string; text: string; by: string; why: "wrong"; listOnly: boolean;
  evidence: { thread: string; message: string; at: number; quote: string };
  /** set once the user OKs it: where the new line went, which copy of it, the heading above it and the old line's ending, so Undo puts the old bytes back on that line only */
  done?: FixDone;
  /** when the judges read it: the owner's newest message then, its text's sha8 and ids, the set of every message the owner had typed; a plan from before has none and takes no OK */
  seen?: { at: number; sha: string; ids?: string };
  /** when an OK found the owner wrote or sent since, or its own line changed; it never takes an OK again */
  outdated?: number;
};
export type FixDone = { at: number; line: number; cr: boolean; nth: number; count: number; heading: string; id: string; undoneAt?: number };
export type JudgeLog = { input: number; output: number; ms: number };
type Pair = { note: NoteLine; row: OwnerRow; sentence: string; turning: number; score: number };
export type StoredRow = UserMark & { thread: string };
export type Newest = { thread: string; id: string; at: number };
type Wrong = { note: string; message: string; quote: string; fix: string };

const replySchema = z.object({ wrong: z.array(z.object({ note: z.string(), message: z.string(), quote: z.string(), fix: z.string() })).max(FLAGS_MAX) });

const day = (at: number) => pickStamp(at).slice(0, 10);
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
// the day a note was written: its stamp, else the first day it names
const noted = (note: NoteLine, today: string) => note.date ?? eventDays(note.text, today)[0];
const plain = (line: string) => line.replace(/\r$/, "");
const body = (text: string) => text.replace(/^\s*[-*+]\s+/, "").replace(/\s*\(noted \d{4}-\d{2}-\d{2}\)\s*$/, "").trim();
const lowWords = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The owner's own typing in these rows after `since`; a line that may hold a login or code is marked guarded. */
export function ownerRows(thread: string, messages: readonly Message[], since: number): OwnerRow[] {
  return messages.flatMap((message) => {
    if (message.at <= since || !eligibleRow(message)) return [];
    const safe = userTyping(message.text);
    const text = safe.trim() ? safe : userTyping(message.text, false);
    if (!text.trim()) return [];
    const row: OwnerRow = { thread, id: message.id, at: message.at, text };
    if (text !== safe || cleanerSkip(text)) row.guarded = true;
    else if (text.length <= WHOLE_MAX && squash(text) === squash(message.text)) row.whole = true;
    return [row];
  });
}

/** A message the owner typed into the chat, any kind or length, skipped by the check or not: a fix judged before it is stale. */
export function ownerTyped(message: { role: string; from?: unknown; origin?: unknown; comm?: unknown; guest?: unknown }): boolean {
  return message.role === "user" && !message.from && !message.origin && !message.comm && !message.guest;
}

/** The exact set of messages the owner typed in these rows: one it lacks changes it, whatever its time or where it came from. */
export function ownedIds(rows: readonly StoredRow[]): string {
  return sha256(rows.filter(ownerTyped).map((row) => `${row.thread}\0${row.id}`).sort().join("\n"));
}

// every order the store keeps: where it was stored, its stamp, when the owner acted, and the send count their window knew
const ORDERS: readonly ((row: StoredRow) => number | null | undefined)[] = [(row) => row.row, (row) => row.at, (row) => row.actedAt, (row) => row.sendSeq];

/** The owner's newest message in any of the bot's chats, only when every order agrees: none of theirs ties or passes it by any order, and none follows it. */
export function newestOwned(rows: readonly StoredRow[], under: (thread: string, id: string) => readonly string[]): Newest | undefined {
  const own = rows.filter(ownerTyped);
  const newest = own.reduce<StoredRow | undefined>((best, row) => (!best || row.row > best.row ? row : best), undefined);
  if (!newest) return undefined;
  const others = own.filter((row) => row !== newest);
  // a held send lands after a newer one, a peer's clock runs behind: one order that does not put it last is enough to abstain
  for (const order of ORDERS) {
    const mine = order(newest);
    const theirs = others.map(order).filter((each) => typeof each === "number");
    if (theirs.length && (typeof mine !== "number" || theirs.some((each) => each >= mine))) return undefined;
  }
  if (others.some((row) => row.thread === newest.thread && [row.parentId, row.sentAfterId, row.replyToId].includes(newest.id))) return undefined;
  const below = new Set(under(newest.thread, newest.id));
  if (others.some((row) => row.thread === newest.thread && below.has(row.id))) return undefined;
  return { thread: newest.thread, id: newest.id, at: newest.at };
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
/** A line can propose the fix only when it holds a word only the fix has and none only the old note has: "January, not March" keeps January. */
export function proposes(note: string, by: string, line: string): boolean {
  const [old, next, words] = [wordsOf(body(note)), wordsOf(body(by)), wordsOf(line)];
  const gone = [...old].filter((word) => !next.has(word));
  const added = [...next].filter((word) => !old.has(word));
  return gone.length > 0 && !gone.some((word) => words.has(word)) && added.some((word) => words.has(word));
}

/** Each note a line may show wrong, paired with that line, best first. */
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
  return [...found.values()].sort((a, b) => weighed(b) - weighed(a) || b.row.at - a.row.at);
}

const clean = (text: string) => text.replace(PROMPT_TAGS, " ");
const ownerLine = (ref: string, row: OwnerRow) => `${ref} (${pickStamp(row.at).slice(0, 16)}): ${row.text}`;

/** Up to WRONG_PAIRS_MAX pairs inside WRONG_PROMPT_MAX bytes; refs names each sent pair by its M ref, only when the prompt holds its owner line as typed. */
export function wrongPrompt(pairs: readonly Pair[], today: string) {
  const head = [
    `Today is ${today}. You check a bot's notes against lines its owner typed later. Only the owner's lines are evidence.`,
    "Each PAIR is one note (L<n>, with the day it was written when known) and one owner line (M<n>, with its time) that may be about it.",
    "Flag a note only when the owner line clearly states that the note is wrong now: same subject, and the two cannot both be true. A line that asks, guesses, jokes, agrees, adds a detail, narrows the scope or talks about something else is not evidence. No evidence is not wrong. When unsure, leave it out.",
    "For each flag: note (L<n>), message (M<n>), quote (3 to 25 words copied exactly from that owner line, the part that shows the note is wrong), fix (the note rewritten as one line that agrees with the quote and keeps the rest of the note).",
    'Reply with JSON only: {"wrong": [{"note": "L9", "message": "M3", "quote": "...", "fix": "..."}]}, or {"wrong": []} when nothing qualifies.',
    "",
    "<pairs>",
  ];
  const body: string[] = [];
  const refs = new Map<string, Pair>();
  let size = Buffer.byteLength(head.join("\n")) + 20;
  for (const pair of pairs) {
    if (refs.size >= WRONG_PAIRS_MAX) break;
    // a line the prompt would have to change reaches no judge
    if (clean(pair.row.text) !== pair.row.text) continue;
    const ref = `M${refs.size + 1}`;
    const text = `PAIR\nL${pair.note.at + 1} (written ${noted(pair.note, today) ?? "unknown"}): ${clean(pair.note.text)}\n${ownerLine(ref, pair.row)}\n`;
    const bytes = Buffer.byteLength(text) + 1;
    if (size + bytes > WRONG_PROMPT_MAX) continue;
    size += bytes;
    body.push(text);
    refs.set(ref, pair);
  }
  const prompt = [...head, ...body, "</pairs>"].join("\n");
  for (const [ref, pair] of refs) if (!prompt.includes(`\n${ownerLine(ref, pair.row)}\n`)) refs.delete(ref);
  return { prompt, refs };
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
/** newest: the owner's newest message when the judges read the pairs; ids: every message the owner had typed then. */
export type WrongContext = { all: readonly string[]; today: string; written(note: NoteLine): number | undefined; newest: Newest; ids: string };

/** Flags both judges agree on that pass the code gates, as items; nothing is applied. */
export function planWrong(a: readonly Wrong[], b: readonly Wrong[], refs: ReadonlyMap<string, Pair>, context: WrongContext) {
  const items: FixItem[] = [];
  const rejected: Rejected[] = [];
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
    const by = fixLine(note.text, one.fix);
    // both judges name the one new line byte for byte: case, spaces and marks inside a value can change it
    if (one.fix.trim() !== other.fix.trim()) {
      no("judges fix different values");
      continue;
    }
    if (!body(by) || by === note.text || !factsSurvive(by, [note.text, row.text]) || redactRoomMemory(by) !== by || redactRoomMemory(note.text) !== note.text) {
      no("fix not grounded in the old line and the quote");
      continue;
    }
    const item: FixItem = {
      op: "fix", target, text: note.text, by, why: "wrong", listOnly: handOnly(note, context.all),
      evidence: { thread: row.thread, message: row.id, at: row.at, quote },
      seen: { at: context.newest.at, sha: sha8(row.text), ids: context.ids },
    };
    // only the owner's newest message, read whole, may propose: nothing after it needs reading
    if (row.thread !== context.newest.thread || row.id !== context.newest.id || !row.whole || row.guarded) {
      no("row is not the owner's newest message, read whole");
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

export type WrongCheck = { state: "checked" | "no-model"; items: FixItem[]; pairs: number; bytes: number; logs: Partial<Record<keyof DreamJudges, JudgeLog>>; reason?: string };

/** One pass: pair the owner's newest message when it is read whole, ask both judges once, keep what both agree on and the gates pass. newest: that message, none when its order is unclear; ids: every message the owner had typed. */
export async function checkWrong(input: { raw: string; rows: readonly OwnerRow[]; newest: Newest | undefined; ids: string; saved: readonly SavedNotes[]; judges: DreamJudges; today: string; signal: AbortSignal; now(): number }): Promise<WrongCheck> {
  const logs: WrongCheck["logs"] = {};
  const notes = fixTargets(input.raw);
  const { newest } = input;
  const rows = newest ? input.rows.filter((row) => row.thread === newest.thread && row.id === newest.id && row.whole) : [];
  const { prompt, refs } = wrongPrompt(await wrongPairs(input.raw, notes, rows, input.signal), input.today);
  const none: FixItem[] = [];
  const base = { items: none, pairs: refs.size, bytes: refs.size ? Buffer.byteLength(prompt) : 0, logs };
  if (!refs.size || !newest) return { state: "checked", ...base };
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
  return { state: "checked", ...base, items: planWrong(a.value, b.value, refs, { all, today: input.today, written: writtenAt(input.saved), newest, ids: input.ids }).items };
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
