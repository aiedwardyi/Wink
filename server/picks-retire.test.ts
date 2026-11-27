import { describe, expect, it } from "vitest";

import { applyPicks, currentPicks, mergeTimelines, picksBlock, retiredLines, retireProof, retirePicks, TURN_WORDS } from "./picks.ts";
import { withSystemChanges } from "./turn-context.ts";

const NOW = new Date("2026-11-26T12:00:00").getTime();
const entry = (id: string, key: string, picked: string, ...rest: string[]) => [`## ${id} | ${key} | current`, `- Picked: ${picked}`, ...rest, ""];
// real picks from a teacher bot's decisions.md
const TIMELINE = [
  "# Decision timeline",
  "",
  ...entry("2026-11-19 00:31", "site default theme", "Samurai Ink, not Warp", '- Said: "i change my mind i want samurai , because it flows better towards bottom"'),
  ...entry("2026-11-19 11:26", "memory list cap", "No cap: every live ask stays in memory", '- Said: "so our memory will be through the roof now AS INTENDED the wohle purpose of the list"'),
  ...entry("2026-11-23 15:36", "Mac download in releases", "Yes - $99/yr Apple developer account (my pick)", "- Over: Not now", '- Said: "Yes, $99 (my pick)"'),
  ...entry("2026-11-18 18:09", "instant PC-to-PC sync now", "Yes - build it now", '- Tweak 2026-11-18 19:42: "to a user it should be same as how chats work in terms of sync"'),
  ...entry("2026-11-22 20:29", "shared Forum for all bots", "Park it for now"),
  ...entry("2026-11-25 16:20", "fresh-bot test accounts", "up.codex.today and getwinkdev subs"),
  ...entry("2026-11-24 20:31", "Also add Sign Out to Settings → Account? Right now it's o...", "Settings only, top right (my pick)", "- Tapped: yes"),
  ...entry("2026-11-19 15:03", "Timeline demo: merge now", "Merge the Timeline demo now, since time is short"),
  ...entry("2026-11-18 17:32", "Memory audit fix timing", "Yes - fix tonight, in tonight's 21:00 update"),
  ...entry("2026-11-18 12:30", "Work PC second lane for checks", "Yes - after 13:30"),
  ...entry("2026-11-20 11:31", "getwinkdev account use", "Burn getwinkdev 1% leftover, grind hard, then use reset", '- Tweak 2026-11-25 09:17: "Also use the getwinkdev abd rocknblock subs asap. They expire today"'),
  ...entry("2026-11-23 13:39", "Web reading fix needs one more round (~1-2 h). Release 1....", "Yes, release now (my pick)", "- Tapped: yes"),
  ...entry("2026-11-26 09:10", "Ship the Gemini fix tonight?", "Yes (my pick)", "- Tapped: yes"),
].join("\n");
const STANDING = ["site default theme", "memory list cap", "Mac download in releases", "instant PC-to-PC sync now", "shared Forum for all bots", "fresh-bot test accounts", "Also add Sign Out", "Ship the Gemini fix tonight?", "Timeline demo: merge now", "Memory audit fix timing", "Work PC second lane", "getwinkdev account use"];
const ONE_OFFS = ["Web reading fix"];
const WEB_FIX = "Web reading fix needs one more round (~1-2 h). Release 1....";
const VERBS = ["run", "send", "ship", "deploy", "merge", "release", "publish", "post", "build", "fix", "push", "restart", "update", "test", "check", "clean", "delete", "review", "start", "do"];
const ANCHORS: [string, 0 | 1][] = [["now", 0], ["right now", 0], ["today", 0], ["tonight", 0], ["this morning", 0], ["this afternoon", 0], ["this evening", 0], ["tomorrow", 1], ["tomorrow morning", 1], ["tomorrow night", 1]];
const KEEP: string[] = [
  // gate A to I wordings
  "Every day after 13:30", "Yes", "Wait, ping me (my pick)", "Wait for my approval", "Always require approval", "Deploy only after it merges",
  "Not now, wait for my approval", "Never page me after 18:00", "Hold until I confirm", "Wait for a manual release",
  "From today, use dark mode as the default", "Use the sign-in flow from PR #41 as the default", "Hold for signoff on PR #43", "Not now, ship next week", "Ship next Friday, not today",
  "Use the layout from PR #41 for all new workspaces", "Send the survey one week after today", "Send the survey two weeks from today",
  "Send the finished release notes to everyone on the project mailing list and include the updated schedule, but wait for my approval before sending.",
  "A - Send the release notes, but wait for my approval before sending.", "A - Send the release notes", "C#", "Ship with PR #41", "Release on merge",
  "After PR #41 and #42 merge", "After PR 41 and PR 43 merge", "Close it once PR #41 merges", "Close the beta task after PR #41 and PR #43 merge",
  // the teacher's own picks
  '175 MB cap today - "175 MB is faster" pick, recommended', "Start now - follow-up starts today, not 11-20", "Yes - build the timeline canvas once tonight's update is out",
  "Merge the Timeline demo now, since time is short", "Yes - fix tonight, in tonight's 21:00 update", "Yes - after 13:30", "Park it for now", "Samurai Ink, not Warp",
  "Yes - $99/yr Apple developer account (my pick)", "up.codex.today and getwinkdev subs", "Yes (my pick)", "Build it (my pick)", "Merge + deploy (my pick)",
  "Also use the getwinkdev abd rocknblock subs asap. They expire today", "Use dark mode from today onward", "Use the home server starting today", "Start using dark mode today",
  // outside the grammar
  "Fix the one two three four five six tonight", "Run the 2 checks tonight", "Run the sign-in checks tonight", "Run tonight's checks", "Tonight, then again tomorrow", "오늘 밤",
  "Merge PR 41 and 42", "Merge PR #41 tonight", "Merge PR #41 after #42", "Merge it after PR #41", "Land the fix",
];
const DUE: [string, 0 | 1][] = [
  ["Tonight", 0], ["Run the checks tonight", 0], ["Review the release notes tonight", 0], ["Build the Forum rename and text fixes now", 0], ["Yes, release now (my pick)", 0], ["Yes - build it now", 0],
  ["B - Tonight.", 0], ["Tonight (my pick)", 0], ["tonight!", 0], ["Option C: run the checks tomorrow night", 1], ["OK, deploy tomorrow morning", 1], ["Go ahead - ship it this evening", 0],
  ["Do it now", 0], ["Sure: fix it right now", 0], ["Fix the one two three four five tonight", 0], ["Tomorrow", 1],
];
const MERGES: [string, { repo?: string; number: number }[]][] = [
  ["Merge PR #41", [{ number: 41 }]], ["Merge PR #41 and #42", [{ number: 41 }, { number: 42 }]], ["Merge PR 2194 once CI is green", [{ number: 2194 }]], ["Yes, merge PR 2194", [{ number: 2194 }]],
  ["Merge PR #41 after review", [{ number: 41 }]], ["Merge PR #41 and PR #43", [{ number: 41 }, { number: 43 }]], ["Merge PR #41 and #41", [{ number: 41 }]],
  ["Yes, merge PR #41, #42 + acme/web#7", [{ number: 41 }, { number: 42 }, { repo: "acme/web", number: 7 }]],
  ["Ship https://github.com/Acme/Web/pull/9 when checks pass", [{ repo: "acme/web", number: 9 }]], ["B - Land #12 (my pick)", [{ number: 12 }]],
];

describe("retiring finished one-off picks", () => {
  const retired = retirePicks(TIMELINE, NOW)!;

  it("takes dated one-offs past their day out of the block and keeps standing rules in full", () => {
    const block = picksBlock(retired);
    for (const key of STANDING) expect(block).toContain(key);
    for (const key of ONE_OFFS) expect(block).not.toContain(key);
    expect(block).toContain("- memory list cap (11-19): No cap: every live ask stays in memory");
  });

  it("keeps each retired pick on file, marked with the day", () => {
    expect(currentPicks(retired).filter((pick) => pick.retired).map((pick) => [pick.key, pick.retired])).toEqual(ONE_OFFS.map((key) => [expect.stringContaining(key), "2026-11-26"]));
    expect(retired.match(/^- Retired: 2026-11-26$/gm)).toHaveLength(ONE_OFFS.length);
    expect(retired).toContain("- Picked: Yes, release now (my pick)");
    expect(retirePicks(retired, NOW)).toBeNull();
    // the question's "tonight" never dates the answer
    expect(retirePicks(retired, NOW + 86_400_000)).toBeNull();
  });

  it("retires a pick whose PRs done() finds merged", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-25 10:00", "Card picks fix", "Merge PR 2194 once CI is green")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
    expect(picksBlock(retirePicks(text, NOW, (_, prs) => prs.some(({ number }) => number === 2194)))).toBe("");
  });

  it("brings a retired pick back when the user tweaks it", () => {
    const tweaked = applyPicks(retired, [{ kind: "tweak", at: NOW, key: WEB_FIX, said: "keep a release lane every day" }])!.text;
    expect(picksBlock(tweaked)).toContain("keep a release lane every day");
  });

  it("dates a pick retyped on a later day by when it was last confirmed", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-25 20:00", "Which lane?", "Run the checks tonight", `- At: ${new Date("2026-11-26T09:00:00").getTime()}`, "- Binding: verified")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
  });

  it("brings a retired pick back when the user confirms it again", () => {
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const tapped = applyPicks("", [{ kind: "pick", key: "Which lane?", picked: "Run the checks tonight", said: "Run the checks tonight", tapped: true, at: new Date("2026-11-25T20:00:00").getTime(), binding: { at: new Date("2026-11-25T20:00:00").getTime(), messageId: "a1", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    const old = retirePicks(tapped, NOW)!;
    const typed = applyPicks(old, [{ kind: "pick", key: "Which lane?", picked: "Run the checks tonight", said: "Run the checks tonight again", at: NOW, binding: { at: NOW, messageId: "a2", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    expect(picksBlock(typed)).toContain("Run the checks tonight");
  });

  it("keeps a renewed confirmation over a retired copy through a sync merge", () => {
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const tapped = applyPicks("", [{ kind: "pick", key: "Which lane?", picked: "Run the checks tonight", said: "Run the checks tonight", tapped: true, at: new Date("2026-11-25T20:00:00").getTime(), binding: { at: new Date("2026-11-25T20:00:00").getTime(), messageId: "a1", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    const old = retirePicks(tapped, NOW)!;
    const typed = applyPicks(old, [{ kind: "pick", key: "Which lane?", picked: "Run the checks tonight", said: "Run the checks tonight again", at: NOW, binding: { at: NOW, messageId: "a2", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    for (const merged of [mergeTimelines(old, typed)!, mergeTimelines(typed, old)!]) expect(picksBlock(merged)).toContain("Run the checks tonight");
  });

  it("keeps a choice that starts today rather than ends today", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-25 10:00", "Theme", "Use dark mode from today onward"), ...entry("2026-11-25 11:00", "Server", "Use the home server starting today")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
  });

  it("keeps a recurring card whose recurrence comes before what it asks", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-25 10:00", "Daily backups. Which server after 13:30?", "Home server", "- Tapped: yes")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
  });

  it("dates a pick that chose tomorrow by that day", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-25 10:00", "Ship today or tomorrow?", "Tomorrow", "- Tapped: yes")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
    expect(picksBlock(retirePicks(text, NOW + 86_400_000)!)).toBe("");
  });

  it("lands a tweak keyed like a revised card answer on the card's pick", () => {
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const first = applyPicks("", [{ kind: "pick", key: "Which theme?", picked: "Dark", said: "Dark", tapped: true, at: NOW - 60_000, binding: { at: NOW - 60_000, messageId: "a1", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    const out = applyPicks(first, [{ kind: "pick", key: "Theme", picked: "Light", said: "Light", at: NOW, binding: { at: NOW, messageId: "a2", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }, { kind: "tweak", key: "Theme", said: "Keep the header small", at: NOW }])!;
    expect(out.tweaks).toBe(1);
    expect(picksBlock(out.text)).toContain("Keep the header small");
  });

  it("dates tomorrow by the calendar across a clock change", () => {
    // deleting TZ keeps the last zone on Windows, so put back the one in force
    const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "America/New_York";
    try {
      const at = new Date("2026-11-01T00:30:00").getTime();
      const text = ["# Decision timeline", "", ...entry("2026-11-01 00:30", "Ship today or tomorrow?", "Tomorrow", `- At: ${at}`, "- Binding: verified")].join("\n");
      expect(retirePicks(text, new Date("2026-11-02T12:00:00").getTime())).toBeNull();
    } finally {
      process.env.TZ = zone;
    }
  });

  it("judges the day by the chosen answer, never the question or an option it beat", () => {
    const text = ["# Decision timeline", "",
      ...entry("2026-11-24 10:00", "update now or wait for helpers", "Wait, ping me (my pick)", "- Over: Update now, restart them", "- Tapped: yes"),
      ...entry("2026-11-24 10:01", "Deploy today or wait for my approval?", "Wait for my approval", "- Tapped: yes"),
      ...entry("2026-11-24 10:02", "When should we package the beta?", "Tonight", "- Tapped: yes"),
    ].join("\n");
    expect(currentPicks(retirePicks(text, NOW)).filter((pick) => pick.retired).map(({ picked }) => picked)).toEqual(["Tonight"]);
  });

  it("keeps a standing rule a merged PR starts", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-24 10:00", "Which release rule takes effect after PR #41 merges?", "Always require approval", "- Tapped: yes")].join("\n");
    expect(retirePicks(text, NOW, () => true)).toBeNull();
  });

  it("keeps a dated pick while a PR it waits on is open", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-24 10:00", "Deploy after PR #42 merges?", "Deploy tonight once PR #42 merges", "- Tapped: yes"), ...entry("2026-11-24 10:01", "Merge?", "Merge PR #42", "- Tapped: yes")].join("\n");
    expect(retirePicks(text, NOW, () => null)).toBeNull();
  });

  it("dates a pick by its newest tweak even when an older one landed after it", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-24 10:00", "Release checks", "Run the checks", '- Tweak 2026-11-26 09:00: "Move this to next week"', '- Tweak 2026-11-25 09:00: "Run it tonight"')].join("\n");
    expect(retirePicks(text, NOW + 86_400_000)).toBeNull();
  });

  it("numbers a second card's colliding key within the key limit, so a tweak by that key finds it", () => {
    const key = "For the upcoming release, which signing service should we use for the beta builds?";
    const tap = (questionId: string, messageId: string, picked: string, at: number) => ({ kind: "pick" as const, at, key, picked, said: picked, tapped: true, binding: { at, messageId, questionId, thread: "t1", files: [], overPictures: [], named: true } as never });
    const two = applyPicks("", [tap("q1", "a1", "Local signing", NOW), tap("q2", "a2", "Cloud signing", NOW + 60_000)])!.text;
    const second = currentPicks(two).find(({ picked }) => picked === "Cloud signing")!;
    expect(second.key.length).toBeLessThanOrEqual(60);
    const tweaked = applyPicks(two, [{ kind: "tweak", at: NOW + 120_000, key: second.key, said: "use the EV certificate" }])!.text;
    expect(currentPicks(tweaked).map(({ picked, tweaks }) => [picked, tweaks.map(({ said }) => said)])).toEqual([["Local signing", []], ["Cloud signing", ["use the EV certificate"]]]);
  });

  it("keeps a standing default, a hold and a postponement, whatever day it names or PR merged", () => {
    const text = ["# Decision timeline", "",
      ...entry("2026-11-24 10:00", "Which theme should new sites use?", "From today, use dark mode as the default", "- Tapped: yes"),
      ...entry("2026-11-24 10:01", "Which sign-in flow belongs in new workspaces?", "Use the sign-in flow from PR #41 as the default", "- Tapped: yes"),
      ...entry("2026-11-24 10:02", "What do we do about release signoff?", "Hold for signoff on PR #43", "- Tapped: yes"),
      ...entry("2026-11-24 10:03", "Release timing", "Not now, ship next week"),
      ...entry("2026-11-24 10:04", "Launch timing", "Ship next Friday, not today"),
    ].join("\n");
    expect(retirePicks(text, NOW, () => true)).toBeNull();
  });

  it("retires a one-off once its day passed or every PR its answer names merged", () => {
    const text = ["# Decision timeline", "",
      ...entry("2026-11-24 10:00", "When should we archive the demo?", "Tonight", "- Tapped: yes"),
      ...entry("2026-11-24 10:01", "When do we close the beta task?", "Merge PR #41 and PR #43", "- Tapped: yes"),
      ...entry("2026-11-24 10:02", "Which test accounts?", "up.codex.today and getwinkdev subs"),
      ...entry("2026-11-24 10:03", "When do we close the release task?", "Close the beta task after PR #41 and PR #43 merge", "- Tapped: yes"),
    ].join("\n");
    expect(currentPicks(retirePicks(text, NOW, () => true)).filter((pick) => pick.retired).map(({ picked }) => picked)).toEqual(["Tonight", "Merge PR #41 and PR #43"]);
  });

  it("dates a pick confirmed again after its last tweak by the confirmation", () => {
    const first = new Date("2026-11-25T10:00:00").getTime();
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const bound = (messageId: string, at: number) => ({ at, messageId, questionId: "q1", thread: "t1", files: [], overPictures: [], named: true }) as never;
    const key = "When should we run checks?";
    const picked = "Run the checks tonight";
    const initial = applyPicks("", [{ kind: "pick", at: first, key, picked, said: picked, tapped: true, binding: bound("a1", first) }, { kind: "tweak", at: first + 60_000, key, said: "Run the signing checks tonight" }])!.text;
    const archived = retirePicks(initial, NOW)!;
    expect(picksBlock(archived)).toBe("");
    const confirmed = applyPicks(archived, [{ kind: "pick", at: NOW, key, picked, said: picked, binding: bound("a2", NOW) }])!.text;
    expect(picksBlock(retirePicks(confirmed, NOW) ?? confirmed)).toContain(picked);
    expect(picksBlock(retirePicks(confirmed, NOW + 86_400_000)!)).toBe("");
  });

  it("renews a tap when the user taps the same option on its card again", () => {
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const tap = (messageId: string, at: number) => ({ kind: "pick" as const, at, key: "When should we run checks?", picked: "Tonight", said: "Tonight", tapped: true, binding: { at, messageId, questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never });
    const archived = retirePicks(applyPicks("", [tap("a1", NOW - 2 * 86_400_000)])!.text, NOW)!;
    const renewed = applyPicks(archived, [tap("a2", NOW)])!.text;
    expect(currentPicks(renewed).map(({ picked, retired }) => [picked, retired])).toEqual([["Tonight", undefined]]);
    expect(retirePicks(renewed, NOW)).toBeNull();
  });

  it("never retires a recurring instruction, whatever time it names", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-20 10:00", "When should alerts go to the backup?", "Every day after 13:30", "- Tapped: yes")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
  });

  it("keeps a newer tweak over an older retirement through a sync merge", () => {
    const old = retirePicks(["# Decision timeline", "", ...entry("2026-11-20 12:00", "Extra checks", "Run tonight")].join("\n"), NOW - 5 * 86_400_000)!;
    const revived = applyPicks(old, [{ kind: "tweak", at: NOW - 4 * 86_400_000, key: "Extra checks", said: "Keep these checks every week" }])!.text;
    const other = applyPicks(old, [{ kind: "pick", at: NOW - 4 * 86_400_000, key: "Theme", picked: "Dark", said: "Dark" }])!.text;
    for (const merged of [mergeTimelines(revived, other)!, mergeTimelines(other, revived)!]) {
      expect(picksBlock(merged)).toContain("Keep these checks every week");
      expect(picksBlock(merged)).toContain("Dark");
    }
  });

  it("keeps the mark through a sync merge", () => {
    expect(currentPicks(mergeTimelines(retired, TIMELINE)!).filter((pick) => pick.retired)).toHaveLength(ONE_OFFS.length);
  });

  it("never tells a resumed session a retired pick no longer applies", () => {
    const delivered = `Rules.\n\n${picksBlock(TIMELINE)}`;
    const system = `Rules.\n\n${picksBlock(retired)}`;
    expect(withSystemChanges("hi", delivered, system)).toContain("[Removed:]");
    expect(withSystemChanges("hi", delivered, system, undefined, retiredLines(retired))).toBe("hi");
    const added = applyPicks(retired, [{ kind: "pick", at: NOW, key: "site accent", picked: "Neon pink", said: "Neon pink" }])!.text;
    const update = withSystemChanges("hi", delivered, `Rules.\n\n${picksBlock(added)}`, undefined, retiredLines(added))!;
    expect(update).toContain("[Added:]");
    expect(update).not.toContain("[Removed:]");
  });

  it("stays quiet for a session that got the pick before its last tweak", () => {
    const at = (day: string) => new Date(`2026-11-${day}T09:00:00`).getTime();
    const first = applyPicks("", [{ kind: "pick", key: "Branch cleanup", picked: "Clean old release branches", said: "Clean old release branches", at: at("22") }, { kind: "pick", key: "Default theme", picked: "Dark", said: "Dark", at: at("22") + 600_000 }])!.text;
    const tweaked = applyPicks(first, [{ kind: "tweak", key: "Branch cleanup", said: "Run it tonight", at: at("23") }])!.text;
    const retired = retirePicks(tweaked, at("24"))!;
    expect(withSystemChanges("hi", `Rules.\n${picksBlock(first)}`, `Rules.\n${picksBlock(retired)}`, undefined, retiredLines(retired))).toBe("hi");
  });

  it("sends no removal for the block header when the last pick retires", () => {
    const at = (day: string) => new Date(`2026-11-${day}T09:00:00`).getTime();
    const lone = applyPicks("", [{ kind: "pick", key: "Demo lane", picked: "Run it tonight", said: "Run it tonight", at: at("20") }])!.text;
    expect(withSystemChanges("hi", `Rules.\n${picksBlock(lone)}`, "Rules.", undefined, retiredLines(retirePicks(lone, at("24"))))).toBe("hi");
  });
});

describe("the retire proof", () => {
  it.each(KEEP)("keeps %j", (words) => {
    expect(retireProof(words)).toBeNull();
  });

  it.each(DUE)("dates %j", (words, dueIn) => {
    expect(retireProof(words)).toEqual({ dueIn });
  });

  it.each(MERGES)("merges %j", (words, prs) => {
    expect(retireProof(words)).toEqual({ prs });
  });

  it.each(ANCHORS)("dates %j alone and after each verb", (anchor, dueIn) => {
    for (const words of [anchor, `yes, ${anchor}`, ...VERBS.map((verb) => `${verb} it ${anchor}`)]) expect(retireProof(words)).toEqual({ dueIn });
  });

  it("keeps a short one-off that holds any turn word", () => {
    for (const word of ["not", "no", "never", "until", "after", "before", "if", "once", "when", "from", "every", "each", "next", "later", "week", "weeks", "month", "months", "day", "days", "wait", "hold"]) expect(TURN_WORDS).toContain(word);
    expect(retireProof("Run the checks tonight")).toEqual({ dueIn: 0 });
    for (const word of TURN_WORDS) {
      expect(retireProof(`Run the ${word} checks tonight`)).toBeNull();
      expect(retireProof(`Ship it ${word} now`)).toBeNull();
    }
  });
});

describe("retiring only on proof", () => {
  const timeline = (...entries: string[][]) => ["# Decision timeline", "", ...entries.flat()].join("\n");
  const retiredOf = (text: string | null) => currentPicks(text).filter((pick) => pick.retired).map(({ picked }) => picked);

  it("keeps a standing cap that names today", () => {
    const text = timeline(entry("2026-11-18 11:00", "Memory leak cap size", '175 MB cap today - "175 MB is faster" pick, recommended'));
    expect(retirePicks(text, NOW, () => true)).toBeNull();
  });

  it("keeps a task due after today, and a choice that merely cites a merged PR", () => {
    const text = timeline(
      entry("2026-11-26 10:00", "When should the survey go out?", "Send the survey one week after today", "- Tapped: yes"),
      entry("2026-11-24 10:00", "Which layout for new workspaces?", "Use the layout from PR #41 for all new workspaces", "- Tapped: yes"),
    );
    expect(retirePicks(text, NOW + 86_400_000, () => true)).toBeNull();
  });

  it("retires a merge once its PR merged, whatever it waited on", () => {
    const text = timeline(entry("2026-11-24 10:00", "When should we merge?", "Merge PR #41 after review", "- Tapped: yes"));
    expect(retiredOf(retirePicks(text, NOW, () => true))).toEqual(["Merge PR #41 after review"]);
  });

  it("asks done() about every PR the answer lists, since the answer was given", () => {
    const seen: unknown[] = [];
    const text = timeline(entry("2026-11-24 10:00", "Merge?", "Merge PR #41 and #42", "- Tapped: yes"), entry("2026-11-24 10:01", "Release?", "Release after PR #43 merges"));
    expect(retirePicks(text, NOW, (pick, prs, since) => (seen.push([pick.key, prs, since]), null))).toBeNull();
    expect(seen).toEqual([["Merge?", [{ number: 41 }, { number: 42 }], new Date("2026-11-24T10:00").getTime()]]);
  });

  it("proves from a newer tweak alone, so one without proof keeps a dated pick", () => {
    const text = timeline(entry("2026-11-24 10:00", "Checks", "Run the checks tonight", '- Tweak 2026-11-24 11:00: "include the signing checks"'));
    expect(retirePicks(text, NOW)).toBeNull();
    const merge = timeline(entry("2026-11-24 10:00", "Merge?", "Merge PR #41", '- Tweak 2026-11-24 11:00: "also deploy it to staging"'));
    expect(retirePicks(merge, NOW, () => true)).toBeNull();
  });

  it("never proves from the question or an option the answer beat", () => {
    const text = timeline(
      entry("2026-11-24 10:00", "Run the checks tonight?", "Yes", "- Over: Run them tonight", "- Tapped: yes"),
      entry("2026-11-24 10:01", "Merge PR #41 now?", "Sure (my pick)", "- Over: Merge PR #41", "- Tapped: yes"),
    );
    expect(retirePicks(text, NOW, () => true)).toBeNull();
  });
});
