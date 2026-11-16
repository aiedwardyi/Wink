import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

// Its own file: profile-sync.json and the Google binding are parsed strictly by older builds.
const ANALYTICS_FILE = "analytics.json";

export function loadAnalyticsConsent(dataDir: string, unset = false): boolean {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(join(dataDir, ANALYTICS_FILE), "utf8"));
  } catch {
    return unset;
  }
  const parsed = z.object({ enabled: z.boolean() }).safeParse(saved);
  return parsed.success && parsed.data.enabled;
}

export function saveAnalyticsConsent(dataDir: string, enabled: boolean): boolean {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, ANALYTICS_FILE), JSON.stringify({ enabled }, null, 2));
  return enabled;
}
