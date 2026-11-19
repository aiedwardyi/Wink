import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";

import { bootReads, startBootReads } from "./boot-reads.ts";
import { chatListPage } from "./cold-thread.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

const workers = vi.hoisted(() => ({ live: new Set<Worker>(), started: 0, peak: 0 }));

vi.mock(import("node:worker_threads"), async (original) => {
  const threads = await original();
  return {
    ...threads,
    Worker: class extends threads.Worker {
      constructor(...args: ConstructorParameters<typeof threads.Worker>) {
        super(...args);
        workers.live.add(this);
        workers.started++;
        workers.peak = Math.max(workers.peak, workers.live.size);
        this.once("exit", () => workers.live.delete(this));
      }
    },
  };
});

afterEach(async () => {
  await Promise.all([...workers.live].map((worker) => worker.terminate()));
});

it("shares one isolate for boot and cold reads and releases it at idle", async () => {
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = store.createBot({}, { seedMessages: false });
  const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
  const note = store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "report", mailbox: { key: "test" } });
  const read = () => chatListPage({ loaded: () => false }, bot.threadId, 10);

  const page = read();
  await startBootReads({ dataDir: DATA_DIR, now: Date.now(), askThreads: [], cutoverAt: null, notices: { migration: "", conflict: [] }, reportThreads: [] });
  expect((await page)?.messages.map(({ id }) => id)).toEqual([message.id, note.id]);
  expect((await bootReads()).receipts).toContainEqual({ key: "test", id: note.id, at: note.at });
  expect(workers.peak).toBe(1);

  expect(await read()).toEqual(await page);
  expect(workers.started).toBe(2);
  expect(workers.peak).toBe(1);
  await vi.waitFor(() => expect(workers.live.size).toBe(0));
});
