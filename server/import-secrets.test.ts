import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { redactRoomMemory } from "../shared/redact.ts";
import { factsOf } from "./about-you.ts";
import { secretLike } from "./memory-pass.ts";
import { ALLOWED } from "./testing/import-secret-allowed.ts";
import { CORPUS } from "./testing/import-secret-corpus.ts";

// the check each line got before this filter; a fact here is its whole line, as no corpus line is longer than a fact
const hidBefore = (fact: string) => secretLike(fact) || redactRoomMemory(fact) !== fact;
// the import before this filter left each out too: a secret word in its own sense ("rotate my passwords"), a value's shape
// beside another sense ("a 2015 Rioja"), "is" + one word; or each reads like a WiFi key, a door code or a login ("WiFi: U+Net1A2B", "dana77")
const LOST = ["Prefers passkeys over passwords.", "Rotates passwords every 90 days.", "Forgot the Netflix password last week and reset it.", "Works on API keys and auth at a fintech startup.", "Their secret talent is juggling.", "Booked UA2345 to SFO.", "Password: changed monthly (work policy).", "Security: wants 2FA on everything.", "Asked how to make a strong password.", "비밀번호를 자주 잊어버려요.", "공동현관 비밀번호는 매달 바뀌어요.", "와이파이 비밀번호를 자주 바꿔요.", "카드 번호는 외우지 못해요.", "Uses argon2id for password hashing.", "Turns on 2FA everywhere.", "Tokens: 1500000", "My password is long and random.", "PIN is required at checkout.", "Password: none", "Card number ends in 4821.", "Account number is on the statement.", "Uses 2FA: Authy", "비밀번호는 복잡하게 만들어요.", "토큰: 8192", "Verification code: by SMS", "I use Bitwarden for passwords at work", "Prefers passkeys over passwords", "Changes passwords every 90 days", "Credentials: PMP certified, AWS Solutions Architect", "Uses argon2id for password hashing in his side project", "비밀번호를 정기적으로 바꾸는 습관이 있음", "Pin bowling high score is 214", "I prefer passkeys over passwords wherever a site supports them.", "I rotate my passwords every 90 days.", "I forgot my password twice last month and had to reset it.", "My token of thanks to Sam was a 2015 Rioja.", "비밀번호는 3개월마다 바꾸는 편이에요.", "WiFi: Linksys00423", "dana77", "Total saved: 143", "Rotation: 90days", "The Wi-Fi at the office is Eduroam2024", "카드번호 끝자리는 4821이에요.", "The WiFi at my parents' place is called BlueHeron5Ghome.", "WiFi: U+Net1A2B", "와이파이: iptime5G", "Last audit: 2024-11", "Changed: 2024", "대문 번호 1203", "Password reset was on 11-03.", "PIN is the name of my cat, she is 4.", "I prefer passkeys over passwords whenever a site offers them.", "Forgot my bank password twice last month, so I want reminders to rotate it.", "Building a password strength meter for the signup page at work.", "Tracks LLM token costs: about 12k tokens per chat.", "Certification: AWS Solutions Architect, credential ID is on LinkedIn.", "Prefers long passphrases over short complex passwords.", "토큰 비용을 줄이려고 캐시를 써요.", "API key rotation is every 90 days at my company."];
// each value was saved before this filter too: no label names it ("login", "combo", "pass", "invite code", "recovery phrase"),
// it sits under a sub-heading, a named item ("Home:" under "WiFi") or an unnamed "Codes" item, a network name's shape, or plain words
const SAVED = ["qwer1105", "qwer1106", "qwer1109", "qwer1110", "qwer2018", "lilac4023", "plum7010x", "Sp4rrow-lake", "14-32-08", "maple-Tr33-99", "6021", "Qu1etRiver!", "tteok8899", "candle velvet mango", "8213821382", "2F3A9C8214", "01082158215", "ABCD8216", "plum821", "82A20#", "8221", "8231-ab12", "PineTree_903", "CloudNine2026", "Kestrel!742", "849-201-773", "xK9mPq2R", "4532-8910-4421-7709", "correct horse battery staple", "VelvetMoon#91", "VelvetMoon#91", "PineTree_903", "482910", "ABCD-9921", "4532 8910 4421 7709", "maple orbit candle", "Biscuit1997", "4821", "maple_syrup88", "blue-moon-88", "tiger_lily77", "9f8a7b6c5d4e3f2a1b0c", "xapp1A2b3C4d5E6f", "BlueWhale#88", "BlueWhale#4471", "Tr0ub4dor&3", "0429#", "BlueWhale#4471", "sakura-2231-xx", "Dragon8848!", "Kestrel-77-moss-Q", "Sup3rS3cret", "N4s-Home-77", "lunar tiger basket", "BlueWhale#88", "bada-Router!55", "9931 2210", "Gato-Negro-41"];
const runs = CORPUS.map(([, paste, secrets, keeps]) => ({ paste, ...factsOf(paste), secrets, keeps }));
// a one-line paste also arrives as a list item
const pastes = CORPUS.flatMap(([, paste]) => (/\n|^[-*#|]/.test(paste) ? [paste] : [paste, `- ${paste}`]));

describe("import secret filter corpus", () => {
  it("saves no line the import before this filter left out, apart from the reviewed list", () => {
    const saved = new Set(pastes.flatMap((paste) => factsOf(paste).facts.filter(hidBefore)));
    expect([...saved].sort()).toEqual(ALLOWED.map(([fact]) => fact).sort());
  });

  it("keeps every ordinary fact", () => {
    expect(runs.flatMap(({ facts, keeps }) => keeps.filter((keep) => !facts.includes(keep)))).toEqual(LOST);
  });

  it("leaves out every secret value", () => {
    expect(runs.flatMap(({ facts, secrets }) => secrets.filter((secret) => facts.some((fact) => fact.includes(secret))))).toEqual(SAVED);
  });

  // a table header that names its password column was left out before this filter too
  it("counts a left-out line in a paste with no secret only where a fact is lost", () => {
    const counted = runs.filter(({ secrets, keeps, facts, hidden }) => !secrets.length && hidden && keeps.every((keep) => facts.includes(keep)));
    expect(counted.map(({ paste }) => paste)).toEqual(["| Account | Password last changed |\n| Gmail | 2024 |\n| Bank | 2023 |"]);
  });

  // a run of marks or labels is read once, not once per mark or label, so a long pasted line cannot hold up the server
  it("reads a long line in one pass", () => {
    const marks = ".".repeat(100_000);
    const start = performance.now();
    const { hidden } = factsOf([`WiFi: ${marks}x`, `WiFi: ${"@".repeat(100_000)}`, `Likes PIN-up posters ${marks}x`, `와이파이 비번은 ${marks}x예요`, "WiFi ".repeat(15_000), "와이파이 ".repeat(15_000)].join("\n"));
    expect(hidden).toBe(2);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

// a seeded random source, so a failing variant comes back the same on every run
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const next = random(2114);
const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];
const many = (count: number, make: () => string) => Array.from({ length: count }, make);
// letters and syllables that cannot spell a secret label: no c, k, p, s or w; no 비, 번, 암, 키, 코 or 핀
const word = () => many(2 + Math.floor(next() * 3), () => pick([..."bdfglmnrtv"]) + pick([..."aeiou"])).join("");
const korean = () => many(2, () => pick([..."가나다라마사아자차하구누두루무수우주"])).join("");
const value = () => word().replace(/^./, (first) => first.toUpperCase()) + Math.floor(next() * 9000 + 1000) + pick(["", "G", "x"]);

describe("import secret filter rules", () => {
  it("keeps a named item under a WiFi heading unless its name is a secret label", () => {
    const wrong: string[] = [];
    for (let i = 0; i < 300; i++) {
      const ko = i % 3 === 2;
      const heading = ko ? pick(["## 와이파이", "### 집 와이파이", "와이파이:"]) : pick(["## Wi-Fi", "## WiFi", "# Home WiFi", "**WLAN**", "Wi-Fi:"]);
      const kept = `${many(1 + Math.floor(next() * 3), ko ? korean : word).join(" ")}: ${value()}`;
      const label = ko ? pick(["비밀번호", "비번", "암호", "와이파이 비번", "키"]) : pick(["Password", "WiFi password", "PW", "Key", "Network key", "Passcode", "PIN", "Code"]);
      const secret = value();
      const { facts } = factsOf(`${heading}\n- ${kept}\n${pick(["- ", ""])}${label}: ${secret}`);
      if (!facts.includes(kept) && !hidBefore(kept)) wrong.push(kept);
      if (facts.some((fact) => fact.includes(secret))) wrong.push(`${label}: ${secret}`);
    }
    expect(wrong).toEqual([]);
  });

  // after a comma a value needs a cue; a second clause or sentence stays out whatever it says, and so do spaced digits
  it("leaves out a letters-only, spelled-out or spaced value after a word in its other sense", () => {
    const digits = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const en = [(v: string) => `the master is ${v}.`, (v: string) => `I unlock it with ${v}.`, (v: string) => `I sign in as dana with ${v}.`, (v: string) => `log in: ${v}`, (v: string) => `it was ${v}.`, (v: string) => `it takes ${v}.`];
    const ko = [(v: string) => `마스터는 ${v}예요.`, (v: string) => `잠금은 ${v}`, (v: string) => `그건 ${v}이에요.`, (v: string) => `그건 ${v} 이에요.`];
    const wrong: string[] = [];
    for (const [fact] of ALLOWED) {
      const isKo = /[가-힣]/.test(fact);
      const said = fact.replace(/[.!]$/, "");
      const filler = isKo ? korean : word;
      const spelled = isKo ? many(4, () => pick([..."공일이삼사오육칠팔구"])).join(" ") : many(4, () => pick(digits)).join(pick([" ", ", ", "-"]));
      const spaced = many(4, () => String(Math.floor(next() * 10))).join(pick([" ", ", "]));
      for (const secret of [word() + word(), spelled, spaced]) {
        const lines = [...(isKo ? ko : en).map((say) => `${said}, ${say(secret)}`), `${said}. ${filler()} ${filler()} ${secret}.`, `${said}; ${filler()} ${secret}`];
        if (!isKo) lines.push(`${said}, and ${filler()} ${secret}`);
        if (secret === spaced) lines.push(`${said} ${filler()} ${secret}`);
        for (const line of lines) for (const paste of [line, `- ${line}`]) if (factsOf(paste).facts.some((saved) => saved.includes(secret))) wrong.push(paste);
      }
    }
    expect(wrong).toEqual([]);
  });

  // a secret word beside any word of the corpus or of the filter itself is saved only in a sense a reviewed fact shows,
  // so an exception needs a reviewed row even when no corpus row has its word ("password generator")
  it("saves a secret word only in a sense the reviewed list shows", () => {
    const stem = (text: string) => text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/(?:ing|ed|es|e|s|으로|로|는|은|이|가|을|를|에|의|도)$/u, "");
    const stems = (text: string) => ` ${text.split(/[\s\-–—]+/).map(stem).join(" ")} `;
    const reviewed = ALLOWED.map(([fact]) => stems(fact));
    const filter = readFileSync(new URL("./import-secrets.ts", import.meta.url), "utf8");
    const words = new Set([...CORPUS.map(([, paste]) => paste), ...ALLOWED.map(([fact]) => fact), filter].flatMap((text) => text.toLowerCase().match(/[a-z]{3,}|[가-힣]{2,}/g) ?? []));
    const released: string[] = [];
    for (const neighbour of words) {
      const ko = /[가-힣]/.test(neighbour);
      for (const secret of ko ? ["비밀번호", "비번", "암호", "패스워드", "토큰", "시크릿", "핀"] : ["password", "passwords", "PIN", "pin", "pins", "Pin", "token", "tokens", "Token", "secret", "Secret", "passcode", "credentials"]) {
        for (const pair of [`${secret} ${neighbour}`, `${neighbour} ${secret}`]) {
          const line = ko ? `${pair} 좋아요.` : `I like the ${pair}.`;
          if (hidBefore(line) && factsOf(line).facts.length && !reviewed.some((fact) => fact.includes(stems(pair)))) released.push(pair);
        }
      }
    }
    expect(released).toEqual([]);
  });
});
