import { parentPort, workerData } from "node:worker_threads";

import { en, ko } from "../src/lib/i18n-catalog.ts";
import { backupFailure, writeBackup, type BackupOptions } from "./backup.ts";

// SAFETY: runBackupWorker passes BackupOptions as workerData.
writeBackup({ ...(workerData as BackupOptions), note: `${en["backup.note"]}\n\n${ko["backup.note"]}\n` }).then(
  (summary) => parentPort!.postMessage({ summary }),
  (error: unknown) => parentPort!.postMessage({ error: backupFailure(error) }),
);
