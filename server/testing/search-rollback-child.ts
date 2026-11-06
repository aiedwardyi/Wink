// One process of the search cache rollback tests, run on a fixture data dir:
//   node --experimental-strip-types search-rollback-child.ts new|old <server dir>
// `new` serves searches the way the given build does and settles its cache; `old` writes messages.db.
//   CRASH  exits 91 at that point: a source one below, or a search worker crash point
//   OPS    comma list: `new` runs outside, inject, delete-open; `old` runs writes, outside, inject
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import dc from "node:diagnostics_channel";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";

process.on("uncaughtException", (error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(70);
});
process.stdout.on("error", () => {});

const [mode, server] = process.argv.slice(2);
const dataDir = process.env.OMB_DATA_DIR!;
const crash = process.env.CRASH ?? "";
const ops = (process.env.OPS ?? "").split(",").filter(Boolean);
const QUERIES = ["a", "is", "API", "error", "search", "Bash", "the result", "node:sqlite", "%", "qzxv_1105\\nohit", "검", "결", "검사", "결과", "검색", "요", "완료", "다음 단계", "결과:", "쀍쀍없는결과", "crash", "outside", "inject", "old"];
const msg = (id: string, text: string, at: number) => ({ id, role: "user", kind: "text", text, at, parentId: null });
const load = (file: string) => import(pathToFileURL(join(server, file)).href);
const legacy = join(dataDir, "messages-legacy.json");
const db = await load("message-db.ts");

if (mode === "old") {
  if (ops.includes("outside")) db.insertMessage("one", msg("outside", "search outside write", 5000));
  if (ops.includes("inject")) db.insertMessage("one", msg("inject", "search inject write", 7000));
  if (ops.includes("writes")) {
    const { Store } = await load("store.ts");
    const store = new Store(() => ({ instanceId: "old", model: "old" }));
    const bot = store.createBot({ name: "Old" }, { seedMessages: false });
    const task = store.createTask(bot.id, "Old task");
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: "search old append" });
    db.insertMessage("two", msg("two-1", "search old edit", 1));
    writeFileSync(legacy, JSON.stringify({ messages: [msg("legacy-1", "search old legacy", 7)], activeLeafId: "legacy-1" }));
    db.readThread("legacy", legacy);
    db.replaceThread("swap", [msg("swap-new", "search old replaced", 8)], "swap-new");
    db.deleteThread("gone");
    store.applySyncChanges(bot.id, task.threadId, [{ cursor: 1, kind: "row", rowId: "synced", value: msg("synced", "search old sync", 9), conflict: false }]);
  }
  db.closeMessageDb();
  process.exit(0);
}

// Builds before the search cache have neither module.
const optional = (file: string) => (existsSync(join(server, file)) ? load(file) : null);
const cache = await optional("search-cache.ts");
const gate = await optional("search-gate.ts");
const text = await optional("search-text.ts");
const source: DatabaseSync = db.messageDatabase();
const counts = { fts: 0, scans: 0 };
const writes: string[] = [];
let hook: ((sql: string, when: "prepare" | "before" | "after") => void) | null = null;
let onAccept: (() => void) | null = null;
const die = () => process.exit(91);
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|BEGIN|SAVEPOINT|VACUUM)/i;

const { prepare, exec } = DatabaseSync.prototype;
DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
  if (this === source && WRITE.test(sql)) writes.push(sql);
  if (this === source) hook?.(sql, "prepare");
  const stmt: StatementSync = prepare.call(this, sql);
  if (sql.includes("search_fts MATCH")) counts.fts++;
  if (this === source && sql.startsWith("SELECT rowid AS row FROM messages ")) {
    const iterate = stmt.iterate.bind(stmt);
    stmt.iterate = (...args) => (counts.scans++, Reflect.apply(iterate, stmt, args));
  }
  if (this === source && sql.startsWith("SELECT 1 FROM messages WHERE rowid")) {
    const get = stmt.get.bind(stmt);
    stmt.get = (...args) => (onAccept?.(), Reflect.apply(get, stmt, args));
  }
  return stmt;
};
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  if (this === source && WRITE.test(sql)) writes.push(sql);
  if (this === source) hook?.(sql, "before");
  exec.call(this, sql);
  if (this === source) hook?.(sql, "after");
};
dc.subscribe("worker_threads", (message) => (message as { worker: Worker }).worker.on("exit", (code) => code === 91 && die()));

function ask(queries = QUERIES) {
  counts.fts = counts.scans = 0;
  const hits = queries.flatMap((query) => [db.searchMessages(query, 1000), db.searchMessages(query, 1000, "one")]);
  const ids = [...new Set(hits.flat().map((hit: { messageId: string }) => hit.messageId))].sort();
  return { searches: queries.length * 2, fts: counts.fts, scans: counts.scans, hash: createHash("sha256").update(JSON.stringify(hits)).digest("hex"), ids };
}

/** What a search request does: (re)start the cache, until it is trusted. */
async function settle() {
  if (!cache || !gate) return null;
  for (let i = 0; i < 6000; i++) {
    cache.startSearchCache(dataDir, crash || undefined);
    if (gate.searchCacheState().trusted) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** Whether the settled cache holds exactly what a rebuild from messages.db would. */
function exact() {
  const file = join(dataDir, "search-cache.db");
  if (!text || !existsSync(file)) return null;
  const key = (row: Record<string, unknown>) => [row.thread_id, row.id, row.source_rowid ?? row.rowid, row.at].join("|");
  const want = source.prepare("SELECT rowid, thread_id, id, at, kind, text, json FROM messages").all()
    .filter((row) => ["text", "activity"].includes(String(row.kind)) && text.messageSearchGrams({ ...JSON.parse(String(row.json)), kind: row.kind, text: row.text }).length)
    .map(key).sort();
  const peek = new DatabaseSync(file, { readOnly: true });
  const have = peek.prepare("SELECT thread_id, id, source_rowid, at FROM search_docs").all().map(key).sort();
  peek.close();
  return { docs: have.length, equal: JSON.stringify(have) === JSON.stringify(want) };
}

const old = (op: string) => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "old", server], {
    encoding: "utf8", env: { ...process.env, OPS: op, CRASH: "" },
  });
  if (result.status !== 0) throw new Error(`old writer failed: ${result.stderr}`);
};

// A process ending at each point of a write while its cache is trusted.
const sourceCrash: Record<string, () => void> = {
  "before-source-commit": () => {
    hook = (sql, when) => when === "before" && sql === "COMMIT" && die();
    db.appendMessage("one", msg("crash-row", "crash before commit", 6000));
  },
  // the chat-sync writer wraps a local append in its own transaction
  "after-source-commit": () => {
    hook = (sql, when) => when === "after" && sql === "COMMIT" && die();
    db.withMessageTransaction(() => db.appendMessage("one", msg("crash-row", "crash after commit", 6000)));
  },
  "between-delete": () => {
    hook = (sql) => sql.startsWith("DELETE FROM thread_state") && die();
    db.deleteThread("gone");
  },
  "inside-import": () => {
    writeFileSync(legacy, JSON.stringify({ messages: [msg("legacy-1", "crash inside import", 7)], activeLeafId: "legacy-1" }));
    hook = (sql) => sql.startsWith("INSERT INTO thread_state") && source.isTransaction && die();
    db.readThread("legacy", legacy);
  },
};

const OPS: Record<string, () => Promise<unknown>> = {
  // another build writes while this one is trusted and chat sync is idle
  outside: async () => {
    const before = gate?.searchCacheState().trusted ?? null;
    old("outside");
    const answer = ask();
    const after = gate?.searchCacheState();
    return { before, answer, after: after && { trusted: after.trusted, full: after.full }, recaught: await settle(), again: ask() };
  },
  // the same write lands between one query's cache read and its check
  inject: async () => {
    let fired = false;
    onAccept = () => {
      if (!fired) old("inject");
      fired = true;
    };
    const during = ask(["search"]);
    onAccept = null;
    return { fired, during, baseline: ask(["search"]) };
  },
  "delete-open": async () => {
    let removed = true;
    try {
      rmSync(join(dataDir, "search-cache.db"));
    } catch (error) {
      // Windows refuses to delete a file SQLite holds open; a build without the cache has none
      if (!["EPERM", "EBUSY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      removed = false;
    }
    return { removed, answer: ask(), trusted: gate?.searchCacheState().trusted ?? null };
  },
};

const out: Record<string, unknown> = { start: gate ? gate.searchCacheState().trusted : null, first: ask() };
out.trusted = await settle();
if (crash === "after-ack") die();
if (sourceCrash[crash]) {
  sourceCrash[crash]();
  throw new Error(`crash point ${crash} not reached`);
}
out.second = ask();
out.exact = exact();
for (const op of ops) out[op] = await OPS[op]();
out.writes = writes;
await cache?.stopSearchCache();
db.closeMessageDb();
console.log(JSON.stringify(out));
process.exit(0);
