import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { mailboxGrant, mailboxSecretFor } from "./mailbox.ts";
import { closeMessageDb, messageDatabase } from "./message-db.ts";
import { loadProfileSyncSettings, PROFILE_SYNC_CHANGES_DIR, PROFILE_SYNC_FORMAT, PROFILE_SYNC_VERSION, saveProfileSyncSettings, writeSyncOperation } from "./profile-sync.ts";
import { Store, type Message } from "./store.ts";
import { harnessFetch, spawnHarness } from "./testing/harness-auth.ts";
import { CONFLICT_NOTICE } from "./thread-sync.ts";
import { createThreadSyncV2Store } from "./thread-sync-v2-store.ts";

const root = join(import.meta.dirname, "..");
const port = 28800 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;
const home = join(homedir(), "host");
const userData = join(home, "user-data");
const spyLog = join(home, "main-sql.jsonl");
const syncFolder = join(home, "sync");
const BIG = 50_000;
const WINDOW_MS = 30_000;
const scope = { pane: "pane-1", teacher: "teacher-1" };
const mailId = randomUUID();
let child: ChildProcess;
let stderr = "";
let botId = "";
let threadId = "";
let servingAt = 0;

type Statement = { t: number; sql: string; params: string[]; rows?: number; at: string | null; via?: string[]; plan?: string[] };
type FsRead = { t: number; fs: string; path: string; at: string | null; via: string[] };

function seed(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const store = new Store(() => ({ instanceId: "claude", model: "claude-fake" }));
  const bot = store.createBot({ name: "Big" }, { seedMessages: false });
  store.patchBot(bot.id, { notifications: false, composio: false });
  const small = store.createBot({ name: "Small" }, { seedMessages: false });
  store.patchBot(small.id, { notifications: false, composio: false });
  store.flushSaves();
  botId = bot.id;
  threadId = bot.threadId;
  const cutoverAt = Date.now() - 86_400_000;
  writeFileSync(join(DATA_DIR, "thread-sync-v2-cutover.json"), JSON.stringify({ version: 2, cutoverAt }));
  const sync = createThreadSyncV2Store({
    store, dataDir: DATA_DIR, deviceId: saveProfileSyncSettings(DATA_DIR, { ...loadProfileSyncSettings(DATA_DIR), folder: syncFolder }).deviceId, folder: () => null, enabled: () => false, target: () => null, bots: () => [],
    running: () => false, project: (message) => message, imported: () => {}, maintenance: () => {}, bootReads: async () => ({ migration: [], conflicts: [] }),
  })!;
  void sync.close();
  const key = createHash("sha256").update(`${scope.pane}:${bot.id}:${scope.teacher}:${mailId}`).digest("hex");
  // SAFETY: a handed read needs only state and upto; the rest of comm is irrelevant to the finder.
  const markers: Array<Partial<Message> & { id: string }> = [
    { id: "mark-mail", role: "bot", kind: "note", text: "worker report", mailbox: { key } },
    { id: "mark-notice", role: "bot", kind: "activity", tool: { name: `error: ${CONFLICT_NOTICE}`, ok: false } },
    { id: "mark-after-notice", role: "user", kind: "text", text: "after the notice" },
    { id: "mark-card", role: "bot", kind: "options", card: { title: "Ask Scout?", subtitle: "", options: ["Allow", "Deny"], requestId: "req-1", tool: "ask_bot" } },
    { id: "mark-handed", role: "bot", kind: "text", text: "handed mail", comm: { read: { state: "handed", upto: 5 } } as Message["comm"] },
  ];
  // a resumed ask starts the turn the user asked for, which loads its chat; in the big chat that would hide any boot walk of it
  const ask = { id: "mark-ask", at: Date.now() - 60_000, parentId: null, role: "user", kind: "text", text: "quick question?", quick: { state: "asked" } } satisfies Partial<Message>;
  for (let sequence = 1; sequence <= 200; sequence++) {
    writeSyncOperation(syncFolder, { format: PROFILE_SYNC_FORMAT, version: PROFILE_SYNC_VERSION, operationId: `gone-${sequence}`, deviceId: "peer-device", sequence, recordedAt: cutoverAt, entity: "bot", entityId: `gone-${sequence}`, deleted: true });
  }
  const db = messageDatabase();
  const insert = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  let parentId: string | null = null;
  const start = cutoverAt - 30 * 86_400_000;
  for (let index = 0; index < BIG; index++) {
    const row: Partial<Message> & { id: string; at: number } = { id: `row-${index}`, at: start + index, parentId, role: index % 2 ? "bot" : "user", kind: "text", text: `row ${index} ${"x".repeat(200)}` };
    insert.run(threadId, row.id, row.at, row.role!, row.kind!, row.text!, JSON.stringify(row));
    parentId = row.id;
  }
  for (const [index, marker] of markers.entries()) {
    const row = { at: Date.now() - 60_000 + index, parentId, ...marker };
    insert.run(threadId, row.id, row.at, row.role!, row.kind!, row.text ?? null, JSON.stringify(row));
    parentId = row.id;
  }
  const leaf = db.prepare("INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id");
  leaf.run(threadId, parentId);
  insert.run(small.threadId, ask.id, ask.at, ask.role, ask.kind, ask.text, JSON.stringify(ask));
  leaf.run(small.threadId, ask.id);
  const task = bot.tasks![0]!;
  db.prepare("INSERT INTO sync_v2_store VALUES (?, ?, ?, ?, ?, 0, 1, 0)").run(threadId, bot.id, "sync-big", task.title, task.createdAt);
  db.prepare("INSERT INTO sync_v2_notices VALUES (?, 0)").run(threadId);
  db.exec("COMMIT");
  closeMessageDb();
}

function logged(): Array<Statement | FsRead | { t: number; tick: true }> {
  // SAFETY: main-sql-spy.ts writes one Statement, fs read or tick per line.
  return readFileSync(spyLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Statement | FsRead | { t: number; tick: true });
}

function statements(): Statement[] {
  return logged().filter((row): row is Statement => "sql" in row);
}

function plans(rows: Statement[]): Map<string, string[]> {
  return new Map(rows.flatMap((row) => (row.plan ? [[row.sql, row.plan] as const] : [])));
}

// A PK point read or join, or a newest-first page with no JSON filter; anything else reads rows it does not return.
function keyed(row: Statement, plan: string[] | undefined): boolean {
  const sql = row.sql.replace(/\s+/g, " ").trim();
  if (/^(CREATE|PRAGMA|INSERT)\b/i.test(sql)) return true;
  const names = new Set(["messages", ...[...sql.matchAll(/\bmessages\s+(?:AS\s+)?(\w+)/gi)].map((hit) => hit[1]!)
    .filter((name) => !/^(WHERE|JOIN|ON|SET|ORDER|GROUP|LIMIT|CROSS|LEFT|INNER|USING|VALUES)$/i.test(name))]);
  const reads = (plan ?? []).filter((detail) => /^(SCAN|SEARCH) (\w+)/.test(detail) && names.has(/^(?:SCAN|SEARCH) (\w+)/.exec(detail)![1]!));
  if (!plan || !reads.length) return false;
  if (reads.every((detail) => /^SEARCH \w+ USING (?:COVERING )?(?:INDEX|PRIMARY KEY)\b.* \(thread_id=\? AND (?:id|<expr>)=\?\)$/.test(detail))) return true;
  const where = sql.split(/\bWHERE\b/i).slice(1).join(" WHERE ");
  return /\bORDER BY [\w.]+ DESC LIMIT\b/i.test(sql) && !/json_(extract|type)\(/i.test(where) && reads.every((detail) => detail.startsWith("SEARCH"));
}

function scans(rows: Statement[]): string[] {
  const planOf = plans(rows);
  const seen = new Set<string>();
  return rows.filter((row) => !keyed(row, planOf.get(row.sql))).flatMap((row) => {
    const line = `main-thread scan of messages at boot: ${row.sql.replace(/\s+/g, " ").trim()} (${row.at}). Find the rows in server/cold-thread-worker.ts and apply them by id (ARCH-STARTUP).`;
    if (seen.has(line)) return [];
    seen.add(line);
    return [line];
  });
}

// After paint: a JSON filter that is not a key lookup, or every row of one chat with no LIMIT.
function unbounded(rows: Statement[]): string[] {
  const planOf = plans(rows);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const plan = planOf.get(row.sql) ?? [];
    const sql = row.sql.replace(/\s+/g, " ").trim();
    // SQLite answers a lone MIN/MAX on an indexed column from one index entry
    if (keyed(row, plan) || /^SELECT (?:MAX|MIN)\(\w+\)(?: AS \w+)? FROM messages WHERE thread_id = \?$/i.test(sql)) return [];
    const where = sql.split(/\bWHERE\b/i).slice(1).join(" WHERE ");
    const json = /json_(extract|type)\(/i.test(where);
    const whole = row.params.includes(threadId) && !/\bLIMIT\b/i.test(sql)
      && plan.some((detail) => /^SCAN (m|messages)\b/.test(detail) || /USING (?:COVERING )?INDEX (?:messages_thread|messages_thread_at|sqlite_autoindex_messages_1) \(thread_id=\?\)$/.test(detail));
    if (!json && !whole) return [];
    const line = `main-thread ${json ? "JSON filter" : "whole-chat read"} after paint: ${sql} (${[row.at, ...(row.via ?? [])].join(" < ")}). Bound it to a key or a LIMITed page, or move it to server/cold-thread-worker.ts (ARCH-STARTUP).`;
    if (seen.has(line)) return [];
    seen.add(line);
    return [line];
  });
}

// The first page's cold reads: a chat's page or the profile sync change log, read on the thread that serves the app.
function firstPageReads(rows: Array<Statement | FsRead>): string[] {
  const changes = join(syncFolder, PROFILE_SYNC_CHANGES_DIR);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const via = [row.at, ...(row.via ?? [])].join(" < ");
    const line = "fs" in row
      ? row.path.startsWith(changes) && `main-thread ${row.fs} of the profile sync change log (${via}). Read it with readSyncOperationsAsync in server/profile-sync.ts (STARTUP-ROOT).`
      : row.params.includes(threadId) && (row.rows ?? 0) > 1
        && `main-thread page of a cold chat: ${row.sql.replace(/\s+/g, " ").trim()} (${via}). Read it in server/cold-thread-worker.ts (STARTUP-ROOT).`;
    if (!line || seen.has(line)) return [];
    seen.add(line);
    return [line];
  });
}

function rows(): Map<string, Message> {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  try {
    // SAFETY: json is the stored Message the server wrote.
    const found = db.prepare("SELECT json FROM messages WHERE id LIKE 'mark-%'").all() as Array<{ json: string }>;
    // SAFETY: json is the stored Message the server wrote.
    return new Map(found.map((row): [string, Message] => { const message = JSON.parse(row.json) as Message; return [message.id, message]; }));
  } finally {
    db.close();
  }
}

function notices(): number {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  try {
    // SAFETY: COUNT(*) returns one integer row.
    return (db.prepare("SELECT COUNT(*) AS n FROM sync_v2_notices WHERE thread = ?").get(threadId) as { n: number }).n;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  seed();
  mailboxSecretFor(userData);
  child = spawnHarness(process.execPath, ["--import", pathToFileURL(join(root, "server", "testing", "main-sql-spy.ts")).href, join(root, "server", "index.ts")], {
    cwd: root,
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: DATA_DIR, OMB_PORT: String(port), OMB_USER_DATA: userData,
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
      OMB_THREAD_SYNC_V2: "1", ORBIT_REMOTE_AUTO: "0", ORBIT_RELAY: "0", ORBIT_NO_WSL: "1", WINK_SQL_SPY: spyLog, WINK_SQL_SPY_FS: syncFolder,
    },
  });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const end = Date.now() + 90_000;
  for (;;) {
    const sent = Date.now();
    // the client's own page size: an unpaginated /api/bots reads every chat whole by design
    if ((await harnessFetch(`${base}/api/bots?messages=200`).catch(() => null))?.status === 200) {
      servingAt = sent;
      break;
    }
    if (child.exitCode !== null || Date.now() > end) throw new Error(`server start: ${stderr.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // the first page asks for the sync status beside its chats
  expect((await harnessFetch(`${base}/api/profile-sync`)).status).toBe(200);
}, 120_000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await ended;
}, 30_000);

describe("boot reads of messages.db", () => {
  it("before serving, the main thread reads messages only by key or newest page", () => {
    expect(scans(statements().filter((row) => row.t < servingAt))).toEqual([]);
  });

  it("handles each boot marker once by the end of the first 30 s", async () => {
    const response = await harnessFetch(`${base}/api/mailbox`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-orbit-pane": scope.pane, "x-orbit-bot": botId, "x-orbit-teacher": scope.teacher,
        authorization: `Bearer ${mailboxGrant(mailboxSecretFor(userData), scope.pane, botId, scope.teacher)}`,
      },
      body: JSON.stringify({ text: "worker report", messageId: mailId }),
    });
    expect(await response.json()).toEqual({ ok: true, id: "mark-mail" });
    const handled = () => {
      const marks = rows();
      return {
        notice: marks.has("mark-notice"),
        noticeRow: notices(),
        reparented: marks.get("mark-after-notice")?.parentId,
        ask: marks.get("mark-ask")?.quick?.state !== "asked",
        queued: Boolean(marks.get("mark-ask")?.queueId),
        card: marks.get("mark-card")?.card?.dismissed,
        handed: marks.get("mark-handed")?.comm?.read?.state,
      };
    };
    const want = { notice: false, noticeRow: 1, reparented: "mark-mail", ask: true, queued: true, card: true, handed: "read" };
    while (Date.now() < servingAt + WINDOW_MS && JSON.stringify(handled()) !== JSON.stringify(want)) await new Promise((resolve) => setTimeout(resolve, 250));
    expect(handled()).toEqual(want);
    const notes = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try {
      expect(notes.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND kind = 'note'").get(threadId)).toEqual({ n: 1 });
    } finally {
      notes.close();
    }
  }, WINDOW_MS + 10_000);

  it("for 30 s after serving, reads only keyed or bounded rows on the main thread", async () => {
    await vi.waitFor(() => expect(logged().at(-1)!.t).toBeGreaterThanOrEqual(servingAt + WINDOW_MS), { timeout: WINDOW_MS + 5_000, interval: 500 });
    expect(unbounded(statements().filter((row) => row.t >= servingAt && row.t < servingAt + WINDOW_MS))).toEqual([]);
  }, WINDOW_MS + 10_000);

  it("reads the first page's cold chat tails and sync change log off the main thread", () => {
    expect(firstPageReads(logged().filter((row): row is Statement | FsRead => !("tick" in row) && row.t < servingAt + WINDOW_MS))).toEqual([]);
  });
});

describe("boot rows", () => {
  it("settle to empty rows when a shutdown before paint skips the read", async () => {
    const { bootReads, skipBootReads } = await import("./boot-reads.ts");
    skipBootReads();
    expect(await bootReads()).toEqual({ receipts: [], migration: [], conflicts: [], asks: [], peerCards: [], handed: [], reports: [] });
  });
});
