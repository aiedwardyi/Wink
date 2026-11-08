import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import os from "node:os";
import { createTerminalHost, paneProcesses } from "./terminal-host.mjs";

test("real PTY accepts input, resizes, replays output and reports shell exit", { timeout: 20000 }, async (t) => {
  let finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  const owner = { id: 1, mainFrame: {}, send(channel, value) { if (channel === "terminal:exit") finish(value); } };
  const host = createTerminalHost({ authorize() {}, resolveCwd: async () => os.tmpdir() });
  t.after(() => host.dispose());
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const input = { botId: "smoke", cols: 80, rows: 24 };
  const session = await host.open(event, input);
  await host.resize(event, session.id, 100, 30);
  await host.write(event, session.id, process.platform === "win32" ? "Write-Output ORBIT_PTY_SMOKE; exit 0\r" : "printf ORBIT_PTY_SMOKE; exit 0\n");
  const exit = await exited;
  assert.equal(exit.exitCode, 0);
  const replay = await host.open(event, input);
  assert.match(replay.output, /ORBIT_PTY_SMOKE/);
  assert.ok(replay.seq > 0);
  assert.equal(replay.exitCode, 0);
  host.dispose();
});

test("app shutdown closes its idle shell", { timeout: 20000 }, async (t) => {
  let ready;
  let finish;
  let output = "";
  const started = new Promise((resolve) => { ready = resolve; });
  const exited = new Promise((resolve) => { finish = resolve; });
  const owner = { id: 2, mainFrame: {}, send(channel, value) {
    if (channel === "terminal:data") {
      output += value.data;
      if (/ORBIT_SHELL_PID=(\d+)/.test(output)) ready(Number(output.match(/ORBIT_SHELL_PID=(\d+)/)[1]));
    }
    if (channel === "terminal:exit") finish(value);
  } };
  const host = createTerminalHost({ authorize() {}, resolveCwd: async () => os.tmpdir() });
  t.after(() => host.dispose());
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const session = await host.open(event, { botId: "shutdown", cols: 80, rows: 24 });
  await host.write(event, session.id, process.platform === "win32" ? "Write-Output ('ORBIT_SHELL_PID=' + $PID)\r" : "echo ORBIT_SHELL_PID=$$\n");
  const pid = await started;
  host.dispose();
  await exited;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("closing a bot pane stops a hidden process it started and spares an older one", { timeout: 30000 }, async (t) => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const older = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { detached: true, stdio: "ignore", windowsHide: true });
  older.unref();
  let sleeper = null;
  t.after(() => { for (const pid of [older.pid, sleeper]) if (pid && alive(pid)) process.kill(pid); });
  let output = "";
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const owner = { id: 3, mainFrame: {}, isDestroyed: () => false, send(channel, value) {
    if (channel !== "terminal:data") return;
    output += value.data;
    const match = output.match(/SLEEPER=(\d+)/);
    if (match) ready(Number(match[1]));
  } };
  const host = createTerminalHost({ authorize() {}, resolveCwd: async () => os.tmpdir(), owner: () => owner, processes: paneProcesses });
  t.after(() => host.dispose());
  const node = process.execPath;
  const command = process.platform === "win32"
    ? `$p = Start-Process -FilePath '${node}' -ArgumentList '-e','setTimeout(()=>{},600000)' -WindowStyle Hidden -PassThru; Write-Output ('SLEEPER=' + $p.Id)`
    : `nohup '${node}' -e 'setTimeout(()=>{},600000)' >/dev/null 2>&1 & echo SLEEPER=$!`;
  const pane = await host.openForBot("leftover", { label: "LEFT-1", command });
  sleeper = await started;
  assert.equal(alive(sleeper), true);
  const closedAt = Date.now();
  await host.closeForBot("leftover", pane.sessionId);
  while (alive(sleeper) && Date.now() - closedAt < 5000) await new Promise((resolve) => setTimeout(resolve, 100));
  t.diagnostic(`sleeper gone after ${Date.now() - closedAt} ms`);
  assert.throws(() => process.kill(sleeper, 0), { code: "ESRCH" });
  assert.equal(alive(older.pid), true);
});
