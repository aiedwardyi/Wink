// Dreaming's two judges: one prompt that models of two makers both read, the flags they agree on, and the code gates a flag still passes before its line moves.
import { z } from "zod";

import type { NoteGenerator } from "./memory-pass.ts";
import { loadWindow, negates, noteLines, planTidy, replaces, tokens, twinKey, type Move, type NoteLine } from "./memory-sleep.ts";

export const DREAM_MOVES_MAX = 20;
export const DREAM_GEMINI = "gemini-4-hydrogen-low";
/** Claude's helper (Haiku 5.5 low) and Gemini 4 Hydrogen low; null while that engine cannot run here. */
export type DreamJudges = { claude: NoteGenerator | null; gemini: NoteGenerator | null };
const REFS_MAX = 60;

export type Kind = "repeat" | "replaced" | "expired";
/** at and by are line indexes in MEMORY.md. */
export type Flag = { kind: Kind; at: number; by: number[] };

const refList = z.union([z.array(z.string()), z.string().transform((ref) => [ref])]);
const replySchema = z.object({
  repeat: z.array(z.object({ drop: z.string(), by: refList, lost: z.string().nullish() })).max(REFS_MAX).nullish(),
  disagree: z.array(z.tuple([z.string(), z.string()])).max(REFS_MAX).nullish(),
  stale: z.array(z.string()).max(REFS_MAX).nullish(),
});

const STAMP = /\(noted (\d{4}-\d{2}-\d{2})\)/;
const PROMPT_TAGS = /<\/?notes\b[^>]*>/gi;
const FULL_DATE = /(?<![\d/-])(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\d/])/g;
// 11-19 or 11/19; a one-digit side like 3-5 or 1/3 is a range or a share far more often than a day
const SHORT_DATE = /(?<![\d/-])(0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])(?![\d/-])/g;
// a standing rule, however old its date: an ALL CAPS label, or always, never, must, a rule
const RULE_CAPS = /^[-*+]\s+(?:\*\*)?[A-Z][A-Z0-9&/'+-]{2,}(?:\s+[A-Z0-9&/'+-]+)*(?:\*\*)?\s*[:(]/;
const RULE_WORDS = /\b(?:never|always|must|rules?|don['’]?t|do not)\b/i;
const QUOTED = /"[^"\n]{2,}"|“[^”\n]{2,}”|「[^」\n]{2,}」/;
const PINNED = /\bpin(?:ned|s)?\b|\block(?:ed)?\b|\bpicks?\b|\bdecisions?\b|📌/i;

const ref = (line: NoteLine) => `L${line.at + 1}`;
const withoutStamp = (text: string) => text.replace(STAMP, " ");

/** Every day the note itself names, not its Auto Notes stamp; a day with no year is in today's year. */
export function writtenDays(text: string, today: string): string[] {
  const body = withoutStamp(text);
  const days = [...body.matchAll(FULL_DATE)].map(([, y, m, d]) => `${y}-${m}-${d}`);
  const rest = body.replace(FULL_DATE, " ");
  return [...days, ...[...rest.matchAll(SHORT_DATE)].map(([, m, d]) => `${today.slice(0, 4)}-${m}-${d}`)];
}

/** A one-off whose every written day is before today; a note with no written day never expires. */
export function expired(text: string, today: string): boolean {
  const days = writtenDays(text, today);
  return days.length > 0 && days.every((day) => day < today);
}

/** Lines no judge may move: a standing rule, the user's quoted words with a date, and anything under a pinned, locked, picks or decisions heading. */
export function neverMoves(line: NoteLine, lines: readonly string[]): boolean {
  const heading = line.section >= 0 ? lines[line.section] ?? "" : "";
  const dated = STAMP.test(line.text) || writtenDays(line.text, "2000-01-01").length > 0;
  return RULE_CAPS.test(line.text) || RULE_WORDS.test(line.text) || (QUOTED.test(line.text) && dated) || PINNED.test(heading) || /📌/.test(line.text);
}

// the day a note was written: its stamp, else the first day it names, else unknown
const noted = (line: NoteLine, today: string) => line.date ?? writtenDays(line.text, today)[0];

/** The judge's flags, by line, for notes it was sent; null when the reply is not the JSON asked for. */
export function parseDream(output: string, notes: readonly NoteLine[], today: string): Flag[] | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let parsed: z.infer<typeof replySchema>;
  try {
    const result = replySchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const sent = new Map(notes.map((line) => [ref(line), line] as const));
  const flags: Flag[] = [];
  for (const { drop, by, lost } of parsed.repeat ?? []) {
    const line = sent.get(drop);
    const kept = by.map((each) => sent.get(each));
    // a repeat the judge says loses something is not a repeat
    if (!line || lost?.trim() || !kept.length || kept.some((each) => !each || each === line)) continue;
    flags.push({ kind: "repeat", at: line.at, by: kept.map((each) => each!.at) });
  }
  for (const [a, b] of parsed.disagree ?? []) {
    const [x, y] = [sent.get(a), sent.get(b)];
    if (!x || !y || x === y) continue;
    const [dx, dy] = [noted(x, today), noted(y, today)];
    // the older line moves: by the day it was written, else by where it sits
    const older = dx && dy && dx !== dy ? (dx < dy ? x : y) : x.at < y.at ? x : y;
    flags.push({ kind: "replaced", at: older.at, by: [(older === x ? y : x).at] });
  }
  for (const each of parsed.stale ?? []) {
    const line = sent.get(each);
    if (line) flags.push({ kind: "expired", at: line.at, by: [] });
  }
  return flags;
}

/** Only what both judges flagged: the same line for the same kind; a repeat keeps the covering lines both named. */
export function agreed(a: readonly Flag[], b: readonly Flag[]): Flag[] {
  const flags: Flag[] = [];
  for (const one of a) {
    if (flags.some((flag) => flag.at === one.at)) continue;
    const other = b.find((flag) => flag.kind === one.kind && flag.at === one.at && (one.kind !== "replaced" || flag.by[0] === one.by[0]));
    if (!other) continue;
    const by = one.by.filter((at) => other.by.includes(at));
    if (one.kind === "repeat" && !by.length) continue;
    flags.push({ ...one, by });
  }
  return flags;
}

export function dreamPrompt(notes: readonly NoteLine[], today: string): string {
  const clean = (text: string) => text.replace(PROMPT_TAGS, " ");
  return [
    `Today is ${today}. You tidy a bot's notes. Find only three things:`,
    '- repeat: a note whose every fact other notes already say. drop is that note, by lists the notes that say it, lost is what drop says that by does not ("" when nothing).',
    "- disagree: two notes about the same thing that cannot both be true now, like a preference the user later changed. Put the older note first.",
    "- stale: a note about a one-off event, plan or reminder whose every date is before today, so it no longer guides anything. A lasting rule, preference or fact that carries a date is not stale.",
    "Notes that add different details are not repeats, two notes that can both be true do not disagree, and a note that still guides the bot is not stale. When unsure, leave it out. Never judge which side is right.",
    'Reply with JSON only: {"repeat": [{"drop": "L9", "by": ["L3"], "lost": ""}], "disagree": [["L4", "L12"]], "stale": ["L7"]}, or {"repeat": [], "disagree": [], "stale": []} when nothing qualifies.',
    "",
    "NOTES:",
    "<notes>",
    ...notes.map((line) => `${ref(line)}: ${clean(line.text)}`),
    "</notes>",
  ].join("\n");
}

const lower = (text: string) => tokens(text).map((token) => token.toLowerCase());
// numbers, paths, quoted words and capitalized names
const facts = (text: string) => [
  ...(withoutStamp(text).match(/\d[\d.,:/-]*\d|\d/g) ?? []),
  ...(withoutStamp(text).match(/"[^"]+"|“[^”]+”/g) ?? []).map((quote) => quote.slice(1, -1)),
  ...tokens(text).filter((token) => /[\\/]|\.[a-z0-9]{1,5}$/i.test(token) || /^\p{Lu}/u.test(token)),
];

/** Every fact of the dropped line is in the lines that keep it. */
export function factsSurvive(drop: string, by: readonly string[]): boolean {
  const kept = by.join("\n").toLowerCase();
  return facts(drop).every((fact) => kept.includes(fact.toLowerCase()));
}

/** Every word of the dropped line is in the lines that keep it, and they add no word that turns it. */
export function covers(drop: string, by: readonly string[]): boolean {
  const need = lower(drop);
  const have = by.flatMap(lower);
  return need.length > 0 && need.every((word) => have.includes(word)) && !have.filter((word) => !need.includes(word)).some(negates);
}

/** Exact twins as Sleep finds them that both judges flagged as repeats of a twin, then up to DREAM_MOVES_MAX of the agreed flags that pass the code gates. */
export function planDream(raw: string, flags: readonly Flag[], today: string, movedBefore: ReadonlySet<string> = new Set()): Move[] {
  const all = raw.split("\n").map((line) => line.replace(/\r$/, ""));
  const lines = new Map(noteLines(raw).map((line) => [line.at, line] as const));
  const twinFlagged = (line: NoteLine) =>
    flags.some((flag) => flag.kind === "repeat" && flag.at === line.at && flag.by.length > 0 && flag.by.every((at) => lines.has(at) && twinKey(lines.get(at)!.text) === twinKey(line.text)));
  const moves = planTidy(raw, "", movedBefore).filter((move) => twinFlagged(lines.get(move.at)!) && !neverMoves(lines.get(move.at)!, all));
  const { head, loaded } = loadWindow(raw);
  const gone = new Set(moves.map(({ at }) => at));
  const kept = new Set(moves.flatMap(({ by }) => [...lines.values()].filter((line) => line.text === by).map(({ at }) => at)));
  let judged = 0;
  for (const flag of flags) {
    if (judged >= DREAM_MOVES_MAX) break;
    const line = lines.get(flag.at);
    if (!line || !line.alone || gone.has(line.at) || kept.has(line.at) || movedBefore.has(twinKey(line.text)) || neverMoves(line, all)) continue;
    const by = flag.by.map((at) => lines.get(at));
    if (by.some((each) => !each || each === line || gone.has(each.at) || !each.alone)) continue;
    const keep = by as NoteLine[];
    if (flag.kind === "expired") {
      if (keep.length || !expired(line.text, today)) continue;
    } else {
      // never in favor of a line the prompt does not load, and only under the same heading
      if (!keep.length || keep.some((each) => each.section !== line.section || (loaded(line) && !loaded(each)))) continue;
      if (flag.kind === "repeat") {
        // the keeper is newer: by its stamp when both carry one, else by where it sits; a head line stays, since the newest lines roll out
        const newer = (each: NoteLine) => (line.date && each.date ? each.date > line.date : each.at > line.at);
        if (!keep.every(newer) || (line.at < head && keep.some((each) => each.at >= head))) continue;
        if (!covers(line.text, keep.map(({ text }) => text)) || !factsSurvive(line.text, keep.map(({ text }) => text))) continue;
      } else if (keep.length !== 1 || !replaces(keep[0]!, line)) continue;
    }
    moves.push({ at: line.at, text: line.text, by: keep.map(({ text }) => text).join("\n"), why: flag.kind === "repeat" ? "duplicate" : flag.kind });
    judged += 1;
    gone.add(line.at);
    for (const each of keep) kept.add(each.at);
  }
  return moves.sort((p, q) => p.at - q.at);
}
