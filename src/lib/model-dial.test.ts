import { afterEach, describe, expect, it, vi } from "vitest";

import { dialRunCost, dialWheel } from "./model-dial";

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

describe("dialWheel", () => {
  afterEach(() => vi.unstubAllGlobals());

  const steps = (zoom: number, deltas: number[], gap: number) => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("window", { innerHeight: 800, devicePixelRatio: zoom });
    const burst = { at: 0, dir: 0, sum: 0 };
    return deltas.filter((delta) => {
      const stepped = dialWheel(burst, { deltaY: delta, deltaMode: 0 } as WheelEvent);
      now += gap;
      return stepped;
    }).length;
  };

  it.each([1, 1.2, 1.25, 1.5, 2])("steps a rolled mouse wheel every 130 ms at zoom %f", (zoom) => {
    const notch = Math.fround(100 / zoom);
    expect(steps(zoom, Array(10).fill(notch), 60)).toBe(4);
  });

  it("keeps a trackpad flick of whole-pixel deltas over 50 to one step", () => {
    expect(steps(1, [90, 86, 82, 78, 74, 70, 66, 62, 58, 54, 52, 50], 16)).toBe(1);
  });
});
