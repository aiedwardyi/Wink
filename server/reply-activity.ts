import { botRepliesPerDay } from "./message-db.ts";

const WEEKS = 26;

export interface ReplyActivity {
  /** Local day of counts[0], a Sunday; the last count is today. */
  start: string;
  counts: number[];
  streak: number;
  busiest: { day: string; count: number } | null;
  total: number;
}

const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Bot replies per local day over the last 26 weeks, oldest first. */
export function replyActivity(now = Date.now()): ReplyActivity {
  const today = new Date(now);
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (WEEKS - 1) * 7);
  const midnights = [first.getTime()];
  while (midnights.at(-1)! <= now) {
    midnights.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + midnights.length).getTime());
  }
  const counts = botRepliesPerDay(midnights);
  let busy = 0;
  counts.forEach((count, day) => { if (count >= counts[busy]!) busy = day; });
  let streak = 0;
  // a quiet morning keeps yesterday's streak
  for (let day = counts.length - (counts.at(-1) ? 1 : 2); day >= 0 && counts[day]; day--) streak++;
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    start: isoDay(first),
    counts,
    streak,
    busiest: total ? { day: isoDay(new Date(midnights[busy]!)), count: counts[busy]! } : null,
    total,
  };
}
