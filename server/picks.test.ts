import { describe, expect, it } from "vitest";

import { applyPicks, currentOnly, currentPicks, parseTimeline, pickKeysList, picksBlock, promptTokens, renderTimeline, type PickChange } from "./picks.ts";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const pick = (key: string, picked: string, said: string, when: number, extra: Partial<Extract<PickChange, { kind: "pick" }>> = {}): PickChange =>
  ({ kind: "pick", at: when, key, picked, said, ...extra });
const tweak = (key: string, said: string, when: number): PickChange => ({ kind: "tweak", at: when, key, said });

describe("applyPicks", () => {
  it("replaces the current pick on the same question in one write, the old one struck with a pointer", () => {
    const first = applyPicks("", [pick("Forum look", "A - plain list", "a looks cleanest", at(17, 10))])!;
    const next = applyPicks(first.text, [pick("forum  LOOK!", "C - Reddit cards", "actually c", at(17, 10, 40))])!;
    expect(next).toMatchObject({ picks: 1, tweaks: 0, replaced: 1 });
    expect(next.text).toContain(
      '## 2026-11-17 10:00 | Forum look | replaced by 2026-11-17 10:40\n- Picked: ~~A - plain list~~\n- Said: "a looks cleanest"\n\n## 2026-11-17 10:40 | Forum look | current\n- Picked: C - Reddit cards\n- Said: "actually c"\n',
    );
    expect(currentPicks(next.text).map((entry) => entry.picked)).toEqual(["C - Reddit cards"]);
    expect(renderTimeline(parseTimeline(next.text))).toBe(next.text);
  });

  it("appends tweaks to the picked picture without replacing it", () => {
    const picture = { picture: { path: "C:\\mock\\C.png", caption: "C - Reddit cards" }, over: ["A - plain list", "B - tiles"], overPictures: [{ path: "C:\\mock\\A.png", caption: "A - plain list" }, { path: "C:\\mock\\B.png" }] };
    const first = applyPicks("", [pick("forum look", "C - Reddit cards", "c", at(17, 10), picture)])!;
    const tweaked = applyPicks(first.text, [tweak("forum look", "make the header smaller", at(17, 10, 52)), tweak("forum look", "blue accent instead of orange", at(17, 11, 3))])!;
    expect(tweaked).toMatchObject({ picks: 0, tweaks: 2, replaced: 0 });
    expect(tweaked.text).toContain(
      '## 2026-11-17 10:00 | forum look | current\n- Picked: C - Reddit cards\n- Picture: C:\\mock\\C.png (C - Reddit cards)\n- Over: A - plain list; B - tiles\n- Over pictures: C:\\mock\\A.png (A - plain list); C:\\mock\\B.png\n- Said: "c"\n- Tweak 2026-11-17 10:52: "make the header smaller"\n- Tweak 2026-11-17 11:03: "blue accent instead of orange"\n',
    );
    expect(parseTimeline(tweaked.text).entries[0]).toMatchObject({ picture: picture.picture, overPictures: picture.overPictures });
    expect(renderTimeline(parseTimeline(tweaked.text))).toBe(tweaked.text);
  });

  it("lands a tweak after the pick it was said with, whatever order they come in", () => {
    const first = applyPicks("", [pick("forum look", "A - plain list", "a", at(17, 10))])!;
    const next = applyPicks(first.text, [tweak("forum look", "make the header smaller", at(17, 10, 41)), pick("forum look", "C - Reddit cards", "actually c", at(17, 10, 40))])!;
    expect(currentPicks(next.text)).toMatchObject([{ picked: "C - Reddit cards", tweaks: [{ at: "2026-11-17 10:41", said: "make the header smaller" }] }]);
  });

  it("changes nothing for a restated pick, a repeated tweak or a tweak with no pick", () => {
    const first = applyPicks("", [pick("forum look", "C - Reddit cards", "c", at(17, 10)), tweak("forum look", "make the header smaller", at(17, 11))])!;
    expect(applyPicks(first.text, [pick("Forum Look", "C - Reddit cards", "c again", at(17, 12)), tweak("forum look", "make the header smaller", at(17, 13))])).toBeNull();
    expect(applyPicks("", [tweak("forum look", "make the header smaller", at(17, 10))])).toBeNull();
  });

  it("keeps an older decisions file word for word under its own heading", () => {
    const out = applyPicks("# Older decisions\n\n- GIT ROW LOOK (11-14): rows show the branch first\n", [pick("forum look", "C - Reddit cards", "c", at(17, 10))])!;
    expect(out.text).toMatch(/^# Decision timeline\n/);
    expect(out.text).toContain("## Older picks, before the timeline (no words kept)\n\n- GIT ROW LOOK (11-14): rows show the branch first\n");
    expect(parseTimeline(out.text).entries.map((entry) => entry.key)).toEqual(["forum look"]);
  });
});

describe("picksBlock", () => {
  it("reads C with its picture plus the tweaks, newest pick first", () => {
    const text = applyPicks("", [
      pick("Bigger scroll handle", "Bigger scroll handle", "make the handle bigger", at(15, 9)),
      pick("theme", "Follows the app theme", "the second one", at(16, 9)),
      pick("forum look", "C - Reddit cards", "c", at(17, 10), { picture: { path: "C:\\mock\\C.png" } }),
      tweak("forum look", "make the header smaller", at(17, 10, 52)),
      tweak("forum look", "blue accent instead of orange", at(17, 11, 3)),
    ])!.text;
    expect(picksBlock(text).split("\n").slice(1)).toEqual([
      '- forum look (11-17): C - Reddit cards (C:\\mock\\C.png) + tweaks: "make the header smaller" (11-17), "blue accent instead of orange" (11-17)',
      "- theme (11-16): Follows the app theme",
      "- Bigger scroll handle (11-15)",
    ]);
    expect(pickKeysList(text)).toContain("- forum look: C - Reddit cards");
    expect(picksBlock(text).split("\n")[0]).toContain("Auto Notes keeps the history in the user's words in memory/decisions.md; read it, never edit it.");
  });

  it("shows the note-taker what the newest picks beat", () => {
    const text = applyPicks("", [
      ...Array.from({ length: 10 }, (_, i) => pick(`question ${i + 1}`, `answer ${i + 1}`, `answer ${i + 1}`, at(10, 9, i), { over: [`other ${i + 1}`] })),
      pick("forum look", "A - plain list", "a", at(17, 10), {
        picture: { path: "C:\\mock\\A.png", caption: "A - plain list" },
        over: ["B - tiles", "C - Reddit cards"],
        overPictures: [{ path: "C:\\mock\\B.png", caption: "B - tiles" }, { path: "C:\\mock\\C.png", caption: "C - Reddit cards" }],
      }),
    ])!.text;
    const list = pickKeysList(text);
    expect(list).toMatch(/^- question 1: answer 1\n- question 2: answer 2\n {2}over: other 2\n/);
    expect(list).toMatch(/- forum look: A - plain list\n {2}picture: C:\\mock\\A\.png \(A - plain list\)\n {2}over: B - tiles; C - Reddit cards\n {2}over pictures: C:\\mock\\B\.png \(B - tiles\); C:\\mock\\C\.png \(C - Reddit cards\)$/);
  });

  it("names how many older tweaks only the file holds", () => {
    const text = applyPicks("", [pick("forum look", "C", "c", at(17, 10)), ...["one", "two", "three", "four"].map((word, i) => tweak("forum look", `tweak ${word}`, at(17, 11, i)))])!.text;
    expect(picksBlock(text)).toContain('+ tweaks: "tweak two" (11-17), "tweak three" (11-17), "tweak four" (11-17) (+1 earlier in memory/decisions.md)');
  });

  it("stays within 300 estimated tokens for 40 picks in any script", () => {
    expect(promptTokens("ab")).toBeCloseTo(2 / 2.6);
    expect(promptTokens("답변")).toBe(2);
    for (const word of ["answer", "답변"]) {
      const text = applyPicks("", Array.from({ length: 40 }, (_, i) => pick(`question ${i + 1}`, Array(6).fill(`${word} ${i + 1}`).join(" "), "yes", at(1 + Math.floor(i / 4), i % 4))))!.text;
      const block = picksBlock(text);
      expect(promptTokens(block)).toBeLessThanOrEqual(300);
      expect(block).toContain("- question 40 (11-10):");
      expect(block).toMatch(/\n\d+ older current picks are only in memory\/decisions\.md\.$/);
    }
  });

  it("is empty without a current pick", () => {
    expect(picksBlock("")).toBe("");
    expect(picksBlock("# Older decisions\n\n- GIT ROW LOOK (11-14): rows show the branch first\n")).toBe("");
  });
});

describe("currentOnly", () => {
  it("blanks replaced picks and keeps the line numbers", () => {
    const first = applyPicks("", [pick("forum look", "A - plain list", "a looks cleanest", at(17, 10))])!;
    const text = applyPicks(first.text, [pick("forum look", "C - Reddit cards", "actually c", at(17, 10, 40))])!.text;
    const only = currentOnly(text);
    expect(only.split("\n")).toHaveLength(text.split("\n").length);
    expect(only).not.toMatch(/plain list|cleanest/);
    expect(only).toContain('- Picked: C - Reddit cards\n- Said: "actually c"');
  });
});
