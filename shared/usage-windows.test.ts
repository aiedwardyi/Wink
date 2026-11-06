import { describe, expect, it } from "vitest";

import type { RateLimitWindow } from "../server/contracts.ts";
import { applicableWindows, assessUsage, windowKind, workerWindowLow } from "./usage-windows.ts";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const window = (id: string, usedPercent = 0, resetsAt: number | null = null, windowMinutes?: number): RateLimitWindow => ({ id, usedPercent, resetsAt, windowMinutes });
const evidence = (windows: RateLimitWindow[], at = NOW) => ({ observedAt: new Date(at).toISOString(), windows });

describe("applicable windows", () => {
  it.each<[string, string[]]>([
    ["claude-opus-5-5", ["five_hour", "seven_day", "seven_day_opus", "seven_day_new"]],
    ["claude-sonnet-5-5", ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_new"]],
    ["claude-haiku-5-5", ["five_hour", "seven_day", "seven_day_new"]],
    ["custom", ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_new"]],
  ])("keeps only binding Claude scopes for %s", (model, expected) => {
    const windows = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_new"].map((id) => window(id));
    expect(applicableWindows("claudeAgent", model, windows).map((item) => item.id)).toEqual(expected);
  });

  it("preserves Codex bucket identity and excludes only known unrelated scopes", () => {
    const windows = ["five_hour", "seven_day", "codex:seven_day", "spark:five_hour", "gpt-6-astra:seven_day", "new:primary"].map((id) => window(id));
    expect(applicableWindows("codex", "gpt-6.1-sol", windows).map((item) => item.id)).toEqual(["five_hour", "seven_day", "codex:seven_day", "new:primary"]);
    expect(applicableWindows("codex", "gpt-5.3-codex-spark", windows).map((item) => item.id)).toContain("spark:five_hour");
    expect(applicableWindows("codex", "gpt-6-astra", windows).map((item) => item.id)).toContain("gpt-6-astra:seven_day");
    expect(applicableWindows("codex", "", windows)).toHaveLength(6);
    expect(applicableWindows("codex", "gpt-6.1-sol", [window("gpt-6:five_hour", 99)])).toHaveLength(1);
    expect(assessUsage("codex", "gpt-6.1-sol", evidence([window("gpt-6:five_hour", 99)]), NOW)).toBe("low");
    expect(applicableWindows("claudeAgent", "custom-haiku", [window("seven_day_opus", 99)])).toHaveLength(1);
  });

  it.each(["antigravityAgent", "grokAgent", "museAgent"])("consumes actual normalized windows for %s", (engine) => {
    const windows = [window("five_hour", 2), window("seven_day", 3), window("daily", 4), window("primary", 5, null, 60)];
    expect(applicableWindows(engine, "model", windows)).toEqual(windows);
    expect(assessUsage(engine, "model", undefined, NOW)).toBe("unknown");
  });

  it.each([
    ["five_hour", 75, false], ["five_hour", 75.00001, true], ["seven_day", 90, false], ["seven_day", 90.00001, true],
    ["daily", 90, false], ["daily", 90.00001, true], ["primary", 90.1, true], ["five_hour", NaN, false], ["five_hour", -1, false],
  ] as const)("uses exact thresholds for %s at %s", (id, used, low) => expect(workerWindowLow(window(id, used))).toBe(low));

  it("uses normalized durations for named and nonstandard windows", () => {
    expect(windowKind(window("named:primary", 0, null, 10080))).toBe("weekly");
    expect(windowKind(window("named:primary", 0, null, 300))).toBe("session");
    expect(windowKind(window("daily", 0, null, 1440))).toBe("other");
  });
});

describe("quota evidence", () => {
  it.each([null, NOW - 1, NOW + 1])("keeps known low evidence regardless of reset %s", (reset) => {
    expect(assessUsage("codex", "gpt-6.1-sol", evidence([window("five_hour", 100, reset)], NOW - 6 * 60_000), NOW)).toBe("low");
  });

  it("requires a newer fresh matching read to clear known exhaustion", () => {
    const prior = evidence([window("five_hour", 100)], NOW - 10 * 60_000);
    for (const current of [undefined, evidence([]), evidence([window("seven_day", 0)]), evidence([window("five_hour", 0)], NOW - 6 * 60_000), evidence([window("five_hour", 0)], NOW + 1), evidence([window("five_hour", NaN)])]) {
      expect(assessUsage("codex", "gpt-6.1-sol", current, NOW, prior)).toBe("low");
    }
    expect(assessUsage("codex", "gpt-6.1-sol", evidence([window("five_hour", 0)]), NOW, prior)).toBe("ready");
  });

  it("keeps unknown scope and invalid/future/stale observations unknown", () => {
    expect(assessUsage("claudeAgent", "claude-opus-5-5", evidence([window("seven_day_new")]), NOW)).toBe("unknown");
    expect(assessUsage("codex", "gpt-6.1-sol", evidence([window("new:five_hour")]), NOW)).toBe("unknown");
    for (const at of [NOW + 1, NOW - 300001]) expect(assessUsage("codex", "gpt-6.1-sol", evidence([window("five_hour")], at), NOW)).toBe("unknown");
    for (const used of [NaN, Infinity, -1]) expect(assessUsage("codex", "gpt-6.1-sol", evidence([window("five_hour", used)]), NOW)).toBe("unknown");
    expect(assessUsage("codex", "gpt-6.1-sol", { observedAt: "bad", windows: [window("five_hour")] }, NOW)).toBe("unknown");
    expect(assessUsage("codex", "gpt-6.1-sol", evidence([window("five_hour")], NOW - 300000), NOW)).toBe("ready");
  });
});
