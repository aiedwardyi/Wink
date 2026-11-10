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

// anchor: the message an unclosed card sits after, so a restart keeps its spot.
const Record = z.object({
  seen: z.string().optional(),
  anchor: z.object({ release: z.string(), id: z.string() }).optional().catch(undefined),
});
type Saved = z.infer<typeof Record>;

function readSaved(dataDir: string): Saved {
  try {
    const parsed = Record.safeParse(JSON.parse(readFileSync(join(dataDir, FILE), "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeSaved(dataDir: string, saved: Saved): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, FILE), JSON.stringify(saved, null, 2));
}

/** Must run before the store loads: a fresh install is told apart by having no bots.json yet. */
export function openWhatsNew(dataDir: string, version: string) {
  const release = releaseOf(version);
  let { seen, anchor } = readSaved(dataDir);
  if (release && seen === undefined && !existsSync(join(dataDir, "bots.json"))) writeSaved(dataDir, { seen: (seen = release) });
  // The client holds the notes and names the one it showed, so a stale client's older card can't use up a newer one.
  const showable = (shown: unknown): shown is string =>
    Boolean(release) && typeof shown === "string" && releaseOf(shown) === shown && !newerRelease(shown, release!) && (seen === undefined || newerRelease(shown, seen));
  return {
    // No record on an install that already has bots means it ran a build from before this file.
    pending: () => (release && (seen === undefined || newerRelease(release, seen)) ? { release, seen: seen ?? null, anchor } : null),
    markSeen: (shown: unknown) => {
      if (!showable(shown)) return;
      if (anchor && !newerRelease(anchor.release, shown)) anchor = undefined;
      writeSaved(dataDir, { seen: (seen = shown), anchor });
    },
    place: (shown: unknown, id: unknown) => {
      if (!showable(shown) || typeof id !== "string" || !id) return;
      writeSaved(dataDir, { seen, anchor: (anchor = { release: shown, id }) });
    },
  };
}
