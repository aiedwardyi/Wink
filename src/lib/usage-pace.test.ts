import { describe, expect, it } from "vitest";
import { bindingWindow, chartSeries, cycleStart, pace, todayVsNormal, type Verdict } from "./usage-pace";
import type { UsageBoardAccount, UsageBoardEvent, UsageBoardSample, UsageBoardWindow } from "./usage-board";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 10, 4, 15, 0).getTime();

// Points every `step` minutes ending at `end`, used % climbing by `rate` per minute.
function trail(end: number, count: number, endUsed: number, rate: number, step = 5): UsageBoardSample[] {
  return Array.from({ length: count }, (_, i) => {
    const minute = end / MIN - (count - 1 - i) * step;
    return [minute, Math.round((endUsed - rate * (end / MIN - minute)) * 10) / 10, 10];
  });
}
const session = (patch: Partial<UsageBoardWindow> = {}): UsageBoardWindow =>
  ({ id: "five_hour", kind: "session", usedPercent: 80, resetsAt: NOW + 120 * MIN, windowMinutes: 300, ...patch });
const week = (patch: Partial<UsageBoardWindow> = {}): UsageBoardWindow =>
  ({ id: "seven_day", kind: "week", usedPercent: 10, resetsAt: NOW + 3 * 24 * HOUR, windowMinutes: 10080, ...patch });
function account(windows: UsageBoardWindow[], fine: UsageBoardSample[] = [], coarse: UsageBoardSample[] = []): UsageBoardAccount {
  return {
    id: "a", number: 1, nickname: null, name: "Claude 1", main: true, signIn: "ready", coverage: "complete",
    windows, observedAt: NOW, history: { fine, coarse }, bots: [], workers: [],
  };
}
const verdictOf = (window: UsageBoardWindow, fine: UsageBoardSample[], events: UsageBoardEvent[] = []) =>
  pace(account([window, week()], fine), window, events, NOW);

describe("pace", () => {
  const cases: Array<[string, UsageBoardWindow, UsageBoardSample[], Verdict["kind"], UsageBoardEvent[]?]> = [
    ["exactly 10 min before reset", session({ resetsAt: NOW + 50 * MIN }), trail(NOW, 13, 80, 0.5), "lasts"],
    ["11 min before reset", session({ resetsAt: NOW + 51 * MIN }), trail(NOW, 13, 80, 0.5), "runsOut"],
    ["9 min before reset", session({ resetsAt: NOW + 49 * MIN }), trail(NOW, 13, 80, 0.5), "lasts"],
    ["first 20 min of a cycle", session({ resetsAt: NOW + 285 * MIN }), trail(NOW, 4, 80, 0.5), "learning"],
    ["under 3 points", session(), trail(NOW, 2, 80, 0.5), "learning"],
    ["under 15 min", session(), trail(NOW, 3, 80, 0.5), "learning"],
    ["newest over 5 min old", session(), trail(NOW - 6 * MIN, 13, 80, 0.5), "noRecent"],
    ["newest at 5 min old", session(), trail(NOW - 5 * MIN, 13, 80, 0.1), "lasts"],
    ["unknown reset", session({ resetsAt: null }), trail(NOW, 13, 80, 0.5), "noRecent"],
    ["unknown duration", session({ windowMinutes: null }), trail(NOW, 13, 80, 0.5), "noRecent"],
    ["gap over a quarter of the trail", session(), trail(NOW, 13, 80, 0.5).filter((_, i) => i < 3 || i > 7), "noRecent"],
    ["future point", session(), [...trail(NOW, 13, 80, 0.5), [NOW / MIN + 10, 81, 10]], "noRecent"],
    ["past reset", session({ resetsAt: NOW - MIN }), trail(NOW, 13, 80, 0.5), "awaiting"],
    ["measured zero burn", session({ resetsAt: NOW + 51 * MIN }), trail(NOW, 13, 80, 0), "lasts"],
    ["missing history", session({ resetsAt: NOW + 51 * MIN }), trail(NOW, 13, 80, 0).map(([m, , w]) => [m, null, w]), "learning"],
    ["window at 100%", session({ usedPercent: 100 }), trail(NOW, 13, 100, 0.5), "out"],
    ["reset event 10 min ago", session(), trail(NOW, 13, 80, 0.5), "learning",
      [{ seq: 1, at: NOW - 10 * MIN, kind: "reset", accountId: "a", window: "five_hour" }]],
    ["reset event for another window", session(), trail(NOW, 13, 80, 0.5), "runsOut",
      [{ seq: 1, at: NOW - 10 * MIN, kind: "reset", accountId: "a", window: "seven_day" }]],
  ];
  it.each(cases)("%s", (_name, window, fine, expected, events = []) => {
    const { verdict, projection } = verdictOf(window, fine, events);
    expect(verdict.kind).toBe(expected);
    expect(projection !== null).toBe(expected === "runsOut" || expected === "lasts");
  });

  it("keeps a 14:59 observation fresh at 15:01 despite its 14:55 bucket", () => {
    const window = session();
    const acct = account([window], trail(NOW - 5 * MIN, 13, 80, 0.5));
    acct.observedAt = NOW - MIN;
    const { verdict, projection } = pace(acct, window, [], NOW + MIN);
    expect(verdict.kind).toBe("runsOut");
    expect(projection).not.toBeNull();
    expect(projection!.from).toEqual({ at: NOW - 5 * MIN, used: 80 });
  });

  it("expires the same 14:59 observation at 15:05", () => {
    const window = session();
    const acct = account([window], trail(NOW - 5 * MIN, 13, 80, 0.5));
    acct.observedAt = NOW - MIN;
    expect(pace(acct, window, [], NOW + 5 * MIN)).toEqual({ verdict: { kind: "noRecent" }, projection: null });
  });

  it("does not freshen a 14:57 window from a valueless 15:03 report", () => {
    const window = session();
    const acct = account([window], [...trail(NOW - 5 * MIN, 13, 80, 0.5), [NOW / MIN, null, 11]]);
    acct.observedAt = NOW + 3 * MIN;
    expect(pace(acct, window, [], NOW + 3 * MIN)).toEqual({ verdict: { kind: "noRecent" }, projection: null });
  });

  it("rounds the shown run-out time to 10 minutes only after the margin test", () => {
    // 80% at 0.5 %/min runs out 40 min from now; the reset 51 min out clears the 10-min margin.
    const { verdict } = verdictOf(session({ resetsAt: NOW + 51 * MIN }), trail(NOW, 13, 80, 0.5));
    expect(verdict).toEqual({ kind: "runsOut", at: NOW + 40 * MIN });
    const odd = verdictOf(session({ usedPercent: 81, resetsAt: NOW + 120 * MIN }), trail(NOW, 13, 81, 0.5));
    expect(odd.verdict).toEqual({ kind: "runsOut", at: NOW + 40 * MIN });
  });

  it("uses a 24 h trail for the week window", () => {
    const fine: UsageBoardSample[] = Array.from({ length: 25 }, (_, i) => [NOW / MIN - (24 - i) * 60, 10, 40 + i]);
    const acct = account([session({ usedPercent: 10 }), week({ usedPercent: 64 })], fine);
    const { verdict, projection } = pace(acct, acct.windows[1]!, [], NOW);
    expect(verdict.kind).toBe("runsOut");
    expect(projection!.from).toEqual({ at: NOW, used: 64 });
  });

  it("starts a new cycle at a drop and never projects across it", () => {
    const before = trail(NOW - 15 * MIN, 10, 95, 0.5);
    const after = trail(NOW, 3, 6, 0.5);
    const { verdict } = verdictOf(session({ usedPercent: 6 }), [...before, ...after]);
    expect(verdict.kind).toBe("learning");
  });
});

describe("cycleStart", () => {
  it("takes the latest of the window start, a reset and a drop", () => {
    const window = session({ resetsAt: NOW + 60 * MIN, windowMinutes: 300 });
    expect(cycleStart([], window, [], NOW)).toBe(NOW - 240 * MIN);
    expect(cycleStart([], window, [NOW - 100 * MIN], NOW)).toBe(NOW - 100 * MIN);
    expect(cycleStart([{ at: NOW - 50 * MIN, used: 90 }, { at: NOW - 45 * MIN, used: 2 }], window, [NOW - 100 * MIN], NOW)).toBe(NOW - 45 * MIN);
    expect(cycleStart([], window, [NOW + MIN], NOW)).toBe(NOW - 240 * MIN);
  });
});

describe("bindingWindow", () => {
  it("is the lowest % left, the shorter window on a tie", () => {
    expect(bindingWindow([session({ usedPercent: 40 }), week({ usedPercent: 70 })])!.id).toBe("seven_day");
    expect(bindingWindow([week({ usedPercent: 50 }), session({ usedPercent: 50 })])!.id).toBe("five_hour");
    expect(bindingWindow([])).toBeUndefined();
  });
});

describe("chartSeries", () => {
  it("keeps actual samples of the running cycle with gaps, no synthesized points", () => {
    const fine = trail(NOW, 13, 80, 0.5).filter((_, i) => i < 4 || i > 8);
    const acct = account([session(), week()], fine);
    const series = chartSeries(acct, acct.windows[0]!, [], NOW)!;
    expect(series.segments.map((segment) => segment.length)).toEqual([4, 4]);
    expect(series.segments.flat()).toHaveLength(8);
    expect(series.end).toBe(NOW + 120 * MIN);
  });

  it("drops the earlier cycle and keeps bars nonnegative", () => {
    const fine: UsageBoardSample[] = [[NOW / MIN - 20, 90, 10], [NOW / MIN - 15, 95, 10], [NOW / MIN - 10, 3, 10], [NOW / MIN - 5, 4, 10], [NOW / MIN, 6, 10]];
    const acct = account([session({ usedPercent: 6 }), week()], fine);
    const series = chartSeries(acct, acct.windows[0]!, [], NOW)!;
    expect(series.segments.flat().map((point) => point.used)).toEqual([3, 4, 6]);
    expect(series.bars.every((bar) => bar.used >= 0)).toBe(true);
    expect(series.bars.reduce((sum, bar) => sum + bar.used, 0)).toBe(3);
  });

  it("marks limit and reset events of its own window only", () => {
    const acct = account([session(), week()], trail(NOW, 13, 80, 0.5));
    const events: UsageBoardEvent[] = [
      { seq: 1, at: NOW - 30 * MIN, kind: "limit", accountId: "a", window: "five_hour" },
      { seq: 2, at: NOW - 30 * MIN, kind: "limit", accountId: "a", window: "seven_day" },
      { seq: 3, at: NOW - 30 * MIN, kind: "main", from: "a", to: "b" },
    ];
    expect(chartSeries(acct, acct.windows[0]!, events, NOW)!.marks).toEqual([{ at: NOW - 30 * MIN, kind: "limit" }]);
  });

  it("has no chart for an extra window", () => {
    const other: UsageBoardWindow = { id: "daily", kind: "other", usedPercent: 18, resetsAt: NOW + HOUR, windowMinutes: 1440 };
    const acct = account([other], []);
    expect(chartSeries(acct, other, [], NOW)).toBeNull();
  });
});

describe("todayVsNormal", () => {
  const midnight = new Date(2026, 10, 4).getTime();
  // Hourly coarse points from the hour before `days` days back, using `perHour` % each hour.
  function coarse(days: number, perHour: number[]): UsageBoardSample[] {
    const out: UsageBoardSample[] = [];
    let used = 0;
    for (let at = midnight - days * 24 * HOUR - HOUR; at <= NOW; at += HOUR) {
      const dayIndex = Math.floor((at - (midnight - days * 24 * HOUR)) / (24 * HOUR));
      used += perHour[Math.min(dayIndex, perHour.length - 1)] ?? 0;
      out.push([at / MIN, null, used]);
    }
    return out;
  }

  it("compares today with the median of covered earlier days", () => {
    const acct = account([week()], [], coarse(3, [1, 2, 3, 2]));
    // Today 15 h at 2 %/h = 30; earlier days 15, 30, 45: median 30.
    expect(todayVsNormal(acct, NOW)).toBeCloseTo(1, 5);
  });

  it("compares completed hours only, so a fresh hour does not read as quieter", () => {
    // Constant use (0.1 % every 5 min), observed every 5 min; each hourly point holds the hour's latest reading.
    const now = midnight + 65 * MIN;
    const buckets = new Map<number, number>();
    for (let at = midnight - 5 * 24 * HOUR; at <= now; at += 5 * MIN) {
      buckets.set(Math.floor(at / HOUR) * HOUR, Math.round(((at - (midnight - 5 * 24 * HOUR)) / (5 * MIN)) * 0.1 * 10) / 10);
    }
    const samples: UsageBoardSample[] = [...buckets].map(([at, used]) => [at / MIN, null, used]);
    expect(todayVsNormal(account([week()], [], samples), now)).toBeCloseTo(1, 5);
  });

  it("is omitted with fewer than three covered days", () => {
    expect(todayVsNormal(account([week()], [], coarse(2, [1, 1, 1])), NOW)).toBeNull();
  });

  it("is omitted when a day has a gap", () => {
    const samples = coarse(3, [1, 1, 1, 1]).filter(([minute]) => minute * MIN < midnight - 3 * 24 * HOUR + 5 * HOUR || minute * MIN > midnight - 3 * 24 * HOUR + 9 * HOUR);
    expect(todayVsNormal(account([week()], [], samples), NOW)).toBeNull();
  });
});
