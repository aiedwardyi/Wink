// Today's GlitchTip error count for the build's DSN project, read with the owner's saved key.

import { z } from "zod";

import type { CustomKey } from "../shared/credential-request.ts";
import { kstDayStart } from "./team-today.ts";

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;
const FIELD = "sum(quantity)";
const orgsSchema = z.array(z.object({ slug: z.string().min(1) }));
const statsSchema = z.object({ groups: z.array(z.object({ series: z.record(z.string(), z.array(z.number().nullable())) })) });

export interface CrashCountOptions {
  origin: string | null;
  project: string | null;
  key(): CustomKey | null | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Null when there is no key or DSN, or GlitchTip fails; the key only ever leaves in the request header. */
export function crashCounter(options: CrashCountOptions): () => Promise<number | null> {
  let org: string | null = null;
  let cached: { at: number; day: number; count: number | null } | null = null;
  return async () => {
    const key = options.key();
    const { origin, project } = options;
    if (!origin || !project || !key?.key.trim()) return null;
    const now = (options.now ?? Date.now)();
    const day = kstDayStart(now);
    if (cached && cached.day === day && now - cached.at < CACHE_MS) return cached.count;
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const get = (path: string) => (options.fetchImpl ?? fetch)(`${origin}/api/0/${path}`, {
      headers: { [key.header]: `${key.prefix}${key.key.trim()}` }, redirect: "error", signal,
    });
    const query = new URLSearchParams({ category: "error", field: FIELD, interval: "1h", project, start: new Date(day).toISOString(), end: new Date(now).toISOString() });
    let count: number | null = null;
    try {
      const orgs = org ? [org] : orgsSchema.parse(await (await get("organizations/")).json()).map((entry) => entry.slug);
      for (const slug of orgs) {
        // GlitchTip answers 404 when the project is not in this org
        const response = await get(`organizations/${encodeURIComponent(slug)}/stats_v2/?${query}`);
        if (!response.ok) continue;
        const stats = statsSchema.parse(await response.json());
        org = slug;
        count = stats.groups.reduce((sum, group) => sum + (group.series[FIELD] ?? []).reduce<number>((inner, value) => inner + (value ?? 0), 0), 0);
        break;
      }
    } catch {}
    cached = { at: now, day, count };
    return count;
  };
}
