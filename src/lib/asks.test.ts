import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { askCounts, botAsks } from "./asks";

const task = (threadId: string, updatedAt: number, asks: unknown) => ({ threadId, taskState: { threadId, goal: "g", updatedAt, asks } });
const bot = (...tasks: unknown[]) => ({ id: "b", threadId: "t1", messages: [], tasks }) as unknown as Bot;

describe("botAsks", () => {
  it("reads asks from every task, oldest first", () => {
    const asks = botAsks(bot(
      task("t1", 5, [{ text: "Emoji on right-click", at: 20, status: "waiting-for-user", ref: "PR #12" }]),
      task("t2", 3, [{ text: "Picker style in Themes", at: 10, status: "building" }]),
    ));
    expect(asks).toEqual([
      { text: "Picker style in Themes", at: 10, status: "building" },
      { text: "Emoji on right-click", at: 20, status: "waiting-for-user", ref: "PR #12" },
    ]);
  });

  it("keeps one copy of an ask two tasks share, from the newest record", () => {
    const asks = botAsks(bot(
      task("t1", 9, [{ text: "Pinned room notice", at: 10, status: "done" }]),
      task("t2", 4, [{ text: "Pinned room notice", at: 10, status: "building" }]),
    ));
    expect(asks).toEqual([{ text: "Pinned room notice", at: 10, status: "done" }]);
  });

  it("takes ask/when keys, ISO times and underscored statuses", () => {
    const asks = botAsks(bot(task("t1", 1, [{ ask: "Dark sand skin", when: "2026-11-12T01:00:00.000Z", status: "waiting_for_user" }])));
    expect(asks).toEqual([{ text: "Dark sand skin", at: Date.parse("2026-11-12T01:00:00.000Z"), status: "waiting-for-user" }]);
  });

  it("skips malformed items and tasks without asks", () => {
    const asks = botAsks(bot(
      task("t1", 1, [{ text: "", at: 1, status: "open" }, { text: "x", at: 1, status: "maybe" }, null, "nope", { text: "Real", at: 2, status: "open" }]),
      task("t2", 1, "not a list"),
      { threadId: "t3" },
    ));
    expect(asks.map((each) => each.text)).toEqual(["Real"]);
  });

  it("is empty for a bot with no tasks", () => {
    expect(botAsks({ id: "b", threadId: "t", messages: [] } as unknown as Bot)).toEqual([]);
  });
});

describe("askCounts", () => {
  it("counts open, building and waiting as open; done and declined as closed", () => {
    const counts = askCounts((["open", "building", "waiting-for-user", "done", "declined", "done"] as const).map((status, at) => ({ text: String(at), at, status })));
    expect(counts).toEqual({ open: 3, closed: 3 });
  });
});
