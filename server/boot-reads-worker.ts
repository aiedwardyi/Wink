import { parentPort, workerData } from "node:worker_threads";

import { findBootRows, type BootReadInput } from "./boot-reads.ts";

try {
  // SAFETY: startBootReads passes BootReadInput as workerData.
  parentPort!.postMessage({ rows: findBootRows(workerData as BootReadInput) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
