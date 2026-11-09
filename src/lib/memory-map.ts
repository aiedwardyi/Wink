import type { Message } from "@/state/store";
import { memoryLineText, recentLines } from "./memory-recent";

export interface MemoryFact {
  line: string;
  fact: string;
  at: Date | null;
}

export interface MemoryMapData {
  longTerm: MemoryFact[];
  learned: MemoryFact[];
  muscle: MemoryFact[];
}

export const LEARNED_SHOWN = 3;

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const NOTED = /\s+\(noted (\d{4})-(\d{2})-(\d{2})\)\s*$/;
// a line that points at a topic file belongs to Knowledge, not to the facts
const LINK = /^\[[^\]]+\]\([^)]+\)/;
// structure a plain line must not be: heading, table row, rule
const STRUCTURE = /^(?:#|\||[-*_]{3,}$)/;
// rules for how the bot should act, the habits a user's corrections leave behind
const MUSCLE = /^(?:feedback\b|when you\b|wants the bot\b|never\b|always\b|don'?t\b|do not\b|before\b)/i;

const newestFirst = (a: MemoryFact, b: MemoryFact) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0);

export function memoryMap(text: string, messages: readonly Message[] = []): MemoryMapData {
  let fenced = false;
  let commented = false;
  const facts = text.split("\n").flatMap((raw) => {
    const line = raw.trimEnd();
    const bare = line.trim();
    const fence = /^(?:```|~~~)/.test(bare);
    if (fence) fenced = !fenced;
    const comment = commented || bare.startsWith("<!--");
    if (comment) commented = !bare.includes("-->");
    if (!ITEM.test(line) && (!bare || fence || fenced || comment || STRUCTURE.test(bare))) return [];
    const fact = memoryLineText(line).replace(/`/g, "");
    if (!fact || LINK.test(fact)) return [];
    const stamp = NOTED.exec(line);
    return [{ line, fact, at: stamp ? new Date(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3])) : null }];
  });
  const muscle = facts.filter((each) => MUSCLE.test(each.fact)).sort(newestFirst);
  const learned = recentLines(text, messages).slice(0, LEARNED_SHOWN).map(({ line, fact, at }) => ({ line, fact: fact.replace(/`/g, ""), at }));
  const skip = new Set([...muscle, ...learned].map((each) => each.line));
  return { longTerm: facts.filter((each) => !skip.has(each.line)).sort(newestFirst), learned, muscle };
}
