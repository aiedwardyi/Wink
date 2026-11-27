import { describe, expect, it } from "vitest";

import { checkWrong, fixTargets, newestOwned, ownedIds, ownerRows, ownerTyped, planWrong, proposes, wrongPairs, wrongPrompt, applyFix, undoFix, type Newest, type OwnerRow, type SavedNotes, type StoredRow } from "./dream-wrong.ts";
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
const row = (id: string, when: number, text: string): OwnerRow => ({ thread: "t1", id, at: when, text, whole: true });
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
  row("theme", time(26, 18), "the green theme is the one for the app now"),
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
const named = ({ thread, id, at: when }: OwnerRow): Newest => ({ thread, id, at: when });
const newest = (rows: readonly OwnerRow[]) => rows.length ? named(rows.reduce((last, each) => (each.at > last.at ? each : last))) : undefined;
const check = (rows = ROWS, latest: Newest | null = newest(rows) ?? null, use: typeof judges = judges) => checkWrong({ raw: MEMORY, rows, newest: latest ?? undefined, ids: "ids", owned: [], saved: SAVED, judges: use, today: TODAY, signal: new AbortController().signal, now: Date.now });
const upTo = (id: string) => ROWS.slice(0, ROWS.findIndex((each) => each.id === id) + 1);

describe("wrong-note check", () => {
  it("lists a planted wrong note from the owner's newest message with their words, and no other note", async () => {
    const plan = await check(upTo("plan"));
    expect(plan.state).toBe("checked");
    expect(plan.items.map(({ text, by, listOnly, evidence, seen }) => [text, by, listOnly, evidence.message, evidence.quote, seen])).toEqual([
      [TRAPS.plan, "- The main account's plan ends in March (noted 2026-11-20)", false, "plan", "It lasts till march", { at: time(24, 22), sha: sha8(ROWS.find((each) => each.id === "plan")!.text), ids: "ids" }],
    ]);
    const { items } = await check();
    expect(items.map(({ text, by, evidence }) => [text, by, evidence.message])).toEqual([[TRAPS.theme, "- Prefers the green theme for the app (noted 2026-11-26)", "theme"]]);
    expect([...plan.items, ...items].every((item) => item.op === "fix" && item.why === "wrong" && /^note:[0-9a-f]{8}$/.test(item.target))).toBe(true);
  });

  it("judges only the owner's newest message, alone at its time and read whole", async () => {
    const prompts: string[] = [];
    const spy = (generate: NoteGenerator): NoteGenerator => async (prompt, ...rest) => {
      prompts.push(prompt);
      return generate(prompt, ...rest);
    };
    const watched = { claude: spy(judges.claude), gemini: spy(judges.gemini) };
    await check(ROWS, newest(ROWS), watched);
    const sent = prompts.flatMap((prompt) => [...prompt.matchAll(/^M\d+ \([^)]*\): (.*)$/gm)].map((match) => match[1]));
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set([ROWS.at(-1)!.text]));
    prompts.length = 0;
    const last = ROWS.at(-1)!;
    const cases: [string, OwnerRow[], Newest | null][] = [
      ["guarded", [...ROWS.slice(0, -1), { ...last, guarded: true, whole: undefined }], named(last)],
      ["cut", [...ROWS.slice(0, -1), { ...last, whole: undefined }], named(last)],
      ["followed by a message no judge reads", ROWS, { thread: "t1", id: "picture", at: last.at + 1 }],
      ["when the order of the owner's messages is unclear", ROWS, null],
    ];
    for (const [name, rows, latest] of cases) expect([name, (await check(rows, latest, watched)).items, prompts.length]).toEqual([name, [], 0]);
  });

  it("never sends a guarded line that names a note", async () => {
    const secret: OwnerRow = { ...row("secret", time(24, 21), "The main account password is SunnyHarbor! now"), guarded: true, whole: undefined };
    const pairs = await wrongPairs(MEMORY, fixTargets(MEMORY), [...ROWS, secret]);
    expect(pairs.some((pair) => pair.row.guarded)).toBe(false);
    expect(wrongPrompt(pairs, TODAY).prompt).not.toContain("SunnyHarbor");
    expect(await check([secret], named(secret))).toMatchObject({ items: [], pairs: 0 });
  });

  it("holds a flag back unless both judges name it, quote the row word for word and alike, the row comes after the note and the fix adds nothing", async () => {
    const all = MEMORY.split("\n");
    const written = (note: { text: string }) => (note.text === TRAPS.theme ? time(26, 10) : undefined);
    const verdict = async (rows: OwnerRow[], latest: Newest, when = written) => {
      const { refs } = wrongPrompt(await wrongPairs(MEMORY, fixTargets(MEMORY), rows), TODAY);
      const flags = (name: "claude" | "gemini") => [...refs].flatMap(([ref, pair]) => RULES.filter((rule) => (rule.judges ?? ["claude", "gemini"]).includes(name) && pair.note.text.includes(rule.note.replace(/^- /, "")) && pair.row.id === rule.row).map((rule) => ({ note: `L${pair.note.at + 1}`, message: ref, quote: rule.quote, fix: rule.fix })));
      return planWrong(flags("claude"), flags("gemini"), refs, { all, today: TODAY, written: when, newest: latest, ids: "ids", owned: [] });
    };
    // each row as the owner's newest message
    const rejected = (await Promise.all(ROWS.map((each) => verdict([each], named(each))))).flatMap((each) => each.rejected);
    const why = Object.fromEntries(rejected.map((each) => [each.message + " " + all[each.note - 1], each.why]));
    expect(why).toMatchObject({
      [`release ${TRAPS.release}`]: "judges fix different values",
      [`pnpm ${all[at("pnpm")]}`]: "judges quote different words",
      [`adhd ${all[at("adhd")]}`]: "fix not grounded in the old line and the quote",
    });
    const theme = ROWS.find((each) => each.id === "theme")!;
    expect((await verdict([theme], named(theme))).items.map((item) => item.text)).toEqual([TRAPS.theme]);
    // a same-day line with no save time to order it by stays out
    expect((await verdict([theme], named(theme), () => undefined)).items).toEqual([]);
    // a line the owner wrote more after never proposes
    const plan = ROWS.find((each) => each.id === "plan")!;
    const later = await verdict([plan], named(theme));
    expect(later.items).toEqual([]);
    expect(later.rejected).toContainEqual({ note: all.indexOf(TRAPS.plan) + 1, message: "plan", why: "row is not the owner's newest message, read whole" });
  });

  it("holds back a same-day line typed before Auto Notes saved the note", async () => {
    expect((await check(upTo("theme-early"))).items).toEqual([]);
  });

  it("flags none of the 48 lines known never to move, whichever line is the newest", async () => {
    const items = (await Promise.all(ROWS.map((each) => check(upTo(each.id))))).flatMap((each) => each.items);
    const safety = new Set(SAFETY_IDS.map((id) => MEMORY.split("\n")[at(id)]));
    expect(items.map((item) => item.text)).toEqual([TRAPS.plan, TRAPS.theme]);
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
    expect((await checkWrong({ raw: MEMORY, rows: [], newest: undefined, ids: "", owned: [], saved: [], judges: { claude: counted, gemini: counted }, today: TODAY, signal: new AbortController().signal, now: Date.now })).items).toEqual([]);
    expect(calls).toBe(0);
  });

  it("lists nothing while a judge is missing or unreadable", async () => {
    expect(await checkWrong({ raw: MEMORY, rows: ROWS, newest: newest(ROWS), ids: "ids", owned: [], saved: SAVED, judges: { claude: judges.claude, gemini: null }, today: TODAY, signal: new AbortController().signal, now: Date.now })).toMatchObject({ state: "no-model", items: [] });
    expect(await checkWrong({ raw: MEMORY, rows: ROWS, newest: newest(ROWS), ids: "ids", owned: [], saved: SAVED, judges: { claude: judges.claude, gemini: async () => "no json" }, today: TODAY, signal: new AbortController().signal, now: Date.now })).toMatchObject({ state: "no-model", items: [] });
  });

  it("swaps only the note's own line and puts the exact old bytes back", () => {
    const raw = "# Memory\r\n\r\n- Keep\r\n" + TRAPS.plan + "\r\n- Keep too\r\n";
    const item = { target: `note:${sha8(TRAPS.plan)}`, text: TRAPS.plan, by: "- The main account's plan ends in March (noted 2026-11-20)" };
    const swapped = applyFix(raw, item)!;
    expect(swapped.text).toBe(raw.replace(TRAPS.plan, item.by));
    expect(swapped).toMatchObject({ line: 3, cr: true });
    const { text, ...placed } = swapped;
    expect(undoFix(text, { ...item, done: { at: 1, id: "x", ...placed } })).toEqual({ text: raw });
    expect(applyFix(raw + TRAPS.plan + "\n", item)).toBeNull();
    expect(undoFix(raw, { ...item, done: { at: 1, id: "x", ...placed } })).toEqual({ error: "changed" });
  });
});

describe("what a fix takes as the owner's word", () => {
  const run = async (note: string, owner: string, quote: string, fix: string) => {
    const raw = SAFETY_MEMORY + note + "\n";
    const generate: NoteGenerator = async (prompt) => {
      const wrong = prompt.split(/(?=^PAIR$)/m).flatMap((block) => {
        const match = /^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) /m.exec(block);
        return match && match[2] === note ? [{ note: match[1]!, message: match[3]!, quote, fix }] : [];
      });
      return JSON.stringify({ wrong });
    };
    return (await checkWrong({ raw, rows: [row("evidence", time(24, 12), owner)], newest: { thread: "t1", id: "evidence", at: time(24, 12) }, ids: "ids", owned: [], saved: [], judges: { claude: generate, gemini: generate }, today: TODAY, signal: new AbortController().signal, now: Date.now })).items;
  };
  const listed = (items: Awaited<ReturnType<typeof run>>) => items.map((item) => item.listOnly);

  it("offers only a hand edit for a note with no stamp", async () => {
    expect(listed(await run("- The main account plan ends in January", "The main account plan now lasts till March instead.", "lasts till March", "- The main account plan ends in March"))).toEqual([true]);
  });

  it("takes no event day inside a note with no stamp as the day it was written", async () => {
    expect(listed(await run("- The studio tour on 2026-11-10 used the blue entrance", "The studio tour used the green entrance.", "used the green entrance", "- The studio tour on 2026-11-10 used the green entrance"))).toEqual([true]);
  });

  it("offers only a hand edit for a standing instruction", async () => {
    expect(listed(await run("- Use the blue theme for every screen (noted 2026-11-20)", "Use the green theme for every screen now.", "Use the green theme", "- Use the green theme for every screen (noted 2026-11-20)"))).toEqual([true]);
  });

  it("keeps a note about one day's event when the owner talks about another day's", async () => {
    expect(await run("- The studio tour on 2026-11-10 used the blue entrance (noted 2026-11-11)", "On 2026-11-24 the studio tour will use the green entrance.", "use the green entrance", "- The studio tour on 2026-11-10 used the green entrance (noted 2026-11-11)")).toEqual([]);
    const note = "- The studio tour on November 10 used the blue entrance (noted 2026-11-11)";
    const fix = note.replace("blue", "green");
    expect(await run(note, "For the November 24 studio tour use the green entrance.", "use the green entrance", fix)).toEqual([]);
    expect(await run(note, "The studio tour on 24 Nov will use the green entrance.", "use the green entrance", fix)).toEqual([]);
    expect(listed(await run(note, "The Nov. 10th studio tour used the green entrance.", "used the green entrance", fix))).toEqual([false]);
    const dated = "- The studio tour on November 10, 2026 used the blue entrance (noted 2026-11-11)";
    expect(await run(dated, "For the 10 Nov. 2025 studio tour we used the green entrance.", "used the green entrance", dated.replace("blue", "green"))).toEqual([]);
  });

  it("takes no words the owner quotes from someone else", async () => {
    const note = "- The main account plan ends in January (noted 2026-11-20)";
    expect(listed(await run(note, "The plan for the main account lasts till March now instead.", "lasts till March now", "- The main account plan ends in March (noted 2026-11-20)"))).toEqual([false]);
    expect(await run(note, 'My designer said "the plan for the main account lasts till March now" but I have not checked.', "lasts till March now", "- The main account plan ends in March (noted 2026-11-20)")).toEqual([]);
    expect(await run(note, "My designer said “it lasts till March” today.", "it lasts till March", "- The main account plan ends in March (noted 2026-11-20)")).toEqual([]);
    expect(await run(note, "The plan for the main account lasts till March now instead.", "it lasts until March", "- The main account plan ends in March (noted 2026-11-20)")).toEqual([]);
  });

  it("archives the quote as the owner typed it, not as a judge spelled it", async () => {
    const items = await run("- The main account plan ends in January (noted 2026-11-20)", "For the main account plan, It lasts  till March and that is my main account.", "it lasts till march", "- The main account plan ends in March (noted 2026-11-20)");
    expect(items.map((item) => [item.listOnly, item.evidence.quote])).toEqual([[false, "It lasts  till March"]]);
  });

  it("reads only the owner's typed rows in the bot's own chats", async () => {
    const { insertMessage, typedSince } = await import("./message-db.ts");
    const { ownerRows } = await import("./dream-wrong.ts");
    const { ownerChats } = await import("./one-mind.ts");
    // SAFETY: ownerChats reads only threadId and tasks' threadId.
    const chats = ownerChats({ threadId: "one", tasks: [{ threadId: "one" }, { threadId: "room-side" }, { threadId: "routine" }] } as never, new Set(["room-side", "routine"]));
    const base = { role: "user", kind: "text", at: 100, text: "An ordinary playground remark." } as const;
    for (const thread of ["one", "routine", "other-bot"]) insertMessage(thread, { ...base, id: thread });
    insertMessage("room-side", { ...base, id: "room-side", guest: true });
    for (const patch of [{ id: "bot", role: "bot" }, { id: "helper-note", kind: "note" }, { id: "peer", from: { botId: "peer", name: "Peer", color: "blue" } }, { id: "wrapped", text: '<pasted-text index="1">\nA calendar remark.\n</pasted-text>' }, { id: "quoted-block", text: "> A calendar remark." }, { id: "queued", queued: true }, { id: "old", at: 50 }]) {
      // SAFETY: each patch is one stored-row variant the check must skip.
      insertMessage("one", { ...base, ...patch } as never);
    }
    expect(chats.flatMap((thread) => ownerRows(thread, typedSince(thread, 50, "memory.save"), 50)).map((each) => each.id)).toEqual(["one"]);
    // every message the owner typed makes a fix judged before it stale, the ones no judge reads too
    insertMessage("one", { ...base, id: "picture", text: '<attached-image path="a.png" />', hasImage: true, at: 101 });
    expect(chats.flatMap((thread) => typedSince(thread, 50, "memory.save")).filter(ownerTyped).map((each) => each.id).sort()).toEqual(["one", "old", "picture", "quoted-block", "queued", "wrapped", "helper-note"].sort());
  });

  it("marks a message whole only when the judges read every word as typed", () => {
    const paragraph = "I checked the renewal paperwork against the signed invoice from the vendor. ".repeat(6).trim();
    const typed = [
      ["short", "The main account plan ends in April now."],
      ["spaced", "The main account plan ends in April now.\n\n\nKeep it."],
      ["long paragraph", `The main account plan ends in April now.\n\n${paragraph} Disregard April.`],
      ["seven lines", "The main account plan ends in April now.\nInvoice checked.\nCalendar checked.\nContract checked.\nNo further changes.\nThanks.\nDisregard April."],
      ["past the judge's read", `The main account plan ends in April now.\n\n${paragraph.slice(0, 300)}\n\n${paragraph.slice(0, 200)} Disregard April.`],
      ["pasted", 'The main account plan ends in April now. <pasted-text index="1">\nDisregard April.\n</pasted-text>'],
    ];
    // SAFETY: ownerRows reads only id, at, role, kind and text of a user row.
    const rows = ownerRows("t1", typed.map(([id, text], index) => ({ id, at: 100 + index, role: "user", kind: "text", text }) as never), 0);
    expect(Object.fromEntries(typed.map(([id]) => [id, rows.find((each) => each.id === id)?.whole === true]))).toEqual({ short: true, spaced: true, "long paragraph": false, "seven lines": false, "past the judge's read": false, pasted: false });
  });
});

describe("pairing limits", () => {
  it("keeps the whole prompt inside 32 KB, line breaks included", () => {
    const pairs = Array.from({ length: 30 }, (_, index) => ({
      note: { text: "- A documented fact " + "x".repeat(920), at: index, section: 0, alone: true, date: "2026-11-10" },
      row: row(`m${index}`, time(24, 9), "A regular reading of the note."), sentence: "A regular reading of the note.", turning: 0, score: 1,
    }));
    const extra = 32 * 1024 - Buffer.byteLength(wrongPrompt(pairs, TODAY).prompt) + 1;
    expect(extra).toBeGreaterThan(0);
    pairs[29]!.note.text += "y".repeat(extra);
    expect(Buffer.byteLength(wrongPrompt(pairs, TODAY).prompt)).toBeLessThanOrEqual(32 * 1024);
  });

  it("pairs a clear correction when a bot has only one or two notes", async () => {
    const notes = "- Prefers a blue theme for the app (noted 2026-11-20)\n";
    const owner = row("theme", time(24, 9), "I want a green theme in the app now, not blue.");
    const counts: number[] = [];
    for (const raw of [notes, notes + "- Prefers apple juice (noted 2026-11-21)\n", notes + "- Prefers apple juice (noted 2026-11-21)\n- Drinks tea (noted 2026-11-22)\n"]) counts.push((await wrongPairs(raw, fixTargets(raw), [owner])).length);
    expect(counts.every((count) => count > 0)).toBe(true);
  });
});


describe("a line proposes only without the old value", () => {
  const note = TRAPS.plan;
  const by = "- The main account's plan ends in April (noted 2026-11-20)";

  it.each([
    ["The main account's plan ends in January, not March or April.", false],
    ["It ends in April, not January.", false],
    ["The plan is billed monthly.", false],
    ["It ends in April now.", true],
  ])("lets %s propose: %s", (line, can) => {
    expect(proposes(note, by, line)).toBe(can);
  });

  it("never proposes a fix that changes no word of the note", () => {
    expect(proposes(TRAPS.rooms, "- ROOMS WORD (11-20): say groups, not rooms, and Group Details to them in every user-facing string.", "its called groups not rooms")).toBe(false);
  });

  // true fixes the rule holds back: each costs a missed fix, never a written one
  it.each([
    ["the old value said to turn it", "- Prefers the blue theme for the app (noted 2026-11-20)", "not the blue theme anymore, the green theme is the one for the app now", "the green theme is the one for the app now", "- Prefers the green theme for the app (noted 2026-11-20)"],
    ["X, not the old value", "- The app uses a blue theme (noted 2026-11-20)", "For the app theme use green, not blue, from now on.", "use green, not blue", "- The app uses a green theme (noted 2026-11-20)"],
    ["the old value named as wrong", note, "It's not January anymore, the main account plan ends in March.", "the main account plan ends in March", "- The main account's plan ends in March (noted 2026-11-20)"],
    ["the old note quoted to explain it", note, '"The main account\'s plan ends in January" is what I said. That is wrong. Keep the March correction.', "Keep the March correction", "- The main account's plan ends in March (noted 2026-11-20)"],
    ["a fix that keeps the old word", "- Calls them rooms in every string (noted 2026-11-20)", "its called groups not rooms we removed that name", "its called groups not rooms", "- Calls them groups, not rooms, in every string (noted 2026-11-20)"],
  ])("misses a true fix when the newest line holds %s", async (_, saved, owner, quote, fix) => {
    const raw = SAFETY_MEMORY + saved + "\n";
    const generate: NoteGenerator = async (prompt) => JSON.stringify({ wrong: [...prompt.matchAll(/^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) /gm)].filter((match) => match[2] === saved).map((match) => ({ note: match[1], message: match[3], quote, fix })) });
    expect((await checkWrong({ raw, rows: [row("evidence", time(24, 12), owner)], newest: { thread: "t1", id: "evidence", at: time(24, 12) }, ids: "ids", owned: [], saved: [], judges: { claude: generate, gemini: generate }, today: TODAY, signal: new AbortController().signal, now: Date.now })).items).toEqual([]);
  });
});

describe("the owner's newest message, by what the store holds", () => {
  const mark = (id: string, when: number, place: number, extra: Partial<StoredRow> = {}): StoredRow => ({ thread: "t1", id, at: when, row: place, role: "user", ...extra });
  const none = () => [];

  it("names it only when its time, its place in the store and every link agree", () => {
    const original = mark("original", 1000, 1);
    expect(newestOwned([original], none)).toEqual({ thread: "t1", id: "original", at: 1000 });
    expect(newestOwned([original, mark("reply", 1001, 2, { parentId: "original" })], none)?.id).toBe("reply");
    expect(newestOwned([original, mark("tie", 1000, 2)], none)).toBeUndefined();
    // a synced reply stamped 1.5 s earlier that the store took in later
    expect(newestOwned([original, mark("reply", -500, 2, { parentId: "original" })], none)).toBeUndefined();
    for (const link of ["parentId", "sentAfterId", "replyToId"] as const) expect(newestOwned([mark("reply", -500, 1, { [link]: "original" }), { ...original, row: 2 }], none)).toBeUndefined();
    expect(newestOwned([mark("later", -500, 1), { ...original, row: 2 }], () => ["bot-reply", "later"])).toBeUndefined();
    expect(newestOwned([mark("other", 900, 3, { thread: "t2" }), original], none)).toBeUndefined();
    expect(newestOwned([], none)).toBeUndefined();
  });

  it("names it only when no other message of the owner's, in any chat, is as new by when it was stored, stamped, acted on or counted", () => {
    const april = mark("april", 2000, 3, { actedAt: 2000, sendSeq: 2 });
    // the withdrawal reached the chat first, the April send held for after the turn landed last
    for (const withdraw of [{ actedAt: 2100, sendSeq: 3 }, { actedAt: 2100, sendSeq: 1 }, { actedAt: 1900, sendSeq: 3 }, { actedAt: 1900, sendSeq: 2 }, { actedAt: 2000, sendSeq: 1 }]) {
      for (const thread of ["t1", "t2"]) expect([withdraw, thread, newestOwned([mark("withdraw", 1500, 2, { thread, ...withdraw }), april], none)]).toEqual([withdraw, thread, undefined]);
    }
    // a peer's April pulled after a withdrawal stamped on a clock 1.5 s behind
    expect(newestOwned([mark("april", 2000, 2, { actedAt: 2000, sendSeq: 1 }), mark("withdraw", 500, 1, { thread: "t2", actedAt: 500, sendSeq: 1 })], none)).toBeUndefined();
    expect(newestOwned([mark("withdraw", 1500, 2, { actedAt: 1500 }), mark("april", 2000, 3)], none)).toBeUndefined();
    expect(newestOwned([mark("older", 1500, 2, { thread: "t2", actedAt: 1500, sendSeq: 1 }), april], none)?.id).toBe("april");
    // a row from before action times and send counts were kept is placed by the rest
    expect(newestOwned([mark("legacy", 1500, 2), april], none)?.id).toBe("april");
  });

  it("counts only what the owner typed", () => {
    const original = mark("original", 1000, 1);
    const others = [mark("peer", 2000, 2, { from: '{"botId":"peer"}' }), mark("guest", 2000, 3, { guest: 1 }), mark("routine", 2000, 4, { origin: "routine" }), mark("comm", 2000, 5, { comm: "{}" }), mark("bot", 2000, 6, { role: "bot" })];
    expect(newestOwned([original, ...others], none)?.id).toBe("original");
    expect(ownedIds([original, ...others])).toBe(ownedIds([original]));
  });

  it("names the exact set of the owner's messages, whatever their time or order", () => {
    const rows = [mark("a", 1000, 1), mark("b", 2000, 2), mark("c", 3000, 1, { thread: "t2" })];
    expect(ownedIds([...rows].reverse())).toBe(ownedIds(rows));
    expect(ownedIds([...rows, mark("synced", 10, 9)])).not.toBe(ownedIds(rows));
    expect(ownedIds([...rows, mark("tie", 3000, 9, { thread: "t2" })])).not.toBe(ownedIds(rows));
    expect(ownedIds(rows.slice(1))).not.toBe(ownedIds(rows));
    expect(ownedIds([...rows, mark("a", 1000, 3, { thread: "t3" })])).not.toBe(ownedIds(rows));
  });

  it("reads a synced reply stamped earlier as stored later and under the message it answers", async () => {
    const { insertMessage, rowsUnder, userMarks } = await import("./message-db.ts");
    const thread = "sync-order";
    const read = () => userMarks(thread).map((each) => ({ ...each, thread }));
    insertMessage(thread, { id: "original", at: 1000, role: "user", kind: "text", text: "The main account plan ends in April now.", parentId: null });
    insertMessage(thread, { id: "bot-reply", at: 1100, role: "bot", kind: "text", text: "Noted.", parentId: "original" });
    for (const patch of [{ id: "peer", from: { botId: "peer", name: "Peer", color: "blue" } }, { id: "guest", guest: true }, { id: "routine", origin: "routine" }]) {
      // SAFETY: each row is a stored-row variant the owner did not type.
      insertMessage(thread, { at: 5000, role: "user", kind: "text", text: "ok", ...patch } as never);
    }
    const before = read();
    expect(newestOwned(before, rowsUnder)).toEqual({ thread, id: "original", at: 1000 });
    insertMessage(thread, { id: "withdraw", at: 500, role: "user", kind: "text", text: "Disregard April and keep the saved date.", parentId: "bot-reply" });
    const after = read();
    expect(rowsUnder(thread, "original").sort()).toEqual(["bot-reply", "withdraw"]);
    expect(newestOwned(after, rowsUnder)).toBeUndefined();
    expect(ownedIds(after)).not.toBe(ownedIds(before));
  });

  it("reads when the owner acted and the send count from the store, so a held send that landed last is not the newest", async () => {
    const { insertMessage, rowsUnder, userMarks } = await import("./message-db.ts");
    const read = (thread: string) => userMarks(thread).map((each) => ({ ...each, thread }));
    for (const [thread, acted] of [["held-order", 900], ["held-control", 2100]] as const) {
      insertMessage(thread, { id: "withdraw", at: 1000, role: "user", kind: "text", text: "Disregard April and keep the saved date.", parentId: null, actedAt: 2000, sendSeq: acted > 2000 ? 1 : 2 });
      insertMessage(thread, { id: "april", at: 3000, role: "user", kind: "text", text: "The main account plan ends in April now.", parentId: "withdraw", actedAt: acted, sendSeq: acted > 2000 ? 2 : 1, waited: true });
    }
    expect(read("held-order").find((each) => each.id === "april")).toMatchObject({ actedAt: 900, sendSeq: 1 });
    expect(newestOwned(read("held-order"), rowsUnder)).toBeUndefined();
    expect(newestOwned(read("held-control"), rowsUnder)?.id).toBe("april");
  });
});

describe("what the judges read and agree on", () => {
  const note = TRAPS.plan;
  const raw = SAFETY_MEMORY + note + "\n";
  const april = note.replace("January", "April");
  const may = note.replace("January", "May");
  const withdrawn = "The main account plan ends in May now, after the April estimate was withdrawn.";
  const ask = async (owner: string, fixes: [string | null, string | null], quote = "The main account plan ends in May now", owned: StoredRow[] = []) => {
    const prompts: string[] = [];
    const judge = (fix: string | null): NoteGenerator => async (prompt) => {
      if (prompt.includes("<pairs>")) prompts.push(prompt);
      const wrong = fix === null ? [] : [...prompt.matchAll(/^PAIR\n(L\d+) \(written [^)]*\): ([^\n]+)\n(M\d+) /gm)].filter((match) => match[2] === note).map((match) => ({ note: match[1], message: match[3], quote, fix }));
      return JSON.stringify({ wrong });
    };
    // SAFETY: ownerRows reads only id, at, role, kind and text of a user row.
    const rows = ownerRows("t1", [{ id: "evidence", at: time(24, 12), role: "user", kind: "text", text: owner } as never], 0);
    const checked = await checkWrong({ raw, rows, newest: { thread: "t1", id: "evidence", at: time(24, 12) }, ids: "ids", owned, saved: [], judges: { claude: judge(fixes[0]), gemini: judge(fixes[1]) }, today: TODAY, signal: new AbortController().signal, now: Date.now });
    return { items: checked.items.map((item) => item.by), prompts };
  };

  it("lists nothing once the owner wrote in another chat since the note, whatever its time or order", async () => {
    const plain = "The main account plan ends in May now.";
    const mark = (id: string, thread: string, when: number, extra: Partial<StoredRow> = {}): StoredRow => ({ thread, id, at: when, row: 1, role: "user", ...extra });
    const evidence = mark("evidence", "t1", time(24, 12), { row: 9, actedAt: time(24, 12), sendSeq: 9 });
    // a peer's withdrawal stamped on a clock behind, stored before, counted lower
    for (const when of [time(24, 11, 59), time(20, 0), time(25, 9)]) expect([when, (await ask(plain, [may, may], undefined, [evidence, mark("withdraw", "t2", when, { actedAt: when, sendSeq: 1 })])).items]).toEqual([when, []]);
    expect((await ask(plain, [may, may], undefined, [evidence, mark("before", "t2", time(19, 23))])).items).toEqual([may]);
    expect((await ask(plain, [may, may], undefined, [evidence, mark("earlier", "t1", time(24, 11))])).items).toEqual([may]);
    expect((await ask(plain, [may, may], undefined, [evidence, mark("peer", "t2", time(24, 11), { from: '{"botId":"peer"}' })])).items).toEqual([may]);
  });

  it("reads a message whole only when every line reaches the judges byte for byte", async () => {
    const lines = (value: string) => `The main account plan ends in the month below now.\n\n${value}\n\nKeep it.`;
    for (const indent of [" ", "  ", "    ", "\t"]) expect([indent, (await ask(lines(`${indent}May`), [may, may], "The main account plan ends in")).items]).toEqual([indent, []]);
    expect((await ask(lines("May"), [may, may], "The main account plan ends in")).items).toEqual([may]);
    expect((await ask(lines("May").replace("\n\nKeep", "\n \n\nKeep"), [may, may], "The main account plan ends in")).items).toEqual([may]);
  });

  it("lists a fix only when the value it puts in reads as the owner typed it, case aside", async () => {
    const quote = "The main account plan ends in May";
    const owner = "The main account plan ends in May with Team  Files now.";
    const [two, one] = ["Team  Files", "Team Files"].map((each) => may.replace("May", `May with ${each}`));
    expect((await ask(owner, [one, one], quote)).items).toEqual([]);
    expect((await ask(owner, [two, two], quote)).items).toEqual([two]);
    expect((await ask(owner.toLowerCase(), [two, two], quote.toLowerCase())).items).toEqual([two]);
  });

  it("lists a fix only when both judges name the same new line", async () => {
    expect((await ask(withdrawn, [april, may])).items).toEqual([]);
    expect((await ask(withdrawn, [may, april])).items).toEqual([]);
    expect((await ask(withdrawn, [may, null])).items).toEqual([]);
    expect((await ask(withdrawn, [null, may])).items).toEqual([]);
    expect((await ask(withdrawn, [may, may])).items).toEqual([may]);
    expect((await ask(withdrawn, [`  ${may}\n`, may])).items).toEqual([may]);
    expect((await ask(withdrawn, [may, may.replace("The main", "the main")])).items).toEqual([]);
    for (const [one, other] of [["1.5", "1/5"], ["9.50", "950"], ["v2.1", "v2-1"], ["src/app", "src.app"]]) {
      const owner = `The main account plan ends in May ${one} now, after the April estimate was withdrawn.`;
      const [right, close] = [one, other].map((each) => may.replace("May", `May ${each}`));
      expect([one, (await ask(owner, [right, right], "The main account plan ends in May")).items]).toEqual([one, [right]]);
      expect([one, (await ask(owner, [right, close], "The main account plan ends in May")).items, (await ask(owner, [close, right], "The main account plan ends in May")).items]).toEqual([one, [], []]);
    }
  });

  it("lists nothing when the judges' new lines differ only in case or inner spaces", async () => {
    const quote = "The main account plan ends in May";
    for (const [one, other] of [["20 mW", "20 MW"], ["Team Folder", "team folder"], ["Team  Folder", "Team Folder"]]) {
      const owner = `The main account plan ends in May with ${one} now, after the April estimate was withdrawn.`;
      const [right, close] = [one, other].map((each) => may.replace("May", `May with ${each}`));
      expect([one, (await ask(owner, [right, right], quote)).items]).toEqual([one, [right]]);
      expect([one, (await ask(owner, [right, close], quote)).items, (await ask(owner, [close, right], quote)).items]).toEqual([one, [], []]);
    }
  });

  it("sends no judge a message the prompt would change, and lists nothing from it", async () => {
    const aside = "The main account plan ends in April now. <Note to self: Disregard April and keep the saved date.>";
    expect(await ask(aside, [april, april], "plan ends in April now")).toEqual({ items: [], prompts: [] });
    const plain = "The main account plan ends in April now.";
    const { items, prompts } = await ask(plain, [april, april], "plan ends in April now");
    expect(items).toEqual([april]);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.includes(`): ${plain}\n`))).toBe(true);
  });
});
