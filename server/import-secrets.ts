// Import Memory leaves out every line the check before this filter left out, unless each secret word in it means something
// else here ("PIN-up", "Secret Santa", "password manager", a flight number) and no word in it has a value's shape.
// Past that check it also leaves out a value only this filter reads: a WiFi key, a door code, a value under a secret heading.
import { redactRoomMemory } from "../shared/redact.ts";
import { secretLike } from "./memory-pass.ts";

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
// marks at the end match only from the start of their run, so a long run is read once, not once per mark
const COPULA = /(?:\s*(?:이에요|예요|이야|입니다|이다|임|요)|(?<![.!。]))[.!。]*$/u;
// a value then a break, so text after it does not hide it: "lilac27 (personal account)", "tulip742! and I change it"
// a value longer than one mark ends on another character, so each run of marks is read once
const LEAD = /^(\d[\d -]*\d(?![\p{L}\p{N}])|[.,;!。]|\S*?[^\s.,;!。])[.,;!。]*(?=\s*$|\s*[(,;]|\s+(?:and|but|so|or|which|because|since|until|[-–—])(?:\s|$))/iu;
// an email splits at its first @ and is checked for spaces once, so a run of @ is not read once per @
const NOT_VALUE = /^(?:(?:~|\.{1,2})?\/\S+|\S[^\s@]*@(?=\S*$)\S+\.\S+|https?:\/\/\S+|\d+(?:\.\d+)?(?:ghz|mhz|[kmg]bps|[kmgt]b|k|km|kg|cm|mm)|\d+(?:\.\d+)+[a-z]*|\S*[a-z0-9](?:password|passcode)\S*|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i;

// one value token, or a card or account number written in groups
const valueOf = (rest: string) => {
  const value = rest.replace(COPULA, "").trim();
  return /^\d[\d -]*\d$/.test(value) ? [value.replace(/[ -]/g, "")] : NOT_VALUE.test(value) ? [value] : value.split(/\s*\/\s*/);
};
// a Korean particle after a value is not part of it: 8107이에요, lilac8105를
const bare = (token: string) => token.replace(/^["'“‘(]+/, "").replace(/(?:이에요|예요|이야|입니다|이고|으로|로|을|를|은|는|이|가|도|(?<!["'”’).,;!?。]))["'”’).,;!?。]*$/u, "");
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

// a network's name is not its key: "WiFi name: BlueHeron5G", "Wi-Fi network name is MapleHouse2024", "와이파이 이름"
const NAME_AFTER = /^\s*(?:network\s+)?(?:name|ssid)\b|^\s*(?:네트워크\s*)?이름/iu;
// a label's value is read in the next 256 characters, so a line of many labels is read once, not once per label
const REACH = 256;

function labeledValue(line: string): boolean {
  for (const match of line.matchAll(LABEL)) {
    const end = match.index + match[0].length;
    const near = line.slice(end, end + REACH);
    if (match[2] && NAME_AFTER.test(near)) continue;
    let rest = near;
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
    const clause = near.split(/[.!?。](?:\s|$)/u)[0];
    const after = (match[1] ? SAID_PAST : SAYS).exec(clause)?.[1];
    if (after?.trim().split(/\s+/).slice(0, 2).flatMap(valueOf).some(isValue)) return true;
  }
  return false;
}

// a value line under a secret heading: "qwer2017", "Mail: lilac4006"
// under a heading like "Tokens" or "API keys" only a bare value counts, so "Max output: 8192" under "Token budgets" stays a fact
// under a WiFi heading an item named for what the network is, not where, stays a fact: "Network name: BlueHeron5G", "이름: olleh5G2f3a"
const NAMED = /^(?:(?:wi-?fi|wlan|와이파이)\s*)?(?:(?:network\s+)?name|network|ssid|router|modem|model|plan|provider|isp|mac(?:\s+address)?|band|channel|speed|이름|네트워크|통신사|공유기|모뎀|모델|요금제|속도)$/iu;
function listedValue(line: string, kind: Kind, word = ""): boolean {
  const pair = /^([^:：=]{1,40}?)(?:\s*[:：=]\s*|\s+[-–—]\s+)(.+)$/u.exec(line);
  const named = Boolean(pair && pair[1].split(/\s+/).length <= 4);
  if (named && kind === "wifi" && NAMED.test(pair![1].trim())) return false;
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

// a table column named only by secret words holds secrets; "WiFi name" or "Password last changed" names something else
const columnKind = (cell: string) => (cell.replace(LABEL, "").replace(/[\s/&+,()-]+/g, "") ? undefined : headingKind(cell));

// the check this import ran before this filter
const flagged = (line: string) => secretLike(line) || redactRoomMemory(line) !== line;
// other senses of a secret word; each swaps out only that word, so the rest of the line is still read
const OTHER = [
  // a poster style, a suit stripe, a pin cushion, a card reader; pins as things; pin as a verb
  /\bpins?(?=[- ]?(?:ups?|strip\w*|cushions?|pads?)\b)/giu,
  /(?<=\b(?:bowling|enamel|lapel|hat|safety|bobby|push|hair|rolling|sewing|map)[ -])pins?\b/giu,
  /\bpins?(?= bowling\b)/giu,
  /\b[Pp]ins?(?= (?:my|the|it|this|that|them|these|those|a|an|your|our|their|his|her)\b)/gu,
  /\b[Pp]ins?\b(?=(?: \S+){0,3} (?:on|to|from) Pinterest\b)/gu,
  // a name: "a dog named Pin"
  /(?<=\b(?:named|called) )(?:Pin|Token)\b/gu,
  // LLM, crypto and arcade tokens, token-based auth, a token of thanks
  /\btokens?(?=[- ](?:based|budgets?|limits?|counts?|usage|economy|of (?:thanks|appreciation|gratitude))\b)/giu,
  /(?<=\b(?:ETH|NFT|crypto|governance|utility|arcade|subway|bus) )tokens?\b/giu,
  /토큰(?=\s*(?:기반|이코노미))/gu,
  // Secret Santa, a secret talent, the secret to good coffee, a title such as The Secret Garden
  /\bsecrets?(?= (?:santa|talents?|ingredients?|recipes?|menu|level|room|door|garden|weapon|sauce|admirer|agent|service|society|hobby|passion|skill|crush|life|identity|spot|trick|tips?|history|to (?:a|an|the|good|great|my|your|our|their|his|her|success|happiness))\b)/giu,
  /(?<=\bThe )Secret(?= (?!(?:Key|Code|Word|Phrase|Password|Token|PIN|Pin|Number|Question|Answer)\b)\p{Lu})/gu,
  // a password manager, password hashing or hygiene; 1Password is a manager's name
  /\bpasswords?(?= (?:managers?|management|hashing|hygiene|policy|policies)\b)/giu,
  /(?:비밀\s*번호|패스워드)(?=\s*(?:관리자|관리\s*앱|매니저))/gu,
  /\b1Password\b/gu,
  // a flight number right after a flight word: "Flight KE7524 to Busan", "Boarding pass: KE7523"
  /(?<=\b(?:[Ff]lights?|[Ff]lying|[Ff]lew|[Bb]oarding [Pp]ass)(?: (?:number|no\.?))?[\s:#]{1,3})(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\d{1,4}(?![\p{L}\p{N}_])/gu,
];
const otherSense = (line: string) => OTHER.reduce((text, pattern) => text.replace(pattern, "thing"), line);
// a word with a value's shape, a year included; a decade is not one
const valued = (line: string) => line.split(/[\s\p{Script=Hangul}]+/u).some((word) => valueLike(word) && !/^'?\d{2}(?:\d{2})?s$/.test(bare(word)));
// a line the check before this filter flags stays out, unless its secret words all mean something else and no word looks like a value;
// a word that names a field keeps its own sense: "1Password: sunflower", "Password manager: opensesame"
function stillHidden(line: string, flag = flagged(line)): boolean {
  if (!flag) return false;
  const text = otherSense(line);
  const field = /^([^:：=]*)[:：=](.*)$/u.exec(text);
  const named = Boolean(field && /\bthing\b/.test(field[1]) && /\S/.test(field[2].replace(/\bthing\b/g, "")));
  return text === line || named || flagged(text) || valued(text);
}
// the line after a lone value names it: "plum8504x" then "That's my Netflix password.", "이게 와이파이 비밀번호예요"
const NAMES_IT = /^\s*(?:[-*+]\s+)?(?:(?:(?:that|it)(?:'s|’s| is| was)|this is)\s+(?:my|the|our|your|his|her|their|a)|이게|이거|이건|그게|그거|그건)\s/iu;

/** Reads a paste line by line: "secret" for a line that gives a secret's value, "label" for a secret section's own heading line. */
export function importSecrets(): (raw: string, line: string, next?: string) => "secret" | "label" | undefined {
  let section = 0;
  let kind: Kind = "weak";
  let word = "";
  // a table's header row names the columns that hold secrets: "| Service | Password |"
  let columns: (Kind | undefined)[] | undefined;
  return (raw, line, next = "") => {
    const flag = flagged(line);
    const text = flag ? otherSense(line) : line;
    const cells = /^\s*\|.*\|\s*$/.test(raw) ? text.replace(/^\|\s*|\s*\|$/g, "").split(/\s*\|\s*/) : undefined;
    const header = Boolean(cells) && !columns;
    columns = cells ? (columns ?? cells.map(columnKind)) : undefined;
    const row = cells ? cells.join(": ") : text;
    const inColumn = !header && Boolean(cells?.some((cell, at) => { const column = columns?.[at]; return Boolean(column && VALUE_FOR[column](cell)); }));
    const given = stillHidden(line, flag) || labeledValue(row) || inColumn;
    const head = structure(raw, line);
    if (head) {
      // a bold value under a secret heading is that value, not a new heading: "## Passwords" then "**lilac4023**"
      if (section && head.depth === 7 && listedValue(head.text, kind, word)) return "secret";
      // any other heading ends the list, so "#### Hashing in use" under "### Passwords" is prose again
      const found = headingKind(otherSense(head.text));
      if (!found) section = 0;
      else if (!section || head.depth <= section) [section, kind, word] = [head.depth, found, bareWord(head.text)];
      return given ? "secret" : head.depth === 7 && section === 7 ? "label" : undefined;
    }
    if (given || (row && !header && section && listedValue(row, kind, word))) return "secret";
    if (single(line) && NAMES_IT.test(next) && next.trim().split(/\s+/).length <= 6 && stillHidden(next.trim())) return "secret";
    return undefined;
  };
}
