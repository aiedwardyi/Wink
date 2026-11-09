import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { inflateRawSync } from "node:zlib";

import type { VerifyDocFinding, VerifyDocKind } from "../shared/verify-doc.ts";

export const DOC_EXTS = new Set([".md", ".markdown", ".txt", ".docx"]);
// A printed page: 45 rows of 80 columns, a Hangul or CJK character two columns.
const ROWS = 45;
const COLS = 80;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g;
const MIN = 6_000;
const MAX = 18_000;
const SPREAD = 6_000;
const HITS = 12;
const MODEL_KINDS = new Set<VerifyDocKind>(["spelling", "grammar", "translation", "names"]);
const PARTS = /<w:p\b[^>]*?(\/?)>|<\/w:p>|<w:t\b[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b([^>]*)\/>|<w:lastRenderedPageBreak\/>|<w:pageBreakBefore\b([^>]*)\/>/g;
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const ARTICLE = /제\s*(\d{1,3})\s*조(?!\s*의\s*\d)/g;
const HEADING = /^[\s#*[(]*/;
const SCENE = /^(?:S\s*#|씬|scene)\s*(\d{1,4})\b/i;
const ITEM = /^ ?(\d{1,3})([.)])\s+\S/;
const LABEL = /\b(Exhibit|Appendix|Annex|Attachment|Schedule)\s+([A-Z]|\d{1,2})\b|(별첨|별지|첨부)\s*(\d{1,2})(?!\d)/g;
const LAW = /(?:법|령|규칙|규정|조례|협약|약관)\s*$/;

export interface DocText { text: string; lineStarts: number[]; pages: number[]; pageCount: number }
export interface DocChunk { start: number; end: number }
export interface DocHit { kind: VerifyDocKind; at: number; quote: string; fix: string; note?: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `rendered`: pages come only from Word's own page marks, else breaks plus page size. */
export function docText(raw: string, rendered = false): DocText {
  const lines: string[] = [], pages: number[] = [], lineStarts: number[] = [];
  let page = 1, used = 0, seen = false, at = 0;
  for (const row of raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = row.includes("\f") ? row.replaceAll("\f", "") : row;
    if (line !== row && seen) { page++; used = 0; }
    const height = Math.max(1, Math.ceil((line.length + (line.match(WIDE)?.length ?? 0)) / COLS));
    if (!rendered && used && used + height > ROWS) { page++; used = 0; }
    used += height;
    seen ||= line.trim() !== "";
    lines.push(line); pages.push(page); lineStarts.push(at);
    at += line.length + 1;
  }
  return { text: lines.join("\n"), lineStarts, pages, pageCount: page };
}

function zipEntry(zip: Buffer, name: string): Buffer {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("not a zip");
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0 && zip.readUInt32LE(at) === 0x02014b50; n--) {
    const nameLength = zip.readUInt16LE(at + 28);
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const local = zip.readUInt32LE(at + 42), data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(data, data + zip.readUInt32LE(at + 20));
      return zip.readUInt16LE(at + 10) === 0 ? body : inflateRawSync(body, { maxOutputLength: 64 * 1024 * 1024 });
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  throw new Error(`no ${name}`);
}

export function docxText(zip: Buffer): { raw: string; rendered: boolean } {
  const xml = zipEntry(zip, "word/document.xml").toString("utf8");
  // Word marks every page it laid out; explicit breaks would count those pages twice.
  const rendered = xml.includes("<w:lastRenderedPageBreak/>");
  const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => name[0] === "#" ? String.fromCodePoint(Number.parseInt(name.slice(name[1] === "x" || name[1] === "X" ? 2 : 1), name[1] === "x" || name[1] === "X" ? 16 : 10)) : ENTITIES[name] ?? whole);
  const paragraphs: string[] = [];
  let text = "";
  for (const match of xml.matchAll(PARTS)) {
    const [tag, empty, run, br, before] = match;
    if (tag === "</w:p>" || empty === "/") { paragraphs.push(text); text = ""; }
    else if (run !== undefined) text += decode(run);
    else if (tag === "<w:tab/>") text += "\t";
    else if (br !== undefined) text += /w:type="page"/.test(br) ? rendered ? "" : "\f" : "\n";
    else if (tag === "<w:lastRenderedPageBreak/>") text += "\f";
    else if (before !== undefined && !rendered && !/w:val="(?:0|false|off)"/.test(before)) text += "\f";
  }
  return { raw: paragraphs.join("\n"), rendered };
}

export async function readDoc(path: string): Promise<{ raw: string; rendered: boolean }> {
  const bytes = await readFile(path);
  if (extname(path).toLowerCase() === ".docx") return docxText(bytes);
  return { raw: bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8"), rendered: false };
}

// Below 1 a line ends a chunk. Cuts follow content, not offsets, so an edit re-sends only the chunks around it.
const cutScore = (line: string) => {
  let hash = 2166136261;
  for (let i = 0; i < line.length; i++) hash = Math.imul(hash ^ line.charCodeAt(i), 16777619);
  return (hash >>> 0) / 2 ** 32 * SPREAD / line.length;
};

export function chunkDoc(doc: DocText): DocChunk[] {
  const { text, lineStarts } = doc, chunks: DocChunk[] = [];
  const end = (i: number) => i + 1 < lineStarts.length ? lineStarts[i + 1]! : text.length;
  let start = 0, best = -1, bestScore = Infinity;
  const cut = (at: number) => { chunks.push({ start, end: at }); start = at; best = -1; bestScore = Infinity; };
  for (let i = 0; i < lineStarts.length; i++) {
    const from = lineStarts[i]!, to = end(i);
    if (to - start > MAX && best >= 0) { cut(end(best)); i = best; continue; }
    if (to - start > MAX && from > start) cut(from);
    while (to - start > MAX) {
      const space = text.lastIndexOf(" ", start + MAX - 1);
      cut(space > start + MIN ? space + 1 : start + MAX);
    }
    if (to - start < MIN) continue;
    const score = cutScore(text.slice(from, to));
    if (score < 1) cut(to);
    else if (score < bestScore) { best = i; bestScore = score; }
  }
  const last = chunks.at(-1);
  if (start < text.length && last && text.length - start < MIN / 2 && text.length - last.start <= MAX) last.end = text.length;
  else if (start < text.length || !chunks.length) chunks.push({ start, end: text.length });
  return chunks;
}

export const lineIndex = (doc: DocText, at: number) => {
  let low = 0, high = doc.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (doc.lineStarts[mid]! <= at) low = mid; else high = mid - 1;
  }
  return low;
};

export function findingAt(doc: DocText, hit: DocHit): VerifyDocFinding {
  const index = lineIndex(doc, hit.at);
  return { kind: hit.kind, line: index + 1, page: doc.pages[index]!, quote: hit.quote, fix: hit.fix, ...(hit.note ? { note: hit.note } : {}) };
}

function ordered(rows: { n: number; at: number; quote: string }[], name: (n: number) => string, ko: boolean, hits: DocHit[]) {
  let prev: number | undefined;
  for (const row of rows) {
    if (prev !== undefined && row.n !== prev + 1 && row.n !== 1) {
      const note = row.n === prev ? ko ? `${row.quote} 중복` : `${row.quote} twice` : ko ? `${name(prev)} 다음` : `after ${name(prev)}`;
      hits.push({ kind: "numbering", at: row.at, quote: row.quote, fix: name(prev + 1), note });
    }
    prev = row.n;
  }
}

/** Articles, scenes, numbered lists and appendix references, without the model. */
export function numberingHits(doc: DocText): DocHit[] {
  const ko = /[가-힣]/.test(doc.text.slice(0, 4_000));
  const hits: DocHit[] = [], articles: { n: number; at: number; quote: string }[] = [], scenes: typeof articles = [], refs: typeof articles = [];
  const lists: (typeof articles)[] = [], heads = new Map<string, typeof articles>(), items: { n: number; at: number; quote: string; i: number }[] = [];
  const labels = new Map<string, Set<string>>(), labelRefs: { family: string; label: string; at: number; quote: string }[] = [];
  let fence = false;
  const lines = doc.text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const start = doc.lineStarts[i]!, lead = HEADING.exec(line)![0].length, rest = line.slice(lead);
    for (const match of line.matchAll(ARTICLE)) {
      const row = { n: Number(match[1]), at: start + match.index, quote: match[0] };
      if (match.index === lead) articles.push(row);
      else if (!LAW.test(line.slice(Math.max(0, match.index - 12), match.index))) refs.push(row);
    }
    const scene = SCENE.exec(rest);
    if (scene) scenes.push({ n: Number(scene[1]), at: start + lead, quote: scene[0] });
    const depth = /^#{1,6}(?=\s)/.exec(line)?.[0], head = depth ? ITEM.exec(rest) : null;
    if (head) heads.set(depth!, [...heads.get(depth!) ?? [], { n: Number(head[1]), at: start + lead, quote: `${head[1]}${head[2]}` }]);
    const item = ITEM.exec(line);
    if (item) items.push({ n: Number(item[1]), at: start + line.indexOf(item[1]!), quote: `${item[1]}${item[2]}`, i });
    for (const match of line.matchAll(LABEL)) {
      const family = match[1] ?? match[3]!, label = match[2] ?? match[4]!;
      if (match.index === lead) labels.set(family, (labels.get(family) ?? new Set()).add(label));
      else labelRefs.push({ family, label, at: start + match.index, quote: match[0] });
    }
  }
  const article = (n: number) => `제${n}조`;
  ordered(articles, article, ko, hits);
  ordered(scenes, n => scenes[0]!.quote.replace(/\d+$/, String(n)), ko, hits);
  // A numbered line with no other within 2 lines is a section heading: those follow one sequence across the document.
  const sections: typeof articles = [];
  let previous = -10;
  for (const [k, row] of items.entries()) {
    if (!(row.i - (items[k - 1]?.i ?? -10) <= 2 || (items[k + 1]?.i ?? Infinity) - row.i <= 2)) { sections.push(row); continue; }
    if (row.i - previous > 3) lists.push([]);
    lists.at(-1)!.push(row);
    previous = row.i;
  }
  for (const list of [...heads.values(), sections, ...lists]) if (list.some(row => row.n !== list[0]!.n)) ordered(list, n => `${n}${list[0]!.quote.slice(-1)}`, ko, hits);
  const missing = (quote: string) => ko ? `문서에 ${quote} 없음` : `no ${quote} in this document`;
  const known = new Set(articles.map(row => row.n)), told = new Set<string>();
  if (articles.length >= 2) for (const ref of refs) if (!known.has(ref.n) && !told.has(article(ref.n))) {
    told.add(article(ref.n));
    hits.push({ kind: "numbering", at: ref.at, quote: ref.quote, fix: "", note: missing(ref.quote) });
  }
  for (const ref of labelRefs) if (labels.get(ref.family) && !labels.get(ref.family)!.has(ref.label) && !told.has(ref.quote)) {
    told.add(ref.quote);
    hits.push({ kind: "numbering", at: ref.at, quote: ref.quote, fix: "", note: missing(ref.quote) });
  }
  return hits.sort((a, b) => a.at - b.at);
}

export function chunkPrompt(doc: DocText, chunk: DocChunk, file: string): string {
  const from = lineIndex(doc, chunk.start) + 1, to = lineIndex(doc, Math.max(chunk.start, chunk.end - 1)) + 1;
  return [
    "Proofread this excerpt of a document. Report only clear mistakes a careful editor would correct. Never report style, tone, word choice, missing content, or text that is correct.",
    "Ignore Korean spacing (띄어쓰기) on its own. Leave dialogue slang, dialect, names, and intentional spellings alone. Do not report numbering.",
    "Kinds:",
    "- spelling: a misspelled word or typo, including Korean spelling (맞춤법)",
    "- grammar: a clear grammar error, such as a wrong particle or ending, or a missing or doubled word",
    "- translation: a sentence and its translation next to it disagree in meaning, names, or numbers",
    "- names: one person, company, or term written two different ways in this excerpt (quote the rarer form), or one event given two different dates",
    'Reply with JSON only: {"findings":[{"kind":"spelling","quote":"exact text from the excerpt","fix":"text that replaces quote","note":"why, at most 8 words"}],"names":["each distinct person or company name"],"dates":[{"date":"as written","what":"the event, at most 6 words"}]}',
    "quote is copied character for character from the excerpt, 2 to 60 characters, long enough to be unique. At most 12 findings, 20 names, 10 dates. With no mistakes, findings is [].",
    `Excerpt of ${basename(file)}, lines ${from}-${to}:`,
    "<<<",
    doc.text.slice(chunk.start, chunk.end),
    ">>>",
  ].join("\n");
}

const count = (text: string, part: string) => {
  let n = 0;
  for (let at = text.indexOf(part); at >= 0 && n < 9_999; at = text.indexOf(part, at + part.length)) n++;
  return n;
};

/** null when there is nothing to compare across chunks */
export function mergePrompt(doc: DocText, names: string[], dates: string[]): string | null {
  const counted = [...new Set(names)].map(name => [name, count(doc.text, name)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 80);
  const listed = [...new Set(dates)].slice(0, 60);
  if (counted.length < 2 && listed.length < 2) return null;
  return [
    "These names and dates come from one long document. Counts are how often each exact form appears.",
    "Find a person, company, or term written two different ways that clearly mean the same one (the rare form is the mistake), and one event given two different dates.",
    "Different people, companies, or events are not mistakes. Report only clear cases.",
    'Reply with JSON only: {"findings":[{"kind":"names","quote":"the wrong form, exactly as listed","fix":"the form to use","note":"why, at most 8 words"}]}. With none, findings is [].',
    "Names:", ...counted.map(([name, n]) => `${name} ×${n}`),
    "Dates:", ...listed,
  ].join("\n");
}

function json(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(reply.slice(start, end + 1));
    return record(value) ? value : null;
  } catch { return null; }
}

function hits(rows: unknown, text: string, offset: number, kinds: Set<VerifyDocKind>): DocHit[] {
  const out: DocHit[] = [], seen = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (out.length >= HITS) break;
    if (!record(row) || !kinds.has(row.kind as VerifyDocKind) || typeof row.quote !== "string" || typeof row.fix !== "string") continue;
    const quote = row.quote.trim(), fix = row.fix.trim(), index = quote ? text.indexOf(quote) : -1;
    // The quote must be in the text: a model's claim alone never becomes a finding.
    if (index < 0 || quote.length > 120 || !fix || fix === quote || fix.length > 200 || seen.has(`${quote}\n${fix}`)) continue;
    seen.add(`${quote}\n${fix}`);
    const note = typeof row.note === "string" ? row.note.trim().slice(0, 80) : "";
    out.push({ kind: row.kind as VerifyDocKind, at: offset + index, quote, fix, ...(note ? { note } : {}) });
  }
  return out;
}

/** `ok`: the reply was the JSON asked for, so no findings means none. */
export function parseChunkReply(reply: string, doc: DocText, chunk: DocChunk): { ok: boolean; hits: DocHit[]; names: string[]; dates: string[] } {
  const value = json(reply);
  const names = (Array.isArray(value?.names) ? value.names : []).slice(0, 20).flatMap(name => typeof name === "string" && name.trim() ? [name.trim().slice(0, 60)] : []);
  const dates = (Array.isArray(value?.dates) ? value.dates : []).slice(0, 10).flatMap(row => {
    if (!record(row) || typeof row.date !== "string" || !row.date.trim()) return [];
    const what = typeof row.what === "string" ? row.what.trim().slice(0, 60) : "";
    return [`${row.date.trim().slice(0, 40)}${what ? ` (${what})` : ""}`];
  });
  return { ok: Array.isArray(value?.findings), hits: hits(value?.findings, doc.text.slice(chunk.start, chunk.end), chunk.start, MODEL_KINDS), names, dates };
}

export function parseMergeReply(reply: string, doc: DocText): DocHit[] {
  return hits(json(reply)?.findings, doc.text, 0, new Set(["names"]));
}

/** One event the model dated two ways, both in the text: the rarer date is the slip. */
export function dateClashes(doc: DocText, dates: string[]): DocHit[] {
  const ko = /[가-힣]/.test(doc.text.slice(0, 4_000)), events = new Map<string, Set<string>>(), hits: DocHit[] = [];
  for (const row of dates) {
    const match = /^(.+?) \((.+)\)$/.exec(row), what = match?.[2]!.replace(/\([^()]*\)/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (match && what?.includes(" ")) events.set(what, (events.get(what) ?? new Set()).add(match[1]!));
  }
  const numbers = (date: string) => new Set(date.match(/\d+/g)?.map(Number));
  for (const forms of events.values()) {
    const seen = [...forms].map(date => ({ date, n: count(doc.text, date), at: doc.text.indexOf(date) })).filter(row => row.n > 0).sort((a, b) => b.n - a.n || a.at - b.at);
    if (seen.length !== 2) continue;
    const [common, rare] = seen as [(typeof seen)[0], (typeof seen)[0]], a = numbers(common.date), b = numbers(rare.date);
    // The same digits in another format ("2024. 3. 15." and "2024년 3월 15일") are one date.
    if ([...a].every(n => b.has(n)) || [...b].every(n => a.has(n))) continue;
    hits.push({ kind: "names", at: rare.at, quote: rare.date, fix: common.date, note: ko ? "같은 일, 다른 날짜" : "same event, another date" });
  }
  return hits;
}

const oneOff = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return Math.abs(a.length - b.length) <= 1 && a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
};

/** A listed name used once or twice, one letter off a listed name used far more: the rare one is the slip. */
export function nameTwins(doc: DocText, names: string[]): DocHit[] {
  const ko = /[가-힣]/.test(doc.text.slice(0, 4_000)), hits: DocHit[] = [];
  const counted = [...new Set(names)].filter(name => name.length >= 2).map(name => ({ name, n: count(doc.text, name) })).filter(row => row.n > 0);
  for (const rare of counted) {
    // "서연아" next to "서연" is the same name with a particle, not a slip.
    const twin = rare.n <= 2 ? counted.find(row => row.n >= Math.max(3, 3 * rare.n) && !row.name.includes(rare.name) && !rare.name.includes(row.name) && oneOff(rare.name, row.name)) : undefined;
    if (twin) hits.push({ kind: "names", at: doc.text.indexOf(rare.name), quote: rare.name, fix: twin.name, note: ko ? `다른 곳은 ${twin.name} (${twin.n}번)` : `elsewhere ${twin.name} (${twin.n} times)` });
  }
  return hits;
}
