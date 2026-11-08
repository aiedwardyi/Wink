import { describe, expect, it, vi } from "vitest";

import type { RateLimitWindow } from "./contracts.ts";
import { createSpawnUsage } from "./spawn-usage.ts";

const NOW = Date.parse("2026-11-07T00:00:00Z");

function check(command: string, windows: RateLimitWindow[]) {
  const instanceId = command.startsWith("claude") ? "claude" : command.startsWith("agy") ? "antigravity" : "codex";
  return createSpawnUsage({ rateLimits: new Map([[instanceId, { observedAt: new Date(NOW).toISOString(), windows }]]),
    save() {}, refresh: vi.fn(async () => ({})), environment: () => ({}), now: () => NOW })("bot", "task", command);
}

describe("shared quota regressions", () => {
  it.each([null, NOW - 1])("retains a low window with reset %s", async (resetsAt) => {
    expect(await check("codex --model gpt-6.1-sol", [{ id: "five_hour", usedPercent: 96, resetsAt }])).toHaveProperty("hold");
  });

  it("holds below the precise session threshold before display rounding", async () => {
    expect(await check("codex --model gpt-6.1-sol", [{ id: "five_hour", usedPercent: 75.01, resetsAt: NOW + 60_000 }])).toHaveProperty("hold");
  });

  it("holds a model-specific Claude week", async () => {
    expect(await check("claude --model claude-opus-5-5", [
      { id: "seven_day", usedPercent: 10, resetsAt: null },
      { id: "seven_day_opus", usedPercent: 99, resetsAt: null },
    ])).toHaveProperty("hold");
  });

  it("recognizes a binding Gemini daily cap", async () => {
    expect(await check("agy --model gemini-3.8-flash-high", [{ id: "daily", usedPercent: 91, resetsAt: null, windowMinutes: 1440 }])).toHaveProperty("hold");
  });

  it("recognizes a binding named Codex bucket", async () => {
    expect(await check("codex --model gpt-5.3-codex-spark", [{ id: "spark:five_hour", usedPercent: 99, resetsAt: null, windowMinutes: 300 }])).toHaveProperty("hold");
  });

  it.each([{ windows: [] }, { windows: [{ id: "five_hour", usedPercent: NaN, resetsAt: null }] }])("does not clear known low after a missing or invalid refresh %j", async ({ windows }) => {
    const previous = { observedAt: new Date(NOW - 600_000).toISOString(), windows: [{ id: "five_hour", usedPercent: 99, resetsAt: NOW - 1 }] };
    const usage = createSpawnUsage({ rateLimits: new Map([["codex", previous]]), save() {}, refresh: async () => ({ report: { observedAt: new Date(NOW).toISOString(), windows } }), environment: () => ({}), now: () => NOW });
    expect(await usage("bot", "task", "codex --model gpt-6.1-sol")).toHaveProperty("hold");
  });
});
