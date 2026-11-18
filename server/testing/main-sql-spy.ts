// Loaded with --import by boot-reads.test.ts: logs every statement the main thread runs, with its caller, rows and query plan.
import fs, { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";

const file = process.env.WINK_SQL_SPY;
if (isMainThread && file) {
  const prepare = DatabaseSync.prototype.prepare;
  const owners = new WeakMap<StatementSync, DatabaseSync>();
  const planned = new Set<string>();
  let inside = false;
  // boot-reads.test.ts waits on these ticks: a log that reaches the window's end proves the server lived through it
  setInterval(() => appendFileSync(file, `${JSON.stringify({ t: Date.now(), tick: true })}\n`), 1000).unref();
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    owners.set(statement, this);
    return statement;
  };
  const callers = () => (new Error().stack ?? "").split("\n").slice(1)
    .map((line) => /[\\/]server[\\/]([^\s)]+?):(\d+):\d+/.exec(line))
    .flatMap((hit) => hit && !hit[1]!.startsWith("testing") ? [`${hit[1]}:${hit[2]}`] : []);
  const record = (statement: StatementSync, params: unknown[], start: number, rows: number | undefined) => {
    const sql = statement.sourceSQL;
    if (!/\bmessages\b(?!_)/.test(sql)) return;
    const sites = callers();
    const line: { t: number; ms: number; sql: string; params: string[]; rows?: number; at: string | null; via: string[]; plan?: string[] } = { t: start, ms: Date.now() - start, sql, params: params.map((value) => String(value).slice(0, 80)), rows, at: sites[0] ?? null, via: sites.slice(1, 6) };
    if (!planned.has(sql)) {
      planned.add(sql);
      try {
        // SAFETY: params are the values the caller just bound to this same statement.
        line.plan = prepare.call(owners.get(statement)!, `EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])).map((row) => String(row.detail));
      } catch {}
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  };
  for (const method of ["all", "get", "run", "iterate"] as const) {
    // SAFETY: each wrapped method takes bound parameters and returns what the original returns.
    const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
    // SAFETY: the replacement forwards to the original with the same receiver and arguments.
    (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...params: unknown[]) {
      if (inside) return original.apply(this, params);
      const start = Date.now();
      let result: unknown;
      try {
        return result = original.apply(this, params);
      } finally {
        inside = true;
        try { record(this, params, start, Array.isArray(result) ? result.length : undefined); } finally { inside = false; }
      }
    };
  }
  // sync reads of the profile sync folder (WINK_SQL_SPY_FS) block the thread that serves the app
  const folder = process.env.WINK_SQL_SPY_FS;
  if (folder) {
    for (const method of ["readFileSync", "readdirSync"] as const) {
      // SAFETY: each wrapped fs method takes a path first and returns what the original returns.
      const original = fs[method] as (...args: unknown[]) => unknown;
      (fs as unknown as Record<string, unknown>)[method] = function (...args: unknown[]) {
        const path = String(args[0]);
        if (path.startsWith(folder)) appendFileSync(file, `${JSON.stringify({ t: Date.now(), fs: method, path, at: callers()[0] ?? null, via: callers().slice(1, 6) })}\n`);
        return original.apply(fs, args);
      };
    }
    syncBuiltinESMExports();
  }
}
