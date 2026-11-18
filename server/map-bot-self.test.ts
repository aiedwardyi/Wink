import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { MapSnapshot } from "../shared/map-pane.ts";
import { listenLocal } from "./phone-relay/testing/net.ts";
import { createWorkerMap } from "./map-pane.ts";
import { DATA_DIR } from "./config.ts";
import { Store, type Message, type StoreChange } from "./store.ts";
import { messageDatabase } from "./message-db.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { completedTool } from "./tool-activity.ts";

const roots: string[] = [];
const servers: Server[] = [];
const streams: ServerResponse[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const stream of streams.splice(0)) stream.end();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const root of roots.splice(0)) await removeTempDir(root);
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "wink-map-self-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { windowsHide: true, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "file.ts"), "const before = 1;\n");
  writeFileSync(join(root, "other.ts"), "const other = 1;\n");
  git("add", ".");
  git("commit", "-qm", "initial");
  return { root, git };
}

let id = 0;
const said = (text: string): Message => ({ id: `m${++id}`, at: Date.now(), role: "bot", kind: "text", text });
const edited = (writes: string[], ok = true): Message => ({
  id: `m${++id}`, at: Date.now(), role: "bot", kind: "activity",
  tool: completedTool({ name: "Edit" }, { eventId: `e${id}`, provider: "claude", threadId: "thread", createdAt: new Date().toISOString(), type: "item.completed", itemType: "tool", ok, writes }),
});

async function open(messages: Message[], cwd?: string, task?: { cwd?: string | null }, real?: { store: Store; botId: string }) {
  const listeners: ((change: StoreChange) => void)[] = [];
  // SAFETY: the worker map reads only these five store members.
  const store = real?.store ?? {
    bot: () => ({ id: "bot", name: "Teacher", threadId: "thread", cwd }),
    taskByThread: () => task,
    loaded: () => true,
    messagesFor: () => messages,
    onChange: (listener: (change: StoreChange) => void) => { listeners.push(listener); return () => {}; },
  } as unknown as Store;
  const feature = createWorkerMap(store, () => null);
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/live") streams.push(res);
    void feature.handle(req, res, real?.botId ?? "bot", url.pathname.slice(1), url);
  });
  servers.push(server);
  const url = `http://127.0.0.1:${await listenLocal(server)}`;
  const abort = new AbortController();
  const reader = (await fetch(`${url}/live`, { signal: abort.signal })).body!.getReader();
  let buffered = "";
  async function until(check: (data: MapSnapshot) => boolean): Promise<MapSnapshot> {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const data: MapSnapshot = JSON.parse(buffered.slice(6, end));
        buffered = buffered.slice(end + 2);
        if (check(data)) return data;
      } else {
        const { value, done } = await reader.read();
        if (done) throw new Error("Map stream ended");
        buffered += new TextDecoder().decode(value);
      }
    }
  }
  const add = (message: Message) => { messages.push(message); for (const listener of listeners) listener({ type: "message", threadId: "thread", message }); };
  return { url, until, add, close: () => abort.abort() };
}

it("shows the bot as a row with the files its own turn edited in a git folder", async () => {
  const { root } = repo();
  const map = await open([said("On it.")]);
  expect((await map.until(() => true)).workers).toEqual([]);
  writeFileSync(join(root, "file.ts"), "const after = 2;\n");
  writeFileSync(join(root, "new.ts"), "const fresh = 1;\n");
  map.add(edited([join(root, "file.ts"), join(root, "new.ts")]));
  const shown = await map.until(data => data.workers.length > 0);
  expect(shown.workers).toHaveLength(1);
  expect(shown.workers[0]).toMatchObject({ nick: "Teacher", git: true });
  expect(shown.workers[0].files.map(file => file.path).sort()).toEqual(["file.ts", "new.ts"]);
  const diff = await fetch(`${map.url}/file?worker=${shown.workers[0].id}&path=file.ts`).then(res => res.json());
  expect(diff).toMatchObject({ lines: expect.arrayContaining([expect.objectContaining({ kind: "add", text: "const after = 2;" })]) });
  map.close();
});

it("reads only the rows that wrote files and leaves a long chat unloaded", async () => {
  const { root } = repo();
  rmSync(DATA_DIR, { recursive: true, force: true });
  const write = (store: Store, threadId: string, path: string) => {
    const { id: _id, at: _at, ...row } = edited([join(root, path)]);
    store.appendMessage(threadId, row);
  };
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  writeFileSync(join(root, "file.ts"), "const first = 2;\n");
  write(setup, bot.threadId, "file.ts");
  for (let row = 0; row < 300; row++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${row}` });
  writeFileSync(join(root, "other.ts"), "const second = 2;\n");
  write(setup, bot.threadId, "other.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const whole = vi.spyOn(store, "messagesFor");
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  const shown = await map.until(data => data.workers.length > 0);
  map.close();
  expect(shown.workers[0].files.map(file => file.path).sort()).toEqual(["file.ts", "other.ts"]);
  expect(whole).not.toHaveBeenCalled();
  expect(store.loaded(bot.threadId)).toBe(false);
});

it("keeps serving while it reads an unloaded chat's write rows from a large database", async () => {
  const { root } = repo();
  rmSync(DATA_DIR, { recursive: true, force: true });
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  writeFileSync(join(root, "file.ts"), "const first = 2;\n");
  const { id: _id, at: _at, ...row } = edited([join(root, "file.ts")]);
  setup.appendMessage(bot.threadId, row);
  const database = messageDatabase();
  const insert = database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES ('other', ?, 0, 'bot', 'activity', NULL, ?)");
  const json = JSON.stringify({ id: "r", at: 0, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, detail: { output: ["x".repeat(4_000)] } } });
  database.exec("BEGIN");
  for (let n = 0; n < 40_000; n++) insert.run(`r${n}`, json);
  database.exec("COMMIT");
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const loaded = store.loaded.bind(store);
  const waits: number[] = [];
  // Map asks whether the chat is loaded right before it reads the chat: a callback queued then must not wait on the read.
  vi.spyOn(store, "loaded").mockImplementation(threadId => {
    const queued = performance.now();
    setImmediate(() => waits.push(performance.now() - queued));
    return loaded(threadId);
  });
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  const shown = await map.until(data => data.workers.length > 0);
  map.close();
  expect(shown.workers[0].files.map(file => file.path)).toEqual(["file.ts"]);
  expect(Math.max(...waits)).toBeLessThan(50);
});

it("reads no note for panes edited after every note of an unloaded chat", async () => {
  const folders = [repo().root, repo().root];
  rmSync(DATA_DIR, { recursive: true, force: true });
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  for (let n = 0; n < 200; n++) setup.appendMessage(bot.threadId, { role: "bot", kind: "note", text: `done ${n}`, at: Date.now() - 60_000 });
  for (const root of folders) {
    writeFileSync(join(root, "file.ts"), "const edited = 2;\n");
    const { id: _id, at: _at, ...row } = edited([join(root, "file.ts")]);
    setup.appendMessage(bot.threadId, row);
  }
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const parse = vi.spyOn(JSON, "parse");
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  const shown = await map.until(data => data.workers.length === 2);
  map.close();
  const notes = parse.mock.calls.filter(([text]) => text.includes('"kind":"note"')).length;
  parse.mockRestore();
  expect(shown.workers.map(worker => worker.reason)).toEqual([undefined, undefined]);
  expect(notes).toBe(0);
});

// Two rows whose edits left no change, so each reason reads every note since 0, and `count` notes about other panes.
function cleanPanes(count: number) {
  const folders = [repo().root, repo().root];
  rmSync(DATA_DIR, { recursive: true, force: true });
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  for (const root of folders) {
    const { id: _id, at: _at, ...row } = edited([join(root, "file.ts")]);
    setup.appendMessage(bot.threadId, row);
  }
  const database = messageDatabase();
  const insert = database.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, 'bot', 'note', ?, ?)");
  database.exec("BEGIN");
  for (let n = 0; n < count; n++) {
    const text = `[pane 0f0f0f0f] done ${n}\n${"x".repeat(1_000)}`;
    insert.run(bot.threadId, `note${n}`, n, text, JSON.stringify({ id: `note${n}`, at: n, role: "bot", kind: "note", text }));
  }
  database.exec("COMMIT");
  return { store: new Store(() => ({ instanceId: "claude", model: "opus" })), botId: bot.id };
}

it("keeps serving while it reads clean rows' reasons from an unloaded chat's notes", async () => {
  const real = cleanPanes(10_000);
  const loaded = real.store.loaded.bind(real.store);
  const waits: number[] = [];
  vi.spyOn(real.store, "loaded").mockImplementation(threadId => {
    const queued = performance.now();
    setImmediate(() => waits.push(performance.now() - queued));
    return loaded(threadId);
  });
  const map = await open([], undefined, undefined, real);
  expect((await map.until(() => true)).workers).toEqual([]);
  map.close();
  expect(real.store.loaded(real.store.bot(real.botId)!.threadId)).toBe(false);
  expect(Math.max(...waits)).toBeLessThan(50);
});

it("reads an unloaded chat's write rows and notes once across Map reads of clean rows", async () => {
  const real = cleanPanes(200);
  const parse = vi.spyOn(JSON, "parse");
  const post = vi.spyOn(Worker.prototype, "postMessage");
  for (let read = 0; read < 2; read++) {
    const map = await open([], undefined, undefined, real);
    expect((await map.until(() => true)).workers).toEqual([]);
    map.close();
  }
  const here = parse.mock.calls.filter(([text]) => text.includes('"kind":"note"')).length;
  // SAFETY: cold-thread.ts posts each worker request as one object.
  const requests = post.mock.calls.map(([request]) => request as { notesSince?: number; writes?: true });
  parse.mockRestore();
  post.mockRestore();
  expect({ notes: here + 200 * requests.filter(request => request.notesSince === 0).length, writeReads: requests.filter(request => request.writes).length }).toEqual({ notes: 200, writeReads: 1 });
});

it("shows no row for a bot that only chats, or whose edit failed or left no change", async () => {
  const { root } = repo();
  writeFileSync(join(root, "other.ts"), "const someoneElse = 2;\n");
  const map = await open([said("Here is the plan."), edited([join(root, "other.ts")], false), edited([join(root, "file.ts")])]);
  const first = await map.until(() => true);
  map.close();
  expect(first.workers).toEqual([]);
});

it("runs no git for a bot that only chats, on open or on chat events", async () => {
  const { root } = repo();
  writeFileSync(join(root, "file.ts"), "const someoneElse = 2;\n");
  const trace = join(mkdtempSync(join(tmpdir(), "wink-map-trace-")), "git.jsonl");
  roots.push(join(trace, ".."));
  // Git logs each of its own runs here, so the count needs no stand-in for git.
  vi.stubEnv("GIT_TRACE2_EVENT", trace);
  const map = await open([said("Here is the plan.")], root);
  expect((await map.until(() => true)).workers).toEqual([]);
  for (let event = 0; event < 5; event++) map.add({ id: `m${++id}`, at: Date.now(), role: "bot", kind: "activity", tool: { name: "Bash", ok: true } });
  await new Promise(done => setTimeout(done, 300));
  expect(existsSync(trace)).toBe(false);
  map.add(edited([join(root, "file.ts")]));
  await map.until(data => data.workers.length === 1);
  map.close();
  expect(existsSync(trace)).toBe(true);
});

it("keeps the row through a commit on a branch and drops it once the work is on the trunk", async () => {
  const { root, git } = repo();
  git("checkout", "-qb", "work");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "own.ts"), "const own = 1;\n");
  const map = await open([edited(["src/own.ts"])], root);
  await map.until(data => data.workers[0]?.files.length === 1);
  git("add", ".");
  git("commit", "-qm", "own work");
  const committed = await map.until(data => data.workers.length === 1);
  expect(committed.workers[0].files.map(file => file.path)).toEqual(["src/own.ts"]);
  const flow = await fetch(`${map.url}/flow?worker=${committed.workers[0].id}`).then(res => res.json());
  expect(flow).toMatchObject({ branch: "work", commits: [expect.objectContaining({ subject: "own work" })] });
  git("checkout", "-q", "main");
  git("merge", "-q", "--ff-only", "work");
  await map.until(data => data.workers.length === 0);
  map.close();
});

it("keeps an unpushed commit on the trunk and drops the row when the push lands, with no file edit", async () => {
  const { root, git } = repo();
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(root, "file.ts"), "const shipped = 2;\n");
  const map = await open([edited([join(root, "file.ts")])]);
  await map.until(data => data.workers[0]?.files.length === 1);
  git("commit", "-qam", "on main");
  const committed = await map.until(() => true);
  expect(committed.workers.map(worker => worker.files.map(file => file.path))).toEqual([["file.ts"]]);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  await map.until(data => data.workers.length === 0);
  map.close();
});

it("reads relative writes in the task's pinned folder, not a bot folder set since", async () => {
  const { root } = repo();
  const moved = mkdtempSync(join(tmpdir(), "wink-map-moved-"));
  roots.push(moved);
  writeFileSync(join(root, "file.ts"), "const pinned = 2;\n");
  const map = await open([edited(["file.ts"])], moved, { cwd: root });
  const shown = await map.until(data => data.workers.length > 0);
  map.close();
  expect(shown.workers[0].files.map(file => file.path)).toEqual(["file.ts"]);
});

it("drops a linked worktree's row when its branch is merged from the main checkout", async () => {
  const { git } = repo();
  const tree = join(mkdtempSync(join(tmpdir(), "wink-map-tree-")), "work");
  roots.push(join(tree, ".."));
  git("worktree", "add", "-q", "-b", "work", tree);
  writeFileSync(join(tree, "file.ts"), "const branch = 2;\n");
  const map = await open([edited([join(tree, "file.ts")])]);
  await map.until(data => data.workers[0]?.files.length === 1);
  execFileSync("git", ["-C", tree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "branch work"], { windowsHide: true });
  await map.until(data => data.workers.length === 1);
  git("merge", "-q", "--ff-only", "work");
  await map.until(data => data.workers.length === 0);
  map.close();
});
