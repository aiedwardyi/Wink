import { consentOf } from "./consent";
import { asksToRepeat } from "./guard";

export const GAP_MS = 1_500;

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const ORDINAL = /^(?:(?:the|option|number)\s+)?(first|second|third|1|2|3|one|two|three|last)(?:\s+(?:one|option))?$/;
const ORDINAL_KO = /^(첫|두|세|마지막)\s?번째/;
const HELLO = /\b(?:hi|hello|hey)\b|안녕/i;
const PLACE: Record<string, number> = { first: 0, "1": 0, one: 0, 첫: 0, second: 1, "2": 1, two: 1, 두: 1, third: 2, "3": 2, three: 2, 세: 2 };

export function answersCard(said: string, options: readonly string[]): boolean {
  const text = said.trim();
  if (!text || /\?\s*$/.test(text) || asksToRepeat(text)) return false;
  if (consentOf(text)) return true;
  // A question with no choices takes any plain line but a hello.
  if (!options.length) return !HELLO.test(text);
  const line = words(text);
  const size = line.split(" ").length;
  const named = options.filter((option) => {
    const want = words(option);
    return want !== "" && ` ${line} `.includes(` ${want} `) && size <= want.split(" ").length + 2;
  });
  if (named.length === 1) return true;
  const place = line.match(ORDINAL)?.[1] ?? text.match(ORDINAL_KO)?.[1];
  if (!place || !options.length) return false;
  const index = place === "last" || place === "마지막" ? options.length - 1 : PLACE[place]!;
  return index < options.length;
}
