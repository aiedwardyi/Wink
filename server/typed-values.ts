import { secretLike, userTyping } from "./memory-pass.ts";
import type { Message } from "./store.ts";

export const TYPED_VALUES_HEADER =
  "[Values the user typed, copied by Wink from their own messages, oldest first. A later line replaces an earlier one about the same thing.]";

const SENTENCE_CHARS = 100;
const CHARS_BEFORE = 50;
const CHARS_AFTER = 30;
// A sentence found word for word in one of the bot messages just before is pasted bot text.
const PASTED_FROM_MESSAGES = 20;
const PASTED_MIN_CHARS = 24;

export interface TypedLine {
  /** where its message sits in the list given */
  index: number;
  line: string;
  /** a later line with the same key replaces this one */
  keys: string[];
}

interface Rule {
  kind: string;
  pattern: RegExp;
  normal?: (match: string) => string;
  accept?: (match: string) => boolean;
  /** takes its text so no later rule counts the digits, but makes no line alone */
  context?: true;
}

interface Value {
  kind: string;
  value: string;
  at: number;
  end: number;
}

const MACHINE_LINE = /^\s*(?:\*\*|[-*] \*\*|#{1,6} |\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[\d{2}:\d{2}|\d{2}:\d{2}:\d{2}\b|at \S+ \(|PS [A-Z]:\\|[A-Z]:\\[^ ]*>|\$ |\||[+-]{3} |@@ |\{"|\[\{|<\/?[a-z][\w-]*[ >]|npm (?:ERR|WARN)|error TS\d+|Traceback|File ")/;
const CODE_LINE = /^\s*(?:def \w+\(|class \w+[(:]|import \w|from [\w.]+ import |elif .+:\s*$|else:\s*$|for \w+ in .+:\s*$|while .+:\s*$|print\(|console\.\w+\(|(?:const|let|var|function) \w)/;
const LIST_MARK = /^\s*(?:[-*•]\s+|\d{1,3}[.)]\s+)/;
// No \b on the Korean half: it never fires between Hangul syllables.
// A bare "token" is a label only with an owner ("my token is") or a value holding a letter ("token: ab12"), not "max tokens: 4000".
const CREDENTIAL = /\b(?:passwords?|passcodes?|passwd|pins?|otp|2fa|mfa|one[\s-]time codes?|verification codes?|security codes?|cvv|ssn|social security|account numbers?|card numbers?|routing numbers?|private keys?|credentials?|api[\s_-]?(?:keys?|tokens?|secrets?)|(?:access|auth|bearer|refresh|oauth|client|secret|license)[\s_-]?(?:tokens?|keys?|secrets?))\b|\b(?:my|our|your|the|this)\s+(?:\w+\s+)?(?:secret|token)s?\s*(?:is\b|was\b|[:=])|\bsecrets?\s*[:=]|\btokens?\s*[:=]\s*(?=\S*[A-Za-z])|비밀\s*(?:번호|키)|비번|암호(?!화|학)|패스워드|인증\s*(?:번호|코드|키|토큰)|보안\s*코드|계좌\s*번호|카드\s*번호|주민\s*(?:등록\s*)?번호|핀\s*번호|(?:api|에이피아이)\s*(?:키|토큰)|(?:액세스|접근|시크릿)\s*(?:키|토큰)|시크릿|토큰\s*(?:값)?\s*(?:은|는|[:=])\s*(?=\S*[A-Za-z])/i;
const BARE_WORDS = /\btokens?\b|\bone[- ]time\b/gi;
// A label whose value is still to come, though the sentence holds another number ("My PIN for card 12 is").
const DANGLING = /(?:\b(?:is|was|are|were)|[:=]|[은는])\s*$/i;

/** This file's labels and every one the memory pass screens for, but a bare "token" or "one time" only by CREDENTIAL's narrower rules. */
const credential = (sentence: string) => CREDENTIAL.test(sentence) || secretLike(sentence.replace(BARE_WORDS, " "));

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const UNIT = "(?:%|percent|minutes?|hours?|days?|weeks?|months?|years?|seconds?|k|m|b|bn|ms|s|sec|secs|min|mins|h|hr|hrs|x|gb|mb|kb|tb|px|pt|fps|usd|krw|won|원|만원|억|달러|개|명|번|시간|분|초|일|주|개월|년|살|세)";

/** 3/4 reads as a date only when both halves can be a month and a day. */
function datelike(match: string): boolean {
  const parts = /^(\d{1,2})[/-](\d{1,2})$/.exec(match);
  if (!parts) return true;
  if (match === "24/7" || (parts[1]!.length === 1 && parts[2]!.length === 1)) return false;
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  return (first >= 1 && first <= 12 && second >= 1 && second <= 31) || (first >= 1 && first <= 31 && second >= 1 && second <= 12);
}

const lower = (match: string) => match.toLowerCase();
const amount = (match: string) => match.replace(/[\s,]/g, "").toLowerCase();

// Ordered: an earlier rule takes its text, so a later one never counts the same digits again.
const RULES: Rule[] = [
  { kind: "url", pattern: /https?:\/\/[^\s<>"')\]]+/g, normal: (match) => match.replace(/[.,;:!?]+$/, "") },
  { kind: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.-]*\w/g, normal: lower },
  {
    kind: "date",
    pattern: new RegExp(`\\b\\d{4}-\\d{1,2}-\\d{1,2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2})?)?\\b|\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b|\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTH}\\b|\\b\\d{1,2}[\\/-]\\d{1,2}(?:[\\/-]\\d{2,4})?\\b|\\d{1,2}월\\s?\\d{1,2}일`, "gi"),
    normal: lower,
    accept: datelike,
  },
  { kind: "time", pattern: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b|\b\d{1,2}\s?(?:am|pm)\b|(?:(?:오전|오후)\s?)?(?<!\d)\d{1,2}시(?!간)(?:\s?\d{1,2}분)?/gi, normal: (match) => match.toLowerCase().replace(/\s/g, "") },
  { kind: "version", pattern: /\bv?\d+\.\d+\.\d+(?:\.\d+)?\b/g, normal: (match) => match.replace(/^v/, "") },
  { kind: "ref", pattern: /#\d{2,}\b/g },
  { kind: "file", pattern: /\b[\w.-]+\.(?:tsx?|mjs|cjs|jsx?|json|md|ps1|py|css|html|ya?ml|csv|db|txt|png|jpe?g|svg|toml|sh|exe|pdf|docx?|xlsx?|log|zip|mp4|mov|mkv|webm|mp3|wav|gif|webp)\b/gi, context: true },
  { kind: "code", pattern: /\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)+\b/g },
  { kind: "ident", pattern: /\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/g, context: true },
  { kind: "money", pattern: /(?:[$₩€£]\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[$₩€£]\s?\d+(?:\.\d+)?)(?:\s?(?:k|m|b|bn|million|billion|thousand)\b)?/gi, normal: amount },
  { kind: "quantity", pattern: /\b\d+\s?[x×]\s?\d+\b/g, normal: amount },
  { kind: "quantity", pattern: new RegExp(`(?<![\\w.\\/\\\\:#@-])-?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?\\s?${UNIT}(?![A-Za-z])`, "gi"), normal: amount },
  { kind: "id", pattern: /\b(?=[A-Za-z0-9.-]*\d)(?=[A-Za-z0-9.-]*[A-Za-z])[A-Za-z]{1,12}[-.]?\d[A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*\b|\b[0-9a-f]{7,40}\b(?<=[a-f][0-9a-f]*)(?<=\d[0-9a-f]*)/g, normal: lower },
  // A colon after the digits is a label ("Note 12:"), not a value. A minus is a sign only after no word, so "10-20" stays unsigned.
  { kind: "number", pattern: /(?<![\w./\\:#@-])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w/\\:-]|\.\d)/g, normal: (match) => match.replace(/,/g, "") },
];

const SHORT_KINDS = new Set(["number", "quantity", "money", "time", "date"]);
const FILLER = new Set("is are was were be to of in on at by for the an and or but so if it its we you me my our this that with from as do did does has have had not no yes ok okay lol btw pls please just like".split(" "));

const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const pad = (value: number) => String(value).padStart(2, "0");

/** A credential label with no value of its own ("My PIN:") takes the next sentence with it, even across lines. */
function sentences(text: string): string[] {
  const kept: string[] = [];
  let held = false;
  for (const line of text.split(/\n+/)) {
    const noise = MACHINE_LINE.test(line) || CODE_LINE.test(line);
    for (const sentence of line.replace(LIST_MARK, "").split(/(?<=[.!?。])\s+/).map((part) => part.trim()).filter(Boolean)) {
      if (!held && !noise) kept.push(sentence);
      held = credential(sentence) && ((!valuesIn(sentence).length && !/«redacted \d+ chars»/.test(sentence)) || DANGLING.test(sentence));
    }
  }
  return kept;
}

function valuesIn(sentence: string): Value[] {
  const found: Value[] = [];
  let rest = sentence;
  for (const { kind, pattern, normal, accept, context } of RULES) {
    rest = rest.replace(pattern, (match: string, at: number) => {
      if (accept && !accept(match)) return match;
      if (!context) found.push({ kind, value: normal ? normal(match) : match, at, end: at + match.length });
      return " ".repeat(match.length);
    });
  }
  return found
    .filter((value) => value.kind !== "number" || value.value.replace(/\D/g, "").length >= 2)
    .sort((a, b) => a.at - b.at);
}

/** A short number is told apart by the word next to it, a long one by the word it follows: the same digits about another thing are another fact. */
function keysOf(sentence: string, values: Value[]): Map<Value, string> {
  let words = sentence;
  for (const value of values) words = `${words.slice(0, value.at)}${" ".repeat(value.end - value.at)}${words.slice(value.end)}`;
  return new Map(values.map((value) => {
    const key = `${value.kind === "money" || value.kind === "quantity" ? "amount" : value.kind}:${value.value}`;
    if (!SHORT_KINDS.has(value.kind)) return [value, key];
    const next = /^\s*([A-Za-zㄱ-힝]{2,})/.exec(words.slice(value.end))?.[1]?.toLowerCase();
    if (value.value.replace(/\D/g, "").length >= 4) {
      const subject = words.slice(0, value.at).toLowerCase().match(/[a-zㄱ-힝]{2,}/g)?.filter((word) => !FILLER.has(word)).at(-1);
      return [value, `${key}|${subject ?? (next && !FILLER.has(next) ? next : "")}`];
    }
    const previous = /([A-Za-zㄱ-힝]{2,})[\s:=#(-]*$/.exec(words.slice(0, value.at))?.[1]?.toLowerCase();
    const near = next && !FILLER.has(next) ? next : previous && !FILLER.has(previous) ? previous : next ?? previous ?? "";
    return [value, `${key}|${near}`];
  }));
}

/** The whole sentence, or the part around each run of values when it is long. */
function clips(sentence: string, values: Value[]): Array<{ text: string; values: Value[] }> {
  if (sentence.length <= SENTENCE_CHARS) return [{ text: sentence, values }];
  const runs: Value[][] = [];
  for (const value of values) {
    const run = runs.at(-1);
    if (run && value.at - run.at(-1)!.end <= CHARS_BEFORE + CHARS_AFTER) run.push(value);
    else runs.push([value]);
  }
  return runs.map((run) => {
    const first = run[0]!;
    const last = run.at(-1)!;
    let from = Math.max(0, first.at - CHARS_BEFORE);
    let to = Math.min(sentence.length, last.end + CHARS_AFTER);
    if (from > 0) {
      const space = sentence.indexOf(" ", from);
      if (space >= 0 && space < first.at) from = space + 1;
    }
    if (to < sentence.length) {
      const space = sentence.lastIndexOf(" ", to);
      if (space > last.end) to = space;
    }
    return { text: `${from > 0 ? "…" : ""}${sentence.slice(from, to).trim()}${to < sentence.length ? "…" : ""}`, values: run };
  });
}

/** One line per sentence the user typed that holds a number, id, amount, date, time, address or version, oldest first. */
export function typedValueLines(messages: readonly Message[], excludeIds: ReadonlySet<string> = new Set()): TypedLine[] {
  const lines: TypedLine[] = [];
  const botTexts: string[] = [];
  let recent: string[] | undefined;
  messages.forEach((message, index) => {
    if (message.kind !== "text" || !message.text || excludeIds.has(message.id)) return;
    if (message.role === "bot") {
      botTexts.push(message.text);
      recent = undefined;
      return;
    }
    if (message.from || message.comm || message.origin || message.quick) return;
    const date = new Date(message.at);
    const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    for (const sentence of sentences(userTyping(message.text, false))) {
      const values = valuesIn(sentence);
      if (!values.length || credential(sentence)) continue;
      if (sentence.length >= PASTED_MIN_CHARS) {
        recent ??= botTexts.slice(-PASTED_FROM_MESSAGES).map(flat);
        const said = flat(sentence);
        if (recent.some((text) => text.includes(said))) continue;
      }
      const keys = keysOf(sentence, values);
      for (const clip of clips(sentence, values)) {
        lines.push({ index, line: `- ${day} ${clip.text.replace(/\s+/g, " ")}`, keys: [...new Set(clip.values.map((value) => keys.get(value)!))] });
      }
    }
  });
  return lines;
}

/** The block within maxBytes: a value stays with its newest line and the oldest lines fall off first. Same lines, same bytes. */
export function typedValuesBlock(lines: readonly TypedLine[], maxBytes: number): string {
  interface Kept {
    line: string;
    keys: Set<string>;
    bytes: number;
  }
  const kept = new Set<Kept>();
  const owner = new Map<string, Kept>();
  let used = bytes(TYPED_VALUES_HEADER);
  let leftOut = 0;
  const note = () => `[${leftOut} older lines left out]`;
  const size = () => used + (leftOut ? bytes(note()) + 1 : 0);
  const remove = (entry: Kept) => {
    kept.delete(entry);
    for (const key of entry.keys) if (owner.get(key) === entry) owner.delete(key);
    used -= entry.bytes;
  };
  for (const { line, keys } of lines) {
    const entry: Kept = { line, keys: new Set(keys), bytes: bytes(line) + 1 };
    for (const key of entry.keys) {
      const earlier = owner.get(key);
      owner.set(key, entry);
      if (!earlier || !kept.has(earlier)) continue;
      earlier.keys.delete(key);
      if (!earlier.keys.size) remove(earlier);
    }
    kept.add(entry);
    used += entry.bytes;
    // The first removal adds the left-out note, so size() can grow before it shrinks.
    while (size() > maxBytes && kept.size > 1) {
      remove(kept.values().next().value!);
      leftOut += 1;
    }
  }
  if (!kept.size || size() > maxBytes) return "";
  return [TYPED_VALUES_HEADER, ...(leftOut ? [note()] : []), ...[...kept].map((entry) => entry.line)].join("\n");
}

/** A summary's own text: the values block is rebuilt at every write, never read back. */
export function withoutTypedValues(summary: string): string {
  const at = summary.lastIndexOf(`\n${TYPED_VALUES_HEADER}\n`);
  return at < 0 ? summary : summary.slice(0, at).trimEnd();
}
