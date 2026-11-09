import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

const FILE = "whats-new.json";

/** "1.0.246-dev.3" -> "1.0.246", so dev builds share their release's notes. */
export function releaseOf(version: string): string | null {
  return /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? null;
}

function newer(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
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
  const seen = readSeen(dataDir);
  let pending: string | null = null;
  if (release && seen === undefined && !existsSync(join(dataDir, "bots.json"))) writeSeen(dataDir, release);
  // No record on an install that already has bots means it ran a build from before this file.
  else if (release && (seen === undefined || newer(release, seen))) pending = release;
  return {
    pending: () => pending,
    markSeen: () => {
      if (!pending) return;
      writeSeen(dataDir, pending);
      pending = null;
    },
  };
}
