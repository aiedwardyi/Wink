import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { botRepliesByEngine, botRepliesPerDay, firstBotReplyAt } from "./message-db.ts";

const WEEKS = 26;

export interface ReplyActivity {
  /** Local day of counts[0], a Sunday; the last count is today. */
  start: string;
  counts: number[];
  /** Local day of the first bot reply; busiest and total run from it. */
  since: string | null;
  busiest: { day: string; count: number } | null;
  total: number;
  /** Most worker panes open at once, all time. */
  workers: number;
  /** Replies per engine driver kind, biggest first. */
  engines: Array<{ engine: string; count: number }>;
}

const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function workerPeak(): number {
  try {
    const { count } = JSON.parse(readFileSync(join(DATA_DIR, "worker-peak.json"), "utf8")) as { count?: unknown };
    return Number.isSafeInteger(count) && (count as number) > 0 ? (count as number) : 0;
  } catch {
    return 0;
  }
}

/** Untagged replies, from before engines were stamped, count for their bot's current engine. */
function engineCounts(engineOf: (threadId: string, botId: string | null) => string | null) {
  const counts = new Map<string, number>();
  for (const row of botRepliesByEngine()) {
    const engine = row.engine ?? engineOf(row.threadId, row.botId);
    if (engine) counts.set(engine, (counts.get(engine) ?? 0) + row.count);
  }
  return [...counts].map(([engine, count]) => ({ engine, count })).sort((a, b) => b.count - a.count);
}

/** Bot replies per local day over the last 26 weeks, oldest first, with totals since the first reply. */
export function replyActivity(now = Date.now(), engineOf: (threadId: string, botId: string | null) => string | null = () => null): ReplyActivity {
  const today = new Date(now);
  const grid = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (WEEKS - 1) * 7);
  const firstAt = firstBotReplyAt();
  const first = firstAt === null || firstAt >= grid.getTime() ? grid : new Date(firstAt);
  const from = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const midnights = [from.getTime()];
  while (midnights.at(-1)! <= now) {
    midnights.push(new Date(from.getFullYear(), from.getMonth(), from.getDate() + midnights.length).getTime());
  }
  const all = botRepliesPerDay(midnights);
  const dayOf = (index: number) => isoDay(new Date(midnights[index]!));
  let busy = 0;
  all.forEach((count, day) => { if (count >= all[busy]!) busy = day; });
  const total = all.reduce((sum, count) => sum + count, 0);
  const firstDay = all.findIndex(Boolean);
  return {
    start: isoDay(grid),
    counts: all.slice(midnights.indexOf(grid.getTime())),
    since: firstDay < 0 ? null : dayOf(firstDay),
    busiest: total ? { day: dayOf(busy), count: all[busy]! } : null,
    total,
    workers: workerPeak(),
    engines: total ? engineCounts(engineOf) : [],
  };
}
