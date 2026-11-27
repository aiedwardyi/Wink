import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chatListPage, coldLoad, coldPageBefore, coldPaneReason, coldSendIds, coldWriteRows, sentRow, WARM_ROW_CAP, warmChats } from "./cold-thread.ts";
import { offscreenLimit } from "./chat-tail.ts";
import { DATA_DIR } from "./config.ts";
import { applySyncedRows, insertMessage, messageDatabase, messageDbFile, readThread } from "./message-db.ts";
import { paneLines, paneReason } from "../shared/pane-note.ts";
import { Store, type Message } from "./store.ts";
import type { SyncChange } from "./thread-sync-v2.ts";

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

async function expectSamePages(threadId: string) {
  for (const limit of [0, 1, 50, 200, 1000])
    for (const chat of [undefined, {}, { unread: true }, { unread: true, readAt: 150 }]) {
      const store = fresh();
      expect(await chatListPage(store, threadId, limit, chat), `limit ${limit} ${JSON.stringify(chat)}`).toEqual(fullPage(threadId, limit, chat));
      expect(store.loaded(threadId)).toBe(false);
    }
}

const card = (subtitle: string): Omit<Message, "id" | "at"> => ({ role: "bot", kind: "options", card: { title: "Question", askUser: true, subtitle, options: ["Yes"] } });

describe("chat list page from a thread's tail", () => {
  it("matches the loaded page on a long thread with tool rows", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    for (let i = 0; i < 300; i++) {
      if (i % 40 === 0) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `go ${i}`, at: i });
      else store.appendMessage(bot.threadId, { role: "bot", kind: "activity", at: i, tool: { name: "Bash", ok: true, detail: { input: `step ${i}`, output: ["ok"] } } });
    }
    await expectSamePages(bot.threadId);
  });

  it("matches when a reply quotes a question older than the tail", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    store.appendMessage(bot.threadId, card("Which db?"));
    for (let i = 0; i < 300; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `ok ${i}` });
    store.appendMessage(bot.threadId, card("Which port?"));
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Re: “Which db?”\nPostgres" });
    for (let i = 0; i < 120; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `ok ${i}` });
    expect(fullPage(bot.threadId, 200, {}).messages).toHaveLength(122);
    await expectSamePages(bot.threadId);
  });

  it("matches on a branched thread", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "start" });
    for (let i = 0; i < 260; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `ok ${i}` });
    store.branchMessage(bot.threadId, first.id, "start over");
    for (let i = 0; i < 20; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `again ${i}` });
    await expectSamePages(bot.threadId);
    store.setActiveLeaf(bot.threadId, store.messagesFor(bot.threadId)[200]!.id);
    await expectSamePages(bot.threadId);
  });

  it("matches on rows imported from a legacy file without parent ids", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const legacy = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, at: i, role: i % 30 ? "bot" : "user", kind: "text", text: `line ${i}` }));
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));
    fresh();
    await expectSamePages(bot.threadId);
  });

  it("leaves a loaded thread to the store", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(await chatListPage(store, bot.threadId, 200)).toBeNull();
  });

  it("leaves a thread loaded during its read to the store", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    fresh().appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const store = fresh();
    const page = chatListPage(store, bot.threadId, 200);
    store.messagesFor(bot.threadId);
    expect(await page).toBeNull();
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

describe("older page from a thread's rows", () => {
  async function expectSameOlderPages(threadId: string) {
    const all = fresh().messagesFor(threadId);
    for (const at of [0, 1, 37, 150, all.length - 1])
      for (const limit of [0, 1, 50, 200, 1000]) {
        const store = fresh();
        const start = Math.max(0, at - limit);
        expect(await coldPageBefore(store, threadId, all[at]!.id, limit), `at ${at} limit ${limit}`).toEqual({ messages: all.slice(start, at), hasMore: start > 0 });
        expect(store.loaded(threadId)).toBe(false);
      }
  }

  it("matches the loaded page on a long thread", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    for (let i = 0; i < 300; i++) store.appendMessage(bot.threadId, { role: i % 40 ? "bot" : "user", kind: "text", text: `line ${i}`, at: i });
    await expectSameOlderPages(bot.threadId);
  });

  it("matches on a branched thread", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "start" });
    for (let i = 0; i < 200; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `ok ${i}` });
    store.branchMessage(bot.threadId, first.id, "start over");
    for (let i = 0; i < 20; i++) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `again ${i}` });
    await expectSameOlderPages(bot.threadId);
  });

  it("matches on rows imported from a legacy file without parent ids", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const legacy = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, at: i, role: i % 30 ? "bot" : "user", kind: "text", text: `line ${i}` }));
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));
    fresh().messagesFor(bot.threadId);
    await expectSameOlderPages(bot.threadId);
  });

  it("leaves a loaded thread and an unknown cursor to the store", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    const store = fresh();
    const row = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(await coldPageBefore(store, bot.threadId, row.id, 50)).toBeNull();
    expect(await coldPageBefore(fresh(), bot.threadId, "nope", 50)).toBeNull();
  });
});

describe("warm chats", () => {
  it("loads every chat after the paint, the open one first", async () => {
    const setup = fresh();
    const bots = [setup.createBot({}, { seedMessages: false }), setup.createBot({}, { seedMessages: false }), setup.createBot({}, { seedMessages: false })];
    for (const bot of bots) setup.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const store = fresh();
    const read = vi.spyOn(store, "warm");
    let start!: () => Promise<void>;
    const open = warmChats(store, () => bots, (begin) => (start = begin));
    open(bots[2]!.id);
    expect(read).not.toHaveBeenCalled();
    await start();
    await vi.waitFor(() => expect(bots.every((bot) => store.loaded(bot.threadId))).toBe(true));
    expect(read.mock.calls.map(([threadId]) => threadId)).toEqual([bots[2]!.threadId, bots[0]!.threadId, bots[1]!.threadId]);
  });

  it("never loads a chat over the row cap, and warms the rest", async () => {
    const setup = fresh();
    const [big, small] = [setup.createBot({}, { seedMessages: false }), setup.createBot({}, { seedMessages: false })];
    setup.appendMessage(small!.threadId, { role: "user", kind: "text", text: "hi" });
    const db = messageDatabase();
    const insert = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'user', 'text', 'row', ?)");
    db.exec("BEGIN");
    for (let index = 0; index <= WARM_ROW_CAP; index++) insert.run(big!.threadId, `row-${index}`, index, JSON.stringify({ id: `row-${index}`, at: index, role: "user", kind: "text", text: "row" }));
    db.exec("COMMIT");
    const store = fresh();
    const read = vi.spyOn(store, "warm");
    let start!: () => Promise<void>;
    warmChats(store, () => [big!, small!], (begin) => (start = begin));
    await start();
    await vi.waitFor(() => expect(store.loaded(small!.threadId)).toBe(true));
    expect(read.mock.calls.map(([threadId]) => threadId)).toEqual([small!.threadId]);
    expect(store.loaded(big!.threadId)).toBe(false);
  });

  it("warms each chat once, and only into spare room", async () => {
    const setup = fresh();
    const bots = Array.from({ length: 4 }, () => setup.createBot({}, { seedMessages: false }));
    for (const bot of bots) for (const text of ["a", "b", "c"]) setup.appendMessage(bot.threadId, { role: "user", kind: "text", text });
    const store = new Store(() => ({ instanceId: "claude", model: "opus" }), { threadCacheChars: readThread(bots[0]!.threadId, "").chars * 2.5 });
    const read = vi.spyOn(store, "warm");
    let listed = 0;
    let start!: () => Promise<void>;
    warmChats(store, () => {
      if (++listed > 10) throw new Error("warming never ends");
      return bots;
    }, (begin) => (start = begin));
    await start();
    await vi.waitFor(() => expect(listed).toBe(5));
    expect(read.mock.calls.map(([threadId]) => threadId)).toEqual(bots.map((bot) => bot.threadId));
    expect(bots.map((bot) => store.loaded(bot.threadId))).toEqual([true, true, false, false]);
  });

  it("keeps warming past a thread that fails to load", async () => {
    const setup = fresh();
    const bots = [setup.createBot({}, { seedMessages: false }), setup.createBot({}, { seedMessages: false })];
    const store = fresh();
    const real = store.warm.bind(store);
    const read = vi.spyOn(store, "warm").mockImplementation((threadId) => {
      if (threadId === bots[0]!.threadId) throw new Error("corrupt");
      return real(threadId);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    let start!: () => Promise<void>;
    warmChats(store, () => bots, (begin) => (start = begin));
    await start();
    await vi.waitFor(() => expect(store.loaded(bots[1]!.threadId)).toBe(true));
    expect(read.mock.calls.filter(([threadId]) => threadId === bots[0]!.threadId)).toHaveLength(1);
  });
});

setFlagsFromString("--expose-gc");
// SAFETY: with --expose-gc set, a new context gets V8's gc() as a global function.
const gc = runInNewContext("gc") as () => void;
const collect = async () => {
  for (let pass = 0; pass < 5; pass++) {
    await new Promise(setImmediate);
    gc();
  }
};

const unloaded = { loaded: () => false };
const wrote = (path: string): Omit<Message, "id" | "at"> => ({ role: "bot", kind: "activity", tool: { name: "Edit", ok: true, writes: [path] } });
const synced = (message: Message): SyncChange => ({ cursor: 0, kind: "row", rowId: message.id, value: message, conflict: false });
const reads = (post: { mock: { calls: unknown[][] } }) => post.mock.calls.length;

describe("Map's reads of an unloaded chat", () => {
  it("reads again after a synced patch that keeps the chat's newest row", async () => {
    const store = fresh();
    const bot = store.createBot({}, { seedMessages: false });
    const edit = store.appendMessage(bot.threadId, wrote("/a/file.ts"));
    const note = store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "[pane 0f0f0f0f] before" });
    const read = async () => ({
      writes: (await coldWriteRows(unloaded, bot.threadId))?.map(row => row.tool?.writes),
      reason: await coldPaneReason(unloaded, bot.threadId, "0f0f0f0f-pane", 0),
    });
    expect(await read()).toEqual({ writes: [["/a/file.ts"]], reason: "before" });
    store.applySyncChanges(bot.id, bot.threadId, [synced({ ...edit, tool: { ...edit.tool!, writes: ["/b/file.ts"] } }), synced({ ...note, text: "[pane 0f0f0f0f] after" })]);
    expect(await read()).toEqual({ writes: [["/b/file.ts"]], reason: "after" });
  });

  it("reads again after another connection commits to the chat", async () => {
    const store = fresh();
    const bot = store.createBot({}, { seedMessages: false });
    const edit = store.appendMessage(bot.threadId, wrote("/a/file.ts"));
    expect((await coldWriteRows(unloaded, bot.threadId))?.map(row => row.tool?.writes)).toEqual([["/a/file.ts"]]);
    const other = new DatabaseSync(messageDbFile());
    other.prepare("UPDATE messages SET json = ? WHERE thread_id = ? AND id = ?").run(JSON.stringify({ ...edit, tool: { ...edit.tool!, writes: ["/b/file.ts"] } }), bot.threadId, edit.id);
    other.close();
    expect((await coldWriteRows(unloaded, bot.threadId))?.map(row => row.tool?.writes)).toEqual([["/b/file.ts"]]);
  });

  it("reads again once a transaction it read inside commits", async () => {
    const store = fresh();
    const bot = store.createBot({}, { seedMessages: false });
    const edit = store.appendMessage(bot.threadId, wrote("/a/file.ts"));
    const writes = async () => (await coldWriteRows(unloaded, bot.threadId))?.map(row => row.tool?.writes);
    messageDatabase().exec("BEGIN IMMEDIATE");
    store.applySyncChanges(bot.id, bot.threadId, [synced({ ...edit, tool: { ...edit.tool!, writes: ["/b/file.ts"] } }), synced({ ...wrote("/c/file.ts"), id: "peer", at: Date.now() })]);
    expect(await writes()).toEqual([["/a/file.ts"]]);
    messageDatabase().exec("COMMIT");
    expect(await writes()).toEqual([["/b/file.ts"], ["/c/file.ts"]]);
  });

  it("keeps a chat's reads while another bot's chat or a room's changes", async () => {
    const store = fresh();
    const bot = store.createBot({}, { seedMessages: false });
    const other = store.createBot({}, { seedMessages: false });
    const room = store.createGroup("Room", [bot.id, other.id]);
    store.appendMessage(bot.threadId, wrote("/a/file.ts"));
    store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "[pane 0f0f0f0f] mine" });
    const theirs = store.appendMessage(other.threadId, { role: "bot", kind: "note", text: "[pane 0f0f0f0f] theirs" });
    const said = store.appendMessage(room.threadId, { role: "bot", kind: "note", text: "[pane 0f0f0f0f] room" });
    expect(await coldPaneReason(unloaded, bot.threadId, "0f0f0f0f-pane", 0)).toBe("mine");
    await coldWriteRows(unloaded, bot.threadId);
    const post = vi.spyOn(Worker.prototype, "postMessage");
    store.applySyncChanges(other.id, other.threadId, [synced({ ...theirs, text: "[pane 0f0f0f0f] theirs again" })]);
    messageDatabase().prepare("UPDATE messages SET json = ? WHERE thread_id = ? AND id = ?").run(JSON.stringify({ ...said, text: "[pane 0f0f0f0f] room again" }), room.threadId, said.id);
    expect(await coldPaneReason(unloaded, bot.threadId, "0f0f0f0f-pane", 0)).toBe("mine");
    expect((await coldWriteRows(unloaded, bot.threadId))?.map(row => row.tool?.writes)).toEqual([["/a/file.ts"]]);
    expect(reads(post)).toBe(0);
  });

  it("frees a deleted task's reads", async () => {
    const store = fresh();
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Doomed")!;
    store.appendMessage(task.threadId, wrote("/a/file.ts"));
    let rows = await coldWriteRows(unloaded, task.threadId);
    const cached = new WeakRef(rows!);
    const control = new WeakRef(structuredClone(rows!));
    rows = null;
    expect(store.deleteTask(bot.id, task.threadId)).not.toBeNull();
    await collect();
    expect({ cached: cached.deref(), control: control.deref() }).toEqual({ cached: undefined, control: undefined });
  });

  it("keeps reads for the two chats read last", async () => {
    const store = fresh();
    const bot = store.createBot({}, { seedMessages: false });
    const chats = [bot.threadId, store.createTask(bot.id)!.threadId, store.createTask(bot.id)!.threadId];
    const cached: WeakRef<Message[]>[] = [];
    for (const threadId of chats) {
      store.appendMessage(threadId, wrote("/a/file.ts"));
      cached.push(new WeakRef((await coldWriteRows(unloaded, threadId))!));
    }
    await collect();
    expect(cached.map(ref => ref.deref() !== undefined)).toEqual([false, true, true]);
  });
});

describe("loading a chat off the server thread", () => {
  it("loads what the store would read, with the rows written meanwhile", async () => {
    const setup = fresh();
    const bot = setup.createBot({}, { seedMessages: false });
    for (let n = 0; n < 2_500; n++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${n}` });
    const [first, second] = setup.messagesFor(bot.threadId);
    const store = fresh();
    const load = coldLoad(store, bot.threadId);
    setup.applySyncChanges(bot.id, bot.threadId, [synced({ ...first, text: "edited" })]);
    messageDatabase().prepare("DELETE FROM messages WHERE thread_id = ? AND id = ?").run(bot.threadId, second.id);
    setup.appendMessage(bot.threadId, { role: "user", kind: "text", text: "sent during the load" });
    await load;
    expect(store.loaded(bot.threadId)).toBe(true);
    const read = fresh();
    expect(store.messagesFor(bot.threadId)).toEqual(read.messagesFor(bot.threadId));
    expect(store.activeLeaf(bot.threadId)).toBe(read.activeLeaf(bot.threadId));
  });

  it("loads the row that took a deleted row's rowid behind the pages read", async () => {
    const setup = fresh();
    const bot = setup.createBot({}, { seedMessages: false });
    applySyncedRows(bot.threadId, Array.from({ length: 1024 }, (_, n): Message => ({ id: `pad-${n}`, at: n, role: "user", kind: "text", text: "filler" })));
    const note = (id: string, text: string): Message => ({ id, at: Date.now(), role: "bot", kind: "note", text: `[pane a1b2c3d4] ${text}` });
    const first = note("first", "original");
    const notice: Message = { id: "notice", at: Date.now(), role: "bot", kind: "activity", parentId: first.id, tool: { name: "error: sync conflict notice", ok: false } };
    setup.applySyncChanges(bot.id, bot.threadId, [synced(first), synced(notice)]);
    const rowid = (id: string) => Number(messageDatabase().prepare("SELECT rowid FROM messages WHERE thread_id = ? AND id = ?").get(bot.threadId, id)?.rowid);
    const top = rowid(notice.id);
    const store = fresh();
    const incoming = note("incoming", "new peer note");
    const post = Worker.prototype.postMessage;
    let patched = false;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, request: { threadId?: string; after?: number }, transfer) {
      if (!patched && request.threadId === bot.threadId && request.after === top) {
        patched = true;
        store.removeSyncNotices(bot.threadId, [notice.id]);
        store.applySyncChanges(bot.id, bot.threadId, [synced({ ...first, text: "[pane a1b2c3d4] patched" }), synced(incoming), { cursor: 0, kind: "head", rowId: "", value: incoming.id, conflict: false }]);
      }
      post.call(this, request, transfer);
    });
    await coldLoad(store, bot.threadId);
    expect(rowid(incoming.id)).toBe(top);
    expect(store.loaded(bot.threadId)).toBe(true);
    const read = fresh();
    const reason = (from: Store) => paneReason(paneLines(from.messagesFor(bot.threadId).toReversed(), 0, "a1b2c3d4-pane"), "a1b2c3d4-pane", 0);
    expect(store.messagesFor(bot.threadId)).toEqual(read.messagesFor(bot.threadId));
    expect(store.activeLeaf(bot.threadId)).toBe(read.activeLeaf(bot.threadId));
    expect([reason(store), reason(read)]).toEqual(["new peer note", "new peer note"]);
  });

  it("keeps each moved row's newest copy when the pages it moved to are read again", async () => {
    const bot = fresh().createBot({}, { seedMessages: false });
    applySyncedRows(bot.threadId, Array.from({ length: 1024 }, (_, n): Message => ({ id: `pad-${n}`, at: n, role: "user", kind: "text", text: "filler" })));
    const row = (id: string, text: string): Message => ({ id, at: Date.now(), role: "user", kind: "text", text });
    const rowid = (id: string) => Number(messageDatabase().prepare("SELECT rowid FROM messages WHERE thread_id = ? AND id = ?").get(bot.threadId, id)?.rowid);
    const writes = new Map([[rowid("pad-1023"), () => {
      insertMessage(bot.threadId, row("pad-0", "moved"));
      insertMessage(bot.threadId, row("twice", "moves again"));
      insertMessage(bot.threadId, row("last", "deleted later"));
      writes.set(rowid("last"), () => {
        insertMessage(bot.threadId, row("twice", "moved again"));
        writes.set(rowid("twice"), () => {
          messageDatabase().prepare("DELETE FROM messages WHERE thread_id = ? AND id = ?").run(bot.threadId, "last");
          insertMessage(bot.threadId, row("next", "after the delete"));
        });
      });
    }]]);
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, request: { threadId?: string; after?: number }, transfer) {
      const write = request.threadId === bot.threadId && request.after !== undefined ? writes.get(request.after) : undefined;
      if (write) {
        writes.delete(request.after!);
        write();
      }
      post.call(this, request, transfer);
    });
    const store = fresh();
    await coldLoad(store, bot.threadId);
    expect(writes.size).toBe(0);
    expect(store.loaded(bot.threadId)).toBe(true);
    expect(store.messagesFor(bot.threadId)).toEqual(fresh().messagesFor(bot.threadId));
  });

  it("takes a send made during the load by key, and loads it with the chat", async () => {
    const setup = fresh();
    const bot = setup.createBot({});
    for (let n = 0; n < 2_500; n++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${n}` });
    const head = setup.activeLeaf(bot.threadId);
    const store = fresh();
    const load = coldLoad(store, bot.threadId);
    const sent = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "sent right after Map opened" });
    expect(store.loaded(bot.threadId)).toBe(false);
    expect(sent.parentId).toBe(head);
    await load;
    expect(store.loaded(bot.threadId)).toBe(true);
    const read = fresh();
    expect(store.messagesFor(bot.threadId)).toEqual(read.messagesFor(bot.threadId));
    expect(store.messagesFor(bot.threadId).filter((row) => row.id === sent.id)).toHaveLength(1);
    expect(store.activeLeaf(bot.threadId)).toBe(sent.id);
  });

  it("finds a send by Map's key read, or among the rows stored since, without loading the chat", async () => {
    const setup = fresh();
    const bot = setup.createBot({}, { seedMessages: false });
    const before = setup.appendMessage(bot.threadId, { role: "user", kind: "text", text: "sent before", sendId: "sent-before-map-open" });
    for (let n = 0; n < 50; n++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${n}` });
    const store = fresh();
    coldSendIds(store, bot.threadId);
    expect(await sentRow(store, bot.threadId, "sent-before-map-open")).toEqual(before);
    const after = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "sent after", sendId: "sent-after-map-open" });
    expect(await sentRow(store, bot.threadId, "sent-after-map-open")).toEqual(after);
    expect(await sentRow(store, bot.threadId, "never-sent-anywhere")).toBeUndefined();
    expect(store.loaded(bot.threadId)).toBe(false);
  });

  it("finds a send that took a deleted row's rowid behind Map's key read", async () => {
    const setup = fresh();
    const bot = setup.createBot({}, { seedMessages: false });
    for (let n = 0; n < 50; n++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${n}` });
    const top = setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "newest" });
    const store = fresh();
    coldSendIds(store, bot.threadId);
    expect(await sentRow(store, bot.threadId, "nothing-sent-yet-here")).toBeUndefined();
    const rowid = (id: string) => Number(messageDatabase().prepare("SELECT rowid FROM messages WHERE thread_id = ? AND id = ?").get(bot.threadId, id)?.rowid);
    const cursor = rowid(top.id);
    messageDatabase().prepare("DELETE FROM messages WHERE thread_id = ? AND id = ?").run(bot.threadId, top.id);
    const sent = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "sent", sendId: "sent-behind-the-cursor" });
    expect(rowid(sent.id)).toBe(cursor);
    expect(await sentRow(store, bot.threadId, "sent-behind-the-cursor")).toEqual(sent);
  });

  it("dismisses an unloaded chat's first-run quiz by key when the user sends", () => {
    const bot = fresh().createBot({});
    // older builds seeded this quiz; their chats still hold it
    fresh().appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "What do you mostly want help with?", subtitle: "", options: ["Work & projects"] } });
    expect(fresh().messagesFor(bot.threadId).some((row) => row.kind === "options" && !row.card?.dismissed)).toBe(true);
    const store = fresh();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(store.loaded(bot.threadId)).toBe(false);
    expect(fresh().messagesFor(bot.threadId).filter((row) => row.kind === "options").map((row) => row.card?.dismissed)).toEqual([true]);
  });

  it("keeps the chat the store loaded first", async () => {
    const setup = fresh();
    const bot = setup.createBot({}, { seedMessages: false });
    for (let n = 0; n < 50; n++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${n}` });
    const store = fresh();
    const load = coldLoad(store, bot.threadId);
    const own = store.messagesFor(bot.threadId);
    await load;
    expect(store.messagesFor(bot.threadId)).toBe(own);
  });

  it("loads nothing for a chat deleted during the load", async () => {
    const store = fresh();
    const bot = store.createBot({}, { seedMessages: false });
    const task = store.createTask(bot.id, "Doomed")!;
    for (let n = 0; n < 50; n++) store.appendMessage(task.threadId, { role: "bot", kind: "text", text: `step ${n}` });
    const cold = fresh();
    const load = coldLoad(cold, task.threadId);
    store.deleteTask(bot.id, task.threadId);
    await load;
    expect(cold.loaded(task.threadId)).toBe(false);
  });
});
