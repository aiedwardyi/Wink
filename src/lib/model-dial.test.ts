import { describe, expect, it } from "vitest";

import { dialRunCost } from "./model-dial";

describe("dialRunCost", () => {
  it.each([["low", 0.98], ["medium", 2.45], ["high", 3.46], ["xhigh", 6.05]])("reads the Intelligence Index run cost at %s", (effort, cost) => {
    expect(dialRunCost("claude-opus-5-5", effort)).toBeCloseTo(cost, 2);
  });

  it.each([
    ["gemini-3.8-flash-low", undefined],
    ["claude-opus-5-5", "none"],
    ["unlisted-model", "high"],
    ["grok-4.7", "medium"],
  ])("has no run cost for %s at %s", (model, effort) => {
    expect(dialRunCost(model, effort)).toBeUndefined();
  });

  it("takes a Gemini tier from the model id, not the effort", () => {
    expect(dialRunCost("gemini-3.8-flash-high", "low")).toBeCloseTo(7.77, 2);
    expect(dialRunCost("gemini-3.8-flash-medium", undefined)).toBeCloseTo(6.26, 2);
  });
});
