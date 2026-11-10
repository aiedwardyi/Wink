import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { newerRelease } from "../shared/release-order.ts";
import { writeFileAtomic } from "./atomic.ts";

const FILE = "whats-new.json";

/** "1.0.246-dev.3" -> "1.0.246", so dev builds share their release's notes. */
export function releaseOf(version: string): string | null {
  return /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? null;
}

function readSeen(dataDir: string): string | undefined {
  try {
    const parsed = z.object({ seen: z.string() }).safeParse(JSON.parse(readFileSync(join(dataDir, FILE), "utf8")));
    return parsed.success ? parsed.data.seen : undefined;
  } catch {
    return undefined;
  }
}

function writeSeen(dataDir: string, release: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, FILE), JSON.stringify({ seen: release }, null, 2));
}

/** Must run before the store loads: a fresh install is told apart by having no bots.json yet. */
export function openWhatsNew(dataDir: string, version: string) {
  const release = releaseOf(version);
  let seen = readSeen(dataDir);
  if (release && seen === undefined && !existsSync(join(dataDir, "bots.json"))) writeSeen(dataDir, (seen = release));
  return {
    // No record on an install that already has bots means it ran a build from before this file.
    pending: () => (release && (seen === undefined || newerRelease(release, seen)) ? { release, seen: seen ?? null } : null),
    // The client holds the notes and names the one it showed, so a stale client's older card can't use up a newer one.
    markSeen: (shown: unknown) => {
      if (!release || typeof shown !== "string" || releaseOf(shown) !== shown) return;
      if (newerRelease(shown, release) || (seen !== undefined && !newerRelease(shown, seen))) return;
      writeSeen(dataDir, (seen = shown));
    },
  };
}
