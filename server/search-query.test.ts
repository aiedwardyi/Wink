import dc from "node:diagnostics_channel";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  appendMessage,
  applySyncedRows,
  closeMessageDb,
  insertMessage,
  messageDatabase,
  replaceThread,
  searchMessages,
  updateMessage,
  withMessageTransaction,
} from "./message-db.ts";
import { createSearchIndexer, startSearchCache, stopSearchCache } from "./search-cache.ts";
import { ackSearchCache, searchCacheState, syncRequestStarted, untrustSearchCache } from "./search-gate.ts";
import * as query from "./search-query.ts";
import type { Message } from "./store.ts";

const msg = (id: string, text = id, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: 1, parentId: null, ...extra });
const fixed = ["a", "is", "API", "error", "search", "Bash", "the result", "node:sqlite", "%", "qzxv_1105\\nohit", "검", "결", "검사", "결과", "검색", "요", "완료", "다음 단계", "결과:", "쀍쀍없는결과"];
const literals = "a is API error search Bash the result node:sqlite 100% _ \\ \" ' 검사 결과 검색 요 완료 다음 단계 결과: 🧠 e\u0301 É İ Σ";
const scanRows = "SEARCH_SCAN_ROWS" in query ? Number(query.SEARCH_SCAN_ROWS) : 20000;
let fts: string[];
let fetched: number;
let scanned: number;

async function ready(pad = true) {
  if (pad) {
    const source = messageDatabase();
    const threads = source.prepare("SELECT DISTINCT thread_id FROM messages").all();
    const insert = source.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, -1, 'user', 'note', '', ?)");
    withMessageTransaction(() => {
      for (const { thread_id } of threads) {
        for (let i = 0; i < scanRows; i++) {
          const row = msg(`search-query-padding-${i}`, "", { at: -1, kind: "note" });
          insert.run(thread_id, row.id, JSON.stringify(row));
        }
      }
    });
  }
  const module = await import("./search-cache.ts").catch(() => null);
  if (!module) return;
  const state = searchCacheState();
  const indexer = module.createSearchIndexer(DATA_DIR);
  try {
    await indexer.work(state);
  } finally {
    indexer.close();
  }
  expect(ackSearchCache(state.epoch, state.generation)).toBe(true);
}

function trace(before?: (database: DatabaseSync, sql: string) => void, after?: (database: DatabaseSync, sql: string, stmt: StatementSync) => void) {
  const source = messageDatabase();
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    before?.(this, sql);
    const stmt = prepare.call(this, sql);
    if (sql.includes("search_fts MATCH")) {
      for (const method of ["get", "all", "iterate"] as const) {
        const run = stmt[method].bind(stmt);
        Object.defineProperty(stmt, method, { value: (...args: Parameters<StatementSync[typeof method]>) => {
          fts.push(String(args[0]));
          return Reflect.apply(run, stmt, args);
        } });
      }
    }
    if (this === source && sql.startsWith("SELECT thread_id, id, at, role, kind")) {
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => { fetched++; return Reflect.apply(get, stmt, args); };
    }
    if (this === source && sql.startsWith("SELECT rowid AS row FROM messages ")) {
      const iterate = stmt.iterate.bind(stmt);
      stmt.iterate = (...args) => { scanned++; return Reflect.apply(iterate, stmt, args); };
    }
    after?.(this, sql, stmt);
    return stmt;
  });
}

function hiddenOnly() {
  const rows = Array.from({ length: 3000 }, (_, i) => msg(`hidden-${i}`, "", {
    at: i, kind: "activity", tool: { name: "Read", detail: { input: "public/file.txt", output: ["HiddenOnlyNeedle"], outputHidden: true } },
  }));
  applySyncedRows("hidden", rows);
  const raw = messageDatabase().prepare("UPDATE messages SET json = ? WHERE thread_id = 'hidden' AND id = ?");
  withMessageTransaction(() => { for (const row of rows) raw.run(JSON.stringify(row), row.id); });
}

function corpus() {
  for (const thread of ["one", "two"]) {
    const rows = Array.from({ length: 140 }, (_, i) => msg(`${thread}-${i}`, `${literals} ${i}`, {
      at: Math.floor(i / 4), role: i % 2 ? "bot" : "user", from: { name: "Helper", botId: "helper", color: "blue" },
      parentId: i > 1 ? `${thread}-${i - 2}` : null,
      ...(i % 3 === 0 ? { kind: "activity" as const, text: "", tool: { name: "Bash", summary: `search summary ${i}`, detail: { input: literals, output: [literals, "tail"] } } } : {}),
      ...(i % 17 === 0 ? { summarized: true } : {}),
      ...(i % 19 === 0 ? { kind: "note" as const } : {}),
    }));
    rows.push(msg(`${thread}-comm`, literals, { at: 9, kind: "activity", tool: { name: "Reply from @Helper" }, comm: { groupId: "room", withBotId: "helper", withName: "Helper", withColor: "blue", peer: "reply" } }));
    replaceThread(thread, rows, `${thread}-139`);
  }
  applySyncedRows("noise", Array.from({ length: 700 }, (_, i) => msg(`noise-${i}`, "irrelevant newer row", { at: 1000 + i })));
}

beforeEach(async () => {
  closeMessageDb();
  await stopSearchCache();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  fts = [];
  fetched = 0;
  scanned = 0;
});

afterEach(async () => {
  await stopSearchCache();
  vi.restoreAllMocks();
});

describe("search query", () => {
  it("scans a small trusted scope without opening the cache", async () => {
    replaceThread("small", Array.from({ length: 100 }, (_, i) => msg(`small-${i}`, "small search", { at: i })), "small-99");
    const baseline = searchMessages("search", 40, "small");
    await ready(false);
    let opened = 0;
    trace((_database, sql) => { if (sql.startsWith("SELECT format, fingerprint")) opened++; });
    expect(searchMessages("search", 40, "small")).toEqual(baseline);
    expect(scanned).toBe(1);
    expect(opened).toBe(0);
    expect(searchCacheState().trusted).toBe(true);
  });

  it("reuses scope counts only within the current source epoch and generation", async () => {
    replaceThread("memo", Array.from({ length: scanRows - 1 }, (_, i) => msg(`memo-${i}`, "memo", { kind: i ? "note" : "text" })), "memo-0");
    await ready(false);
    const source = messageDatabase();
    let probes = 0;
    trace((database, sql) => { if (database === source && sql.endsWith(`LIMIT 1 OFFSET ${scanRows - 1}`)) probes++; });
    expect(searchMessages("memo", 40, "memo")).toHaveLength(1);
    expect(searchMessages("memo", 40, "memo")).toHaveLength(1);
    expect(probes).toBe(1);
    insertMessage("memo", msg("memo-new", "memo", { at: 2 }));
    const changed = searchMessages("memo", 40, "memo");
    await ready(false);
    fts = [];
    expect(searchMessages("memo", 40, "memo")).toEqual(changed);
    expect(probes).toBe(2);
    expect(fts.length).toBeGreaterThan(0);
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    other.prepare("DELETE FROM messages WHERE thread_id = 'memo' AND id = 'memo-new'").run();
    other.close();
    expect(searchMessages("memo", 40, "memo")).toHaveLength(1);
    expect(searchCacheState().trusted).toBe(false);
    await ready(false);
    fts = [];
    scanned = 0;
    expect(searchMessages("memo", 40, "memo")).toHaveLength(1);
    expect(searchMessages("memo", 40, "memo")).toHaveLength(1);
    expect(probes).toBe(3);
    expect(scanned).toBe(2);
    expect(fts).toEqual([]);
  });

  it("rejects 3,000 older hidden-only previews with bounded source fetches", async () => {
    hiddenOnly();
    await ready();
    trace();
    expect(searchMessages("HiddenOnlyNeedle")).toEqual([]);
    expect(fetched).toBeLessThanOrEqual(10);
    expect(fts.some((match) => match.includes("g000068000069000064") && match.includes("kindactivity"))).toBe(true);
    expect(scanned).toBe(0);
  });

  it("serves hidden-only searches from the cache while writes continue after a restart", { timeout: 180_000 }, async () => {
    hiddenOnly();
    await ready();
    closeMessageDb();
    await stopSearchCache();
    messageDatabase();
    expect(searchCacheState()).toMatchObject({ full: true, trusted: false });
    trace();
    let failure: unknown;
    let written = 0;
    let newest = "";
    let samples = 0;
    let served = 0;
    let current = 0;
    let done: { epoch: number; generation: number } | undefined;
    const append = () => {
      newest = `live-${written}`;
      appendMessage("live", msg(newest, `LiveNeedle ${written}`, { at: 10_000 + written++ }));
    };
    const sample = () => {
      try {
        samples++;
        const state = searchCacheState();
        const before = { fetched, scanned, fts: fts.length };
        expect(searchMessages("HiddenOnlyNeedle")).toEqual([]);
        const cached = { fetched: fetched - before.fetched <= 10, scanned: scanned - before.scanned, matched: fts.slice(before.fts).some((match) => match.includes("g000068000069000064") && match.includes("kindactivity")) };
        if (cached.fetched && !cached.scanned && cached.matched) served++;
        if (done?.epoch === state.epoch && done.generation === state.generation) {
          current++;
          expect(state.trusted).toBe(true);
          expect(cached).toEqual({ fetched: true, scanned: 0, matched: true });
        }
        const live = searchMessages("LiveNeedle", 41);
        expect(live).toEqual(withMessageTransaction(() => searchMessages("LiveNeedle", 41)));
        if (written) expect(live[0]?.messageId).toBe(newest);
        setImmediate(startSearchCache, DATA_DIR);
      } catch (error) {
        failure ??= error;
      }
    };
    const handlers: Array<[Worker, (message: { type: string; epoch: number; generation: number }) => void]> = [];
    const spawned = (message: unknown) => {
      const { worker } = message as { worker: Worker };
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (work: { type: string; full?: boolean }) => {
        post(work);
        if (work.type === "work" && work.full) append();
      };
      const handle = (message: { type: string; epoch: number; generation: number }) => {
        if (message.type !== "done") return;
        done = { epoch: message.epoch, generation: message.generation };
        sample();
      };
      handlers.push([worker, handle]);
      // after the controller's own listener, which acks first
      queueMicrotask(() => worker.on("message", handle));
    };
    const until = async (ready: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; !failure && !ready() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 50));
      if (failure) throw failure;
    };
    dc.subscribe("worker_threads", spawned);
    const writer = setInterval(() => {
      try {
        append();
      } catch (error) {
        failure ??= error;
      }
    }, 1000);
    const sampler = setInterval(sample, 250);
    try {
      const start = Date.now();
      await until(() => served > 0, 60_000);
      expect(served, "a hidden search was served from the cache within 60 s").toBeGreaterThan(0);
      const first = Date.now() - start;
      await until(() => false, 15_000);
      expect(current).toBeGreaterThan(0);
      console.log(`search converge: first cache-served ${first} ms after the first sample; ${served}/${samples} samples served, ${current} at a current done, ${written} writes`);
    } finally {
      clearInterval(writer);
      clearInterval(sampler);
      dc.unsubscribe("worker_threads", spawned);
      for (const [worker, handle] of handlers) worker.off("message", handle);
      await stopSearchCache();
    }
  });

  it("takes the scan after a partial ack and the cache after the final one", async () => {
    insertMessage("one", msg("old", "search"));
    await ready();
    const indexer = createSearchIndexer(DATA_DIR);
    try {
      insertMessage("one", msg("first", "search", { at: 2 }));
      const posted = searchCacheState();
      insertMessage("one", msg("second", "search", { at: 3 }));
      expect(await indexer.work(posted)).toBe(true);
      expect(ackSearchCache(posted.epoch, posted.generation)).toBe(false);
      trace();
      const baseline = withMessageTransaction(() => searchMessages("search"));
      expect(baseline.map((hit) => hit.messageId)).toEqual(["second", "first", "old"]);
      const generation = searchCacheState().generation;
      scanned = 0;
      expect(searchMessages("search")).toEqual(baseline);
      expect([scanned, fts]).toEqual([1, []]);
      const last = searchCacheState();
      expect(last.generation).toBe(generation);
      expect(await indexer.work(last)).toBe(true);
      expect(ackSearchCache(last.epoch, last.generation)).toBe(true);
      expect(searchMessages("search")).toEqual(baseline);
      expect(scanned).toBe(1);
      expect(fts.length).toBeGreaterThan(0);
    } finally {
      indexer.close();
    }
  });

  it("matches every ordered field for fixed and generated literals, paging and pending writes", async () => {
    corpus();
    let seed = 1105;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const points = Array.from(literals);
    const queries = [...fixed, "_", "\\", "\"", "'", "🧠", "e\u0301", "É", "İ", "Σ", ...Array.from({ length: 30 }, (_, i) => {
      const at = random(points.length);
      return points.slice(at, at + (i % 3 === 0 ? 1 : i % 3 === 1 ? 2 : 3 + random(20))).join("");
    })];
    const shapes = [
      { thread: undefined, before: undefined }, { thread: "one", before: undefined },
      { thread: "one", before: "one-85" }, { thread: "one", before: "missing" },
      { thread: "one", before: "two-85" }, { thread: undefined, before: "one-85" },
    ];
    const cases = queries.flatMap((query) => [1, 12, 40, 41, 100].flatMap((limit) => shapes.flatMap(({ thread, before }) => [false, true].map((chips) => ({ query, limit, thread, options: { before, chips } })))));
    const baseline = cases.map(({ query, limit, thread, options }) => searchMessages(query, limit, thread, options));
    await ready();
    trace();
    for (const [i, { query, limit, thread, options }] of cases.entries()) expect(searchMessages(query, limit, thread, options), JSON.stringify(cases[i])).toEqual(baseline[i]);
    expect(fts.length).toBeGreaterThan(0);
    expect(scanned).toBe(0);
    insertMessage("one", msg("pending", literals, { at: 9000 }));
    const beforeAck = cases.map(({ query, limit, thread, options }) => searchMessages(query, limit, thread, options));
    const count = fts.length;
    expect(searchCacheState().trusted).toBe(false);
    untrustSearchCache();
    for (const [i, { query, limit, thread, options }] of cases.entries()) expect(searchMessages(query, limit, thread, options)).toEqual(beforeAck[i]);
    expect(fts.length).toBe(count);
    expect(scanned).toBeGreaterThan(0);
    console.log(`search parity: ${queries.length} queries x 5 limits x 6 scopes/cursors x 2 skins = ${cases.length}, ready and pending ack`);
  }, 60_000);

  it("completes postings after a bounded ordered probe without duplicate or missing hits", async () => {
    const rows = [
      ...Array.from({ length: 140 }, (_, i) => msg(`old-${i}`, "", { at: i, kind: "activity", tool: { name: "z" } })),
      ...Array.from({ length: 4500 }, (_, i) => msg(`hidden-${i}`, "", { at: 200 + i, kind: "activity", tool: { name: "Bash", summary: "noop", detail: { input: "z" } } })),
      ...Array.from({ length: 5 }, (_, i) => msg(`new-${i}`, "", { at: 5000 + i, kind: "activity", tool: { name: "z" } })),
    ];
    replaceThread("probe", rows, "new-4");
    const baseline = [undefined, "probe"].map((thread) => searchMessages("z", 100, thread, { chips: true }));
    await ready();
    const sql: string[] = [];
    trace((_database, text) => { sql.push(text); });
    for (const [i, thread] of [undefined, "probe"].entries()) expect(searchMessages("z", 100, thread, { chips: true })).toEqual(baseline[i]);
    expect(sql.some((text) => text.includes("INDEXED BY search_docs_order"))).toBe(true);
    expect(sql.some((text) => text.includes("INDEXED BY search_docs_thread_order"))).toBe(true);
    expect(scanned).toBe(0);
    expect(fetched).toBe(200);
  });

  it("intersects at most sixteen necessary grams with the kind marker", async () => {
    const text = "abcdefghijklmnopqrstuvwxyz0123456789";
    insertMessage("one", msg("long", text));
    await ready();
    trace();
    expect(searchMessages(text).map((hit) => hit.messageId)).toEqual(["long"]);
    expect(fts.length).toBeGreaterThan(0);
    for (const match of fts) {
      expect(match.match(/"g[0-9a-f]+"/g)?.length).toBeLessThanOrEqual(16);
      expect(match).toMatch(/kindtext|kindactivity/);
    }
  });

  it("keeps scoped postings complete across interleaved document ids and an empty scope", async () => {
    for (let i = 0; i < 120; i++) {
      insertMessage("one", msg(`one-${i}`, "search", { at: Math.floor(i / 3) }));
      insertMessage("two", msg(`two-${i}`, "search", { at: 1000 + i }));
    }
    insertMessage("empty", msg("unsearchable", "", { kind: "note" }));
    const baseline = searchMessages("search", 100, "one", { before: "one-100" });
    await ready();
    trace();
    expect(searchMessages("search", 100, "one", { before: "one-100" })).toEqual(baseline);
    expect(searchMessages("search", 100, "empty")).toEqual([]);
    expect(fts.length).toBeGreaterThan(0);
    expect(scanned).toBe(0);
  });

  it("preserves ordered parity at the scan cutoff and on cursor-reduced scopes", async () => {
    const sizes = [scanRows - 1, scanRows, scanRows + 1];
    const cases = sizes.flatMap((n) => {
      const thread = `boundary-${n}`;
      replaceThread(thread, Array.from({ length: n }, (_, i) => msg(`${thread}-${i}`, "boundary 검사 100%", {
        at: Math.floor(i / 3), kind: i % 10 ? "note" : "text",
      })), `${thread}-${n - 1}`);
      return ["boundary", "검사", "%"].flatMap((needle) => [1, 12, 40, 41, 100].flatMap((limit) => [false, true].flatMap((chips) =>
        [undefined, `${thread}-${Math.floor(n / 2)}`, "missing"].map((before) => ({ thread, needle, limit, options: { chips, before } })))));
    });
    const baseline = cases.map(({ thread, needle, limit, options }) => searchMessages(needle, limit, thread, options));
    await ready(false);
    trace();
    for (const [i, { thread, needle, limit, options }] of cases.entries()) expect(searchMessages(needle, limit, thread, options)).toEqual(baseline[i]);
    for (const n of sizes) {
      scanned = 0;
      fts = [];
      searchMessages("boundary", 40, `boundary-${n}`);
      expect(scanned).toBe(n < scanRows ? 1 : 0);
      expect(fts.length > 0).toBe(n >= scanRows);
    }
    insertMessage(`boundary-${scanRows}`, msg("pending-boundary", "boundary 검사 100%", { at: scanRows }));
    const pending = cases.map(({ thread, needle, limit, options }) => searchMessages(needle, limit, thread, options));
    const matched = fts.length;
    untrustSearchCache();
    for (const [i, { thread, needle, limit, options }] of cases.entries()) expect(searchMessages(needle, limit, thread, options)).toEqual(pending[i]);
    expect(fts.length).toBe(matched);
  }, 60_000);

  it.each(["", "  ", "\0", "a\0b", "\ud800", "\udfff"])("keeps the baseline for unsupported literal %j", async (query) => {
    insertMessage("one", msg("literal", `a${query}b`));
    const baseline = searchMessages(query);
    await ready();
    trace();
    expect(searchMessages(query)).toEqual(baseline);
    expect(fts).toEqual([]);
  });

  it.each(["untrusted", "pending", "unpublished", "format", "fingerprint", "missing", "fts", "corrupt", "closed"])("isolates an %s cache and preserves source writes", async (mode) => {
    insertMessage("one", msg("match", "search"));
    const baseline = searchMessages("search");
    await ready();
    if (mode === "untrusted") untrustSearchCache();
    else if (mode === "pending") updateMessage("one", msg("match", "search"));
    else if (mode === "missing") rmSync(join(DATA_DIR, "search-cache.db"));
    else if (mode === "corrupt") writeFileSync(join(DATA_DIR, "search-cache.db"), "broken cache");
    else if (mode !== "closed") {
      const cache = new DatabaseSync(join(DATA_DIR, "search-cache.db"));
      if (mode === "fts") cache.exec("DROP TABLE search_fts");
      else if (mode === "unpublished") cache.exec("UPDATE search_meta SET generation = 0, state = 'validate'");
      else if (mode === "format") cache.exec("UPDATE search_meta SET format = 999");
      else cache.exec("UPDATE search_meta SET fingerprint = 'old'");
      cache.close();
    }
    trace((database, sql) => { if (mode === "closed" && sql.startsWith("SELECT format, fingerprint")) database.close(); });
    expect(searchMessages("search")).toEqual(baseline);
    expect(scanned).toBe(1);
    expect(searchCacheState().trusted).toBe(false);
    insertMessage("one", msg("after", "search after failure", { at: 2 }));
    applySyncedRows("sync", [msg("synced", "search synced")]);
    expect(searchMessages("search")).toHaveLength(3);
    expect(messageDatabase().isOpen).toBe(true);
  });

  it("ignores an unacked generation and uncommitted source rows", async () => {
    insertMessage("one", msg("old", "search"));
    await ready();
    trace();
    withMessageTransaction(() => {
      insertMessage("one", msg("new", "search", { at: 2 }));
      expect(searchMessages("search").map((hit) => hit.messageId)).toEqual(["new", "old"]);
    });
    expect(fts).toEqual([]);
    expect(searchMessages("search").map((hit) => hit.messageId)).toEqual(["new", "old"]);
    expect(fts).toEqual([]);
  });

  it.each([false, true])("checks data_version before an indexed read with sync attribution %j", async (sync) => {
    insertMessage("one", msg("old", "search"));
    await ready();
    trace();
    const done = sync ? syncRequestStarted() : () => {};
    const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
    other.exec("CREATE TABLE sync_only (id INTEGER)");
    other.close();
    done();
    expect(searchMessages("search").map((hit) => hit.messageId)).toEqual(["old"]);
    expect(fts.length > 0).toBe(sync);
    expect(scanned).toBe(sync ? 0 : 1);
    expect(searchCacheState().trusted).toBe(sync);
  });

  it.each([false, true])("discards partial indexed hits after an unattributed mid-query write, limited %j", async (limited) => {
    insertMessage("one", msg("old", "search"));
    await ready();
    const source = messageDatabase();
    let written = false;
    trace(undefined, (database, sql, stmt) => {
      if (database === source && sql.startsWith("SELECT thread_id, id, at, role, kind")) {
        const get = stmt.get.bind(stmt);
        stmt.get = (...args) => {
          const row = Reflect.apply(get, stmt, args);
          if (!written) {
            written = true;
            const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
            other.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run("one", "new", 2, "user", "text", "search", JSON.stringify(msg("new", "search", { at: 2 })));
            other.close();
          }
          return row;
        };
      }
    });
    const hits = searchMessages("search", limited ? 1 : 40);
    expect(hits.map((hit) => hit.messageId)).toEqual(limited ? ["new"] : ["new", "old"]);
    expect(fts.length).toBeGreaterThan(0);
    expect(scanned).toBe(1);
    expect(searchCacheState().trusted).toBe(false);
  });

  it.each(["epoch", "generation", "cache", "sync"])("rechecks %s after collecting partial hits", async (mode) => {
    insertMessage("one", msg("old", "search"));
    insertMessage("one", msg("tool", "", { kind: "activity", tool: { name: "search" } }));
    const baseline = searchMessages("search");
    await ready();
    const source = messageDatabase();
    let changed = false;
    trace((database, sql) => {
      if (mode === "cache" && fetched && database !== source && sql.startsWith("SELECT count(*) AS n FROM ")) database.close();
    }, (database, sql, stmt) => {
      if (database !== source || !sql.startsWith("SELECT thread_id, id, at, role, kind")) return;
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => {
        const row = Reflect.apply(get, stmt, args);
        if (!changed) {
          changed = true;
          if (mode === "epoch") insertMessage("one", msg("new", "search", { at: 2 }));
          else if (mode === "generation") untrustSearchCache();
          else if (mode === "sync") {
            const done = syncRequestStarted();
            const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
            other.exec("CREATE TABLE sync_only (id INTEGER)");
            other.close();
            done();
          }
        }
        return row;
      };
    });
    const hits = searchMessages("search");
    if (mode === "epoch") expect(hits.map((hit) => hit.messageId)).toEqual(["new", "old", "tool"]);
    else expect(hits).toEqual(baseline);
    expect(fts.length).toBeGreaterThan(0);
    expect(scanned).toBe(mode === "sync" ? 0 : 1);
    expect(searchCacheState().trusted).toBe(mode === "sync");
  });

  it("owns a read-only cache handle and closes it after each query", async () => {
    insertMessage("one", msg("old", "search"));
    await ready();
    const handles: DatabaseSync[] = [];
    trace((database, sql) => {
      if (!sql.startsWith("SELECT format, fingerprint")) return;
      handles.push(database);
      expect(() => database.prepare("DELETE FROM search_docs").run()).toThrow(/readonly/);
    });
    expect(searchMessages("search")).toHaveLength(1);
    expect(searchMessages("search")).toHaveLength(1);
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => !handle.isOpen)).toBe(true);
    expect(messageDatabase().isOpen).toBe(true);
    expect(scanned).toBe(0);
  });
});
