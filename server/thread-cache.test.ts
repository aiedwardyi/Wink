import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { readThread, replaceThread } from "./message-db.ts";
import { bootPaneWakes } from "./pane-wake.ts";
import { Store, type Message } from "./store.ts";
import type { SyncChange } from "./thread-sync-v2.ts";

const selection = () => ({ instanceId: "claude", model: "opus" });
const size = (threadId: string) => readThread(threadId, "").chars;

/** Chats of `rows` rows each, written by one store; the store under test reads them cold. */
function chats(count: number, rows: number, text = (index: number) => `row ${index}`): string[] {
  const setup = new Store(selection);
  return Array.from({ length: count }, () => {
    const { threadId } = setup.createBot({}, { seedMessages: false });
    for (let index = 0; index < rows; index++) setup.appendMessage(threadId, { role: "user", kind: "text", text: text(index) });
    return threadId;
  });
}

describe("thread cache", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("drops the least recently used chats once their size passes the budget", () => {
    const [a, b, c, d] = chats(4, 4);
    const store = new Store(selection, { threadCacheChars: size(a!) * 2.5 });
    for (const threadId of [a!, b!, c!]) store.messagesFor(threadId);
    expect([a, b, c].map((threadId) => store.loaded(threadId!))).toEqual([false, true, true]);
    store.messagesFor(b!);
    store.messagesFor(d!);
    expect([a, b, c, d].map((threadId) => store.loaded(threadId!))).toEqual([false, true, false, true]);
  });

  it("keeps the two newest chats even when one alone is over the budget", () => {
    const [a, b] = chats(2, 4);
    const store = new Store(selection, { threadCacheChars: size(a!) / 2 });
    store.messagesFor(a!);
    store.messagesFor(b!);
    expect([store.loaded(a!), store.loaded(b!)]).toEqual([true, true]);
  });

  it("weighs a chat by its rows' size, not their count", () => {
    const [long, b, c] = chats(3, 2, (index) => `${index}${"x".repeat(32_768)}`);
    const store = new Store(selection, { threadCacheChars: size(long!) * 2.5 });
    for (const threadId of [long!, b!, c!]) store.messagesFor(threadId);
    expect([long, b, c].map((threadId) => store.loaded(threadId!))).toEqual([false, true, true]);
  });

  it("drops an idle chat once a patch grows the loaded ones past the budget", () => {
    const [a, b, c] = chats(3, 1);
    const store = new Store(selection, { threadCacheChars: size(a!) * 3.5 });
    for (const threadId of [a!, b!, c!]) store.messagesFor(threadId);
    expect(store.loaded(a!)).toBe(true);
    store.patchMessage(c!, store.activeLeaf(c!)!, { text: "x".repeat(size(a!) * 2) });
    expect([a, b, c].map((threadId) => store.loaded(threadId!))).toEqual([false, true, true]);
  });

  it("drops an idle chat once synced rows grow the loaded ones past the budget", () => {
    const setup = new Store(selection);
    const bots = Array.from({ length: 3 }, () => setup.createBot({}, { seedMessages: false }));
    for (const bot of bots) setup.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const [a, b, c] = bots.map((bot) => bot.threadId);
    const store = new Store(selection, { threadCacheChars: size(a!) * 3.5 });
    for (const threadId of [a!, b!, c!]) store.messagesFor(threadId);
    let parent = store.activeLeaf(c!);
    const changes: SyncChange[] = Array.from({ length: 10 }, (_, index) => {
      const message: Message = { id: `synced-${index}`, parentId: parent, at: index + 1, role: "bot", kind: "text", text: `synced ${index}` };
      parent = message.id;
      return { cursor: 0, kind: "row", rowId: message.id, value: message, conflict: false };
    });
    store.applySyncChanges(bots[2]!.id, c!, changes);
    expect(store.loaded(a!)).toBe(false);
    expect(store.messagesFor(c!).map((message) => message.id)).toContain("synced-9");
  });

  it("never drops a chat a turn is running in", () => {
    const setup = new Store(selection);
    const busy = setup.createBot({}, { seedMessages: false });
    setup.appendMessage(busy.threadId, { role: "user", kind: "text", text: "go" });
    const others = chats(3, 4);
    const store = new Store(selection, { threadCacheChars: size(others[0]!) * 1.5 });
    store.setActivity(busy.id, "working");
    store.messagesFor(busy.threadId);
    for (const threadId of others) store.messagesFor(threadId);
    expect(store.loaded(busy.threadId)).toBe(true);
    expect(store.loaded(others[0]!)).toBe(false);
  });

  it("keeps a chat its driver still owns after Stop marked the bot idle", () => {
    const [held, ...others] = chats(4, 4);
    const store = new Store(selection, { threadCacheChars: size(held!) * 1.5 });
    store.holdThreads(() => [held!]);
    for (const threadId of [held!, ...others]) store.messagesFor(threadId);
    expect(store.loaded(held!)).toBe(true);
    expect(store.loaded(others[0]!)).toBe(false);
  });

  it("evicts eligible chats when turns settle without another cache write", () => {
    const ids = chats(4, 4);
    const store = new Store(selection, { threadCacheChars: size(ids[0]!) * 2.5 });
    const bots = ids.map((id) => store.botByThread(id)!);
    const held = new Set(ids);
    store.holdThreads(() => held);
    for (const bot of bots) {
      store.setActivity(bot.id, "working");
      store.messagesFor(bot.threadId);
    }
    expect(ids.map((id) => store.loaded(id))).toEqual([true, true, true, true]);
    for (const bot of bots) {
      held.delete(bot.threadId);
      store.setActivity(bot.id, "idle");
    }
    expect(ids.map((id) => store.loaded(id))).toEqual([false, false, true, true]);
  });

  it("evicts a stopped chat only after the driver releases it", () => {
    const [held, b, c] = chats(3, 4);
    const store = new Store(selection, { threadCacheChars: size(b!) + size(c!) });
    const bot = store.botByThread(held!)!;
    const driverThreads = new Set([held!]);
    store.holdThreads(() => driverThreads);
    store.setActivity(bot.id, "working");
    for (const id of [held!, b!, c!]) store.messagesFor(id);
    store.setActivity(bot.id, "idle");
    expect(store.loaded(held!)).toBe(true);
    driverThreads.delete(held!);
    store.trimThreadCache();
    expect([held, b, c].map((id) => store.loaded(id!))).toEqual([false, true, true]);
  });

  it("finds a pending pane wake after evicting legacy rows with a stored head", () => {
    const [legacy, b, c] = chats(3, 4);
    replaceThread(legacy!, [
      { id: "user", at: 1, role: "user", kind: "text", text: "Watch the worker" },
      { id: "note", at: 2, role: "bot", kind: "note", text: "Worker finished", origin: "home" },
      { id: "activity", at: 3, role: "bot", kind: "activity", text: "Reviewing" },
    ], "activity");
    const store = new Store(selection, { threadCacheChars: size(b!) + size(c!) });
    const bot = store.botByThread(legacy!)!;
    store.markPaneNotesDelivered(bot.id, bot.threadId, undefined);
    const wake = { botId: bot.id, threadId: bot.threadId };
    store.messagesFor(legacy!);
    expect(bootPaneWakes(store, "home")).toEqual([wake]);
    store.messagesFor(b!);
    store.messagesFor(c!);
    expect(store.loaded(legacy!)).toBe(false);
    expect(bootPaneWakes(store, "home")).toEqual([wake]);
    expect(store.loaded(legacy!)).toBe(false);
  });

  it("warms a chat only into spare room, and drops it before the chats in use", () => {
    const [open, other, warmed, fits, later] = chats(5, 4);
    const store = new Store(selection, { threadCacheChars: size(open!) * 2.5 });
    store.messagesFor(open!);
    store.messagesFor(other!);
    store.warm(warmed!);
    expect([store.loaded(open!), store.loaded(other!), store.loaded(warmed!)]).toEqual([true, true, false]);
    store.messagesFor(other!);
    const roomy = new Store(selection, { threadCacheChars: size(open!) * 3.5 });
    roomy.messagesFor(open!);
    roomy.warm(fits!);
    roomy.messagesFor(other!);
    roomy.messagesFor(later!);
    expect([open, fits, other, later].map((threadId) => roomy.loaded(threadId!))).toEqual([true, false, true, true]);
  });

  it("a dropped chat reads back whole and takes new rows on its branch", () => {
    const [a, b, c] = chats(3, 4);
    const store = new Store(selection, { threadCacheChars: size(a!) * 2.5 });
    const before = store.messagesFor(a!).map((message) => message.id);
    store.messagesFor(b!);
    store.messagesFor(c!);
    expect(store.loaded(a!)).toBe(false);
    const added = store.appendMessage(a!, { role: "user", kind: "text", text: "after" });
    expect(added.parentId).toBe(before.at(-1));
    expect(store.messagesFor(a!).map((message) => message.id)).toEqual([...before, added.id]);
    expect(new Store(selection).activePath(a!).map((message) => message.id)).toEqual([...before, added.id]);
  });
});
