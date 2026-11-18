import { describe, expect, it } from "vitest";

import { applyPicks, currentOnly, currentPicks, mergeTimelines, parseTimeline, pickKeysList, picksBlock, promptTokens, renderTimeline, type PickChange } from "./picks.ts";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const pick = (key: string, picked: string, said: string, when: number, extra: Partial<Extract<PickChange, { kind: "pick" }>> = {}): PickChange =>
  ({ kind: "pick", at: when, key, picked, said, ...extra });
const tweak = (key: string, said: string, when: number): PickChange => ({ kind: "tweak", at: when, key, said });

describe("applyPicks", () => {
  it("keeps precise action time in metadata readable by older timeline parsers", () => {
    const time = at(17, 10) + 5_000;
    const text = applyPicks("", [pick("forum", "C - Reddit cards", "c", time)])!.text;
    expect(text).toContain("## 2026-11-17 10:00 | forum | current");
    expect(text).toContain(`- At: ${time}`);
    expect(parseTimeline(text).entries[0]?.at).toBe(time);
  });
  it("merges a legacy roll file with a timeline without losing either", () => {
    const timeline = applyPicks("", [pick("forum", "C - Reddit cards", "c", at(17, 10))])!.text;
    const merged = mergeTimelines("# Older decisions\n- Keep the old note\n", timeline)!;
    expect(currentPicks(merged)[0]?.picked).toBe("C - Reddit cards");
    expect(merged).toContain("Keep the old note");
    expect(mergeTimelines(timeline, "# Older decisions\n- Keep the old note\n")).toBe(merged);
  });

  it("preserves known replacement order for old minute ids", () => {
    const text = '# Decision timeline\n\n## 2026-11-17 10:00 | palette | replaced by 2026-11-17 10:00 (2)\n- Picked: ~~Zinc~~\n- Said: "zinc"\n\n## 2026-11-17 10:00 (2) | palette | current\n- Picked: Amber\n- Said: "amber"\n';
    const other = applyPicks("", [pick("layout", "Cards", "cards", at(17, 11))])!.text;
    const merged = mergeTimelines(text, other)!;
    expect(currentPicks(merged).find(({ key }) => key === "palette")?.picked).toBe("Amber");
    expect(mergeTimelines(merged, text)).toBe(merged);
  });
  it("never lets a card tap from another PC replace a typed pick", () => {
    const typed = applyPicks("", [pick("theme", "Dark", "dark", at(17, 10))])!.text;
    const tapped = applyPicks("", [pick("theme", "Light", "light", at(17, 10) + 5_000, { tapped: true })])!.text;
    const merged = mergeTimelines(typed, tapped)!;
    expect(currentPicks(merged).map(({ picked }) => picked)).toEqual(["Dark"]);
    expect(parseTimeline(merged).entries).toHaveLength(2);
    expect(mergeTimelines(tapped, typed)).toBe(merged);
    expect(mergeTimelines(merged, typed)).toBe(merged);
    expect(mergeTimelines(merged, merged)).toBe(merged);
  });
  it("keeps same-minute tweaks in the order the user said them through a merge", () => {
    const first = applyPicks("", [pick("header", "Big header", "big header", at(17, 12))])!.text;
    const text = applyPicks(first, [tweak("header", "make the header smaller", at(17, 12, 1)), tweak("header", "keep the header large", at(17, 12, 1) + 20_000)])!.text;
    expect(currentPicks(mergeTimelines(text, text))[0]!.tweaks.map(({ said }) => said)).toEqual(["make the header smaller", "keep the header large"]);
  });
  it("keeps the later choice when two PCs pick within the same minute", () => {
    const early = applyPicks("", [pick("forum", "C - Reddit cards", "c", at(17, 10) + 5_000)])!.text;
    const late = applyPicks("", [pick("forum", "A - plain list", "a", at(17, 10) + 10_000)])!.text;
    expect(currentPicks(mergeTimelines(early, late))[0]?.picked).toBe("A - plain list");
  });
  it("merges colliding ids deterministically without duplicating picks on replay", () => {
    const a = applyPicks("", [pick("forum", "A - plain list", "a", at(17, 10)), tweak("forum", "smaller header", at(17, 10, 1))])!.text;
    const b = applyPicks("", [pick("forum", "C - Reddit cards", "c", at(17, 10)), pick("theme", "Dark", "dark", at(17, 10))])!.text;
    const merged = mergeTimelines(a, b)!;
    expect(mergeTimelines(b, a)).toBe(merged);
    expect(mergeTimelines(merged, a)).toBe(merged);
    expect(mergeTimelines(merged, b)).toBe(merged);
    expect(parseTimeline(merged).entries).toHaveLength(3);
    expect(new Set(parseTimeline(merged).entries.map(({ id }) => id)).size).toBe(3);
    expect(currentPicks(merged)).toHaveLength(2);
    expect(parseTimeline(merged).entries.find(({ picked }) => picked === "A - plain list")?.tweaks).toHaveLength(1);
  });
  it("keeps same-time snapshots separate when their source messages differ", () => {
    const first = applyPicks("", [pick("forum", "B", "b", at(17, 10), { thread: "t1", messageId: "m1", questionId: "q1", files: ["/shots/first.png"] })])!.text;
    const next = applyPicks("", [pick("forum", "B", "b", at(17, 10), { thread: "t2", messageId: "m2", questionId: "q2", files: ["/shots/next.png"] })])!.text;
    const merged = mergeTimelines(first, next)!;
    expect(parseTimeline(merged).entries).toHaveLength(2);
    expect(mergeTimelines(merged, first)).toBe(merged);
    expect(mergeTimelines(merged, next)).toBe(merged);
  });
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

  it("never lets a card tap replace a typed pick, however late", () => {
    const typed = applyPicks("", [pick("forum", "A - plain list", "a", at(17, 10))])!.text;
    expect(applyPicks(typed, [pick("forum", "C - Reddit cards", "c", at(17, 11), { tapped: true })])).toBeNull();
    expect(applyPicks("", [pick("forum", "C - Reddit cards", "c", at(17, 11), { tapped: true }), pick("forum", "A - plain list", "a", at(17, 10))])!.text).toContain("- Picked: A - plain list");
  });
  it("lets typing replace a card tap even when the tap is stamped later", () => {
    const tapped = applyPicks("", [pick("forum", "C - Reddit cards", "c", at(17, 11), { tapped: true })])!.text;
    expect(parseTimeline(tapped).entries[0]?.tapped).toBe(true);
    const next = applyPicks(tapped, [pick("forum", "A - plain list", "a", at(17, 10))])!.text;
    expect(currentPicks(next).map(({ picked }) => picked)).toEqual(["A - plain list"]);
    expect(currentPicks(next)[0]?.tapped).toBeUndefined();
  });
  it("makes a tap's option typed when the user types the same option", () => {
    const tapped = applyPicks("", [pick("forum", "C - Reddit cards", "c", at(17, 10), { tapped: true })])!.text;
    const typed = applyPicks(tapped, [pick("forum", "C - Reddit cards", "c please", at(17, 11))])!.text;
    expect(applyPicks(typed, [pick("forum", "B - tiles", "b", at(17, 12), { tapped: true })])).toBeNull();
  });
  it("keeps a retyped pick's binding and attachments after it syncs with the tap", () => {
    const tapped = applyPicks("", [pick("forum", "B", "b", at(17, 10), { tapped: true, thread: "t1", messageId: "m1", questionId: "q1", files: ["/shots/tap.png"] })])!.text;
    const typed = applyPicks(tapped, [pick("forum", "B", "I choose B", at(17, 11), { thread: "t2", messageId: "m2", questionId: "q2", files: ["/shots/typed.png"] })])!.text;
    expect(parseTimeline(mergeTimelines(tapped, typed)!).entries).toMatchObject([
      { thread: "t2", messageId: "m2", questionId: "q2", files: ["/shots/typed.png"] },
    ]);
  });
  it("dates a retyped tap at the typing, so an older delayed pick never replaces it", () => {
    const tapped = applyPicks("", [pick("forum", "C - Reddit cards", "c", at(17, 10), { tapped: true })])!.text;
    const typed = applyPicks(tapped, [pick("forum", "C - Reddit cards", "c please", at(17, 11))])!.text;
    expect(applyPicks(typed, [pick("forum", "B - tiles", "b", at(17, 10, 30))])).toBeNull();
    const merged = mergeTimelines(tapped, typed)!;
    expect(parseTimeline(merged).entries).toHaveLength(1);
    expect(currentPicks(merged)[0]?.tapped).toBeUndefined();
    expect(applyPicks(merged, [pick("forum", "B - tiles", "b", at(17, 10, 30))])).toBeNull();
  });
  it("changes nothing for a restated pick, a repeated tweak or a tweak with no pick", () => {
    const first = applyPicks("", [pick("forum look", "C - Reddit cards", "c", at(17, 10)), tweak("forum look", "make the header smaller", at(17, 11))])!;
    expect(applyPicks(first.text, [pick("Forum Look", "C - Reddit cards", "c again", at(17, 12)), tweak("forum look", "make the header smaller", at(17, 13))])).toBeNull();
    expect(applyPicks("", [tweak("forum look", "make the header smaller", at(17, 10))])).toBeNull();
  });

  it("never cuts an emoji in half", () => {
    const said = `${"x".repeat(116)}\u{1F600} and more`;
    const { text } = applyPicks("", [pick("forum look", "C - Reddit cards", said, at(17, 10))])!;
    expect(text).toContain(`- Said: "${"x".repeat(116)}..."\n`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
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
    expect(picksBlock(text).split("\n")[0]).toContain("History: memory/decisions.md (Auto Notes writes it; never edit).");
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
      expect(block).toMatch(/\nAlso current, on file: question 39; .* \(\+\d+ more\)$/);
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

describe("picks index", () => {
  const keys = (count: number) => Array.from({ length: count }, (_, i) => `area ${i + 1} look`);

  it("names every current pick's key within the cap at 34 picks", () => {
    const text = applyPicks("", keys(34).map((key, i) => pick(key, `answer ${i + 1} with a few words`, "yes", at(1 + Math.floor(i / 4), i % 4))))!.text;
    const block = picksBlock(text);
    expect(promptTokens(block)).toBeLessThanOrEqual(300);
    expect(block).toContain("- area 34 look (11-09): answer 34 with a few words");
    for (const key of keys(34)) expect(block).toContain(key);
  });

  it("names every key of eight picture picks with tweaks, the newest in full", () => {
    const text = applyPicks("", keys(8).flatMap((key, i) => [
      pick(key, `C - option ${i + 1} cards`, "c", at(10 + i, 9), { picture: { path: `C:\\Users\\me\\Desktop\\Orbit-cards\\day-11${i}\\mock\\C.png` } }),
      tweak(key, "make the header a bit smaller", at(10 + i, 10)),
      tweak(key, "and use a blue accent instead of orange", at(10 + i, 11)),
    ]))!.text;
    const block = picksBlock(text);
    expect(promptTokens(block)).toBeLessThanOrEqual(300);
    expect(block).toContain('- area 8 look (11-17): C - option 8 cards (C:\\Users\\me\\Desktop\\Orbit-cards\\day-117\\mock\\C.png) + tweaks: "make the header a bit smaller" (11-17), "and use a blue accent instead of orange" (11-17)');
    for (const key of keys(8)) expect(block).toContain(key);
  });

  it("keeps a long non-Latin newest pick and the other keys in view", () => {
    const korean = "포럼 화면은 레딧처럼 카드가 쌓이는 모양으로 하고 제목과 미리보기와 댓글 수를 보여준다".repeat(2);
    const text = applyPicks("", [
      ...keys(9).map((key, i) => pick(key, `answer ${i + 1}`, "yes", at(10, 9, i))),
      pick("포럼 화면 모양", korean, "그걸로 해", at(17, 10)),
      ...["헤더를 더 작게 해 줘 지금보다 반 정도로", "주황 대신 파란 포인트 색으로 바꿔 줘", "댓글 수는 오른쪽 위에 작게 보여 줘"].map((said, i) => tweak("포럼 화면 모양", said, at(17, 11, i))),
    ])!.text;
    const block = picksBlock(text);
    expect(promptTokens(block)).toBeLessThanOrEqual(300);
    expect(block).toContain("- 포럼 화면 모양 (11-17): 포럼 화면은");
    for (const key of keys(9)) expect(block).toContain(key);
  });
});

describe("applyPicks order", () => {
  it("treats the same option in other words as a restatement that keeps its tweaks", () => {
    const first = applyPicks("", [pick("forum look", "C - Reddit cards", "c", at(17, 10)), tweak("forum look", "make the header smaller", at(17, 11))])!;
    expect(applyPicks(first.text, [pick("forum look", "C - Reddit-style cards", "yes, c with the reddit style cards", at(17, 12))])).toBeNull();
  });

  it("replaces a pick when the same letter names a changed option", () => {
    const blue = applyPicks("", [pick("Header color", "A - blue header", "a", at(17, 10))])!;
    const red = applyPicks(blue.text, [pick("Header color", "A - red header", "For Header color, pick A - red header instead.", at(17, 10, 2))])!;
    expect(red).toMatchObject({ picks: 1, replaced: 1 });
    expect(red.text).toContain("- Picked: ~~A - blue header~~");
    expect(currentPicks(red.text).map(({ picked }) => picked)).toEqual(["A - red header"]);
    expect(applyPicks(red.text, [pick("Header color", "A - red header bar", "a, the red header bar", at(17, 10, 3))])).toBeNull();
  });

  it("lands a tweak the user asks for again after reversing it", () => {
    const first = applyPicks("", [pick("forum look", "C - Reddit cards", "c", at(17, 10)), tweak("forum look", "make the header smaller", at(17, 11))])!;
    const back = applyPicks(first.text, [tweak("forum look", "keep the header large", at(17, 12)), tweak("forum look", "make the header smaller", at(17, 13))])!;
    expect(currentPicks(back.text)[0]!.tweaks.map(({ said }) => said)).toEqual(["make the header smaller", "keep the header large", "make the header smaller"]);
    expect(applyPicks(back.text, [tweak("forum look", "keep the header large", at(17, 12)), tweak("forum look", "make the header smaller", at(17, 13))])).toBeNull();
  });

  it("never lets a replayed older pick replace a newer one", () => {
    const a = applyPicks("", [pick("forum look", "A - plain list", "a", at(17, 10))])!;
    const c = applyPicks(a.text, [pick("forum look", "C - Reddit cards", "actually c", at(17, 10, 1))])!;
    expect(applyPicks(c.text, [pick("forum look", "A - plain list", "a", at(17, 10))])).toBeNull();
    const first = { ...pick("forum look", "A - plain list", "a", at(17, 10)), thread: "t1", messageId: "m1", questionId: "q1" };
    const second = { ...pick("forum look", "C - Reddit cards", "actually c", first.at), thread: "t1", messageId: "m2", questionId: "q1" };
    const tied = applyPicks("", [first, second])!;
    expect(currentPicks(tied.text)[0]?.messageId).toBe("m2");
    expect(applyPicks(tied.text, [first, second])).toBeNull();
  });
});
