import { once } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { sendNow } from "./save-defer.ts";
import { Store } from "./store.ts";

const BOTS = join(DATA_DIR, "bots.json");
const SLOW_MS = 200;
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const block = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const savedBots = () => JSON.parse(readFileSync(BOTS, "utf8"));

const turn = (store: Store, botId: string, threadId: string) => {
  store.setActivity(botId, "working", threadId);
  store.setResumeCursor(botId, "claude", "session-1", threadId);
  store.markTaskDispatched(botId, threadId, "claude", "claude-sonnet-5");
  settle(store, botId, threadId);
};

const settle = (store: Store, botId: string, threadId: string) => {
  store.addTaskUsage(botId, threadId, { input: 1200, output: 80, cachedInput: 900, costUsd: 0.02 });
  store.recordNativePrompt(botId, threadId, "claude", { first: 1200, last: 1200 }, 200_000);
  store.setActivity(botId, "idle");
  store.patchBot(botId, { unread: true }, { soon: true });
};

const CLIENT = `
const { parentPort, workerData } = require("node:worker_threads");
require("node:http").get({ host: "127.0.0.1", port: workerData }, (res) => {
  res.setEncoding("utf8");
  res.on("data", (text) => parentPort.postMessage({ text, at: Date.now() }));
});
`;

/** The reader runs on its own thread: this one is blocked while a save runs, so it cannot time an arrival. */
async function openStream() {
  let opened!: (res: ServerResponse) => void;
  const ready = new Promise<ServerResponse>((resolve) => { opened = resolve; });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    opened(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  const client = new Worker(CLIENT, { eval: true, workerData: (server.address() as AddressInfo).port });
  const arrival = async (): Promise<{ text: string; at: number }> => (await once(client, "message"))[0];
  const hello = arrival();
  const res = await ready;
  await hello;
  return {
    res,
    arrival,
    async close() {
      await client.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("saves off the reply path", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a turn's last frame before its bookkeeping is saved", async () => {
    const store = new Store(selection, { coalesceSaves: true });
    const bot = store.createBot();
    store.setActivity(bot.id, "working", bot.threadId);
    store.setResumeCursor(bot.id, "claude", "session-1", bot.threadId);
    await tick();
    const stream = await openStream();
    const write = atomic.writeFileAtomic;
    const saved: number[] = [];
    let botsSaved!: () => void;
    const savedOnce = new Promise<void>((resolve) => { botsSaved = resolve; });
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, data, options) => {
      block(SLOW_MS);
      write(path, data, options);
      if (path !== BOTS) return;
      saved.push(Date.now());
      botsSaved();
    });
    try {
      const arrived = stream.arrival();
      stream.res.write("data: turn.completed\n\n");
      settle(store, bot.id, bot.threadId);
      // The frame can land before the deferred save has even started
      const [frame] = await Promise.all([arrived, savedOnce]);
      expect(frame.text).toContain("turn.completed");
      expect(frame.at).toBeLessThan(saved[0]!);
      expect(saved).toHaveLength(1);
    } finally {
      await stream.close();
    }
  });

  it("puts a held frame on the wire before the caller's next line", async () => {
    const stream = await openStream();
    try {
      const arrived = stream.arrival();
      stream.res.write("data: turn.completed\n\n");
      sendNow(stream.res);
      block(SLOW_MS);
      const unblocked = Date.now();
      expect((await arrived).at).toBeLessThan(unblocked);
    } finally {
      await stream.close();
    }
  });

  it("writes bots.json once for a tick of bookkeeping", async () => {
    const store = new Store(selection, { coalesceSaves: true });
    const bot = store.createBot();
    const write = vi.spyOn(atomic, "writeFileAtomic");
    turn(store, bot.id, bot.threadId);
    expect(write).not.toHaveBeenCalled();
    await tick();
    expect(write).toHaveBeenCalledExactlyOnceWith(BOTS, JSON.stringify(store.bots, null, 2), { mode: 0o600 });
    store.flushSaves();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes the same bots.json after a flush as saving every change at once", () => {
    const bot = new Store(selection).createBot();
    const before = readFileSync(BOTS, "utf8");
    turn(new Store(selection), bot.id, bot.threadId);
    const atOnce = readFileSync(BOTS, "utf8");
    expect(atOnce).not.toBe(before);

    writeFileSync(BOTS, before);
    const store = new Store(selection, { coalesceSaves: true });
    turn(store, bot.id, bot.threadId);
    expect(readFileSync(BOTS, "utf8")).toBe(before);
    store.flushSaves();
    expect(readFileSync(BOTS, "utf8")).toBe(atOnce);
  });

  it("carries what a tick owes in a save made at once", async () => {
    const store = new Store(selection, { coalesceSaves: true });
    const bot = store.createBot();
    const write = vi.spyOn(atomic, "writeFileAtomic");
    store.setActivity(bot.id, "working", bot.threadId);
    store.patchBot(bot.id, { name: "Ada" });
    expect(savedBots()[0]).toMatchObject({ name: "Ada", activity: "working" });
    await tick();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps a save that failed for the flush", async () => {
    const store = new Store(selection, { coalesceSaves: true });
    const bot = store.createBot();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => { throw new Error("disk full"); });
    store.setActivity(bot.id, "working", bot.threadId);
    await tick();
    expect(error).toHaveBeenCalledTimes(1);
    expect(savedBots()[0].activity).toBeUndefined();
    store.flushSaves();
    expect(savedBots()[0].activity).toBe("working");
  });
});
