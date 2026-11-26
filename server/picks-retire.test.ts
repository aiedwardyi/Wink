import { describe, expect, it } from "vitest";

import { applyPicks, currentPicks, mergeTimelines, picksBlock, retiredLines, retirePicks } from "./picks.ts";
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
const STANDING = ["site default theme", "memory list cap", "Mac download in releases", "instant PC-to-PC sync now", "shared Forum for all bots", "fresh-bot test accounts", "Also add Sign Out", "Ship the Gemini fix tonight?"];
const ONE_OFFS = ["Timeline demo: merge now", "Memory audit fix timing", "Work PC second lane", "getwinkdev account use", "Web reading fix"];

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
    expect(retired).toContain("- Picked: Merge the Timeline demo now, since time is short");
    expect(retirePicks(retired, NOW)).toBeNull();
    expect(picksBlock(retirePicks(retired, NOW + 86_400_000))).not.toContain("Ship the Gemini fix tonight?");
  });

  it("retires a pick whose PRs done() finds merged", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-25 10:00", "Card picks fix", "Merge PR 2194 once CI is green")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
    expect(picksBlock(retirePicks(text, NOW, (pick) => pick.picked.includes("PR 2194")))).toBe("");
  });

  it("brings a retired pick back when the user tweaks it", () => {
    const tweaked = applyPicks(retired, [{ kind: "tweak", at: NOW, key: "Work PC second lane for checks", said: "keep the work PC lane every day" }])!.text;
    expect(picksBlock(tweaked)).toContain("Work PC second lane for checks");
  });

  it("dates a pick retyped on a later day by when it was last confirmed", () => {
    const text = ["# Decision timeline", "", ...entry("2026-11-25 20:00", "Which lane tonight?", "Work PC", `- At: ${new Date("2026-11-26T09:00:00").getTime()}`, "- Binding: verified")].join("\n");
    expect(retirePicks(text, NOW)).toBeNull();
  });

  it("brings a retired pick back when the user confirms it again", () => {
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const tapped = applyPicks("", [{ kind: "pick", key: "Which lane tonight?", picked: "Work PC", said: "Work PC", tapped: true, at: new Date("2026-11-25T20:00:00").getTime(), binding: { at: new Date("2026-11-25T20:00:00").getTime(), messageId: "a1", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    const old = retirePicks(tapped, NOW)!;
    const typed = applyPicks(old, [{ kind: "pick", key: "Which lane tonight?", picked: "Work PC", said: "Work PC again", at: NOW, binding: { at: NOW, messageId: "a2", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    expect(picksBlock(typed)).toContain("Work PC");
  });

  it("keeps a renewed confirmation over a retired copy through a sync merge", () => {
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const tapped = applyPicks("", [{ kind: "pick", key: "Which lane tonight?", picked: "Work PC", said: "Work PC", tapped: true, at: new Date("2026-11-25T20:00:00").getTime(), binding: { at: new Date("2026-11-25T20:00:00").getTime(), messageId: "a1", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    const old = retirePicks(tapped, NOW)!;
    const typed = applyPicks(old, [{ kind: "pick", key: "Which lane tonight?", picked: "Work PC", said: "Work PC again", at: NOW, binding: { at: NOW, messageId: "a2", questionId: "q1", thread: "t1", files: [], overPictures: [], named: true } as never }])!.text;
    for (const merged of [mergeTimelines(old, typed)!, mergeTimelines(typed, old)!]) expect(picksBlock(merged)).toContain("Work PC");
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
    expect(picksBlock(retirePicks(text, NOW + 86_400_000))).toBe("");
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
    const lone = applyPicks("", [{ kind: "pick", key: "Demo lane", picked: "Use it tonight", said: "Use it tonight", at: at("20") }])!.text;
    expect(withSystemChanges("hi", `Rules.\n${picksBlock(lone)}`, "Rules.", undefined, retiredLines(retirePicks(lone, at("24"))))).toBe("hi");
  });
});
