import { describe, expect, it } from "vitest";

import { askPr, createAskPrs } from "./ask-prs.ts";
import type { TaskAsk } from "./task-asks.ts";
import { UNLANDED_REFRESH_MS } from "./unlanded.ts";

const ask = (id: number, overrides: Partial<TaskAsk> = {}): TaskAsk => ({ id: `A${id}`, ask: `ask ${id}`, status: "building", at: 1, changedAt: 1, ...overrides });

function rig(states: Record<string, string>, dir: string | null = "C:/repo") {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  let clock = 1_000;
  const prs = createAskPrs({
    repoDir: () => dir ?? undefined,
    now: () => clock,
    gh: async (cwd, args) => {
      calls.push({ cwd, args });
      const state = states[args[2]!];
      if (!state) throw new Error("no pull requests found");
      return JSON.stringify({ state });
    },
  });
  return { prs, calls, tick: (ms: number) => { clock += ms; } };
}

describe("ask PRs", () => {
  it.each([
    ["PR #1988", { number: 1988 }],
    ["pr 12", { number: 12 }],
    ["https://github.com/AiEdwardYi/Wink/pull/1988", { repo: "aiedwardyi/wink", number: 1988 }],
    ["card RELEASE", null],
    [undefined, null],
  ])("reads %j as %j", (ref, pr) => expect(askPr(ref)).toEqual(pr));

  it("closes a building ask once its PR merges, on the turn after the check", async () => {
    const { prs, calls } = rig({ "1988": "MERGED", "7": "OPEN" });
    const asks = [ask(1, { ref: "PR #1988" }), ask(2, { ref: "PR #7" }), ask(3, { status: "open", ref: "PR #1988" }), ask(4, { ref: "card X" })];
    expect(prs.take("bot", "thread", asks)).toEqual([]);
    await prs.settled();
    expect(calls).toEqual([
      { cwd: "C:/repo", args: ["pr", "view", "1988", "--json", "state"] },
      { cwd: "C:/repo", args: ["pr", "view", "7", "--json", "state"] },
    ]);
    expect(prs.take("bot", "thread", asks)).toEqual(["A1"]);
  });

  it("asks gh about a PR URL in its own repo and rechecks an open PR only after the refresh time", async () => {
    const { prs, calls, tick } = rig({ "5": "OPEN" }, null);
    const asks = [ask(1, { ref: "https://github.com/o/r/pull/5" }), ask(2, { ref: "PR #6" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(calls.map((call) => call.args)).toEqual([["pr", "view", "5", "--repo", "o/r", "--json", "state"]]);
    prs.take("bot", "thread", asks);
    tick(UNLANDED_REFRESH_MS - 1);
    prs.take("bot", "thread", asks);
    expect(calls).toHaveLength(1);
    tick(1);
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(calls).toHaveLength(2);
  });

  it("leaves the ask as it is when gh fails", async () => {
    const { prs } = rig({});
    const asks = [ask(1, { ref: "PR #404" })];
    prs.take("bot", "thread", asks);
    await prs.settled();
    expect(prs.take("bot", "thread", asks)).toEqual([]);
  });
});
