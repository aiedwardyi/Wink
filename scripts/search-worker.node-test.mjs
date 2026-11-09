import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

test("packaged search worker builds and validates the cache without node_modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "search-worker-package-"));
  const server = join(root, "Resources", "server");
  const dataDir = join(root, "data");
  mkdirSync(server, { recursive: true });
  mkdirSync(dataDir);
  copyFileSync(new URL("../dist-server/search-worker.js", import.meta.url), join(server, "search-worker.js"));
  const source = new DatabaseSync(join(dataDir, "messages.db"));
  source.exec(`CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id))`);
  const insert = source.prepare("INSERT INTO messages VALUES (?, ?, ?, 'user', 'text', ?, ?)");
  for (let i = 0; i < 600; i++) insert.run(`t${i % 2}`, `m${i}`, i, `packaged row ${i}`, JSON.stringify({ id: `m${i}`, role: "user", kind: "text", at: i, text: `packaged row ${i}` }));
  source.close();

  const worker = new Worker(join(server, "search-worker.js"), { workerData: { dataDir } });
  const messages = [];
  worker.on("message", (message) => {
    messages.push(message.type);
    if (message.type === "ready" || (message.type === "done" && messages.length < 3)) {
      worker.postMessage({ type: "work", epoch: messages.length, generation: 0, full: true, threads: new Set(), keys: new Map() });
    } else worker.postMessage({ type: "stop" });
  });
  try {
    assert.deepEqual(await once(worker, "exit"), [0]);
    assert.deepEqual(messages, ["ready", "done", "done"]);
    const cache = new DatabaseSync(join(dataDir, "search-cache.db"), { readOnly: true });
    assert.deepEqual({ ...cache.prepare("SELECT generation, state FROM search_meta").get() }, { generation: 2, state: "current" });
    assert.equal(cache.prepare("SELECT count(*) AS n FROM search_docs").get().n, 600);
    cache.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
