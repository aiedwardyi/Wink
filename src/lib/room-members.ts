import type { MessageKey } from "./i18n-catalog";

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
