import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import dc from "node:diagnostics_channel";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { drivePathRule } from "./drive-mirror.ts";
import {
  appendMessage,
  applySyncedRows,
  closeMessageDb,
  deleteThread,
  insertMessage,
  messageDatabase,
  replaceThread,
  searchMessages,
  updateMessage,
  withMessageTransaction,
} from "./message-db.ts";
import { readSyncOperations } from "./profile-sync.ts";
import {
  openSearchCache,
  openSearchSource,
  probeSearchFts,
  SEARCH_CACHE_FILE,
  searchCacheFingerprint,
  startSearchCache,
  stopSearchCache,
  type SearchWork,
} from "./search-cache.ts";
import { searchCacheState, searchDirty, searchSource } from "./search-gate.ts";
import { messageSearchGrams } from "./search-text.ts";
import type { Message } from "./store.ts";
import { createThreadRoutes } from "./thread-routes.ts";
import { pullBotThreads, type ThreadSyncHost } from "./thread-sync.ts";
import { ThreadSyncV2 } from "./thread-sync-v2.ts";
import { isMemoryTopicName } from "./workspace.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const url = (file: string) => JSON.stringify(pathToFileURL(join(ROOT, "server", file)).href);
const NAMES = [SEARCH_CACHE_FILE, `${SEARCH_CACHE_FILE}-wal`, `${SEARCH_CACHE_FILE}-shm`];
const msg = (id: string, text = id, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: 1, parentId: null, ...extra });
const tool = (id: string, name: string, extra: Partial<Message> = {}): Message => msg(id, "", { kind: "activity", tool: { name, detail: { input: `${name} input`, output: [`${id} output`] } }, ...extra });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const workers: Worker[] = [];
dc.subscribe("worker_threads", (message) => workers.push((message as { worker: Worker }).worker));

function peek<T>(read: (cache: DatabaseSync) => T, dataDir = DATA_DIR): T {
  const cache = new DatabaseSync(join(dataDir, SEARCH_CACHE_FILE), { readOnly: true });
  try {
    return read(cache);
  } finally {
    cache.close();
  }
}

const docs = () => peek((cache) => cache.prepare("SELECT thread_id, id, source_rowid, at, priority FROM search_docs ORDER BY thread_id, id").all());
const meta = () => peek((cache) => cache.prepare("SELECT generation, cursor, state FROM search_meta").get());
const matching = (text: string) => peek((cache) => cache.prepare("SELECT d.thread_id, d.id FROM search_fts f JOIN search_docs d ON d.docid = f.rowid WHERE search_fts MATCH ? ORDER BY d.thread_id, d.id")
  .all(messageSearchGrams({ kind: "text", text }).filter((gram) => gram.length === 19 && gram.startsWith("g")).map((gram) => `"${gram}"`).join(" AND ")));

/** What a complete rebuild from messages.db holds. */
function expected() {
  const rows = messageDatabase().prepare("SELECT rowid, thread_id, id, at, kind, text, json FROM messages ORDER BY thread_id, id").all();
  return rows.filter((row) => ["text", "activity"].includes(String(row.kind)) && messageSearchGrams({ ...JSON.parse(String(row.json)), kind: row.kind, text: row.text }).length)
    .map((row) => ({ thread_id: row.thread_id, id: row.id, source_rowid: row.rowid, at: row.at, priority: row.kind === "text" ? 0 : 1 }));
}

function sourceShape() {
  const db = messageDatabase();
  return hash([db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(), db.prepare("SELECT rowid, * FROM messages ORDER BY rowid").all()]);
}

async function trusted() {
  await vi.waitFor(() => expect(searchCacheState().trusted).toBe(true), { timeout: 60_000, interval: 10 });
}

type Work = SearchWork & { type: "work"; epoch: number; generation: number };
const drain = () => new Promise((resolve) => setImmediate(resolve));

/** Records the controller's work posts; `after` runs synchronously once each real post is sent. */
function posts(worker: Worker, after: (work: Work) => void = () => {}) {
  const sent: Work[] = [];
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (message: Work | { type: "stop" }) => {
    post(message);
    if (message.type !== "work") return;
    sent.push(message);
    after(message);
  };
  return { sent, restore: () => { worker.postMessage = post; } };
}

function fixture(rows = 700) {
  for (let i = 0; i < rows; i++) {
    const thread = `t${i % 3}`;
    if (i % 50 === 7) insertMessage(thread, msg(`n${i}`, "never indexed", { kind: "note" }));
    else if (i % 2) insertMessage(thread, msg(`m${i}`, `hello 검사 row ${i}`, { at: i }));
    else insertMessage(thread, tool(`m${i}`, "Bash", { at: i }));
  }
}

function child(body: string, env: Record<string, string> = {}) {
  const script = `process.on("uncaughtException", (error) => { process.stderr.write(String(error?.stack ?? error)); process.exit(70); });
    process.stdout.on("error", () => {});
    // the search worker is unref'd, so hold the process open until the script ends
    const alive = setInterval(() => {}, 1000);
    ${body}
    clearInterval(alive);`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 120_000, env: { ...process.env, OMB_DATA_DIR: DATA_DIR, ...env },
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

// Drives the worker directly, the way the controller does, and dies when it does.
const harness = (passes: number) => `
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(new URL(${url("search-worker.ts")}), { workerData: { dataDir: process.env.OMB_DATA_DIR, crash: process.env.CRASH }, execArgv: ["--experimental-strip-types"] });
  let pass = 0;
  const work = () => worker.postMessage({ type: "work", epoch: pass, generation: 0, full: true, threads: new Set(), keys: new Map() });
  worker.on("message", (message) => {
    if (message.type === "ready") work();
    else if (message.type === "done") ++pass < ${passes} ? work() : worker.postMessage({ type: "stop" });
    else process.exit(71);
  });
  worker.on("exit", (code) => process.exit(code));`;

async function countingIndexer() {
  let calls = 0;
  vi.resetModules();
  vi.doMock("./search-text.ts", async (original) => {
    const real = await original<typeof import("./search-text.ts")>();
    return { ...real, messageSearchGrams: (row: Parameters<typeof real.messageSearchGrams>[0]) => (calls++, real.messageSearchGrams(row)) };
  });
  const { createSearchIndexer } = await import("./search-cache.ts");
  vi.doUnmock("./search-text.ts");
  const indexer = createSearchIndexer(DATA_DIR);
  calls = 0;
  const pass = async () => {
    expect(await indexer.work({ full: true, threads: new Set(), keys: new Map() })).toBe(true);
    const projected = calls;
    calls = 0;
    return projected;
  };
  return { pass, close: indexer.close };
}

beforeEach(async () => {
  closeMessageDb();
  await stopSearchCache();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  workers.length = 0;
});

afterEach(async () => {
  closeMessageDb();
  await stopSearchCache();
});

describe("search cache", () => {
  it("adds only search-cache.db, with the decision's schema, and never writes messages.db", async () => {
    fixture(40);
    const before = sourceShape();
    const version = messageDatabase().prepare("PRAGMA data_version").get();
    startSearchCache(DATA_DIR);
    await trusted();
    expect(messageDatabase().prepare("PRAGMA data_version").get()).toEqual(version);
    expect(sourceShape()).toBe(before);
    const added = readdirSync(DATA_DIR).filter((name) => !name.startsWith("messages.db"));
    expect(added).toContain(SEARCH_CACHE_FILE);
    expect(added.filter((name) => !NAMES.includes(name))).toEqual([]);
    if (process.platform !== "win32") expect(statSync(join(DATA_DIR, SEARCH_CACHE_FILE)).mode & 0o777).toBe(0o600);
    await stopSearchCache();
    const schema = peek((cache) => cache.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'search_fts_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
    expect(schema.map(({ type, name }) => `${type} ${name}`)).toEqual(["table search_docs", "index search_docs_order", "index search_docs_thread_order", "table search_fts", "table search_meta"]);
    expect(String(schema.find(({ name }) => name === "search_fts")!.sql)).toContain("fts5(grams, content='', contentless_delete=1, detail=none, tokenize='ascii')");
    expect(String(schema.find(({ name }) => name === "search_docs")!.sql)).toMatch(/source_rowid INTEGER NOT NULL,\s+at INTEGER NOT NULL,\s+priority INTEGER NOT NULL,\s+source_hash BLOB,\s+UNIQUE\(thread_id, id\)/);
    expect(peek((cache) => cache.prepare("PRAGMA journal_mode").get())).toEqual({ journal_mode: "wal" });
    expect(docs()).toEqual(expected());
    expect(matching("검사 row 17")).toEqual([{ thread_id: "t2", id: "m17" }]);
  });

  it("rebuilds when the projection over its fixture changes", async () => {
    fixture(10);
    openSearchCache(DATA_DIR).close();
    const { pass, close } = await countingIndexer();
    await pass();
    close();
    expect(docs().length).toBeGreaterThan(0);
    vi.resetModules();
    vi.doMock("./search-text.ts", async (original) => {
      const real = await original<typeof import("./search-text.ts")>();
      return { ...real, messageSearchGrams: (row: Parameters<typeof real.messageSearchGrams>[0]) => real.messageSearchGrams({ ...row, text: row.text && `${row.text}!` }) };
    });
    const changed = await import("./search-cache.ts");
    vi.doUnmock("./search-text.ts");
    expect(changed.searchCacheFingerprint()).not.toBe(searchCacheFingerprint());
    changed.openSearchCache(DATA_DIR).close();
    expect(docs()).toEqual([]);
    expect(peek((cache) => cache.prepare("SELECT fingerprint, state FROM search_meta").get())).toEqual({ fingerprint: changed.searchCacheFingerprint(), state: "build" });
  });

  it("probes the exact fts5 table in memory, and stays on the scan for the process when it is missing", () => {
    expect(probeSearchFts()).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "search-probe-"));
    const preload = join(dir, "no-fts5.mjs");
    writeFileSync(preload, `import { DatabaseSync } from "node:sqlite";
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) { if (/fts5/.test(sql)) throw new Error("no such module: fts5"); return exec.call(this, sql); };`);
    try {
      fixture(5);
      closeMessageDb();
      const result = child(`
        const dc = await import("node:diagnostics_channel");
        let spawned = 0;
        dc.subscribe("worker_threads", () => spawned++);
        const db = await import(${url("message-db.ts")});
        const cache = await import(${url("search-cache.ts")});
        const gate = await import(${url("search-gate.ts")});
        db.messageDatabase();
        cache.startSearchCache(process.env.OMB_DATA_DIR);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        for (let i = 0; i < 5; i++) cache.startSearchCache(process.env.OMB_DATA_DIR);
        await new Promise((resolve) => setTimeout(resolve, 200));
        console.log(JSON.stringify({ spawned, trusted: gate.searchCacheState().trusted, hits: db.searchMessages("hello").length }));`,
      { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.split("\n");
      expect(lines.filter((line) => line.startsWith("search cache:"))).toEqual(["search cache: off (fts)"]);
      expect(JSON.parse(lines.at(-1)!)).toEqual({ spawned: 1, trusted: false, hits: 2 });
      expect(existsSync(join(DATA_DIR, SEARCH_CACHE_FILE))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the worker's import closure free of runtime state, and its source connection read-only", () => {
    const visited = new Set<string>();
    const walk = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      expect(["config.ts", "store.ts", "message-db.ts", "index.ts"]).not.toContain(basename(file));
      const parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const node of parsed.statements) {
        if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier) continue;
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        if (clause?.isTypeOnly || (ts.isExportDeclaration(node) && node.isTypeOnly)) continue;
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings) && !clause?.name && bindings.elements.every((item) => item.isTypeOnly)) continue;
        const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
        if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier));
        else expect(specifier, file).toMatch(/^node:/);
      }
    };
    walk(join(ROOT, "server", "search-worker.ts"));
    expect([...visited].map((file) => relative(ROOT, file).split(sep).join("/")).sort()).toEqual([
      "server/redact.ts", "server/search-cache.ts", "server/search-gate.ts", "server/search-text.ts", "server/search-worker.ts", "server/tool-redact.ts",
      "shared/redact.ts", "shared/tool-detail.ts", "shared/tool-verb.ts",
    ]);
    fixture(1);
    const source = openSearchSource(DATA_DIR);
    try {
      expect(() => source.exec("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES ('x', 'x', 1, 'user', 'text', 'x', '{}')")).toThrow(/readonly/);
      expect(() => source.exec("CREATE TABLE extra (x)")).toThrow(/readonly/);
    } finally {
      source.close();
    }
    expect(readFileSync(join(ROOT, "scripts", "bundle-server.mjs"), "utf8")).toContain('"search-worker.ts",');
  });

  it("starts only from a search request, after its answer, never at import or from searchMessages", async () => {
    const imported = child(`
      const dc = await import("node:diagnostics_channel");
      let spawned = 0;
      dc.subscribe("worker_threads", () => spawned++);
      const db = await import(${url("message-db.ts")});
      await import(${url("thread-routes.ts")});
      db.insertMessage("t", { id: "a", role: "user", kind: "text", text: "hello", at: 1 });
      const hits = db.searchMessages("hello").length + db.searchMessages("hello", 5, "t").length;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { existsSync } = await import("node:fs");
      console.log(JSON.stringify({ spawned, hits, cache: existsSync(process.env.OMB_DATA_DIR + "/search-cache.db") }));`);
    expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual({ spawned: 0, hits: 2, cache: false });

    fixture(5);
    const store = { botByThread: () => undefined, groupByThread: () => undefined };
    const routes = createThreadRoutes({ dataDir: DATA_DIR, store } as unknown as Parameters<typeof createThreadRoutes>[0]);
    let body = "";
    const answered = routes.search({ writeHead: () => {}, end: (data: string) => { body = data; } } as never, new URL("http://x/api/search?q=hello"));
    expect(workers).toHaveLength(0);
    await answered;
    expect(JSON.parse(body)).toMatchObject({ hits: [], more: false });
    expect(workers).toHaveLength(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(workers).toHaveLength(1);
    await trusted();
    await routes.search({ writeHead: () => {}, end: () => {} } as never, new URL("http://x/api/search?q=hello"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(workers).toHaveLength(1);
  });

  it.each([
    ["close", () => closeMessageDb()],
    ["reopen", () => {
      messageDatabase().close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
      messageDatabase();
    }],
  ])("stops the worker and closes its handles on %s", async (_name, replace) => {
    fixture(5);
    startSearchCache(DATA_DIR);
    await trusted();
    const exited = new Promise((resolve) => workers[0].once("exit", resolve));
    replace();
    await stopSearchCache();
    await exited;
    expect(searchCacheState().trusted).toBe(false);
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true });
    expect(existsSync(DATA_DIR)).toBe(false);
  });

  it("reconciles changed, moved, new and deleted rows, and refreshes rowid and time on an unchanged hash", async () => {
    fixture(30);
    const { pass, close } = await countingIndexer();
    try {
      expect(await pass()).toBe(29);
      expect(docs()).toEqual(expected());
      expect(await pass()).toBe(0);
      insertMessage("t0", msg("m15", "hello 검사 row 15", { at: 15 }));
      updateMessage("t0", msg("m3", "edited words", { at: 90 }));
      insertMessage("t0", msg("m9", "now summarized", { summarized: true }));
      insertMessage("t2", msg("fresh", "brand new"));
      insertMessage("t2", msg("m5", "became a note", { kind: "note" }));
      deleteThread("t1");
      replaceThread("t3", [msg("r1"), tool("r2", "Read")], "r2");
      expect(await pass()).toBe(5);
      expect(docs()).toEqual(expected());
      expect(docs().some(({ thread_id }) => thread_id === "t1")).toBe(false);
      expect(matching("edited words")).toEqual([{ thread_id: "t0", id: "m3" }]);
      expect(matching("brand new")).toEqual([{ thread_id: "t2", id: "fresh" }]);
      expect(matching("now summarized")).toEqual([]);

      replaceThread("t3", [msg("r1"), tool("r2", "Read")], "r2");
      const external = new DatabaseSync(join(DATA_DIR, "messages.db"));
      external.exec("INSERT OR REPLACE INTO messages SELECT * FROM messages WHERE thread_id = 't0' AND id = 'm21'");
      external.close();
      expect(await pass()).toBe(1);
      expect(docs()).toEqual(expected());
    } finally {
      close();
    }
  });

  it("applies dirt per epoch without a full pass, and acks only after the cache commit", async () => {
    fixture(30);
    startSearchCache(DATA_DIR);
    await trusted();
    const generation = meta()!.generation;
    appendMessage("t0", msg("sent", "just sent", { at: 100 }));
    updateMessage("t0", msg("m3", "patched text", { at: 101 }));
    replaceThread("t1", [msg("x1", "replaced row")], "x1");
    applySyncedRows("t2", [msg("synced", "from sync")]);
    deleteThread("t2");
    expect(searchCacheState().trusted).toBe(false);
    startSearchCache(DATA_DIR);
    await trusted();
    expect(meta()!.generation).toBe(generation);
    expect(docs()).toEqual(expected());
    expect(matching("patched text")).toEqual([{ thread_id: "t0", id: "m3" }]);
    expect(matching("hello 검사 row 3")).toEqual([]);

    const external = new DatabaseSync(join(DATA_DIR, "messages.db"));
    external.exec("DELETE FROM messages WHERE id = 'sent'");
    external.close();
    startSearchCache(DATA_DIR);
    await trusted();
    expect(meta()!.generation).toBe(Number(generation) + 1);
    expect(docs()).toEqual(expected());
  });

  it("keeps a full pass that a write overtook and catches the write up with a dirt pass", { timeout: 90_000 }, async () => {
    fixture(3000);
    startSearchCache(DATA_DIR);
    let late = 0;
    const { sent, restore } = posts(workers[0], (work) => {
      if (work.full) insertMessage("t0", msg(`late-${late}`, `late arrival ${late++}`));
    });
    try {
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2), { timeout: 60_000, interval: 5 });
      expect(sent[1].full).toBe(false);
      await trusted();
      expect(meta()).toMatchObject({ generation: 1, state: "current" });
      expect(docs()).toEqual(expected());
      for (let i = 0; i < late; i++) expect(matching(`late arrival ${i}`)).toEqual([{ thread_id: "t0", id: `late-${i}` }]);
    } finally {
      restore();
      await stopSearchCache();
    }
  });

  it("catches up after writes one turn later, without a search", { timeout: 90_000 }, async () => {
    fixture(30);
    startSearchCache(DATA_DIR);
    const { sent, restore } = posts(workers[0]);
    try {
      await trusted();
      sent.length = 0;
      appendMessage("t0", msg("sent", "just sent", { at: 100 }));
      updateMessage("t0", msg("m3", "patched text", { at: 101 }));
      expect(sent).toEqual([]);
      await drain();
      expect(sent).toMatchObject([{ full: false, threads: new Set(), keys: new Map([["t0", new Set(["sent", "m3"])]]) }]);
      await trusted();
      expect(docs()).toEqual(expected());
      expect(matching("patched text")).toEqual([{ thread_id: "t0", id: "m3" }]);
    } finally {
      restore();
      await stopSearchCache();
    }
  });

  it("replaces a full or dirt pass that crossed the dirt cap and ends exact", { timeout: 120_000 }, async () => {
    fixture(3000);
    startSearchCache(DATA_DIR);
    const crossed: boolean[] = [];
    const bulk = (round: number) => withMessageTransaction(() => {
      for (let i = 0; i <= 10_000; i++) insertMessage("bulk", msg(`bulk-${i}`, `bulk ${round} row ${i} end`, { at: i }));
    });
    const { restore } = posts(workers[0], (work) => {
      if (crossed.length > 1 || (crossed.length === 1) === work.full) return;
      const before = searchCacheState();
      bulk(crossed.length);
      expect(searchCacheState()).toMatchObject({ generation: before.generation + 1, full: true, threads: new Set(), keys: new Map() });
      insertMessage("t0", msg(`newer-${crossed.length}`, `newer ${crossed.length} arrival`));
      crossed.push(work.full);
    });
    const boundaries: Array<{ generation: number; current: number; full: boolean; trusted: boolean; newer: boolean; exact: boolean }> = [];
    workers[0].on("message", (message: { type: string; generation: number }) => {
      if (message.type !== "done") return;
      const state = searchCacheState();
      boundaries.push({
        generation: message.generation, current: state.generation, full: state.full, trusted: state.trusted,
        newer: Boolean(state.keys.get("t0")?.has(`newer-${crossed.length - 1}`)),
        exact: state.trusted && hash(docs()) === hash(expected()),
      });
    });
    try {
      await vi.waitFor(() => expect(crossed).toEqual([true]), { timeout: 60_000, interval: 5 });
      await trusted();
      appendMessage("t0", msg("poke", "poke row"));
      await vi.waitFor(() => expect(crossed).toEqual([true, false]), { timeout: 60_000, interval: 5 });
      await trusted();
      const stale = boundaries.filter(({ generation, current }) => generation < current);
      expect(stale).toHaveLength(2);
      expect(stale.every(({ full, trusted, newer }) => full && !trusted && newer)).toBe(true);
      expect(boundaries.filter(({ trusted, exact }) => trusted !== exact)).toEqual([]);
      expect(docs()).toEqual(expected());
      expect(matching("bulk 1 row 4321 end")).toEqual([{ thread_id: "bulk", id: "bulk-4321" }]);
      expect(matching("bulk 0 row 4321 end")).toEqual([]);
      for (const round of [0, 1]) expect(matching(`newer ${round} arrival`)).toEqual([{ thread_id: "t0", id: `newer-${round}` }]);
    } finally {
      restore();
      await stopSearchCache();
    }
  });

  it("drops a catch-up queued before stop or close, and restarts on the next source", { timeout: 90_000 }, async () => {
    fixture(30);
    const second = mkdtempSync(join(tmpdir(), "search-second-"));
    let other: DatabaseSync | undefined;
    const watched: Array<ReturnType<typeof posts>> = [];
    const begin = (dataDir = DATA_DIR) => {
      startSearchCache(dataDir);
      watched.push(posts(workers.at(-1)!));
      return watched.at(-1)!.sent;
    };
    try {
      let sent = begin();
      await trusted();
      sent.length = 0;
      const database = messageDatabase();
      appendMessage("t0", msg("queued", "queued write", { at: 50 }));
      const stopped = stopSearchCache();
      const prepare = vi.spyOn(database, "prepare");
      await drain();
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
      await stopped;
      appendMessage("t0", msg("later", "later write", { at: 51 }));
      await drain();
      expect([sent, workers.length, searchCacheState().trusted]).toEqual([[], 1, false]);
      expect(searchMessages("write").map(({ messageId }) => messageId)).toEqual(["later", "queued"]);
      expect(searchMessages("write")).toEqual(withMessageTransaction(() => searchMessages("write")));

      sent = begin();
      await trusted();
      expect(sent.map(({ full }) => full)).toEqual([false]);
      expect(docs()).toEqual(expected());
      appendMessage("t0", msg("restarted", "after restart"));
      await drain();
      expect(sent.map(({ full, keys }) => [full, keys])).toEqual([[false, new Map([["t0", new Set(["queued", "later"])]])], [false, new Map([["t0", new Set(["restarted"])]])]]);
      await trusted();
      expect(docs()).toEqual(expected());

      appendMessage("t0", msg("closing", "closing write"));
      closeMessageDb();
      await drain();
      await stopSearchCache();
      expect(sent).toHaveLength(2);
      expect(messageDatabase() === database).toBe(false);
      expect(searchCacheState()).toMatchObject({ full: true, trusted: false });

      messageDatabase().exec(`VACUUM INTO '${join(second, "messages.db")}'`);
      closeMessageDb();
      other = new DatabaseSync(join(second, "messages.db"));
      searchSource(other);
      sent = begin(second);
      await trusted();
      other.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES ('t0', 'second', 60, 'user', 'text', 'second dir', ?)")
        .run(JSON.stringify(msg("second", "second dir", { at: 60 })));
      searchDirty(other, "t0", "second");
      await drain();
      expect(sent.map(({ full }) => full)).toEqual([true, false]);
      await trusted();
      expect(peek((cache) => cache.prepare("SELECT thread_id, id FROM search_docs WHERE id IN ('second', 'closing') ORDER BY id").all(), second))
        .toEqual([{ thread_id: "t0", id: "closing" }, { thread_id: "t0", id: "second" }]);
      await stopSearchCache();
      searchSource(null);
      other.close();
      messageDatabase();
      sent = begin();
      await trusted();
      expect(sent.map(({ full }) => full)).toEqual([true]);
      expect(docs()).toEqual(expected());
      expect(docs().some(({ id }) => id === "second")).toBe(false);
    } finally {
      for (const { restore } of watched) restore();
      await stopSearchCache();
      if (other?.isOpen) {
        searchSource(null);
        other.close();
      }
      rmSync(second, { recursive: true, force: true });
    }
  });

  it.each(["error", "corrupt"])("drops a catch-up queued before the worker fails with %s", { timeout: 60_000 }, (reason) => {
    fixture(30);
    closeMessageDb();
    const result = child(`
      const dc = await import("node:diagnostics_channel");
      const workers = [];
      dc.subscribe("worker_threads", ({ worker }) => workers.push(worker));
      const db = await import(${url("message-db.ts")});
      const cache = await import(${url("search-cache.ts")});
      const gate = await import(${url("search-gate.ts")});
      const dir = process.env.OMB_DATA_DIR;
      const drain = () => new Promise((resolve) => setImmediate(resolve));
      const wait = async (done) => { for (let i = 0; i < 3000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); };
      const write = (id, at) => db.appendMessage("t0", { id, role: "user", kind: "text", text: id + " write", at, parentId: null });
      const hits = () => db.searchMessages("write").map((hit) => hit.messageId);
      let posts = 0;
      const watch = (worker) => {
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message) => { post(message); if (message.type === "work") posts++; };
      };
      const database = db.messageDatabase();
      cache.startSearchCache(dir);
      watch(workers[0]);
      await wait(() => gate.searchCacheState().trusted);
      const exited = new Promise((resolve) => workers[0].once("exit", resolve));
      const before = posts;
      write("queued", 50);
      ${reason === "error" ? `workers[0].emit("error", new Error("test failure"));` : `workers[0].emit("message", { type: "failed", reason: "corrupt" });`}
      let samples = 0;
      const prepare = database.prepare;
      database.prepare = function (sql) { if (sql === "PRAGMA data_version") samples++; return prepare.call(this, sql); };
      await drain();
      write("later", 51);
      await drain();
      database.prepare = prepare;
      const old = { posts: posts - before, samples, trusted: gate.searchCacheState().trusted, hits: hits() };
      await workers[0].terminate();
      await exited;
      cache.startSearchCache(dir);
      let restarted = null;
      if (workers.length === 2) {
        watch(workers[1]);
        await wait(() => gate.searchCacheState().trusted);
        const at = posts;
        write("fresh", 52);
        await drain();
        const pushed = posts - at;
        await wait(() => gate.searchCacheState().trusted);
        restarted = { pushed, trusted: gate.searchCacheState().trusted, hits: hits() };
        await cache.stopSearchCache();
      }
      console.log(JSON.stringify({ workers: workers.length, old, restarted }));`);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("search cache:"))).toEqual([`search cache: off (${reason})`]);
    const old = { posts: 0, samples: 0, trusted: false, hits: ["later", "queued"] };
    expect(JSON.parse(lines.at(-1)!)).toEqual(reason === "error"
      ? { workers: 1, old, restarted: null }
      : { workers: 2, old, restarted: { pushed: 1, trusted: true, hits: ["fresh", "later", "queued"] } });
  });

  it.each([
    ["mid-page", 1, { state: "build" }],
    ["before-commit", 1, { state: "build" }],
    ["validating", 2, { state: "validate", generation: 1 }],
    ["after-commit", 1, { state: "current", generation: 1 }],
    ["after-ack", 0, { state: "current", generation: 1 }],
  ])("keeps committed work and stays untrusted after a crash %s", async (crash, passes, after) => {
    fixture(700);
    const rows = expected();
    closeMessageDb();
    const result = crash === "after-ack"
      ? child(`
        const db = await import(${url("message-db.ts")});
        const cache = await import(${url("search-cache.ts")});
        const gate = await import(${url("search-gate.ts")});
        db.messageDatabase();
        cache.startSearchCache(process.env.OMB_DATA_DIR);
        while (!gate.searchCacheState().trusted) await new Promise((resolve) => setTimeout(resolve, 10));
        process.exit(91);`)
      : child(harness(passes), { CRASH: crash });
    expect(result.status, result.stderr).toBe(91);
    const firstPage = messageDatabase().prepare("SELECT rowid FROM messages ORDER BY rowid LIMIT 1 OFFSET 255").get()!.rowid;
    const kept = docs();
    expect(meta()).toMatchObject({ ...after, cursor: ["build", "validate"].includes(after.state) ? firstPage : 0 });
    expect(kept).toEqual(after.state === "build" ? rows.filter(({ source_rowid }) => Number(source_rowid) <= Number(firstPage)) : rows);

    // an older build writes while this one is stopped
    updateMessage("t0", msg("m3", "changed while stopped", { at: 3 }));
    const external = new DatabaseSync(join(DATA_DIR, "messages.db"));
    external.exec("INSERT OR REPLACE INTO messages SELECT * FROM messages WHERE id = 'm1'");
    external.exec("DELETE FROM messages WHERE id = 'm5'");
    external.close();
    expect(searchCacheState()).toMatchObject({ trusted: false, full: true });
    expect(searchMessages("hello 검사", 1000).length).toBe(rows.filter(({ priority }) => priority === 0).length - 2);

    const { pass, close } = await countingIndexer();
    try {
      expect(await pass()).toBe(rows.length - kept.length + 1);
    } finally {
      close();
    }
    expect(searchCacheState().trusted).toBe(false);
    startSearchCache(DATA_DIR);
    await trusted();
    expect(docs()).toEqual(expected());
    expect(matching("changed while stopped")).toEqual([{ thread_id: "t0", id: "m3" }]);
  });

  it("drops trust for the process when the worker dies, the cache is busy or its file is deleted", () => {
    fixture(5);
    closeMessageDb();
    const setup = `
      const dc = await import("node:diagnostics_channel");
      const workers = [];
      dc.subscribe("worker_threads", ({ worker }) => workers.push(worker));
      const db = await import(${url("message-db.ts")});
      const cache = await import(${url("search-cache.ts")});
      const gate = await import(${url("search-gate.ts")});
      const { DatabaseSync } = await import("node:sqlite");
      const { existsSync, rmSync } = await import("node:fs");
      const dir = process.env.OMB_DATA_DIR;
      const wait = async (done) => { for (let i = 0; i < 3000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); };
      const exited = () => new Promise((resolve) => workers.at(-1).once("exit", resolve));
      db.messageDatabase();
      const report = async () => {
        for (let i = 0; i < 3; i++) cache.startSearchCache(dir);
        await new Promise((resolve) => setTimeout(resolve, 300));
        console.log(JSON.stringify({ workers: workers.length, trusted: gate.searchCacheState().trusted, hits: db.searchMessages("hello").length }));
      };`;
    const killed = child(`${setup}
      cache.startSearchCache(dir);
      await wait(() => gate.searchCacheState().trusted);
      const gone = exited();
      await workers[0].terminate();
      await gone;
      await report();`);
    const busy = child(`${setup}
      const lock = new DatabaseSync(dir + "/search-cache.db");
      lock.exec("BEGIN EXCLUSIVE");
      cache.startSearchCache(dir);
      await exited();
      lock.exec("ROLLBACK");
      lock.close();
      await report();`);
    const deleted = child(`${setup}
      cache.startSearchCache(dir);
      await wait(() => gate.searchCacheState().trusted);
      let removed = true;
      // Windows refuses to delete a file SQLite holds open
      try { rmSync(dir + "/search-cache.db"); } catch (error) { removed = error.code !== "EPERM" && error.code !== "EBUSY"; }
      db.insertMessage("t0", { id: "after", role: "user", kind: "text", text: "hello again", at: 9 });
      const gone = exited();
      cache.startSearchCache(dir);
      if (removed) await gone;
      else await wait(() => gate.searchCacheState().trusted);
      await report();`);
    for (const [result, reason] of [[killed, "exit"], [busy, "error"], [deleted, "gone"]] as const) {
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.split("\n");
      const kept = reason === "gone" && process.platform === "win32";
      expect(lines.filter((line) => line.startsWith("search cache:"))).toEqual(kept ? [] : [`search cache: off (${reason})`]);
      expect(JSON.parse(lines.at(-1)!)).toEqual({ workers: 1, trusted: kept, hits: reason === "gone" ? 3 : 2 });
    }
    const next = child(`${setup}
      cache.startSearchCache(dir);
      await wait(() => gate.searchCacheState().trusted);
      console.log(gate.searchCacheState().trusted);`);
    expect(next.stdout).toBe("true");
  });

  it("reports a cache file deleted under it", async () => {
    fixture(5);
    vi.resetModules();
    vi.doMock("node:fs", async (original) => {
      const real = await original<typeof import("node:fs")>();
      return { ...real, existsSync: (path: string) => !path.endsWith(SEARCH_CACHE_FILE) && real.existsSync(path) };
    });
    const { createSearchIndexer, SearchCacheGone } = await import("./search-cache.ts");
    vi.doUnmock("node:fs");
    const indexer = createSearchIndexer(DATA_DIR);
    try {
      await expect(indexer.work({ full: true, threads: new Set(), keys: new Map() })).rejects.toBeInstanceOf(SearchCacheGone);
    } finally {
      indexer.close();
    }
  });

  it.each([
    ["not a database", (file: string) => writeFileSync(file, "x".repeat(8192))],
    ["corrupt pages", (file: string) => {
      const bytes = readFileSync(file);
      bytes.fill(0x5a, 4096 * 2);
      writeFileSync(file, bytes);
    }],
  ])("deletes only its own files when %s and rebuilds once in the process", (_name, damage) => {
    fixture(400);
    const before = sourceShape();
    closeMessageDb();
    const built = child(harness(1), { CRASH: "" });
    expect(built.status, built.stderr).toBe(0);
    damage(join(DATA_DIR, SEARCH_CACHE_FILE));
    const result = child(`
      const dc = await import("node:diagnostics_channel");
      const workers = [];
      dc.subscribe("worker_threads", ({ worker }) => workers.push(worker));
      const db = await import(${url("message-db.ts")});
      const cache = await import(${url("search-cache.ts")});
      const gate = await import(${url("search-gate.ts")});
      const { existsSync, writeFileSync } = await import("node:fs");
      const dir = process.env.OMB_DATA_DIR;
      db.messageDatabase();
      cache.startSearchCache(dir);
      await new Promise((resolve) => workers[0].once("exit", resolve));
      const deleted = ["", "-wal", "-shm"].every((suffix) => !existsSync(dir + "/search-cache.db" + suffix));
      cache.startSearchCache(dir);
      while (!gate.searchCacheState().trusted) await new Promise((resolve) => setTimeout(resolve, 10));
      await cache.stopSearchCache();
      writeFileSync(dir + "/search-cache.db", "x".repeat(8192));
      cache.startSearchCache(dir);
      await new Promise((resolve) => workers[2].once("exit", resolve));
      cache.startSearchCache(dir);
      await new Promise((resolve) => setTimeout(resolve, 300));
      console.log(JSON.stringify({ deleted, workers: workers.length, trusted: gate.searchCacheState().trusted, messages: existsSync(dir + "/messages.db") }));`);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("search cache:"))).toEqual(["search cache: off (corrupt)", "search cache: off (corrupt)"]);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ deleted: true, workers: 3, trusted: false, messages: true });
    expect(sourceShape()).toBe(before);
  });

  it("is never selected by profile, memory, chat or Drive sync, or by bot export", async () => {
    const folder = mkdtempSync(join(tmpdir(), "search-sync-"));
    try {
      const ids = { profileDeviceId: "device", writerId: "writer", memoryDeviceId: "0123456789ab" };
      for (const name of NAMES) {
        expect(drivePathRule(name, ids), name).toBe("unknown");
        expect(drivePathRule(`threads-v2/bot/thread/writer/${name}`, ids), name).toBe("unknown");
        expect(isMemoryTopicName(name), name).toBe(false);
      }
      for (const dir of ["changes", "threads/bot", "threads-v2/bot", "threads-v2/bot/thread/peer"]) {
        mkdirSync(join(folder, dir), { recursive: true });
        for (const name of NAMES) writeFileSync(join(folder, dir, name), "private");
      }
      expect(readSyncOperations(folder)).toEqual({ operations: [], invalidFiles: [], truncated: false });
      expect(pullBotThreads({ folder } as ThreadSyncHost, "bot", "bot")).toEqual({});
      const sync = new ThreadSyncV2({ folder, dataDir: join(folder, "local"), deviceId: "local" });
      try {
        expect(await sync.threads("bot")).toEqual(["thread"]);
        expect((await sync.pull({ botSyncId: "bot", threadId: "thread" })).rowsTouched).toBe(0);
      } finally {
        await sync.close();
      }
      for (const file of ["bot-package.ts", "bot-profile.ts", "package-export.ts"]) {
        const text = readFileSync(join(ROOT, "server", file), "utf8");
        expect(text, file).not.toMatch(/from "(?:node:)?fs(?:\/promises)?"|search-cache|DATA_DIR/);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
