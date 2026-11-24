// The nightly cleaner's rules on copies: which notes never move, a note's id, the moves history block and the counts-only night summary.
// scripts/dream-check.ts runs it on copies; nothing live imports it yet.
import { createHash } from "node:crypto";
import { z } from "zod";

import { holdsValue, LABEL_WORDS, secretLike } from "./memory-pass.ts";

const LABEL_JA = /パスワード/;
const KEY_WORD = /\bkeys?\b/i;
const CODE_NEAR = /\b(?:code|pin|otp|passcode|combo)\b[\s\S]{0,12}?(?<!\d)\d{4,9}(?!\d)|(?<!\d)\d{4,9}(?!\d)[\s\S]{0,12}?\b(?:code|pin|otp|passcode|combo)\b/i;
const BASIC_AUTH = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
// 8+ characters, mixed case, a symbol, no slash; a trailing symbol counts, so SunnyHarbor! is a value
const looksLikeValue = (word: string) => {
  const bare = word.replace(/^[^\p{L}\p{N}]+/u, "");
  return bare.length >= 8 && /\p{Ll}/u.test(bare) && /\p{Lu}/u.test(bare) && /[^\p{L}\p{N}\s]/u.test(bare) && !bare.includes("/");
};

/** A note that may hold a login, key or code never moves, merges or retires. Judge the whole note: a label line's value often sits on its indented line. */
export function cleanerSkip(note: string): boolean {
  // no token-talk rescue: a false skip only keeps a note loaded. A bare value with no label and no shape (plainword!, ABCD-EFGH, 16 hex, 9 digits) still moves.
  return secretLike(note) || LABEL_WORDS.test(note) || LABEL_JA.test(note) || KEY_WORD.test(note) || CODE_NEAR.test(note) || holdsValue(note) || note.split(/\s+/).some(looksLikeValue) || BASIC_AUTH.test(note);
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const sha8 = (text: string) => sha256(text).slice(0, 8);

/** Lines grouped into notes as fileableNotes reads them: a top line and the indented lines under it. */
export function noteGroups(lines: readonly string[]): string[][] {
  const groups: string[][] = [];
  for (const line of lines) {
    if (/^\s+\S/.test(line) && groups.length) groups.at(-1)!.push(line);
    else groups.push([line]);
  }
  return groups;
}

/** Quiz blocks with every skipped note taken out; a block left empty is dropped. */
export function quizBlocks<T extends { lines: string[] }>(blocks: readonly T[]): T[] {
  return blocks.flatMap((block) => {
    const lines = noteGroups(block.lines).filter((note) => !cleanerSkip(note.join("\n"))).flat();
    return lines.length ? [{ ...block, lines }] : [];
  });
}

export const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA8 = /^[0-9a-f]{8}$/;
const CLEAN_FILE = /^(?:MEMORY\.md|memory\/[^\s/\\]+\.md)$/;
export const HISTORY_DIR = "memory/cleaner-history";
export const HISTORY_OPS = ["move", "merge", "replace", "retire", "putback"] as const;
const count = z.number().int().nonnegative();
const cleanFile = z.string().regex(CLEAN_FILE);

// the header carries src/lib/memory-clean.ts's MemoryCleanRun fields, so the app reads a run without the notes
const historyHeader = z.object({
  runId: z.string().regex(SHA8),
  pc: z.string().regex(SHA8),
  bot: z.string().regex(BOT_ID),
  at: count,
  files: z.array(cleanFile),
  beforeBytes: count,
  afterBytes: count,
  merged: count,
  replaced: count,
  moved: count,
}).strict();
export type HistoryNote = { op: (typeof HISTORY_OPS)[number]; sha8: string; bytes: number; target: string };
export type HistoryRun = z.infer<typeof historyHeader> & { notes: HistoryNote[] };
const NOTE_LINE = new RegExp(`^- (${HISTORY_OPS.join("|")}) ([0-9a-f]{8}) (\\d+) (\\S+)$`);

export const runIdOf = (pc: string, bot: string, at: number) => sha8(`${pc}\0${bot}\0${at}`);
/** One file per PC and month: only that PC appends, so two PCs never tie on it. */
export const historyFile = (at: number, pc: string) => `${HISTORY_DIR}/moves-${new Date(at).toISOString().slice(0, 7)}-${pc}.md`;

export function historyBlock({ notes, ...run }: HistoryRun): string {
  const header = historyHeader.parse(run);
  for (const note of notes) if (!SHA8.test(note.sha8) || !CLEAN_FILE.test(note.target) || !Number.isInteger(note.bytes)) throw new Error(`bad history note ${note.sha8}`);
  return [`## ${header.runId}`, `- run: ${JSON.stringify(header)}`, ...notes.map(({ op, sha8: id, bytes, target }) => `- ${op} ${id} ${bytes} ${target}`), ""].join("\n");
}

function jsonOrNull(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Runs in a history file; it is data, never a command, so a line that does not parse is left out. */
export function parseHistory(text: string): HistoryRun[] {
  const runs: HistoryRun[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("- run: ")) {
      const parsed = historyHeader.safeParse(jsonOrNull(line.slice("- run: ".length)));
      if (parsed.success) runs.push({ ...parsed.data, notes: [] });
      continue;
    }
    const note = NOTE_LINE.exec(line);
    const op = HISTORY_OPS.find((each) => each === note?.[1]);
    if (note && op && runs.length && CLEAN_FILE.test(note[4]!)) runs.at(-1)!.notes.push({ op, sha8: note[2]!, bytes: Number(note[3]), target: note[4]! });
  }
  return runs;
}

export const ERROR_CODES = ["cap", "rate-limit", "engine", "parse", "io", "other"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** A failure as a code; its text stays in dream-practice and only its sha8 reaches the results folder. */
export function errorCode(message: string): ErrorCode {
  if (/token cap|night cap|week cap|ledger/i.test(message)) return "cap";
  if (/\b429\b|rate.?limit|usage limit|overloaded/i.test(message)) return "rate-limit";
  if (/\b(?:EISDIR|ENOENT|EACCES|EPERM|EBUSY|ENOTDIR)\b/.test(message)) return "io";
  if (/JSON|zod|parse/i.test(message)) return "parse";
  if (/claude|exited|spawn|signal|timed? ?out|abort/i.test(message)) return "engine";
  return "other";
}

const TIDY_RESULTS = ["saved", "none", "conflict", "error", "timeout", "cancelled", "no-log"] as const;

/** What a night leaves in the results folder: numbers, booleans, codes, bot ids and 8-hex shas, never a free string. */
export const nightSummarySchema = z.object({
  build: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  model: z.boolean(),
  nights: count,
  spent: z.object({ fresh: count, processed: count }).strict(),
  failed: count,
  bots: z.array(z.object({
    bot: z.string().regex(BOT_ID),
    night: count,
    trap: z.boolean(),
    result: z.enum(TIDY_RESULTS),
    linesBefore: count,
    linesAfter: count,
    bytesBefore: count,
    bytesAfter: count,
    tokensBefore: count,
    tokensAfter: count,
    proposed: count,
    moved: count,
    filed: count,
    skipped: count,
    lost: z.array(z.string().regex(SHA8)),
    madeUp: z.array(z.string().regex(SHA8)),
    quizAsked: count,
    quizRight: count,
    undoneBlocks: count,
    conflicts: count,
    error: z.enum(ERROR_CODES).nullable(),
    errorSha: z.string().regex(SHA8).nullable(),
    ms: count,
    modelTokens: count,
    filingTokens: count,
  }).strict()),
}).strict();
export type NightSummary = z.infer<typeof nightSummarySchema>;
export const tidyResult = (result: string) => TIDY_RESULTS.find((each) => each === result) ?? "no-log";
