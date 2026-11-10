import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { offscreenLimit } from "./chat-tail.ts";
import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import { insertMessage, messageDatabase, setActiveLeaf } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { SyncChange } from "./thread-sync-v2.ts";

const selection = () => ({ instanceId: "test", model: "test" });
const LIMITS = [0, 1, 30, 200];
const CHATS = [undefined, {}, { unread: true }, { unread: true, readAt: 0 }, { readAt: Number.MAX_SAFE_INTEGER }];

afterEach(() => vi.restoreAllMocks());

function fixture(rows = 450) {
  const store = new Store(selection);
  const bot = store.createBot({}, { seedMessages: false });
  for (let i = 0; i < rows; i++) {
    store.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: i % 7 ? "text" : "activity", text: `row ${i}` });
  }
  return { store, bot, threadId: bot.threadId };
}

/** What /api/bots sends for one chat, from either read. */
function page(thread: { messages: readonly Message[]; activeLeafId: string | null }, limit: number, chat?: { unread?: boolean; readAt?: number }) {
  const size = chat ? offscreenLimit(thread.messages, limit, chat, thread.activeLeafId) : limit;
  const start = Math.max(0, thread.messages.length - size);
  return { activeLeafId: thread.activeLeafId, messages: JSON.parse(JSON.stringify(thread.messages.slice(start))), hasMore: start > 0 };
}

function expectSameAsFull(threadId: string, tailRows?: number) {
  for (const limit of LIMITS) {
    for (const chat of CHATS) {
      const tailStore = new Store(selection);
      const tail = tailStore.threadTail(threadId, limit);
      if (tailRows !== undefined) expect(tail.messages.length).toBe(Math.min(tailRows, limit + 1));
      const fullStore = new Store(selection);
      const full = { messages: fullStore.messagesFor(threadId), activeLeafId: fullStore.activeLeaf(threadId) };
      expect(page(tail, limit, chat)).toEqual(page(full, limit, chat));
    }
  }
}

describe("thread tail", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("pages an unloaded thread from one tail query, same as a full load", () => {
    const { threadId } = fixture();
    expectSameAsFull(threadId, 450);
    const store = new Store(selection);
    const prepare = vi.spyOn(messageDatabase(), "prepare");
    store.threadTail(threadId, 200);
    const reads = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith("SELECT json FROM messages"));
    expect(reads).toEqual(["SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?"]);
    const plan = messageDatabase().prepare(`EXPLAIN QUERY PLAN ${reads[0]}`).all(threadId, 201).map((row) => row.detail).join(" | ");
    expect(plan).toContain("USING INDEX");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("matches a full load after an edit and a regenerate inside the tail", () => {
    const { store, threadId } = fixture();
    const rows = store.messagesFor(threadId);
    store.branchMessage(threadId, rows.at(-20)!.id, "edited");
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "reply to the edit" });
    store.setActiveLeaf(threadId, rows.at(-2)!.id);
    expectSameAsFull(threadId);
  });

  it("falls back to the full load when the active leaf sits on an old branch", () => {
    const { store, threadId } = fixture();
    const rows = store.messagesFor(threadId);
    const edited = store.branchMessage(threadId, rows[40]!.id, "edited long ago")!;
    store.setActiveLeaf(threadId, rows[40]!.id);
    for (let i = 0; i < 100; i++) store.appendMessage(threadId, { role: "user", kind: "text", text: `later ${i}` });
    store.setActiveLeaf(threadId, edited.id);
    expect(store.activeLeaf(threadId)).toBe(edited.id);
    expect(new Store(selection).threadTail(threadId, 30).messages).toHaveLength(551);
    expectSameAsFull(threadId);
  });

  it("chains legacy rows without a parent the way a full load does", () => {
    for (let i = 0; i < 260; i++) insertMessage("legacy", { id: `m${i}`, at: i, role: "user", kind: "text", text: `${i}` });
    expectSameAsFull("legacy");
    setActiveLeaf("legacy", null);
    expectSameAsFull("legacy");
    expect(new Store(selection).threadTail("legacy", 30).messages.at(-1)!.parentId).toBe("m258");
  });

  it("imports a legacy JSON thread through the full read", () => {
    const messages = [{ id: "a", at: 1, role: "user", kind: "text", text: "hi" }, { id: "b", at: 2, role: "bot", kind: "text", text: "yo" }];
    writeFileSync(join(DATA_DIR, "messages-json-thread.json"), JSON.stringify({ messages, activeLeafId: "b" }));
    const thread = new Store(selection).threadTail("json-thread", 30);
    expect(thread.messages.map((message) => [message.id, message.parentId])).toEqual([["a", null], ["b", "a"]]);
    expect(thread.activeLeafId).toBe("b");
  });

  it("serves a loaded thread from memory", () => {
    const { store, threadId } = fixture(10);
    expect(store.threadTail(threadId, 3).messages).toBe(store.messagesFor(threadId));
  });
});

describe("whole-thread readers after a tail page", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("send appends to the real leaf of the whole thread", () => {
    const { threadId } = fixture();
    const store = new Store(selection);
    const leaf = store.threadTail(threadId, 30).activeLeafId;
    const sent = store.appendMessage(threadId, { role: "user", kind: "text", text: "next" });
    expect(sent.parentId).toBe(leaf);
    expect(store.messagesFor(threadId)).toHaveLength(451);
    expect(store.activePath(threadId)).toHaveLength(451);
  });

  it("context planning sees the whole active path", async () => {
    const { threadId } = fixture();
    const store = new Store(selection);
    store.threadTail(threadId, 30);
    const plan = (messages: Message[]) => prepareModelContext({ messages, contextWindow: 1_000_000, taskRecordText: "" });
    expect(await plan(store.activePath(threadId))).toEqual(await plan(new Store(selection).activePath(threadId)));
    expect(store.activePath(threadId)).toHaveLength(450);
  });

  it("compaction lands on the whole thread", () => {
    const { threadId } = fixture();
    const store = new Store(selection);
    store.threadTail(threadId, 30);
    const rows = new Store(selection).messagesFor(threadId);
    const compacted = store.appendCompaction(threadId, {
      v: 1,
      summary: "Earlier work",
      coveredThroughId: rows[300]!.id,
      firstKeptId: rows[301]!.id,
      contextWindow: 8_192,
      estimatedTokensBefore: 900,
      sourceMessageCount: 301,
    });
    expect(compacted.parentId).toBe(rows.at(-1)!.id);
    expect(store.activePath(threadId).map((message) => message.id)).toEqual([...rows.map((message) => message.id), compacted.id]);
  });

  it("sync rows written after a tail page show in the next page and the full thread", () => {
    const { bot, threadId } = fixture();
    const store = new Store(selection);
    const leaf = store.threadTail(threadId, 30).activeLeafId!;
    const row: Message = { id: "synced", parentId: leaf, at: Date.now(), role: "bot", kind: "text", text: "from the other PC" };
    const changes: SyncChange[] = [
      { cursor: 0, kind: "row", rowId: row.id, value: row, conflict: false },
      { cursor: 0, kind: "head", rowId: "", value: row.id, conflict: false },
    ];
    store.applySyncChanges(bot.id, threadId, changes);
    const tail = store.threadTail(threadId, 30);
    expect(tail.messages.at(-1)!.id).toBe("synced");
    expect(tail.activeLeafId).toBe("synced");
    expect(store.messagesFor(threadId)).toHaveLength(451);
    expect(store.activePath(threadId).at(-1)!.id).toBe("synced");
  });
});
