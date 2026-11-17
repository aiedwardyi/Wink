import { findBootRows, type BootRows } from "../boot-reads.ts";
import { DATA_DIR } from "../config.ts";
import { CONFLICT_NOTICE, CONFLICT_NOTICE_V2 } from "../thread-sync.ts";
import { migrationCutoverAt } from "../thread-sync-v2-store.ts";

/** What the boot worker would find now, read on the test's own thread. */
export function bootRowsNow(askThreads: string[] = [], dataDir = DATA_DIR, now = Date.now(), reportThreads: string[] = []): BootRows {
  return findBootRows({
    dataDir, now, askThreads, reportThreads, cutoverAt: migrationCutoverAt(dataDir),
    notices: { migration: `error: ${CONFLICT_NOTICE}`, conflict: [CONFLICT_NOTICE, CONFLICT_NOTICE_V2].map((notice) => `error: ${notice}`) },
  });
}

/** A sync store host's bootReads: the finders run when the store asks. */
export const testBootReads = (dataDir: string) => async () => bootRowsNow([], dataDir);
