import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { ackSearchCache, searchCacheState, untrustSearchCache, type SearchCacheState } from "./search-gate.ts";
import { messageSearchGrams } from "./search-text.ts";
import type { Message } from "./store.ts";

// PC-local beside messages.db; never a profile, memory or thread sync file.
export const SEARCH_CACHE_FILE = "search-cache.db";
const FORMAT = 1;
const PAGE_ROWS = 256;
const PAGE_BYTES = 4 * 1024 * 1024;
const FTS = "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(grams, content='', contentless_delete=1, detail=none, tokenize='ascii')";
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS search_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    format INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    generation INTEGER NOT NULL,
    cursor INTEGER NOT NULL,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS search_docs (
    docid INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source_rowid INTEGER NOT NULL,
    at INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    source_hash BLOB,
    UNIQUE(thread_id, id)
  );
  CREATE INDEX IF NOT EXISTS search_docs_order ON search_docs(priority, at DESC, source_rowid DESC);
  CREATE INDEX IF NOT EXISTS search_docs_thread_order ON search_docs(thread_id, at DESC, source_rowid DESC);
  ${FTS};
`;

type SearchRow = Parameters<typeof messageSearchGrams>[0];
const comm: Message["comm"] = { groupId: "pair", withBotId: "helper", withName: "Helper", withColor: "blue", peer: "reply" };
// Projection and redaction output over these rows keys the cache, so a code change rebuilds it.
const FINGERPRINT_ROWS: SearchRow[] = [
  { kind: "text", text: "Mixed CASE 검사 🧠 e\u0301 100% _ \\ \" '" },
  { kind: "text", text: "summarized", summarized: true },
  { kind: "note", text: "never indexed" },
  { kind: "activity", tool: { name: "Bash", summary: "run tests", detail: { input: "npm test", output: ["PASSWORD=PreviewCanary987654321", "\u001b[32mok\u001b[0m", "two", "three", "four"] } } },
  { kind: "activity", tool: { name: "app.ts", verb: "Edit", summary: "updated", detail: { input: "path.ts", diff: ["-old", "+new", "context"] } } },
  { kind: "activity", tool: { name: "Read", summary: "summary", detail: { input: "extra input", diff: ["+line"], more: 2 } } },
  { kind: "activity", tool: { name: "Edit", ok: false, detail: { input: "app.ts", diff: ["+never drawn"] } } },
  { kind: "activity", tool: { name: "Read", detail: { input: "C:\\work\\.ssh\\config", output: ["PrivateCanary987654321"] } } },
  { kind: "activity", tool: { name: "Read", summary: "notes", detail: { input: "notes.txt", outputHidden: true, output: ["hidden"] } } },
  { kind: "activity", tool: { name: "Bash", detail: { input: "x".repeat(150), output: ["y".repeat(100)] } } },
  { kind: "activity", tool: { name: "Reply from @Helper" }, comm, text: "검사 결과" },
];

export function searchCacheFingerprint(): string {
  return createHash("sha256").update(JSON.stringify(FINGERPRINT_ROWS.map((row) => messageSearchGrams(row)))).digest("hex");
}

/** The exact cache FTS table, in memory, before any cache file exists. */
export function probeSearchFts(): boolean {
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec(FTS);
    probe.prepare("INSERT INTO search_fts (rowid, grams) VALUES (1, 'g000061 kindtext'), (2, 'g000062 kindtext')").run();
    probe.prepare("DELETE FROM search_fts WHERE rowid = 1").run();
    const rows = probe.prepare("SELECT rowid FROM search_fts WHERE search_fts MATCH '\"kindtext\"'").all();
    return rows.length === 1 && rows[0].rowid === 2;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

export function removeSearchCache(dataDir: string): void {
  for (const file of [SEARCH_CACHE_FILE, `${SEARCH_CACHE_FILE}-wal`, `${SEARCH_CACHE_FILE}-shm`]) rmSync(join(dataDir, file), { force: true });
}

/** A different format or projection fingerprint deletes the old file and starts over. */
export function openSearchCache(dataDir: string): DatabaseSync {
  const file = join(dataDir, SEARCH_CACHE_FILE);
  const fingerprint = searchCacheFingerprint();
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const cache = new DatabaseSync(file);
  try {
    cache.exec("PRAGMA journal_mode = WAL");
    cache.exec("PRAGMA synchronous = NORMAL");
    const meta = cache.prepare("SELECT name FROM sqlite_master WHERE name = 'search_meta'").get()
      ? cache.prepare("SELECT format, fingerprint FROM search_meta").get()
      : undefined;
    if (meta && (meta.format !== FORMAT || meta.fingerprint !== fingerprint)) {
      cache.close();
      removeSearchCache(dataDir);
      return openSearchCache(dataDir);
    }
    cache.exec(SCHEMA);
    cache.prepare("INSERT OR IGNORE INTO search_meta VALUES (1, ?, ?, 0, 0, 'build')").run(FORMAT, fingerprint);
    return cache;
  } catch (error) {
    if (cache.isOpen) cache.close();
    throw error;
  }
}

/** The worker's only messages.db connection. */
export function openSearchSource(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
}

export type SearchCrash = "mid-page" | "before-commit" | "validating" | "after-commit";
export type SearchWork = Pick<SearchCacheState, "full" | "threads" | "keys">;

interface SourceRow {
  row: number;
  thread_id: string;
  id: string;
  at: number;
  kind: string;
  text: string | null;
  json: string | null;
}

interface Doc {
  docid: number;
  source_rowid: number;
  at: number;
  source_hash: Uint8Array;
}

const SOURCE_COLUMNS = "rowid AS row, thread_id, id, at, kind, text, CASE WHEN kind IN ('text', 'activity') THEN json END AS json";
const digest = (row: SourceRow) => createHash("sha256").update(JSON.stringify([row.kind, row.text, row.json])).digest();
/** SQLITE_CORRUPT or SQLITE_NOTADB. */
export const corruption = (error: unknown) => [11, 26].includes(Number((error as { errcode?: number } | null)?.errcode) & 0xff);
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function grams(row: SourceRow): string[] {
  if (row.json === null) return [];
  // SAFETY: Stored rows use the Message envelope; the columns are what search's SQL reads.
  const message = JSON.parse(row.json) as Message;
  return messageSearchGrams({ ...message, kind: row.kind as Message["kind"], text: row.text });
}

/** Builds and validates the cache from messages.db. Reads are one short statement or transaction per page. */
export function createSearchIndexer(dataDir: string, crash?: SearchCrash) {
  const cache = openSearchCache(dataDir);
  // open only while working, so an idle worker never holds messages.db
  let source: DatabaseSync;
  let stopping = false;
  const crashAt = (point: SearchCrash) => {
    if (crash === point) process.exit(91);
  };
  const prepare = (sql: string) => {
    try {
      return cache.prepare(sql);
    } catch (error) {
      cache.close();
      throw error;
    }
  };
  const findDoc = prepare("SELECT docid, source_rowid, at, source_hash FROM search_docs WHERE thread_id = ? AND id = ?");
  const insertDoc = prepare("INSERT INTO search_docs (thread_id, id, source_rowid, at, priority, source_hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING docid");
  const updateDoc = prepare("UPDATE search_docs SET source_rowid = ?, at = ?, priority = ?, source_hash = ? WHERE docid = ?");
  const moveDoc = prepare("UPDATE search_docs SET source_rowid = ?, at = ? WHERE docid = ?");
  const deleteDoc = prepare("DELETE FROM search_docs WHERE docid = ?");
  const insertFts = prepare("INSERT INTO search_fts (rowid, grams) VALUES (?, ?)");
  const deleteFts = prepare("DELETE FROM search_fts WHERE rowid = ?");
  const setCursor = prepare("UPDATE search_meta SET cursor = ?, state = ?");
  const published = prepare("UPDATE search_meta SET generation = generation + 1, cursor = 0, state = 'current'");

  // Leaving the loop early resets the statement, which ends its read.
  function capped(rows: Iterable<unknown>): SourceRow[] {
    const kept: SourceRow[] = [];
    let bytes = 0;
    // SAFETY: Each source statement selects SOURCE_COLUMNS.
    for (const row of rows as Iterable<SourceRow>) {
      kept.push(row);
      bytes += (row.json?.length ?? 0) + (row.text?.length ?? 0);
      if (bytes >= PAGE_BYTES) break;
    }
    return kept;
  }

  function write(work: () => void, crashPage = false): void {
    cache.exec("BEGIN IMMEDIATE");
    try {
      work();
      if (crashPage) crashAt("before-commit");
      cache.exec("COMMIT");
    } catch (error) {
      if (cache.isTransaction) cache.exec("ROLLBACK");
      throw error;
    }
  }

  function removeDoc(docid: number): void {
    deleteFts.run(docid);
    deleteDoc.run(docid);
  }

  /** Reconciles current source rows. An unchanged hash only refreshes rowid and time, which order and page results. */
  function apply(rows: SourceRow[], seen: Set<number>, meta?: { cursor: number; state: string }, crashPage = false): void {
    const plans = rows.map((row) => {
      // SAFETY: This SELECT list is docid, source_rowid, at, source_hash.
      const doc = findDoc.get(row.thread_id, row.id) as Doc | undefined;
      const hash = digest(row);
      return { row, doc, hash, grams: doc && hash.equals(doc.source_hash) ? null : grams(row) };
    });
    write(() => {
      plans.forEach(({ row, doc, hash, grams }, at) => {
        if (crashPage && at === plans.length >> 1) crashAt("mid-page");
        if (!grams) {
          if (doc!.source_rowid !== row.row || doc!.at !== row.at) moveDoc.run(row.row, row.at, doc!.docid);
          seen.add(doc!.docid);
          return;
        }
        if (doc) deleteFts.run(doc.docid);
        if (!grams.length) {
          if (doc) deleteDoc.run(doc.docid);
          return;
        }
        const priority = row.kind === "text" ? 0 : 1;
        let docid = doc?.docid;
        if (docid === undefined) docid = Number(insertDoc.get(row.thread_id, row.id, row.row, row.at, priority, hash)!.docid);
        else updateDoc.run(row.row, row.at, priority, hash, docid);
        insertFts.run(docid, grams.join(" "));
        seen.add(docid);
      });
      if (meta) setCursor.run(meta.cursor, meta.state);
    }, crashPage);
  }

  function sweep(docids: Iterable<number>, seen: Set<number>, last?: () => void): void {
    let batch: number[] = [];
    const flush = (final: boolean) => {
      if (!batch.length && !(final && last)) return;
      const done = batch;
      batch = [];
      write(() => {
        for (const docid of done) removeDoc(docid);
        if (final) last?.();
      });
    };
    for (const docid of [...docids]) {
      if (seen.has(docid)) continue;
      batch.push(docid);
      if (batch.length >= PAGE_ROWS) flush(false);
    }
    flush(true);
  }

  // The stored cursor only picks where the pass starts; it still wraps to cover every row.
  async function fullPass(): Promise<boolean> {
    // SAFETY: search_meta has one row with these columns.
    const hint = cache.prepare("SELECT cursor, state FROM search_meta").get() as { cursor: number; state: string };
    const state = hint.state === "build" ? "build" : "validate";
    const start = hint.state === "current" ? 0 : hint.cursor;
    const ranges = start > 0 ? [[start, Number.MAX_SAFE_INTEGER], [Number.MIN_SAFE_INTEGER, start]] : [[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]];
    const seen = new Set<number>();
    let pages = 0;
    const page = source.prepare(`SELECT ${SOURCE_COLUMNS} FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ${PAGE_ROWS}`);
    for (const [from, through] of ranges) {
      for (let after = from; ;) {
        if (stopping) return false;
        const rows = capped(page.iterate(after, through));
        if (!rows.length) break;
        after = rows.at(-1)!.row;
        apply(rows, seen, { cursor: after, state }, pages === 1);
        if (pages++ === 0 && state === "validate") crashAt("validating");
        await yieldTurn();
      }
    }
    if (stopping) return false;
    // SAFETY: This SELECT list is docid.
    const docids = (cache.prepare("SELECT docid FROM search_docs").all() as Array<{ docid: number }>).map(({ docid }) => docid);
    sweep(docids, seen, () => published.run());
    crashAt("after-commit");
    return true;
  }

  function readTransaction<T>(read: () => T): T {
    source.exec("BEGIN");
    try {
      return read();
    } finally {
      source.exec("COMMIT");
    }
  }

  async function dirtPass({ threads, keys }: SearchWork): Promise<boolean> {
    const threadPage = source.prepare(`SELECT ${SOURCE_COLUMNS} FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid LIMIT ${PAGE_ROWS}`);
    const byKey = source.prepare(`SELECT ${SOURCE_COLUMNS} FROM messages WHERE thread_id = ? AND id = ?`);
    for (const threadId of threads) {
      const seen = new Set<number>();
      for (let after = 0; ;) {
        if (stopping) return false;
        const rows = capped(threadPage.iterate(threadId, after));
        if (!rows.length) break;
        after = rows.at(-1)!.row;
        apply(rows, seen);
        await yieldTurn();
      }
      // SAFETY: This SELECT list is docid.
      sweep((cache.prepare("SELECT docid FROM search_docs WHERE thread_id = ?").all(threadId) as Array<{ docid: number }>).map(({ docid }) => docid), seen);
    }
    const pending = [...keys].filter(([threadId]) => !threads.has(threadId)).flatMap(([threadId, ids]) => [...ids].map((id) => [threadId, id] as const));
    for (let at = 0; at < pending.length; at += PAGE_ROWS) {
      if (stopping) return false;
      const chunk = pending.slice(at, at + PAGE_ROWS);
      // SAFETY: This statement selects SOURCE_COLUMNS.
      const rows = readTransaction(() => chunk.map(([threadId, id]) => byKey.get(threadId, id) as SourceRow | undefined));
      // SAFETY: This SELECT list is docid, source_rowid, at, source_hash.
      const gone = chunk.filter((_, index) => !rows[index]).map(([threadId, id]) => findDoc.get(threadId, id) as Doc | undefined);
      apply(rows.filter((row) => row !== undefined), new Set());
      write(() => {
        for (const doc of gone) if (doc) removeDoc(doc.docid);
      });
      await yieldTurn();
    }
    return true;
  }

  return {
    /** False when stopped before the work finished. */
    async work(work: SearchWork): Promise<boolean> {
      source = openSearchSource(dataDir);
      let done: boolean;
      try {
        done = await (work.full ? fullPass() : dirtPass(work));
      } finally {
        source.close();
      }
      if (done && !existsSync(join(dataDir, SEARCH_CACHE_FILE))) throw new SearchCacheGone();
      return done;
    },
    stop(): void {
      stopping = true;
    },
    close(): void {
      if (cache.isOpen) cache.close();
    },
    /** True only when the cache file itself is damaged, never for messages.db. */
    corrupt(error: unknown): boolean {
      if (!corruption(error)) return false;
      try {
        return cache.prepare("PRAGMA quick_check").get()?.quick_check !== "ok";
      } catch {
        return true;
      }
    },
  };
}

export class SearchCacheGone extends Error {
  constructor() {
    super("search cache file removed");
  }
}

export type SearchWorkerMessage =
  | { type: "ready" }
  | { type: "done"; epoch: number; generation: number }
  | { type: "failed"; reason: "fts" | "corrupt" | "gone" | "error" };

let worker: Worker | null = null;
let exited = Promise.resolve();
let working = false;
let off = false;
let rebuilt = false;

function nextWork(): void {
  if (!worker || working) return;
  const { trusted, ...state } = searchCacheState();
  if (trusted) return;
  working = true;
  worker.postMessage({ type: "work", ...state });
}

function fail(current: Worker, reason: string): void {
  if (worker !== current) return;
  worker = null;
  working = false;
  untrustSearchCache();
  // a corrupt file was deleted; the next search rebuilds it once
  if (reason === "corrupt" && !rebuilt) rebuilt = true;
  else off = true;
  console.log(`search cache: off (${reason})`);
}

/** Idempotent; also hands the worker any dirt since its last ack. Never awaited by a request. */
export function startSearchCache(dataDir: string, crash?: SearchCrash): void {
  if (off) return;
  if (worker) return nextWork();
  const source = new URL("./search-worker.ts", import.meta.url);
  const entry = existsSync(source) ? source : new URL("./search-worker.js", import.meta.url);
  const current = new Worker(entry, {
    workerData: { dataDir, crash },
    execArgv: entry.pathname.endsWith(".ts") ? ["--experimental-strip-types"] : [],
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 },
  });
  worker = current;
  working = true;
  current.on("message", (message: SearchWorkerMessage) => {
    if (worker !== current) return;
    if (message.type === "failed") return fail(current, message.reason);
    working = false;
    if (message.type === "done") ackSearchCache(message.epoch, message.generation);
    nextWork();
  });
  current.on("error", () => fail(current, "error"));
  exited = new Promise((resolve) => current.on("exit", () => {
    fail(current, "exit");
    resolve();
  }));
  current.unref();
}

/** Resolves once the worker has closed its databases and exited. */
export function stopSearchCache(): Promise<void> {
  const current = worker;
  worker = null;
  working = false;
  current?.ref();
  current?.postMessage({ type: "stop" });
  return exited;
}
