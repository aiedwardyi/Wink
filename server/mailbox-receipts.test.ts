import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createMailboxReceipts, MAILBOX_RECEIPT_LIMIT } from "./mailbox-receipts.ts";

it("promotes a deferred identity once when the watcher delivers it", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE messages (id TEXT, at INTEGER, kind TEXT, json TEXT)");
  const receipts = createMailboxReceipts(() => database);
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  await receipts.accept(scope, "deferred", async () => ({ ok: true, deferred: true }));
  let writes = 0;
  const deliver = () => receipts.accept(scope, "deferred", async () => { writes++; return { ok: true, id: "note" }; }, true);
  expect(await Promise.all([deliver(), deliver()])).toEqual([{ ok: true, id: "note" }, { ok: true, id: "note" }]);
  expect(writes).toBe(1);
  expect(await receipts.accept(scope, "deferred", async () => { throw new Error("duplicate"); })).toEqual({ ok: true, id: "note" });
  database.close();
});

it("bounds the rebuilt set and expires receipts after seven days", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE messages (id TEXT, at INTEGER, kind TEXT, json TEXT)");
  const now = Date.now();
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  const receipts = createMailboxReceipts(() => database, () => now);
  let firstKey = "";
  await receipts.accept(scope, "first", async key => { firstKey = key!; return { ok: true, id: "first-note" }; });
  const insert = database.prepare("INSERT INTO messages VALUES (?, ?, 'note', ?)");
  insert.run("expired", now - 8 * 86_400_000, JSON.stringify({ mailbox: { key: firstKey } }));
  const rebuilt = createMailboxReceipts(() => database, () => now);
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
  const capped = createMailboxReceipts(() => database, () => now);
  await capped.accept(scope, "first", async () => { writes++; return { ok: true, id: "outside-boot-cap" }; });
  expect(writes).toBe(3);
  database.close();
});

it("finishes a watcher delivery that arrives while the deferral acknowledgement is pending", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE messages (id TEXT, at INTEGER, kind TEXT, json TEXT)");
  const receipts = createMailboxReceipts(() => database);
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const deferred = receipts.accept(scope, "same", async () => { await ready; return { ok: true, deferred: true }; });
  const final = receipts.accept(scope, "same", async () => ({ ok: true, id: "stored" }), true);
  release();
  expect(await deferred).toEqual({ ok: true, deferred: true });
  expect(await final).toEqual({ ok: true, id: "stored" });
  database.close();
});

it("does not claim a failed write and scopes identities to the authenticated pane", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE messages (id TEXT, at INTEGER, kind TEXT, json TEXT)");
  const receipts = createMailboxReceipts(() => database);
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  await expect(receipts.accept(scope, "same-id", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  expect(await receipts.accept(scope, "same-id", async () => ({ ok: true, id: "stored" }))).toEqual({ ok: true, id: "stored" });
  expect(await receipts.accept({ ...scope, pane: "other" }, "same-id", async () => ({ ok: true, id: "other-note" }))).toEqual({ ok: true, id: "other-note" });
  database.close();
});
