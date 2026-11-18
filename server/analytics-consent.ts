import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

// Its own file: profile-sync.json and the Google binding are parsed strictly by older builds.
const ANALYTICS_FILE = "analytics.json";
const ONBOARDING_FILE = "onboarding-done";
const analyticsSettings = z.object({ enabled: z.boolean() });

function readAnalyticsSettings(dataDir: string) {
  try {
    return analyticsSettings.safeParse(JSON.parse(readFileSync(join(dataDir, ANALYTICS_FILE), "utf8")));
  } catch {
    return undefined;
  }
}

export function loadAnalyticsConsent(dataDir: string, unset = false): boolean {
  const saved = readAnalyticsSettings(dataDir);
  return saved ? saved.success && saved.data.enabled : unset;
}

export function hasCompletedOnboarding(dataDir: string): boolean {
  return existsSync(join(dataDir, ONBOARDING_FILE)) || readAnalyticsSettings(dataDir)?.success === true;
}

export function completeOnboarding(dataDir: string, enabled?: boolean): boolean | undefined {
  if (hasCompletedOnboarding(dataDir)) return;
  if (enabled !== undefined) return saveAnalyticsConsent(dataDir, enabled);
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, ONBOARDING_FILE), "true");
}

export function saveAnalyticsConsent(dataDir: string, enabled: boolean): boolean {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, ANALYTICS_FILE), JSON.stringify({ enabled }, null, 2));
  return enabled;
}
