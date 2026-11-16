import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { deliverMailboxOutbox } from "./mailbox-outbox.mjs";
import { createPaneRuns } from "./pane-runs.mjs";
import { createServerRevival } from "./server-revival.mjs";
import { createTerminalHost } from "./terminal-host.mjs";
import { createWorkerSession } from "./worker-session.mjs";
import { adoptWorkers } from "./worker-host-adopt.mjs";
import { installOrbitMsg } from "./terminal-mailbox.mjs";
import { Store } from "../server/store.ts";
import { createMailboxReceipts } from "../server/mailbox-receipts.ts";
import { closeMessageDb } from "../server/message-db.ts";
import { receiveMailboxPost } from "../server/mailbox-delivery.ts";
import { mailboxGrant } from "../server/mailbox.ts";
import { Readable } from "node:stream";

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
});

async function fixture(handler = (_req, res) => res.end("{}")) {
  const profile = await fs.mkdtemp(path.join(os.homedir(), "late-review-"));
  const dir = path.join(profile, "mailbox-outbox");
  await fs.mkdir(dir);
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const scope = { pane: "pane", bot: "bot", teacher: "bot" };
  const write = async (at = Date.now()) => {
    const file = path.join(dir, `${at}-${randomUUID()}.json`);
    await fs.writeFile(file, JSON.stringify({ headers: { authorization: "Bearer fixture", "x-orbit-pane": scope.pane, "x-orbit-bot": scope.bot, "x-orbit-teacher": scope.teacher }, payload: { messageId: randomUUID(), sentAt: at, queued: true, text: "finished", kind: "report" } }));
    return file;
  };
  return { profile, dir, url, scope, write };
}

async function sendReport(profile, url) {
  const bin = await installOrbitMsg(path.join(profile, "bin"), "win32", profile);
  return new Promise(resolve => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(bin, "orbit-msg.ps1"), "--report", "DONE", "FIXTURE", "finished"], { windowsHide: true, env: { ...process.env, ORBIT_URL: url, ORBIT_MSG_AUTH: "fixture", ORBIT_PANE: "pane", ORBIT_BOT: "bot", ORBIT_TEACHER: "bot", ORBIT_REPORT_SIGNAL: "" } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}

it.skipIf(process.platform !== "win32")("retains a report when reading fails but deletion is allowed", async () => {
  const f = await fixture();
  const file = await f.write();
  const script = `$lock = [IO.File]::Open('${file.replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Delete); [Console]::Out.WriteLine('locked'); [void][Console]::In.ReadLine(); $lock.Dispose()`;
  const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  const exited = new Promise(resolve => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => { child.once("error", reject); child.stdout.on("data", chunk => { if (String(chunk).includes("locked")) resolve(); }); });
    await deliverMailboxOutbox(f.profile, f.url);
    expect(await fs.readdir(f.dir)).toContain(path.basename(file));
  } finally { child.stdin.end("release\n"); await exited; }
  expect((await deliverMailboxOutbox(f.profile, f.url)).delivered).toBe(1);
});

it("checkpoints retirement while the acknowledged queue record still exists", async () => {
  const f = await fixture();
  const file = await f.write();
  const ledger = path.join(f.profile, "pane-runs.json");
  await fs.writeFile(ledger, JSON.stringify([{ id: "pane", botId: "bot", teacher: "bot", state: "running" }]));
  const runs = createPaneRuns(ledger);
  let existsAtRetirement = false;
  const checkpoint = { ...runs, closed: async id => {
    existsAtRetirement = (await fs.readdir(f.dir)).includes(path.basename(file));
    const saved = runs.closed(id);
    expect(createPaneRuns(ledger).restarted().size).toBe(0);
    return saved;
  } };
  expect((await deliverMailboxOutbox(f.profile, f.url, checkpoint)).delivered).toBe(1);
  expect(existsAtRetirement).toBe(true);
});

it("retains the queue record when retirement cannot be checkpointed", async () => {
  const f = await fixture();
  const file = await f.write();
  const runs = { restarted: () => new Map([["bot", [{ id: "pane", botId: "bot", teacher: "bot" }]]]), closed: () => false };
  const result = await deliverMailboxOutbox(f.profile, f.url, runs);
  expect(result.delivered).toBe(0);
  expect(result.pendingReports).toEqual([f.scope]);
  expect(await fs.readdir(f.dir)).toContain(path.basename(file));
});

it("bounds the whole drain and preserves unfinished reports", async () => {
  const f = await fixture((_req, res) => { setTimeout(() => res.end("{}"), 80); });
  for (let i = 0; i < 3; i++) await f.write(Date.now() - i);
  const result = await deliverMailboxOutbox(f.profile, f.url, undefined, { budgetMs: 120 });
  expect(result.delivered).toBeLessThan(3);
  expect((await fs.readdir(f.dir)).length).toBeGreaterThan(0);
});

it.skipIf(process.platform !== "win32")("uses discovery after an old profile port rejects the grant", async () => {
  let posts = 0;
  const current = await fixture((_req, res) => { posts++; res.end("{}"); });
  const stale = await fixture((_req, res) => res.writeHead(401).end());
  await fs.writeFile(path.join(current.profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: current.url }));
  const result = await sendReport(current.profile, stale.url);
  expect(result.code, result.stderr).toBe(0);
  expect(posts).toBe(1);
});

it.skipIf(process.platform !== "win32")("still tries a known published URL when the old port changes from 503 to 401", async () => {
  let currentPosts = 0;
  let stalePosts = 0;
  const current = await fixture((_req, res) => res.writeHead(++currentPosts === 1 ? 503 : 200).end("{}"));
  const stale = await fixture((_req, res) => res.writeHead(++stalePosts === 1 ? 503 : 401).end());
  await fs.writeFile(path.join(current.profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: current.url }));
  const result = await sendReport(current.profile, stale.url);
  expect(result.code, result.stderr).toBe(0);
  expect(currentPosts).toBe(2);
});

async function startup(overrides = {}) {
  const source = await fs.readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("    const mailboxUrl = `http://127.0.0.1:${app.isPackaged"), source.indexOf("  // The companion the user left on"));
  const body = block.slice(0, block.lastIndexOf("\n  }")).replace("void adoptWorkers(", "return adoptWorkers(");
  const calls = [];
  const deps = { app: { isPackaged: true, getPath: () => "profile" }, SERVER_PORT: 8799, serverReady: true, terminalBridgeAccess: null, publishTerminalDiscovery() {}, deliverMailboxOutbox: async () => { calls.push("drain"); return { reports: [], pendingReports: [] }; }, paneRuns: { restarted: () => new Map() }, recoverWorkers: async () => { calls.push("recover"); }, adoptWorkers: async ({ recover }) => recover(new Map()), workerHost: {}, paneBotNames() {}, terminalHost: {}, paneMailbox() {}, postPaneNote() {}, slog(error) { throw error; }, ...overrides };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(...Object.keys(deps), body)(...Object.values(deps));
  return calls;
}

it("drains once more after recovery writes a report beyond the first snapshot", async () => {
  const f = await fixture();
  const calls = await startup({ app: { isPackaged: true, getPath: () => f.profile }, SERVER_PORT: Number(new URL(f.url).port), deliverMailboxOutbox, recoverWorkers: async () => { await f.write(); } });
  expect(calls).toEqual([]);
  expect(await fs.readdir(f.dir)).toEqual([]);
  expect(await startup()).toEqual(["drain", "recover", "drain"]);
});

it("holds unfinished report panes during recovery and retries them in the follow-up pass", async () => {
  let status = 503;
  const f = await fixture((_req, res) => res.writeHead(status).end("{}"));
  await f.write();
  const ledger = path.join(f.profile, "pane-runs.json");
  await fs.writeFile(ledger, JSON.stringify([{ id: "pane", botId: "bot", teacher: "bot", state: "running" }, { id: "other", botId: "bot", teacher: "bot", state: "running" }]));
  const runs = createPaneRuns(ledger);
  await startup({ app: { isPackaged: true, getPath: () => f.profile }, SERVER_PORT: Number(new URL(f.url).port), deliverMailboxOutbox, paneRuns: runs, recoverWorkers: async ({ runs: recovering }) => {
    expect(recovering.restarted().get("bot").map(run => run.id)).toEqual(["other"]);
    recovering.forget("bot");
    expect(runs.restarted().get("bot").map(run => run.id)).toEqual(["pane"]);
    status = 200;
  } });
  expect(runs.restarted().size).toBe(0);
  expect(await fs.readdir(f.dir)).toEqual([]);
});

it("adopts what the worker host kept and restarts only panes that are gone with no queued report", async () => {
  let status = 503;
  const f = await fixture((req, res) => res.writeHead(req.headers["x-orbit-pane"] === "pane" ? status : 200).end("{}"));
  await f.write();
  f.scope.pane = "kept";
  await f.write();
  const ledger = path.join(f.profile, "pane-runs.json");
  await fs.writeFile(ledger, JSON.stringify(["kept", "pane", "ended", "gone"].map(id => ({ id, botId: "bot", teacher: "bot", state: id === "ended" ? "ended" : "running", kept: id !== "gone" }))));
  const runs = createPaneRuns(ledger);
  const ids = bots => [...bots.values()].flat().map(run => run.id).sort();
  expect(ids(runs.restarted())).toEqual(["gone", "kept", "pane"]);
  const adopted = [];
  const dropped = [];
  const restarted = [];
  const workerHost = { left: () => "kept", prewarm: async () => true, panes: async () => [{ id: "kept" }], attach: () => ({ pty: { detach() {}, onData() {}, onExit() {}, onError() {} }, replayed: Promise.resolve() }), drop: id => dropped.push(id), state: () => ({}) };
  const terminalHost = { adoptPane: run => { adopted.push(run.id); runs.adopted(run.id); return Promise.resolve({ running: true, busy: false, exitCode: null, reported: false }); }, closeForBot: async () => {} };
  await startup({ app: { isPackaged: true, getPath: () => f.profile }, SERVER_PORT: Number(new URL(f.url).port), deliverMailboxOutbox, adoptWorkers, workerHost, terminalHost, paneRuns: runs, paneMailbox: async () => null, paneBotNames: async () => null, recoverWorkers: async ({ runs: recovering, kept }) => {
    expect([...kept.keys()]).toEqual(["bot"]);
    restarted.push(ids(recovering.restarted()));
    recovering.forget("bot");
    status = 200;
  } });
  expect([adopted, dropped, restarted]).toEqual([["kept"], [], [["gone"]]]);
  expect(runs.restarted().size).toBe(0);
  expect(JSON.parse(await fs.readFile(ledger, "utf8")).map(run => run.id)).toEqual(["kept"]);
  expect(await fs.readdir(f.dir)).toEqual([]);
});

it.each([undefined, { pendingReports: [], unreadable: true }])("holds prior panes when the drain cannot identify queued reports (%j)", async result => {
  const held = new Set();
  const calls = await startup({ paneRuns: { restarted: excluded => new Map(excluded?.has("pane") ? [] : [["bot", [{ id: "pane", botId: "bot" }]]]) }, deliverMailboxOutbox: async () => result, recoverWorkers: async ({ runs }) => { for (const panes of runs.restarted().values()) for (const pane of panes) held.add(pane.id); } });
  expect(held.size).toBe(0);
  expect(calls).toEqual([]);
});

it.skipIf(process.platform !== "win32")("does not send an authentication rejection to fallback ports without a new published URL", async () => {
  const f = await fixture((_req, res) => res.writeHead(401).end());
  await fs.writeFile(path.join(f.profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: f.url }));
  const result = await sendReport(f.profile, f.url);
  expect(result.code).toBe(1);
  expect(await fs.readdir(f.dir)).toEqual([]);
});

it.skipIf(process.platform !== "win32")("keeps validation failures final even with a different published URL", async () => {
  let posts = 0;
  const current = await fixture((_req, res) => { posts++; res.end("{}"); });
  const stale = await fixture((_req, res) => res.writeHead(400).end());
  await fs.writeFile(path.join(current.profile, "terminal-discovery.json"), JSON.stringify({ mailboxUrl: current.url }));
  expect((await sendReport(current.profile, stale.url)).code).toBe(1);
  expect(posts).toBe(0);
});

async function revival(overrides = {}) {
  const source = await fs.readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const reviveServer = createServerRevival({");
  // A Windows checkout ends lines with CRLF, so the end marker cannot include the trailing newline.
  const block = source.slice(start, source.indexOf("\n});", start) + "\n});".length);
  const deps = { createServerRevival, quitting: false, verifyProbe: false, childEnvCredentials: null, absorbPackagedPlaintextSecrets() {}, secureCredentials: {}, startServerPackaged: async () => true, slog() {}, serverReady: false, serverKeptStopping: false, packagedBootPhase: null, BOOT_CONNECTING: 0, BOOT_READY: 1, BOOT_FAILED: 2, pushGoogleSession: async () => {}, livePackagedWindow: () => null, connectingPageHref() {}, packagedWindowHref() {}, app: { getPath: () => "profile" }, SERVER_PORT: 8799, terminalBridgeAccess: null, publishTerminalDiscovery: async () => {}, deliverMailboxOutbox: async () => ({}), paneRuns: { restarted: () => new Map() }, ...overrides };
  return new Function(...Object.keys(deps), `${block}return reviveServer;`)(...Object.values(deps));
}

it("delivers reports queued while the server was down once it revives", async () => {
  const f = await fixture();
  await f.write();
  const drains = [];
  const revive = await revival({ app: { getPath: () => f.profile }, SERVER_PORT: Number(new URL(f.url).port), deliverMailboxOutbox: (...args) => { const drain = deliverMailboxOutbox(...args); drains.push(drain); return drain; } });
  expect(await revive()).toBe(true);
  await Promise.all(drains);
  expect(drains).toHaveLength(1);
  expect(await fs.readdir(f.dir)).toEqual([]);
});

it("does not run a follow-up drain when the server is unavailable", async () => {
  const calls = await startup({ serverReady: false });
  expect(calls).toEqual(["recover"]);
});

it("a fresh terminal host authenticates a surviving pane against its saved launch", async () => {
  const f = await fixture();
  const file = path.join(f.profile, "pane-runs.json");
  const worker = { kind: "managed", args: [], account: { id: "account", generation: 1 }, session: { engine: "codex", launchGeneration: randomUUID(), nativeId: null } };
  const capture = createWorkerSession(worker, "pane", f.profile, f.url);
  const runs = createPaneRuns(file);
  runs.started({ id: "pane", botId: "bot", teacher: "bot", cwd: f.profile, session: capture.run });
  const restored = createPaneRuns(file);
  const host = createTerminalHost({ authorize() {}, resolveCwd: async () => f.profile, paneRuns: restored });
  const input = { pane: "pane", launchGeneration: capture.run.launchGeneration, session_id: randomUUID(), transcript_path: null, cwd: f.profile, source: "resume" };
  try {
    expect(host.captureWorkerSession("Bearer wrong", input)).toBe(false);
    expect(host.captureWorkerSession(`Bearer ${capture.auth}`, { ...input, launchGeneration: "wrong" })).toBe(false);
    expect(host.captureWorkerSession(`Bearer ${capture.auth}`, input)).toBe(true);
    expect(createPaneRuns(file).restarted().get("bot")[0].session.nativeId).toBe(input.session_id);
  } finally { host.dispose(); }
});

const OSC = String.fromCharCode(27) + "]133;";
const BEL = String.fromCharCode(7);
const LINE = createHash("sha256").update("work").digest("base64");

// A pane the worker host kept, taken back by a fresh terminal host; `replay` is its old output.
async function adoptedPane({ replay = "", notes = [] } = {}) {
  const f = await fixture();
  const file = path.join(f.profile, "pane-runs.json");
  const worker = { kind: "managed", args: [], account: { id: "account", generation: 1 }, session: { engine: "codex", launchGeneration: randomUUID(), nativeId: null } };
  const capture = createWorkerSession(worker, "pane", f.profile, f.url);
  createPaneRuns(file).started({ id: "pane", botId: "bot", teacher: "bot", cwd: f.profile, session: capture.run });
  const runs = createPaneRuns(file);
  const data = new Set();
  const pty = { pid: 4242, onData: listener => data.add(listener), onExit() {}, onError() {}, ready: Promise.resolve(), exited: new Promise(() => {}), write: async () => {}, resize: async () => {}, kill: async () => {}, terminate() {}, hosted: () => true, detach: () => true };
  const emit = text => { for (const listener of data) listener(text); };
  const owner = { id: 7, mainFrame: {}, isDestroyed: () => false, send() {} };
  const host = createTerminalHost({ authorize() {}, resolveCwd: async () => f.profile, owner: () => owner, paneRuns: runs, stallCheckMs: 5, notePane: async (_mail, _scope, text) => { notes.push(text); } });
  let replayed;
  const outcome = host.adoptPane(runs.left()[0], { cols: 80, rows: 24, start: 1, mark: { kind: "C", value: `pane;${LINE}` } }, { pty, replayed: new Promise(resolve => { replayed = resolve; }) }, {});
  emit(replay);
  replayed();
  return { host, capture, emit, notes, profile: f.profile, result: await outcome };
}

it("a kept command that ended during its replay is not kept running", async () => {
  const { host, result } = await adoptedPane({ replay: `${OSC}C;pane;${LINE}${BEL}work${OSC}D;pane;3${BEL}` });
  try {
    expect([result.running, result.exitCode]).toEqual([false, null]);
  } finally { host.dispose(); }
});

it("a kept command that ends after adoption tells its bot it finished", async () => {
  const { host, emit, notes, result } = await adoptedPane({ replay: `${OSC}D;pane;2${BEL}${OSC}C;pane;${LINE}${BEL}work` });
  try {
    expect(result.running).toBe(true);
    emit(`done${OSC}D;pane;3${BEL}`);
    await vi.waitFor(() => expect(notes.some(text => text.startsWith("FINISHED: command ended without a report."))).toBe(true));
  } finally { host.dispose(); }
});

it("a kept worker's late start hook authenticates with the launch it was given", async () => {
  const { host, capture, profile, result } = await adoptedPane();
  const input = { pane: "pane", launchGeneration: capture.run.launchGeneration, session_id: randomUUID(), transcript_path: null, cwd: profile, source: "startup" };
  try {
    expect(result.running).toBe(true);
    expect(host.captureWorkerSession("Bearer wrong", input)).toBe(false);
    expect(host.captureWorkerSession(`Bearer ${capture.auth}`, input)).toBe(true);
  } finally { host.dispose(); }
});

it("benchmark cleanup skips a child that already exited by signal", async () => {
  const source = await fs.readFile(new URL("../scripts/bench-late-reports.mjs", import.meta.url), "utf8");
  const body = source.slice(source.lastIndexOf("} finally {") + "} finally {".length, source.lastIndexOf("}"));
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: "SIGKILL", kill() {} });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const cleanup = new AsyncFunction("children", body)([child]);
  const listeners = child.listenerCount("exit");
  child.emit("exit");
  await cleanup;
  expect(listeners).toBe(0);
});

it("thread adoption keeps local receipt keys across database restart", async () => {
  const store = new Store(() => ({ instanceId: "ghost", model: "ghost" }));
  const bot = store.createBot();
  const receipts = createMailboxReceipts();
  const scope = { pane: "pane", bot: bot.id, teacher: bot.id };
  const messageId = randomUUID();
  await receipts.accept(scope, messageId, async key => ({ ok: true, id: store.appendMessage(bot.threadId, { role: "bot", kind: "note", text: "finished", mailbox: { key } }).id }));
  const local = store.messagesFor(bot.threadId);
  const projected = local.map(({ mailbox: _mailbox, ...row }) => row);
  store.adoptSyncedTask(bot.id, store.activeTask(bot.id), projected, projected[0].id);
  closeMessageDb();
  let writes = 0;
  await createMailboxReceipts().accept(scope, messageId, async () => { writes++; return { ok: true }; });
  expect(writes).toBe(0);
});

it("post-write callbacks keep the delivery thread when attention switches chats", async () => {
  const store = new Store(() => ({ instanceId: "ghost", model: "ghost" }));
  const bot = store.createBot();
  const original = bot.threadId;
  const other = store.createTask(bot.id, "other", false);
  const secret = "a".repeat(64);
  const req = Readable.from([Buffer.from(JSON.stringify({ text: "finished", kind: "report", messageId: randomUUID() }))]);
  req.headers = { authorization: `Bearer ${mailboxGrant(secret, "pane", bot.id, bot.id)}`, "x-orbit-pane": "pane", "x-orbit-bot": bot.id, "x-orbit-teacher": bot.id };
  const threads = [];
  const result = await receiveMailboxPost(req, { secret, store, receipts: createMailboxReceipts(), origin: "fixture", label: async () => null, auto: async () => false, refresh() {}, attention: async () => { store.switchTask(bot.id, other.threadId); }, reported: (_scope, _text, source) => threads.push(source.threadId), notify: source => threads.push(source.threadId), arrived: (_scope, source) => threads.push(source.threadId) });
  expect(result.status).toBe(200);
  expect(threads).toEqual([original, original, original]);
});
