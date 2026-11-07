import { z } from "zod";

import { cleanFileSchema, lineHash } from "./memory-clean-format.ts";
import type { ArchiveEntry, ChangeList, RejectReason, ValidateInput, ValidateResult } from "./memory-clean-types.ts";
import { withSystemChanges } from "./turn-context.ts";

const id = z.number().int().positive();
const reason = z.string();
const changeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("merge"), ids: z.array(id).min(2).max(3), text: z.string(), reason }).strict(),
  z.object({ op: z.literal("replace"), id, newer: id, reason }).strict(),
  z.object({ op: z.literal("retire"), id, reason }).strict(),
  z.object({ op: z.literal("split"), id, keep: z.array(z.string().min(1)).min(1), reason }).strict(),
  z.object({ op: z.literal("remind"), id, text: z.string(), reason }).strict(),
]);
const listSchema = z.object({ version: z.literal(1), file: cleanFileSchema, changes: z.array(changeSchema) }).strict();
export const pointerLine = (line: string) => /\bmemory\/[\w][\w .-]*\.md\b/.test(line);
export const declinedLine = (line: string) => /\b(declined?|rejected?|ruled out|turned down|chose against)\b|거절|사양|선택하지|하지 않기로/i.test(line);

export function protectedLines(text: string, typed: ReadonlySet<string>, includeDeclined = true): Set<number> {
  const protectedIds = new Set<number>();
  let pinnedDepth = 0;
  text.split("\n").forEach((line, i) => {
    const heading = /^(#{1,6})\s+(.+)/.exec(line);
    if (heading) {
      if (pinnedDepth && heading[1]!.length <= pinnedDepth) pinnedDepth = 0;
      if (/\bpinned\b|고정/i.test(heading[2]!)) pinnedDepth = heading[1]!.length;
    }
    if (pinnedDepth || /\(pinned\)\s*$/i.test(line) || typed.has(lineHash(line)) || pointerLine(line) || includeDeclined && declinedLine(line) ||
      /\b(corrections?|corrected|lessons?|rules?|preferences?|prefer(?:s|red)?|always|never|don['’]t|do not|must|should)\b|항상|절대|하지\s*마|교정|정정|교훈|규칙|선호/i.test(line)) protectedIds.add(i + 1);
  });
  return protectedIds;
}

export function factTokens(text: string, base = text): string[] {
  const pattern = /"[^"\n]+"|“[^”\n]+”|'[^'\n]+'|`[^`\n]+`|(?:[A-Za-z]:[\\/]|\.{0,2}\/|https?:\/\/)[^\s,;<>"`]+|\d{4}-\d{2}-\d{2}|\d+(?:[.,:/%-]\d+)*(?:%|[A-Za-z]+)?|[\p{L}\p{N}_-]+\.(?:md|ts|json|py|txt|com|org)\b|(?<![\p{L}\p{N}_-])[\p{L}_]*[\p{Lu}][\p{L}\p{N}_-]*/gu;
  const initial = (source: string, at: number) => /(?:^|\n|[.!?]\s+)[ \t>*#+\-\d.)]*$/u.test(source.slice(0, at));
  const midSentence = new Set([...base.matchAll(pattern)].filter((match) => !initial(base, match.index)).map((match) => match[0]));
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

export function validateChangeList(input: ValidateInput): ValidateResult {
  let raw = input.list;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return { ok: false, errors: [{ reason: "shape" }] }; } }
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success || parsed.data.file !== input.file) return { ok: false, errors: [{ reason: "shape" }] };
  const list = parsed.data as ChangeList;
  const lines = input.text.split("\n");
  const protectedIds = protectedLines(input.text, input.typed);
  const otherProtection = protectedLines(input.text, input.typed, false);
  const used = new Set<number>();
  const touched = new Set<number>();
  const removed = new Set<number>();
  const edits = new Map<number, string[]>();
  const entries: ArchiveEntry[] = [];
  const counts = { merged: 0, replaced: 0, moved: 0 };
  const errors: Array<{ reason: RejectReason; change?: number }> = [];
  const fail = (reason: RejectReason, change?: number) => errors.push({ reason, ...(change === undefined ? {} : { change }) });
  list.changes.forEach((change, index) => {
    const ids = change.op === "merge" ? change.ids : [change.id];
    const refs = change.op === "replace" ? [...ids, change.newer] : ids;
    if (refs.some((n) => !lines[n - 1]?.trim())) { fail("unknown-id", index); return; }
    if (refs.some((n, i) => used.has(n) || refs.indexOf(n) !== i)) fail("reused-id", index);
    refs.forEach((n) => used.add(n));
    ids.forEach((n) => touched.add(n));
    if (/[\r\n]/.test(change.reason) || change.reason.length > 120) fail("too-long", index);
    if ((change.op === "merge" || change.op === "remind") && (/[\r\n]/.test(change.text) || Buffer.byteLength(change.text) > (change.op === "merge" ? 300 : 200) || !change.text.trim())) fail("too-long", index);
    if ((change.op === "split" || change.op === "remind") && input.file === "MEMORY.md") fail("op-not-allowed", index);
    if (change.op === "remind" && !declinedLine(lines[change.id - 1]!)) fail("op-not-allowed", index);
    for (const n of ids) {
      const line = lines[n - 1]!;
      const exactCopy = change.op === "retire" && lines.some((other, i) => i + 1 !== n && other === line && !list.changes.some((op) => (op.op === "merge" ? op.ids : [op.id]).includes(i + 1)));
      if (pointerLine(line) && !exactCopy) fail("pointer", index);
      if (!protectedIds.has(n)) continue;
      const reminder = change.op === "remind" && input.file !== "MEMORY.md" && declinedLine(line) && !otherProtection.has(n);
      if (!exactCopy && !reminder) fail("protected", index);
    }
    let wrote: string[] = [];
    if (change.op === "merge") {
      const kept = factTokens(change.text, input.text);
      if (ids.some((n) => factTokens(lines[n - 1]!, input.text).some((token) => !kept.includes(token)))) fail("fact-lost", index);
      wrote = [change.text + (lines[ids[0]! - 1]!.endsWith("\r") ? "\r" : "")];
      counts.merged += ids.length;
    } else if (change.op === "replace") {
      if (!newer(lines[change.id - 1]!, lines[change.newer - 1]!, change.id, change.newer)) fail("not-newer", index);
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
    else counts.moved++;
    for (const n of ids) removed.add(n);
    edits.set(ids[0]!, wrote);
    entries.push({ header: { file: input.file, op: change.op, at: ids, prev: ids.map((n) => {
      for (let i = n - 2; i >= 0; i--) if (lines[i]!.trim()) return lineHash(lines[i]!);
      return "";
    }), wrote }, reason: change.reason, lines: ids.map((n) => lines[n - 1]!) });
  });
  const text = lines.flatMap((line, i) => edits.get(i + 1) ?? (removed.has(i + 1) ? [] : [line])).join("\n");
  if (touched.size > 40) fail("cap-lines");
  if (withSystemChanges("", input.text, text, 8000) === null) fail("cap-chars");
  if (input.file === "MEMORY.md" && (Buffer.byteLength(text) > 24000 || text.split("\n").length > 200)) fail("budget");
  return errors.length ? { ok: false, errors } : { ok: true, text, entries, counts };
}
