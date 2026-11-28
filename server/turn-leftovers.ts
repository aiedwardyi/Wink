import type { Message } from "./store.ts";

// #2073's first-person commitment, in English or Korean
const COMMIT = /\b(?:i['’]ll|i will(?! not\b)|i['’]m going to|i am going to)\b|(?:할|볼|드릴|둘|놓을)\s?[게께]요?(?=[\s.!~]|$)/i;
// #2073's time or trigger: a take-back's "tomorrow" names no promise
const DEFERRED = /\b(?:later|tomorrow|tonight|today|overnight|noon|midnight|when|once|after|before|next|by|(?:mon|tues|wednes|thurs|fri|satur|sun)day|this (?:morning|afternoon|evening|week|weekend)|in (?:an?|\d+) (?:minutes?|hours?|days?|weeks?))\b|\b\d{1,2}(?::\d{2})?\s?[ap]\.?m\b|\bat \d{1,2}(?::\d{2})?\b|나중에|내일|오늘|이따|다음에|되면|끝나면|켜시면|하시면|후에|\d{1,2}시/i;
const FILLER = /^(?:(?:ok(?:ay)?|sure|got it|alright)[,!.]?\s+)?(?:let me|lemme|one (?:moment|sec(?:ond)?)|give me a (?:sec(?:ond)?|moment|minute)|hold on|just a (?:sec(?:ond)?|moment))\b|^(?:잠시만|잠깐만)/i;
// an offer waits on the user's yes; "check if it exists", "check if you have access" and "the feature you want" are still promises
const OFFER = /\b(?:if|unless) (?:you(?:['’]d| would)? (?:want|like|prefer)|needed|wanted|useful|helpful)\b|\b(?:want me to|would you like|shall i|maybe|perhaps)\b|원하시면|괜찮으시면/i;
const DENIED = /\b(?:not|never|no|cannot)\b|n['’]t\b|(?:^|\s)(?:안|못)\s/i;
const HEDGED = /\b(?:if|unless|maybe|perhaps|in case)\b/i;
// #2073's take-back: it opens its sentence, and one that names nothing is about the promise right before it
const WITHDRAWN = /^(?:(?:actually|oh|oops|sorry|wait|no)[,!.]?\s+)*(?:scratch that|never ?mind|cancel that)\b|취소할게요/i;
// "running as PID 4128": a note for the next reply to check, never a status
const RUNNING = /\b(?:running|in progress|under ?way|kicked off|pid \d+)\b|실행 중|진행 중/i;
const TIMES = new RegExp(DEFERRED.source, "gi");
const SENTENCE = /(?<=[.!?。！？])\s+|\n+/;
const CODE = /(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g;
const QUESTION = /[?？]$/;
// "I'll update the guide; I'll email the invoice": each promise its own line, so each gets its own ID
const CLAUSE = /(?:;|,? and)\s+(?=(?:i['’]ll|i will|i['’]m going to|i am going to)\b)/i;

const sentences = (text: string) => text.replace(CODE, "$1").split(SENTENCE)
  .map((part) => part.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
const said = (row: Message) => row.role === "bot" && row.kind === "text" && !row.roomEcho && Boolean(row.text?.trim());
const PLAIN = new Set(["a", "an", "the", "i", "me", "my", "myself", "you", "your", "yourself", "we", "us", "our", "it", "its", "this", "that", "these", "those", "there", "here", "them", "they", "their", "to", "of", "for", "on", "in", "at", "with", "from", "into", "about", "up", "out", "off", "as", "and", "or", "but", "so", "if", "then", "than", "until", "also", "just", "now", "still", "really", "actually", "sorry", "okay", "ok", "anyway", "instead", "though", "again", "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could", "going", "s", "t", "ll", "ve", "re", "d", "m", "그거", "그건", "이거"]);
// #2073's whole-word match of a take-back to the promise it names
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
const POINTED = new Set(["i", "me", "my", "myself", "you", "your", "yourself", "we", "us", "our", "them", "they", "their", "if", "until"]);
const bare = (text: string) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).every((word) => PLAIN.has(word.toLowerCase()) && !POINTED.has(word.toLowerCase()));
const own = (promise: string) => {
  const does = verb(promise);
  return new Set([...terms(promise.replace(COMMIT, " ")), ...(does ? forms(does) : [])]);
};

/** A take-back is about a promise only when it names that promise's whole object in its order, and its action, as whole words, and more of it than of each other promise. */
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

// an "I'll" in quotes is an example, not the bot's word
const spoken = (line: string) => line.replace(/"[^"]*"|“[^”]*”/g, (quoted) => " ".repeat(quoted.length));

/** The messages a turn answered, oldest first: every user row back from its first row to the last reply, one folded in while it set up too. */
export function answeredRows(first: Message | undefined, row: (id: string) => Message | undefined): Message[] {
  const opening: Message[] = [];
  for (let at = first?.parentId ? row(first.parentId) : undefined; at?.role === "user"; at = at.parentId ? row(at.parentId) : undefined) opening.unshift(at);
  return opening;
}

/** note: a later line of the turn saying that work is running; held: a question of the turn's newest message, which this engine answered, so it rides on only when another engine or model takes the next turn */
export interface Leftover { ask: string; promise?: true; note?: string; held?: true }

/** What a settled turn may have left open, to carry to the next reply unchecked: every "I'll" it kept, its last text's too, then each question of the user's the quick helper did not answer: one a newer message steered over or folded in files now, the newest message's is held. A false one costs one checked line, so no wording decides an ask was answered or done: no line closes, narrows or drops a filed ask. rows: the turn in order, from the messages it answered. */
export function turnLeftovers(rows: readonly Message[]): Leftover[] {
  const own = (row: Message) => said(row) && !row.quick;
  const lines = rows.flatMap((row) => !own(row) ? [] : sentences(row.text!).flatMap((line) => line.split(CLAUSE))
    .map((line) => ({ line, commit: COMMIT.test(spoken(line)) && !OFFER.test(line) && !FILLER.test(line) && !QUESTION.test(line) })));
  for (const [at, { line }] of lines.entries()) {
    if (!WITHDRAWN.test(line)) continue;
    const taken = line.replace(WITHDRAWN, " ");
    const promises = lines.slice(0, at).filter(({ commit }) => commit);
    const dropped = bare(taken) ? promises.slice(-1) : promises.filter((promise) => namesPromise(taken, promise.line, promises.filter((other) => other !== promise).map((other) => other.line)));
    for (const promise of dropped) promise.commit = false;
  }
  // no line after a promise decides it is done: a Read, "PC B is updated" or "updated" is for the next reply to check
  const left = lines.flatMap(({ line, commit }, at): Leftover[] => {
    if (!commit) return [];
    const about = promised(line);
    const note = lines.slice(at + 1).find((later) => RUNNING.test(later.line) && [...terms(later.line)].some((word) => about.has(word)))?.line;
    return [note ? { ask: line, promise: true, note } : { ask: line, promise: true }];
  });
  // the messages the turn answered, folded ones too, and the steers it took
  const lead = rows.findIndex((row) => row.role !== "user");
  const asked = rows.filter((row, at) => row.role === "user" && row.kind === "text" && Boolean(row.text?.trim()) && (!row.quick || row.quick.state === "handoff") && (lead < 0 || at < lead || row.steered));
  for (const row of asked) {
    // the quick helper answered it
    if (rows.some((other) => other.quick?.askId === row.id)) continue;
    const held = row === asked.at(-1);
    for (const ask of sentences(row.text!).filter((line) => QUESTION.test(line))) left.push(held ? { ask, held } : { ask });
  }
  return left;
}
