// Pace math for the race chart. Pure functions, no React.
// A window burns down from 100% left at its start to its reset (the finish line).
// The even-pace guide runs straight from (start, 100) to (reset, 0).
// The projection extends the recent pace: the last hour for 5h, the last day for a week.
import { at, HOUR, MIN, type Key, type Kind } from "./fixtures";

export type Sample = { t: number; used: number };
export type Win = { kind: Kind; minutes: number; resetsAt: number; samples: Sample[] };
export type Verdict =
  | { kind: "out"; back: number }
  | { kind: "runsOut"; at: number; left: number }
  | { kind: "lasts"; spare: number; left: number }
  | { kind: "none" };

export const MINUTES: Record<Kind, number> = { "5h": 300, week: 10080 };
const TRAIL: Record<Kind, number> = { "5h": HOUR, week: 24 * HOUR };

export const startOf = (w: Win) => w.resetsAt - w.minutes * MIN;

/** Reports arrive when an engine reports (turns, CLI status), not on a clock:
 * busy stretches report every few minutes, quiet ones barely at all. */
export function samplesFrom(keys: readonly Key[], seed: number): Sample[] {
  let state = seed * 9301 + 49297;
  const rand = () => ((state = (state * 9301 + 49297) % 233280) / 233280);
  const points = keys.map(([stamp, used]) => ({ t: at(stamp), used }));
  const out: Sample[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    out.push(a);
    const b = points[i + 1];
    if (!b) break;
    const perHour = (b.used - a.used) / ((b.t - a.t) / HOUR);
    if (perHour < 0.4) continue;
    let t = a.t + (2.5 + rand() * 4) * MIN;
    while (t < b.t - MIN) {
      out.push({ t, used: Math.round((a.used + ((b.used - a.used) * (t - a.t)) / (b.t - a.t)) * 10) / 10 });
      t += (2.5 + rand() * 4.5) * MIN;
    }
  }
  return out;
}

export function usedAt(w: Win, t: number): number {
  const s = w.samples;
  if (s.length === 0 || t <= s[0]!.t) return t < startOf(w) ? 0 : s[0]?.used ?? 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const a = s[i]!;
    if (a.t <= t) {
      const b = s[i + 1];
      if (!b) return a.used;
      return a.used + ((b.used - a.used) * (t - a.t)) / (b.t - a.t);
    }
  }
  return 0;
}

export const lastUsed = (w: Win) => w.samples.at(-1)?.used ?? 0;
export const leftOf = (w: Win) => Math.max(0, 100 - lastUsed(w));
export const evenLeft = (w: Win, t: number) => Math.max(0, Math.min(100, (100 * (w.resetsAt - t)) / (w.minutes * MIN)));

/** Percent per ms over the trailing span (bounded by the window start). */
export function recentRate(w: Win, now: number): number {
  const from = Math.max(startOf(w), now - TRAIL[w.kind]);
  if (now - from < 10 * MIN) return 0;
  return Math.max(0, (lastUsed(w) - usedAt(w, from)) / (now - from));
}

export function verdict(w: Win | undefined, now: number): Verdict {
  if (!w) return { kind: "none" };
  const left = leftOf(w);
  if (left <= 0) return { kind: "out", back: w.resetsAt };
  const rate = recentRate(w, now);
  const until = w.resetsAt - now;
  if (rate <= 0) return { kind: "lasts", spare: left, left };
  const lastsMs = left / rate;
  if (lastsMs < until) return { kind: "runsOut", at: now + lastsMs, left };
  return { kind: "lasts", spare: Math.max(0, left - rate * until), left };
}

export const live = (w: Win, now: number) => w.resetsAt > now;

/** The window that decides: out first (latest return), then the earliest run-out, then the least left. */
export function binding(wins: Win[], now: number): Win | undefined {
  const open = wins.filter((w) => live(w, now));
  const outs = open.filter((w) => leftOf(w) <= 0);
  if (outs.length) return outs.reduce((a, b) => (b.resetsAt > a.resetsAt ? b : a));
  const short = open
    .map((w) => ({ w, v: verdict(w, now) }))
    .filter((x): x is { w: Win; v: Extract<Verdict, { kind: "runsOut" }> } => x.v.kind === "runsOut");
  if (short.length) return short.reduce((a, b) => (b.v.at < a.v.at ? b : a)).w;
  return open.reduce<Win | undefined>((a, b) => (!a || leftOf(b) < leftOf(a) ? b : a), undefined);
}

/** Usage per bucket (percentage points) for the volume bars under the line. */
export function buckets(w: Win, now: number, count: number): { from: number; to: number; used: number }[] {
  const start = startOf(w);
  const size = (w.resetsAt - start) / count;
  const out: { from: number; to: number; used: number }[] = [];
  for (let i = 0; i < count; i++) {
    const from = start + i * size;
    const to = from + size;
    if (from >= now) out.push({ from, to, used: 0 });
    else out.push({ from, to, used: Math.max(0, usedAt(w, Math.min(to, now)) - usedAt(w, from)) });
  }
  return out;
}

/** Today vs a normal day, from the week window's daily totals (local days). */
export function todayVsNormal(w: Win, now: number, dayStart: (t: number) => number): { today: number; normal: number } | null {
  if (w.kind !== "week") return null;
  // A normal day = the average day so far this week (the sample store keeps 8 days,
  // so the build can average the last 7 full days instead).
  const today0 = dayStart(now);
  const today = lastUsed(w) - usedAt(w, today0);
  const days: number[] = [];
  for (let d = today0 - 24 * HOUR; d + 24 * HOUR > startOf(w); d -= 24 * HOUR) days.push(usedAt(w, d + 24 * HOUR) - usedAt(w, Math.max(d, startOf(w))));
  if (days.length < 2) return null;
  const normal = days.reduce((a, b) => a + b, 0) / days.length;
  return { today, normal };
}

export const roundTo10Min = (t: number) => Math.round(t / (10 * MIN)) * 10 * MIN;
