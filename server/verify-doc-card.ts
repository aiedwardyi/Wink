import type { VerifyCardData } from "../shared/live-verify.ts";
import { VERIFY_DOC_FINDINGS, VERIFY_DOC_KINDS, type VerifyDocData, type VerifyDocFinding, type VerifyDocKind } from "../shared/verify-doc.ts";
import { redactSecretsInText } from "./redact.ts";

const KINDS = new Set<VerifyDocKind>(VERIFY_DOC_KINDS);
const WORDS: Record<VerifyDocKind, string> = { spelling: "spelling", grammar: "grammar", translation: "translation", names: "names and dates", numbering: "numbering" };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max: number) => typeof value === "string" ? redactSecretsInText(value).slice(0, max) : null;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function finding(value: unknown): VerifyDocFinding | null {
  if (!record(value) || !KINDS.has(value.kind as VerifyDocKind) || !count(value.line) || !count(value.page)) return null;
  const quote = text(value.quote, 120), fix = text(value.fix, 200), note = text(value.note, 80);
  if (!quote || fix === null) return null;
  return { kind: value.kind as VerifyDocKind, line: value.line, page: value.page, quote, fix, ...(note ? { note } : {}) };
}

export function redactVerifyDoc(value: unknown): VerifyDocData | undefined {
  if (!record(value) || !count(value.pages) || !count(value.lines) || !Array.isArray(value.chunks) || value.chunks.length !== 2) return undefined;
  const [done, total] = value.chunks as unknown[];
  if (!count(done) || !count(total) || done > total) return undefined;
  const out: VerifyDocData = { pages: value.pages, lines: value.lines, chunks: [done, total] };
  if (count(value.page)) out.page = value.page;
  if (count(value.beat)) out.beat = value.beat;
  const by = value.by;
  if (record(by)) out.by = Object.fromEntries(VERIFY_DOC_KINDS.filter(kind => count(by[kind])).map(kind => [kind, by[kind]])) as VerifyDocData["by"];
  if (Array.isArray(value.findings)) out.findings = value.findings.slice(0, VERIFY_DOC_FINDINGS).map(finding).filter(row => row !== null);
  if (count(value.findingTotal)) out.findingTotal = value.findingTotal;
  if (count(value.cut) && value.cut > 0) out.cut = value.cut;
  if (value.uncompared === true) out.uncompared = true;
  if (value.fixing === true) out.fixing = true;
  if (Array.isArray(value.fixedFindings)) out.fixedFindings = value.fixedFindings.slice(0, VERIFY_DOC_FINDINGS).map(finding).filter(row => row !== null);
  return out;
}

export function docCardText(card: VerifyCardData): string {
  if (card.status === "preparing" || card.status === "running" || card.status === "waiting") return `Live Verify is checking ${card.site}.`;
  if (card.status !== "completed") return `Live Verify could not finish checking ${card.site}.`;
  const total = card.doc?.findingTotal ?? 0;
  if (!total) return card.fixed ? `Live Verify checked ${card.site}: fixed ${plural(card.fixed, "problem")}, none left.` : `Live Verify checked ${card.site}: no problems found.`;
  const by = VERIFY_DOC_KINDS.flatMap(kind => card.doc?.by?.[kind] ? [`${card.doc.by[kind]} ${WORDS[kind]}`] : []).join(", ");
  return `Live Verify checked ${card.site}: ${card.fixed ? `fixed ${plural(card.fixed, "problem")}, ${total} left` : plural(total, "problem")}${by ? ` (${by})` : ""}.`;
}
