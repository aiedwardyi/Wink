import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { applySyncedRows, closeMessageDb, messageDatabase, replaceThread, withMessageTransaction } from "./message-db.ts";
import type { Message } from "./store.ts";

const SERVER = fileURLToPath(new URL(".", import.meta.url));
const SOURCE = join(DATA_DIR, "messages.db");
const CACHE = join(DATA_DIR, "search-cache.db");
const literals = "a is API error search Bash the result node:sqlite 100% _ \\ \" ' 검사 결과 검색 요 완료 다음 단계 결과: 🧠 é É İ Σ";
const msg = (id: string, text = id, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: 1, parentId: null, ...extra });
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
let pristine: string;

interface Answer {
  searches: number;
  fts: number;
  scans: number;
  hash: string;
  ids: string[];
}

interface Out {
  start: boolean | null;
  first: Answer;
  trusted: boolean | null;
  second: Answer;
  exact: { docs: number; equal: boolean } | null;
  writes: string[];
  [op: string]: unknown;
}

function run(mode: "new" | "old", env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(SERVER, "testing", "search-rollback-child.ts"), mode, SERVER], {
    encoding: "utf8", timeout: 120_000, env: { ...process.env, OMB_DATA_DIR: DATA_DIR, CRASH: "", OPS: "", ...env },
  });
  // SAFETY: The child's last stdout line is its JSON report.
  const out = result.status === 0 && mode === "new" ? JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Out : null;
  return { status: result.status, stderr: result.stderr, out };
}

function build() {
  const result = run("new");
  expect(result.status, result.stderr).toBe(0);
  expect(result.out!.trusted).toBe(true);
}

/** Read on a connection of the test's own, which also folds in a crashed writer's WAL. */
function read<T>(work: (database: DatabaseSync) => T, file = SOURCE): T {
  const database = new DatabaseSync(file);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

const shape = () => read((database) => ({
  master: hash(database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()),
  rows: hash(database.prepare("SELECT rowid, * FROM messages ORDER BY rowid").all()),
}));
const count = (where: string, table = "messages") => Number(read((database) => database.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get()!.n));
const stamp = (file: string) => (existsSync(file) ? { hash: hash(readFileSync(file).toString("base64")), mtime: statSync(file).mtimeMs } : null);

function recovered(result: ReturnType<typeof run>): Out {
  expect(result.status, result.stderr).toBe(0);
  const out = result.out!;
  expect(out.first, "the first answers come from the scan").toMatchObject({ fts: 0, scans: out.first.searches });
  expect(out.start, "a new process starts untrusted").toBe(false);
  expect(out.trusted, "and trusts the cache once it is validated").toBe(true);
  expect(out.second, "then answers the same from the cache").toMatchObject({ scans: 0, hash: out.first.hash });
  expect(out.second.fts).toBeGreaterThan(0);
  expect(out.exact, "with no lost or extra document").toMatchObject({ equal: true });
  expect(out.writes).toEqual([]);
  return out;
}

function edit(sql: string) {
  read((cache) => cache.exec(sql), CACHE);
}

beforeAll(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  for (const thread of ["one", "two"]) {
    const rows = Array.from({ length: 140 }, (_, i) => msg(`${thread}-${i}`, `${literals} ${i}`, {
      at: Math.floor(i / 4), role: i % 2 ? "bot" : "user", from: { name: "Helper", botId: "helper", color: "blue" },
      ...(i % 3 === 0 ? { kind: "activity" as const, text: "", tool: { name: "Bash", summary: `search summary ${i}`, detail: { input: literals, output: [literals, "tail"] } } } : {}),
      ...(i % 17 === 0 ? { summarized: true } : {}),
      ...(i % 19 === 0 ? { kind: "note" as const } : {}),
    }));
    rows.push(msg(`${thread}-comm`, literals, { at: 9, kind: "activity", tool: { name: "Reply from @Helper" }, comm: { groupId: "room", withBotId: "helper", withName: "Helper", withColor: "blue", peer: "reply" } }));
    replaceThread(thread, rows, `${thread}-139`);
  }
  replaceThread("swap", [msg("swap-1", "search swap", { at: 3 })], "swap-1");
  replaceThread("gone", [msg("gone-1", "search gone", { at: 4 })], "gone-1");
  applySyncedRows("noise", Array.from({ length: 300 }, (_, i) => msg(`noise-${i}`, "irrelevant newer row", { at: 1000 + i })));
  // past the row count below which search keeps its scan
  const insert = messageDatabase().prepare("INSERT INTO messages VALUES ('one', ?, -1, 'user', 'note', '', ?)");
  withMessageTransaction(() => {
    for (let i = 0; i < 20000; i++) insert.run(`padding-${i}`, JSON.stringify(msg(`padding-${i}`, "", { at: -1, kind: "note" })));
  });
  closeMessageDb();
  pristine = mkdtempSync(join(tmpdir(), "search-rollback-"));
  copyFileSync(SOURCE, join(pristine, "messages.db"));
});

afterAll(() => {
  rmSync(pristine, { recursive: true, force: true });
});

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  copyFileSync(join(pristine, "messages.db"), SOURCE);
});

describe("search cache rollback", () => {
  it.each<[string, () => void]>([
    ["absent", () => {}],
    ["present and current", build],
    ["partial from an interrupted build", () => expect(run("new", { CRASH: "before-commit" }).status).toBe(91)],
    ["truncated", () => {
      build();
      const bytes = readFileSync(CACHE);
      writeFileSync(CACHE, bytes.subarray(0, bytes.length >> 1));
    }],
    ["overwritten with random bytes", () => {
      build();
      const bytes = readFileSync(CACHE);
      for (let at = 8192; at < bytes.length; at += 32) createHash("sha256").update(String(at)).digest().copy(bytes, at);
      writeFileSync(CACHE, bytes);
    }],
    ["not a database", () => {
      build();
      writeFileSync(CACHE, "NOTADB".repeat(2000));
    }],
    ["an older format", () => {
      build();
      edit("UPDATE search_meta SET format = 0");
    }],
    ["a newer format", () => {
      build();
      edit("UPDATE search_meta SET format = 2");
    }],
    ["from an older projection", () => {
      build();
      edit(`UPDATE search_meta SET fingerprint = '${"0".repeat(64)}'`);
    }],
    ["from a newer projection", () => {
      build();
      edit(`UPDATE search_meta SET fingerprint = '${"f".repeat(64)}'`);
    }],
  ])("answers from the scan at once with a cache %s, then reconciles it without writing messages.db", { timeout: 120_000 }, (_state, setup) => {
    setup();
    const before = shape();
    const file = stamp(SOURCE);
    recovered(run("new"));
    expect(stamp(SOURCE)).toEqual(file);
    expect(shape()).toEqual(before);
  });

  it("answers from the scan when the open cache file is deleted, where the platform allows it", { timeout: 120_000 }, () => {
    const result = run("new", { OPS: "delete-open" });
    expect(result.status, result.stderr).toBe(0);
    const out = result.out!;
    const { removed, answer, trusted } = out["delete-open"] as { removed: boolean; answer: Answer; trusted: boolean };
    expect(removed).toBe(process.platform !== "win32");
    expect(answer).toMatchObject({ hash: out.first.hash, scans: removed ? answer.searches : 0 });
    expect(trusted).toBe(!removed);
    recovered(run("new"));
  });

  it("revalidates after another build writes while this one is stopped, and that build leaves the schema and cache alone", { timeout: 120_000 }, () => {
    const upgraded = recovered(run("new"));
    const before = { master: shape().master, cache: stamp(CACHE), wal: existsSync(`${CACHE}-wal`) };
    const downgraded = run("old", { OPS: "writes" });
    expect(downgraded.status, downgraded.stderr).toBe(0);
    expect({ master: shape().master, cache: stamp(CACHE), wal: existsSync(`${CACHE}-wal`) }).toEqual(before);
    const again = recovered(run("new"));
    expect(again.first.hash).not.toBe(upgraded.first.hash);
    expect(again.first.ids).toEqual(expect.arrayContaining(["legacy-1", "swap-new", "synced", "two-1"]));
    expect(again.first.ids).not.toEqual(expect.arrayContaining(["gone-1"]));
    expect(again.first.ids).not.toEqual(expect.arrayContaining(["swap-1"]));
  });

  it("answers wholly from the scan after an outside write, and when one lands inside a query", { timeout: 120_000 }, () => {
    const out = recovered(run("new", { OPS: "outside,inject" }));
    const outside = out.outside as { before: boolean; answer: Answer; after: { trusted: boolean; full: boolean }; recaught: boolean; again: Answer };
    expect(outside.before).toBe(true);
    expect(outside.answer).toMatchObject({ fts: 0, scans: outside.answer.searches });
    expect(outside.answer.ids).toContain("outside");
    expect(outside.after).toEqual({ trusted: false, full: true });
    expect(outside.recaught).toBe(true);
    expect(outside.again).toMatchObject({ scans: 0, hash: outside.answer.hash });
    expect(outside.again.fts).toBeGreaterThan(0);
    const inject = out.inject as { fired: boolean; during: Answer; baseline: Answer };
    expect(inject.fired).toBe(true);
    expect(inject.during.fts).toBeGreaterThan(0);
    expect(inject.during).toMatchObject({ scans: inject.during.searches, hash: inject.baseline.hash });
    expect(inject.during.ids).toContain("inject");
  });

  it.each<[string, string, () => void]>([
    ["before the source commit", "before-source-commit", () => expect(count("id = 'crash-row'")).toBe(0)],
    ["after the outermost commit, before its dirt is published", "after-source-commit", () => expect(count("id = 'crash-row'")).toBe(1)],
    ["between deleteThread's two statements", "between-delete", () => {
      expect(count("thread_id = 'gone'")).toBe(0);
      expect(count("thread_id = 'gone'", "thread_state")).toBe(1);
    }],
    ["inside importLegacy's transaction", "inside-import", () => {
      expect(count("thread_id = 'legacy'")).toBe(0);
      expect(existsSync(join(DATA_DIR, "messages-legacy.json"))).toBe(true);
    }],
    ["during a cache transaction", "before-commit", () => {}],
    ["after a cache commit, before the ack", "after-commit", () => {}],
    ["after the ack", "after-ack", () => {}],
    ["during validation", "validating", () => {}],
    ["when the worker dies mid-page", "mid-page", () => {}],
  ])("restarts untrusted and loses no hit after a crash %s", { timeout: 120_000 }, (_point, crash, check) => {
    if (crash === "validating") build();
    const crashed = run("new", { CRASH: crash });
    expect(crashed.status, crashed.stderr).toBe(91);
    check();
    const committed = count("id = 'crash-row'") > 0;
    const out = recovered(run("new"));
    expect(out.first.ids.includes("crash-row")).toBe(committed);
  });
});
