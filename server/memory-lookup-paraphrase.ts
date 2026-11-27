// Lightweight English stemmer and small built-in table of close equivalents for memory recall.

const DOUBLE_END = /([bdfgmnprt])\1$/;
const KEEP_E_STEM = /(?:at|bl|iz|tl|dl|pl|gl|cl|dg|rg|lv|rv|rc|nc)$|(?:ch|rr)ang$/;

function isConsonant(word: string, at: number): boolean {
  const ch = word[at];
  if (ch === "a" || ch === "e" || ch === "i" || ch === "o" || ch === "u") return false;
  if (ch === "y") return at === 0 || !isConsonant(word, at - 1);
  return true;
}

function measure(word: string): number {
  let count = 0;
  let inVowel = false;
  for (let i = 0; i < word.length; i++) {
    if (isConsonant(word, i)) {
      if (inVowel) {
        count++;
        inVowel = false;
      }
    } else {
      inVowel = true;
    }
  }
  return count;
}

function hasVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) if (!isConsonant(word, i)) return true;
  return false;
}

function endsCvc(word: string): boolean {
  const n = word.length;
  if (n < 3) return false;
  const last = word[n - 1]!;
  return last !== "w" && last !== "x" && last !== "y" && isConsonant(word, n - 1) && !isConsonant(word, n - 2) && isConsonant(word, n - 3);
}

/** Conservative English stemmer aligned with FTS5 Porter without over-stemming short nouns. */
export function stem(raw: string): string {
  let word = raw.toLowerCase();
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return word;

  // Step 1a: plurals and 3rd-person singular
  if (word.endsWith("sses")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ies") && word.length > 4) {
    word = `${word.slice(0, -3)}y`;
  } else if (/(?:ch|sh|x|z)es$/.test(word) && word.length > 4) {
    word = word.slice(0, -2);
  } else if (word.endsWith("s") && !/(?:ss|us|is|as)$/.test(word) && hasVowel(word.slice(0, -1))) {
    word = word.slice(0, -1);
  }

  // Step 1b: past tense and gerund
  if (word.endsWith("ied") && word.length > 4) {
    word = `${word.slice(0, -3)}y`;
  } else if (word.endsWith("ying") && word.length > 5) {
    word = `${word.slice(0, -4)}y`;
  } else if (word.endsWith("eed")) {
    const base = word.slice(0, -1);
    if (measure(word.slice(0, -3)) > 0) word = base;
  } else {
    const suffix = word.endsWith("ing") ? 3 : word.endsWith("ed") ? 2 : 0;
    if (suffix && word.length - suffix >= 3 && hasVowel(word.slice(0, -suffix))) {
      let base = word.slice(0, -suffix);
      if (DOUBLE_END.test(base) || (base.endsWith("ll") && base.length >= 6)) {
        base = base.slice(0, -1);
      } else if (KEEP_E_STEM.test(base) || (measure(base) === 1 && endsCvc(base))) {
        base = `${base}e`;
      }
      word = base;
    }
  }

  // Step 2: high-precision derivational suffixes
  if (word.endsWith("ization") || word.endsWith("isation")) {
    const base = word.slice(0, -5);
    if (measure(base) >= 1) word = `${base}z`;
  } else if (word.endsWith("ification") && word.length > 10) {
    word = `${word.slice(0, -7)}y`;
  } else if (word.endsWith("ation") && word.length > 7) {
    const base = word.slice(0, -5);
    if (base.endsWith("ll") && base.length >= 6) word = base.slice(0, -1);
    else if (/(?:rm|ur|ir|or)$/.test(base) && measure(base) >= 1) word = base;
    else if (measure(base) >= 1) word = `${base}at`;
  } else if (word.endsWith("ment") && word.length > 7) {
    const base = word.slice(0, -4);
    if (base !== "apart" && base !== "depart" && measure(base) >= 1) word = base;
  } else if (word.endsWith("ship") && word.length > 7) {
    word = word.slice(0, -4);
  } else if (word.endsWith("ness") && word.length > 7) {
    const base = word.slice(0, -4);
    word = base.endsWith("i") ? `${base.slice(0, -1)}y` : base;
  } else if ((word.endsWith("able") || word.endsWith("ible")) && word.length > 7) {
    const base = word.slice(0, -4);
    if (measure(base) >= 2) word = base;
  } else if (word.endsWith("al") && word.length > 6) {
    const base = word.slice(0, -2);
    if (/[vws]$/.test(base) && measure(base) >= 2) word = base;
  } else if ((word.endsWith("er") || word.endsWith("or")) && word.length > 5) {
    const base = word.slice(0, -2);
    if (!base.endsWith("i") && measure(base) >= 2) word = base;
  } else if (word.endsWith("ly") && word.length > 5) {
    const base = word.slice(0, -2);
    if (measure(base) >= 2 || (base.length >= 4 && !/^(?:on|ear|dai|app|rep|supp|fami|ug)$/.test(base))) {
      word = base.endsWith("i") ? `${base.slice(0, -1)}y` : base;
    }
  }

  // Step 3: normalize trailing silent -e only on multi-syllable stems (measure > 1)
  if (word.endsWith("e") && !word.endsWith("ee") && measure(word.slice(0, -1)) > 1) {
    word = word.slice(0, -1);
  }

  return word;
}

const RAW_EQUIVALENT_GROUPS: readonly (readonly string[])[] = [
  // movement & place
  ["move", "relocate", "transfer"],
  ["venue", "location"],
  ["abroad", "overseas"],
  ["apartment", "condo", "flat"],
  ["lodging", "accommodation", "hotel"],
  ["headquarters", "hq"],
  ["remote", "wfh", "telecommute"],
  // approvals & decisions
  ["approve", "sign off", "signoff", "authorize", "greenlight"],
  ["settle", "confirm", "decide", "finalize", "agree"],
  ["cancel", "abort", "call off", "revoke"],
  ["postpone", "delay", "defer", "push back", "reschedule"],
  ["forbid", "prohibit", "ban", "disallow"],
  ["prefer", "favor"],
  ["mandatory", "required", "compulsory"],
  // people & roles
  ["owner", "assignee", "point person", "custodian", "maintainer"],
  ["vendor", "supplier", "contractor"],
  ["colleague", "coworker", "teammate"],
  ["attorney", "lawyer", "counsel"],
  ["physician", "doctor"],
  ["spouse", "partner"],
  // deadlines & cadence
  ["deadline", "due date", "cutoff", "cut off"],
  ["annual", "yearly"],
  ["biweekly", "fortnightly"],
  ["temporary", "interim", "provisional"],
  ["previous", "prior", "former"],
  // budgets & billing
  ["cap", "ceiling", "limit", "maximum"],
  ["invoice", "billing"],
  ["reimburse", "refund", "repay", "expense claim"],
  ["salary", "compensation"],
  ["purchase", "buy", "acquire"],
  // work & ops
  ["deploy", "rollout", "roll out"],
  ["outage", "downtime", "incident"],
  ["offsite", "retreat"],
  ["standup", "daily sync", "scrum"],
  ["handoff", "hand off", "handover", "hand over"],
  ["followup", "follow up"],
  ["kickoff", "kick off"],
  ["setup", "set up"],
  ["backup", "back up"],
  ["workaround", "work around", "fallback"],
  ["migrate", "cutover", "transition"],
  ["delete", "remove", "purge", "erase"],
  ["verify", "validate"],
  ["investigate", "diagnose", "troubleshoot"],
  ["resolve", "remediate"],
  ["notify", "alert"],
  ["deprecate", "sunset", "discontinue", "terminate"],
  ["login", "log in", "signin", "sign in"],
  ["logout", "log out", "signout", "sign out"],
  ["signup", "sign up", "register"],
  ["shutdown", "shut down"],
  // everyday tools & common abbreviations
  ["inbox", "mailbox"],
  ["carrier", "courier", "shipper"],
  ["printer", "copier"],
  ["handset", "phone", "mobile", "cellphone"],
  ["timezone", "time zone"],
  ["headcount", "head count"],
  ["luggage", "baggage"],
  ["itinerary", "travel plan"],
  ["automobile", "vehicle", "car"],
  ["bicycle", "bike"],
  ["refrigerator", "fridge"],
  ["medication", "prescription"],
  ["appointment", "appt"],
  ["department", "dept"],
  ["management", "mgmt"],
  ["configure", "config"],
  ["repository", "repo"],
  ["environment", "env"],
  ["administrator", "admin"],
  ["specification", "spec"],
  ["authenticate", "auth"],
  ["synchronize", "sync"],
  ["address", "addr"],
];

const normalizeKey = (entry: string) =>
  entry.includes(" ") ? entry.split(" ").map(stem).join(" ") : stem(entry);

const equivalentMap = new Map<string, string[]>();
const knownPhrases = new Set<string>();
const phraseStarts = new Set<string>();

for (const group of RAW_EQUIVALENT_GROUPS) {
  const keys = [...new Set(group.map(normalizeKey))];
  for (const key of keys) {
    if (key.includes(" ")) {
      knownPhrases.add(key);
      phraseStarts.add(key.split(" ")[0]!);
    }
    const others = keys.filter((other) => other !== key);
    const existing = equivalentMap.get(key);
    if (existing) {
      for (const other of others) if (!existing.includes(other)) existing.push(other);
    } else {
      equivalentMap.set(key, others);
    }
  }
}

export const KNOWN_PHRASES: ReadonlySet<string> = knownPhrases;
export const PHRASE_STARTS: ReadonlySet<string> = phraseStarts;

const EMPTY: readonly string[] = [];
export const equivalentKeys = (key: string): readonly string[] => equivalentMap.get(key) ?? EMPTY;
