import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chatListPage, paneNoteWaitingAtBoot, warmChats } from "./cold-thread.ts";
import { offscreenLimit } from "./chat-tail.ts";
import { DATA_DIR } from "./config.ts";
import { hasLocalUndeliveredPaneNote } from "./pane-wake.ts";
import { Store, type Message } from "./store.ts";

afterEach(() => vi.restoreAllMocks());

const fresh = () => new Store(() => ({ instanceId: "claude", model: "opus" }));
type Chat = { unread?: boolean; readAt?: number };

function fullPage(threadId: string, limit: number, chat?: Chat) {
  const store = fresh();
  const all = store.messagesFor(threadId);
  const rows = chat ? offscreenLimit(all, limit, chat, store.activeLeaf(threadId)) : limit;
  const start = Math.max(0, all.length - rows);
  return { messages: all.slice(start), hasMore: start > 0 };
}

function expectSamePages(threadId: string) {
  for (const limit of [0, 1, 50, 200, 1000])
    for (const chat of [undefined, {}, { unread: true }, { unread: true, readAt: 150 }]) {
      const store = fresh();
      expect(chatListPage(store, threadId, limit, chat), `limit ${limit} ${JSON.stringify(chat)}`).toEqual(fullPage(threadId, limit, chat));
      expect(store.loaded(threadId)).toBe(false);
    }
}

const card = (subtitle: string): Omit<Message, "id" | "at"> => ({ role: "bot", kind: "options", card: { title: "Question", askUser: true, subtitle, options: ["Yes"] } });

describe("chat list page from a thread's tail", () => {
  it("matches the loaded page on a long thread with tool rows", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    for (let i = 0; i < 300; i++) {
      if (i % 40 === 0) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `go ${i}`, at: i });
      else store.appendMessage(bot.threadId, { role: "bot", kind: "activity", at: i, tool: { name: "Bash", ok: true, detail: { input: `step ${i}`, output: ["ok"] } } });
    }
    expectSamePages(bot.threadId);
  });

  it("matches when a reply quotes a question older than the tail", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    store.appendMessage(bot.threadId, card("Which db?"));
    for (let i = 0; i < 300; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `ok ${i}` });
    store.appendMessage(bot.threadId, card("Which port?"));
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Re: “Which db?”\nPostgres" });
    for (let i = 0; i < 120; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `ok ${i}` });
    expect(fullPage(bot.threadId, 200, {}).messages).toHaveLength(122);
    expectSamePages(bot.threadId);
  });

  it("matches on a branched thread", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "start" });
    for (let i = 0; i < 260; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `ok ${i}` });
    store.branchMessage(bot.threadId, first.id, "start over");
    for (let i = 0; i < 20; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `again ${i}` });
    expectSamePages(bot.threadId);
    store.setActiveLeaf(bot.threadId, store.messagesFor(bot.threadId)[200]!.id);
    expectSamePages(bot.threadId);
  });

  it("matches on rows imported from a legacy file without parent ids", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const legacy = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, at: i, role: i % 30 ? "bot" : "user", kind: "text", text: `line ${i}` }));
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));
    fresh();
    expectSamePages(bot.threadId);
  });

  it("leaves a loaded thread to the store", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(chatListPage(store, bot.threadId, 200)).toBeNull();
  });

  it("reads the head without loading the thread", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const writer = fresh();
    const first = writer.appendMessage(bot.threadId, { role: "user", kind: "text", text: "start" });
    const reply = writer.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "ok" });
    const store = fresh();
    expect(store.activeLeaf(bot.threadId)).toBe(reply.id);
    const branch = writer.branchMessage(bot.threadId, first.id, "start over")!;
    expect(store.activeLeaf(bot.threadId)).toBe(branch.id);
    writer.setActiveLeaf(bot.threadId, reply.id);
    expect(store.activeLeaf(bot.threadId)).toBe(reply.id);
    expect(store.loaded(bot.threadId)).toBe(false);
  });
});

describe("pane note check at boot", () => {
  const note = { role: "bot", kind: "note", text: "worker done", origin: "home" } as const;
  const tool = { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } } as const;

  function expectSameAnswer(threadId: string, deliveredId?: string) {
    const expected = hasLocalUndeliveredPaneNote(fresh().activePath(threadId), deliveredId, "home");
    const store = fresh();
    const path = vi.spyOn(store, "activePath");
    expect(paneNoteWaitingAtBoot(store, threadId, deliveredId, "home")).toBe(expected);
    return { expected, loaded: path.mock.calls.length > 0 };
  }

  it("decides from the newest rows when they hold the answer", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    for (let i = 0; i < 1500; i++) store.appendMessage(bot.threadId, tool);
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "run the worker" });
    const done = store.appendMessage(bot.threadId, note);
    store.appendMessage(bot.threadId, tool);
    expect(expectSameAnswer(bot.threadId)).toEqual({ expected: true, loaded: false });
    expect(expectSameAnswer(bot.threadId, done.id)).toEqual({ expected: false, loaded: false });
  });

  it("loads the thread when the note sits past the newest rows", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "run the worker" });
    store.appendMessage(bot.threadId, note);
    for (let i = 0; i < 1500; i++) store.appendMessage(bot.threadId, tool);
    expect(expectSameAnswer(bot.threadId)).toEqual({ expected: true, loaded: true });
  });

  it("loads the thread when the head is on another branch", () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "run the worker" });
    store.appendMessage(bot.threadId, note);
    const branch = store.branchMessage(bot.threadId, first.id, "run it again")!;
    store.setActiveLeaf(bot.threadId, store.messagesFor(bot.threadId)[1]!.id);
    store.appendMessage(bot.threadId, tool);
    store.setActiveLeaf(bot.threadId, branch.id);
    expect(expectSameAnswer(bot.threadId)).toEqual({ expected: false, loaded: true });
  });
});

describe("warm chats", () => {
  it("loads every chat after the paint, the open one first", async () => {
    const setup = fresh();
    const bots = [setup.createBot({}, { seedMessages: false }), setup.createBot({}, { seedMessages: false }), setup.createBot({}, { seedMessages: false })];
    for (const bot of bots) setup.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const store = fresh();
    const read = vi.spyOn(store, "messagesFor");
    let start!: () => Promise<void>;
    const open = warmChats(store, () => bots, (begin) => (start = begin));
    open(bots[2]!.id);
    expect(read).not.toHaveBeenCalled();
    await start();
    await vi.waitFor(() => expect(bots.every((bot) => store.loaded(bot.threadId))).toBe(true));
    expect(read.mock.calls.map(([threadId]) => threadId)).toEqual([bots[2]!.threadId, bots[0]!.threadId, bots[1]!.threadId]);
  });
});
