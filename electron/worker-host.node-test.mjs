import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { terminalEnvironment } from "./terminal-host.mjs";
import { createWorkerHostClient } from "./worker-host-client.mjs";
import { holdWorkerHostLock, workerHostLock, workerHostRecord, writeWorkerHostRecord } from "./worker-host-identity.mjs";
import { WORKER_HOST_PROTOCOL, workerHostPeer, workerHostProof } from "./worker-host-protocol.mjs";

const require = createRequire(import.meta.url);
const windows = process.platform === "win32" ? {} : { skip: "the worker host ships on Windows first" };
const entry = fileURLToPath(new URL("./worker-host-entry.mjs", import.meta.url));
const shell = [path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"), path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")].find((file) => fs.existsSync(file));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const noLocal = () => { throw new Error("The pane fell back to a local terminal"); };

async function until(check, timeoutMs = 60_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(25)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error("Timed out waiting for the worker host");
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-host-"));
  const slot = path.join(root, `v${WORKER_HOST_PROTOCOL}`);
  const home = path.join(root, "home");
  for (const folder of ["Roaming", "Local"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  const hosts = [];
  const lines = [];
  const clients = [];
  const sockets = [];
  const undo = [];
  const launch = async ({ ptyModule, slot: folder, launch: record, env }) => {
    writeWorkerHostRecord(path.join(folder, "launch.json"), { ...record, ptyModule });
    const child = spawn(process.execPath, [entry, folder], { detached: true, windowsHide: true, stdio: "ignore", env });
    child.unref();
    hosts.push(child.pid);
    return { pid: child.pid, staged: { bin: false, js: false } };
  };
  const make = (extra = {}) => {
    const client = createWorkerHostClient({ root, ptyModule: () => require.resolve("node-pty"), install: path.join(root, "app"), launch, log: (line) => lines.push(line), ...options, ...extra });
    clients.push(client);
    return client;
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const client of clients) client.close();
    for (const step of undo) step();
    // A host that kept panes for an adopting app ends them for one that cannot adopt.
    const sweeper = createWorkerHostClient({ root, ptyModule: () => "", answerMs: 500, launch: async () => { throw new Error("No host left to sweep"); } });
    if (await sweeper.prewarm()) sweeper.close();
    await until(() => hosts.every((pid) => !alive(pid)), 15_000).catch(() => {});
    const left = hosts.filter(alive);
    if (left.length && workerHostLock(path.join(slot, "host.lock")) === "alive") for (const pid of left) process.kill(pid);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    assert.deepEqual(left, [], "every host ends by itself");
  });
  const env = { ...terminalEnvironment(process.env), USERPROFILE: home, HOME: home, APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local"), POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off", WINK_TEST_CANARY: "canary-value" };
  const pane = (id, extra = {}) => ({ id, tag: "bot-1", shell, args: ["-NoLogo", "-NoProfile"], options: { cwd: root, env, cols: 80, rows: 24 }, ...extra });
  const hold = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = holdWorkerHostLock(file);
    undo.push(() => fs.closeSync(lock));
  };
  return { root, slot, hosts, lines, sockets, undo, make, pane, hold };
}

function watch(pty) {
  const seen = { text: "" };
  pty.onData((text) => { seen.text += text; });
  return seen;
}

function localPty() {
  const listeners = new Set();
  const writes = [];
  return { pid: 4242, writes, emit: (text) => { for (const listener of listeners) listener(text); }, onData: (listener) => listeners.add(listener), onExit() {}, onError() {}, ready: Promise.resolve(), exited: new Promise(() => {}), write: async (input) => { writes.push(input); }, resize: async () => {}, kill: async () => {}, terminate() {} };
}

async function greet(f, { capabilities = [], event = () => {}, data = () => {} } = {}) {
  const record = workerHostRecord(path.join(f.slot, "host.json"));
  const socket = net.createConnection(record.pipe);
  f.sockets.push(socket);
  await once(socket, "connect");
  const peer = workerHostPeer(socket, { event, data });
  const nonce = randomUUID();
  const hello = await peer.request("hello", [{ protocol: WORKER_HOST_PROTOCOL, nonce }]);
  assert.equal(hello.proof, workerHostProof(record.secret, "host", nonce, hello.nonce));
  const welcome = await peer.request("auth", [{ proof: workerHostProof(record.secret, "client", nonce, hello.nonce), capabilities }]);
  return { peer, welcome, closed: once(socket, "close") };
}

async function fakeHost(f, commands = {}) {
  f.hold(path.join(f.slot, "host.lock"));
  const secret = "5".repeat(64);
  const pipe = `\\\\.\\pipe\\wink-worker-test-${randomUUID()}`;
  const seen = [];
  const open = new Set();
  const server = net.createServer((socket) => {
    open.add(socket);
    let challenge;
    const answers = {
      hello: (input) => ({ nonce: challenge = randomUUID(), proof: workerHostProof(secret, "host", input.nonce, challenge) }),
      auth: () => ({ epoch: 1, host: process.pid, capabilities: ["adopt"], panes: [] }),
      ...commands,
    };
    const peer = workerHostPeer(socket, { request(method, [input]) {
      seen.push([method, input?.id]);
      return Object.hasOwn(answers, method) ? answers[method](input, peer) : new Promise(() => {});
    } });
  });
  await new Promise((resolve) => server.listen(pipe, resolve));
  writeWorkerHostRecord(path.join(f.slot, "host.json"), { protocol: WORKER_HOST_PROTOCOL, pid: process.pid, nonce: "fake", secret, pipe });
  f.undo.push(() => {
    for (const socket of open) socket.destroy();
    server.close();
  });
  return { seen };
}

const control = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(5);
  head.writeUInt32LE(body.length + 1);
  head[4] = 1;
  return Buffer.concat([head, body]);
};

function raw(f, pipe) {
  const socket = net.createConnection(pipe);
  f.sockets.push(socket);
  const caller = { socket, bytes: 0, frames: [], closed: once(socket, "close") };
  let buffered = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    caller.bytes += chunk.length;
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
      const end = 4 + buffered.readUInt32LE(0);
      caller.frames.push(JSON.parse(buffered.toString("utf8", 5, end)));
      buffered = buffered.subarray(end);
    }
  });
  return caller;
}

test("a real shell runs in the host: output, input once, resize, mark and exit code", { ...windows, timeout: 120_000 }, async (t) => {
  const f = fixture(t);
  const client = f.make();
  assert.equal(await client.prewarm(), true);
  assert.match(f.lines[0], /^worker host ready pid=\d+ launch=\d+ms staged=none$/);
  assert.deepEqual(client.state().host.pid, f.hosts[0]);
  const pane = client.spawn(f.pane("pane-1"), noLocal);
  const seen = watch(pane);
  const exit = new Promise((resolve) => pane.onExit(resolve));
  await pane.ready;
  assert.equal(alive(pane.pid), true);
  assert.equal(client.state().panes, 1);
  const saved = workerHostRecord(path.join(f.slot, "panes.json"));
  assert.deepEqual(Object.keys(saved.panes[0]), ["id", "pid", "start", "ready", "exit", "tag"]);
  assert.deepEqual([saved.host, saved.panes[0].id, saved.panes[0].pid, saved.panes[0].exit, saved.panes[0].tag], [f.hosts[0], "pane-1", pane.pid, null, "bot-1"]);
  assert.ok(!fs.readFileSync(path.join(f.slot, "panes.json"), "utf8").includes("canary-value"));
  await pane.resize(123, 30);
  await pane.write('Write-Output ("WIDE=" + $Host.UI.RawUI.WindowSize.Width)\r');
  await until(() => seen.text.includes("WIDE=123"));
  await pane.write('Write-Output ("SUM=" + (40 + 2) + "; canary " + $env:WINK_TEST_CANARY)\r');
  await until(() => seen.text.includes("SUM=42; canary canary-value"));
  await pane.write('[Console]::Write("$([char]27)]133;D;abc;7$([char]7)"); Write-Output ("DONE=" + (1 + 1))\r');
  await until(() => seen.text.includes("DONE=2"));
  assert.equal(seen.text.match(/SUM=42/g).length, 1);
  const [listed] = await until(async () => {
    const panes = await client.panes();
    return panes[0]?.mark ? panes : null;
  });
  assert.deepEqual([listed.id, listed.pid, listed.cols, listed.rows, listed.tag, listed.exit], ["pane-1", pane.pid, 123, 30, "bot-1", null]);
  assert.deepEqual([listed.mark.kind, listed.mark.value], ["D", "abc;7"]);
  assert.ok(listed.input >= listed.start && listed.output >= listed.start && listed.seq > 0);
  await pane.write("exit 7\r");
  assert.deepEqual(await exit, { exitCode: 7 });
  await pane.exited;
  assert.equal(alive(pane.pid), false);
  assert.equal(client.state().panes, 0);
  await until(async () => !(await client.panes()).length);
  assert.deepEqual(workerHostRecord(path.join(f.slot, "panes.json")).panes, []);
  const closedAt = Date.now();
  client.close();
  await until(() => !alive(f.hosts[0]), 5_000);
  assert.ok(Date.now() - closedAt < 2_000, `empty host left after ${Date.now() - closedAt} ms`);
});

test("kill stops a hosted shell, and an app that cannot adopt takes its panes with it", { ...windows, timeout: 120_000 }, async (t) => {
  const f = fixture(t);
  const client = f.make();
  assert.equal(await client.prewarm(), true);
  const first = client.spawn(f.pane("kill-me"), noLocal);
  const second = client.spawn(f.pane("left-behind"), noLocal);
  assert.equal(client.spawn(f.pane("kill-me"), noLocal), null);
  await Promise.all([first.ready, second.ready]);
  const exit = new Promise((resolve) => first.onExit(resolve));
  await first.kill();
  assert.ok(Number.isInteger((await exit).exitCode));
  await first.exited;
  assert.equal(alive(first.pid), false);
  assert.equal(alive(second.pid), true);
  const errors = [];
  second.onError((error) => errors.push(error.message));
  const left = new Promise((resolve) => second.onExit(resolve));
  client.close();
  assert.deepEqual(await left, { exitCode: 1 });
  assert.match(errors[0], /^Worker host lost/);
  await assert.rejects(second.write("x"), /Terminal has exited/);
  await until(() => !alive(second.pid) && workerHostRecord(path.join(f.slot, "panes.json")).panes.length === 0);
  const goneAt = Date.now();
  await until(() => !alive(f.hosts[0]), 5_000);
  assert.ok(Date.now() - goneAt < 2_000, `host left ${Date.now() - goneAt} ms after its last pane`);
  assert.equal(f.lines.length, 1);
});

test("a shell that cannot start in the host opens locally", { ...windows, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  const client = f.make();
  assert.equal(await client.prewarm(), true);
  const local = localPty();
  const pane = client.spawn(f.pane("no-shell", { shell: path.join(f.root, "missing.exe") }), () => local);
  await pane.ready;
  assert.equal(pane.pid, local.pid);
  assert.equal(pane.detach(), false);
  assert.match(f.lines[1], /^worker host failed to start a pane \(.+\): panes open locally$/);
  await until(async () => !(await client.panes()).length);
  assert.equal(client.state().panes, 0);
});

test("an adopting app finds its pane again and replays the ring from a seq", { ...windows, timeout: 180_000 }, async (t) => {
  const f = fixture(t);
  const before = f.make({ adopt: true });
  assert.equal(await before.prewarm(), true);
  const pane = before.spawn(f.pane("kept"), noLocal);
  const seen = watch(pane);
  await pane.ready;
  await pane.write('Write-Output ("ONE=" + (1 + 1))\r');
  await until(() => seen.text.includes("ONE=2"));
  const [{ seq }] = await before.panes();
  assert.equal(pane.detach(), true);
  before.close();
  await wait(1_500);
  assert.equal(alive(pane.pid), true);

  const after = f.make({ adopt: true });
  assert.equal(await after.prewarm(), true);
  assert.equal(f.hosts.length, 1);
  assert.match(f.lines.at(-1), /^worker host ready pid=\d+ already running$/);
  assert.deepEqual((await after.panes()).map((listed) => listed.id), ["kept"]);
  const tail = after.attach("kept", seq);
  const later = watch(tail.pty);
  assert.equal((await tail.replay).truncated, false);
  assert.equal(tail.pty.pid, pane.pid);
  await tail.pty.write('Write-Output ("TWO=" + (2 + 2))\r');
  await until(() => later.text.includes("TWO=4"));
  assert.ok(!later.text.includes("ONE=2"));
  assert.equal(tail.pty.detach(), true);

  const whole = after.attach("kept");
  const all = watch(whole.pty);
  assert.equal((await whole.replay).truncated, false);
  await until(() => all.text.includes("TWO=4"));
  assert.ok(all.text.includes("ONE=2") && all.text.indexOf("ONE=2") < all.text.indexOf("TWO=4"));
  await whole.pty.write('Write-Output ("x" * 300000)\r');
  await until(() => all.text.length > 300_000, 90_000);
  assert.equal(whole.pty.detach(), true);

  const cut = after.attach("kept");
  const rest = watch(cut.pty);
  const reply = await cut.replay;
  assert.equal(reply.truncated, true);
  assert.ok(reply.first > 1);
  await until(() => rest.text.length > 200_000);
  assert.ok(!rest.text.includes("ONE=2"));
  assert.ok((await after.panes())[0].bytes <= 256 * 1024);
  after.close();

  const plain = f.make();
  assert.equal(await plain.prewarm(), true);
  assert.deepEqual(await plain.panes(), []);
  await until(() => !alive(pane.pid));
});

test("a second controller fences the first", { ...windows, timeout: 120_000 }, async (t) => {
  const f = fixture(t);
  const starter = f.make({ adopt: true });
  assert.equal(await starter.prewarm(), true);
  const pane = starter.spawn(f.pane("shared"), noLocal);
  await pane.ready;
  pane.detach();
  starter.close();

  const fenced = [];
  const first = await greet(f, { capabilities: ["adopt"], event: (name, value) => fenced.push([name, value]) });
  assert.deepEqual(first.welcome.panes.map((listed) => listed.id), ["shared"]);
  await first.peer.request("attach", [{ id: "shared" }]);
  let output = "";
  const second = await greet(f, { capabilities: ["adopt"], data: (_id, _seq, text) => { output += text; } });
  assert.equal(second.welcome.epoch, first.welcome.epoch + 1);
  await until(() => fenced.length);
  assert.deepEqual(fenced[0], ["fenced", { epoch: second.welcome.epoch }]);
  await assert.rejects(first.peer.write("shared", "x"), /fenced/);
  await assert.rejects(first.peer.request("list"), /fenced/);
  await first.closed;
  await second.peer.request("attach", [{ id: "shared" }]);
  await second.peer.write("shared", 'Write-Output ("B=" + (3 + 4))\r');
  await until(() => output.includes("B=7"));
  assert.equal(await second.peer.request("detach"), true);
  await assert.rejects(second.peer.request("list"), /fenced/);
  assert.equal(alive(pane.pid), true);

  const app = f.make({ adopt: true });
  assert.equal(await app.prewarm(), true);
  const held = app.attach("shared");
  await held.replay;
  const errors = [];
  held.pty.onError((error) => errors.push(error.message));
  const exit = new Promise((resolve) => held.pty.onExit(resolve));
  const last = await greet(f);
  assert.deepEqual(last.welcome.panes, []);
  assert.deepEqual(await exit, { exitCode: 1 });
  assert.match(errors[0], /another Wink took over/);
  assert.equal(app.state().connected, false);
  assert.equal(await app.prewarm(), false);
  assert.equal(app.spawn(f.pane("late"), noLocal), null);
  assert.equal(f.lines.filter((line) => line === "worker host missing (another Wink took over the worker host): panes open locally").length, 1);
  await until(() => !alive(pane.pid));
});

test("a host that cannot start leaves panes local and says so once", windows, async (t) => {
  const f = fixture(t, { retryMs: 0, launch: async () => { throw new Error("runtime copy failed"); } });
  const client = f.make();
  assert.equal(client.spawn(f.pane("early"), noLocal), null);
  assert.equal(await client.prewarm(), false);
  assert.equal(client.spawn(f.pane("later"), noLocal), null);
  assert.equal(await client.prewarm(), false);
  assert.deepEqual(f.lines, ["worker host missing (runtime copy failed): panes open locally"]);
  assert.deepEqual(client.state(), { connected: false, stalled: false, fault: { reason: "missing", detail: "runtime copy failed" }, host: null, panes: 0 });
  assert.equal(f.make({ platform: "linux" }).spawn(f.pane("elsewhere"), noLocal), null);
  assert.equal(await f.make({ platform: "darwin" }).prewarm(), false);
  assert.equal(f.lines.length, 1);
});

test("the host refuses to run from inside the app folder", { ...windows, timeout: 60_000 }, async (t) => {
  const f = fixture(t, { install: path.dirname(process.execPath), publishMs: 3_000 });
  const client = f.make();
  assert.equal(await client.prewarm(), false);
  assert.deepEqual(f.lines, ["worker host missing (host did not start): panes open locally"]);
  assert.match(fs.readFileSync(path.join(f.slot, "host-errors.log"), "utf8"), /Worker host runtime is inside the app folder/);
  assert.equal(alive(f.hosts[0]), false);
});

test("a host of an unknown version is left alone", windows, async (t) => {
  let launched = 0;
  const f = fixture(t, { launch: async () => { launched++; throw new Error("Launched over a live host"); } });
  f.hold(path.join(f.slot, "host.lock"));
  assert.equal(await f.make().prewarm(), false);
  writeWorkerHostRecord(path.join(f.slot, "host.json"), { protocol: 99, pipe: "\\\\.\\pipe\\wink-worker-test-none", secret: "5".repeat(64) });
  const client = f.make();
  assert.equal(await client.prewarm(), false);
  assert.equal(client.spawn(f.pane("pane-1"), noLocal), null);
  assert.deepEqual(f.lines, ["worker host unknown version (no host record): panes open locally", "worker host unknown version (protocol 99): panes open locally"]);
  assert.equal(launched, 0);
});

test("two older hosts still running are the cap", windows, async (t) => {
  let launched = 0;
  const f = fixture(t, { launch: async () => { launched++; throw new Error("Launched a third host"); } });
  for (const name of ["v2", "v3"]) f.hold(path.join(f.root, name, "host.lock"));
  const client = f.make();
  assert.equal(await client.prewarm(), false);
  assert.equal(client.spawn(f.pane("pane-1"), noLocal), null);
  assert.deepEqual(f.lines, ["worker host at cap (2 older hosts still run): panes open locally"]);
  assert.equal(launched, 0);
});

test("a host that never says hello is not answering", windows, async (t) => {
  const f = fixture(t, { answerMs: 200 });
  await fakeHost(f, { hello: () => new Promise(() => {}) });
  const client = f.make();
  assert.equal(await client.prewarm(), false);
  assert.equal(client.spawn(f.pane("pane-1"), noLocal), null);
  assert.deepEqual(f.lines, ["worker host not answering (Worker host unavailable): panes open locally"]);
});

test("a host that stops answering hands the pane to a local terminal", windows, async (t) => {
  const f = fixture(t, { answerMs: 500, retryMs: 1_000 });
  const fake = await fakeHost(f, { kill: () => true });
  const client = f.make();
  assert.equal(await client.prewarm(), true);
  const local = localPty();
  let opened = 0;
  const pane = client.spawn(f.pane("slow"), () => { opened++; return local; });
  const seen = watch(pane);
  await pane.ready;
  assert.equal(opened, 1);
  assert.equal(pane.pid, local.pid);
  await pane.write("typed");
  assert.deepEqual(local.writes, ["typed"]);
  local.emit("from the local shell");
  assert.equal(seen.text, "from the local shell");
  assert.equal(pane.detach(), false);
  assert.deepEqual(f.lines.slice(1), ["worker host not answering (no answer in 500 ms): panes open locally"]);
  await until(() => fake.seen.some(([method, id]) => method === "kill" && id === "slow"));
  assert.equal(client.state().stalled, true);
  assert.equal(client.spawn(f.pane("next"), noLocal), null);
  await until(() => !client.state().connected);
  assert.equal(opened, 1);
});

test("the pane cap and a failed start both open the pane locally", windows, async (t) => {
  const f = fixture(t);
  await fakeHost(f, {
    kill: () => true,
    spawn({ id }, peer) {
      if (id === "full") throw new Error("Worker host is full");
      if (id === "broken") queueMicrotask(() => peer.emit("exit", { id, exitCode: 1, error: "File not found" }));
      return true;
    },
  });
  const client = f.make();
  assert.equal(await client.prewarm(), true);
  const full = client.spawn(f.pane("full"), localPty);
  const broken = client.spawn(f.pane("broken"), localPty);
  await Promise.all([full.ready, broken.ready]);
  assert.deepEqual([full.pid, broken.pid], [4242, 4242]);
  assert.deepEqual(f.lines.slice(1).sort(), ["worker host at cap (Worker host is full): panes open locally", "worker host failed to start a pane (File not found): panes open locally"]);
  assert.equal(client.state().panes, 0);
  for (let index = 0; index < 64; index++) assert.ok(client.spawn(f.pane(`pane-${index}`), noLocal));
  assert.equal(client.spawn(f.pane("pane-64"), noLocal), null);
  assert.equal(client.state().panes, 64);
  assert.equal(f.lines.length, 3);
});

test("a caller without the secret gets nothing", { ...windows, timeout: 60_000 }, async (t) => {
  const f = fixture(t);
  assert.equal(await f.make().prewarm(), true);
  const record = workerHostRecord(path.join(f.slot, "host.json"));
  const hello = (nonce) => control({ id: 1, method: "hello", args: [{ protocol: WORKER_HOST_PROTOCOL, nonce }] });
  const auth = (proof) => control({ id: 2, method: "auth", args: [{ proof, capabilities: ["adopt"] }] });
  const nonce = randomUUID();

  const wrong = raw(f, record.pipe);
  wrong.socket.write(hello(nonce));
  await until(() => wrong.frames.length);
  wrong.socket.write(auth(workerHostProof("0".repeat(64), "client", nonce, wrong.frames[0].value.nonce)));
  await wrong.closed;
  assert.equal(wrong.frames.length, 1);

  const real = raw(f, record.pipe);
  real.socket.write(hello(nonce));
  await until(() => real.frames.length);
  const proof = workerHostProof(record.secret, "client", nonce, real.frames[0].value.nonce);
  real.socket.write(auth(proof));
  await until(() => real.frames.length === 2);
  assert.equal(real.frames[1].value.host, f.hosts[0]);

  const replay = raw(f, record.pipe);
  replay.socket.write(hello(nonce));
  await until(() => replay.frames.length);
  replay.socket.write(auth(proof));
  await replay.closed;
  assert.equal(replay.frames.length, 1);

  for (const first of [control({ id: 1, method: "list", args: [] }), control({ id: 1, method: "hello", args: [{ protocol: 99, nonce }] }), Buffer.from([8, 0, 0, 0, 3, 1, 0x61, 1, 0, 0, 0, 0x78]), Buffer.from([1, 0, 4, 0])]) {
    const caller = raw(f, record.pipe);
    caller.socket.write(first);
    await caller.closed;
    assert.equal(caller.bytes, 0);
  }

  const began = Date.now();
  const idle = [raw(f, record.pipe), raw(f, record.pipe), raw(f, record.pipe)];
  const reader = await fs.promises.open(record.pipe, "r");
  f.undo.push(() => reader.close().catch(() => {}));
  const read = reader.read(Buffer.alloc(64), 0, 64, null).then(({ bytesRead }) => bytesRead, () => 0);
  await wait(500);
  const fifth = raw(f, record.pipe);
  await fifth.closed;
  assert.equal(fifth.bytes, 0);
  assert.ok(Date.now() - began < 4_000, "a fifth unauthenticated caller is refused at once");
  await Promise.all(idle.map((caller) => caller.closed));
  assert.ok(Date.now() - began >= 4_500, "idle callers are held until the deadline");
  assert.deepEqual(idle.map((caller) => caller.bytes), [0, 0, 0]);
  assert.equal(await read, 0);

  real.socket.write(control({ id: 3, method: "list", args: [] }));
  await until(() => real.frames.length === 3);
  assert.deepEqual(real.frames[2], { reply: 3, value: [] });
  real.socket.write(Buffer.from([1, 0, 4, 0]));
  await real.closed;
});
