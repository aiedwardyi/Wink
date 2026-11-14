import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTerminalHost, paneProcesses } from "./terminal-host.mjs";
import { createWorkerHostClient } from "./worker-host-client.mjs";
import { sweepWorkerHostRuntime } from "./worker-host-runtime.mjs";

const require = createRequire(import.meta.url);
const windows = process.platform === "win32" ? {} : { skip: "the worker host ships on Windows first" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// One copy of the runtime serves every test here; each test still starts its own host.
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-host-"));
test.after(async () => {
  await sweepWorkerHostRuntime(runtimeRoot, []);
  fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function until(check, timeoutMs = 60_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await wait(25)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error("Timed out waiting for the hosted pane");
}

async function fixture(t, { client: clientOptions = {}, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-worker-host-"));
  const home = path.join(root, "home");
  for (const folder of ["Roaming", "Local"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  const lines = [];
  const asked = [];
  const seen = { text: "", exits: [] };
  const cleanup = { opened: [], exited: [], closed: [] };
  const client = createWorkerHostClient({ root: path.join(root, "data"), runtimeRoot, ptyModule: () => require.resolve("node-pty"), log: (line) => lines.push(line), ...clientOptions });
  const connected = await client.prewarm();
  const hostPid = client.state().host?.pid ?? null;
  const owner = { id: 7, mainFrame: {}, isDestroyed: () => false, send(channel, value) {
    if (channel === "terminal:data") seen.text += value.data;
    if (channel === "terminal:exit") seen.exits.push(value);
  } };
  const host = createTerminalHost({
    authorize() {},
    resolveCwd: async () => root,
    owner: () => owner,
    env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local"), POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" },
    freeMemory: () => 64 * 1024 ** 3,
    paneCleanup: { start() {}, dispose() {}, opened: (session) => cleanup.opened.push(session.id), exited: (session) => cleanup.exited.push(session.id), closed: (session, keep) => cleanup.closed.push([session.id, keep]) },
    hostPty: (request, local) => {
      asked.push(request.tag);
      return client.spawn(request, local);
    },
    ...options,
  });
  t.after(async () => {
    await host.dispose();
    client.close();
    if (hostPid) await until(() => !alive(hostPid), 15_000);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return { root, host, client, owner, connected, lines, asked, seen, cleanup };
}

test("a hosted bot pane streams to a live viewer and takes its input and resize", { ...windows, timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(f.connected, true);
  const pane = await f.host.openForBot("bot-1", { label: "HOST-1", command: 'Write-Output ("OPEN=" + (1 + 1))' });
  assert.equal(f.client.state().panes, 1);
  assert.deepEqual(f.cleanup.opened, [pane.sessionId]);
  await until(() => f.seen.text.includes("OPEN=2"));
  const frames = [];
  const viewer = { send(frame) { frames.push(frame); return 0; }, drop() {}, end() { frames.push({ ended: true }); } };
  const watching = f.host.watchBot("bot-1", pane.sessionId, viewer);
  assert.match(watching.snapshot.output, /OPEN=2/);
  const live = () => frames.map((frame) => frame.data ?? "").join("");
  const target = { sessionId: pane.sessionId, generation: pane.generation };
  await f.host.inputBot("bot-1", { ...target, data: 'Write-Output ("LIVE=" + (2 + 3))\r' });
  await until(() => live().includes("LIVE=5"));
  assert.equal(live().match(/LIVE=5/g).length, 1);
  assert.ok(frames.find((frame) => frame.data).seq > watching.snapshot.seq);
  await f.host.resizeBot("bot-1", { ...target, cols: 132, rows: 40 });
  assert.ok(frames.some((frame) => frame.cols === 132 && frame.rows === 40));
  await f.host.inputBot("bot-1", { ...target, data: 'Write-Output ("WIDE=" + $Host.UI.RawUI.WindowSize.Width)\r' });
  await until(() => live().includes("WIDE=132"));
  const [listed] = await f.client.panes();
  assert.deepEqual([listed.id, listed.tag, listed.cols, listed.rows], [pane.sessionId, "bot-1", 132, 40]);
  assert.match(listed.mark.kind, /^[CD]$/);
  assert.ok(listed.mark.value.startsWith(pane.sessionId));
  assert.equal(alive(listed.pid), true);
  await f.host.inputBot("bot-1", { ...target, data: "exit 3\r" });
  await until(() => f.seen.exits.length);
  assert.equal(f.seen.exits[0].exitCode, 3);
  assert.deepEqual(f.cleanup.exited, [pane.sessionId]);
  assert.ok(frames.some((frame) => frame.exitCode === 3));
  assert.equal(alive(listed.pid), false);
  assert.deepEqual(f.asked, ["bot-1"]);
  assert.equal(f.lines.length, 1);
});

test("closing a hosted pane stops a hidden process it started, and the pane has its scratch folder", { ...windows, timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { processes: paneProcesses, scratchRoot: path.join(os.tmpdir(), "wink-worker-host-scratch") });
  const scratch = path.join(os.tmpdir(), "wink-worker-host-scratch", "wink-LEFT-1");
  let sleeper = null;
  t.after(() => {
    if (sleeper && alive(sleeper)) process.kill(sleeper);
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const command = `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','setTimeout(()=>{},600000)' -WindowStyle Hidden -PassThru; Write-Output ('SLEEPER=' + $p.Id + ' SCRATCH=' + $env:ORBIT_SCRATCH + ' TEMP=' + $env:TEMP + ' END')`;
  const pane = await f.host.openForBot("bot-1", { label: "LEFT-1", command });
  const [, pid, folder, temp] = await until(() => f.seen.text.match(/SLEEPER=(\d+) SCRATCH=(.+?) TEMP=(.+?) END/));
  sleeper = Number(pid);
  assert.deepEqual([folder, temp], [scratch, scratch]);
  assert.equal(alive(sleeper), true);
  const [listed] = await f.client.panes();
  assert.equal(listed.id, pane.sessionId);
  await f.host.closeForBot("bot-1", pane.sessionId, true);
  assert.deepEqual(f.cleanup.closed, [[pane.sessionId, true]]);
  assert.equal(alive(listed.pid), false);
  await until(() => !alive(sleeper), 15_000);
  assert.equal(f.client.state().panes, 0);
  await until(async () => !(await f.client.panes()).length);
});

test("a hosted remote pane types its ssh line", { ...windows, timeout: 120_000 }, async (t) => {
  const opens = [];
  const remote = { open: async (input) => {
    opens.push([input.name, input.command, input.cwd, input.slot.host]);
    return 'Write-Output ("REMOTE=" + (6 * 7))';
  } };
  const f = await fixture(t, { remote });
  const pane = await f.host.openForBot("bot-1", { label: "FAR-1", host: "work", cwd: "D:\\far\\folder", command: "claude 'Read card.md'" });
  await until(() => f.seen.text.includes("REMOTE=42"));
  assert.deepEqual(opens, [["work", "claude 'Read card.md'", "D:\\far\\folder", "work"]]);
  assert.equal(f.host.readBot("bot-1").panes.find((listed) => listed.sessionId === pane.sessionId).host, "work");
  assert.equal(f.client.state().panes, 1);
  const [listed] = await f.client.panes();
  await f.host.dispose();
  assert.equal(alive(listed.pid), false);
  assert.equal(f.client.state().panes, 0);
});

test("a bot pane opens locally when the host cannot start, and the main shell never asks", { ...windows, timeout: 120_000 }, async (t) => {
  const f = await fixture(t, { client: { launch: async () => { throw new Error("runtime copy failed"); } } });
  assert.equal(f.connected, false);
  const event = { sender: f.owner, senderFrame: f.owner.mainFrame };
  await f.host.open(event, { botId: "bot-1", cols: 80, rows: 24 });
  assert.deepEqual(f.asked, []);
  await f.host.openForBot("bot-1", { label: "LOCAL-1", command: 'Write-Output ("LOCAL=" + (8 + 1))' });
  await until(() => f.seen.text.includes("LOCAL=9"));
  assert.deepEqual(f.asked, ["bot-1"]);
  assert.equal(f.client.state().panes, 0);
  assert.deepEqual(f.lines, ["worker host missing (runtime copy failed): panes open locally"]);
});
