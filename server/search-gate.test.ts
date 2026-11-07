import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  appendMessage,
  applySyncedRows,
  closeMessageDb,
  deleteThread,
  insertMessage,
  messageDatabase,
  readThread,
  replaceThread,
  setActiveLeaf,
  updateMessage,
  withMessageTransaction,
} from "./message-db.ts";
import { ackSearchCache, onSearchDirt, searchCacheState, searchDirty, syncRequestStarted, untrustSearchCache } from "./search-gate.ts";
import { Store, type Message } from "./store.ts";
import { ThreadSyncV2 } from "./thread-sync-v2.ts";
import { registerMigration } from "./thread-sync-v2-migration.ts";
import { createThreadSyncV2Store } from "./thread-sync-v2-store.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
const scope = { botSyncId: "bot", threadId: "thread" };
const msg = (id: string, text = id, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: 1, parentId: null, ...extra });
const legacyFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const temp = () => mkdtempSync(join(tmpdir(), "search-gate-"));
const hash = (json: string) => createHash("sha256").update(json).digest("hex");

function trust() {
  messageDatabase();
  const state = searchCacheState();
  ackSearchCache(state.epoch, state.generation);
  return searchCacheState();
}

function dirt() {
  const state = searchCacheState();
  return { epoch: state.epoch, threads: [...state.threads], keys: [...state.keys].map(([threadId, ids]) => [threadId, [...ids]]) };
}

function externalWrite(id: string) {
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    other.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES ('outside', ?, 1, 'user', 'text', 'x', '{}')").run(id);
  } finally {
    other.close();
  }
}

function shippedFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|mts|js|mjs|cjs)$/.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => !/\.(test|node-test)\.[a-z]+$/.test(path) && !path.startsWith("server/testing/") && !/^scripts\/(.*\/)?bench-/.test(path));
}

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

afterEach(() => onSearchDirt(null));

describe("search gate", () => {
  it("only message-db.ts writes messages", () => {
    const writes = /\b(INSERT\b[^;'"`]*?\bINTO\s+messages\b|REPLACE\s+INTO\s+messages\b|UPDATE\s+messages\b|DELETE\s+FROM\s+messages\b)/i;
    const writers = [...shippedFiles("server"), ...shippedFiles("scripts")]
      .filter((path) => path !== "server/message-db.ts" && writes.test(readFileSync(join(ROOT, path), "utf8")));
    expect(writers).toEqual([]);
  });

  it("publishes each autocommit write before it returns", () => {
    const { epoch } = trust();
    insertMessage("t", msg("a"));
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: [], keys: [["t", ["a"]]] });
    // INSERT OR REPLACE moves the rowid, which orders and pages search
    insertMessage("t", msg("a"));
    expect(dirt().epoch).toBe(epoch + 2);
    updateMessage("t", msg("a", "edited"));
    expect(dirt().epoch).toBe(epoch + 3);
    appendMessage("t", msg("b"));
    expect(dirt()).toEqual({ epoch: epoch + 4, threads: [], keys: [["t", ["a", "b"]]] });
    setActiveLeaf("t", "a");
    expect(dirt().epoch).toBe(epoch + 4);
  });

  it("dirties whole threads once per import, replacement and deletion", () => {
    writeFileSync(legacyFile("old"), JSON.stringify([msg("x"), msg("y")]));
    let { epoch } = trust();
    expect(readThread("old", legacyFile("old")).messages).toHaveLength(2);
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: ["old"], keys: [] });

    ({ epoch } = trust());
    replaceThread("r", [msg("1"), msg("2"), msg("3")], "3");
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: ["r"], keys: [["r", ["1", "2", "3"]]] });

    ({ epoch } = trust());
    const database = messageDatabase();
    const prepare = database.prepare.bind(database);
    let atStateDelete: number | undefined;
    database.prepare = (sql: string) => {
      if (sql.startsWith("DELETE FROM thread_state")) atStateDelete = searchCacheState().epoch;
      return prepare(sql);
    };
    deleteThread("r");
    database.prepare = prepare;
    expect(atStateDelete).toBe(epoch + 1);
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: ["r"], keys: [] });
  });

  it("dirties only the synced rows an upsert changed", () => {
    applySyncedRows("s", [msg("a"), msg("b")], "b");
    const { epoch } = trust();
    expect(applySyncedRows("s", [msg("a"), msg("b")], "b")).toBe(0);
    expect(dirt()).toEqual({ epoch, threads: [], keys: [] });
    expect(searchCacheState().trusted).toBe(true);
    applySyncedRows("s", [msg("a"), msg("b", "changed"), msg("c")]);
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: [], keys: [["s", ["b", "c"]]] });
  });

  it("dirties a thread whose sync notices are removed", () => {
    const store = new Store(selection);
    for (const row of [msg("a"), msg("notice", "", { parentId: "a" }), msg("b", "b", { parentId: "notice" })]) insertMessage("n", row);
    const { epoch } = trust();
    store.removeSyncNotices("n", ["notice"]);
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: ["n"], keys: [] });
    expect(readThread("n", legacyFile("n")).messages.map((row) => [row.id, row.parentId])).toEqual([["a", null], ["b", "a"]]);
  });

  it("publishes nested work only at the outermost COMMIT", () => {
    const { epoch } = trust();
    withMessageTransaction(() => {
      withMessageTransaction(() => insertMessage("t", msg("a")));
      expect(searchCacheState().epoch).toBe(epoch);
      expect(() => withMessageTransaction(() => {
        insertMessage("t", msg("rolled"));
        throw new Error("savepoint");
      })).toThrow("savepoint");
      expect(searchCacheState().epoch).toBe(epoch);
    });
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: [], keys: [["t", ["a", "rolled"]]] });
  });

  it("publishes synced rows after the consume COMMIT, not at the Store event", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.adoptSyncedTask(bot.id, { threadId: "c", title: "Chat", createdAt: 1 }, [], null, true);
    const { epoch } = trust();
    const seen: number[] = [];
    store.onChange((change) => { if (change.type === "message") seen.push(searchCacheState().epoch); });
    withMessageTransaction(() => {
      store.applySyncChanges(bot.id, "c", [{ cursor: 1, kind: "row", rowId: "r", value: msg("r"), conflict: false }]);
    });
    expect(seen).toEqual([epoch]);
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: [], keys: [["c", ["r"]]] });
  });

  it("keeps rolled back dirt for the next commit", () => {
    const { epoch } = trust();
    expect(() => withMessageTransaction(() => {
      insertMessage("t", msg("gone"));
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(searchCacheState().epoch).toBe(epoch);
    insertMessage("t", msg("kept"));
    expect(dirt()).toEqual({ epoch: epoch + 1, threads: [], keys: [["t", ["gone", "kept"]]] });
  });

  it("starts untrusted in a new process", () => {
    const gate = pathToFileURL(join(ROOT, "server", "search-gate.ts")).href;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e",
      `const gate = await import(${JSON.stringify(gate)}); const { full, trusted } = gate.searchCacheState(); console.log(JSON.stringify({ full, trusted }));`], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ full: true, trusted: false });
  });

  it.each([
    ["handle reopen", () => {
      messageDatabase().close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
    }],
    ["close", closeMessageDb],
    ["cache format change", untrustSearchCache],
    ["unknown write", () => externalWrite("unknown")],
  ])("untrusts the whole cache on %s", (_name, untrust) => {
    const state = trust();
    expect(state.trusted).toBe(true);
    untrust();
    messageDatabase();
    const after = searchCacheState();
    expect(after).toMatchObject({ full: true, trusted: false });
    expect(after.generation).toBeGreaterThan(state.generation);
    expect(ackSearchCache(state.epoch, state.generation)).toBe(false);
  });

  it("never restores trust from a stale ack", () => {
    const stale = trust();
    insertMessage("t", msg("a"));
    expect(ackSearchCache(stale.epoch, stale.generation)).toBe(false);
    expect(searchCacheState()).toMatchObject({ epoch: stale.epoch + 1, trusted: false });

    const first = searchCacheState();
    insertMessage("t", msg("b"));
    const second = searchCacheState();
    expect(ackSearchCache(second.epoch, second.generation)).toBe(true);
    insertMessage("t", msg("c"));
    expect(ackSearchCache(first.epoch, first.generation)).toBe(false);
    expect(ackSearchCache(second.epoch, second.generation)).toBe(false);
    expect(dirt().keys).toEqual([["t", ["c"]]]);

    const built = searchCacheState();
    closeMessageDb();
    messageDatabase();
    expect(ackSearchCache(built.epoch, built.generation)).toBe(false);
  });

  it("acks only the dirt stamped at or before the posted epoch", () => {
    messageDatabase();
    onSearchDirt(() => {});
    untrustSearchCache();
    insertMessage("t", msg("a"));
    const a = searchCacheState();
    insertMessage("t", msg("b"));
    const b = searchCacheState();
    expect(b).toMatchObject({ full: true, trusted: false });
    expect([b.threads, b.keys, b.keys.get("t")]).toEqual([new Set(), new Map([["t", new Set(["a", "b"])]]), new Set(["a", "b"])]);
    b.threads.add("x");
    b.keys.get("t")!.add("x");
    b.keys.set("y", new Set(["y"]));
    expect(dirt().keys).toEqual([["t", ["a", "b"]]]);
    expect(ackSearchCache(a.epoch, a.generation)).toBe(false);
    expect(searchCacheState()).toMatchObject({ full: false, trusted: false });
    expect(dirt().keys).toEqual([["t", ["b"]]]);
    expect(ackSearchCache(b.epoch, b.generation)).toBe(true);
    expect(searchCacheState()).toMatchObject({ full: false, trusted: true, threads: new Set(), keys: new Map() });

    insertMessage("t", msg("a"));
    const key = searchCacheState();
    updateMessage("t", msg("a", "again"));
    expect(ackSearchCache(key.epoch, key.generation)).toBe(false);
    expect(dirt().keys).toEqual([["t", ["a"]]]);
    expect(ackSearchCache(searchCacheState().epoch, key.generation)).toBe(true);

    deleteThread("r");
    const thread = searchCacheState();
    deleteThread("r");
    expect(ackSearchCache(thread.epoch, thread.generation)).toBe(false);
    expect(dirt()).toMatchObject({ threads: ["r"], keys: [] });
    expect(ackSearchCache(searchCacheState().epoch, thread.generation)).toBe(true);

    deleteThread("t");
    const older = searchCacheState();
    insertMessage("t", msg("c"));
    expect(dirt()).toMatchObject({ threads: ["t"], keys: [["t", ["c"]]] });
    expect(ackSearchCache(older.epoch, older.generation)).toBe(false);
    expect(dirt()).toMatchObject({ threads: [], keys: [["t", ["c"]]] });
    expect(ackSearchCache(searchCacheState().epoch, older.generation)).toBe(true);
    expect(searchCacheState()).toMatchObject({ trusted: true, threads: new Set(), keys: new Map() });
  });

  it("calls the dirt listener once per published commit, outside any transaction", () => {
    const { epoch } = trust();
    const calls: boolean[] = [];
    onSearchDirt(() => calls.push(messageDatabase().isTransaction));
    insertMessage("t", msg("a"));
    expect(calls).toEqual([false]);
    withMessageTransaction(() => {
      withMessageTransaction(() => insertMessage("t", msg("b")));
      expect(() => withMessageTransaction(() => {
        insertMessage("t", msg("inner"));
        throw new Error("savepoint");
      })).toThrow("savepoint");
      expect(calls).toHaveLength(1);
    });
    expect(calls).toEqual([false, false]);
    expect(dirt()).toEqual({ epoch: epoch + 2, threads: [], keys: [["t", ["a", "b", "inner"]]] });
    expect(() => withMessageTransaction(() => {
      insertMessage("t", msg("gone"));
      throw new Error("rollback");
    })).toThrow("rollback");
    setActiveLeaf("t", "a");
    expect(calls).toHaveLength(2);
    insertMessage("u", msg("kept"));
    expect(calls).toEqual([false, false, false]);
    expect(dirt()).toEqual({ epoch: epoch + 3, threads: [], keys: [["t", ["a", "b", "inner", "gone"]], ["u", ["kept"]]] });
    applySyncedRows("s", [msg("s1")]);
    expect(calls).toHaveLength(4);
    expect(applySyncedRows("s", [msg("s1")])).toBe(0);
    expect(calls).toEqual([false, false, false, false]);
    expect(searchCacheState().epoch).toBe(epoch + 4);
  });

  it("untrusts once past 10,000 distinct dirty threads and keys", () => {
    const { generation } = trust();
    const database = messageDatabase();
    const batch = (from: number, to: number) => {
      const before = searchCacheState().generation;
      withMessageTransaction(() => {
        for (let i = from; i < to; i++) searchDirty(database, "k", `id-${i}`);
        expect(searchCacheState().generation).toBe(before);
      });
    };
    const counts = () => {
      const state = searchCacheState();
      return { generation: state.generation, full: state.full, threads: state.threads.size, keys: state.keys.get("k")?.size ?? 0, inner: state.keys.size };
    };
    for (let i = 0; i < 4000; i++) searchDirty(database, `thread-${i}`);
    batch(0, 6000);
    searchDirty(database, "thread-0");
    searchDirty(database, "k", "id-0");
    expect(counts()).toEqual({ generation, full: false, threads: 4000, keys: 6000, inner: 1 });
    searchDirty(database, "k", "id-6000");
    expect(counts()).toEqual({ generation: generation + 1, full: true, threads: 0, keys: 0, inner: 0 });
    searchDirty(database, "k", "dropped");
    expect(counts()).toEqual({ generation: generation + 1, full: true, threads: 0, keys: 0, inner: 0 });

    onSearchDirt(() => {});
    batch(0, 6000);
    const posted = searchCacheState();
    batch(6000, 10_000);
    expect(counts()).toEqual({ generation: generation + 1, full: true, threads: 0, keys: 10_000, inner: 1 });
    expect(ackSearchCache(posted.epoch, posted.generation)).toBe(false);
    expect(counts()).toEqual({ generation: generation + 1, full: false, threads: 0, keys: 4000, inner: 1 });
    batch(10_000, 16_000);
    searchDirty(database, "k", "id-15999");
    expect(counts()).toEqual({ generation: generation + 1, full: false, threads: 0, keys: 10_000, inner: 1 });
    untrustSearchCache();
    batch(0, 10_005);
    expect(counts()).toEqual({ generation: generation + 3, full: true, threads: 0, keys: 0, inner: 0 });
    searchDirty(database, "k", "after");
    expect(dirt()).toMatchObject({ threads: [], keys: [["k", ["after"]]] });
    expect(searchCacheState().generation).toBe(generation + 3);
  });

  it("untrusts an external write unless a sync request ran since the last sample", () => {
    const { generation } = trust();
    externalWrite("lone");
    expect(searchCacheState()).toMatchObject({ full: true, trusted: false });
    expect(searchCacheState().generation).toBe(generation + 1);

    trust();
    const done = syncRequestStarted();
    externalWrite("during");
    expect(searchCacheState().trusted).toBe(true);
    done();
    done();
    externalWrite("replied");
    expect(searchCacheState().trusted).toBe(true);
    externalWrite("after");
    expect(searchCacheState().trusted).toBe(false);
  });

  it("the staged sync worker never writes messages", { timeout: 60_000 }, async () => {
    const folder = temp();
    const peerDir = temp();
    for (const row of [msg("m1"), msg("m2", "two", { parentId: "m1" })]) insertMessage("thread", row);
    insertMessage("legacy", msg("l1"));
    mkdirSync(join(folder, "threads", "bot"), { recursive: true });
    writeFileSync(join(folder, "threads", "bot", "legacy.json"), JSON.stringify({
      format: "orbit.thread-sync", version: 1, revision: 1, writerDeviceId: "old", updatedAt: 1,
      task: { threadId: "legacy", title: "Chat", createdAt: 1 }, activeLeafId: "l2", messages: [msg("l2")],
    }));
    const client = new ThreadSyncV2({ folder, dataDir: DATA_DIR, deviceId: "local", staged: true });
    const peer = new ThreadSyncV2({ folder, dataDir: peerDir, deviceId: "peer" });
    const rows = () => messageDatabase().prepare("SELECT rowid, thread_id, id, json FROM messages ORDER BY rowid").all();
    const syncTables = () => Object.fromEntries(messageDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync_v2_%' ORDER BY name")
      .all().map(({ name }) => [String(name), hash(JSON.stringify(messageDatabase().prepare(`SELECT * FROM "${String(name)}"`).all()))]));
    try {
      await client.state(scope);
      withMessageTransaction((db) => registerMigration(db, { botSyncId: "bot", threadId: "legacy" }, "Chat", 1));
      const before = rows();
      const tablesBefore = syncTables();
      const legacy = { sourceHash: "a".repeat(64), source: "main" as const };
      await client.commit(scope, [{ kind: "row", value: msg("m3", "three", { parentId: "m2" }) }, { kind: "head", value: "m3" }]);
      await client.recover(scope, [{ kind: "row", value: msg("old", "old"), legacy }, { kind: "head", value: "old", legacy }]);
      await client.flush(scope);
      await peer.commit(scope, [{ kind: "row", value: msg("p1", "peer") }]);
      await peer.flush(scope);
      await client.pull(scope);
      expect(messageDatabase().prepare("SELECT COUNT(*) AS n FROM sync_v2_packets WHERE applied = 0").get()!.n).toBeGreaterThan(0);
      let phase = "";
      for (let step = 0; step < 50 && phase !== "done"; step++) phase = (await client.migrate({ botSyncId: "bot", threadId: "legacy" })).phase;
      expect(phase).toBe("done");
      expect(rows()).toEqual(before);
      const tablesAfter = syncTables();
      expect(Object.keys(tablesAfter).filter((name) => tablesAfter[name] !== tablesBefore[name]).length).toBeGreaterThan(3);
    } finally {
      await client.close();
      await peer.close();
      rmSync(folder, { recursive: true, force: true });
      rmSync(peerDir, { recursive: true, force: true });
    }
  });

  it("keeps trust through chat sync sends, flushes and pulls, and catches a raw write between them", { timeout: 120_000 }, async () => {
    const folder = temp();
    const peerDir = temp();
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.adoptSyncedTask(bot.id, { threadId: "thread", title: "Chat", createdAt: 1 }, [], null, true);
    const sync = createThreadSyncV2Store({
      store,
      dataDir: DATA_DIR,
      deviceId: "local",
      folder: () => folder,
      enabled: () => true,
      target: (threadId) => store.taskByThread(bot.id, threadId) ? { botId: bot.id, botSyncId: "bot" } : null,
      bots: () => [{ botId: bot.id, botSyncId: "bot" }],
      running: () => false,
      project: (message) => message,
      imported: () => {},
      maintenance: () => {},
    })!;
    const peer = new ThreadSyncV2({ folder, dataDir: peerDir, deviceId: "peer" });
    try {
      await sync.flush("thread");
      const { generation } = trust();
      const settle = () => {
        const state = searchCacheState();
        expect(state.generation).toBe(generation);
        expect(ackSearchCache(state.epoch, state.generation)).toBe(true);
      };
      for (let i = 0; i < 20; i++) {
        store.appendMessage("thread", { role: "user", kind: "text", text: `send ${i}` });
        settle();
        expect(await sync.flush("thread")).toBe("written");
        settle();
      }
      for (let i = 0; i < 10; i++) {
        await peer.commit(scope, [{ kind: "row", value: msg(`peer-${i}`, `peer ${i}`, { at: 2 + i }) }]);
        await peer.flush(scope);
        await sync.pull("thread");
        settle();
      }
      expect(store.messagesFor("thread").filter((row) => row.id.startsWith("peer-"))).toHaveLength(10);
      sync.stop();
      expect(searchCacheState().trusted).toBe(true);
      externalWrite("raw");
      expect(searchCacheState()).toMatchObject({ full: true, trusted: false, generation: generation + 1 });
    } finally {
      await sync.close();
      await peer.close();
      rmSync(folder, { recursive: true, force: true });
      rmSync(peerDir, { recursive: true, force: true });
    }
  });

  it("leaves every writer's SQL and the transcript schema unchanged", () => {
    const store = new Store(selection);
    writeFileSync(legacyFile("old"), JSON.stringify({ messages: [msg("x"), msg("y", "y", { parentId: "x" })], activeLeafId: "y" }));
    const database = messageDatabase();
    const trace: Array<string | Array<string | SQLInputValue>> = [];
    const exec = database.exec.bind(database);
    const prepare = database.prepare.bind(database);
    database.exec = (sql: string) => {
      trace.push(sql);
      exec(sql);
    };
    database.prepare = (sql: string) => {
      const statement = prepare(sql);
      const [run, get, all] = [statement.run.bind(statement), statement.get.bind(statement), statement.all.bind(statement)];
      const note = (args: SQLInputValue[]) => trace.push([sql, ...args]);
      // SAFETY: message-db binds positional parameters only, and each wrapper forwards them and the result unchanged.
      statement.run = ((...args: SQLInputValue[]) => (note(args), run(...args))) as StatementSync["run"];
      // SAFETY: As above.
      statement.get = ((...args: SQLInputValue[]) => (note(args), get(...args))) as StatementSync["get"];
      // SAFETY: As above.
      statement.all = ((...args: SQLInputValue[]) => (note(args), all(...args))) as StatementSync["all"];
      return statement;
    };
    readThread("old", legacyFile("old"));
    insertMessage("t", msg("a"));
    insertMessage("t", msg("a"));
    appendMessage("t", msg("b", "b", { parentId: "a" }));
    updateMessage("t", msg("b", "edited", { parentId: "a" }));
    replaceThread("r", [msg("1"), msg("2", "2", { parentId: "1" })], "2");
    applySyncedRows("s", [msg("c"), msg("d", "d", { parentId: "c" })], "d");
    applySyncedRows("s", [msg("c"), msg("d", "changed", { parentId: "c" })]);
    withMessageTransaction((db) => applySyncedRows("s", [msg("c")], undefined, db));
    insertMessage("n", msg("notice", "", { parentId: "a" }));
    insertMessage("n", msg("child", "child", { parentId: "notice" }));
    setActiveLeaf("n", "notice");
    store.removeSyncNotices("n", ["notice", "missing"]);
    deleteThread("r");
    database.exec = exec;
    database.prepare = prepare;
    const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    expect({ trace: hash(JSON.stringify(trace)), schema: hash(JSON.stringify(schema)) }).toEqual({
      trace: "4103a8fdc76120aa8b45c7d81dee83c14a393295b1987a4b5b92a234274f682f",
      schema: "40eeab35be10d7b86ea59a3c3c9e150789e189edd861325cc0d294c940b28b00",
    });
  });
});
