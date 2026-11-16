import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

const FILE = "call-intro.json";

// Kept on disk: the app's localStorage write can be lost when an update closes Wink.
export function openCallIntro(dataDir: string) {
  let seen = existsSync(join(dataDir, FILE));
  return {
    seen: () => seen,
    markSeen: () => {
      if (seen) return;
      mkdirSync(dataDir, { recursive: true });
      writeFileAtomic(join(dataDir, FILE), JSON.stringify({ seen: true }));
      seen = true;
    },
  };
}
