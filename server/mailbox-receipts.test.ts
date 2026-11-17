import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { createMailboxReceipts, MAILBOX_RECEIPT_LIMIT } from "./mailbox-receipts.ts";
import { closeMessageDb, messageDatabase } from "./message-db.ts";
import { bootRowsNow } from "./testing/boot-rows.ts";

const receiptsFrom = (now = Date.now()) => Promise.resolve(bootRowsNow([], DATA_DIR, now).receipts);

it("rebuilds receipts from an index, never a scan of every message", () => {
  closeMessageDb();
  mkdirSync(DATA_DIR, { recursive: true });
  messageDatabase();
  const prepare = DatabaseSync.prototype.prepare;
  const prepared: string[] = [];
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    prepared.push(sql);
    return prepare.call(this, sql);
  });
  bootRowsNow();
  vi.restoreAllMocks();
  const plans = prepared.filter((sql) => sql.includes("$.mailbox.key")).flatMap((sql) => messageDatabase().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 1).map((row) => String(row.detail)));
  expect(plans.length).toBeGreaterThan(0);
  expect(plans.filter((detail) => detail.startsWith("SCAN messages") && !detail.includes("COVERING INDEX"))).toEqual([]);
  closeMessageDb();
});

it("touches no database until its rows arrive, and holds keyed mail until then", async () => {
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  let release!: (rows: Array<{ key: string; id: string; at: number }>) => void;
  const receipts = createMailboxReceipts(new Promise((resolve) => { release = resolve; }));
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  let writes = 0;
  const first = receipts.accept(scope, "held", async () => { writes++; return { ok: true, id: "note" }; });
  await new Promise((resolve) => setImmediate(resolve));
  expect(writes).toBe(0);
  expect(prepare).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  release([]);
  expect(await first).toEqual({ ok: true, id: "note" });
});

it("promotes a deferred identity once when the watcher delivers it", async () => {
  const receipts = createMailboxReceipts(Promise.resolve([]));
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  await receipts.accept(scope, "deferred", async () => ({ ok: true, deferred: true }));
  let writes = 0;
  const deliver = () => receipts.accept(scope, "deferred", async () => { writes++; return { ok: true, id: "note" }; }, true);
  expect(await Promise.all([deliver(), deliver()])).toEqual([{ ok: true, id: "note" }, { ok: true, id: "note" }]);
  expect(writes).toBe(1);
  expect(await receipts.accept(scope, "deferred", async () => { throw new Error("duplicate"); })).toEqual({ ok: true, id: "note" });
});

it("bounds the rebuilt set and expires receipts after seven days", async () => {
  closeMessageDb();
  mkdirSync(DATA_DIR, { recursive: true });
  const database = messageDatabase();
  const now = Date.now();
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  const receipts = createMailboxReceipts(receiptsFrom(now), () => now);
  let firstKey = "";
  await receipts.accept(scope, "first", async key => { firstKey = key!; return { ok: true, id: "first-note" }; });
  const insert = database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, json) VALUES ('teacher', ?, ?, 'bot', 'note', ?)");
  insert.run("expired", now - 8 * 86_400_000, JSON.stringify({ mailbox: { key: firstKey } }));
  const rebuilt = createMailboxReceipts(receiptsFrom(now), () => now);
  let writes = 0;
  await rebuilt.accept(scope, "first", async () => { writes++; return { ok: true, id: "fresh-note" }; });
  expect(writes).toBe(1);
  for (let index = 0; index < MAILBOX_RECEIPT_LIMIT; index++) {
    await rebuilt.accept(scope, `next-${index}`, async () => ({ ok: true, id: `note-${index}` }));
  }
  await rebuilt.accept(scope, "first", async () => { writes++; return { ok: true, id: "fresh-again" }; });
  expect(writes).toBe(2);
  insert.run("oldest", now - 1, JSON.stringify({ mailbox: { key: firstKey } }));
  database.exec("BEGIN");
  for (let index = 0; index < MAILBOX_RECEIPT_LIMIT; index++) insert.run(`newer-${index}`, now, JSON.stringify({ mailbox: { key: `newer-${index}` } }));
  database.exec("COMMIT");
  const capped = createMailboxReceipts(receiptsFrom(now), () => now);
  await capped.accept(scope, "first", async () => { writes++; return { ok: true, id: "outside-boot-cap" }; });
  expect(writes).toBe(3);
  closeMessageDb();
});

it("finishes a watcher delivery that arrives while the deferral acknowledgement is pending", async () => {
  const receipts = createMailboxReceipts(Promise.resolve([]));
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const deferred = receipts.accept(scope, "same", async () => { await ready; return { ok: true, deferred: true }; });
  const final = receipts.accept(scope, "same", async () => ({ ok: true, id: "stored" }), true);
  release();
  expect(await deferred).toEqual({ ok: true, deferred: true });
  expect(await final).toEqual({ ok: true, id: "stored" });
});

it("does not claim a failed write and scopes identities to the authenticated pane", async () => {
  const receipts = createMailboxReceipts(Promise.resolve([]));
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  await expect(receipts.accept(scope, "same-id", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  expect(await receipts.accept(scope, "same-id", async () => ({ ok: true, id: "stored" }))).toEqual({ ok: true, id: "stored" });
  expect(await receipts.accept({ ...scope, pane: "other" }, "same-id", async () => ({ ok: true, id: "other-note" }))).toEqual({ ok: true, id: "other-note" });
});
