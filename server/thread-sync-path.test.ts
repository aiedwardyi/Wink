import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { messageDatabase } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { syncPathChanged } from "./thread-sync-path.ts";
import type { SyncChange } from "./thread-sync-v2.ts";

const rowChange = (message: Message): SyncChange => ({ cursor: 0, kind: "row", rowId: message.id, value: message, conflict: false });
const message = (id: string, parentId: string | null): Message => ({ id, parentId, at: 1, role: "user", kind: "text", text: id });

function fixture(rows: Message[], leaf: string) {
  const store = new Store(() => ({ instanceId: "test", model: "test" }));
  const bot = store.createBot({}, { seedMessages: false });
  const threadId = bot.threadId;
  store.adoptSyncedTask(bot.id, { threadId, title: "Chat", createdAt: 1 }, rows, leaf);
  store.setResumeCursor(bot.id, "test", "cursor", threadId);
  return { store, bot, threadId };
}

afterEach(() => vi.restoreAllMocks());

describe("sync path continuity", () => {
  it("checks 50 appended rows on a 100k-row thread in under 5 ms without walking its path", () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => ({ ...message(`m${i}`, i ? `m${i - 1}` : null), text: "x".repeat(512) }));
    const leaf = rows.at(-1)!.id;
    const { store, bot, threadId } = fixture(rows, leaf);
    const prepare = vi.spyOn(messageDatabase(), "prepare");
    const samples: number[] = [];
    for (let page = 0; page < 5; page++) {
      const added = Array.from({ length: 50 }, (_, i) => message(`new-${page}-${i}`, i ? `new-${page}-${i - 1}` : leaf));
      const changes: SyncChange[] = [...added.map(rowChange), { cursor: 0, kind: "head", rowId: "", value: leaf, conflict: false }];
      const start = performance.now();
      expect(syncPathChanged(messageDatabase(), threadId, changes)).toBe(false);
      samples.push(performance.now() - start);
      store.applySyncChanges(bot.id, threadId, changes);
    }
    console.log(`sync continuity 100000 rows, 50-row append pages: ${samples.map((ms) => ms.toFixed(3)).join(", ")} ms; max ${Math.max(...samples).toFixed(3)} ms`);
    expect(Math.max(...samples)).toBeLessThan(5);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("WITH RECURSIVE active"))).toBe(false);
    expect(store.taskByThread(bot.id, threadId)?.resumeCursors).toEqual({ test: "cursor" });
    expect(bot.resumeCursors).toEqual({ test: "cursor" });
  }, 90_000);

  for (const missing of ["parent", "leaf"]) {
    it(`invalidates when a new row fills the missing active ${missing}`, () => {
      const root = message("root", null);
      const leaf = message("leaf", "missing");
      const { store, bot, threadId } = fixture(missing === "parent" ? [root, leaf] : [root], leaf.id);
      store.applySyncChanges(bot.id, threadId, [rowChange(missing === "parent" ? message("missing", root.id) : leaf)]);
      expect(store.taskByThread(bot.id, threadId)?.resumeCursors).toEqual({});
      expect(bot.resumeCursors).toEqual({});
    });
  }

  it("keeps continuity when a new row repairs an off-path missing parent", () => {
    const root = message("root", null);
    const leaf = message("leaf", root.id);
    const side = message("side", "missing");
    const { store, bot, threadId } = fixture([root, leaf, side], leaf.id);
    store.applySyncChanges(bot.id, threadId, [rowChange(message("missing", root.id))]);
    expect(store.taskByThread(bot.id, threadId)?.resumeCursors).toEqual({ test: "cursor" });
  });
});
