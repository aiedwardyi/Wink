import { expect, it } from "vitest";

import { antigravityRateLimitWindows, claudeRateLimitWindows, codexRateLimitWindows, grokRateLimitWindows } from "./drivers/rate-limits.ts";
import { createUsageRefresh } from "./usage-refresh.ts";

it("preserves provider precision across the session and weekly admission thresholds", () => {
  expect(codexRateLimitWindows({ primary: { usedPercent: 75.01, windowDurationMins: 300 } })[0].usedPercent).toBe(75.01);
  expect(claudeRateLimitWindows({ rateLimitType: "five_hour", utilization: 0.7501 })[0].usedPercent).toBe(75.01);
  expect(grokRateLimitWindows({ config: { creditUsagePercent: 90.01, currentPeriod: { type: "WEEKLY", end: "2026-11-10T00:00:00Z" } } })[0].usedPercent).toBe(90.01);
  expect(antigravityRateLimitWindows({ "gemini-daily": { remaining_fraction: 0.0999 } })[0].usedPercent).toBeGreaterThan(90);
});

it("preserves the default named Codex bucket and an explicit bucket scope", () => {
  const snapshot = { limitId: "spark", primary: { usedPercent: 99, windowDurationMins: 300 } };
  expect(codexRateLimitWindows(snapshot)[0].id).toBe("spark:five_hour");
  expect(codexRateLimitWindows(snapshot, "spark")[0].id).toBe("spark:five_hour");
  expect(codexRateLimitWindows({ ...snapshot, limitId: "codex" })[0].id).toBe("five_hour");
});

it("refreshes named Codex buckets once without losing scope or adding a second prefix", async () => {
  const refresh = createUsageRefresh({ rpc: async () => ({
    rateLimits: { limitId: "spark", primary: { usedPercent: 99, windowDurationMins: 300 } },
    rateLimitsByLimitId: { spark: { limitId: "spark", primary: { usedPercent: 99, windowDurationMins: 300 } }, "gpt-6.1-sol": { limitId: "gpt-6.1-sol", secondary: { usedPercent: 20, windowDurationMins: 10080 } } },
  }) });
  const result = await refresh("codex", { instanceId: "fixture" });
  expect(result.error).toBeUndefined();
  expect(result.report?.windows.map((window) => window.id)).toEqual(["spark:five_hour", "gpt-6.1-sol:seven_day"]);
});
