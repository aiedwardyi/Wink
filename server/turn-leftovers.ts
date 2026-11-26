import type { Message } from "./store.ts";
import { askTerms, isOpenAsk, type TaskAsk } from "./task-asks.ts";

// #2073's first-person commitment, in English or Korean
const COMMIT = /\b(?:i['’]ll|i will(?! not\b)|i['’]m going to|i am going to)\b|(?:할|볼|드릴|둘|놓을)\s?[게께]요?(?=[\s.!~]|$)/i;
// #2073's time or trigger: a final reply's "I'll" counts only with one, since the rest is where the turn stopped
const DEFERRED = /\b(?:later|tomorrow|tonight|today|overnight|noon|midnight|when|once|after|before|next|by|(?:mon|tues|wednes|thurs|fri|satur|sun)day|this (?:morning|afternoon|evening|week|weekend)|in (?:an?|\d+) (?:minutes?|hours?|days?|weeks?))\b|\b\d{1,2}(?::\d{2})?\s?[ap]\.?m\b|\bat \d{1,2}(?::\d{2})?\b|나중에|내일|오늘|이따|다음에|되면|끝나면|켜시면|하시면|후에|\d{1,2}시/i;
const FILLER = /^(?:(?:ok(?:ay)?|sure|got it|alright)[,!.]?\s+)?(?:let me|lemme|one (?:moment|sec(?:ond)?)|give me a (?:sec(?:ond)?|moment|minute)|hold on|just a (?:sec(?:ond)?|moment))\b|^(?:잠시만|잠깐만)/i;
// an offer waits on the user's yes; "check if it exists" and "the feature you want" are still promises
const OFFER = /\b(?:if|unless) (?:you|needed|wanted|useful|helpful)\b|\b(?:want me to|would you like|shall i|maybe|perhaps)\b|원하시면|괜찮으시면/i;
const REPORT = /\b(?:done|checked|fixed|finished|confirmed|verified|sent|merged|tested)\b|했어요|했습니다|완료/i;
const DENIED = /\b(?:not|never|no|cannot)\b|n['’]t\b|(?:^|\s)(?:안|못)\s/i;
const HEDGED = /\b(?:if|unless|maybe|perhaps|in case)\b/i;
// #2073's take-back: it opens its sentence, and one that names nothing is about the promise right before it
const WITHDRAWN = /^(?:(?:actually|oh|oops|sorry|wait|no)[,!.]?\s+)*(?:scratch that|never ?mind|cancel that)\b|취소할게요/i;
// "running as PID 4128": the work is underway, so the next reply must check on it, never start it again
const RUNNING = /\b(?:running|in progress|under ?way|kicked off|pid \d+)\b|실행 중|진행 중/i;
const TIMES = new RegExp(DEFERRED.source, "gi");
const SENTENCE = /(?<=[.!?。！？])\s+|\n+/;
const CODE = /(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g;
const QUESTION = /[?？]$/;

const sentences = (text: string) => text.replace(CODE, "$1").split(SENTENCE)
  .map((part) => part.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
// "Logs are clean, no errors" still reports the logs; "I couldn't rebuild the picker" reports nothing
const clauses = (line: string) => line.split(/[,;:]\s*|\s+(?:but|though)\s+/i).map((part) => part.trim()).filter((part) => part && !DENIED.test(part));
const said = (row: Message) => row.role === "bot" && row.kind === "text" && !row.roomEcho && Boolean(row.text?.trim());
const PLAIN = new Set(["a", "an", "the", "i", "me", "my", "myself", "you", "your", "yourself", "we", "us", "our", "it", "its", "this", "that", "these", "those", "there", "here", "them", "they", "their", "to", "of", "for", "on", "in", "at", "with", "from", "into", "about", "up", "out", "off", "as", "and", "or", "but", "so", "if", "then", "than", "until", "also", "just", "now", "still", "really", "actually", "sorry", "okay", "ok", "anyway", "instead", "though", "again", "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "going", "s", "t", "ll", "ve", "re", "d", "m", "그거", "그건", "이거"]);
const COMMON = new Set("all and any are but can for get got had has how its let new not now off one our out see the too two was way who why you".split(" "));
// with the short ones a subject can be: "the API", "the bug"
function words(text: string): Set<string> {
  const found = askTerms(text);
  for (const word of text.toLowerCase().match(/\b[a-z0-9]{2,3}\b/g) ?? []) if (!COMMON.has(word) && !PLAIN.has(word)) found.add(word);
  return found;
}
// half its words come back in what followed
const covered = (item: Set<string>, later: Set<string>) => [...item].filter((term) => later.has(term)).length * 2 >= item.size;

/** What a promise is about: its words after "I'll" and the verb, or before a Korean ending, less when it happens. */
function object(promise: string): Set<string> {
  const marker = COMMIT.exec(promise)!;
  const about = /^i/i.test(marker[0]) ? promise.slice(marker.index + marker[0].length).replace(/^\s*\S+/, "") : promise.slice(0, marker.index);
  return words(about.replace(TIMES, " ").replace(/\b(?:first|again|right away|quickly)\b/gi, " "));
}

// #2073's whole-word match of a report to the promise it names
const terms = (text: string) => new Set((text.match(/[\p{L}\p{N}]+/gu) ?? [])
  .map((word) => (/^\p{Lu}$/u.test(word) && word !== "I" ? word : word.toLowerCase())).filter((word) => !PLAIN.has(word)));
const named = (text: string) => terms(text.replace(TIMES, " "));
function promised(promise: string): Set<string> {
  const marker = COMMIT.exec(promise);
  if (marker && !/^i/i.test(marker[0])) return named(promise.slice(0, marker.index));
  return named((marker ? promise.slice(marker.index + marker[0].length) : promise).replace(/^\s*\S+/, ""));
}
function verb(promise: string): string | undefined {
  const marker = COMMIT.exec(promise);
  if (marker && !/^i/i.test(marker[0])) return undefined;
  return /^\s*(\p{L}+)/u.exec(marker ? promise.slice(marker.index + marker[0].length) : promise)?.[1]?.toLowerCase();
}
const forms = (does: string) => {
  const stem = does.replace(/e$/, "");
  const ied = does.replace(/([^aeiou])y$/, "$1i");
  return new Set([does, `${does}s`, `${ied}es`, `${stem}ed`, `${ied}ed`, `${stem}ing`, `${does}${does.slice(-1)}ed`, `${does}${does.slice(-1)}ing`]);
};
const PAST = new Map([["build", ["built"]], ["do", ["did"]], ["find", ["found"]], ["make", ["made"]], ["put", ["put"]], ["read", ["read"]], ["run", ["ran"]], ["send", ["sent"]], ["set", ["set"]], ["write", ["wrote", "written"]]]);
// "updated", "built": the promise's own action, said as done
const pastOf = (does: string) => [...forms(does)].filter((form) => form.endsWith("ed")).concat(PAST.get(does) ?? []);
const POINTED = new Set(["i", "me", "my", "myself", "you", "your", "yourself", "we", "us", "our", "them", "they", "their", "if", "until"]);
const bare = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).every((word) => PLAIN.has(word.toLowerCase()) && !POINTED.has(word.toLowerCase()));
const own = (promise: string) => {
  const does = verb(promise);
  return new Set([...terms(promise.replace(COMMIT, " ")), ...(does ? forms(does) : [])]);
};

/** A line is about a promise only when it names that promise's whole object in its order, and its action, as whole words, and more of it than of each other promise. */
function namesPromise(line: string, promise: string, others: readonly string[]): boolean {
  const found = terms(line);
  const shared = (text: string) => [...own(text)].filter((word) => found.has(word));
  const about = promised(promise);
  const does = verb(promise);
  const hits = shared(promise);
  const action = (does !== undefined && [...forms(does)].some((form) => found.has(form))) || hits.length === found.size;
  const whole = about.size > 0 && [...found].filter((word) => about.has(word)).join(" ") === [...about].join(" ");
  return !DENIED.test(line) && !HEDGED.test(line) && hits.length > 0 && whole && action
    && others.map(shared).every((theirs) => theirs.length < hits.length && theirs.every((word) => hits.includes(word)));
}

// "The icon is updated" never finishes "update the icon and layout"; "Please update the labels" finishes nothing
function finished(line: string, promise: string, others: readonly string[]): boolean {
  const does = verb(promise);
  const found = terms(line);
  return (REPORT.test(line) || (does !== undefined && pastOf(does).some((form) => found.has(form)))) && namesPromise(line, promise, others);
}

/** The open promises and the user's open questions this turn settled: a promise its text reports done, whole, and a question its shown reply took up. */
export function settledAsks(rows: readonly Message[], asks: readonly TaskAsk[] | undefined): string[] {
  const open = (asks ?? []).filter((ask) => isOpenAsk(ask) && (ask.kind === "promise" || (!ask.kind && QUESTION.test(ask.ask))));
  if (!open.length) return [];
  const text = rows.filter((row) => said(row) && !row.quick);
  const reports = text.flatMap((row) => sentences(row.text!)).filter((line) => !COMMIT.test(line) && !QUESTION.test(line));
  const seen = words(text.filter((row) => !row.summarized).flatMap((row) => sentences(row.text!).flatMap(clauses)).join("\n"));
  const promises = open.filter((ask) => ask.kind === "promise").map((ask) => ask.ask);
  return open.filter((ask) => ask.kind === "promise"
    ? reports.some((line) => finished(line, ask.ask, promises.filter((other) => other !== ask.ask)))
    : covered(words(ask.ask), seen)).map((ask) => ask.id);
}

/** running: the line that said it is underway */
export interface Leftover { ask: string; promise?: true; running?: string }

/** What a settled turn left open: an "I'll" that nothing after it finished, whole, or one in the last text on a time, then a question of the user's a steer talked over before any reply they saw, or one a reply skipped while it took up another. rows: the turn in order, from the message that started it. */
export function turnLeftovers(rows: readonly Message[]): Leftover[] {
  const own = (row: Message) => said(row) && !row.quick;
  const last = rows.findLast(own);
  // a turn with no "I'll" reads no further
  const from = rows.findIndex((row) => own(row) && COMMIT.test(row.text!));
  const lines = from < 0 ? [] : rows.slice(from).flatMap((row) => row.tool
    ? [{ line: [row.tool.name, row.tool.summary, ...(row.tool.writes ?? [])].join(" "), commit: false, tool: true }]
    : !own(row) ? []
    : sentences(row.text!).map((line) => ({ line, tool: false, commit: COMMIT.test(line) && !OFFER.test(line) && !FILLER.test(line) && !QUESTION.test(line) && (row !== last || DEFERRED.test(line)) })));
  for (const [at, { line }] of lines.entries()) {
    if (!WITHDRAWN.test(line)) continue;
    const taken = line.replace(WITHDRAWN, " ");
    const promises = lines.slice(0, at).filter(({ commit }) => commit);
    const dropped = bare(taken) ? promises.slice(-1) : promises.filter((promise) => namesPromise(taken, promise.line, promises.filter((other) => other !== promise).map((other) => other.line)));
    for (const promise of dropped) promise.commit = false;
  }
  const left: Leftover[] = [];
  // each word's last mention after the line at hand: what the turn ended up saying about it
  const latest = new Map<string, { at: number; text: string }>();
  const heard = new Set<string>();
  let at = 0;
  for (const { line, commit, tool } of lines.toReversed()) {
    if (!commit) {
      for (const text of (tool ? [line] : clauses(line)).toReversed()) {
        // a repeat says nothing the later copy did not
        if (heard.has(text)) continue;
        heard.add(text);
        at += 1;
        for (const term of words(text)) if (!latest.has(term)) latest.set(term, { at, text });
      }
      continue;
    }
    const about = [...object(line)].map((term) => latest.get(term));
    if (!about.length) continue;
    const last = about.reduce((pick, said) => (said && (!pick || said.at < pick.at) ? said : pick), undefined);
    if (last && RUNNING.test(last.text)) left.unshift({ ask: line, promise: true, running: last.text });
    else if (about.some((said) => !said)) left.unshift({ ask: line, promise: true });
  }
  const asked = rows.flatMap((row, at) => row.role === "user" && row.kind === "text" && row.text?.trim() && (!row.quick || row.quick.state === "handoff") && (at === 0 || row.steered) ? [at] : []);
  const shown = (row: Message) => said(row) && !row.summarized;
  for (const [i, at] of asked.entries()) {
    const next = asked[i + 1];
    if (next !== undefined && (rows.slice(at + 1, next).some(shown) || rows.some((row) => row.quick?.askId === rows[at]!.id))) continue;
    const seen = words(rows.slice(next ?? at + 1).filter(shown).map((row) => row.text).join("\n"));
    const questions = sentences(rows[at]!.text!).filter((line) => QUESTION.test(line)).map((ask) => ({ ask, terms: words(ask) })).filter(({ terms }) => terms.size);
    const skipped = questions.filter(({ terms }) => !covered(terms, seen));
    // the last message's reply took none up: it answered its own way
    if (next === undefined && skipped.length === questions.length) continue;
    left.push(...skipped.map(({ ask }) => ({ ask })));
  }
  return left;
}
