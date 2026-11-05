import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";

import { SEARCH_CACHE_FILE, searchCacheFingerprint } from "./search-cache.ts";
import { searchCacheState, untrustSearchCache } from "./search-gate.ts";
import { needleGrams } from "./search-text.ts";

type Rows = Iterable<Record<string, SQLOutputValue>>;
const FINGERPRINT = searchCacheFingerprint();
export const SEARCH_SCAN_ROWS = 20000;
const routes = new WeakMap<DatabaseSync, { epoch: number; generation: number; scopes: Map<string, boolean> }>();

function* candidates(cache: DatabaseSync, source: DatabaseSync, match: string, limit: number, ordered: StatementSync, args: SQLInputValue[]): Rows {
  const scoped = args.length > 2;
  const scope = scoped ? " AND d.thread_id = ?2" : "";
  const cursor = args.length > 3 ? " AND (d.at < ?3 OR (d.at = ?3 AND d.source_rowid < ?4))" : "";
  const order = scoped ? "d.at DESC, d.source_rowid DESC" : "d.priority, d.at DESC, d.source_rowid DESC";
  const postings = cache.prepare(
    "SELECT d.source_rowid AS row FROM search_fts CROSS JOIN search_docs d ON d.docid = search_fts.rowid " +
      `WHERE search_fts MATCH ?1${scope}${cursor} ORDER BY ${order}`,
  );
  const sql = ordered.sourceSQL;
  const predicate = sql.slice(sql.indexOf(" WHERE ") + 7, sql.lastIndexOf(" ORDER BY "));
  const accept = source.prepare(`SELECT 1 FROM messages WHERE rowid = ?${args.length + 1} AND (${predicate})`);
  const membership = cache.prepare("SELECT 1 FROM search_fts WHERE search_fts MATCH ?1 AND rowid = ?2");
  const checked = new Set<SQLOutputValue>();
  const phases = scoped ? [`${match} AND (kindtext OR kindactivity)`] : [`${match} AND kindtext`, `${match} AND kindactivity`];
  for (const [priority, phase] of phases.entries()) {
    const count = Number(cache.prepare("SELECT count(*) AS n FROM (SELECT rowid FROM search_fts WHERE search_fts MATCH ? LIMIT 4096)").get(phase)!.n);
    if (!count) continue;
    if (count >= 4096 && limit <= 101) {
      const total = Number(cache.prepare("SELECT max(docid) AS n FROM search_docs").get()!.n);
      const budget = Math.min(8192, Math.max(512, Math.ceil(total * Math.max(1, limit) * 2 / count)));
      const index = scoped ? "search_docs_thread_order" : "search_docs_order";
      const rank = scoped ? "" : ` AND d.priority = ${priority}`;
      const probe = cache.prepare(`SELECT d.source_rowid AS row, d.docid FROM search_docs d INDEXED BY ${index} ` +
        `WHERE 1=1${scope}${cursor}${rank} ORDER BY ${order} LIMIT ${budget}`);
      for (const row of probe.iterate(...(scoped ? [null, ...args.slice(2)] : []))) {
        if (!membership.get(phase, row.docid)) continue;
        checked.add(row.row);
        if (accept.get(...args, row.row)) yield row;
      }
    }
    for (const row of postings.iterate(phase, ...args.slice(2))) {
      if (checked.has(row.row)) continue;
      checked.add(row.row);
      if (accept.get(...args, row.row)) yield row;
    }
  }
}

export function querySearchCache<T>(
  source: DatabaseSync,
  dataDir: string,
  needle: string,
  limit: number,
  ordered: StatementSync,
  args: SQLInputValue[],
  collect: (rows: Rows) => T,
): T | undefined {
  if (source.isTransaction || needle.includes("\0") || /[\ud800-\udfff]/u.test(needle)) return;
  const grams = needleGrams(needle);
  if (!grams.length) return;
  const file = join(dataDir, SEARCH_CACHE_FILE);
  if (!routes.has(source) && !existsSync(file)) {
    untrustSearchCache();
    return;
  }
  let cache: DatabaseSync | undefined;
  try {
    const state = searchCacheState();
    if (!state.trusted) return;
    let route = routes.get(source);
    if (!route || route.epoch !== state.epoch || route.generation !== state.generation) {
      route = { epoch: state.epoch, generation: state.generation, scopes: new Map() };
      routes.set(source, route);
    }
    const key = JSON.stringify(args.slice(2));
    let large = route.scopes.get(key);
    if (large === undefined) {
      const scope = args.length > 2 ? ` WHERE thread_id = ?1${args.length > 3 ? " AND (at < ?2 OR (at = ?2 AND rowid < ?3))" : ""}` : "";
      large = Boolean(source.prepare(`SELECT 1 FROM messages${scope} LIMIT 1 OFFSET ${SEARCH_SCAN_ROWS - 1}`).get(...args.slice(2)));
      route.scopes.set(key, large);
    }
    if (!large) return;
    if (!existsSync(file)) {
      untrustSearchCache();
      return;
    }
    cache = new DatabaseSync(file, { readOnly: true });
    const meta = cache.prepare("SELECT format, fingerprint, generation, state FROM search_meta WHERE id = 1").get();
    if (!meta || meta.format !== 1 || meta.fingerprint !== FINGERPRINT || Number(meta.generation) < 1 || meta.state !== "current") {
      untrustSearchCache();
      return;
    }
    const necessary = grams.length <= 16 ? grams : Array.from({ length: 16 }, (_, i) => grams[Math.floor(i * (grams.length - 1) / 15)]);
    const match = necessary.map((gram) => `"${gram}"`).join(" AND ");
    const result = collect(candidates(cache, source, match, limit, ordered, args));
    cache.close();
    cache = undefined;
    const after = searchCacheState();
    if (after.trusted && after.epoch === state.epoch && after.generation === state.generation) return result;
  } catch {
    untrustSearchCache();
  } finally {
    try { cache?.close(); } catch {}
  }
}
