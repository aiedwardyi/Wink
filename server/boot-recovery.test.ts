import { readFileSync, rmSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, expect, it, vi } from "vitest";

import { deferBootRecovery } from "./boot-recovery.ts";
import { DATA_DIR } from "./config.ts";
import { _loadPending, discardOrphanedDelegations } from "./delegations.ts";
import { handMail, mailForTurn } from "./mail.ts";
import { closeMessageDb } from "./message-db.ts";
import { createStartupTiming } from "./startup-timing.ts";
import { _queuedCount, _resetSteerQueue, queueMark } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { currentTurnTrace } from "./turn-timing.ts";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  _loadPending();
  _resetSteerQueue();
});

function crashed() {
  const store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  const from = store.createBot({}, { seedMessages: false });
  const target = store.createBot({}, { seedMessages: false });
  const mailKey = `task:reply:${from.threadId}`;
  const reply = store.appendMessage(from.threadId, { role: "bot", kind: "activity", text: "Finished work", comm: { groupId: "dm", withBotId: target.id, withName: target.name, withColor: target.color, peer: "reply", taskId: "task", mailKey, state: "done" } });
  handMail(store, from.threadId, "task", "crashed", "request");
  store.appendMessage(from.threadId, { role: "user", kind: "text", text: "which branch?", quick: { state: "asked" } });
  discardOrphanedDelegations({ store, broadcast: () => {} }, false);
  return { store, from, reply };
}

it("leaves crash recovery until the chat is painted", async () => {
  const { store, from, reply } = crashed();
  const timing = createStartupTiming({ write: () => {} });
  const follow = vi.fn();
  deferBootRecovery(store, follow, timing);
  timing.serving();
  await new Promise(setImmediate);
  expect(follow).not.toHaveBeenCalled();
  expect(_queuedCount(from.threadId)).toBe(0);
  expect(mailForTurn(store, from.threadId)).toEqual([]);
  timing.paint();
  await timing.waitFor("recovery");
  expect(follow).toHaveBeenCalledOnce();
  expect(_queuedCount(from.threadId)).toBe(1);
  expect(mailForTurn(store, from.threadId).map((part) => part.id)).toEqual([reply.id]);
});

it("starts a turn claimed before recovery only after it, with the handed mail released", async () => {
  const { store, from, reply } = crashed();
  const timing = createStartupTiming({ write: () => {} });
  deferBootRecovery(store, () => {}, timing);
  const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("async function startClaimedTurn(");
  const body = text.slice(text.indexOf("{\n", start) + 2, text.indexOf("  const bot =", start));
  const dispatch = vi.fn(() => mailForTurn(store, from.threadId).map((part) => part.id));
  const turn = runInNewContext(`(async () => { ${body} return dispatch(); })()`, {
    startupTiming: timing, currentTurnTrace, currentTurnEpoch: () => 0, queueMark, dispatch, botId: from.id,
  }) as Promise<string[]>;
  await new Promise(setImmediate);
  expect(dispatch).not.toHaveBeenCalled();
  timing.paint();
  expect(await turn).toEqual([reply.id]);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("registers recovery before any held request is replayed", () => {
  const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const registered = text.indexOf("\ndeferBootRecovery(store");
  expect(registered).toBeGreaterThan(-1);
  expect(registered).toBeLessThan(text.indexOf("early.setHandler(handleRequest)"));
});
