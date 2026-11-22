// Import Memory leaves out a line only when it gives a secret's value, so a secret word in prose stays a fact.
import { redactRoomMemory } from "../shared/redact.ts";
import { secretLike, tokenLike } from "./memory-pass.ts";

const EDGE = "(?<![\\p{L}\\p{N}])";
// a Korean label may carry its particle: 와이파이는, 비번은
// a hyphen joins a new word: PIN-up, token-based
const END = "(?=(?:으로|[은는이가을를로도]|이에요|예요|입니다|이다|이야|야)?(?![\\p{L}\\p{N}]|-\\p{L}))";
const STRONG = "passwords?|passwd|passcodes?|passphrases?|pwd?|pin-(?:numbers?|no)|pins?|비밀\\s*번호|비번|암호(?!화|학)|패스워드|패스코드|핀(?:\\s*(?:번호|코드))?";
const WIFI = "wi-?fi|wlan|와이파이";
// keypad codes, given as digits
const DOOR = "(?:door|gate|alarm|garage|lockbox|entry)[ -]?codes?|도어락|공동현관|현관|대문";
const WEAK = "(?:api|access|secret|private|recovery|license|product)[ _-]?keys?|tokens?|secrets?|credentials?|otp|2fa|mfa|one[- ]time (?:codes?|passwords?)" +
  "|(?:access|recovery|backup|security|verification|pin)[ -]?codes?|(?:card|account|routing|social security)[ -]?numbers?|cvv|ssn" +
  "|토큰|시크릿|(?:api|에이피아이|개인)\\s*키|계좌\\s*번호|카드\\s*번호|주민\\s*(?:등록\\s*)?번호|(?:인증|보안|일회용)\\s*(?:번호|코드)";
const LABEL = new RegExp(`${EDGE}(?:(${STRONG})|(${WIFI})|(${DOOR})|${WEAK})${END}`, "giu");
// a heading that is only one of these words lends it to each item: "## Codes" + "Front door: 4821" reads "Front door code: 4821"
const BARE = /^\s*(?:(code|login)s|(코드))\s*[:：]?\s*$/iu;
// words between a label and its value: "WiFi pw", "PIN-number", "현관 비밀번호는"
const BRIDGE = new RegExp(`^(?:\\s+|[-–—]|\\([^)]{0,30}\\)|[:：=]|(?:is|are|was)(?![\\p{L}\\p{N}])|[은는이가](?![\\p{L}\\p{N}])|(?:${STRONG}|keys?|codes?|numbers?|no\\.?|#|login|비밀번호|번호|코드|키)${END})`, "iu");
const SAID = /^(?:[:：=]|is|are|was|[은는이가])$/iu;
// other labels reach a value past plain words only as "for X is", "at X:"; a password or PIN past any words to "is", ":" or 는
const LINK = String.raw`(?:[:：=→]|->|(?<![\p{L}\p{N}])(?:is|are|was)(?![\p{L}\p{N}])|[은는](?=\s))`;
const SAYS = new RegExp(String.raw`^\s+(?:for|to|at|on|of|in|that)\s.*?${LINK}(.*)$`, "u");
const SAID_PAST = new RegExp(String.raw`^.*?${LINK}(.*)$`, "u");
const COPULA = /(?:\s*(?:이에요|예요|이야|입니다|이다|임|요))?[.!。]*$/u;
// a value then a break, so text after it does not hide it: "lilac27 (personal account)", "tulip742! and I change it"
const LEAD = /^(\d[\d -]*\d(?![\p{L}\p{N}])|\S+?)[.,;!。]*(?=\s*$|\s*[(,;]|\s+(?:and|but|so|or|which|because|since|until|[-–—])(?:\s|$))/iu;
// a room invite code is six characters; a flight number of that length is not one
const FLIGHT = /(?<![\p{L}\p{N}_#])(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\d{4}(?![\p{L}\p{N}_])/gu;
const NOT_VALUE = /^(?:(?:~|\.{1,2})?\/\S+|\S+@\S+\.\S+|https?:\/\/\S+|\d+(?:\.\d+)?(?:ghz|mhz|[kmg]bps|[kmgt]b|k|km|kg|cm|mm)|\d+(?:\.\d+)+[a-z]*|\S*[a-z0-9](?:password|passcode)\S*|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i;

// one value token, or a card or account number written in groups
const valueOf = (rest: string) => {
  const value = rest.replace(COPULA, "").trim();
  return /^\d[\d -]*\d$/.test(value) ? [value.replace(/[ -]/g, "")] : NOT_VALUE.test(value) ? [value] : value.split(/\s*\/\s*/);
};
// a Korean particle after a value is not part of it: 8107이에요, lilac8105를
const bare = (token: string) => token.replace(/^["'“‘(]+/, "").replace(/(?:이에요|예요|이야|입니다|이고|으로|로|을|를|은|는|이|가|도)?["'”’).,;!?。]*$/u, "");
// a typed value is ASCII
const valueLike = (raw: string) => {
  const token = bare(raw);
  return !/\p{Script=Hangul}/u.test(token) && !NOT_VALUE.test(token) && (/^\d{3,}$/.test(token) || (token.length >= 4 && /[\p{N}!@#$%^&*_+=~?]/u.test(token)));
};
type Kind = "strong" | "wifi" | "door" | "weak";
// a WiFi key is 8+ characters with a small letter or symbol, so RT-AX88U and 802.11ax stay facts; a keypad code is digits, so 1203호 does
const VALUE_FOR = {
  strong: valueLike,
  weak: valueLike,
  // a network name joins its words with - or _: BlueHeron-5G, iptime_5G
  wifi: (token) => valueLike(token) && token.length >= 8 && /[a-z!@#$%^&*_+=~?]/.test(token) && !/[\p{L}\p{N}][-_][\p{L}\p{N}]/u.test(bare(token)),
  door: (token) => /^[#*]?\d{3,}[#*]?$/.test(bare(token)),
} satisfies Record<Kind, (token: string) => boolean>;
const kindOf = (match: RegExpMatchArray): Kind => (match[1] ? "strong" : match[2] ? "wifi" : match[3] ? "door" : "weak");
const single = (token: string) => Boolean(token) && !/\s/.test(token);

function labeledValue(line: string): boolean {
  for (const match of line.matchAll(LABEL)) {
    let rest = line.slice(match.index + match[0].length);
    let said = false;
    for (let step = 0; step < 8; step++) {
      const bridge = BRIDGE.exec(rest)?.[0];
      if (!bridge) break;
      said ||= SAID.test(bridge.trim()) || /[-–—]/.test(bridge);
      rest = rest.slice(bridge.length);
    }
    const lead = LEAD.exec(rest.replace(COPULA, ""))?.[1].replace(/^(\d[\d -]*\d)$/, (digits) => digits.replace(/[ -]/g, ""));
    const tokens = valueOf(rest).every(single) ? valueOf(rest) : lead ? [lead] : [];
    const isValue = VALUE_FOR[kindOf(match)];
    // "Netflix password: bluemoon" needs no digit; a bare "PIN cushion" does
    if (tokens.some(isValue) || (match[1] && said && tokens.length === 1 && tokens[0].length >= 4 && !NOT_VALUE.test(tokens[0]))) return true;
    // plain words before the value: "The door code for the gym is 8010", "pw for Hulu is x"; "Gate code for the pool: posted on the 2026 board" gives none
    const clause = line.slice(match.index + match[0].length).split(/[.!?。](?:\s|$)/u)[0];
    const after = (match[1] ? SAID_PAST : SAYS).exec(clause)?.[1];
    if (after?.trim().split(/\s+/).slice(0, 2).flatMap(valueOf).some(isValue)) return true;
  }
  return false;
}

// base left out every line with one of its secret words, so such a line goes when it gives a value anywhere in it:
// "Use hunter2morrow as the password", "My bank PIN. It's 8210.", "API key is sk-x for staging"
const MARK = new RegExp(`${LINK}|^[은는이가]`, "gu");
function wordedValue(line: string): boolean {
  return [...line.matchAll(LABEL)].some((match) => {
    if (!secretLike(match[0])) return false;
    const rest = line.slice(match.index + match[0].length);
    if (rest.split(/\s+/).flatMap(valueOf).some(valueLike)) return true;
    // before the label a value is linked to it: "Use x as the password", "x is my Netflix password", "x가 비밀번호예요"
    const before = line.slice(0, match.index).split(/\s+/);
    if (before.some((word, at) => valueLike(word) && (/\p{Script=Hangul}$/u.test(word) || /^(?:is|are|was|as)$/i.test(before[at + 1] ?? "")))) return true;
    // a password needs no digit when it ends its clause: "Password for Netflix: sunflowerlake", "is currently sunflowermoon"
    if (!match[1]) return false;
    const clause = rest.split(/[.!?。](?:\s|$)/u)[0];
    const mark = [...clause.matchAll(MARK)].at(-1);
    const words = mark ? clause.slice(mark.index + mark[0].length).trim().split(/\s+/) : [];
    const token = bare(words.at(-1) ?? "");
    return words.length <= 2 && /^[\x21-\x7e]{4,}$/.test(token) && /[a-z]/i.test(token) && !NOT_VALUE.test(token);
  });
}

// a value line under a secret heading: "qwer2017", "Mail: lilac4006"
// under a heading like "Tokens" or "API keys" only a bare value counts, so "Max output: 8192" under "Token budgets" stays a fact
function listedValue(line: string, kind: Kind, word = ""): boolean {
  const pair = /^([^:：=]{1,40}?)(?:\s*[:：=]\s*|\s+[-–—]\s+)(.+)$/u.exec(line);
  const named = Boolean(pair && pair[1].split(/\s+/).length <= 4);
  if (named && word) return labeledValue(`${pair![1]} ${word}: ${pair![2]}`);
  if (named && kind === "weak") return false;
  const tokens = valueOf(named ? pair![2] : line);
  return tokens.every(single) && tokens.some(VALUE_FOR[kind]);
}

function headingKind(text: string): Kind | undefined {
  const kinds = [...text.matchAll(LABEL)].map(kindOf);
  return BARE.test(text) ? "strong" : (["strong", "wifi", "door", "weak"] as const).find((kind) => kinds.includes(kind));
}
const bareWord = (text: string) => BARE.exec(text)?.slice(1).find(Boolean) ?? "";

// heading 1-6, bold line 7, "Label:" line 8; a line opens or closes the section at its own depth or above
function structure(raw: string, line: string): { depth: number; text: string } | undefined {
  const heading = /^\s*(#{1,6})\s+(.*)$/.exec(raw);
  if (heading) return { depth: heading[1].length, text: heading[2] };
  const bold = /^\s*(?:[-*+]\s+)?\*\*([^*]+)\*\*\s*[:：]?\s*$/.exec(raw);
  if (bold) return { depth: 7, text: bold[1] };
  if (/[:：]$/.test(line)) return { depth: 8, text: line };
  return undefined;
}

/** Reads a paste line by line: "secret" for a line that gives a secret's value, "label" for a secret section's own heading line. */
export function importSecrets(): (raw: string, line: string) => "secret" | "label" | undefined {
  let section = 0;
  let kind: Kind = "weak";
  let word = "";
  // a table's header row decides whether its rows list secrets: "| Service | Password |"
  let table: Kind | "" | undefined;
  return (raw, line) => {
    const row = line.replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, ": ");
    const header = /^\s*\|.*\|\s*$/.test(raw) && table === undefined;
    table = /^\s*\|.*\|\s*$/.test(raw) ? (table ?? headingKind(row) ?? "") : undefined;
    const plain = row.replace(FLIGHT, "");
    const given = Boolean(row) && (redactRoomMemory(plain) !== plain || tokenLike(row) || labeledValue(row) || wordedValue(row));
    const head = structure(raw, line);
    if (head) {
      // any other heading ends the list, so "#### Hashing in use" under "### Passwords" is prose again
      const found = headingKind(head.text);
      if (!found) section = 0;
      else if (!section || head.depth <= section) [section, kind, word] = [head.depth, found, bareWord(head.text)];
      return given ? "secret" : head.depth === 7 && section === 7 ? "label" : undefined;
    }
    if (given || (row && !header && ((section && listedValue(row, kind, word)) || (table && listedValue(row, table))))) return "secret";
    return undefined;
  };
}
