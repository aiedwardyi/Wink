// Loaded with --import by boot-reads.test.ts: logs every statement the main thread runs, with its caller and query plan.
import { appendFileSync } from "node:fs";
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
  const record = (statement: StatementSync, params: unknown[], start: number) => {
    const sql = statement.sourceSQL;
    if (!/\bmessages\b(?!_)/.test(sql)) return;
    const sites = callers();
    const line: { t: number; ms: number; sql: string; params: string[]; at: string | null; via: string[]; plan?: string[] } = { t: start, ms: Date.now() - start, sql, params: params.map((value) => String(value).slice(0, 80)), at: sites[0] ?? null, via: sites.slice(1, 6) };
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
      try {
        return original.apply(this, params);
      } finally {
        inside = true;
        try { record(this, params, start); } finally { inside = false; }
      }
    };
  }
}
