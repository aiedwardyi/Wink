import type { Message } from "./store.ts";
import { askTerms } from "./task-asks.ts";

// #2073's first-person commitment, in English or Korean
const COMMIT = /\b(?:i['’]ll|i will(?! not\b)|i['’]m going to|i am going to)\b|(?:할|볼|드릴|둘|놓을)\s?[게께]요?(?=[\s.!~]|$)/i;
// an offer waits on the user's yes
const OFFER = /\b(?:if|unless|want|would|shall|maybe|perhaps)\b|원하시면|괜찮으시면/i;
const SENTENCE = /(?<=[.!?。！？])\s+|\n+/;
const CODE = /(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g;

const sentences = (text: string) => text.replace(CODE, "$1").split(SENTENCE)
  .map((part) => part.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
const said = (row: Message) => row.role === "bot" && row.kind === "text" && !row.roomEcho && Boolean(row.text?.trim());
// half its words come back in what followed
const covered = (item: Set<string>, later: Set<string>) => [...item].filter((term) => later.has(term)).length * 2 >= item.size;

/** What a promise is about: its words after "I'll" and the verb, or before a Korean ending. */
function object(promise: string): Set<string> {
  const marker = COMMIT.exec(promise)!;
  if (!/^i/i.test(marker[0])) return askTerms(promise.slice(0, marker.index));
  return askTerms(promise.slice(marker.index + marker[0].length).replace(/^\s*\S+/, ""));
}

export interface Leftover { ask: string; promise?: true }

/** What a settled turn left open: an "I'll" before its last text that nothing after it took up, then a question of the user's that a steer talked over before any reply they saw, which nothing they saw later took up. rows: the turn in order, from the message that started it. */
export function turnLeftovers(rows: readonly Message[]): Leftover[] {
  const own = (row: Message) => said(row) && !row.quick;
  const last = rows.findLast(own);
  // a turn with no "I'll" before its last text reads no further
  const from = rows.findIndex((row) => row !== last && own(row) && COMMIT.test(row.text!));
  // the last text's promises are where the turn stopped, not work it skipped; it, a row with no promise and a tool call only cover
  const lines = from < 0 ? [] : rows.slice(from).flatMap((row) => row.tool
    ? [{ line: [row.tool.name, row.tool.summary, ...(row.tool.writes ?? [])].join(" "), commit: false }]
    : !own(row) ? [] : row === last || !COMMIT.test(row.text!) ? [{ line: row.text!, commit: false }]
    : sentences(row.text!).map((line) => ({ line, commit: COMMIT.test(line) && !OFFER.test(line) && !/[?？]$/.test(line) })));
  const left: Leftover[] = [];
  const later = new Set<string>();
  let after: string[] = [];
  for (const { line, commit } of lines.toReversed()) {
    if (!commit) {
      after.push(line);
      continue;
    }
    for (const term of askTerms(after.join("\n"))) later.add(term);
    after = [];
    const about = object(line);
    if (about.size && !covered(about, later)) left.unshift({ ask: line, promise: true });
  }
  const asked = rows.flatMap((row, at) => row.role === "user" && row.kind === "text" && row.text?.trim() && !row.quick && (at === 0 || row.steered) ? [at] : []);
  for (const [i, at] of asked.slice(0, -1).entries()) {
    const shown = (row: Message) => said(row) && !row.summarized;
    if (rows.slice(at + 1, asked[i + 1]).some(shown) || rows.some((row) => row.quick?.askId === rows[at]!.id)) continue;
    const seen = askTerms(rows.slice(asked[i + 1]).filter(shown).map((row) => row.text).join("\n"));
    for (const question of sentences(rows[at]!.text!).filter((line) => /[?？]$/.test(line))) {
      const terms = askTerms(question);
      if (terms.size && !covered(terms, seen)) left.push({ ask: question });
    }
  }
  return left;
}
