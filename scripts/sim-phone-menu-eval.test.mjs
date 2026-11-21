import { expect, it } from "vitest";

import { phoneMenuRows } from "./sim-phone-menu-eval.mjs";

const trace = (input, lookup = 1) => ({
  spans: [{ phase: "prompt_build", start: 0, end: 10 }, { phase: "forum_lesson", start: 4, end: 4 + lookup }],
  marks: { first_visible_text: 25 },
  requests: [{ usage: { input, output: 20 } }],
});
const checks = { check: "passed", width: 392, opens: true, links: ["#hours", "#contact"] };
const seed = {
  build: "build", model: "model", historyCount: 0, fixtureHash: "fixture", requestHash: "request", memoryHash: "memory", status: "done", budget: 2,
  scope: { ordinary: 0, unrelated: 0, unbound: 0, sameName: 0, room: 0, deleted: 0, superseded: 0, repeat: 0 },
  before: { runId: "before", endedAt: 1, check: "missed" },
  after: { runId: "after", startedAt: 3, check: "passed" },
  lesson: { beforeRunId: "before", afterRunId: "after", predictedAt: 2, outcome: "fixed" },
};
const off = { ...seed, threadId: "thread-1", sessionId: "session-1", lessonOffered: false, traces: { ordinary: [trace(300)], matching: [trace(300)] }, cycles: [{ ...checks, opens: false }, checks] };
const on = { ...seed, threadId: "thread-2", sessionId: "session-2", lessonOffered: true, traces: { ordinary: [trace(300)], matching: [trace(350, 2)] }, cycles: [checks] };
const pair = { id: "same-model", off, on };

it("grades the paired fixture, including real input usage and the first working menu", () => {
  const rows = phoneMenuRows([pair]);
  const metric = name => rows.filter(row => row.metric === `sim/phoneMenu/${name}`).map(row => row.value);
  expect(metric("predictionOutcome")).toEqual([1, 1]);
  expect(metric("firstPass")).toEqual([0, 1]);
  expect(metric("repeatsBeforePass")).toEqual([1, 0]);
  expect(metric("scope")).toEqual([1, 1]);
  expect(metric("cost")).toEqual([1, 1]);
  expect(rows.find(row => row.metric.endsWith("/cost")).matching.samples[0]).toMatchObject({ inputTokens: 50, promptMs: 0, lookupMs: 1 });
});

it("keeps blocked, missing and mismatched pairs as rows without measurements", () => {
  for (const patch of [undefined, { status: "blocked", reason: "heavy lock" }, { ...on, memoryHash: "different" }]) {
    const rows = phoneMenuRows([{ ...pair, on: patch }]);
    expect(rows).toHaveLength(10);
    expect(rows.every(row => row.value === null && row.reason)).toBe(true);
  }
});

it("fails measured wrong-scope offers and token overruns", () => {
  const scope = { ...on.scope, sameName: 1 };
  const traces = { ...on.traces, matching: [trace(421)] };
  const rows = phoneMenuRows([{ ...pair, on: { ...on, scope, traces } }]);
  expect(rows.find(row => row.side === "on" && row.metric.endsWith("/scope")).value).toBe(0);
  expect(rows.find(row => row.side === "on" && row.metric.endsWith("/cost")).value).toBe(0);
});
