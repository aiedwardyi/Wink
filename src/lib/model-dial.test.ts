import { describe, expect, it } from "vitest";

import { dialRunCost } from "./model-dial";

describe("dialRunCost", () => {
  it.each([["low", 0.55], ["medium", 1.34], ["high", 1.82], ["xhigh", 3.46]])("reads the Intelligence Index run cost at %s", (effort, cost) => {
    expect(dialRunCost("claude-opus-5-5", effort)).toBeCloseTo(cost, 2);
  });

  it.each([
    ["gemini-3.8-flash-low", undefined],
    ["claude-opus-5-5", "none"],
    ["unlisted-model", "high"],
    ["gpt-6-luna", "low"],
  ])("has no run cost for %s at %s", (model, effort) => {
    expect(dialRunCost(model, effort)).toBeUndefined();
  });

  it("takes a Gemini tier from the model id, not the effort", () => {
    expect(dialRunCost("gemini-3.8-flash-high", "low")).toBeCloseTo(1.24, 2);
    expect(dialRunCost("gemini-3.8-flash-medium", undefined)).toBeCloseTo(0.93, 2);
  });
});
