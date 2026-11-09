import { parentPort, workerData } from "node:worker_threads";

import { corruption, createSearchIndexer, probeSearchFts, removeSearchCache, SearchCacheGone, type SearchCrash, type SearchWork, type SearchWorkerMessage } from "./search-cache.ts";

type Request = { type: "stop" } | ({ type: "work"; epoch: number; generation: number } & SearchWork);

const { dataDir, crash } = workerData as { dataDir: string; crash?: SearchCrash };
const port = parentPort!;
const post = (message: SearchWorkerMessage) => port.postMessage(message);
let indexer: ReturnType<typeof createSearchIndexer> | null = null;
let queue = Promise.resolve();

function failed(reason: "fts" | "corrupt" | "gone" | "error"): void {
  indexer?.close();
  indexer = null;
  if (reason === "corrupt") {
    try {
      removeSearchCache(dataDir);
    } catch {}
  }
  post({ type: "failed", reason });
  port.close();
}

if (!probeSearchFts()) failed("fts");
else {
  try {
    indexer = createSearchIndexer(dataDir, crash);
    post({ type: "ready" });
  } catch (error) {
    // only the cache file has been read at this point
    failed(corruption(error) ? "corrupt" : "error");
  }
}

port.on("message", (request: Request) => {
  if (request.type === "stop") {
    indexer?.stop();
    queue = queue.then(() => {
      indexer?.close();
      indexer = null;
      port.close();
    });
    return;
  }
  queue = queue.then(async () => {
    const current = indexer;
    if (!current) return;
    try {
      if (await current.work(request)) post({ type: "done", epoch: request.epoch, generation: request.generation });
    } catch (error) {
      failed(error instanceof SearchCacheGone ? "gone" : current.corrupt(error) ? "corrupt" : "error");
    }
  });
});
