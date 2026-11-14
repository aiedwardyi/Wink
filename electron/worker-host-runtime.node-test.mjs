import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { terminalEnvironment } from "./terminal-host.mjs";
import { spawnTerminalPty } from "./terminal-pty.mjs";
import { createWorkerHostClient } from "./worker-host-client.mjs";
import { WORKER_HOST_PROTOCOL } from "./worker-host-protocol.mjs";
import { launchWorkerHost, stageWorkerHostRuntime, sweepWorkerHostRuntime } from "./worker-host-runtime.mjs";

const require = createRequire(import.meta.url);
const windows = process.platform === "win32" ? {} : { skip: "the worker host ships on Windows first" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const layers = (root) => fs.readdirSync(root).sort();

async function until(check, timeoutMs = 60_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(25)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error("Timed out waiting for the worker host");
}

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-host-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return root;
}

// The first run of a freshly copied exe takes seconds; a test about the instant of the launch needs it quick.
async function warmed(root) {
  const runtime = await stageWorkerHostRuntime({ root, executable: process.execPath, ptyModule: require.resolve("node-pty"), sources: [] });
  execFileSync(runtime.executable, ["--version"], { windowsHide: true, stdio: "ignore" });
  return root;
}

test("the runtime is copied once, and a script change restages only the script layer", windows, async (t) => {
  const root = scratch(t);
  const input = { root, executable: process.execPath, ptyModule: require.resolve("node-pty") };
  const sources = [["worker-host-entry.mjs", "one"], ["terminal-pty.mjs", "two"]];
  const first = await stageWorkerHostRuntime({ ...input, sources });
  assert.deepEqual(first.staged, { bin: true, js: true });
  assert.equal(path.basename(first.executable), "WinkWorker.exe");
  assert.equal(fs.statSync(first.executable).size, fs.statSync(process.execPath).size);
  assert.equal(fs.readFileSync(first.entry, "utf8"), "one");
  assert.ok(fs.existsSync(first.ptyModule) && first.ptyModule.startsWith(first.bin));
  const copied = fs.readdirSync(first.bin, { recursive: true }).map(String);
  assert.ok(copied.some((name) => name.endsWith("conpty.node")));
  assert.deepEqual(copied.filter((name) => /\.(?:pdb|map)$/.test(name)), []);

  const again = await stageWorkerHostRuntime({ ...input, sources });
  assert.deepEqual([again.staged, again.bin, again.js], [{ bin: false, js: false }, first.bin, first.js]);
  const changed = await stageWorkerHostRuntime({ ...input, sources: [["worker-host-entry.mjs", "three"], sources[1]] });
  assert.deepEqual([changed.staged, changed.bin], [{ bin: false, js: true }, first.bin]);
  assert.notEqual(changed.js, first.js);

  fs.mkdirSync(path.join(root, "staging-fresh"));
  fs.mkdirSync(path.join(root, "staging-stale"));
  fs.utimesSync(path.join(root, "staging-stale"), new Date(0), new Date(0));
  fs.writeFileSync(path.join(root, "notes.txt"), "not ours");
  await sweepWorkerHostRuntime(root, [changed.bin, changed.js]);
  assert.deepEqual(layers(root), [path.basename(changed.bin), path.basename(changed.js), "notes.txt", "staging-fresh"].sort());
});

test("a host started from the copied runtime runs a pane and keeps its layers", { ...windows, timeout: 120_000 }, async (t) => {
  const root = scratch(t);
  const runtimeRoot = path.join(root, "runtime");
  const home = path.join(root, "home");
  for (const folder of ["Roaming", "Local"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  const lines = [];
  const hosts = [];
  const connect = async () => {
    const client = createWorkerHostClient({ root: path.join(root, "data"), runtimeRoot, ptyModule: () => require.resolve("node-pty"), log: (line) => lines.push(line) });
    assert.equal(await client.prewarm(), true);
    hosts.push(client.state().host.pid);
    return client;
  };
  t.after(() => until(() => hosts.every((pid) => !alive(pid)), 15_000));

  const client = await connect();
  assert.match(lines[0], /^worker host ready pid=\d+ launch=\d+ms staged=bin\+js$/);
  const before = layers(runtimeRoot);
  assert.deepEqual(before.map((name) => name.split("-")[0]), ["bin", "js"]);
  const env = { ...terminalEnvironment(process.env), USERPROFILE: home, HOME: home, APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local"), POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" };
  const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const pane = client.spawn({ id: "staged", shell, args: ["/d"], options: { cwd: root, env, cols: 80, rows: 24 } }, () => { throw new Error("The pane fell back to a local terminal"); });
  let output = "";
  pane.onData((text) => { output += text; });
  const exit = new Promise((resolve) => pane.onExit(resolve));
  await pane.ready;
  await pane.write("set /a 6*7\r");
  await until(() => output.includes("42"));
  await sweepWorkerHostRuntime(runtimeRoot, []);
  assert.deepEqual(layers(runtimeRoot), before);
  await pane.write("exit 5\r");
  assert.deepEqual(await exit, { exitCode: 5 });
  await pane.exited;
  client.close();
  await until(() => !alive(hosts[0]));

  const next = await connect();
  assert.match(lines[1], /^worker host ready pid=\d+ launch=\d+ms staged=none$/);
  next.close();
  await until(() => !alive(hosts[1]));
  // An ended host's exe cannot be deleted for a moment; the layer waits as trash for the next sweep.
  await until(async () => {
    await sweepWorkerHostRuntime(runtimeRoot, []);
    return !layers(runtimeRoot).length;
  }, 15_000);
});

test("the host is not created while a terminal is inside its start", { ...windows, timeout: 120_000 }, async (t) => {
  const root = scratch(t);
  const slow = path.join(root, "slow-pty.cjs");
  fs.writeFileSync(slow, "exports.spawn = (shell, args, { hold }) => { Atomics.store(hold, 1, 1); Atomics.wait(hold, 0, 0, 60_000); return { pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; };");
  const hold = new Int32Array(new SharedArrayBuffer(8));
  const order = [];
  const pty = spawnTerminalPty(slow, "", [], { hold });
  t.after(() => pty.terminate());
  void pty.ready.then(() => order.push("terminal"));
  await until(() => Atomics.load(hold, 1));
  const launch = async (input) => {
    const host = await launchWorkerHost(input);
    order.push("host");
    return host;
  };
  const client = createWorkerHostClient({ root: path.join(root, "data"), runtimeRoot: await warmed(path.join(root, "runtime")), ptyModule: () => require.resolve("node-pty"), launch });
  const warm = client.prewarm();
  await until(() => fs.existsSync(path.join(root, "data", `v${WORKER_HOST_PROTOCOL}`, "launch.json")));
  await wait(1_000);
  const early = [...order];
  Atomics.store(hold, 0, 1);
  Atomics.notify(hold, 0);
  assert.equal(await warm, true);
  const host = client.state().host.pid;
  client.close();
  await until(() => !alive(host), 15_000);
  assert.deepEqual([early, order], [[], ["terminal", "host"]]);
});

test("a terminal opened as the host starts ends when it is stopped", { ...windows, timeout: 120_000 }, async (t) => {
  const root = scratch(t);
  const ptyModule = require.resolve("node-pty");
  const client = createWorkerHostClient({ root: path.join(root, "data"), runtimeRoot: await warmed(path.join(root, "runtime")), ptyModule: () => ptyModule });
  const warm = client.prewarm();
  const shell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const pty = spawnTerminalPty(ptyModule, shell, ["/d"], { name: "xterm-256color", cols: 80, rows: 24, cwd: os.tmpdir(), env: terminalEnvironment(process.env), useConptyDll: true });
  await pty.ready;
  assert.equal(await warm, true);
  const host = client.state().host.pid;
  void pty.kill().catch(() => {});
  const ended = await Promise.race([pty.exited.then(() => true), wait(8_000).then(() => false)]);
  client.close();
  await until(() => !alive(host), 15_000);
  if (!ended) await pty.terminate();
  assert.equal(ended, true);
});
