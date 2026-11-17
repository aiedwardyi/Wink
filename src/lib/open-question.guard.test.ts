import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = "src/lib/open-question.ts";

const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return sources(path);
  return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
});
// the first-run quiz and live asks: other cards, which name askUser only to step around it
const OTHER_CARDS = new Set(["components/OptionCard.tsx", "state/store-transforms.ts"]);
// a file that touches the ask_user card
const ASK_AWARE = /askUser|isAskUserCard|PendingQuestion|AskUserRecord|open-question/;
const RULES: Array<[RegExp, string]> = [
  [/\.staysOpen\b/, "reads staysOpen"],
  [/card[!?]?\.(?:answered|dismissed)\b(?!\s*:)/, "reads a card's answered or dismissed"],
  [/\w*[Qq]uestion\w*\s*=\s*new (?:Set|Map)\b/, "keeps its own question Set or Map"],
  [/\buse(?:State|Ref)\b[^\n]*[Qq]uestion|[Qq]uestion\w*\]?\s*=\s*use(?:State|Ref)\b/, "keeps question state of its own"],
];

describe("one source for the question card", () => {
  it("leaves every open, fold and settle decision to the module", () => {
    const found: string[] = [];
    for (const file of [...sources(join(src, "components")), ...sources(join(src, "state"))]) {
      const text = readFileSync(file, "utf8");
      if (!ASK_AWARE.test(text) || OTHER_CARDS.has(relative(src, file).replaceAll("\\", "/"))) continue;
      text.split("\n").forEach((line, at) => {
        for (const [rule, what] of RULES) if (rule.test(line)) found.push(`${relative(join(src, ".."), file)}:${at + 1} ${what}`);
      });
    }
    expect(found, `decide the question card's open, fold or settle state in ${MODULE} (askRecord, useQuestionView, useShownQuestion, answerPatch, settledBy) and read it from there`).toEqual([]);
  });
});
