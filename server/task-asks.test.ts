import { describe, expect, it } from "vitest";

import { addQuestionAsk, answerQuestionAsk, ASK_STALE_MS, asksBlock, asksNudge, isStatusTurn, mergeTaskAsks, type TaskAsk } from "./task-asks.ts";

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 12, 9, 0).getTime();
const ask = (id: number, overrides: Partial<TaskAsk> = {}): TaskAsk => ({
  id: `A${id}`,
  ask: `ask number ${id}`,
  status: "open",
  at: NOW - HOUR,
  changedAt: NOW - HOUR,
  ...overrides,
});
const saved = (result: ReturnType<typeof mergeTaskAsks>) => {
  if ("error" in result) throw new Error(result.error);
  return result;
};
// The repo's own estimate, as in context-compaction.ts: three UTF-8 bytes a token.
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);

describe("task asks", () => {
  it("adds each ask with an id and the time it was asked", () => {
    const { asks, note } = saved(mergeTaskAsks(undefined, [
      { ask: "Fix the login redirect", status: "open" },
      { ask: "Review the installer", status: "waiting-for-user", ref: "PR #12" },
    ], NOW));
    expect(asks).toEqual([
      { id: "A1", ask: "Fix the login redirect", status: "open", at: NOW, changedAt: NOW },
      { id: "A2", ask: "Review the installer", status: "waiting-for-user", ref: "PR #12", at: NOW, changedAt: NOW },
    ]);
    expect(note).toBe("Asks saved: added A1, A2; 2 open.");
  });

  it("updates an ask by id and keeps every ask the update left out", () => {
    const { asks } = saved(mergeTaskAsks([ask(1), ask(2, { ref: "PR #3" })], [{ id: "a2", status: "building", ref: "card RELEASE" }], NOW));
    expect(asks).toEqual([ask(1), ask(2, { status: "building", ref: "card RELEASE", changedAt: NOW })]);
    const cleared = saved(mergeTaskAsks(asks, [{ id: "A2", status: "building", ref: "" }], NOW)).asks;
    expect(cleared[1]).not.toHaveProperty("ref");
  });

  it("closes an ask into history instead of deleting it", () => {
    const { asks, note } = saved(mergeTaskAsks([ask(1), ask(2)], [{ id: "A1", status: "done" }], NOW));
    expect(asks).toEqual([ask(1, { status: "done", changedAt: NOW }), ask(2)]);
    expect(note).toBe("Asks saved; 1 open.");
    expect(asksBlock(asks, NOW)).toBe("[Wink asks list - 1 open.]\n- A2 open 11-12: ask number 2");
  });

  it("updates the open ask with the same words instead of adding a twin", () => {
    const { asks } = saved(mergeTaskAsks([ask(1, { ask: "Fix the login redirect" })], [{ ask: "fix the LOGIN  redirect", status: "building" }], NOW));
    expect(asks).toEqual([ask(1, { ask: "Fix the login redirect", status: "building", changedAt: NOW })]);
  });

  it("restarts an ask's clock when the bot raises it again unchanged", () => {
    const { asks } = saved(mergeTaskAsks([ask(1, { status: "waiting-for-user", changedAt: 0 })], [{ id: "A1", status: "waiting-for-user" }], NOW));
    expect(asks).toEqual([ask(1, { status: "waiting-for-user", changedAt: NOW })]);
    expect(asksNudge(asks, NOW, "thanks")).toBe("");
  });

  it("refuses an unknown id and a new ask with no words", () => {
    expect(mergeTaskAsks([ask(1)], [{ id: "A9", status: "done" }], NOW)).toEqual({ error: "Unknown ask id A9. Open asks: A1." });
    expect(mergeTaskAsks([ask(1)], [{ status: "open" }], NOW)).toEqual({ error: "A new ask needs ask, the user's words in brief; send id to update one." });
  });

  it("drops the oldest closed asks past the cap and refuses when every kept ask is open", () => {
    const kept = Array.from({ length: 40 }, (_, index) => ask(index + 1, { status: index < 3 ? "done" : "open" }));
    const { asks } = saved(mergeTaskAsks(kept, [{ ask: "One more", status: "open" }, { ask: "And another", status: "open" }], NOW));
    expect(asks.map((item) => item.id)).toEqual([...Array.from({ length: 38 }, (_, index) => `A${index + 3}`), "A41", "A42"]);
    const open = Array.from({ length: 40 }, (_, index) => ask(index + 1));
    expect(mergeTaskAsks(open, [{ ask: "One too many", status: "open" }], NOW)).toEqual({
      error: "That would leave 41 asks open; Wink keeps 40. Close finished ones as done or declined first.",
    });
  });

  it.each(["open", "building", "waiting-for-user"] as const)("flags a %s ask with no change for 6 hours as stale", (status) => {
    const fresh = ask(1, { status, changedAt: NOW - ASK_STALE_MS + 1 });
    const stale = ask(2, { status, changedAt: NOW - ASK_STALE_MS });
    const block = asksBlock([fresh, stale], NOW);
    expect(block).toContain(`- A2 ${status} stale 11-12`);
    expect(block).toContain(`- A1 ${status} 11-12`);
    expect(asksNudge([fresh], NOW, "thanks")).toBe("");
    expect(asksNudge([fresh, stale], NOW, "thanks")).toBe(block);
  });

  it("never flags or lists a closed ask", () => {
    const old = [ask(1, { status: "done", changedAt: 0 }), ask(2, { status: "declined", changedAt: 0 })];
    expect(asksBlock(old, NOW)).toBe("");
    expect(asksBlock(undefined, NOW)).toBe("");
    expect(asksNudge(old, NOW, "status?")).toBe("");
  });

  it("lists stale asks first, then the oldest, five at most", () => {
    const asks = [...Array.from({ length: 6 }, (_, index) => ask(index + 1)), ask(7, { changedAt: 0, ref: "PR #7" })];
    expect(asksBlock(asks, NOW).split("\n")).toEqual([
      "[Wink asks list - 7 open, 1 stale: no change in 6+ hours, so raise it with the user now, then update it.]",
      "- A7 open stale 11-12: ask number 7 (PR #7)",
      ...[1, 2, 3, 4].map((id) => `- A${id} open 11-12: ask number ${id}`),
      "+2 more open",
    ]);
  });

  it("lists every open ask on a status turn", () => {
    const asks = Array.from({ length: 8 }, (_, index) => ask(index + 1));
    const block = asksNudge(asks, NOW, "Morning! Where are we?");
    expect(block.split("\n")[0]).toBe("[Wink asks list - 8 open. Build any summary or status from this list.]");
    expect(block.split("\n")).toHaveLength(9);
    expect(asksBlock(asks, NOW, true)).toBe(block);
  });

  it.each(["Give me the morning summary", "status?", "write the release notes", "recap please", "what's left", "오늘 현황 정리해줘", "요약"])(
    "treats %j as a status turn",
    (text) => expect(isStatusTurn(text)).toBe(true),
  );

  it.each(["thanks", "fix the login bug", "진행해"])("treats %j as an ordinary turn", (text) => {
    expect(isStatusTurn(text)).toBe(false);
  });

  it("keeps the injected block small", () => {
    const list = (count: number) => Array.from({ length: count }, (_, index) => ask(index + 1, {
      ask: "Review the model picker look row",
      ...(index % 3 ? {} : { status: "waiting-for-user" as const, ref: `PR #${1300 + index}` }),
    }));
    expect(asksBlock(list(0), NOW)).toBe("");
    expect(tokens(asksBlock(list(5), NOW))).toBeLessThanOrEqual(150);
    expect(tokens(asksBlock(list(30), NOW))).toBeLessThanOrEqual(150);
    expect(tokens(asksBlock(list(30), NOW, true))).toBeLessThanOrEqual(700);
  });

  describe("skipped questions", () => {
    const question = (id: number, overrides: Partial<TaskAsk> = {}) => ask(id, { ask: `question ${id}?`, kind: "question", choices: "Yes / No", ...overrides });
    const GUIDE = " A question is your own card the user skipped: re-ask open ones 1-3 at a time at a natural pause, and close moot or answered ones.";

    it("files a skipped card as an open question with its choices, clipped to the ask limits", () => {
      expect(addQuestionAsk([ask(1)], "  Ship   it now?  ", ["Ship", "Wait"], NOW)).toEqual([
        ask(1),
        { id: "A2", ask: "Ship it now?", status: "open", kind: "question", choices: "Ship / Wait", at: NOW, changedAt: NOW },
      ]);
      const [long] = addQuestionAsk(undefined, "q".repeat(500), ["c".repeat(200)], NOW)!;
      expect(long).toMatchObject({ ask: `${"q".repeat(79)}…`, choices: `${"c".repeat(79)}…` });
      expect(addQuestionAsk(undefined, "Free text?", [], NOW)![0]).not.toHaveProperty("choices");
    });

    it("dedupes by words against open asks, and files again once the old one closed", () => {
      expect(addQuestionAsk([question(1, { ask: "Ship it?" })], "ship  IT?", [], NOW)).toBeNull();
      expect(addQuestionAsk([question(1, { ask: "Ship it?", status: "done" })], "Ship it?", [], NOW)?.map((item) => item.id)).toEqual(["A1", "A2"]);
    });

    it("keeps the 40 cap: drops the oldest closed first and never an open one", () => {
      const kept = Array.from({ length: 40 }, (_, index) => ask(index + 1, { status: index < 2 ? "done" : "open" }));
      expect(addQuestionAsk(kept, "One more?", [], NOW)?.map((item) => item.id)).toEqual([...Array.from({ length: 39 }, (_, index) => `A${index + 2}`), "A41"]);
      expect(addQuestionAsk(Array.from({ length: 40 }, (_, index) => ask(index + 1)), "One more?", [], NOW)).toBeNull();
    });

    it("caps open questions apart, so they never block the bot's own asks", () => {
      const questions = Array.from({ length: 10 }, (_, index) => question(index + 1));
      expect(addQuestionAsk(questions, "One more?", [], NOW)?.map((item) => item.id)).toEqual([...Array.from({ length: 9 }, (_, index) => `A${index + 2}`), "A11"]);
      const full = [...questions, ...Array.from({ length: 30 }, (_, index) => ask(index + 11))];
      const { asks } = saved(mergeTaskAsks(full, [{ ask: "One more", status: "open" }], NOW));
      expect(asks.map((item) => item.id)).toEqual([...Array.from({ length: 39 }, (_, index) => `A${index + 2}`), "A41"]);
    });

    it("lets the bot close a question with the usual asks update", () => {
      const { asks } = saved(mergeTaskAsks([question(1)], [{ id: "A1", status: "declined" }], NOW));
      expect(asks).toEqual([question(1, { status: "declined", changedAt: NOW })]);
      expect(asksBlock(asks, NOW, true)).toBe("");
    });

    it("takes back a question filed for the card just answered and closes an older one", () => {
      expect(answerQuestionAsk([question(1, { at: NOW })], "question 1?", NOW, NOW)).toEqual([]);
      expect(answerQuestionAsk([question(1)], "Question 1?", NOW, NOW)).toEqual([question(1, { status: "done", changedAt: NOW })]);
      expect(answerQuestionAsk([ask(1, { ask: "question 1?" })], "question 1?", NOW, NOW)).toBeNull();
    });

    it("lists questions after the user's asks, never stale, with the re-ask line", () => {
      const asks = [question(1, { changedAt: 0 }), ask(2)];
      expect(asksBlock(asks, NOW, true).split("\n")).toEqual([
        `[Wink asks list - 2 open. Build any summary or status from this list.${GUIDE}]`,
        "- A2 open 11-12: ask number 2",
        "- A1 open question 11-12: question 1? (choices: Yes / No)",
      ]);
      expect(asksNudge(asks, NOW, "thanks")).toBe("");
      expect(asksBlock([ask(1, { changedAt: 0 }), ...Array.from({ length: 4 }, (_, index) => ask(index + 2)), question(9)], NOW)).not.toContain("question");
    });

    it("adds nothing to an ordinary turn and stays small on a status turn", () => {
      const list = (count: number) => Array.from({ length: count }, (_, index) => question(index + 1, {
        ask: "Should the model picker row keep the old look?",
        choices: "Keep / New look / Ask me later",
        changedAt: 0,
      }));
      expect([0, 5, 30].map((count) => tokens(asksNudge(list(count), NOW, "fix the login bug")))).toEqual([0, 0, 0]);
      expect(tokens(asksBlock(list(30), NOW))).toBeLessThanOrEqual(250);
      expect(tokens(asksNudge(list(5), NOW, "status?"))).toBeLessThanOrEqual(260);
      expect(tokens(asksNudge(list(30), NOW, "status?"))).toBeLessThanOrEqual(1_250);
    });
  });
});
