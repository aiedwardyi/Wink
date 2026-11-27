import { describe, expect, it } from "vitest";

import { addQuestionAsk, answerQuestionAsk, ASK_VERDICT_MS, asksBlock, asksNudge, fileLeftovers, isStatusTurn, MAX_STATUS_ASKS_BYTES, mergeTaskAsks, rotatedAsks, TASK_ASKS_PROMPT, type TaskAsk } from "./task-asks.ts";
import { taskRecordBlock } from "./turn-context.ts";

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
const DAY = 24 * HOUR;
const listed = (block: string) => block.split("\n").filter((line) => line.startsWith("- A"));
const record = (asks: TaskAsk[]) => ({ goal: "Ship", plan: [], completed: [], blockers: [], nextAction: "", asks });

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
    const { asks } = saved(mergeTaskAsks({ asks: [ask(1), ask(2, { ref: "PR #3" })] }, [{ id: "a2", status: "building", ref: "card RELEASE" }], NOW));
    expect(asks).toEqual([ask(1), ask(2, { status: "building", ref: "card RELEASE", changedAt: NOW })]);
    const cleared = saved(mergeTaskAsks({ asks: asks }, [{ id: "A2", status: "building", ref: "" }], NOW)).asks;
    expect(cleared[1]).not.toHaveProperty("ref");
  });

  it("closes an ask into history instead of deleting it", () => {
    const { asks, note } = saved(mergeTaskAsks({ asks: [ask(1), ask(2)] }, [{ id: "A1", status: "done" }], NOW));
    expect(asks).toEqual([ask(1, { status: "done", changedAt: NOW }), ask(2)]);
    expect(note).toBe("Asks saved; 1 open.");
    expect(asksBlock(asks, NOW)).toBe("[Wink asks list - 1 open.]\n- A2 open 11-12: ask number 2");
  });

  it("updates the open ask with the same words instead of adding a twin", () => {
    const { asks } = saved(mergeTaskAsks({ asks: [ask(1, { ask: "Fix the login redirect" })] }, [{ ask: "fix the LOGIN  redirect", status: "building" }], NOW));
    expect(asks).toEqual([ask(1, { ask: "Fix the login redirect", status: "building", changedAt: NOW })]);
  });

  it("restarts an ask's clock when the bot raises it again unchanged", () => {
    const { asks } = saved(mergeTaskAsks({ asks: [ask(1, { status: "waiting-for-user", changedAt: 0 })] }, [{ id: "A1", status: "waiting-for-user" }], NOW));
    expect(asks).toEqual([ask(1, { status: "waiting-for-user", changedAt: NOW })]);
    expect(asksNudge(asks, NOW, "thanks")).toBe("");
  });

  it("tells every bot to file a yes to its own proposal as an ask not started yet", () => {
    expect(TASK_ASKS_PROMPT).toContain("Add each ask the user makes to update_task_state asks in the same turn, counting a yes to something you proposed; open means not started yet.");
  });

  it("tells every bot the plan, building asks and the asks list are its only lists for asks and work", () => {
    expect(TASK_ASKS_PROMPT).toContain("Keep three lists for asks and work only: the plan is the to-do for now, asks marked building are the sprint, and the asks list holds every open ask; never start a separate list file, and keep your other records.");
  });

  it("keeps a decided ask not started under newer ones and reopens a declined one by id", () => {
    const decided = saved(mergeTaskAsks(undefined, [{ ask: "Fold decided work into asks", status: "open" }, { ask: "Old idea", status: "declined" }], NOW - 2 * HOUR));
    let asks: TaskAsk[] = decided.asks;
    for (let index = 0; index < 45; index += 1) asks = saved(mergeTaskAsks({ asks, lastAskId: index + 2 }, [{ ask: `newer ${index}`, status: "open" }], NOW)).asks;
    expect(asks[0]).toEqual({ id: "A1", ask: "Fold decided work into asks", status: "open", at: NOW - 2 * HOUR, changedAt: NOW - 2 * HOUR });
    expect(asks.map((item) => item.id)).not.toContain("A2");
    expect(listed(asksBlock(asks, NOW))).toHaveLength(46);
    expect(asksBlock(asks, NOW, true)).toContain("- A1 open 11-12: Fold decided work into asks");
    const declined = [ask(1), ask(2, { status: "declined" })];
    const reopened = saved(mergeTaskAsks({ asks: declined }, [{ id: "A2", status: "open" }], NOW)).asks;
    expect(reopened[1]).toEqual(ask(2, { changedAt: NOW }));
    expect(saved(mergeTaskAsks({ asks: declined }, [{ ask: "ask number 2", status: "open" }], NOW)).asks.map((item) => [item.id, item.status])).toEqual([["A1", "open"], ["A2", "declined"], ["A3", "open"]]);
  });

it("lists all 221 open asks on an ordinary turn, not the oldest five", () => {
    const open = Array.from({ length: 221 }, (_, index) => ask(index + 1, { ask: `${"x".repeat(70)} ${index + 1}`.slice(0, 80), at: NOW - 10 * 24 * HOUR, changedAt: NOW - 10 * 24 * HOUR }));
    const listed = asksNudge(open, NOW, "thanks").split("\n").filter((line) => line.startsWith("- A"));
    expect(listed).toHaveLength(221);
  });

  it("refuses an unknown id and a new ask with no words", () => {
    expect(mergeTaskAsks({ asks: [ask(1)] }, [{ id: "A9", status: "done" }], NOW)).toEqual({ error: "Unknown ask id A9. Open asks: A1." });
    expect(mergeTaskAsks({ asks: [ask(1)] }, [{ status: "open" }], NOW)).toEqual({ error: "A new ask needs ask, the user's words in brief; send id to update one." });
  });

  it("drops the oldest closed asks past 40 and never refuses an open one", () => {
    const kept = Array.from({ length: 40 }, (_, index) => ask(index + 1, { status: index < 3 ? "done" : "open" }));
    const { asks } = saved(mergeTaskAsks({ asks: kept }, [{ ask: "One more", status: "open" }, { ask: "And another", status: "open" }], NOW));
    expect(asks.map((item) => item.id)).toEqual([...Array.from({ length: 38 }, (_, index) => `A${index + 3}`), "A41", "A42"]);
    const open = Array.from({ length: 40 }, (_, index) => ask(index + 1));
    const forty = saved(mergeTaskAsks({ asks: open }, [{ ask: "The 41st", status: "open" }], NOW));
    expect(forty.asks.map((item) => item.id)).toEqual(Array.from({ length: 41 }, (_, index) => `A${index + 1}`));
    expect(forty.note).toBe("Asks saved: added A41; 41 open.");
    let many: TaskAsk[] = forty.asks;
    for (let index = 42; index <= 100; index += 1) many = saved(mergeTaskAsks({ asks: many }, [{ ask: `ask ${index}`, status: "open" }], NOW)).asks;
    expect(many).toHaveLength(100);
    expect(many.at(-1)).toMatchObject({ id: "A100", ask: "ask 100", status: "open" });
  });

  it("never gives a closed id that fell off to a new ask", () => {
    const open = Array.from({ length: 41 }, (_, index) => ask(index + 1));
    const closed = saved(mergeTaskAsks({ asks: open }, [{ id: "A41", status: "done" }], NOW));
    expect(closed.asks.map((item) => item.id)).not.toContain("A41");
    const added = saved(mergeTaskAsks(closed, [{ ask: "A new one", status: "open" }], NOW));
    expect(added.asks.at(-1)).toMatchObject({ id: "A42", ask: "A new one" });
    expect(addQuestionAsk(added, "Ship it?", [], NOW)?.asks.at(-1)?.id).toBe("A43");
    expect(mergeTaskAsks(added, [{ id: "A41", status: "building" }], NOW)).toEqual({ error: expect.stringMatching(/^Unknown ask id A41\./) });
  });

  it("lists 300 full-length asks on every path that carries the list", () => {
    const open = Array.from({ length: 300 }, (_, index) => ask(index + 1, { ask: "가".repeat(80), ref: "r".repeat(80) }));
    const old = open.map(({ ref: _, ...item }) => ({ ...item, changedAt: NOW - 4 * DAY }));
    expect(listed(asksBlock(open, NOW))).toHaveLength(300);
    expect(listed(asksNudge(open, NOW, "status?"))).toHaveLength(300);
    expect(listed(asksNudge(old, NOW, "thanks"))).toHaveLength(300);
    expect(listed(taskRecordBlock(record(open), 6_000, { now: NOW }))).toHaveLength(300);
    expect(rotatedAsks(open, NOW)).toBeNull();
    expect(asksBlock(open, NOW).split("\n")[0]).toBe("[Wink asks list - 300 open.]");
  });

  it("rotates least recently shown first past the byte ceiling and counts the rest in the header", () => {
    const open = Array.from({ length: 600 }, (_, index) => ask(index + 1, { ask: "가".repeat(80), ref: "r".repeat(80) }));
    const first = asksBlock(open, NOW);
    const shown = listed(first);
    expect(Buffer.byteLength(shown.join("\n"), "utf8")).toBeLessThanOrEqual(MAX_STATUS_ASKS_BYTES);
    expect(first.split("\n")[0]).toBe(`[Wink asks list - 600 open. ${600 - shown.length} more wait for the next turn, least recently shown first.]`);
    const ids = rotatedAsks(open, NOW)!;
    expect(ids).toEqual(shown.map((line) => line.split(" ")[1]));
    const stamped = open.map((item) => ids.includes(item.id) ? { ...item, shown: NOW } : item);
    const next = listed(asksBlock(stamped, NOW + 1)).map((line) => line.split(" ")[1]);
    expect(next).toEqual(expect.arrayContaining(open.filter((item) => !ids.includes(item.id)).map((item) => item.id)));
    expect(new Set([...ids, ...next]).size).toBe(600);
  });

  it("keeps parked asks under the byte ceiling and rotates them with the open ones", () => {
    const parked = Array.from({ length: 1_000 }, (_, index) => ask(index + 1, { ask: "가".repeat(80), until: NOW + DAY + index }));
    for (const block of [asksBlock(parked, NOW), asksNudge(parked, NOW, "status?")]) {
      expect(Buffer.byteLength(listed(block).join("\n"), "utf8")).toBeLessThanOrEqual(MAX_STATUS_ASKS_BYTES);
    }
    const ids = rotatedAsks(parked, NOW)!;
    expect(ids).toEqual(listed(asksBlock(parked, NOW)).map((line) => line.split(" ")[1]));
    const next = listed(asksBlock(parked.map((item) => ids.includes(item.id) ? { ...item, shown: NOW } : item), NOW + 1)).map((line) => line.split(" ")[1]);
    expect(next[0]).not.toBe(ids[0]);
  });

  it.each(["open", "building", "waiting-for-user"] as const)("flags a %s ask with no ref and no change for 3 days as needing a verdict", (status) => {
    const fresh = ask(1, { status, changedAt: NOW - ASK_VERDICT_MS + 1 });
    const due = ask(2, { status, changedAt: NOW - ASK_VERDICT_MS });
    const block = asksBlock([fresh, due], NOW);
    expect(block).toContain(`- A2 ${status} needs verdict 11-12`);
    expect(block).toContain(`- A1 ${status} 11-12`);
    expect(asksNudge([fresh], NOW, "thanks")).toBe("");
    expect(listed(asksNudge([fresh, due], NOW, "thanks"))).toEqual([`- A2 ${status} needs verdict 11-12: ask number 2`]);
  });

  it("flags a waiting-for-user ask with a ref and no change for 3 days, to check whether the user already did their part", () => {
    const waiting = ask(1, { status: "waiting-for-user", ref: "VM ready", changedAt: NOW - 4 * DAY });
    expect(listed(asksNudge([waiting], NOW, "thanks"))).toEqual(["- A1 waiting-for-user needs verdict 11-12: ask number 1 (VM ready)"]);
    expect(asksBlock([waiting], NOW)).toContain("1 needs a verdict: no ref and no change in 3+ days, or waiting on the user that long, so check whether the user already did their part, then build, park or close it yourself");
  });

  it("never flags a fresh waiting ask, an open or building ask with a ref, or a parked one", () => {
    for (const quiet of [
      ask(1, { status: "waiting-for-user", ref: "VM ready", changedAt: NOW - 2 * DAY }),
      ask(2, { status: "building", ref: "PR #3", changedAt: 0 }),
      ask(3, { ref: "PR #4", changedAt: 0 }),
      ask(4, { ref: "VM ready", until: NOW + DAY, changedAt: 0 }),
    ]) expect(asksNudge([quiet], NOW, "thanks"), quiet.id).toBe("");
  });

  it("brings the newest asks waiting on the user to a typed reply, so a bare done reaches the one they finished", () => {
    const vm = ask(1, { ask: "Set up the teacher VM", status: "waiting-for-user", ref: "VM ready; his logins", changedAt: NOW - 2 * DAY });
    expect(asksNudge([vm], NOW, "done", [], true).split("\n")).toEqual([
      "[Wink asks waiting on the user - 1 open, newest first. If this message finishes or answers one, update it by ID and go on; otherwise leave them alone and do not nag.]",
      "- A1 waiting-for-user 11-12: Set up the teacher VM (VM ready; his logins)",
    ]);
    expect(asksNudge([vm], NOW, "done")).toBe("");
    expect(asksNudge([vm], NOW, "status?", [], true)).not.toContain("waiting on the user -");
    const many = Array.from({ length: 30 }, (_, index) => ask(index + 1, { status: "waiting-for-user", ref: "VM ready", changedAt: NOW - DAY + index }));
    expect(asksNudge(many, NOW, "done", [], true).split("\n").slice(1)).toEqual(["- A30 waiting-for-user 11-12: ask number 30 (VM ready)", "- A29 waiting-for-user 11-12: ask number 29 (VM ready)", "- A28 waiting-for-user 11-12: ask number 28 (VM ready)", "- +27 more waiting on the user; a status question lists them"]);
  });

  it("shows at most 3 stale waiting asks for a verdict on an ordinary turn, and every one on a status question", () => {
    const many = Array.from({ length: 30 }, (_, index) => ask(index + 1, { status: "waiting-for-user", ref: "VM ready", changedAt: NOW - 4 * DAY }));
    for (const typed of [false, true]) {
      const block = asksNudge(many, NOW, "thanks", [], typed);
      expect(listed(block).filter((line) => line.includes("needs verdict"))).toEqual(["- A1 waiting-for-user needs verdict 11-12: ask number 1 (VM ready)", "- A2 waiting-for-user needs verdict 11-12: ask number 2 (VM ready)", "- A3 waiting-for-user needs verdict 11-12: ask number 3 (VM ready)"]);
      expect(block).toContain("30 need a verdict");
      expect(block).toContain(" 27 more show on a status question.");
      expect(listed(block)).toHaveLength(typed ? 6 : 3);
    }
    expect(listed(asksNudge(many, NOW, "status?"))).toHaveLength(30);
    const stale = Array.from({ length: 5 }, (_, index) => ask(index + 1, { changedAt: NOW - 4 * DAY }));
    expect(listed(asksNudge(stale, NOW, "thanks"))).toHaveLength(5);
  });

  it("keeps a building ask with a ref and a parked one out of a typed reply", () => {
    for (const quiet of [ask(1, { status: "building", ref: "PR #3", changedAt: 0 }), ask(2, { ref: "VM ready", until: NOW + DAY, changedAt: 0 })]) {
      expect(asksNudge([quiet], NOW, "done", [], true), quiet.id).toBe("");
    }
  });

  it("keeps the verdict nudge on an engine's own ask worded as a question, and spares only a filed leftover", () => {
    const own = ask(1, { ask: "Could you fix the login redirect?", changedAt: NOW - ASK_VERDICT_MS });
    expect(listed(asksNudge([own], NOW, "thanks"))).toEqual(["- A1 open needs verdict 11-12: Could you fix the login redirect?"]);
    const filed = fileLeftovers({ asks: [], lastAskId: 0 }, [{ ask: "Could you fix the login redirect?" }], NOW - ASK_VERDICT_MS)!.asks[0]!;
    expect(asksBlock([{ ...filed, shown: NOW - ASK_VERDICT_MS }], NOW)).not.toContain("needs verdict");
  });

  it("never takes a path in another case for a repeat of an ask filed without a key", () => {
    const done = ask(1, { ask: "Could you fix src/Header.ts?", status: "done" });
    const added = fileLeftovers({ asks: [done], lastAskId: 1 }, [{ ask: "Could you fix src/header.ts?" }, { ask: "Could you fix src/Header.ts" }], NOW);
    expect(added?.asks.map((item) => item.ask)).toEqual(["Could you fix src/Header.ts?", "Could you fix src/header.ts?"]);
    expect(fileLeftovers({ asks: [ask(1, { ask: "COULD you fix the Header" })], lastAskId: 1 }, [{ ask: "could you fix the header." }], NOW), "plain words still match in any case").toBeNull();
  });

  it("lists only the asks needing a verdict on an ordinary turn, and the full list on a status turn or a fresh session", () => {
    const asks = [...Array.from({ length: 20 }, (_, index) => ask(index + 1)), ask(21, { changedAt: 0 })];
    expect(asksNudge(asks, NOW, "thanks").split("\n")).toEqual([
      "[Wink asks list - 21 open, 1 needs a verdict: no ref and no change in 3+ days, so build, park or close it yourself, and ask the user about at most 3 at a time. 20 more show on a status question.]",
      "- A21 open needs verdict 11-12: ask number 21",
    ]);
    expect(asksNudge(asks.slice(0, 20), NOW, "thanks")).toBe("");
    expect(listed(asksNudge(asks, NOW, "status?"))).toHaveLength(21);
    const backlog = Array.from({ length: 1_000 }, (_, index) => ask(index + 1, { ask: "가".repeat(80), changedAt: 0 }));
    expect(Buffer.byteLength(listed(asksNudge(backlog, NOW, "thanks")).join("\n"), "utf8")).toBeLessThanOrEqual(MAX_STATUS_ASKS_BYTES);
    expect(listed(taskRecordBlock(record(asks), 6_000, { now: NOW }))).toHaveLength(21);
    const header = [...asks.slice(0, 20), ask(22, { ask: "make the header smaller on phone" }), ask(21, { changedAt: 0 })];
    expect(listed(asksNudge(header, NOW, "the header on phone"))).toEqual(["- A21 open needs verdict 11-12: ask number 21", "- A22 open 11-12: make the header smaller on phone"]);
  });

  it("never flags or lists a closed ask", () => {
    const old = [ask(1, { status: "done", changedAt: 0 }), ask(2, { status: "declined", changedAt: 0 })];
    expect(asksBlock(old, NOW)).toBe("");
    expect(asksBlock(undefined, NOW)).toBe("");
    expect(asksNudge(old, NOW, "status?")).toBe("");
  });

  it("lists asks needing a verdict first, then the oldest, every one of them", () => {
    const asks = [...Array.from({ length: 6 }, (_, index) => ask(index + 1)), ask(7, { changedAt: 0 })];
    expect(asksBlock(asks, NOW).split("\n")).toEqual([
      "[Wink asks list - 7 open, 1 needs a verdict: no ref and no change in 3+ days, so build, park or close it yourself, and ask the user about at most 3 at a time.]",
      "- A7 open needs verdict 11-12: ask number 7",
      ...[1, 2, 3, 4, 5, 6].map((id) => `- A${id} open 11-12: ask number ${id}`),
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
    expect(tokens(asksBlock(list(30), NOW))).toBeLessThanOrEqual(700);
    expect(tokens(asksBlock(list(30), NOW, true))).toBeLessThanOrEqual(700);
  });

  describe("cleanup", () => {
    const parkedAsk = (id: number, until: number, overrides: Partial<TaskAsk> = {}) => ask(id, { until, ...overrides });
    const NOV = (day: number) => new Date(2026, 10, day).getTime();

    it("adds nothing for an empty list", () => {
      expect(asksBlock([], NOW)).toBe("");
      expect(asksNudge([], NOW, "status?")).toBe("");
      expect(asksNudge([], NOW, "thanks")).toBe("");
      expect(rotatedAsks([], NOW)).toBeNull();
    });

    it("lists a single ask in full", () => {
      expect(asksNudge([ask(1, { ref: "PR #9" })], NOW, "status?")).toBe("[Wink asks list - 1 open. Build any summary or status from this list.]\n- A1 open 11-12: ask number 1 (PR #9)");
    });

    it("parks an ask with a required until date, saved as open so the user's screen shows it as before", () => {
      expect(mergeTaskAsks({ asks: [ask(1)] }, [{ id: "A1", status: "parked" }], NOW)).toEqual({ error: "A parked ask needs until, the future date it comes back, like 2026-12-01." });
      expect(mergeTaskAsks({ asks: [ask(1)] }, [{ id: "A1", status: "parked", until: "2026-11-01" }], NOW)).toEqual({ error: expect.stringMatching(/^A parked ask needs until/) });
      expect(mergeTaskAsks({ asks: [ask(1)] }, [{ id: "A1", status: "parked", until: "soon" }], NOW)).toEqual({ error: expect.stringMatching(/^A parked ask needs until/) });
      const parked = saved(mergeTaskAsks({ asks: [ask(1), ask(2)] }, [{ id: "A1", status: "parked", until: "2026-11-15" }, { ask: "Renew the domain", status: "parked", until: "2026-11-20T09:00:00" }], NOW));
      expect(parked.asks[0]).toEqual(ask(1, { status: "open", until: NOV(15), changedAt: NOW }));
      expect(parked.asks[2]).toMatchObject({ id: "A3", status: "open", until: new Date(2026, 10, 20, 9).getTime() });
      expect(parked.note).toBe("Asks saved: added A3; 1 open, 2 parked.");
      expect(asksBlock(parked.asks, NOW).split("\n")).toEqual(["[Wink asks list - 1 open.]", "- A2 open 11-12: ask number 2", "- A1 parked back 11-15: ask number 1", "- A3 parked back 11-20: Renew the domain"]);
      const back = saved(mergeTaskAsks(parked, [{ id: "A1", status: "building" }], NOW));
      expect(back.asks[0]).not.toHaveProperty("until");
    });

    it("shows only the parked lines when every ask is parked, and never nags an ordinary turn", () => {
      const asks = [parkedAsk(1, NOV(20), { changedAt: 0 }), parkedAsk(2, NOV(14), { changedAt: 0 })];
      expect(asksNudge(asks, NOW, "status?").split("\n")).toEqual(["[Wink asks list - 0 open. Build any summary or status from this list.]", "- A2 parked back 11-14: ask number 2", "- A1 parked back 11-20: ask number 1"]);
      expect(asksNudge(asks, NOW, "thanks")).toBe("");
    });

    it("brings a parked ask back as open on its date, with its verdict clock started then", () => {
      const asks = [parkedAsk(1, NOV(12), { changedAt: NOW - 30 * DAY }), parkedAsk(2, NOV(20))];
      expect(asksBlock(asks, NOW).split("\n")).toEqual(["[Wink asks list - 1 open.]", "- A1 open 11-12: ask number 1", "- A2 parked back 11-20: ask number 2"]);
      expect(asksBlock(asks, NOV(15) + 1)).toContain("- A1 open needs verdict 11-12: ask number 1");
      expect(saved(mergeTaskAsks({ asks }, [{ ask: "One more", status: "open" }], NOW)).note).toBe("Asks saved: added A3; 2 open, 1 parked.");
    });

    it("merges an exact repeat of an open ask and says so", () => {
      const first = saved(mergeTaskAsks(undefined, [{ ask: "Show every open ask in the asks list", status: "open" }], NOW - HOUR));
      const again = saved(mergeTaskAsks(first, [{ ask: "show every OPEN ask in the  asks list", status: "building", ref: "PR #2000" }], NOW));
      expect(again.asks).toEqual([{ id: "A1", ask: "Show every open ask in the asks list", status: "building", ref: "PR #2000", at: NOW - HOUR, changedAt: NOW }]);
      expect(again.note).toBe("Asks saved: merged into A1; 1 open.");
      const other = saved(mergeTaskAsks({ asks: [ask(1, { ask: "Fix the login redirect" })] }, [{ ask: "Fix the logout redirect", status: "open" }], NOW));
      expect(other.note).toBe("Asks saved: added A2; 2 open.");
      expect(saved(mergeTaskAsks({ asks: [ask(1, { ask: "Fix the login redirect", status: "done" })] }, [{ ask: "fix the login redirect", status: "open" }], NOW)).note).toBe("Asks saved: added A2; 1 open.");
    });

    it("shows a parked ask in words and merges a repeat into it", () => {
      const glasses = parkedAsk(961, NOV(25), { ask: "glasses prompter demo" });
      expect(asksBlock([glasses], NOW)).toContain("- A961 parked back 11-25: glasses prompter demo");
      const again = saved(mergeTaskAsks({ asks: [glasses] }, [{ ask: "Glasses prompter demo", status: "parked", until: "2026-11-25" }], NOW));
      expect(again.asks).toHaveLength(1);
      expect(again.note).toBe("Asks saved: merged into A961; 0 open, 1 parked.");
    });

    it("brings the asks an ordinary turn names, and nothing when it names none", () => {
      const asks = [ask(1, { ask: "make the header smaller on phone" }), ask(2, { ask: "add dark mode to settings" }), parkedAsk(3, NOV(20), { ask: "email export for the report" })];
      const header = asksNudge(asks, NOW, "what did I ask you to change on the header?");
      expect(header.split("\n")).toEqual(["[Wink asks the user's message names - 1 of 3 open; a status question lists them all.]", "- A1 open 11-12: make the header smaller on phone"]);
      expect(asksNudge(asks, NOW, "when does the email export come back?")).toContain("- A3 parked back 11-20: email export for the report");
      expect(asksNudge(asks, NOW, "thanks")).toBe("");
      expect(asksNudge(asks, NOW, "ok do the next thing")).toBe("");
      expect(tokens(header)).toBeLessThanOrEqual(45);
    });

    it("names an ask by the words in its ref too", () => {
      const vm = ask(1, { ask: "Tell me when the setup is finished", status: "waiting-for-user", ref: "VM ready; his logins" });
      expect(listed(asksNudge([vm, ask(2)], NOW, "logins finished"))).toEqual(["- A1 waiting-for-user 11-12: Tell me when the setup is finished (VM ready; his logins)"]);
    });

    it("names at most 3 asks in about 100 tokens, and never on a word many asks share", () => {
      const asks = [
        ...["alpha bravo one", "alpha bravo two", "alpha bravo three"].map((words, index) => ask(index + 1, { ask: `ship the ${words} header` })),
        ...["charlie delta one", "charlie delta two", "charlie delta three"].map((words, index) => ask(index + 4, { ask: `ship the ${words} header` })),
      ];
      const named = asksNudge(asks, NOW, "where are the alpha bravo and charlie delta headers?");
      expect(listed(named).length).toBeGreaterThan(0);
      expect(listed(named).length).toBeLessThanOrEqual(3);
      expect(tokens(named)).toBeLessThanOrEqual(100);
      expect(asksNudge(asks, NOW, "what did I ask you to change on the header?")).toBe("");
      expect(asksNudge(asks, NOW, "ship the alpha build tonight")).toBe("");
    });

    it("clips a named ask too long for the budget instead of dropping it", () => {
      const title = "가나다라마바사아자차".repeat(8);
      const named = asksNudge([ask(1, { ask: title }), ask(2)], NOW, title);
      expect(named).toContain("- A1 open 11-12: 가나다라마바사아자차");
      expect(Buffer.byteLength(named, "utf8")).toBeLessThanOrEqual(300);
      expect(asksNudge([ask(1, { ask: "make the header smaller on phone" })], NOW, "the header on phone")).toContain("- A1 open 11-12: make the header smaller on phone\n".trimEnd());
    });

    it("brings the bot's asks from its other chats, without their ids", () => {
      const elsewhere = [ask(1, { ask: "make the header smaller on phone" }), parkedAsk(2, NOV(20), { ask: "email export for the report" })];
      expect(asksNudge(undefined, NOW, "what's left?", elsewhere).split("\n")).toEqual([
        "[Wink asks from the user's other chats with you - 2; update them in that chat.]",
        "- open 11-12: make the header smaller on phone",
        "- parked back 11-20: email export for the report",
      ]);
      expect(asksNudge([ask(3)], NOW, "the header please", elsewhere)).toContain("- open 11-12: make the header smaller on phone");
      expect(asksNudge([ask(3)], NOW, "thanks", elsewhere)).toBe("");
    });

    it("lists every ask in a room thread on a status turn, and only the one needing a verdict otherwise", () => {
      const room = Array.from({ length: 300 }, (_, index) => ask(index + 1, { ask: "r".repeat(80), changedAt: index ? NOW : NOW - 4 * DAY }));
      expect(listed(asksNudge(room, NOW, "@Bot where are we?"))).toHaveLength(300);
      expect(listed(asksNudge(room, NOW, "@Bot thanks"))).toEqual([`- A1 open needs verdict 11-12: ${"r".repeat(80)}`]);
      expect(listed(taskRecordBlock(record(room), 512, { now: NOW, allAsks: true }))).toHaveLength(300);
    });

    it("lists every ask in a fresh session after compaction, where the record rides", () => {
      const asks = Array.from({ length: 300 }, (_, index) => ask(index + 1, { ask: "c".repeat(80), ref: "PR #1" }));
      const block = taskRecordBlock(record(asks), 512, { now: NOW });
      expect(listed(block)).toHaveLength(300);
      expect(block).toContain("[Wink asks list - 300 open.]");
      expect(taskRecordBlock(record(asks), 512, { now: NOW, recovering: true, latestUserText: "continue" })).toContain(`${listed(block).at(-1)}`);
    });

    it("shows an ask edited mid-turn with its new words and status on the next list", () => {
      const before = [ask(1), ask(2)];
      expect(asksBlock(before, NOW)).toContain("- A1 open 11-12: ask number 1");
      const edited = saved(mergeTaskAsks({ asks: before }, [{ id: "A1", ask: "ask number one, reworded", status: "building", ref: "card X" }], NOW)).asks;
      expect(asksBlock(edited, NOW + 1).split("\n")).toEqual(["[Wink asks list - 2 open.]", "- A1 building 11-12: ask number one, reworded (card X)", "- A2 open 11-12: ask number 2"]);
    });

    it("never merges asks whose key words differ, even when most words match", () => {
      const french = saved(mergeTaskAsks(undefined, [{ ask: "Translate settings page into French", status: "open" }], NOW));
      const german = saved(mergeTaskAsks(french, [{ ask: "Translate settings page into German", status: "open" }], NOW));
      expect(german.note).toBe("Asks saved: added A2; 2 open.");
      expect(german.asks.map((item) => item.ask)).toEqual(["Translate settings page into French", "Translate settings page into German"]);
    });

    it("never merges two asks with the same words in another order", () => {
      const first = saved(mergeTaskAsks(undefined, [{ ask: "move header above footer", status: "open" }], NOW));
      const flipped = saved(mergeTaskAsks(first, [{ ask: "move footer above header", status: "open" }], NOW));
      expect(flipped.asks.map((item) => [item.id, item.ask, item.status])).toEqual([["A1", "move header above footer", "open"], ["A2", "move footer above header", "open"]]);
      expect(flipped.note).toBe("Asks saved: added A2; 2 open.");
    });

    it("merges a repeat into a parked ask, and the repeat's status wins", () => {
      const parked = saved(mergeTaskAsks(undefined, [{ ask: "Renew the domain", status: "parked", until: "2026-12-01" }], NOW));
      const again = saved(mergeTaskAsks(parked, [{ ask: "renew  the DOMAIN", status: "building" }], NOW));
      expect(again.asks).toHaveLength(1);
      expect(again.asks[0]).toMatchObject({ id: "A1", ask: "Renew the domain", status: "building" });
      expect(again.asks[0]).not.toHaveProperty("until");
      expect(again.note).toBe("Asks saved: merged into A1; 1 open.");
    });

    it("tells every bot the list is whole, how to park, that repeats merge and how to judge an old ask", () => {
      expect(TASK_ASKS_PROMPT).toContain("Wink lists every open ask in a fresh session and on a status question, otherwise the asks the user's words name and, on a message the user typed, the newest asks waiting on them, and merges a repeat into the ask it matches.");
      expect(TASK_ASKS_PROMPT).toContain("Park an ask with until when it waits on a date.");
      expect(TASK_ASKS_PROMPT).toContain("An ask with no ref, or waiting on the user, and no change in 3 days needs your verdict: build it (helper or time), park it or close it yourself, and ask the user about at most 3 at a time.");
      expect(TASK_ASKS_PROMPT).not.toMatch(/6\+? hours|raise them with the user now/);
    });
  });

  describe("skipped questions", () => {
    const question = (id: number, overrides: Partial<TaskAsk> = {}) => ask(id, { ask: `question ${id}?`, kind: "question", choices: "Yes / No", ...overrides });
    const GUIDE = " A question is your own card still unanswered on the user's screen: never re-ask it; close moot or answered ones.";

    it("files a skipped card as an open question with its choices, clipped to the ask limits", () => {
      expect(addQuestionAsk({ asks: [ask(1)] }, "  Ship   it now?  ", ["Ship", "Wait"], NOW)).toEqual({ asks: [
        ask(1),
        { id: "A2", ask: "Ship it now?", status: "open", kind: "question", choices: "Ship / Wait", at: NOW, changedAt: NOW },
      ], lastAskId: 2 });
      const [long] = addQuestionAsk(undefined, "q".repeat(500), ["c".repeat(200)], NOW)!.asks;
      expect(long).toMatchObject({ ask: `${"q".repeat(79)}…`, choices: `${"c".repeat(79)}…` });
      expect(addQuestionAsk(undefined, "Free text?", [], NOW)!.asks[0]).not.toHaveProperty("choices");
    });

    it("dedupes by words against open asks, and files again once the old one closed", () => {
      expect(addQuestionAsk({ asks: [question(1, { ask: "Ship it?" })] }, "ship  IT?", [], NOW)).toBeNull();
      expect(addQuestionAsk({ asks: [question(1, { ask: "Ship it?", status: "done" })] }, "Ship it?", [], NOW)?.asks.map((item) => item.id)).toEqual(["A1", "A2"]);
    });

    it("drops the oldest closed ask past 40 and files past 40 open", () => {
      const kept = Array.from({ length: 40 }, (_, index) => ask(index + 1, { status: index < 2 ? "done" : "open" }));
      expect(addQuestionAsk({ asks: kept }, "One more?", [], NOW)?.asks.map((item) => item.id)).toEqual([...Array.from({ length: 39 }, (_, index) => `A${index + 2}`), "A41"]);
      const open = Array.from({ length: 40 }, (_, index) => ask(index + 1));
      expect(addQuestionAsk({ asks: open }, "One more?", [], NOW)?.asks.map((item) => item.id)).toEqual(Array.from({ length: 41 }, (_, index) => `A${index + 1}`));
    });

    it("keeps every open question, so they never block the bot's own asks", () => {
      const questions = Array.from({ length: 10 }, (_, index) => question(index + 1));
      expect(addQuestionAsk({ asks: questions }, "One more?", [], NOW)?.asks.map((item) => item.id)).toEqual(Array.from({ length: 11 }, (_, index) => `A${index + 1}`));
      const full = [...questions, ...Array.from({ length: 30 }, (_, index) => ask(index + 11))];
      const { asks } = saved(mergeTaskAsks({ asks: full }, [{ ask: "One more", status: "open" }], NOW));
      expect(asks.map((item) => item.id)).toEqual(Array.from({ length: 41 }, (_, index) => `A${index + 1}`));
    });

    it("lets the bot close a question with the usual asks update", () => {
      const { asks } = saved(mergeTaskAsks({ asks: [question(1)] }, [{ id: "A1", status: "declined" }], NOW));
      expect(asks).toEqual([question(1, { status: "declined", changedAt: NOW })]);
      expect(asksBlock(asks, NOW, true)).toBe("");
    });

    it("takes back a question filed for the card just answered and closes an older one", () => {
      expect(answerQuestionAsk([question(1, { at: NOW })], "question 1?", NOW, NOW)).toEqual([]);
      expect(answerQuestionAsk([question(1)], "Question 1?", NOW, NOW)).toEqual([question(1, { status: "done", changedAt: NOW })]);
      expect(answerQuestionAsk([ask(1, { ask: "question 1?" })], "question 1?", NOW, NOW)).toBeNull();
    });

    it("lists questions after the user's asks, never needing a verdict, with the re-ask line", () => {
      const asks = [question(1, { changedAt: 0 }), ask(2)];
      expect(asksBlock(asks, NOW, true).split("\n")).toEqual([
        `[Wink asks list - 2 open. Build any summary or status from this list.${GUIDE}]`,
        "- A2 open 11-12: ask number 2",
        "- A1 open question 11-12: question 1? (choices: Yes / No)",
      ]);
      expect(asksNudge(asks, NOW, "thanks")).toBe("");
      expect(listed(asksBlock([ask(1, { changedAt: 0 }), ...Array.from({ length: 4 }, (_, index) => ask(index + 2)), question(9)], NOW)).at(-1)).toBe("- A9 open question 11-12: question 9? (choices: Yes / No)");
    });

    it("adds nothing to an ordinary turn and stays small on a status turn", () => {
      const list = (count: number) => Array.from({ length: count }, (_, index) => question(index + 1, {
        ask: "Should the model picker row keep the old look?",
        choices: "Keep / New look / Ask me later",
        changedAt: 0,
      }));
      expect([0, 5, 30].map((count) => tokens(asksNudge(list(count), NOW, "fix the login bug")))).toEqual([0, 0, 0]);
      expect(tokens(asksBlock(list(30), NOW))).toBeLessThanOrEqual(1_250);
      expect(tokens(asksNudge(list(5), NOW, "status?"))).toBeLessThanOrEqual(260);
      expect(tokens(asksNudge(list(30), NOW, "status?"))).toBeLessThanOrEqual(1_250);
    });
  });
});
