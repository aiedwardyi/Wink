import { describe, expect, it } from "vitest";

import { switchPlan } from "./claude-effort.ts";

const key = (model: string | null, effort?: string, extra: Partial<{ base: string | null; cwd: string }> = {}) => JSON.stringify({
  args: ["-p", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])],
  mcpServers: {},
  cwd: extra.cwd ?? "/w",
  model,
  base: extra.base ?? null,
});

describe("switchPlan", () => {
  it("moves model and effort, re-applying effort after a model switch", () => {
    expect(switchPlan(key("a", "max"), key("a", "high"))).toEqual({ effort: "high" });
    expect(switchPlan(key("a", "max"), key("b", "max"))).toEqual({ model: "b", effort: "max" });
    expect(switchPlan(key("a"), key("b"))).toEqual({ model: "b" });
  });

  it.each([
    ["the same contract", key("a", "max"), key("a", "max")],
    ["a base URL change", key("a", "max"), key("b", "max", { base: "http://127.0.0.1:1" })],
    ["any other change", key("a", "max"), key("b", "max", { cwd: "/other" })],
    ["an effort the process was spawned without", key("a"), key("a", "high")],
    ["a cleared effort", key("a", "high"), key("a")],
    ["a model the process was spawned without", key(null), key("a")],
    ["a cleared model", key("a"), key(null)],
  ])("respawns for %s", (_name, from, to) => {
    expect(switchPlan(from, to)).toBeNull();
  });
});
