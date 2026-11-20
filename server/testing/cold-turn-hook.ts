// Preloaded with --import into a harness boot: each Claude sendTurn unloads its chat and starts the chat's background
// load, so the turn runs while Map would still be loading the chat; a COLD_TURN_GATES/unload file holding a thread id
// does the same at once. The load's page reads wait for a COLD_TURN_GATES/<threadId> file. COLD_TURN_LOG gets a line
// for each whole read of a chat while its load waits, each started and settled turn and each load that lands.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { coldLoad } from "../cold-thread.ts";
import type { ProviderInstance } from "../contracts.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { Store } from "../store.ts";

const log = process.env.COLD_TURN_LOG!;
const gates = process.env.COLD_TURN_GATES!;
const write = (entry: Record<string, unknown>) => appendFileSync(log, `${JSON.stringify(entry)}\n`);
const loading = new Set<string>();
const held: Array<{ threadId: string; read: () => void }> = [];
let store: Store | undefined;

const unload = (threadId: string) => {
  // SAFETY: threads is Store's chat cache; dropping an entry is what a trim does to an idle chat.
  (store as unknown as { threads: { delete(threadId: string): void } }).threads.delete(threadId);
  loading.add(threadId);
  void coldLoad(store!, threadId);
  write({ unloaded: threadId });
};

const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (this: Worker, request: { threadId?: string; after?: number }, transfer?: Parameters<Worker["postMessage"]>[1]) {
  const threadId = request?.threadId;
  if (threadId !== undefined && loading.has(threadId) && request.after !== undefined && !existsSync(join(gates, threadId))) held.push({ threadId, read: () => post.call(this, request, transfer) });
  else post.call(this, request, transfer);
};
setInterval(() => {
  const ask = join(gates, "unload");
  if (existsSync(ask)) {
    const threadId = readFileSync(ask, "utf8");
    rmSync(ask);
    unload(threadId);
  }
  for (const entry of held.filter((entry) => existsSync(join(gates, entry.threadId)))) {
    held.splice(held.indexOf(entry), 1);
    entry.read();
  }
}, 20).unref();

// SAFETY: thread() is Store's whole read of a chat into its cache; the hook only watches it.
const internals = Store.prototype as unknown as { thread(this: Store, threadId: string): unknown };
const thread = internals.thread;
internals.thread = function (this: Store, threadId: string) {
  store ??= this;
  if (loading.has(threadId) && !this.loaded(threadId)) write({ wholeRead: threadId, stack: new Error().stack?.split("\n").slice(2, 10).map((line) => line.trim()) });
  return thread.call(this, threadId);
};
const adopt = Store.prototype.adopt;
Store.prototype.adopt = function (this: Store, threadId, read) {
  const landing = loading.has(threadId) && !this.loaded(threadId);
  adopt.call(this, threadId, read);
  if (landing) write({ landed: threadId, rows: read.messages.length });
};

const create = ClaudeDriver.create.bind(ClaudeDriver);
ClaudeDriver.create = async (input) => {
  const instance: ProviderInstance = await create(input);
  instance.adapter.onEvent((event) => {
    // after the runtime subscribers and the work they put off to the loop's next turn
    if (event.type === "turn.completed") setImmediate(() => setImmediate(() => write({ settled: event.threadId })));
    else if (event.type === "turn.started") setImmediate(() => setImmediate(() => write({ started: event.threadId })));
  });
  const sendTurn = instance.adapter.sendTurn.bind(instance.adapter);
  instance.adapter.sendTurn = (turn) => {
    unload(turn.threadId);
    return sendTurn(turn);
  };
  return instance;
};
