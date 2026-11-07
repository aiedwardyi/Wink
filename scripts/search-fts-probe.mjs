// Run under the packaged runtime after `pnpm build:server`:
//   ELECTRON_RUN_AS_NODE=1 "$(node -p "require('electron')")" scripts/search-fts-probe.mjs
// The bundled search worker probes fts5 before it creates the cache; ready means both passed.
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

process.on("uncaughtException", (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(70);
});
process.stdout.on("error", () => {});

const dataDir = mkdtempSync(join(tmpdir(), "search-fts-probe-"));
const worker = new Worker(new URL("../dist-server/search-worker.js", import.meta.url), { workerData: { dataDir } });
const [message] = await once(worker, "message");
worker.postMessage({ type: "stop" });
await once(worker, "exit");
rmSync(dataDir, { recursive: true, force: true });
console.log(JSON.stringify({ node: process.versions.node, sqlite: process.versions.sqlite, electron: process.versions.electron ?? null, worker: message }));
process.exit(message.type === "ready" ? 0 : 1);
