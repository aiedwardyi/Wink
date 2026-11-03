import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { createTerminalHost } from "./terminal-host.mjs";

const workers = await import("./terminal-worker.mjs").catch(() => null);
const policy = await import("../server/worker-launch.ts").catch(() => null);
const captures = await import("../server/worker-turn.ts").catch(() => null);

const THIRD = { id: "acct_third", generation: 3 };
const HOME = path.join(os.tmpdir(), "wink-ACCT-PANES", "account-3");

function launch(account = THIRD, engine = "codex", home = HOME) {
  return {
    kind: "managed", account, executable: engine, args: ["--model", "fixture"],
    environment: engine === "codex" ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home },
  };
}

function fixture(workerLaunch, options = {}) {
  const children = [];
  const owner = { id: 1, isDestroyed: () => false, send() {} };
  const host = createTerminalHost({
    authorize() {}, owner: () => owner, resolveCwd: async () => os.tmpdir(),
    workerLaunch, env: { SHELL: "/bin/sh", CODEX_HOME: "inherited-wrong", CLAUDE_CONFIG_DIR: "inherited-wrong" },
    platform: "linux", freeMemory: () => 8 * 1024 ** 3, setPriority() {},
    loadPty: () => ({ spawn(shell, args, spawnOptions) {
      const child = { shell, args, options: spawnOptions, writes: [], onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write(text) { this.writes.push(text); }, resize() {}, kill() {} };
      children.push(child);
      return child;
    } }),
    ...options,
  });
  return { host, children };
}

test("same-engine worker captures account 3 home at the trusted host boundary", async (t) => {
  const calls = [];
  const f = fixture(async (input) => { calls.push(input); return launch(); });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "worker", command: "codex 'task'", account: { id: "model-account" } });
  assert.equal(f.children[0].options.env.CODEX_HOME, HOME);
  assert.equal(calls[0].botId, "bot-1");
  assert.equal(calls[0].account, undefined);
});

test("model home overrides on managed launches are refused before a PTY starts", async (t) => {
  const f = fixture(async () => { throw new Error("Conflicting worker home override"); });
  t.after(() => f.host.dispose());
  await assert.rejects(f.host.openForBot("bot-1", { label: "worker", command: "$env:CODEX_HOME='wrong'; codex 'task'" }), /Conflicting worker home/);
  assert.equal(f.children.length, 0);
});

for (const engine of ["codex", "claude"]) {
  test(`${engine} managed workers skip profiles that export a conflicting home`, async (t) => {
    const f = fixture(async () => launch(THIRD, engine), { platform: "win32" });
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "worker", command: `${engine} 'task'` });
    assert.ok(f.children[0].args.includes("-NoProfile"));
    assert.equal(f.children[0].options.env[engine === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"], HOME);
  });
}

test("other-engine worker explicitly captures the base account", async (t) => {
  const baseHome = path.join(os.tmpdir(), "wink-ACCT-PANES", "base-claude");
  const f = fixture(async () => launch({ id: "claude", generation: 0 }, "claude", baseHome));
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "worker", command: "claude 'task'" });
  assert.equal(f.children[0].options.env.CLAUDE_CONFIG_DIR, baseHome);
});

test("ambiguous workers are refused rather than launched on account 1", async (t) => {
  const f = fixture(async () => { throw new Error("Ambiguous worker launch"); });
  t.after(() => f.host.dispose());
  await assert.rejects(f.host.openForBot("bot-1", { label: "worker", command: "& codex 'task'" }), /Ambiguous worker/);
  assert.equal(f.children.length, 0);
});

test("existing panes retain their captured id and generation across a bot account change", async (t) => {
  let selected = launch();
  const f = fixture(async () => selected);
  t.after(() => f.host.dispose());
  const first = await f.host.openForBot("bot-1", { label: "first", command: "codex 'task'" });
  selected = launch({ id: "acct_fourth", generation: 4 });
  await f.host.openForBot("bot-1", { label: "second", command: "codex 'task'" });
  assert.deepEqual(f.host.livePanesForAccount?.(THIRD.id), { count: 1, unknown: 0, generations: { "3": 1 } });
  assert.deepEqual(f.host.livePanesForAccount?.("acct_fourth"), { count: 1, unknown: 0, generations: { "4": 1 } });
  f.children[0].exit({ exitCode: 0 });
  assert.equal(f.host.livePanesForAccount(THIRD.id).count, 0);
  assert.equal(f.host.readBot("bot-1", { sessionId: first.sessionId }).exited, true);
});

test("a trusted usage hold creates no shell", async (t) => {
  const f = fixture(async () => ({ kind: "hold", hold: "Held: selected account" }));
  t.after(() => f.host.dispose());
  assert.deepEqual(await f.host.openForBot("bot-1", { label: "worker", command: "codex 'task'" }), { hold: "Held: selected account" });
  assert.equal(f.children.length, 0);
});

test("no-accounts launch preserves shell, environment and command", async (t) => {
  let called = 0;
  const f = fixture(async () => { called++; throw new Error("unexpected account lookup"); }, { workerAccountsEnabled: false });
  t.after(() => f.host.dispose());
  await f.host.openForBot("bot-1", { label: "worker", command: "codex 'task'" });
  assert.equal(f.children[0].shell, "/bin/sh");
  assert.deepEqual(f.children[0].args, []);
  assert.equal(f.children[0].options.env.CODEX_HOME, "inherited-wrong");
  assert.equal(f.children[0].options.env.CLAUDE_CONFIG_DIR, "inherited-wrong");
  assert.deepEqual(f.children[0].writes, ["codex 'task'\r"]);
  assert.equal(called, 0);
});

test("later managed engine input on a plain shell is refused before submission", async (t) => {
  const f = fixture(async (input) => {
    if (input.mode === "send" && /codex/.test(input.command)) throw new Error("Managed worker launches require terminal_spawn");
    return { kind: "shell" };
  });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "shell" });
  await assert.rejects(async () => f.host.sendBot("bot-1", { ...pane, text: "codex 'task'\n" }), /terminal_spawn/);
  assert.deepEqual(f.children[0].writes, []);
});

test("pending launches and plain shells are reported as unknown account use", async (t) => {
  let release;
  const f = fixture(() => new Promise((resolve) => { release = resolve; }));
  t.after(() => f.host.dispose());
  const opening = f.host.openForBot("bot-1", { label: "shell" });
  try {
    assert.equal(f.host.livePanesForAccount?.(THIRD.id).unknown, 1);
  } finally {
    release?.({ kind: "shell" });
    await opening;
  }
  assert.equal(f.host.livePanesForAccount(THIRD.id).unknown, 1);
});

test("managed command serialization preserves prompt text and expands only pane grants", () => {
  assert.ok(workers, "managed command serialization exists");
  const worker = { executable: "codex", args: ["task'; echo wrong", "value=\u0000ORBIT_PANE\u0000"] };
  assert.equal(workers.managedWorkerCommand(worker, { ORBIT_PANE: "trusted-pane" }, "win32"), "& 'codex' 'task''; echo wrong' 'value=trusted-pane'");
});

test("private worker policy requests fail closed and never return an inherited launch", async () => {
  assert.ok(workers, "private worker launch client exists");
  const input = { botId: "bot-1", command: "codex", environment: {} };
  const calls = [];
  const request = async (...args) => { calls.push(args); return Response.json({ launch: launch() }); };
  const result = await workers.resolveWorkerLaunch({ url: "http://fixture", token: "server" }, { token: "host" }, input, request);
  assert.equal(result.account.id, THIRD.id);
  assert.equal(calls[0][1].headers["x-orbit-terminal-host"], "host");
  await assert.rejects(workers.resolveWorkerLaunch({ url: "http://fixture", token: "server" }, { token: "host" }, input, async () => { throw new Error("offline"); }), /offline/);
});

test("the captured-turn resolver and core policy reach the final fake PTY environment", async (t) => {
  assert.ok(policy, "trusted worker policy exists");
  assert.ok(captures, "active-turn account resolver exists");
  const turns = captures.createWorkerTurns();
  turns.capture("bot-1", "thread", { instanceId: THIRD.id, driverKind: "codex", account: { ...THIRD, of: "codex", home: HOME } });
  const usageCalls = [];
  const usage = Object.assign(async (...args) => { usageCalls.push(args); return { line: "Captured usage." }; }, { invalidate() {} });
  const prepare = policy.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: turns.resolveWorkerTurn,
    bases: () => ({ codex: { driver: "codex" } }), available: () => true, usage });
  const f = fixture(prepare, { platform: "win32", env: { CODEX_HOME: "profile-home", OpenAI_Api_Key: "profile-key", BASH_ENV: "profile" } });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", { label: "worker", command: "codex --model fixture 'task'" });
  assert.equal(f.children[0].options.env.CODEX_HOME, HOME);
  assert.equal(f.children[0].options.env.OpenAI_Api_Key, undefined);
  assert.equal(f.children[0].options.env.BASH_ENV, undefined);
  assert.ok(f.children[0].args.includes("-NoProfile"));
  assert.match(f.children[0].writes[0], /'--no-daemon'/);
  assert.deepEqual(usageCalls[0][3], { ...THIRD, name: "Codex" });
  assert.equal(pane.line, "Captured usage.");
  assert.equal(f.host.livePanesForAccount(THIRD.id).count, 1);
});
