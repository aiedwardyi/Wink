// Import Memory leaves out a line only when it gives a secret's value, so a secret word in prose stays a fact.
import { redactSecretsInText } from "../shared/redact.ts";
import { tokenLike } from "./memory-pass.ts";

const EDGE = "(?<![\\p{L}\\p{N}])";
// a Korean label may carry its particle: 와이파이는, 비번은
const END = "(?=[은는이가을를]?(?![\\p{L}\\p{N}]))";
const STRONG = "passwords?|passwd|passcodes?|passphrases?|pwd?|pins?|비밀\\s*번호|비번|암호(?!화|학)|패스워드|패스코드|핀(?:\\s*(?:번호|코드))?";
const WEAK = "wi-?fi|wlan|(?:api|access|secret|private|recovery|license|product)[ _-]?keys?|tokens?|secrets?|credentials?|otp|2fa|mfa|one[- ]time (?:codes?|passwords?)" +
  "|(?:door|gate|alarm|garage|lockbox|entry|access|recovery|backup|security|verification|pin)[ -]?codes?|(?:card|account|routing|social security)[ -]?numbers?|cvv|ssn" +
  "|와이파이|도어락|공동현관|현관|대문|토큰|시크릿|(?:api|에이피아이|개인)\\s*키|계좌\\s*번호|카드\\s*번호|주민\\s*(?:등록\\s*)?번호|(?:인증|보안|일회용)\\s*(?:번호|코드)";
const LABEL = new RegExp(`${EDGE}(?:(${STRONG})|${WEAK})${END}`, "giu");
// heading words that open a list of secrets; the list's values still have to look like one
const HEADING = new RegExp(`${EDGE}(?:${STRONG}|${WEAK}|codes|keys|logins|코드)${END}`, "iu");
// words between a label and its value: "WiFi pw", "PIN-number", "현관 비밀번호는"
const BRIDGE = new RegExp(`^(?:\\s+|[-–—]|\\([^)]{0,30}\\)|[:：=]|(?:is|are|was)(?![\\p{L}\\p{N}])|[은는이가](?![\\p{L}\\p{N}])|(?:${STRONG}|keys?|codes?|numbers?|no\\.?|#|login|비밀번호|번호|코드|키)${END})`, "iu");
const SAID = /^(?:[:：=]|is|are|was|[은는이가])$/iu;
const COPULA = /(?:\s*(?:이에요|예요|이야|입니다|이다|임|요))?[.!。]*$/u;
const NOT_VALUE = /^(?:\S+@\S+\.\S+|https?:\/\/\S+|\d+(?:\.\d+)?(?:ghz|mhz|[kmg]bps|[kmgt]b|k|km|kg|cm|mm)|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i;

// one value token, or a card or account number written in groups
const valueOf = (rest: string) => {
  const value = rest.replace(COPULA, "").trim();
  return /^\d[\d -]*\d$/.test(value) ? [value.replace(/[ -]/g, "")] : value.split(/\s*\/\s*/);
};
const valueLike = (token: string) => !NOT_VALUE.test(token) && (/^\d{3,}$/.test(token) || (token.length >= 4 && /[\p{N}!@#$%^&*_+=~?]/u.test(token)));
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
    const tokens = valueOf(rest);
    if (!tokens.every(single)) continue;
    // "Netflix password: bluemoon" needs no digit; a bare "PIN cushion" does
    if (tokens.some(valueLike) || (match[1] && said && tokens.length === 1 && tokens[0].length >= 4)) return true;
  }
  return false;
}

// a value line under a secret heading: "qwer2017", "Mail: lilac4006"
function listedValue(line: string): boolean {
  const pair = /^([^:：=]{1,40}?)(?:\s*[:：=]\s*|\s+[-–—]\s+)(.+)$/u.exec(line);
  const tokens = valueOf(pair && pair[1].split(/\s+/).length <= 4 ? pair[2] : line);
  return tokens.every(single) && tokens.some(valueLike);
}

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
  return (raw, line) => {
    const head = structure(raw, line);
    if (head) {
      if (HEADING.test(head.text)) {
        if (!section || head.depth <= section) section = head.depth;
      } else if (head.depth <= section) section = 0;
      return head.depth === 7 && section === 7 ? "label" : undefined;
    }
    if (!line) return undefined;
    const row = line.replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, ": ");
    if (redactSecretsInText(row) !== row || tokenLike(row) || labeledValue(row) || (section && listedValue(row))) return "secret";
    return undefined;
  };
}
