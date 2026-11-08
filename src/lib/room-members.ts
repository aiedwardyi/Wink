import type { LocaleId, MessageKey } from "./i18n";

// Turning a set of ticked bots back into a room's ordered roster. Existing
// members keep their order, so the room's lead does not move when someone new
// joins; additions land at the end, in the order the picker listed them.
export function nextMemberIds(current: string[], picked: Set<string>, order: string[]): string[] {
  return [...current.filter((id) => picked.has(id)), ...order.filter((id) => picked.has(id) && !current.includes(id))];
}

export function moveMember(ids: string[], id: string, to: number): string[] {
  const rest = ids.filter((other) => other !== id);
  if (rest.length === ids.length) return ids;
  rest.splice(Math.max(0, Math.min(rest.length, to)), 0, id);
  return rest;
}

const ORDINAL = new Intl.PluralRules("en-US", { type: "ordinal" });
const ORDINAL_KEY = {
  one: "groupWizard.orderOne",
  two: "groupWizard.orderTwo",
  few: "groupWizard.orderFew",
  other: "groupWizard.orderOther",
} as const;

/** The "1st", "2nd", "3rd" message for answer position `n`, counted from 1. */
export function answerOrderKey(n: number): MessageKey {
  const rule = ORDINAL.select(n);
  return rule === "one" || rule === "two" || rule === "few" ? ORDINAL_KEY[rule] : ORDINAL_KEY.other;
}

const KO_ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const KO_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];

/** Korean counts 번째 in native words (첫, 두, ..., 스무, 스물한); a group tops out at 100 bots. */
function koreanOrdinal(n: number): string {
  if (n === 1) return "첫";
  if (n === 20) return "스무";
  if (n === 100) return "백";
  if (!Number.isInteger(n) || n < 1 || n > 100) return String(n);
  return KO_TENS[Math.floor(n / 10)]! + KO_ONES[n % 10]!;
}

export function answerOrderVars(locale: LocaleId, n: number) {
  return { n: locale === "ko" ? koreanOrdinal(n) : n };
}
