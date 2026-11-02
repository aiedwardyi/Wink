// Owner's counts for today in Korea, from what the snag and report claims already filed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { teamOwnerHash } from "./team-route.ts";

const DAY_MS = 24 * 60 * 60_000;
const KST_MS = 9 * 60 * 60_000;
const snagRow = z.object({ id: z.string(), at: z.number() });
const filedReport = z.object({ report: z.object({ at: z.number() }) });

export function kstDayStart(now: number): number {
  return Math.floor((now + KST_MS) / DAY_MS) * DAY_MS - KST_MS;
}

function todaySnags(file: string, start: number): number {
  const ids = new Set<string>();
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return 0; }
  for (const line of text.split("\n")) {
    try {
      const snag = snagRow.safeParse(JSON.parse(line));
      if (snag.success && snag.data.at >= start && snag.data.at < start + DAY_MS) ids.add(snag.data.id);
    } catch {}
  }
  return ids.size;
}

function todayReports(dir: string, start: number): number {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    const file = join(dir, name, "report.json");
    try {
      // filed before today means sent before today; skips reading old image-heavy reports
      if (statSync(file).mtimeMs < start) continue;
      const filed = filedReport.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (filed.success && filed.data.report.at >= start && filed.data.report.at < start + DAY_MS) count++;
    } catch {}
  }
  return count;
}

export async function teamTodayRoute(
  dataDir: string,
  ownerHash: string | null,
  email: string | null,
  crashes: string | null,
  crashCount: () => Promise<number | null> = async () => null,
  now: number = Date.now(),
) {
  const owner = (ownerHash ?? "").trim().toLowerCase();
  const session = (email ?? "").trim();
  if (!owner || !session || teamOwnerHash(session) !== owner) return { status: 403, body: { owner: false } };
  const start = kstDayStart(now);
  return {
    status: 200,
    body: {
      snags: todaySnags(join(dataDir, "team-snags.jsonl"), start),
      bugs: todayReports(join(dataDir, "team-report-inbox"), start),
      crashes,
      crashCount: crashes ? await crashCount() : null,
    },
  };
}
