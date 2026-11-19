import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { MapSnapshot } from "../shared/map-pane.ts";
import { listenLocal } from "./phone-relay/testing/net.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { createWorkerMap } from "./map-pane.ts";
import { DATA_DIR } from "./config.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { Store, type BotRecord, type Message, type StoreChange } from "./store.ts";
import { messageDatabase, withMessageTransaction } from "./message-db.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { completedTool } from "./tool-activity.ts";
import type { SyncChange } from "./thread-sync-v2.ts";

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

it("reads only the rows that wrote files, then loads a long chat off the server thread", async () => {
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
  const messagesFor = store.messagesFor.bind(store);
  const cold: string[] = [];
  vi.spyOn(store, "messagesFor").mockImplementation(threadId => {
    if (!store.loaded(threadId)) cold.push(threadId);
    return messagesFor(threadId);
  });
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  const shown = await map.until(data => data.workers.length > 0);
  map.close();
  expect(shown.workers[0].files.map(file => file.path).sort()).toEqual(["file.ts", "other.ts"]);
  await vi.waitFor(() => expect(store.loaded(bot.threadId)).toBe(true));
  expect(cold).toEqual([]);
  expect(store.messagesFor(bot.threadId)).toEqual(setup.messagesFor(bot.threadId));
});

// A chat several pages long that wrote a file, open in Map from a store that has not loaded it, its load's page reads held until `release`.
async function loadingChat(more?: (setup: Store, bot: BotRecord) => void) {
  const { root } = repo();
  rmSync(DATA_DIR, { recursive: true, force: true });
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  writeFileSync(join(root, "file.ts"), "const first = 2;\n");
  const { id: _id, at: _at, ...row } = edited([join(root, "file.ts")]);
  setup.appendMessage(bot.threadId, row);
  for (let n = 0; n < 5_000; n++) setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `step ${n}` });
  more?.(setup, bot);
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const post = Worker.prototype.postMessage;
  const held: Array<() => void> = [];
  let holding = true;
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, request: { threadId?: string; after?: number }, transfer) {
    if (holding && request.threadId === bot.threadId && request.after !== undefined) held.push(() => post.call(this, request, transfer));
    else post.call(this, request, transfer);
  });
  onTestFinished(() => spy.mockRestore());
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  await map.until(data => data.workers.length > 0);
  map.close();
  await vi.waitFor(() => expect(held).toHaveLength(1));
  const release = () => {
    holding = false;
    for (const read of held.splice(0)) read();
  };
  return { store, bot, release };
}

function sendRoute(store: Store, startTurn: (botId: string, text: string, opts: { sendId?: string }) => Promise<unknown>, pullSyncedThread: () => void) {
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, store, threadSyncGate: { enabled: false }, sendSequencer: new SendSequencer(), startTurn, pullSyncedThread, noteTalked: noop,
    ensureChatLatency: noop, markChatLatency: noop, resolveReplyTarget: () => undefined, botHasActiveTurn: () => false, instanceForBot: () => null,
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  return async (botId: string, body: object) => {
    let status = 0;
    let data: Record<string, any> = {};
    const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
    await routes.send(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", botId] as RegExpMatchArray);
    return { status, data };
  };
}

it("starts a send made while Map loads the chat before the load lands", async () => {
  const { store, bot, release } = await loadingChat();
  const loadedAtTurn: boolean[] = [];
  // the load runs on from the send's pull, so a route that waits for it fails here rather than hangs
  const send = sendRoute(store, async (_botId, text, { sendId }) => {
    loadedAtTurn.push(store.loaded(bot.threadId));
    return { message: store.appendMessage(bot.threadId, { role: "user", kind: "text", text, sendId }) };
  }, release);
  const sendId = randomUUID();
  const { status, data } = await send(bot.id, { text: "sent right after Map opened", sendId });
  expect(loadedAtTurn).toEqual([false]);
  expect(status).toBe(202);
  await vi.waitFor(() => expect(store.loaded(bot.threadId)).toBe(true));
  expect(store.messagesFor(bot.threadId).filter(message => message.sendId === sendId).map(message => message.id)).toEqual([data.message.id]);
  expect(store.activeLeaf(bot.threadId)).toBe(data.message.id);
});

it("answers a retry of a send stored before Map opened by its key while Map loads the chat", async () => {
  const sendId = randomUUID();
  let stored: Message | undefined;
  const { store, bot, release } = await loadingChat((setup, made) => {
    stored = setup.appendMessage(made.threadId, { role: "user", kind: "text", text: "sent before Map opened", sendId });
  });
  const startTurn = vi.fn(async () => ({}));
  const send = sendRoute(store, startTurn, release);
  const retry = await send(bot.id, { text: "sent before Map opened", sendId });
  expect(store.loaded(bot.threadId)).toBe(false);
  expect(retry).toMatchObject({ status: 202, data: { message: { id: stored!.id } } });
  await expect(send(bot.id, { text: "something else", sendId })).rejects.toMatchObject({ status: 409 });
  expect(startTurn).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(store.loaded(bot.threadId)).toBe(true));
});

it("answers a slim switch back to a chat Map is loading without reading it, and sends its frame only while the bot is on it", async () => {
  let sibling = "";
  const { store, bot, release } = await loadingChat((setup, made) => {
    sibling = setup.createTask(made.id, "Sibling", false)!.threadId;
  });
  const frames: Array<[string, boolean]> = [];
  const projection = (shown: BotRecord) => {
    frames.push([shown.threadId, store.loaded(shown.threadId)]);
    return { threadId: shown.threadId, rows: store.messagesFor(shown.threadId).length };
  };
  const broadcast = vi.fn();
  const routes = createBotChatRoutes({
    store, routines: { activeRunForBot: () => undefined }, threadSyncGate: { enabled: false }, pullSyncedThread: () => {}, broadcast,
    wireBot: (shown: BotRecord) => ({ threadId: shown.threadId }), wireTask: (task: { threadId: string }) => ({ threadId: task.threadId }),
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  const switchTo = async (threadId: string) => {
    let data: Record<string, any> = {};
    const res = { writeHead: () => {}, setHeader: () => {}, end: (raw: string) => { data = JSON.parse(raw); } } as unknown as ServerResponse;
    await routes.switchTask(res, ["", bot.id, threadId] as RegExpMatchArray, new URL("http://localhost/?messages=0"), projection);
    return data.bot.threadId;
  };
  const chat = () => frames.filter(([threadId]) => threadId === bot.threadId);
  expect(await switchTo(sibling)).toBe(sibling);
  expect(await switchTo(bot.threadId)).toBe(bot.threadId);
  expect(chat()).toEqual([]);
  expect(await switchTo(sibling)).toBe(sibling);
  release();
  await vi.waitFor(() => expect(store.loaded(bot.threadId)).toBe(true));
  // the bot left the chat before it loaded, so that frame was never built
  expect(chat()).toEqual([]);
  expect(await switchTo(bot.threadId)).toBe(bot.threadId);
  expect(chat()).toEqual([[bot.threadId, true]]);
  expect(broadcast.mock.calls.map(([payload]) => payload.bot.threadId)).toEqual([sibling, sibling, bot.threadId]);
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
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  const shown = await map.until(data => data.workers.length === 2);
  map.close();
  // SAFETY: cold-thread.ts posts each worker request as one object.
  const since = post.mock.calls.map(([request]) => (request as { notesSince?: number }).notesSince).filter(at => at !== undefined);
  post.mockRestore();
  expect(shown.workers.map(worker => worker.reason)).toEqual([undefined, undefined]);
  // the chat then loads once off the server thread; the reason reads ask only for notes since each edit
  expect(since.filter(at => at < Date.now() - 30_000)).toEqual([]);
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
  await vi.waitFor(() => expect(loaded(real.store.bot(real.botId)!.threadId)).toBe(true));
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
  // the chat then loads once, parsing each note here, so the reason may come from the loaded chat
  expect(requests.filter(request => request.notesSince === 0).length).toBeLessThanOrEqual(1);
  expect(here).toBeLessThanOrEqual(200);
  expect(requests.filter(request => request.writes).length).toBe(1);
});

// A peer's row change as applySyncChanges takes it: the chat keeps its row count and newest row.
const synced = (message: Message): SyncChange => ({ cursor: 0, kind: "row", rowId: message.id, value: message, conflict: false });
const selfRow = (root: string) => `self-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;

it("moves the bot's row when a synced patch moves its write to another checkout of an unloaded chat", async () => {
  const [a, b] = [repo().root, repo().root];
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const root of [a, b]) writeFileSync(join(root, "file.ts"), "const edited = 2;\n");
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  const { id: _id, at: _at, ...row } = edited([join(a, "file.ts")]);
  const wrote = setup.appendMessage(bot.threadId, row);
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  expect((await map.until(data => data.workers.length > 0)).workers.map(worker => worker.id)).toEqual([selfRow(a)]);
  store.applySyncChanges(bot.id, bot.threadId, [synced({ ...wrote, tool: { ...wrote.tool!, writes: [join(b, "file.ts")] } })]);
  expect((await map.until(data => data.workers[0]?.id !== selfRow(a))).workers.map(worker => worker.id)).toEqual([selfRow(b)]);
  map.close();
});

it("shows the bot's row once a synced completion gives a pending tool of an unloaded chat its write", async () => {
  const { root } = repo();
  rmSync(DATA_DIR, { recursive: true, force: true });
  writeFileSync(join(root, "file.ts"), "const edited = 2;\n");
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  const pending = setup.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "Edit" } });
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  expect((await map.until(() => true)).workers).toEqual([]);
  store.applySyncChanges(bot.id, bot.threadId, [synced({ ...pending, tool: edited([join(root, "file.ts")]).tool })]);
  expect((await map.until(data => data.workers.length > 0)).workers.map(worker => worker.id)).toEqual([selfRow(root)]);
  map.close();
});

it("follows the bot to a new task mid-turn, and back to the chat whose tool completed meanwhile", async () => {
  const [a, b] = [repo().root, repo().root];
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const root of [a, b]) writeFileSync(join(root, "file.ts"), "const edited = 2;\n");
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  const pending = setup.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "Edit" } });
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  expect((await map.until(() => true)).workers).toEqual([]);
  const task = store.createTask(bot.id)!;
  const { id: _id, at: _at, ...row } = edited([join(b, "file.ts")]);
  store.appendMessage(task.threadId, row);
  expect((await map.until(data => data.workers.length > 0)).workers.map(worker => worker.id)).toEqual([selfRow(b)]);
  store.patchMessage(bot.threadId, pending.id, { tool: edited([join(a, "file.ts")]).tool });
  store.switchTask(bot.id, bot.threadId);
  store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "Read" } });
  expect((await map.until(data => data.workers[0]?.id !== selfRow(b))).workers.map(worker => worker.id)).toEqual([selfRow(a)]);
  map.close();
});

it("shows a write a sync pull commits after the Map refresh it set off inside its transaction", async () => {
  const { root } = repo();
  rmSync(DATA_DIR, { recursive: true, force: true });
  writeFileSync(join(root, "file.ts"), "const edited = 2;\n");
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  setup.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "before the pull" });
  const others = [setup.createBot({}, { seedMessages: false }), setup.createBot({}, { seedMessages: false })];
  for (const other of others) setup.appendMessage(other.threadId, { role: "bot", kind: "text", text: "elsewhere" });
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }), { threadCacheChars: 1 });
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  expect((await map.until(() => true)).workers).toEqual([]);
  await vi.waitFor(() => expect(store.loaded(bot.threadId)).toBe(true));
  for (const other of others) store.messagesFor(other.threadId);
  expect(store.loaded(bot.threadId)).toBe(false);
  const post = Worker.prototype.postMessage;
  const inside: boolean[] = [];
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, request: { threadId?: string }, transfer) {
    if (request.threadId === bot.threadId) inside.push(messageDatabase().isTransaction);
    post.call(this, request, transfer);
  });
  const { id: _id, at: _at, ...row } = edited([join(root, "file.ts")]);
  const history = Array.from({ length: 100 }, (_, n): Message => ({ id: `history-${n}`, at: Date.now(), role: "user", kind: "text", text: "sync history" }));
  // a v2 pull applies each page inside its own transaction, as consume does
  withMessageTransaction(() => store.applySyncChanges(bot.id, bot.threadId, [synced({ ...row, id: "peer-edit", at: Date.now() }), ...history.map(synced)]));
  spy.mockRestore();
  expect(inside).not.toContain(true);
  const shown = await map.until(data => data.workers.length > 0);
  map.close();
  expect(shown.workers.map(worker => [worker.id, worker.files.map(file => file.path)])).toEqual([[selfRow(root), ["file.ts"]]]);
});

it("reads nothing off the server thread for a bot on a brand-new task", async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const setup = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = setup.createBot({}, { seedMessages: false });
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const map = await open([], undefined, undefined, { store, botId: bot.id });
  expect((await map.until(() => true)).workers).toEqual([]);
  map.close();
  // SAFETY: cold-thread.ts posts each worker request as one object.
  const reads = post.mock.calls.filter(([request]) => (request as { threadId?: string }).threadId === bot.threadId);
  post.mockRestore();
  expect(reads).toEqual([]);
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
