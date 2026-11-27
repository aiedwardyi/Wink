import { describe, expect, it } from "vitest";

import { checkWrong, fixTargets, planWrong, wrongPairs, wrongPrompt, applyFix, undoFix, type OwnerRow, type SavedNotes } from "./dream-wrong.ts";
import { sha8 } from "./memory-clean.ts";
import type { NoteGenerator } from "./memory-pass.ts";
import { at, SAFETY_IDS, SAFETY_MEMORY } from "./testing/dream-safety.ts";

const TODAY = "2026-11-26";
const time = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const TRAPS = {
  release: '- RELEASE ONCE A DAY (11-19, their "bigger releases ... update once a day might be okay ... whats new card thats really nice and animated ... 2 cards max and show more leading to that feature"): after launch, 1 release/day; work never stops at 5 pm.',
  rooms: "- ROOMS WORD (11-20): say rooms and Room Details to them in every user-facing string.",
  plan: "- The main account's plan ends in January (noted 2026-11-20)",
  theme: "- Prefers the blue theme for the app (noted 2026-11-26)",
};
// the same claim as the plan trap, written after the line that shows it wrong
const LATER = "- The main account's plan runs out in January (noted 2026-11-25)";
const REAL = {
  anyTime: "- RELEASES ANY TIME (11-23): ship a release whenever it is ready, no fixed days.",
  groups: '- GROUPS NOT ROOMS (11-23, their "its called groups not rooms we removed that name and changed it"): say groups.',
  store: "- Has a developer account for the app store (noted 2026-11-10)",
  resets: "- Two banked resets left on the spare account (noted 2026-11-16)",
};
const MEMORY = SAFETY_MEMORY + [...Object.values(TRAPS), LATER, ...Object.values(REAL)].join("\n") + "\n";
const row = (id: string, when: number, text: string): OwnerRow => ({ thread: "t1", id, at: when, text });
const ROWS = [
  row("old-resets", time(15, 9), "theres no more banked resets on the spare account"),
  row("store", time(23, 10), "the developer account is ready for the app store build"),
  row("rooms", time(23, 12, 43), "its called groups not rooms we removed that name and changed it"),
  row("release", time(23, 13, 10), "Dont have to stick to one update per day can do more release cause we have 0 users"),
  row("accounts", time(24, 9), "And the other account too but my other projects use it so leave that until later"),
  row("plan", time(24, 22), "For the main account plan leave it. It lasts till march and thats my main account anyways."),
  row("dark", time(24, 23), "dark mode looks good on the phone, keep it"),
  row("pnpm", time(25, 8), "we still use pnpm for every repo, not npm, the new repo too"),
  row("adhd", time(25, 9), "short lines please, I have ADHD and long replies are hard"),
  row("theme-early", time(26, 9), "the blue theme is not the one I want for the app anymore"),
  row("theme", time(26, 18), "not the blue theme anymore, the green theme is the one for the app now"),
];
// the theme note was saved at 10:00, after the 09:00 line and before the 18:00 one
const SAVED: SavedNotes[] = [{ at: time(26, 10), text: "Prefers the blue theme for the app" }];

type Rule = { note: string; row: string; quote: string; fix: string; judges?: ("claude" | "gemini")[] };
// what the two judges answer for a pair, single-judge noise included
const RULES: Rule[] = [
  { note: TRAPS.release, row: "release", quote: "Dont have to stick to one update per day can do more release", fix: "RELEASE ONCE A DAY (11-19): after launch, releases are not capped at one per day; work never stops at 5 pm.", judges: ["claude"] },
  { note: TRAPS.release, row: "release", quote: "Dont have to stick to one update per day", fix: "- MULTIPLE RELEASES A DAY (11-23): ship more than one release a day.", judges: ["gemini"] },
  { note: TRAPS.rooms, row: "rooms", quote: "its called groups not rooms we removed that name and changed it", fix: "- ROOMS WORD (11-20): say groups, not rooms, and Group Details to them in every user-facing string." },
  { note: TRAPS.plan, row: "plan", quote: "It lasts till march", fix: "The main account's plan ends in March (noted 2026-11-20)" },
  { note: LATER, row: "plan", quote: "It lasts till march", fix: "- The main account's plan runs out in March (noted 2026-11-25)" },
  { note: TRAPS.theme, row: "theme", quote: "the green theme is the one for the app now", fix: "- Prefers the green theme for the app (noted 2026-11-26)" },
  { note: TRAPS.theme, row: "theme-early", quote: "the blue theme is not the one I want", fix: "- Does not want the blue theme for the app (noted 2026-11-26)" },
  { note: REAL.resets, row: "old-resets", quote: "theres no more banked resets", fix: "- No banked resets left on the spare account (noted 2026-11-16)" },
  { note: "ACCOUNTS MINE", row: "accounts", quote: "leave that until later", fix: "- ACCOUNTS MINE: leave the other account until later.", judges: ["gemini"] },
  { note: "Prefers dark mode, not light mode", row: "dark", quote: "prefers dark mode", fix: "- Prefers dark mode on the phone too (noted 2026-11-12)" },
  { note: "Uses pnpm for every repo (noted 2026-11-01)", row: "pnpm", quote: "we still use pnpm", fix: "- Uses pnpm for every repo (noted 2026-11-01)", judges: ["claude"] },
  { note: "Uses pnpm for every repo (noted 2026-11-01)", row: "pnpm", quote: "not npm, the new repo too", fix: "- Uses pnpm for every repo (noted 2026-11-01)", judges: ["gemini"] },
  { note: "The user has ADHD", row: "adhd", quote: "I have ADHD and long replies are hard", fix: "- The user has ADHD and dyslexia: lead with the answer, short lines (11-25)." },
];
const PAIR = /^PAIR\nL(\d+) \(written [^)]*\): (.*)\n(M\d+) \([^)]*\): ([\s\S]*?)$/;
function judge(name: "claude" | "gemini"): NoteGenerator {
  return async (prompt) => {
    const wrong = prompt.split(/\n(?=PAIR\n)/).flatMap((block) => {
      const [, line, note, ref, text] = PAIR.exec(block.replace(/\n<\/pairs>$/, "").trimEnd()) ?? [];
      if (!ref) return [];
      const said = ROWS.find((each) => each.text === text!.trim());
      return RULES.filter((rule) => (rule.judges ?? ["claude", "gemini"]).includes(name) && note!.includes(rule.note.replace(/^- /, "")) && said?.id === rule.row).map((rule) => ({ note: `L${line}`, message: ref, quote: rule.quote, fix: rule.fix }));
    });
    return JSON.stringify({ wrong });
  };
}
const judges = { claude: judge("claude"), gemini: judge("gemini") };
const check = (rows = ROWS) => checkWrong({ raw: MEMORY, rows, saved: SAVED, judges, today: TODAY, signal: new AbortController().signal, now: Date.now });

describe("wrong-note check", () => {
  it("lists the three planted wrong notes and the same-day one with the owner's words, and no other note", async () => {
    const { state, items } = await check();
    expect(state).toBe("checked");
    expect(items.map(({ text, by, listOnly, evidence }) => [text, by, listOnly, evidence.message, evidence.quote])).toEqual(expect.arrayContaining([
      [TRAPS.release, "- RELEASE ONCE A DAY (11-19): after launch, releases are not capped at one per day; work never stops at 5 pm.", true, "release", "Dont have to stick to one update per day"],
      [TRAPS.rooms, "- ROOMS WORD (11-20): say groups, not rooms, and Group Details to them in every user-facing string.", true, "rooms", "its called groups not rooms we removed that name and changed it"],
      [TRAPS.plan, "- The main account's plan ends in March (noted 2026-11-20)", false, "plan", "It lasts till march"],
      [TRAPS.theme, "- Prefers the green theme for the app (noted 2026-11-26)", false, "theme", "the green theme is the one for the app now"],
    ]));
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.op === "fix" && item.why === "wrong" && /^note:[0-9a-f]{8}$/.test(item.target))).toBe(true);
  });

  it("never pairs a note with the line it was written from", async () => {
    const pairs = await wrongPairs(MEMORY, fixTargets(MEMORY), ROWS);
    expect(pairs.some((pair) => pair.note.text === REAL.groups && pair.row.id === "rooms")).toBe(false);
    expect(pairs.some((pair) => pair.note.text === TRAPS.rooms && pair.row.id === "rooms")).toBe(true);
  });

  it("holds a flag back unless both judges name it, quote the row word for word and alike, the row comes after the note and the fix adds nothing", async () => {
    const pairs = await wrongPairs(MEMORY, fixTargets(MEMORY), ROWS);
    const { refs } = wrongPrompt(pairs, TODAY);
    const flags = (name: "claude" | "gemini") => [...refs].flatMap(([ref, pair]) => RULES.filter((rule) => (rule.judges ?? ["claude", "gemini"]).includes(name) && pair.note.text.includes(rule.note.replace(/^- /, "")) && pair.row.id === rule.row).map((rule) => ({ note: `L${pair.note.at + 1}`, message: ref, quote: rule.quote, fix: rule.fix })));
    const all = MEMORY.split("\n");
    const written = (note: { text: string }) => (note.text === TRAPS.theme ? time(26, 10) : undefined);
    const { rejected } = planWrong(flags("claude"), flags("gemini"), refs, { all, today: TODAY, written });
    const why = Object.fromEntries(rejected.map((each) => [each.message + " " + all[each.note - 1], each.why]));
    expect(why).toMatchObject({
      [`plan ${LATER}`]: "row not after the note",
      [`old-resets ${REAL.resets}`]: "row not after the note",
      [`pnpm ${all[at("pnpm")]}`]: "judges quote different words",
      [`dark ${all[at("dark")]}`]: "quote not word for word in that row",
      [`adhd ${all[at("adhd")]}`]: "fix not grounded in the old line and the quote",
    });
    // a same-day line with no save time to order it by stays out
    const unordered = planWrong(flags("claude"), flags("gemini"), refs, { all, today: TODAY, written: () => undefined });
    expect(unordered.items.map((item) => item.text)).not.toContain(TRAPS.theme);
  });

  it("holds back a same-day line typed before Auto Notes saved the note", async () => {
    const { items } = await check(ROWS.filter((each) => each.id !== "theme"));
    expect(items.map((item) => item.text)).not.toContain(TRAPS.theme);
    expect(items).toHaveLength(3);
  });

  it("flags none of the 48 lines known never to move", async () => {
    const { items } = await check();
    const safety = new Set(SAFETY_IDS.map((id) => MEMORY.split("\n")[at(id)]));
    expect(items.filter((item) => safety.has(item.text))).toEqual([]);
  });

  it("sends at most 30 pairs in 32 KB and calls no judge for no new lines", async () => {
    const many = Array.from({ length: 200 }, (_, n) => row(`m${n}`, time(25, 0, n), `not the blue theme anymore for the app, the green theme number ${n} is the one now`));
    const pairs = await wrongPairs(MEMORY, fixTargets(MEMORY), many);
    const { prompt, refs } = wrongPrompt(pairs, TODAY);
    expect(refs.size).toBeLessThanOrEqual(30);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(32 * 1024);
    let calls = 0;
    const counted: NoteGenerator = async () => {
      calls += 1;
      return '{"wrong": []}';
    };
    expect((await checkWrong({ raw: MEMORY, rows: [], saved: [], judges: { claude: counted, gemini: counted }, today: TODAY, signal: new AbortController().signal, now: Date.now })).items).toEqual([]);
    expect(calls).toBe(0);
  });

  it("lists nothing while a judge is missing or unreadable", async () => {
    expect(await checkWrong({ raw: MEMORY, rows: ROWS, saved: SAVED, judges: { claude: judges.claude, gemini: null }, today: TODAY, signal: new AbortController().signal, now: Date.now })).toMatchObject({ state: "no-model", items: [] });
    expect(await checkWrong({ raw: MEMORY, rows: ROWS, saved: SAVED, judges: { claude: judges.claude, gemini: async () => "no json" }, today: TODAY, signal: new AbortController().signal, now: Date.now })).toMatchObject({ state: "no-model", items: [] });
  });

  it("swaps only the note's own line and puts the exact old bytes back", () => {
    const raw = "# Memory\r\n\r\n- Keep\r\n" + TRAPS.plan + "\r\n- Keep too\r\n";
    const item = { target: `note:${sha8(TRAPS.plan)}`, text: TRAPS.plan, by: "- The main account's plan ends in March (noted 2026-11-20)" };
    const swapped = applyFix(raw, item)!;
    expect(swapped.text).toBe(raw.replace(TRAPS.plan, item.by));
    expect(swapped).toMatchObject({ line: 3, cr: true });
    expect(undoFix(swapped.text, { ...item, done: { at: 1, line: swapped.line, cr: swapped.cr, id: "x" } })).toBe(raw);
    expect(applyFix(raw + TRAPS.plan + "\n", item)).toBeNull();
    expect(undoFix(raw, { ...item, done: { at: 1, line: 3, cr: true, id: "x" } })).toBeNull();
  });
});
