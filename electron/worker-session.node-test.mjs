import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPaneRuns } from "./pane-runs.mjs";
import { createTerminalHost } from "./terminal-host.mjs";
import { createTerminalBridge } from "./terminal-bridge.mjs";
import { installOrbitMsg } from "./terminal-mailbox.mjs";
import { managedWorkerCommand } from "./terminal-worker.mjs";
import { claudeSessionArgs } from "./worker-session.mjs";

async function fixture(t, engine = "codex", overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-"));
  const file = path.join(dir, "pane-runs.json");
  const binDir = await installOrbitMsg(path.join(dir, "bin"), "win32");
  const children = [];
  const runs = createPaneRuns(file);
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  let address;
  const host = createTerminalHost({
    authorize() {}, owner: () => owner, resolveCwd: async () => dir,
    platform: "win32", freeMemory: () => 8 * 1024 ** 3, setPriority() {},
    env: {}, paneRuns: runs, sessionBridge: () => address?.url,
    mailbox: async () => ({ url: "http://127.0.0.1:9", token: "fixture", binDir }),
    workerLaunch: async () => ({ kind: "managed", executable: engine, args: ["--model", "fixture"],
      account: { id: "account-3", generation: 3 }, environment: { CODEX_THREAD_ID: "parent", CLAUDE_SESSION_ID: "parent", CLAUDECODE: "1" },
      session: { engine, launchGeneration: randomUUID(), nativeId: engine === "claude" ? randomUUID() : null, model: "fixture", effort: "high" } }),
    loadPty: () => ({ spawn(shell, args, options) {
      const child = { options, writes: [], onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write(text) { this.writes.push(text); }, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }), ...overrides,
  });
  const bridge = createTerminalBridge({ host });
  address = await bridge.start();
  t.after(async () => { await host.dispose(); await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const open = () => host.openForBot("bot", { command: `${engine} task` });
  const payload = (index, nativeId = randomUUID()) => ({ pane: children[index].options.env.ORBIT_PANE,
    launchGeneration: children[index].options.env.ORBIT_SESSION_GENERATION,
    session_id: nativeId, cwd: dir, transcript_path: path.join(dir, `${nativeId}.jsonl`), source: "startup" });
  const post = (index, body) => fetch(`${address.url}/v1/terminal/session`, { method: "POST",
    headers: { authorization: `Bearer ${children[index].options.env.ORBIT_SESSION_AUTH}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { dir, file, binDir, host, children, runs, open, payload, post, read };
}

for (const engine of ["claude", "codex"]) {
  test(`${engine} captures its hook id and launch metadata through the bridge`, async (t) => {
    const f = await fixture(t, engine);
    const pane = await f.open();
    const pending = f.read()[0].session;
    assert.equal(pending.engine, engine);
    const hook = f.payload(0, pending.nativeId ?? randomUUID());
    assert.equal((await f.post(0, hook)).status, 200);
    assert.deepEqual(f.read()[0].session, { ...pending, nativeId: hook.session_id,
      transcriptPath: hook.transcript_path, source: "startup" });
    assert.equal(pending.pane, pane.sessionId);
    assert.equal(pending.generation, pane.generation);
    assert.equal(pending.accountId, "account-3");
    assert.equal(pending.accountGeneration, 3);
    assert.equal(pending.cwd, f.dir);
    assert.equal(pending.model, "fixture");
    assert.equal(pending.effort, "high");
    assert.equal(pending.lifecycle, "running");
    assert.equal((await f.post(0, { ...hook, source: "resume" })).status, 200);
    assert.equal(f.read()[0].session.source, "resume");
    const prior = createPaneRuns(f.file).restarted().get("bot")[0];
    assert.deepEqual(prior.session, f.read()[0].session);
    assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /fixture-token|ORBIT_SESSION_AUTH|environment/);
    assert.equal(f.children[0].options.env.CODEX_THREAD_ID, undefined);
    assert.equal(f.children[0].options.env.CLAUDE_SESSION_ID, undefined);
    assert.equal(f.children[0].options.env.CLAUDECODE, undefined);
  });
}

test("callbacks reject the wrong pane, generation, id, cwd and grant", async (t) => {
  const f = await fixture(t, "claude");
  await f.open();
  const hook = f.payload(0, f.read()[0].session.nativeId);
  for (const change of [{ pane: randomUUID() }, { launchGeneration: randomUUID() }, { session_id: randomUUID() }, { cwd: os.tmpdir() }, { source: "compact" }]) {
    assert.equal((await f.post(0, { ...hook, ...change })).status, 409);
  }
  assert.equal((await fetch(`${f.children[0].options.env.ORBIT_SESSION_URL}`, { method: "POST", body: JSON.stringify(hook) })).status, 409);
  assert.equal(f.read()[0].session.source, undefined);
});

test("two panes in one cwd retain their ids and reject a stale callback after relaunch", async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  await f.open();
  const hooks = [f.payload(0), f.payload(1)];
  for (let i = 0; i < 2; i++) assert.equal((await f.post(i, hooks[i])).status, 200);
  assert.deepEqual(f.read().map((run) => run.session.nativeId), hooks.map((hook) => hook.session_id));
  assert.equal((await f.post(0, { ...hooks[0], session_id: randomUUID() })).status, 409);
  await f.host.closeForBot("bot", first.sessionId);
  await f.open();
  assert.equal((await f.post(0, hooks[0])).status, 409);
  assert.equal(f.read().at(-1).session.nativeId, null);
});

test("reported and ended runs keep lifecycle and reject late captures", async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  f.host.attendBot("bot", first.sessionId, "report");
  assert.equal(f.read()[0].session.lifecycle, "reported");
  assert.equal((await f.post(0, f.payload(0))).status, 409);
  await f.open();
  f.children[1].exit({ exitCode: 0 });
  assert.equal(f.read()[1].session.lifecycle, "ended");
  assert.equal((await f.post(1, f.payload(1))).status, 409);
});

test("following up keeps the captured session, and a later shell command clears it", async (t) => {
  const f = await fixture(t);
  const pane = await f.open();
  const hook = f.payload(0);
  assert.equal((await f.post(0, hook)).status, 200);
  f.host.attendBot("bot", pane.sessionId, "report");
  await f.host.sendBot("bot", { ...pane, text: "next task\r" });
  assert.equal(f.read()[0].session.nativeId, hook.session_id);
  assert.equal(f.read()[0].session.lifecycle, "running");
  f.children[0].data(`\x1b]133;C;${pane.sessionId};${"a".repeat(43)}=\x07\x1b]133;D;${pane.sessionId};1\x07`);
  await f.host.sendBot("bot", { ...pane, text: "git status\r" });
  assert.equal(f.read()[0].session, undefined);
  assert.equal((await f.post(0, hook)).status, 409);
});

test("Claude inline permissions survive startup hook injection", () => {
  for (const args of [["--settings", '{"permissions":{"allow":["Read"]}}'], ['--settings={"permissions":{"allow":["Read"]}}']]) {
    const command = managedWorkerCommand({ executable: "claude", args, session: { engine: "claude" } }, {}, "win32", "C:/bin");
    assert.match(command, /"allow":\["Read"\]/);
    assert.match(command, /"matcher":"startup\|resume"/);
    assert.equal(command.split("--settings").length, 2);
  }
});

for (const inline of [false, true]) {
  const settingsArgs = (value) => inline ? [`--settings=${value}`] : ["--settings", value];

  test(`Claude file settings pass through without a session record (${inline ? "equals" : "separate"})`, async (t) => {
    const args = ["--model", "fixture", ...settingsArgs("C:/custom/settings.json")];
    const original = [...args];
    assert.deepEqual(claudeSessionArgs(args, "C:/bin"), original);
    const f = await fixture(t, "claude", { workerLaunch: async () => ({ kind: "managed", executable: "claude", args,
      account: { id: "account-3", generation: 3 }, environment: {},
      session: { engine: "claude", launchGeneration: randomUUID(), nativeId: randomUUID(), model: "fixture", effort: "high" } }) });
    await f.open();
    assert.equal(f.read()[0].session, undefined);
    assert.equal(f.children[0].options.env.ORBIT_SESSION_AUTH, undefined);
    assert.equal(f.children[0].writes[0], `${managedWorkerCommand({ executable: "claude", args: original }, {}, "win32")}\r`);
    assert.equal((await f.post(0, f.payload(0))).status, 409);
  });

  test(`Claude inline settings preserve every existing hook (${inline ? "equals" : "separate"})`, () => {
    const startup = { matcher: "startup", hooks: [{ type: "command", command: "custom-start" }] };
    const stop = [{ hooks: [{ type: "command", command: "custom-stop" }] }];
    const value = { permissions: { allow: ["Read"] }, model: "custom", hooks: { SessionStart: [startup], Stop: stop } };
    const args = claudeSessionArgs(settingsArgs(JSON.stringify(value)), "C:/bin");
    const merged = JSON.parse(inline ? args[0].slice(11) : args[1]);
    assert.deepEqual(merged, { ...value, hooks: { ...value.hooks, SessionStart: [startup, merged.hooks.SessionStart.at(-1)] } });
    assert.equal(merged.hooks.SessionStart.length, 2);
    assert.equal(merged.hooks.SessionStart[1].matcher, "startup|resume");
    assert.match(merged.hooks.SessionStart[1].hooks[0].command, /orbit-session\.ps1/);
  });
}

test("Claude without settings gets only the session hook", () => {
  const args = ["--model", "fixture", "task"];
  const updated = claudeSessionArgs(args, "C:/bin");
  assert.deepEqual(updated.slice(0, -2), args);
  assert.equal(updated.at(-2), "--settings");
  const settings = JSON.parse(updated.at(-1));
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  assert.deepEqual(Object.keys(settings.hooks), ["SessionStart"]);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.SessionStart[0].matcher, "startup|resume");
});

test("a new launch generation on the same pane rejects its previous callback", async (t) => {
  const f = await fixture(t);
  await f.open();
  const old = f.payload(0);
  const run = f.read()[0];
  const launchGeneration = randomUUID();
  f.runs.started({ ...run, session: { ...run.session, launchGeneration } });
  assert.equal(f.runs.capture(old), false);
  assert.equal(f.runs.capture({ ...old, launchGeneration }), true);
  assert.equal(f.read()[0].session.nativeId, old.session_id);
});

test("a failed atomic capture preserves the previous file and in-memory id", async (t) => {
  const f = await fixture(t);
  await f.open();
  const previous = fs.readFileSync(f.file, "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("locked"); });
  assert.equal(f.runs.capture(f.payload(0)), false);
  assert.equal(fs.readFileSync(f.file, "utf8"), previous);
  rename.mock.restore();
  const next = f.payload(0);
  assert.equal(f.runs.capture(next), true);
  assert.equal(f.read()[0].session.nativeId, next.session_id);
  assert.deepEqual(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp")), []);
});

test("old-format runs remain readable and old builds tolerate new fields", async (t) => {
  const f = await fixture(t);
  const legacy = { id: "old", botId: "bot", cwd: f.dir, spawnedAt: 1, state: "running" };
  fs.writeFileSync(f.file, JSON.stringify([legacy]));
  assert.deepEqual(createPaneRuns(f.file).restarted().get("bot"), [legacy]);
  await f.open();
  const source = execFileSync("git", ["show", "44bf8af3:electron/pane-runs.mjs"], { encoding: "utf8", windowsHide: true });
  const oldFile = path.join(f.dir, "old-pane-runs.mjs");
  fs.writeFileSync(oldFile, source);
  const { createPaneRuns: oldRuns } = await import(`file:///${oldFile.replaceAll("\\", "/")}`);
  assert.deepEqual(oldRuns(f.file).restarted().get("bot")[0], f.read()[0]);
});

test("other engines and unmanaged commands do not record native sessions", async (t) => {
  for (const engine of ["grok", "muse", "agy"]) {
    const f = await fixture(t, engine);
    await f.open();
    assert.equal(f.read()[0].session, undefined);
    assert.equal(f.children[0].options.env.ORBIT_SESSION_AUTH, undefined);
  }
  const f = await fixture(t, "codex", { workerLaunch: async () => ({ kind: "shell" }) });
  await f.open();
  assert.equal(f.read()[0].session, undefined);
});

test("installed startup hooks post only the native session fields", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  await f.open();
  const settings = JSON.parse(fs.readFileSync(path.join(f.binDir, "claude-worker.json"), "utf8"));
  assert.ok(settings.hooks.SessionStart.some((group) => group.matcher === "compact"));
  const group = settings.hooks.SessionStart.find((group) => group.matcher === "startup|resume");
  assert.ok(group);
  const hook = f.payload(0);
  await new Promise((resolve, reject) => {
    const child = execFile(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(f.binDir, "orbit-session.ps1")],
      { windowsHide: true, env: { ...process.env, ...f.children[0].options.env } }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message} ${stderr}`));
        else { assert.equal(stdout, ""); resolve(); }
      });
    child.stdin.end(JSON.stringify({ ...hook, hook_event_name: "SessionStart", secret: "must-not-persist" }));
  });
  assert.equal(f.read()[0].session.nativeId, hook.session_id);
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /must-not-persist/);
  assert.match(f.children[0].writes[0], /hooks.SessionStart=/);
  assert.match(f.children[0].writes[0], /trusted_hash/);
  assert.doesNotMatch(f.children[0].writes[0], /dangerously-bypass-hook-trust/);
});
