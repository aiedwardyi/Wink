import type { UsageBoardAccount, UsageBoardEvent, UsageBoardSample, UsageBoardWindow } from "./usage-board";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type Point = { at: number; used: number };
export type Verdict =
  | { kind: "out"; back: number | null }
  | { kind: "runsOut"; at: number }
  | { kind: "lasts" }
  | { kind: "learning" }
  | { kind: "noRecent" }
  | { kind: "awaiting" };
/** A valid trailing estimate: the projection starts at `from` and climbs `rate` % per ms. */
export type Projection = { from: Point; rate: number; until: number };

export const leftOf = (window: UsageBoardWindow) => Math.max(0, Math.min(100, 100 - window.usedPercent));

/** The window that runs out first: lowest % left, the shorter window on a tie. */
export function bindingWindow(windows: UsageBoardWindow[]): UsageBoardWindow | undefined {
  return [...windows].sort((a, b) => leftOf(a) - leftOf(b)
    || (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))[0];
}

/** The 5h and week windows the history tracks; everything else is an extra window. */
export function splitWindows(windows: UsageBoardWindow[]) {
  const session = windows.find((window) => window.kind === "session");
  const week = windows.find((window) => window.id === "seven_day") ?? windows.find((window) => window.kind === "week");
  return { session, week, others: windows.filter((window) => window !== session && window !== week) };
}

/** History column for a tracked window, or null for an extra one. */
export function historyColumn(account: UsageBoardAccount, window: UsageBoardWindow): 1 | 2 | null {
  const { session, week } = splitWindows(account.windows);
  return window === session ? 1 : window === week ? 2 : null;
}

export function pointsOf(samples: UsageBoardSample[], column: 1 | 2): Point[] {
  return samples.flatMap((sample) => sample[column] === null ? [] : [{ at: sample[0] * MIN, used: sample[column]! }]);
}

const resetTimes = (events: UsageBoardEvent[], accountId: string, windowId: string) =>
  events.filter((event) => event.kind === "reset" && event.accountId === accountId && event.window === windowId).map((event) => event.at);

/** When the running cycle began: the window's own start, a reset event, or a drop between points, whichever is latest. */
export function cycleStart(points: Point[], window: UsageBoardWindow, resets: number[], now: number): number {
  let start = window.resetsAt !== null && window.windowMinutes !== null ? window.resetsAt - window.windowMinutes * MIN : -Infinity;
  for (const at of resets) if (at <= now) start = Math.max(start, at);
  for (let i = 1; i < points.length; i += 1) if (points[i]!.used < points[i - 1]!.used) start = Math.max(start, points[i]!.at);
  return start;
}

const roundTo10 = (at: number) => {
  const date = new Date(at);
  date.setSeconds(0, 0);
  date.setMinutes(Math.round(date.getMinutes() / 10) * 10);
  return date.getTime();
};

export function pace(account: UsageBoardAccount, window: UsageBoardWindow, events: UsageBoardEvent[], now: number): { verdict: Verdict; projection: Projection | null } {
  const none = (verdict: Verdict) => ({ verdict, projection: null });
  const { resetsAt, windowMinutes } = window;
  if (resetsAt === null || windowMinutes === null) return none(window.usedPercent >= 100 ? { kind: "out", back: null } : { kind: "noRecent" });
  if (now >= resetsAt) return none({ kind: "awaiting" });
  if (window.usedPercent >= 100) return none({ kind: "out", back: resetsAt });
  const column = historyColumn(account, window);
  const all = column === null ? [] : pointsOf(account.history.fine, column);
  const start = cycleStart(all, window, resetTimes(events, account.id, window.id), now);
  if (now - start < 20 * MIN) return none({ kind: "learning" });
  if (all.some((point) => point.at > now)) return none({ kind: "noRecent" });
  const trail = window.kind === "session" ? HOUR : DAY;
  const points = all.filter((point) => point.at >= Math.max(start, now - trail));
  const last = points.at(-1);
  const observedAt = account.observedAt;
  const latest = last && observedAt !== null && observedAt >= last.at && observedAt < last.at + 5 * MIN
    ? observedAt : last?.at ?? observedAt;
  if (latest === null || now - latest > 5 * MIN) return none({ kind: "noRecent" });
  const first = points[0];
  if (!first || !last || points.length < 3 || last.at - first.at < 15 * MIN) return none({ kind: "learning" });
  for (let i = 1; i < points.length; i += 1) if (points[i]!.at - points[i - 1]!.at > trail / 4) return none({ kind: "noRecent" });
  const climb = Math.max(0, last.used - first.used);
  const rate = climb / (last.at - first.at);
  // Multiply before dividing so a whole-minute exhaustion stays exact at the 10-minute boundary.
  const exhaustion = climb > 0 ? last.at + ((100 - last.used) * (last.at - first.at)) / climb : Infinity;
  const projection = { from: last, rate, until: Math.min(exhaustion, resetsAt) };
  if (resetsAt - exhaustion > 10 * MIN) return { verdict: { kind: "runsOut", at: roundTo10(exhaustion) }, projection };
  return { verdict: { kind: "lasts" }, projection };
}

export type ChartSeries = {
  start: number;
  end: number;
  segments: Point[][];
  bars: { at: number; width: number; used: number }[];
  marks: { at: number; kind: "limit" | "reset" }[];
};

/** Actual samples of the running cycle only, split at gaps; bars are nonnegative quota deltas inside it. */
export function chartSeries(account: UsageBoardAccount, window: UsageBoardWindow, events: UsageBoardEvent[], now: number): ChartSeries | null {
  const column = historyColumn(account, window);
  if (column === null) return null;
  const session = window.kind === "session";
  const step = session ? 5 * MIN : HOUR;
  const all = pointsOf(session ? account.history.fine : account.history.coarse, column);
  const resets = resetTimes(events, account.id, window.id);
  const startAt = cycleStart(all, window, resets, now);
  const span = (window.windowMinutes ?? (session ? 300 : 10080)) * MIN;
  const start = Number.isFinite(startAt) ? startAt : now - span;
  const end = window.resetsAt !== null && window.resetsAt > now ? window.resetsAt : now;
  const points = all.filter((point) => point.at >= start && point.at <= now);
  const segments: Point[][] = [];
  for (const point of points) {
    const segment = segments.at(-1);
    if (segment && point.at - segment.at(-1)!.at <= 2 * step) segment.push(point);
    else segments.push([point]);
  }
  const width = session ? 30 * MIN : DAY;
  const bars: ChartSeries["bars"] = [];
  for (const segment of segments) for (let i = 1; i < segment.length; i += 1) {
    const at = session ? Math.floor(segment[i]!.at / width) * width : localDay(segment[i]!.at);
    const delta = Math.max(0, segment[i]!.used - segment[i - 1]!.used);
    const bar = bars.find((each) => each.at === at);
    if (bar) bar.used += delta;
    else bars.push({ at, width, used: delta });
  }
  const marks = events.flatMap((event) => (event.kind === "limit" || event.kind === "reset")
    && event.accountId === account.id && event.window === window.id && event.at >= start && event.at <= end
    ? [{ at: event.at, kind: event.kind }] : []);
  return { start, end, segments, bars, marks };
}

function localDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Week quota used today so far against the median of the same local-clock span on 3 to 7 covered earlier days; null without them.
 * A coarse point sits at its hour's start but holds that hour's latest reading, so only completed hours compare: from the
 * hour before midnight through the last completed hour, on every day alike. */
export function todayVsNormal(account: UsageBoardAccount, now: number): number | null {
  const points = pointsOf(account.history.coarse, 2);
  const midnight = localDay(now);
  const span = Math.floor((now - midnight) / HOUR) * HOUR;
  if (span < HOUR) return null;
  const used = (from: number) => {
    const inside = points.filter((point) => point.at >= from - HOUR && point.at < from + span);
    if (!inside.length || inside[0]!.at >= from || from + span - inside.at(-1)!.at > HOUR) return null;
    let total = 0;
    for (let i = 1; i < inside.length; i += 1) {
      if (inside[i]!.at - inside[i - 1]!.at > 2 * HOUR) return null;
      total += Math.max(0, inside[i]!.used - inside[i - 1]!.used);
    }
    return total;
  };
  const today = used(midnight);
  if (today === null) return null;
  const days: number[] = [];
  for (let back = 1; back <= 7; back += 1) {
    const day = new Date(midnight);
    day.setDate(day.getDate() - back);
    const value = used(day.getTime());
    if (value !== null) days.push(value);
  }
  if (days.length < 3) return null;
  days.sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  const normal = days.length % 2 ? days[mid]! : (days[mid - 1]! + days[mid]!) / 2;
  return normal > 0 ? today / normal : null;
}
