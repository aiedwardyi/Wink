import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchHit } from "../src/lib/search-hit.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import type { SyncHead, SyncMutation } from "./thread-sync-v2.ts";

let store: Store;
let routes: ReturnType<typeof import("./thread-routes.ts").createThreadRoutes>;
let botId: string;
let groupId: string;
let bot: BotRecord;
let threadId: string;
let dataDir: string;
let mdb: typeof import("./message-db.ts");
let cache: typeof import("./search-cache.ts") | undefined;
let gate: typeof import("./search-gate.ts") | undefined;
let sync: ReturnType<typeof import("./thread-sync-v2-store.ts").createThreadSyncV2Store>;
const scanRows = 20000;
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, text, role: "user", kind: "text", at: 1, parentId: null, ...extra });

function routeStore(value: Store, project?: (message: Message) => Message) {
  return import("./thread-routes.ts").then(async ({ createThreadRoutes }) => {
    const { redactBotAuthored } = await import("./store.ts");
    store = value;
    routes = createThreadRoutes({ store, dataDir, clientMessage: project ?? redactBotAuthored } as Parameters<typeof createThreadRoutes>[0]);
  });
}

function trace() {
  const metrics = { fetched: 0, scans: 0, matches: 0 };
  const source = mdb.messageDatabase();
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    const stmt = prepare.call(this, sql);
    if (this === source && sql.startsWith("SELECT thread_id, id, at, role, kind")) {
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => { metrics.fetched++; return Reflect.apply(get, stmt, args); };
    }
    if (this === source && sql.startsWith("SELECT rowid AS row FROM messages ")) {
      const iterate = stmt.iterate.bind(stmt);
      stmt.iterate = (...args) => { metrics.scans++; return Reflect.apply(iterate, stmt, args); };
    }
    if (sql.includes("search_fts MATCH")) {
      for (const method of ["get", "all", "iterate"] as const) {
        const run = stmt[method].bind(stmt);
        Object.defineProperty(stmt, method, { value: (...args: Parameters<StatementSync[typeof method]>) => {
          metrics.matches++;
          return Reflect.apply(run, stmt, args);
        } });
      }
    }
    return stmt;
  });
  return metrics;
}

async function ready(threads = [threadId]) {
  const source = mdb.messageDatabase();
  const insert = source.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, -1, 'user', 'note', '', ?)");
  mdb.withMessageTransaction(() => {
    for (const thread of threads) {
      for (let i = 0; i < scanRows; i++) {
        const row = msg(`padding-${i}`, "", { at: -1, kind: "note" });
        insert.run(thread, row.id, JSON.stringify(row));
      }
    }
  });
  if (!cache || !gate) return;
  const state = gate.searchCacheState();
  const indexer = cache.createSearchIndexer(dataDir);
  try { await indexer.work(state); } finally { indexer.close(); }
  expect(gate.ackSearchCache(state.epoch, state.generation)).toBe(true);
  expect(gate.searchCacheState().trusted).toBe(true);
}

async function parity(paths: string[], threads?: string[]) {
  await ready(threads);
  const metrics = trace();
  const responses = [];
  for (const path of paths) {
    const baseline = await mdb.withMessageTransaction(() => search(path));
    const matches = metrics.matches;
    const indexed = await search(path);
    expect(indexed.status, path).toBe(baseline.status);
    expect(indexed.body, path).toBe(baseline.body);
    if (cache && indexed.status === 200 && !path.includes("before=missing")) {
      expect(metrics.matches, path).toBeGreaterThan(matches);
      expect(gate!.searchCacheState().trusted).toBe(true);
    }
    responses.push(indexed);
  }
  if (cache && paths.some((path) => !path.includes("threadId=missing"))) expect(metrics.matches).toBeGreaterThan(0);
  vi.mocked(DatabaseSync.prototype.prepare).mockRestore();
  console.log(`golden route cases: ${paths.length}, byte-identical`);
  return responses;
}

async function search(path = "/api/search?q=needle&limit=40") {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (code: number) => { status = code; },
    end: (value: string) => { body = value; },
  } as unknown as ServerResponse;
  await routes.search(res, new URL(path, "http://fixture.invalid"));
  return { status, body, result: JSON.parse(body) as { hits: SearchHit[]; more: boolean } };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "search-api-"));
  vi.resetModules();
  vi.stubEnv("OMB_DATA_DIR", dataDir);
  const { Store, redactBotAuthored } = await import("./store.ts");
  const { createThreadRoutes } = await import("./thread-routes.ts");
  mdb = await import("./message-db.ts");
  cache = undefined;
  gate = undefined;
  sync = null;
  if (existsSync(new URL("./search-cache.ts", import.meta.url))) {
    const cachePath = "./search-cache.ts";
    const gatePath = "./search-gate.ts";
    cache = await import(/* @vite-ignore */ cachePath);
    gate = await import(/* @vite-ignore */ gatePath);
    vi.spyOn(cache!, "startSearchCache").mockImplementation(() => {});
  }
  store = new Store(() => ({ instanceId: "test", model: "test" }));
  bot = store.createBot({ name: "Helper" }, { seedMessages: false });
  const task = store.createTask(bot.id, "Bot task")!;
  const group = store.createGroup("Room", [bot.id]);
  const roomTask = store.createGroupTask(group.id, "Room task")!;
  botId = bot.id;
  threadId = task.threadId;
  groupId = group.id;
  store.appendMessage(task.threadId, { role: "user", kind: "text", text: "needle needle" });
  store.appendMessage(roomTask.threadId, {
    role: "bot", kind: "text", text: "needle 검색", from: { botId: bot.id, name: bot.name, color: bot.color },
  });
  routes = createThreadRoutes({ store, dataDir, clientMessage: redactBotAuthored } as Parameters<typeof createThreadRoutes>[0]);
});

afterEach(async () => {
  await sync?.close();
  await cache?.stopSearchCache();
  mdb.closeMessageDb();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("search API", () => {
  it("rejects an unknown conversation", async () => {
    const [response] = await parity(["/api/search?q=needle&threadId=missing"]);
    expect(response.status).toBe(404);
    expect(response.body).toBe('{"error":"no such conversation"}');
  });

  it("resolves bot and room tasks with attribution and occurrence counts", async () => {
    const [response] = await parity(["/api/search?q=needle&limit=40"]);
    expect(response.status).toBe(200);
    expect(response.result.more).toBe(false);
    expect(response.result.hits).toHaveLength(2);
    expect(response.result.hits.find((hit) => hit.botId)).toMatchObject({
      botId, name: "Helper", task: "Bot task", snippet: "needle needle", matches: 2, onActivePath: true,
    });
    expect(response.result.hits.find((hit) => hit.groupId)).toMatchObject({
      groupId, name: "Room", task: "Room task", snippet: "needle 검색", from: "Helper", matches: 1, onActivePath: true,
    });
  });

  it("keeps the iOS decoded fields and pins route-only keys", async () => {
    const response = await search();
    expect(response.status).toBe(200);
    expect(response.result.hits).toHaveLength(2);
    const source = readFileSync(new URL("../ios/Sources/CompanionCore/Models.swift", import.meta.url), "utf8");
    const model = source.match(/public struct SearchHit:[\s\S]*?\n}/)?.[0];
    expect(model).toBeDefined();
    const fields = [...model!.matchAll(/public var (\w+): ([^\n{]+)$/gm)].map((match) => ({ name: match[1], optional: match[2].includes("?") }));
    const decoded = fields.map((field) => field.name).sort();
    const keys = [...new Set(response.result.hits.flatMap((hit) => Object.keys(hit)))].sort();
    expect(keys.filter((key) => !decoded.includes(key))).toEqual(["from", "matches"]);
    for (const field of fields) {
      expect(keys).toContain(field.name);
      if (!field.optional) for (const hit of response.result.hits) {
        expect(hit).toHaveProperty(field.name);
        expect(hit[field.name as keyof SearchHit]).not.toBeNull();
        expect(hit[field.name as keyof SearchHit]).not.toBeUndefined();
      }
    }
  });

  it("filters owners after limit plus one without back-filling dropped rows", async () => {
    const deleted = store.createBot({ name: "Deleted" }, { seedMessages: false });
    const deletedThread = deleted.threadId;
    store.deleteBot(deleted.id);
    mdb.insertMessage(deletedThread, msg("deleted", "OwnerNeedle", { at: 4 }));
    mdb.insertMessage("unowned", msg("orphan", "OwnerNeedle", { at: 3 }));
    const older = store.appendMessage(threadId, { role: "user", kind: "text", text: "OwnerNeedle", at: 2 });
    const oldest = store.appendMessage(threadId, { role: "user", kind: "text", text: "OwnerNeedle", at: 1 });
    const responses = await parity([1, 2, 3, 4].map((limit) => `/api/search?q=OwnerNeedle&limit=${limit}`));
    expect(responses.map(({ result }) => ({ ids: result.hits.map((hit) => hit.messageId), more: result.more }))).toEqual([
      { ids: [], more: true }, { ids: [], more: true }, { ids: [older.id], more: true }, { ids: [older.id, oldest.id], more: false },
    ]);
    expect((await search(`/api/search?q=OwnerNeedle&threadId=${deletedThread}`)).status).toBe(404);
  });

  it("keeps both branches searchable when the active leaf switches", async () => {
    const root = store.appendMessage(threadId, { role: "user", kind: "text", text: "BranchNeedle root", at: 1 });
    const left = store.appendMessage(threadId, { role: "bot", kind: "text", text: "BranchNeedle left", at: 2 });
    const right = store.appendMessage(threadId, { role: "bot", kind: "text", text: "BranchNeedle right", at: 3, parentId: root.id });
    const path = `/api/search?q=BranchNeedle&limit=100&threadId=${threadId}`;
    const [before] = await parity([path]);
    expect(before.result.hits.map((hit) => [hit.messageId, hit.onActivePath])).toEqual([[right.id, true], [left.id, false], [root.id, true]]);
    expect(store.setActiveLeaf(threadId, left.id)).toBe(left.id);
    const [after] = await parity([path]);
    expect(after.result.hits.map((hit) => [hit.messageId, hit.onActivePath])).toEqual([[right.id, false], [left.id, true], [root.id, true]]);
  });

  it("keeps caller limits, chips, terminal details and before paging identical", async () => {
    const rows = Array.from({ length: 207 }, (_, i) => store.appendMessage(threadId, {
      role: "user", kind: "text", text: `CallerNeedle 검색 ${i}`, at: 10 + Math.floor(i / 3),
    }));
    const tool = store.appendMessage(threadId, { role: "bot", kind: "activity", at: 1000,
      tool: { name: "Read", detail: { input: "public/file.txt", output: ["DetailNeedle 결과"] } },
    });
    const q = "CallerNeedle 검색";
    const paths = [
      `/api/search?q=${encodeURIComponent(q)}&limit=12`,
      `/api/search?q=${encodeURIComponent(q)}&limit=40`,
      ...["", "&view=chips"].flatMap((view) => [
        `/api/search?q=${encodeURIComponent(q)}&limit=100&threadId=${encodeURIComponent(threadId)}${view}`,
        `/api/search?q=${encodeURIComponent(q)}&limit=100&threadId=${encodeURIComponent(threadId)}${view}&before=${encodeURIComponent(rows[107].id)}`,
        `/api/search?q=DetailNeedle&limit=100&threadId=${threadId}${view}`,
      ]),
      `/api/search?q=${encodeURIComponent(q)}&limit=100&threadId=${threadId}&before=missing`,
    ];
    const responses = await parity(paths);
    expect(responses.map(({ result }) => result.hits.length)).toEqual([12, 40, 100, 100, 1, 100, 100, 0, 0]);
    expect(responses.slice(0, 4).every(({ result }) => result.more)).toBe(true);
    expect(responses[4].result.hits[0].messageId).toBe(tool.id);
    for (const offset of [2, 5]) {
      const first = responses[offset].result.hits;
      const second = responses[offset + 1].result.hits;
      expect(new Set([...first, ...second].map((hit) => hit.messageId)).size).toBe(200);
      expect(second[0].messageId).toBe(rows[106].id);
    }
  });

  it("proxies MCP searches with the default and maximum page sizes", async () => {
    const { handleToolCall } = await import("../scripts/mcp-server.ts");
    for (let i = 0; i < 105; i++) store.appendMessage(threadId, { role: "user", kind: "text", text: "McpNeedle 검색", at: i });
    await ready();
    const metrics = trace();
    for (const limit of [undefined, 100]) {
      const args = { query: "McpNeedle 검색", task_id: threadId, ...(limit ? { limit } : {}) };
      const paths: string[] = [];
      const fetcher = vi.fn(async (path: string) => { paths.push(path); return (await search(path)).result; });
      const baseline = await mdb.withMessageTransaction(() => handleToolCall("search_messages", args, fetcher));
      const matches = metrics.matches;
      const indexed = await handleToolCall("search_messages", args, fetcher);
      expect(JSON.stringify(indexed)).toBe(JSON.stringify(baseline));
      if (cache) {
        expect(metrics.matches).toBeGreaterThan(matches);
        expect(gate!.searchCacheState().trusted).toBe(true);
      }
      expect(paths).toEqual(Array(2).fill(`/api/search?q=McpNeedle+%EA%B2%80%EC%83%89&limit=${limit ?? 40}&threadId=${threadId}`));
      expect((indexed as { hits: SearchHit[] }).hits).toHaveLength(limit ?? 40);
    }
    if (cache) expect(metrics.matches).toBeGreaterThan(0);
  });

  it("rebuilds sanitized UTF-16 snippet offsets from clientMessage", async () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const raw = msg("raw-client", `🧠\t  ${secret}\n  VisibleNeedle 검색 VisibleNeedle`, { role: "bot" });
    mdb.insertMessage(threadId, raw);
    const { Store, redactBotAuthored } = await import("./store.ts");
    let projected = 0;
    await routeStore(new Store(() => ({ instanceId: "test", model: "test" })), (message) => { projected++; return redactBotAuthored(message); });
    const [response] = await parity(["/api/search?q=VisibleNeedle&limit=40"]);
    expect(projected).toBeGreaterThan(0);
    const hit = response.result.hits[0];
    expect(hit.messageId).toBe(raw.id);
    expect(hit.snippet).toContain("🧠");
    expect(hit.snippet).not.toContain(secret);
    expect(hit.snippet).not.toMatch(/\s{2}|\t|\n/);
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe("VisibleNeedle");
    expect(hit.matchStart).toBe(hit.snippet.indexOf("VisibleNeedle"));
    expect(hit.matchStart).toBeGreaterThan(Array.from(hit.snippet.slice(0, hit.matchStart)).length);
    expect(hit.matches).toBe(2);
    expect(mdb.messageDatabase().prepare("SELECT text FROM messages WHERE id = ?").get(raw.id)!.text).toContain(secret);
  });

  it("imports an unopened legacy conversation before search", async () => {
    const task = store.createTask(bot.id, "Legacy task")!;
    const file = join(dataDir, `messages-${task.threadId}.json`);
    writeFileSync(file, JSON.stringify({ messages: [msg("legacy", "LegacyNeedle 검색")], activeLeafId: "legacy" }));
    const { Store } = await import("./store.ts");
    await routeStore(new Store(() => ({ instanceId: "test", model: "test" })));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.imported`)).toBe(true);
    const [response] = await parity(["/api/search?q=LegacyNeedle&limit=40"]);
    expect(response.result.hits).toMatchObject([{ messageId: "legacy", botId, task: "Legacy task", onActivePath: true }]);
  });

  it("consumes selected and conflicting v2 copies through Store.applySyncChanges", async () => {
    const { createThreadSyncV2Store } = await import("./thread-sync-v2-store.ts");
    const { redactBotAuthored } = await import("./store.ts");
    const task = store.createTask(bot.id, "Sync task")!;
    const folder = join(dataDir, "fake-sync");
    mkdirSync(folder);
    const scope = { botSyncId: "proof-bot", threadId: task.threadId };
    sync = createThreadSyncV2Store({
      store, dataDir, deviceId: "proof-device", folder: () => folder, enabled: () => true,
      target: (id) => id === task.threadId ? { botId, botSyncId: scope.botSyncId } : null,
      bots: () => [{ botId, botSyncId: scope.botSyncId }], running: () => false,
      project: redactBotAuthored, imported: () => {}, maintenance: () => {},
    });
    const apply = vi.spyOn(store, "applySyncChanges");
    const applied: string[] = [];
    const applyRows = mdb.applySyncedRows;
    vi.spyOn(mdb, "applySyncedRows").mockImplementation((thread, rows, leaf, database) => {
      expect(database?.isTransaction).toBe(true);
      applied.push(...rows.map((row) => row.id));
      return applyRows(thread, rows, leaf, database);
    });
    const put = (writerId: string, text: string, branch: string) => {
      const mutations: SyncMutation[] = [
        { kind: "metadata", value: { title: "Synced task", createdAt: 1 } },
        { kind: "row", value: msg("sync-root", text) },
        { kind: "row", value: msg(branch, `SyncNeedle ${branch}`, { at: 2, parentId: "sync-root" }) },
        { kind: "head", value: branch },
      ];
      const head: SyncHead = { v: 2, threadId: task.threadId, writerId, generation: 1, sealedThrough: 0, firstSeq: 1, lastSeq: mutations.length,
        seen: { [writerId]: mutations.length }, versions: mutations.map((mutation, i) => ({ ...mutation, seq: i + 1, seen: { [writerId]: i },
          rowId: mutation.kind === "row" ? mutation.value.id : "", baseStamp: null,
          ...(mutation.kind === "row" ? { origin: writerId } : {}),
        })),
      };
      const dir = join(folder, "threads-v2", scope.botSyncId, task.threadId, writerId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "head.json"), JSON.stringify(head));
    };
    put("a-writer", "SyncNeedle selected copy", "selected-branch");
    expect(mdb.messageDatabase().prepare("SELECT 1 FROM messages WHERE id = 'sync-root'").get()).toBeUndefined();
    await sync!.pull(task.threadId);
    expect(applied).toContain("sync-root");
    const [selected] = await parity([`/api/search?q=SyncNeedle&limit=40&threadId=${task.threadId}`], [task.threadId]);
    expect(selected.result.hits.map((hit) => hit.snippet)).toContain("SyncNeedle selected copy");
    put("z-writer", "SyncNeedle conflict copy", "conflict-branch");
    await sync!.pull(task.threadId);
    expect(apply).toHaveBeenCalled();
    expect(applied).toEqual(expect.arrayContaining(["sync-root", "selected-branch", "conflict-branch"]));
    expect(Number(mdb.messageDatabase().prepare("SELECT count(*) AS n FROM sync_v2_changes WHERE thread = ? AND conflict = 1").get(task.threadId)!.n)).toBeGreaterThan(0);
    const [conflict] = await parity([`/api/search?q=SyncNeedle&limit=40&threadId=${task.threadId}`], [task.threadId]);
    expect(conflict.result.hits.map((hit) => hit.messageId)).toEqual(expect.arrayContaining(["sync-root", "selected-branch", "conflict-branch"]));
    expect(conflict.result.hits.find((hit) => hit.messageId === "sync-root")!.snippet).toBe("SyncNeedle conflict copy");
    expect(conflict.result.hits.every((hit) => hit.botId === botId && hit.task === "Synced task")).toBe(true);
    expect(conflict.result.hits.some((hit) => !hit.onActivePath)).toBe(true);
  });

  it("rejects hidden-only matches with at most ten source row fetches", async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => msg(`hidden-${i}`, "", {
      at: i, kind: "activity", tool: { name: "Read", detail: { input: "public/file.txt", output: ["HiddenOnlyNeedle"], outputHidden: true } },
    }));
    mdb.applySyncedRows(threadId, rows);
    const update = mdb.messageDatabase().prepare("UPDATE messages SET json = ? WHERE thread_id = ? AND id = ?");
    mdb.withMessageTransaction(() => { for (const row of rows) update.run(JSON.stringify(row), threadId, row.id); });
    await ready();
    const metrics = trace();
    const baseline = await mdb.withMessageTransaction(() => search("/api/search?q=HiddenOnlyNeedle&limit=40"));
    expect(baseline.body).toBe('{"hits":[],"more":false}');
    expect(metrics.fetched).toBe(3000);
    metrics.fetched = 0;
    metrics.scans = 0;
    const indexed = await search("/api/search?q=HiddenOnlyNeedle&limit=40");
    expect(indexed.body).toBe(baseline.body);
    expect(metrics.fetched).toBeLessThanOrEqual(10);
    expect(metrics.scans).toBe(0);
    expect(metrics.matches).toBeGreaterThan(0);
  });

  it("keeps search-cache outside memory sync", () => {
    const files = readdirSync(new URL("./", import.meta.url)).filter((file) => /^memory-sync.*\.ts$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toContain("search-cache");
  });
});
