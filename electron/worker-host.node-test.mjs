import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTerminalHost } from "./terminal-host.mjs";
import { createWorkerTerminalHost } from "./worker-host-facade.mjs";
import { createWorkerHostClient } from "./worker-host-client.mjs";
import { workerHostIdentity, workerHostLiveness, workerHostWindows } from "./worker-host-identity.mjs";
import { WORKER_HOST_VERSION, WORKER_HOST_CAPABILITIES, workerHostPeer } from "./worker-host-protocol.mjs";
import { createTerminalScreen } from "./terminal-screen.mjs";
import { workerHostScreen } from "./worker-host-screen.mjs";

const require = createRequire(import.meta.url);
const scratch = path.join(os.tmpdir(), "wink-WORKER-HOST-1");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(30);
  }
  throw new Error("Timed out waiting for worker host proof");
}

function config() {
  const root = path.join(scratch, randomUUID());
  fs.mkdirSync(root, { recursive: true });
  return { root, runtimeRoot: path.join(scratch, "test-runtime"), home: path.join(root, "home"), dataDir: path.join(root, "home", ".orbit"), worktreeRoot: path.join(root, "worktrees"), ptyModule: require.resolve("node-pty") };
}

function client(options, event = () => {}) {
  return createWorkerHostClient({ ...options, event, service: (method) => method === "mailbox" || method === "workerLaunch" ? null : method === "resolveCwd" ? options.root : {} });
}

test("liveness requires creation and boot identities and preserves unknowns", async () => {
  const record = { pid: 10, created: "one", boot: "boot" };
  assert.equal(await workerHostLiveness(record, async () => ({ ...record })), "alive");
  assert.equal(await workerHostLiveness(record, async () => ({ ...record, created: "two" })), "dead");
  assert.equal(await workerHostLiveness(record, async () => ({ ...record, created: null })), "dead");
  assert.equal(await workerHostLiveness(record, async () => ({ ...record, boot: "reboot" })), "dead");
  assert.equal(await workerHostLiveness(record, async () => { throw new Error("Access denied"); }), "unknown");
  assert.equal(await workerHostLiveness({ pid: 10 }), "unknown");
  assert.equal(await workerHostLiveness(record, async () => ({})), "unknown");
});

test("screen attachment restores styles, modes, alternate screen and cursor", () => {
  const before = createTerminalScreen({ cols: 40, rows: 8 });
  before.consume("history\r\n\x1b[?1049h\x1b[?2004h\x1b[31;1mhello\x1b[3;5Hcursor");
  const snapshot = before.snapshot();
  const after = createTerminalScreen({ cols: 40, rows: 8 });
  after.consume(workerHostScreen(snapshot));
  const restored = after.snapshot();
  for (const key of ["screenText", "screenRuns", "cursor", "alternate", "modes"]) assert.deepEqual(restored[key], snapshot[key], key);
});

test("protocol handles split UTF-8 and rejects oversized or malformed frames", async (t) => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\wink-protocol-${randomUUID()}` : path.join(scratch, `${randomUUID()}.sock`);
  const server = net.createServer((socket) => workerHostPeer(socket, (method, args) => { assert.equal(method, "echo"); return args[0]; }));
  await new Promise((resolve) => server.listen(pipe, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const socket = net.createConnection(pipe);
  const peer = workerHostPeer(socket, () => {});
  assert.equal(await peer.request("echo", ["한글 🐒"]), "한글 🐒");
  peer.close();
  const bad = net.createConnection(pipe);
  const closed = new Promise((resolve) => bad.once("close", resolve));
  bad.write("not json\n");
  await closed;
  const fake = new EventEmitter();
  const responses = [];
  fake.write = (frame) => responses.push(JSON.parse(frame));
  fake.destroy = () => { fake.destroyed = true; fake.emit("close"); };
  workerHostPeer(fake, (_method, args) => args[0]);
  const frame = Buffer.from(`${JSON.stringify({ id: 1, method: "echo", args: ["한글"] })}\n`);
  for (const byte of frame) fake.emit("data", Buffer.from([byte]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responses[0].value, "한글");
  fake.emit("data", Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
  assert.equal(fake.destroyed, true);
});

test("flag-off host retains local ownership and shutdown", async () => {
  let child;
  const owner = { id: 1, mainFrame: {}, send() {} };
  const host = createTerminalHost({ authorize() {}, owner: () => owner, resolveCwd: () => scratch, env: { SHELL: "/bin/sh" }, platform: "linux",
    loadPty: () => ({ spawn: () => child = { onData() {}, onExit() {}, write() {}, kill() { this.killed = true; } } }) });
  await host.openForBot("off");
  assert.equal(host.liveWorkerCount(), 1);
  await host.dispose();
  assert.equal(child.killed, true);
});

test("failed unpublished host exits empty without admitting a pane", { timeout: 45_000 }, async (t) => {
  const options = config();
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\wink-occupied-${randomUUID()}` : path.join(options.root, "occupied.sock");
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(pipe, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  fs.writeFileSync(path.join(options.root, "launch.json"), JSON.stringify({ ...options, pipe, nonce: randomUUID(), secret: "fixture", runtime: { ptyModule: options.ptyModule } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./worker-host-entry.mjs", import.meta.url)), options.root], { windowsHide: true, stdio: "ignore" });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.equal(fs.existsSync(path.join(options.root, "host.json")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.root, "pane-runs.json"), "utf8")), []);
});

test("unreachable live host refuses a replacement and leaves discovery intact", { timeout: 20_000 }, async () => {
  const options = config();
  const record = { ...await workerHostIdentity(), version: WORKER_HOST_VERSION, nonce: randomUUID(), secret: "test", pipe: process.platform === "win32" ? `\\\\.\\pipe\\wink-missing-${randomUUID()}` : path.join(options.root, "missing.sock") };
  fs.writeFileSync(path.join(options.root, "host.json"), JSON.stringify(record));
  const before = fs.readFileSync(path.join(options.root, "host.json"), "utf8");
  await assert.rejects(client(options).request("spawn", ["test", {}]), /unavailable/);
  assert.equal(fs.readFileSync(path.join(options.root, "host.json"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(options.root, "launch.json")), false);
});

test("real host authenticates, detaches, reattaches the same shell and exits empty", { timeout: 90_000 }, async () => {
  const options = config();
  let output = "";
  let first = client(options, (channel, value) => { if (channel === "terminal:data") output += value.data; });
  await first.connect();
  const identity = first.identity();
  if (process.platform === "win32") {
    const acl = await workerHostWindows("pipe-acl", { target: identity.pipe });
    assert.match(acl, /\(D;;0x1f019f;;;NU\)/);
    assert.doesNotMatch(acl, /;;;(?:WD|BU|AU|BA)\)/);
    assert.equal((acl.match(/\(A;/g) ?? []).length, 1);
  }
  const pane = await first.request("spawn", ["test", { label: "SURVIVE" }]);
  const input = { botId: "test", sessionId: pane.sessionId, cols: 120, rows: 30 };
  const initial = await first.request("attach", [input]);
  const command = process.platform === "win32" ? "[Console]::Write('SURVIVE_' + 'READY'); $global:ProofCount = 0\r" : "printf 'SURVIVE_READY'; ProofCount=0\n";
  await first.request("write", [pane.sessionId, command]);
  await until(async () => (await first.request("read", ["test"])).screenText.includes("SURVIVE_READY"));
  const badSocket = net.createConnection(identity.pipe);
  const bad = workerHostPeer(badSocket, () => {});
  await assert.rejects(bad.request("hello", [{ secret: "wrong", nonce: identity.nonce, version: WORKER_HOST_VERSION, capabilities: WORKER_HOST_CAPABILITIES }], 2000), /unavailable/);
  bad.close();
  await first.detach();
  await wait(200);
  for (const changes of [{ version: 999 }, { nonce: "different" }, { capabilities: [] }]) {
    const socket = net.createConnection(identity.pipe);
    const incompatible = workerHostPeer(socket, () => {});
    await assert.rejects(incompatible.request("hello", [{ secret: identity.secret, nonce: identity.nonce, version: WORKER_HOST_VERSION, capabilities: WORKER_HOST_CAPABILITIES, ...changes }], 2000), /unavailable/);
    incompatible.close();
  }
  first = client(options, (channel, value) => { if (channel === "terminal:data") output += value.data; });
  await first.connect(false);
  assert.deepEqual(first.identity(), identity);
  if (process.platform === "win32") assert.doesNotMatch(await workerHostWindows("pipe-acl", { target: identity.pipe }), /;;;(?:WD|BU|AU|BA)\)/);
  const restored = await first.request("attach", [input]);
  assert.deepEqual(restored.processIdentity, initial.processIdentity);
  assert.match(restored.screenText, /SURVIVE_READY/);
  const screen = createTerminalScreen({ cols: restored.cols, rows: restored.rows });
  screen.consume(restored.output);
  assert.equal(screen.text(), restored.screenText);
  assert.deepEqual(screen.snapshot().cursor, restored.cursor);
  const once = process.platform === "win32" ? "$global:ProofCount++; Write-Output ('ONCE=' + $global:ProofCount)\r" : "ProofCount=$((ProofCount+1)); echo ONCE=$ProofCount\n";
  await first.request("write", [pane.sessionId, once]);
  await until(async () => (await first.request("read", ["test"])).screenText.includes("ONCE=1"));
  assert.equal((await first.request("list")).count, 1);
  assert.match(output, /ONCE=1/);
  await first.request("close-pane", ["test", pane.sessionId, true]);
  await first.detach();
  await until(async () => await workerHostLiveness(identity) === "dead", 15_000);
});

test("facade adopts without launch admission and leaves workers alive on dispose", { timeout: 90_000 }, async () => {
  const options = config();
  let admissions = 0;
  const owner = { id: 20, mainFrame: {}, send() {}, isDestroyed: () => false };
  const facade = () => createWorkerTerminalHost({ hostConfig: options, authorize() {}, owner: () => owner, resolveCwd: () => options.root,
    mailbox: () => null, botNames: () => ({}), snag() {}, workerAccountsEnabled: true, workerLaunch: () => { admissions++; return null; } });
  const original = facade();
  const pane = await original.openForBot("test", { command: "Write-Output 'FACade'" });
  assert.equal(admissions, 1);
  await original.dispose();
  const replacement = facade();
  const snapshot = await replacement.open({ sender: owner }, { botId: "test", sessionId: pane.sessionId, cols: 120, rows: 30 });
  assert.equal(snapshot.id, pane.sessionId);
  assert.equal(replacement.liveWorkerCount(), 1);
  assert.equal(admissions, 1);
  await replacement.closeForBot("test", pane.sessionId, true);
  await replacement.dispose();
});
