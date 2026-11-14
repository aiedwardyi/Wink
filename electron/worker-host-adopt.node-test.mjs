import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPaneRuns } from "./pane-runs.mjs";
import { createTerminalHost } from "./terminal-host.mjs";
import { adoptWorkers, createReplayPacer, keptNoteText } from "./worker-host-adopt.mjs";
import { createWorkerHostClient } from "./worker-host-client.mjs";
import { sweepWorkerHostRuntime } from "./worker-host-runtime.mjs";
import { recoverWorkers } from "./worker-resume.mjs";

const require = createRequire(import.meta.url);
const windows = process.platform === "win32" ? {} : { skip: "the worker host ships on Windows first" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const remove = (folder) => fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const LOOP = '$n = 0; while ($true) { $l = Read-Host; $n++; Write-Output "LINE$n=$l" }';
const SHORT = 'Start-Sleep -Seconds 20; Write-Output ("WORK=" + (6 * 7))';
const GONE = "Start-Sleep -Seconds 20; exit 3";

async function until(check, timeoutMs = 90_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(25)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error("Timed out waiting for the kept pane");
}

// One run of the app: its own client, pane records and terminal host over a shared data folder.
function app(root, runtimeRoot, { names = null } = {}) {
  const home = path.join(root, "home");
  for (const folder of ["Roaming", "Local"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  const events = [];
  const spawned = [];
  const notes = [];
  const owner = { id: 7, mainFrame: {}, isDestroyed: () => false, send: (channel, value) => events.push([channel, value]) };
  const client = createWorkerHostClient({ root: path.join(root, "data"), runtimeRoot, ptyModule: () => require.resolve("node-pty"), adopt: true });
  const runs = createPaneRuns(path.join(root, "pane-runs.json"));
  const host = createTerminalHost({
    authorize() {},
    resolveCwd: async () => root,
    owner: () => owner,
    env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local"), POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" },
    freeMemory: () => 64 * 1024 ** 3,
    paneRuns: runs,
    hostPty: (request, local) => {
      spawned.push(request.id);
      return client.spawn(request, local);
    },
  });
  const of = (channel) => events.filter(([name]) => name === channel).map(([, value]) => value);
  const text = (id) => of("terminal:data").filter((value) => value.id === id).map((value) => value.data).join("");
  const recover = (kept) => recoverWorkers({ runs, host, mailbox: async () => ({}), notePane: async (mail, scope, note) => { notes.push({ ...scope, text: note }); }, kept, wait: async () => {}, retryMs: 1, tries: 1 });
  const adopt = (options = {}) => adoptWorkers({ client, runs, host, botNames: async () => names, recover, ...options });
  return { client, runs, host, events, spawned, notes, of, text, adopt };
}

if (process.argv[2] === "app") {
  const { root, runtimeRoot, count, command, typed, reported } = JSON.parse(process.argv[3]);
  const first = app(root, runtimeRoot);
  assert.equal(await first.client.prewarm(), true);
  process.send({ host: first.client.state().host.pid });
  const panes = [];
  for (let index = 0; index < count; index++) {
    const botId = `bot-${index % 2}`;
    panes.push({ botId, label: `KEEP-${index}`, ...await first.host.openForBot(botId, { label: `KEEP-${index}`, command: Array.isArray(command) ? command[index] : command }) });
  }
  // Typed too early, a line would go to the shell instead of the command.
  const listed = await until(async () => {
    const list = await first.client.panes();
    return list.length === count && list.every((pane) => pane.mark?.kind === "C") && list;
  });
  for (const pane of panes) {
    if (typed) await first.host.inputBot(pane.botId, { sessionId: pane.sessionId, generation: pane.generation, data: `${typed}\r` });
    if (reported?.includes(pane.label)) first.host.attendBot(pane.botId, pane.sessionId, "report");
  }
  if (typed) await until(() => panes.every((pane) => first.text(pane.sessionId).includes(`LINE1=${typed}`)));
  process.on("message", async () => {
    await first.host.dispose();
    process.exit(0);
  });
  process.send({ panes: panes.map((pane) => ({ ...pane, pid: listed.find((item) => item.id === pane.sessionId).pid })) });
  await new Promise(() => {});
}

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-host-"));
test.after(async () => {
  await sweepWorkerHostRuntime(runtimeRoot, []);
  await remove(runtimeRoot);
});

// The first run of the app is a real process, so it can be quit or killed for real.
async function left(t, { count = 1, end = "quit", command = LOOP, typed = "one", reported = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-adopt-"));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(fileURLToPath(import.meta.url), ["app", JSON.stringify({ root, runtimeRoot, count, command, typed, reported })], { env, execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const gone = new Promise((resolve) => child.once("exit", resolve));
  const first = {};
  const told = new Promise((resolve) => child.on("message", (message) => {
    Object.assign(first, message);
    if (message.panes) resolve();
  }));
  t.after(async () => {
    child.kill();
    await gone;
    // A kept pane keeps its host alive on purpose; a test must not leave either behind.
    if (first.host && alive(first.host)) await until(() => !alive(first.host), 5_000).catch(() => process.kill(first.host));
    await until(() => !first.host || !alive(first.host), 15_000);
    await remove(root);
  });
  await Promise.race([told, gone.then((code) => { throw new Error(`The first app ended early: ${code}`); })]);
  if (end === "quit") child.send("quit");
  else child.kill();
  await gone;
  return { root, ...first };
}

const sorted = (list) => [...list].sort();
const record = (root) => JSON.parse(fs.readFileSync(path.join(root, "pane-runs.json"), "utf8"));
const closeAll = async (run, panes) => {
  for (const pane of panes) await run.host.closeForBot(pane.botId, pane.sessionId).catch(() => {});
  await until(async () => !(await run.client.panes()).length, 30_000);
  await run.host.dispose();
  run.client.close();
};

async function adopted(t, { count, end }) {
  const before = await left(t, { count, end });
  assert.equal(alive(before.host), true);
  assert.deepEqual(before.panes.map((pane) => alive(pane.pid)), before.panes.map(() => true));
  assert.deepEqual(record(before.root).map((run) => [run.state, run.kept === true]), before.panes.map(() => ["running", end === "quit"]));

  const second = app(before.root, runtimeRoot);
  await second.adopt();
  assert.equal(second.client.state().host.pid, before.host);
  assert.deepEqual(second.spawned, []);
  const opened = second.of("terminal:opened");
  assert.deepEqual(sorted(opened.map((pane) => `${pane.id} ${pane.botId} ${pane.label}`)), sorted(before.panes.map((pane) => `${pane.sessionId} ${pane.botId} ${pane.label}`)));
  const listed = await second.client.panes();
  assert.deepEqual(sorted(listed.map((pane) => `${pane.id} ${pane.pid}`)), sorted(before.panes.map((pane) => `${pane.sessionId} ${pane.pid}`)));
  assert.equal(second.host.liveWorkerCount(), count);
  assert.equal(second.host.liveWorkerCount({ closing: true }), 0);
  assert.deepEqual(record(before.root).map((run) => [run.state, run.kept === true]), before.panes.map(() => ["running", false]));

  const bots = sorted(new Set(before.panes.map((pane) => pane.botId)));
  assert.deepEqual(sorted(second.notes.map((note) => note.bot)), bots);
  for (const note of second.notes) {
    const mine = before.panes.filter((pane) => pane.botId === note.bot);
    assert.equal(note.text, `KEPT RUNNING: ${mine.map((pane) => `${pane.label} [pane ${pane.sessionId.slice(0, 8)}] (script) still running`).join("; ")}.`);
  }

  for (const pane of before.panes) {
    const { generation } = opened.find((item) => item.id === pane.sessionId);
    const frames = [];
    const watching = second.host.watchBot(pane.botId, pane.sessionId, { send(frame) { frames.push(frame); return 0; }, drop() {}, end() {} });
    assert.match(watching.snapshot.output, /LINE1=one/);
    await second.host.inputBot(pane.botId, { sessionId: pane.sessionId, generation, data: "two\r" });
    await until(() => second.text(pane.sessionId).includes("LINE2=two"));
    assert.equal(second.text(pane.sessionId).match(/LINE2=two/g).length, 1);
    assert.equal(second.text(pane.sessionId).includes("LINE1=one"), false);
    assert.equal(frames.map((frame) => frame.data ?? "").join("").match(/LINE2=two/g).length, 1);
  }

  await second.adopt();
  assert.equal(second.of("terminal:opened").length, count);
  assert.equal(second.notes.length, bots.length);
  assert.equal(second.host.adoptPane(record(before.root)[0], listed[0], { pty: null, replayed: Promise.resolve() }), null);
  assert.equal((await second.client.panes()).length, count);
  await closeAll(second, before.panes);
  await until(() => before.panes.every((pane) => !alive(pane.pid)), 30_000);
}

for (const end of ["quit", "kill"]) {
  for (const count of [1, 20]) {
    test(`${count} pane(s) left by a ${end} of the app come back with their screen, input and process`, { ...windows, timeout: 300_000 }, (t) => adopted(t, { count, end }));
  }
}

for (const count of [1, 20]) {
  test(`${count} pane(s) end when the host dies under an open app, and the next start brings none of them back`, { ...windows, timeout: 300_000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-adopt-"));
    const first = app(root, runtimeRoot);
    const hosts = [];
    t.after(async () => {
      await first.host.dispose();
      first.client.close();
      await until(() => hosts.every((pid) => !alive(pid)), 15_000).catch(() => { for (const pid of hosts) if (alive(pid)) process.kill(pid); });
      await remove(root);
    });
    assert.equal(await first.client.prewarm(), true);
    hosts.push(first.client.state().host.pid);
    const panes = [];
    for (let index = 0; index < count; index++) panes.push(await first.host.openForBot(`bot-${index % 2}`, { label: `LOST-${index}`, command: LOOP }));
    const listed = await until(async () => {
      const list = await first.client.panes();
      return list.every((pane) => pane.mark?.kind === "C") && list;
    });
    process.kill(hosts[0]);
    await until(() => first.of("terminal:exit").length === count);
    assert.deepEqual(sorted(first.of("terminal:exit").map((pane) => pane.id)), sorted(panes.map((pane) => pane.sessionId)));
    assert.equal(first.host.liveWorkerCount(), 0);
    await until(() => listed.every((pane) => !alive(pane.pid)), 30_000);

    const second = app(root, runtimeRoot);
    await second.adopt();
    if (second.client.state().host) hosts.push(second.client.state().host.pid);
    await second.client.prewarm();
    hosts.push(second.client.state().host.pid);
    assert.deepEqual([second.of("terminal:opened"), second.notes, second.spawned, await second.client.panes()], [[], [], [], []]);
    await second.host.dispose();
    second.client.close();
  });
}

test("a pane that finished while the app was closed is told to its bot once, and closes if it had reported", { ...windows, timeout: 300_000 }, async (t) => {
  const before = await left(t, { count: 3, command: [SHORT, SHORT, GONE], typed: null, reported: ["KEEP-1"] });
  assert.deepEqual(record(before.root).map((run) => [run.label, run.state, run.kept]), [["KEEP-0", "running", true], ["KEEP-1", "reported", true], ["KEEP-2", "running", true]]);
  await wait(22_000);
  const second = app(before.root, runtimeRoot);
  await second.adopt();
  const [quiet, told, gone] = before.panes;
  assert.deepEqual(sorted(second.notes.map((note) => `${note.bot}: ${note.text}`)), [
    `bot-0: FINISHED WHILE WINK WAS DOWN: KEEP-0 [pane ${quiet.sessionId.slice(0, 8)}] command ended, no report: read it, then close it; KEEP-2 [pane ${gone.sessionId.slice(0, 8)}] exit 3, no report: read it, then close it.`,
    `bot-1: FINISHED WHILE WINK WAS DOWN: KEEP-1 [pane ${told.sessionId.slice(0, 8)}] reported (report above).`,
  ]);
  assert.match(second.host.watchBot("bot-0", quiet.sessionId, { send: () => 0, drop() {}, end() {} }).snapshot.output, /WORK=42/);
  assert.deepEqual(second.events.filter(([channel, value]) => value.id === gone.sessionId && /opened|exit/.test(channel)).map(([channel, value]) => [channel, value.exitCode]), [["terminal:opened", undefined], ["terminal:exit", 3]]);
  await until(async () => (await second.client.panes()).length === 2, 30_000);
  assert.deepEqual(second.of("terminal:closed").map((pane) => pane.id), [told.sessionId]);
  await second.adopt();
  assert.equal(second.notes.length, 2);
  assert.equal(second.host.liveWorkerCount(), 1);
  await closeAll(second, [quiet, gone]);
});

test("a kept pane with no record or an unknown owner never becomes a row and is stopped", { ...windows, timeout: 300_000 }, async (t) => {
  const before = await left(t, { count: 3, end: "kill" });
  const [stray, orphan, kept] = before.panes;
  fs.writeFileSync(path.join(before.root, "pane-runs.json"), JSON.stringify(record(before.root).filter((run) => run.id !== stray.sessionId).map((run) => run.id === orphan.sessionId ? { ...run, botId: "bot-gone" } : run)));
  const second = app(before.root, runtimeRoot, { names: { "bot-0": "Zero", "bot-1": "One" } });
  let recheck;
  const rechecked = new Promise((resolve) => { recheck = resolve; });
  await second.adopt({ unknownBotMs: 600_000, wait: (ms) => ms === 600_000 ? rechecked : new Promise((resolve) => { setTimeout(resolve, ms).unref(); }) });
  assert.deepEqual(second.of("terminal:opened").map((pane) => pane.id), [kept.sessionId]);
  await until(() => !alive(stray.pid), 30_000);
  assert.equal(alive(orphan.pid), true);
  assert.deepEqual([...second.runs.restarted().keys()], []);
  recheck();
  await until(() => !alive(orphan.pid), 30_000);
  await until(async () => (await second.client.panes()).length === 1, 30_000);
  assert.deepEqual(second.of("terminal:opened").map((pane) => pane.id), [kept.sessionId]);
  assert.deepEqual(record(before.root).map((run) => run.id), [kept.sessionId]);
  await closeAll(second, [kept]);
});

test("a host the app cannot reach blocks both adoption and restart until it is gone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-adopt-"));
  try {
    const file = path.join(root, "pane-runs.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "11111111-aaaa-4bbb-8ccc-000000000001", botId: "bot-1", teacher: "bot-1", label: "LOST-1", cwd: root, spawnedAt: 1, state: "running", kept: true }]));
    const runs = createPaneRuns(file);
    const calls = [];
    let state = "unknown";
    let tick;
    const client = { left: () => state, prewarm: async () => { calls.push("prewarm"); return false; }, panes: async () => [], attach: () => { calls.push("attach"); return null; }, drop: () => calls.push("drop"), state: () => ({ fault: { detail: "protocol 9" } }) };
    const kept = [];
    const done = adoptWorkers({ client, runs, host: { adoptPane: () => null, closeForBot: async () => {} }, recover: async (notes) => { kept.push([[...notes].map(([botId, note]) => `${botId}: ${note.text}`), [...runs.restarted().keys()]]); }, wait: () => new Promise((resolve) => { tick = resolve; }) });
    await until(() => kept.length === 1 && tick);
    assert.deepEqual(kept[0], [["bot-1: WORKERS UNAVAILABLE: Wink cannot reach its background worker host, so it cannot tell whether these panes still run: LOST-1 [pane 11111111]. It does not restart them, and checks again every 30 s."], []]);
    tick();
    await wait(50);
    assert.equal(kept.length, 1);
    state = "none";
    tick();
    await done;
    assert.deepEqual(kept[1], [[], ["bot-1"]]);
    assert.deepEqual(calls, ["prewarm"]);
  } finally {
    await remove(root);
  }
});

test("old output is handed on in short slices, in order, and live output goes straight through afterwards", async () => {
  let at = 0;
  const deferred = [];
  const pacer = createReplayPacer({ sliceMs: 8, clock: () => at, defer: (run) => deferred.push(run) });
  const listeners = {};
  let caughtUp;
  const pty = { pid: 42, onData: (listener) => { listeners.data = listener; }, onExit: (listener) => { listeners.exit = listener; }, onError: () => {}, detach: () => true };
  const paced = pacer.wrap({ pty, replayed: new Promise((resolve) => { caughtUp = resolve; }) });
  const seen = [];
  paced.pty.onData((text) => { at += 3; seen.push(text.length); });
  paced.pty.onExit((event) => seen.push(event));
  listeners.data("a".repeat(40 * 1024));
  listeners.data(`${"b".repeat(16 * 1024 - 1)}\u{1f600}`);
  assert.deepEqual([seen, paced.pty.pid, paced.pty.detach()], [[], 42, true]);
  caughtUp();
  await wait(0);
  const slices = [];
  while (deferred.length) {
    const before = seen.length;
    deferred.shift()();
    slices.push(seen.length - before);
  }
  assert.deepEqual(seen, [16384, 16384, 8192, 16383, 2]);
  assert.deepEqual(slices, [3, 2]);
  await paced.replayed;
  listeners.data("live");
  listeners.exit({ exitCode: 0 });
  assert.deepEqual(seen.slice(5), [4, { exitCode: 0 }]);
});

test("the kept note names each pane once by what happened to it", () => {
  const run = (label, engine) => ({ id: `${label.toLowerCase()}0000-0000`, label, engine });
  assert.equal(keptNoteText({ running: [run("FAST", "claude"), run("SCRAPE")], finished: [{ run: run("AUDIT"), reported: true, exitCode: null }, { run: run("SWEEP"), reported: false, exitCode: 0 }] }),
    "KEPT RUNNING: FAST [pane fast0000] (claude) still working; SCRAPE [pane scrape00] (script) still running.\nFINISHED WHILE WINK WAS DOWN: AUDIT [pane audit000] reported (report above); SWEEP [pane sweep000] exit 0, no report: read it, then close it.");
});
