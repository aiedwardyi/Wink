import { execFileSync } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { MapSnapshot } from "../shared/map-pane.ts";
import { listenLocal } from "./phone-relay/testing/net.ts";
import { createWorkerMap } from "./map-pane.ts";
import type { Message, Store, StoreChange } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { completedTool } from "./tool-activity.ts";
import { insertMessage, messageDatabase } from "./message-db.ts";
import { DATA_DIR } from "./config.ts";

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

async function open(messages: Message[], cwd?: string, task?: { cwd?: string | null }) {
  const listeners: ((change: StoreChange) => void)[] = [];
  mkdirSync(DATA_DIR, { recursive: true });
  const thread = `map-self-${++id}`;
  for (const message of messages) insertMessage(thread, message);
  const wholeThread = vi.fn(() => messages);
  // SAFETY: the worker map reads only these four store members.
  const store = {
    bot: () => ({ id: "bot", name: "Teacher", threadId: thread, cwd }),
    taskByThread: () => task,
    messagesFor: wholeThread,
    onChange: (listener: (change: StoreChange) => void) => { listeners.push(listener); return () => {}; },
  } as unknown as Store;
  const feature = createWorkerMap(store, () => null);
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/live") streams.push(res);
    void feature.handle(req, res, "bot", url.pathname.slice(1), url);
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
  const add = (message: Message) => { messages.push(message); insertMessage(thread, message); for (const listener of listeners) listener({ type: "message", threadId: thread, message }); };
  return { url, until, add, wholeThread, close: () => abort.abort() };
}

it("reads a bounded tail on open and sync while preserving seeded rows", async () => {
  const { root } = repo();
  writeFileSync(join(root, "file.ts"), "const after = 2;\n");
  mkdirSync(DATA_DIR, { recursive: true });
  const database = messageDatabase();
  const prepare = vi.spyOn(database, "prepare");
  const map = await open([said("Start"), edited([join(root, "file.ts")]), said("Done")]);
  const first = await map.until(data => data.workers.length === 1);
  expect(first.workers.map(worker => [worker.nick, worker.files.map(file => file.path)])).toEqual([["Teacher", ["file.ts"]]]);
  writeFileSync(join(root, "new.ts"), "const fresh = 1;\n");
  map.add(edited([join(root, "new.ts")]));
  await map.until(data => data.workers[0]?.files.some(file => file.path === "new.ts"));
  expect(map.wholeThread).not.toHaveBeenCalled();
  const query = prepare.mock.calls.map(([sql]) => sql).find(sql => /ORDER BY rowid DESC LIMIT 2000/.test(sql));
  expect(query).toBeDefined();
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all("thread");
  expect(JSON.stringify(plan)).toContain("messages_thread");
  prepare.mockRestore();
  map.close();
});

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
