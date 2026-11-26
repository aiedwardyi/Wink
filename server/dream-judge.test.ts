import { describe, expect, it } from "vitest";

import { agreed, dreamPrompt, expired, neverMoves, parseDream, planDream, type Flag } from "./dream-judge.ts";
import { noteLines } from "./memory-sleep.ts";
import { at, SAFETY_IDS, SAFETY_MEMORY, SAFETY_REPLIES, SAFETY_RIGHT, SAFETY_TODAY, SAFETY_WRONG } from "./testing/dream-safety.ts";

const memory = (...lines: string[]) => `# Memory\n\n${lines.join("\n")}\n`;
const flags = (raw: string, reply: unknown, today = "2026-11-26") => parseDream(JSON.stringify(reply), noteLines(raw), today)!;

describe("the safety set", () => {
  const ref = (id: (typeof SAFETY_IDS)[number]) => `L${at(id) + 1}`;
  const replyOf = ({ repeat, disagree, stale }: (typeof SAFETY_REPLIES)["claude"]) => ({
    repeat: (repeat ?? []).map(({ drop, by }) => ({ drop: ref(drop), by: by.map(ref), lost: "" })),
    disagree: (disagree ?? []).map(([a, b]) => [ref(a), ref(b)]),
    stale: (stale ?? []).map(ref),
  });

  it("moves none of the 48 known-wrong flags, and still moves the lines both judges rightly flag", () => {
    expect(SAFETY_WRONG).toHaveLength(48);
    const pair = agreed(flags(SAFETY_MEMORY, replyOf(SAFETY_REPLIES.claude), SAFETY_TODAY), flags(SAFETY_MEMORY, replyOf(SAFETY_REPLIES.gemini), SAFETY_TODAY));
    const moved = new Set(planDream(SAFETY_MEMORY, pair, SAFETY_TODAY).map((move) => move.at));
    expect(SAFETY_WRONG.filter(([, id]) => moved.has(at(id)))).toEqual([]);
    expect([...moved].sort()).toEqual(SAFETY_RIGHT.map(at).sort());
  });

  it("moves none of them on one judge's word, whichever judge it is", () => {
    for (const reply of [SAFETY_REPLIES.claude, SAFETY_REPLIES.gemini]) {
      const one = flags(SAFETY_MEMORY, replyOf(reply), SAFETY_TODAY);
      expect(planDream(SAFETY_MEMORY, agreed(one, []), SAFETY_TODAY)).toEqual([]);
    }
  });
});

describe("agreed", () => {
  const raw = memory("- Uses pnpm (noted 2026-11-01)", "- Uses pnpm (noted 2026-11-10)", "- Dentist on 11-02");
  it("keeps only a line both flag for the same kind", () => {
    const stale = flags(raw, { stale: ["L5"] });
    expect(agreed(stale, [])).toEqual([]);
    expect(agreed(stale, flags(raw, { repeat: [{ drop: "L5", by: ["L4"], lost: "" }] }))).toEqual([]);
    expect(agreed(stale, flags(raw, { stale: ["L5"] }))).toEqual([{ kind: "expired", at: 4, by: [] }]);
  });

  it("keeps a repeat only with a covering line both name", () => {
    const one = flags(raw, { repeat: [{ drop: "L3", by: ["L4"], lost: "" }] });
    expect(agreed(one, flags(raw, { repeat: [{ drop: "L3", by: ["L5"], lost: "" }] }))).toEqual([]);
    expect(agreed(one, flags(raw, { repeat: [{ drop: "L3", by: ["L4", "L5"], lost: "" }] }))).toEqual<Flag[]>([{ kind: "repeat", at: 2, by: [3] }]);
  });
});

describe("parseDream", () => {
  const raw = memory("- Prefers light mode (noted 2026-10-01)", "- Prefers dark mode, not light mode (noted 2026-11-12)");
  it("moves the older side of a disagreement, whichever order the judge gives", () => {
    expect(flags(raw, { disagree: [["L4", "L3"]] })).toEqual([{ kind: "replaced", at: 2, by: [3] }]);
  });

  it("drops a repeat the judge says loses something, a line it was not sent, and a reply that is not JSON", () => {
    expect(flags(raw, { repeat: [{ drop: "L3", by: ["L4"], lost: "light" }], stale: ["L9"] })).toEqual([]);
    expect(parseDream("no idea", noteLines(raw), "2026-11-26")).toBeNull();
  });

  it("tells the judge today's date", () => {
    expect(dreamPrompt(noteLines(raw), "2026-11-26")).toMatch(/^Today is 2026-11-26\./);
  });
});

describe("gates", () => {
  it.each([
    ["every written date is past", "- Dentist on 11-02 at 3pm", true],
    ["a date still to come", "- Dentist on 11-02, then again 12-01", false],
    ["no written date, only the stamp", "- Likes tea (noted 2026-10-01)", false],
    ["a range, not a date", "- Replies run 3-5 lines", false],
  ])("expired: %s", (_, text, past) => {
    expect(expired(text, "2026-11-26")).toBe(past);
  });

  it.each([
    ["a standing rule", ["- Replies (11-02): never more than 4 lines"]],
    ["an ALL CAPS label", ["- ONE-LINERS (11-19): one short sentence per reply."]],
    ["the user's quoted words with a date", ['- Asked (11-02) "keep it short"']],
    ["a line under a pinned heading", ["## Pinned", "- Dentist on 11-02"]],
  ])("never moves %s", (_, lines) => {
    const raw = memory(...lines);
    const line = noteLines(raw).at(-1)!;
    expect(neverMoves(line, raw.split("\n"))).toBe(true);
    expect(planDream(raw, [{ kind: "expired", at: line.at, by: [] }], "2026-11-26")).toEqual([]);
  });

  it("never sends a judge the Decisions lines", () => {
    expect(noteLines(memory("## Decisions", "- Dentist on 11-02"))).toEqual([]);
  });

  it("moves a repeat only when the newer line keeps every word and fact", () => {
    const raw = memory("- Wants short replies (noted 2026-11-01)", "- Wants short replies with bullets (noted 2026-11-10)", "- Wants replies (noted 2026-11-12)");
    expect(planDream(raw, [{ kind: "repeat", at: 2, by: [3] }], "2026-11-26").map(({ at }) => at)).toEqual([2]);
    expect(planDream(raw, [{ kind: "repeat", at: 3, by: [4] }], "2026-11-26")).toEqual([]);
  });
});

describe("exact twins", () => {
  const today = "2026-11-26";
  const both = (raw: string, reply: unknown) => agreed(flags(raw, reply), flags(raw, reply));
  // a pinned rule, the user's quoted pick with a date, and an undated fact that still holds
  const guarded = [
    memory("## Pinned", "- Deploy only from main", "- Deploy only from main"),
    memory('- Picked (11-02) "plain list" for the forum', '- Picked (11-02) "plain list" for the forum'),
    memory("- Lives in Seoul", "- Lives in Seoul"),
  ];

  const twin = (raw: string) => {
    const [drop, keep] = noteLines(raw).slice(-2).map((line) => `L${line.at + 1}`);
    return { repeat: [{ drop, by: [keep], lost: "" }] };
  };
  it.each([
    ["both judges flag nothing", (_raw: string) => ({ repeat: [], disagree: [], stale: [] }), (_raw: string) => ({ repeat: [], disagree: [], stale: [] })],
    ["a judge abstains", twin, (_raw: string) => ({})],
    ["a judge answers an unrelated error object", twin, (_raw: string) => ({ error: "rate limited", code: 429 })],
  ])("stay when %s", (_, claude, gemini) => {
    for (const raw of guarded) {
      const pair = agreed(parseDream(JSON.stringify(claude(raw)), noteLines(raw), today)!, parseDream(JSON.stringify(gemini(raw)), noteLines(raw), today)!);
      expect(planDream(raw, pair, today)).toEqual([]);
    }
  });

  it("keep a pinned rule and a dated quoted pick even when both judges flag the twin", () => {
    for (const raw of guarded.slice(0, 2)) expect(planDream(raw, both(raw, twin(raw)), today)).toEqual([]);
  });

  it("keep each guarded line standing alone when both judges call it expired", () => {
    for (const alone of [memory("## Pinned", "- Deploy only from main"), memory('- Picked (11-02) "plain list" for the forum'), memory("- Lives in Seoul")]) {
      const pair = both(alone, { stale: [`L${noteLines(alone).at(-1)!.at + 1}`] });
      expect(pair).toHaveLength(1);
      expect(planDream(alone, pair, today)).toEqual([]);
    }
  });

  it("move only the copy both judges flag", () => {
    const raw = memory("- Uses pnpm", "- Uses pnpm", "- Uses pnpm");
    expect(planDream(raw, both(raw, { repeat: [{ drop: "L3", by: ["L5"], lost: "" }] }), today).map(({ at }) => at)).toEqual([2]);
    expect(planDream(raw, both(raw, {}), today)).toEqual([]);
  });
});
