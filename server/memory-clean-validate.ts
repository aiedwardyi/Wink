import { z } from "zod";

import { parseReply } from "./memory-clean-call.ts";
import { cleanFileSchema, filePointers, historyPointer, isHistory, lineHash, pointerLine } from "./memory-clean-format.ts";
import type { ArchiveEntry, ChangeList, CleanBudget, CleanFile, RejectReason, SleepLine, ValidateInput, ValidateResult } from "./memory-clean-types.ts";
import { day, secretLike } from "./memory-pass.ts";
import { withSystemChanges } from "./turn-context.ts";
import { isMemoryTopicName } from "./workspace.ts";

export { pointerLine } from "./memory-clean-format.ts";
export const FILE_FLOOR = 16000;
const LEARN_MAX = 8;
export const GROWTH_MAX = 1000;
const REMEMBER_MAX = 600;
const FILE_MAX_BYTES = 4096;
const id = z.number().int().positive();
const reason = z.string();
const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("merge"), ids: z.array(id).min(2).max(3), text: z.string(), reason }).strict(),
  z.object({ op: z.literal("replace"), id, newer: id, reason }).strict(),
  z.object({ op: z.literal("retire"), id, reason }).strict(),
  z.object({ op: z.literal("split"), id, keep: z.array(z.string().min(1)).min(1), reason }).strict(),
  z.object({ op: z.literal("remind"), id, text: z.string(), reason }).strict(),
  z.object({ op: z.literal("learn"), text: z.string(), quote: z.string(), lesson: z.boolean().optional(), reason }).strict(),
  z.object({ op: z.literal("own"), id, quote: z.string(), reason }).strict(),
  z.object({ op: z.literal("file"), ids: z.array(id).min(1).max(20), topic: z.string(), pointer: z.string().optional(), reason }).strict(),
]);
const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const bullet = (text: string) => `- ${text.replace(/\s+/g, " ").trim().replace(/^[-*+]\s+/, "")}`;
const lessonsHeading = (line: string) => /^#{1,6}\s+(?:lessons?|교훈)\s*$/i.test(line.replace(/\r$/, ""));
export const openLine = (line: string) => /pending|parked|awaits?|awaiting|대기|보류/i.test(line);
// "don't forget" asks to remember; it negates nothing
const negated = (text: string) => /\b(?:not|never|cannot)\b|n['’]t\b|(?<![가-힣])(?:안|못)(?=\s)|않/i.test(text.replace(/\b(?:don['’]t|do not) forget\b/gi, ""));
const NOTED = /\s*\(noted (\d{4}-\d{2}-\d{2})\)/gi;
const undated = (text: string) => text.replace(NOTED, "");
const CLAUSES = /;|(?<=[.!?])\s+(?=[A-Z가-힣])|\s+and\s+(?=[A-Z가-힣])/;
const clauseWords = (part: string) => contentWords(part.replace(/[A-Za-z]{40,}/g, ""));
// a merge carries its sources' newest stamp; the archive keeps the older ones
const dated = (text: string, sources: string[]) => {
  const newest = sources.flatMap((line) => [...line.matchAll(NOTED)].map((match) => match[1]!)).sort().at(-1);
  return undated(text).trimEnd() + (newest ? ` (noted ${newest})` : "");
};
const STOPWORDS = new Set(["about", "also", "been", "could", "does", "each", "from", "have", "here", "into", "just", "more", "most", "noted", "only", "said", "says",
  "should", "some", "than", "that", "their", "them", "then", "there", "they", "this", "user", "users", "very", "were", "what", "when", "which", "will", "with", "would", "your"]);

/** Stems of the content words: Latin words of 4+ letters (only those written in lowercase if asked) and Korean words, stopwords dropped. */
export function contentWords(text: string, writtenLowercase = false): Set<string> {
  const words = new Set<string>();
  for (const [word] of text.matchAll(/[A-Za-z]+|[가-힣]+/g)) {
    if (/^[가-힣]/.test(word)) {
      // first syllable plus the next one's initial consonant, so 마셔 and 마심 or 좋아해 and 좋아한다 share a stem
      if (word.length >= 2 && !word.startsWith("사용자")) words.add(word[0]! + Math.floor((word.charCodeAt(1) - 0xac00) / 588));
      continue;
    }
    const lower = word.toLowerCase();
    if (word.length < 4 || (writtenLowercase && word !== lower) || STOPWORDS.has(lower)) continue;
    const stem = lower.replace(/(?:ing|ed|s)$/, "");
    words.add((stem.length < 3 ? lower : stem).replace(/e$/, ""));
  }
  return words;
}

/** The user line a quote sits in, verbatim apart from case and spacing. */
export function quotedLine(quote: string, user: readonly SleepLine[], kind?: SleepLine["kind"]): SleepLine | undefined {
  const said = squash(quote);
  return said.length < 4 ? undefined : user.find((line) => (!kind || line.kind === kind) && squash(line.text).includes(said));
}

export function rememberCovered(line: string, text: string): boolean {
  const body = line.replace(/^(?:(?:please|also|and|fyi|oh|ok|okay)\s+)*(?:remember|don't forget|do not forget|keep in mind|make a note|기억해|기억하세요)\s*[:,-]?\s*/i, "").replace(/^(?:that|the)\s+/i, "");
  const rows = text.split("\n");
  // a long remember is written split across consecutive bullets
  return rows.some((_, i) => {
    let joined = "";
    for (const row of rows.slice(i, i + 8)) {
      joined = `${joined} ${row.replace(/^\s*[-*+]\s+/, "")}`.trim();
      if (squash(joined).includes(squash(body))) return negated(body) === negated(joined);
      if (joined.length > body.length + 300) break;
    }
    return false;
  });
}

/** A remember as bullets of at most 300 bytes, split verbatim at sentence ends, else at spaces. */
export function rememberRows(text: string): string[] | null {
  const line = bullet(text);
  if (Buffer.byteLength(line) <= 300) return [line];
  const rows: string[] = [];
  for (const sentence of line.slice(2).split(/(?<=[.!?])\s+/)) {
    for (const word of Buffer.byteLength(`- ${sentence}`) > 300 ? sentence.split(" ") : [sentence]) {
      const last = rows.at(-1);
      if (last !== undefined && Buffer.byteLength(`${last} ${word}`) <= 300) rows[rows.length - 1] = `${last} ${word}`;
      else if (Buffer.byteLength(`- ${word}`) <= 300) rows.push(`- ${word}`);
      else return null;
    }
  }
  return rows;
}

export const forcedEntry = (entry: ArchiveEntry) => entry.header.op === "own" && !entry.header.at.length && entry.reason === "Asked to remember";

export function sizeFits(old: string, text: string): boolean {
  const before = Buffer.byteLength(old);
  const after = Buffer.byteLength(text);
  const bytes = before > 24000 ? after < before : after <= Math.min(24000, Math.max(before, FILE_FLOOR));
  return bytes && text.split("\n").length <= Math.max(200, old.split("\n").length);
}

export function changedChars(before: string, after: string): number {
  let low = 0;
  let high = before.length + after.length + 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (withSystemChanges("", before, after, middle) === null) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function measureChanges(file: CleanFile, before: string, raw: string, entries: ArchiveEntry[], target?: string) {
  const text = file === "MEMORY.md" && (entries.length || target) ? historyPointer(raw, target) : raw;
  const beforeBytes = Buffer.byteLength(before);
  const finalBytes = Buffer.byteLength(text);
  const ceiling = beforeBytes > 24000 ? beforeBytes - 1 : Math.min(24000, Math.max(beforeBytes, FILE_FLOOR));
  const maxBytes = file === "MEMORY.md" ? Math.min(ceiling, beforeBytes + GROWTH_MAX) : beforeBytes + GROWTH_MAX;
  const own = entries.filter((entry) => entry.header.file === file);
  const inserted = own.reduce((n, entry) => n + (forcedEntry(entry) ? 0 : entry.header.after !== undefined ? entry.header.wrote.length : Math.max(0, entry.header.wrote.length - entry.header.at.length)), 0);
  const pointerChanged = file === "MEMORY.md" && text !== raw && historyPointer(before, target) !== before ? 1 : 0;
  const wroteBytes = (entry: ArchiveEntry) => entry.header.wrote.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
  const metadataBytes = own.filter((entry) => entry.header.op === "learn").reduce((n, entry) => n + entry.header.wrote.reduce((bytes, line) => bytes +
    (/^#{1,6}\s/.test(line) ? Buffer.byteLength(line) + 1 : Buffer.byteLength(line.match(/\s*\(noted \d{4}-\d{2}-\d{2}\)/)?.[0] ?? "")), 0), 0);
  const budget: CleanBudget = {
    beforeBytes, finalBytes, maxBytes, forcedBytes: own.filter(forcedEntry).reduce((n, entry) => n + wroteBytes(entry), 0),
    generatedBytes: Buffer.byteLength(text) - Buffer.byteLength(raw) + metadataBytes + own.filter((entry) => entry.header.op === "file").reduce((n, entry) => n + wroteBytes(entry), 0),
    touchedLines: own.reduce((n, entry) => n + entry.header.at.length, 0) + inserted + pointerChanged,
    changedChars: changedChars(before, text), finalLines: text.split("\n").length, maxLines: Math.max(200, before.split("\n").length),
    excessBytes: Math.max(0, finalBytes - maxBytes),
  };
  const errors: Array<{ reason: RejectReason; over?: number }> = [];
  if (own.filter(forcedEntry).some((entry) => entry.header.wrote.some((line) => Buffer.byteLength(line.replace(/\r$/, "")) > 300))) errors.push({ reason: "too-long" });
  if (budget.touchedLines > 40) errors.push({ reason: "cap-lines", over: budget.touchedLines - 40 });
  if (budget.changedChars > 8000) errors.push({ reason: "cap-chars", over: budget.changedChars - 8000 });
  if (file === "MEMORY.md" && !sizeFits(before, text)) errors.push({ reason: "budget", ...(finalBytes > ceiling ? { over: finalBytes - ceiling } : {}) });
  if (finalBytes - beforeBytes > GROWTH_MAX) errors.push({ reason: "cap-growth", over: finalBytes - beforeBytes - GROWTH_MAX });
  return { text, budget, errors };
}

// a replace stays on one subject: a shared fact token (not a small number, year or date), or shared content words (two, or all of a one-word line); open work needs a fact token
function sameSubject(older: string, newer: string, base: string): boolean {
  const plain = (line: string) => line.replace(/\(noted \d{4}-\d{2}-\d{2}\)/gi, "");
  const facts = (line: string) => new Set(factTokens(plain(line), base).filter((token) => !/^(?:\d{1,2}|(?:19|20)\d\d|\d{4}-\d\d-\d\d)$/.test(token)).map((token) => token.toLowerCase()));
  const newFacts = facts(newer);
  if ([...facts(older)].some((token) => newFacts.has(token))) return true;
  if (openLine(older)) return false;
  const a = contentWords(plain(older));
  const b = contentWords(plain(newer));
  return [...a].filter((word) => b.has(word)).length >= Math.max(1, Math.min(2, a.size, b.size));
}

// new plain lines go last but stay out of a trailing Lessons section; null lessons means the heading is missing
function sleepSlots(lines: string[]): { plain: number; lessons: number | null; end: number } {
  const filled = (from: number, to: number) => {
    for (let at = to; at >= from; at--) if (lines[at - 1]?.trim()) return at;
    return 0;
  };
  const end = filled(1, lines.length);
  const heading = lines.findIndex(lessonsHeading) + 1;
  if (!heading) return { plain: end, lessons: null, end };
  const depth = /^#+/.exec(lines[heading - 1]!)![0].length;
  const next = lines.findIndex((line, i) => i >= heading && (/^#{1,6}(?=\s)/.exec(line)?.[0].length ?? 7) <= depth) + 1;
  return { plain: next ? end : filled(1, heading - 1), lessons: filled(heading, next ? next - 1 : lines.length), end };
}
const listSchema = z.object({ version: z.literal(1), file: cleanFileSchema, changes: z.array(changeSchema) }).strict();
const RULE_WORDS = /\b(?:rules?|preferences?|prefer(?:s|red)?|always|never|don['’]t|do not|must|should)\b|항상|절대|하지\s*마|규칙|선호/gi;
const PATHS = /\bmemory\/[\w][\w .-]*?\.md\b|(?<![\w./\\-])[a-z0-9_][a-z0-9_.-]*\.md\b/g;
const ruleWords = (line: string) => [...line.matchAll(RULE_WORDS)].map(([word]) => word.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ""));
export const declinedLine = (line: string) => /\b(declined?|rejected?|ruled out|turned down|chose against)\b|거절|사양|선택하지|하지 않기로/i.test(line);

/** Without `soft`, only lines no merge or file may touch: rule words and pointers are soft. */
export function protectedLines(text: string, typed: ReadonlySet<string>, includeDeclined = true, soft = true): Set<number> {
  const protectedIds = new Set<number>();
  let pinnedDepth = 0;
  text.split("\n").forEach((line, i) => {
    const heading = /^(#{1,6})\s+(.+)/.exec(line);
    if (heading) {
      if (pinnedDepth && heading[1]!.length <= pinnedDepth) pinnedDepth = 0;
      if (/\bpinned\b|고정/i.test(heading[2]!) || lessonsHeading(line)) pinnedDepth = heading[1]!.length;
    }
    if (pinnedDepth || /\(pinned\)\s*$/i.test(line) || typed.has(lineHash(line)) || includeDeclined && declinedLine(line) || /\b(corrections?|corrected|lessons?)\b|교정|정정|교훈/i.test(line) ||
      soft && (pointerLine(line) || ruleWords(line).length > 0)) protectedIds.add(i + 1);
  });
  return protectedIds;
}

// one base is scanned per night, and the scan is quadratic in its length
let midCache = { base: "", tokens: new Set<string>() };

export function factTokens(text: string, base = text): string[] {
  const pattern = /"[^"\n]+"|“[^”\n]+”|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])|`[^`\n]+`|(?:[A-Za-z]:[\\/]|\.{0,2}\/|https?:\/\/)[^\s,;<>"`]+|\d{4}-\d{2}-\d{2}|\d+(?:[.,:/%-]\d+)*(?:%|[A-Za-z]+)?|[\p{L}\p{N}_-]+\.(?:md|ts|json|py|txt|com|org)\b|(?<![\p{L}\p{N}_-])[\p{L}_]*[\p{Lu}][\p{L}\p{N}_-]*/gu;
  const initial = (source: string, at: number) => /(?:^|\n|[.!?]\s+)[ \t>*#+\-\d.)]*$/u.test(source.slice(0, at));
  if (midCache.base !== base) midCache = { base, tokens: new Set([...base.matchAll(pattern)].filter((match) => !initial(base, match.index)).map((match) => match[0])) };
  const midSentence = midCache.tokens;
  const matches = [...text.matchAll(pattern)].filter((match) => {
    const token = match[0];
    return !/^[\p{Lu}][\p{Ll}_-]+$/u.test(token) || !initial(text, match.index) || midSentence.has(token);
  });
  return [...new Set(matches.map((match) => match[0]))];
}

function newer(a: string, b: string, olderId: number, newerId: number): boolean {
  const date = (line: string): number | null => {
    const noted = /\(noted (\d{4}-\d{2}-\d{2})\)/i.exec(line)?.[1];
    const numeric = /(\d{4})[-/년]\s*(\d{1,2})[-/월]\s*(\d{1,2})/.exec(noted ?? line);
    if (numeric) return Date.UTC(Number(numeric[1]), Number(numeric[2]) - 1, Number(numeric[3]));
    const named = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(line);
    if (!named) return null;
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[1]!.slice(0, 3).toLowerCase());
    return Date.UTC(Number(named[3]), month, Number(named[2]));
  };
  const oldDate = date(a);
  const newDate = date(b);
  return oldDate !== null && newDate !== null ? newDate > oldDate : newerId > olderId;
}

/** Pointer that names every clause and three held facts of the filed lines in their own words and order, on one line when it fits. */
export function filedPointer(text: string, ids: number[], topic: string, k = 3): string {
  const lines = text.split("\n");
  const held = [...new Set(ids.flatMap((n) => factTokens(lines[n - 1]!, text)))];
  const labels = ids.flatMap((n) => undated(lines[n - 1]!).split(CLAUSES).map((part) => {
    const wanted = clauseWords(part);
    const got = new Set<string>();
    const all = part.split(/\s+/).map((raw) => raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
    const words = new Map<number, string>();
    for (const [at, word] of all.entries()) {
      if (got.size >= Math.min(k, wanted.size)) break;
      const stems = [...contentWords(word)].filter((stem) => wanted.has(stem) && !got.has(stem));
      const name = word.length > 1 && /\p{Lu}/u.test(word) && held.some((token) => word.includes(token));
      // path words stay out, so a pointer line never files
      if ((!stems.length && !name) || /[A-Za-z]{40,}/.test(word) || pointerLine(word) || [...words.values()].includes(word)) continue;
      words.set(at, word);
      stems.forEach((stem) => got.add(stem));
    }
    return { line: lines[n - 1]!, part, all, words };
  }));
  const pointer = () => `- ${topic}: ${[...new Set(labels.map((label) => [...label.words].sort(([a], [b]) => a - b).map(([, word]) => word).join(" ")).filter(Boolean))].join("; ")}`;
  const number = /^\d+(?:[.,:]\d+)*$/;
  const unit = /^\p{L}{1,3}$/u;
  for (const token of [...held].sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b))) {
    const pointed = pointer().toLowerCase();
    if (held.filter((item) => pointed.includes(item.toLowerCase())).length >= Math.min(3, held.length)) break;
    const label = labels.find((item) => item.part.includes(token)) ?? labels.findLast((item) => item.line.includes(token));
    if (!label || pointed.includes(token.toLowerCase()) || token.includes(";") || pointerLine(token)) continue;
    const kept = new Map(label.words);
    const at = label.all.findIndex((word) => word.includes(token) && !pointerLine(word));
    const offset = label.part.indexOf(token);
    if (at < 0) label.words.set(offset < 0 ? label.all.length : label.part.slice(0, offset).split(/\s+/).length - 1, token);
    // a number keeps its unit, so the pointer never pairs facts the line keeps apart
    else for (const i of [at, ...number.test(label.all[at]!) && unit.test(label.all[at + 1] ?? "") ? [at + 1] : unit.test(label.all[at]!) && number.test(label.all[at - 1] ?? "") ? [at - 1] : []]) label.words.set(i, label.all[i]!);
    if (secretLike(pointer())) label.words = kept;
  }
  return k > 2 && Buffer.byteLength(pointer()) > 300 ? filedPointer(text, ids, topic, 2) : pointer();
}

export function prepareChangeList(input: ValidateInput): ValidateResult {
  let raw = input.list;
  if (typeof raw === "string") { try { raw = parseReply(raw); } catch { return { ok: false, errors: [{ reason: "shape" }] }; } }
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success || parsed.data.file !== input.file) return { ok: false, errors: [{ reason: "shape" }] };
  const list = parsed.data as ChangeList;
  const lines = input.text.split("\n");
  const protectedIds = protectedLines(input.text, input.typed);
  const otherProtection = protectedLines(input.text, input.typed, false);
  const hardIds = protectedLines(input.text, input.typed, true, false);
  const used = new Set<number>();
  const removed = new Set<number>();
  const edits = new Map<number, string[]>();
  const inserts = new Map<number, { plain: string[]; lessons: string[] }>();
  const entries: ArchiveEntry[] = [];
  const topics: Array<{ file: CleanFile; lines: string[]; reason: string }> = [];
  const counts = { merged: 0, replaced: 0, moved: 0 };
  const errors: Array<{ reason: RejectReason; change?: number; over?: number }> = [];
  const fail = (reason: RejectReason, change?: number) => errors.push({ reason, ...(change === undefined ? {} : { change }) });
  const user = input.user ?? [];
  const cr = input.text.includes("\r\n") ? "\r" : "";
  const slots = sleepSlots(lines);
  // a new Lessons section opens after a leading title, never at the end, and is closed unless a heading follows
  const first = lines.findIndex((line) => line.trim());
  const top = first >= 0 && /^#\s/.test(lines[first]!) ? first + 1 : 0;
  const closeLessons = !/^#{1,2}\s/.test(lines.slice(top).find((line) => line.trim()) ?? "");
  let opened = false;
  let lastLesson: ArchiveEntry | undefined;
  let forced = 0;
  let lessonsAt = slots.lessons;
  let learned = 0;
  let filedBytes = 0;
  const insert = (after: number, line: string, lesson: boolean) => {
    const slot = inserts.get(after) ?? { plain: [], lessons: [] };
    inserts.set(after, slot);
    (lesson ? slot.lessons : slot.plain).push(line);
  };
  const prevHash = (n: number) => {
    for (let i = n - 2; i >= 0; i--) if (lines[i]!.trim()) return lineHash(lines[i]!);
    return "";
  };
  const changedIds = (op: ChangeList["changes"][number]) => op.op === "merge" || op.op === "file" ? op.ids : op.op === "learn" || op.op === "own" ? [] : [op.id];
  list.changes.forEach((change, index) => {
    const ids = changedIds(change);
    const refs = change.op === "replace" ? [...ids, change.newer] : change.op === "own" ? [change.id] : ids;
    if (refs.some((n) => !lines[n - 1]?.trim())) { fail("unknown-id", index); return; }
    let pointer = "";
    let extend: { row: number; text: string } | undefined;
    // a topic's pointer row grows up to 300 bytes once a night, then filing moves on to topic-b, topic-c
    while (change.op === "file") {
      const prefix = `- memory/${change.topic}.md: `;
      pointer = change.pointer ?? filedPointer(input.text, ids, prefix.slice(2, -2));
      const row = lines.findLastIndex((line) => line.startsWith(prefix)) + 1;
      const text = row ? `${lines[row - 1]!.replace(/\r$/, "")}; ${pointer.slice(prefix.length)}` : "";
      if (!row || !pointer.startsWith(prefix)) break;
      if (!used.has(row) && Buffer.byteLength(text) <= 300) { extend = { row, text }; used.add(row); break; }
      change.topic = /-[b-y]$/.test(change.topic) ? change.topic.slice(0, -1) + String.fromCharCode(change.topic.charCodeAt(change.topic.length - 1) + 1) : `${change.topic}-b`;
    }
    if (change.op === "merge") change.text = dated(change.text, ids.map((n) => lines[n - 1]!));
    if (change.op === "learn") change.text = undated(change.text);
    if (refs.some((n, i) => used.has(n) || refs.indexOf(n) !== i)) fail("reused-id", index);
    refs.forEach((n) => used.add(n));
    if (/[\r\n]/.test(change.reason) || change.reason.length > 120) fail("too-long", index);
    if ((change.op === "merge" || change.op === "remind") && (/[\r\n]/.test(change.text) || Buffer.byteLength(change.text) > (change.op === "merge" ? 300 : 200) || !change.text.trim())) fail("too-long", index);
    if ((change.op === "split" || change.op === "remind") && input.file === "MEMORY.md") fail("op-not-allowed", index);
    if ((change.op === "learn" || change.op === "own" || change.op === "file") && input.file !== "MEMORY.md") { fail("op-not-allowed", index); return; }
    if (change.op === "remind" && !declinedLine(lines[change.id - 1]!)) fail("op-not-allowed", index);
    if (change.op === "learn") {
      const source = quotedLine(change.quote, user);
      if (/[\r\n]/.test(change.text) || !change.text.trim() || Buffer.byteLength(bullet(change.text)) > 300) fail("too-long", index);
      if (++learned > LEARN_MAX) fail("cap-learn", index);
      if (secretLike(change.text) || secretLike(change.quote)) fail("secret", index);
      const said = source?.text.toLowerCase() ?? "";
      if (!source || factTokens(bullet(change.text)).some((token) => !said.includes(token.toLowerCase()))) { fail("not-quoted", index); return; }
      const words = [...contentWords(change.text)];
      const heard = contentWords(source.text);
      if (words.filter((word) => heard.has(word)).length < 0.6 * words.length || negated(change.text) !== negated(change.quote)) { fail("not-quoted", index); return; }
      const lesson = change.lesson === true;
      const line = `${bullet(change.text)} (noted ${day(source.at)})${cr}`;
      if (Buffer.byteLength(line.replace(/\r$/, "")) > 300) fail("too-long", index);
      const wrote = lesson && lessonsAt === null ? [`## Lessons${cr}`, line] : [line];
      opened ||= wrote.length > 1;
      const after = lesson ? lessonsAt ?? top : slots.plain;
      if (lesson) lessonsAt = after;
      wrote.forEach((item) => insert(after, item, lesson));
      const entry: ArchiveEntry = { header: { file: input.file, op: "learn", at: [], prev: [], wrote, after, quote: change.quote, lesson }, reason: change.reason, lines: [] };
      entries.push(entry);
      if (lesson) lastLesson = entry;
      return;
    }
    if (change.op === "own") {
      if (!quotedLine(change.quote, user, "remember")) fail("not-quoted", index);
      const hash = lineHash(lines[change.id - 1]!);
      entries.push({ header: { file: input.file, op: "own", at: [], prev: [], wrote: [], quote: change.quote, owned: input.typed.has(hash) ? [] : [hash] }, reason: change.reason, lines: [] });
      return;
    }
    if (change.op === "file") {
      const topic = `memory/${change.topic}.md` as CleanFile;
      if (Buffer.byteLength(input.text) <= FILE_FLOOR && lines.length <= 140) fail("op-not-allowed", index);
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(change.topic) || !isMemoryTopicName(`${change.topic}.md`) || isHistory(topic) || /^memory-history/.test(change.topic) || topic === input.side) fail("op-not-allowed", index);
      if (!filePointers(pointer, topic) || secretLike(pointer)) fail("pointer", index);
      const held = [...new Set(ids.flatMap((n) => factTokens(lines[n - 1]!, input.text)))];
      const pointed = pointer.toLowerCase();
      const words = contentWords(pointer);
      // every filed line needs its subject in the pointer, or MEMORY.md alone can't find it
      const named = (line: string) => factTokens(undated(line), input.text).some((token) => pointed.includes(token.toLowerCase())) || [...contentWords(undated(line))].some((word) => words.has(word));
      const relations = (line: string) => undated(line).split(CLAUSES).every((part) => {
        const content = [...clauseWords(part)];
        return !content.length || content.filter((word) => words.has(word)).length >= Math.min(2, content.length);
      });
      if (held.filter((token) => pointed.includes(token.toLowerCase())).length < Math.min(3, held.length) || ids.some((n) => !named(lines[n - 1]!) || !relations(lines[n - 1]!))) fail("pointer", index);
      filedBytes += ids.reduce((n, id) => n + Buffer.byteLength(lines[id - 1]!.replace(/\r$/, "")) + 1, 0);
      if (filedBytes > FILE_MAX_BYTES) fail("cap-file", index);
      const known = topics.find((item) => item.file === topic);
      const moved = ids.map((n) => lines[n - 1]!.replace(/\r$/, ""));
      if (known) known.lines.push(...moved);
      else topics.push({ file: topic, lines: moved, reason: change.reason });
    }
    for (const n of ids) {
      const line = lines[n - 1]!;
      if ((change.op === "retire" || change.op === "file") && openLine(line)) fail("protected", index);
      const exactCopy = change.op === "retire" && lines.some((other, i) => i + 1 !== n && other === line && !list.changes.some((op) => changedIds(op).includes(i + 1)));
      // a rule or pointer line may merge, and a pointer line may file, when every rule word and path stays in the new line
      const into = change.op === "merge" ? change.text : change.op === "file" && !ruleWords(line).length ? pointer : null;
      const loose = into !== null && !hardIds.has(n) && ruleWords(line).every((word) => ruleWords(into).includes(word)) && [...line.matchAll(PATHS)].every(([path]) => into.includes(path));
      if (pointerLine(line) && !exactCopy && !loose) fail("pointer", index);
      if (!protectedIds.has(n)) continue;
      const reminder = change.op === "remind" && input.file !== "MEMORY.md" && declinedLine(line) && !otherProtection.has(n);
      if (!exactCopy && !reminder && !loose) fail("protected", index);
    }
    let wrote: string[] = [];
    if (change.op === "merge") {
      const kept = factTokens(change.text, input.text);
      const words = contentWords(change.text);
      const lost = (line: string) => [...contentWords(line, true)].filter((word) => !words.has(word)).length > 1;
      if (ids.some((n) => factTokens(undated(lines[n - 1]!), input.text).some((token) => !kept.includes(token)) || lost(lines[n - 1]!)) || ids.some((n) => negated(lines[n - 1]!)) !== negated(change.text)) fail("fact-lost", index);
      wrote = [change.text + (lines[ids[0]! - 1]!.endsWith("\r") ? "\r" : "")];
      counts.merged += ids.length;
    } else if (change.op === "replace") {
      const [older, current] = [lines[change.id - 1]!, lines[change.newer - 1]!];
      if (!newer(older, current, change.id, change.newer) || !sameSubject(older, current, input.text)) fail("not-newer", index);
      counts.replaced++;
    } else if (change.op === "split") {
      const line = lines[change.id - 1]!;
      let cursor = 0;
      for (const fragment of change.keep) {
        const at = line.indexOf(fragment, cursor);
        if (at < 0 || /[\r\n]/.test(fragment)) { fail("not-verbatim", index); break; }
        cursor = at + fragment.length;
      }
      const marker = /^(\s*(?:[-*+]|\d+[.)])\s+)/.exec(line)?.[1] ?? "";
      wrote = [marker + change.keep.join(" ") + (line.endsWith("\r") ? "\r" : "")];
      counts.moved++;
    } else if (change.op === "remind") { wrote = [change.text + (lines[change.id - 1]!.endsWith("\r") ? "\r" : "")]; counts.moved++; }
    else if (change.op === "file") wrote = (filePointers(pointer, `memory/${change.topic}.md`) ?? []).map((line) => line + cr);
    else counts.moved++;
    for (const n of ids) removed.add(n);
    if (extend) {
      edits.set(extend.row, [extend.text + cr]);
      entries.push({ header: { file: input.file, op: "file", at: [extend.row], prev: [prevHash(extend.row)], wrote: [extend.text + cr] }, reason: change.reason, lines: [lines[extend.row - 1]!] });
      wrote = [];
    } else if (change.op === "file") {
      wrote.forEach((line) => insert(0, line, false));
      entries.push({ header: { file: input.file, op: "file", at: [], prev: [], wrote, after: 0 }, reason: change.reason, lines: [] });
      wrote = [];
    }
    edits.set(ids[0]!, wrote);
    entries.push({ header: { file: input.file, op: change.op, at: ids, prev: ids.map(prevHash), wrote, ...(change.op === "file" ? { topic: `memory/${change.topic}.md` as CleanFile } : {}) }, reason: change.reason, lines: ids.map((n) => lines[n - 1]!) });
  });
  const assemble = () => [...(inserts.get(0)?.plain ?? []), ...(inserts.get(0)?.lessons ?? []), ...lines.flatMap((line, i) => [
    ...(edits.get(i + 1) ?? (removed.has(i + 1) ? [] : [line])), ...(inserts.get(i + 1)?.plain ?? []), ...(inserts.get(i + 1)?.lessons ?? []),
  ])].join("\n");
  if (opened && lastLesson && closeLessons) {
    lastLesson.header.wrote.push(`## Notes${cr}`);
    insert(lastLesson.header.after!, `## Notes${cr}`, true);
  }
  let text = assemble();
  if (!errors.length && input.file === "MEMORY.md") {
    for (const line of user.filter((item) => item.kind === "remember").reverse().sort((a, b) => b.at - a.at)) {
      if (rememberCovered(line.text, text) || secretLike(line.text)) continue;
      const wrote = rememberRows(line.text)?.map((row) => row + cr);
      const bytes = wrote?.reduce((n, row) => n + Buffer.byteLength(row) + 1, 0) ?? 0;
      // past tonight's room a remember waits for the next night, newest first
      if (!wrote || forced && forced + bytes > REMEMBER_MAX) continue;
      wrote.forEach((row) => insert(slots.plain, row, false));
      forced += bytes;
      entries.push({ header: { file: input.file, op: "own", at: [], prev: [], wrote, after: slots.plain, quote: line.text, owned: wrote.map(lineHash) }, reason: "Asked to remember", lines: [] });
      text = assemble();
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, text, entries, counts, topics, forced };
}

export function validateChangeList(input: ValidateInput): ValidateResult {
  const result = prepareChangeList(input);
  if (!result.ok) return result;
  const { budget, errors } = measureChanges(input.file, input.text, result.text, result.entries);
  return errors.length ? { ok: false, errors, budget } : { ...result, budget };
}
