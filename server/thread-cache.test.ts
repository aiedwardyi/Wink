import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "opus" });

/** Chats of `rows` rows each, written by one store; the store under test reads them cold. */
function chats(count: number, rows: number): string[] {
  const setup = new Store(selection);
  return Array.from({ length: count }, () => {
    const { threadId } = setup.createBot({}, { seedMessages: false });
    for (let index = 0; index < rows; index++) setup.appendMessage(threadId, { role: "user", kind: "text", text: `row ${index}` });
    return threadId;
  });
}

describe("thread cache", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("drops the least recently used chats once their rows pass the budget", () => {
    const [a, b, c, d] = chats(4, 4);
    const store = new Store(selection, { threadCacheRows: 10 });
    for (const threadId of [a!, b!, c!]) store.messagesFor(threadId);
    expect([a, b, c].map((threadId) => store.loaded(threadId!))).toEqual([false, true, true]);
    store.messagesFor(b!);
    store.messagesFor(d!);
    expect([a, b, c, d].map((threadId) => store.loaded(threadId!))).toEqual([false, true, false, true]);
  });

  it("keeps the two newest chats even when one alone is over the budget", () => {
    const [a, b] = chats(2, 4);
    const store = new Store(selection, { threadCacheRows: 3 });
    store.messagesFor(a!);
    store.messagesFor(b!);
    expect([store.loaded(a!), store.loaded(b!)]).toEqual([true, true]);
  });

  it("never drops a chat a turn is running in", () => {
    const setup = new Store(selection);
    const busy = setup.createBot({}, { seedMessages: false });
    setup.appendMessage(busy.threadId, { role: "user", kind: "text", text: "go" });
    const others = chats(3, 4);
    const store = new Store(selection, { threadCacheRows: 6 });
    store.setActivity(busy.id, "working");
    store.messagesFor(busy.threadId);
    for (const threadId of others) store.messagesFor(threadId);
    expect(store.loaded(busy.threadId)).toBe(true);
    expect(store.loaded(others[0]!)).toBe(false);
  });

  it("a dropped chat reads back whole and takes new rows on its branch", () => {
    const [a, b, c] = chats(3, 4);
    const store = new Store(selection, { threadCacheRows: 8 });
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
