import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { createTerminalHost } from "./terminal-host.mjs";
import { mailboxGrant } from "./terminal-mailbox.mjs";

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

for (const platform of ["linux", "win32"]) {
  test(`managed Claude trust survives command serialization on ${platform}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.UTC(2026, 9, 24) });
    const worker = { ...launch(THIRD, "claude"), args: ["--dangerously-skip-permissions", "task"] };
    const f = fixture(async () => worker, { platform, now: () => Date.now() });
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { command: "claude --dangerously-skip-permissions 'task'" });
    const child = f.children[0];
    const recorded = JSON.parse(readFileSync(new URL("./terminal-host.trust.fixture.json", import.meta.url), "utf8"));
    let elapsed = 0;
    for (const entry of recorded.redraw) {
      t.mock.timers.tick(entry.t - elapsed);
      elapsed = entry.t;
      child.data(entry.data);
      await Promise.resolve();
    }
    t.mock.timers.tick(500);
    await Promise.resolve();
    assert.equal(child.writes.at(-1), "\x1b[B");
    child.data(recorded.redraw.find((entry) => entry.data.includes("1B>")).data);
    t.mock.timers.tick(500);
    await Promise.resolve();
    assert.equal(child.writes.at(-1), "\r");
  });
}

test("split engine input on a plain shell is still refused before submission", async (t) => {
  const f = fixture(async (input) => {
    if (input.mode === "send" && /^codex\b/.test(input.command)) throw new Error("Managed worker launches require terminal_spawn");
    return { kind: "shell" };
  });
  t.after(() => f.host.dispose());
  const pane = await f.host.openForBot("bot-1", {});
  await f.host.sendBot("bot-1", { ...pane, text: "co" });
  await assert.rejects(f.host.sendBot("bot-1", { ...pane, text: "dex 'task'\n" }), /terminal_spawn/);
  assert.deepEqual(f.children[0].writes, ["co"]);
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

test("pending launches block removal until a plain shell is confirmed unrelated", async (t) => {
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
  assert.deepEqual(f.host.livePanesForAccount(THIRD.id), { count: 0, unknown: 0, generations: {} });
});

test("managed command serialization preserves prompt text and expands only pane grants", () => {
  assert.ok(workers, "managed command serialization exists");
  const worker = { executable: "codex", args: ["task'; echo wrong", "value=\u0000ORBIT_PANE\u0000"] };
  assert.equal(workers.managedWorkerCommand(worker, { ORBIT_PANE: "trusted-pane" }, "win32"), "& 'codex' 'task''; echo wrong' 'value=trusted-pane'");
});

for (const platform of ["win32", "linux"]) {
  test(`managed ${platform} commands defer secret placeholders to the pane shell`, () => {
    const environment = { ORBIT_MSG_AUTH: mailboxGrant("test-token", "pane", "bot", "bot"), ORBIT_MSG_TOKEN: mailboxGrant("test-token", "legacy", "bot", "bot"),
      ORBIT_PANE: "pane", ORBIT_BOT: "bot", ORBIT_TEACHER: "teacher", ORBIT_URL: "http://127.0.0.1:9" };
    const args = Object.keys(environment).map((name) => `${name}=\u0000${name}\u0000`);
    const command = workers.managedWorkerCommand({ executable: "codex", args }, environment, platform);
    for (const name of ["ORBIT_MSG_AUTH", "ORBIT_MSG_TOKEN"]) {
      assert.ok(!command.includes(environment[name]));
      assert.ok(command.includes(platform === "win32" ? `$env:${name}` : `"$${name}"`));
    }
    for (const name of ["ORBIT_PANE", "ORBIT_BOT", "ORBIT_TEACHER", "ORBIT_URL"]) assert.ok(command.includes(`${name}=${environment[name]}`));
    assert.ok(!command.includes("\u0000"));
  });

  test(`managed ${platform} commands pass real secret values to the launched process`, { skip: platform === "win32" && process.platform !== "win32" }, (t) => {
    const shell = platform === "win32" ? "powershell.exe" : process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
    const environment = { ORBIT_MSG_AUTH: mailboxGrant("test-token", "pane", "bot", "bot"), ORBIT_MSG_TOKEN: mailboxGrant("test-token", "legacy", "bot", "bot"),
      ORBIT_PANE: "pane", ORBIT_BOT: "bot", ORBIT_TEACHER: "teacher", ORBIT_URL: "http://127.0.0.1:9" };
    const args = ["shell_environment_policy.set.ORBIT_MSG_AUTH='\u0000ORBIT_MSG_AUTH\u0000'", "\u0000ORBIT_MSG_TOKEN\u0000", "before'\u0000ORBIT_MSG_AUTH\u0000'$`;after",
      "\u0000ORBIT_MSG_AUTH\u0000/\u0000ORBIT_MSG_TOKEN\u0000", ...["ORBIT_PANE", "ORBIT_BOT", "ORBIT_TEACHER", "ORBIT_URL"].map((name) => `\u0000${name}\u0000`)];
    const command = workers.managedWorkerCommand({ executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args] }, environment, platform);
    assert.ok(!command.includes(environment.ORBIT_MSG_AUTH));
    assert.ok(!command.includes(environment.ORBIT_MSG_TOKEN));
    const script = "$ProgressPreference = 'SilentlyContinue'; $command = [Console]::In.ReadToEnd(); Invoke-Expression $command";
    let output;
    try {
      output = execFileSync(shell, platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : [], {
        input: command, encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, ...environment, MSYS2_ARG_CONV_EXCL: "*" },
      });
    } catch (error) {
      if (platform !== "win32" && error.code === "ENOENT") return t.skip("POSIX shell is unavailable");
      throw error;
    }
    assert.deepEqual(JSON.parse(output), args.map((arg) => arg.replace(/\u0000(ORBIT_[A-Z_]+)\u0000/g, (_, name) => environment[name])));
  });
}

test("a POSIX credit launch clears the key after Ctrl+C and a failing exit", async (t) => {
  const key = "sk-proj-WINKFAKECTRLC-0001";
  const name = "WINK_OPENAI_CREDIT_KEY";
  const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
  for (const body of ["kill -INT 0", "exit 3", `test -n "$${name}" && echo seen`]) {
    const line = workers.managedWorkerCommand({ executable: "sh", args: ["-c", body], clearEnv: [name] }, {}, "linux");
    // A detached shell leads its own process group, so kill 0 stands in for Ctrl+C without reaching the test runner.
    const child = spawn(shell, ["-i"], { detached: process.platform !== "win32", windowsHide: true, env: { ...process.env, [name]: key } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const closed = new Promise((resolve) => child.on("close", resolve));
    const started = await new Promise((resolve) => { child.on("spawn", () => resolve(true)); child.on("error", () => resolve(false)); });
    if (!started) return t.skip("POSIX shell is unavailable");
    child.stdin.end(`${line}\nprintenv ${name}; echo done\n`);
    await closed;
    assert.match(output, /done/);
    assert.ok(!output.includes(key), body);
    if (body.includes("seen")) assert.match(output, /seen/);
  }
  assert.equal(workers.managedWorkerCommand({ executable: "sh", args: ["-c", "kill -INT 0"], clearEnv: [name] }, {}, "linux"),
    `(trap : INT; 'sh' '-c' 'kill -INT 0'; exit); unset ${name}`);
});

test("managed Windows commands preserve smart quotes as one literal argument", () => {
  for (const prompt of ["don\u2019t", "x\u2019; calc; \u2019y", "a\u2018b", "a\u201ab", "a\u201bb"]) {
    const command = workers.managedWorkerCommand({ executable: "codex", args: [prompt] }, {}, "win32");
    assert.equal(command, `& 'codex' '${prompt.replace(/['\u2018\u2019\u201a\u201b]/g, (mark) => mark + mark)}'`);
  }
});

test("PowerShell parses smart-quoted prompts without extra commands", { skip: process.platform !== "win32" }, () => {
  const prompts = ["don\u2019t", "x\u2019; calc; \u2019y", "a\u2018b", "a\u201ab", "a\u201bb"];
  const commands = prompts.map((prompt) => workers.managedWorkerCommand({ executable: "codex", args: [prompt] }, {}, "win32"));
  const script = `[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $commands = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $values = foreach ($command in $commands) {
      $tokens = $null; $errors = $null
      $ast = [Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors)
      if ($errors.Count -or $ast.EndBlock.Statements.Count -ne 1 -or $ast.EndBlock.Statements[0].PipelineElements.Count -ne 1) { throw 'Unexpected command structure' }
      $ast.EndBlock.Statements[0].PipelineElements[0].CommandElements[1].Value
    }
    ConvertTo-Json -Compress -InputObject @($values)`;
  const parsed = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    input: JSON.stringify(commands), encoding: "utf8", windowsHide: true,
  });
  assert.deepEqual(JSON.parse(parsed), prompts);
});

test("the terminal test command includes worker account regressions", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.scripts["test:terminal"].includes("electron/terminal-worker.node-test.mjs"));
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

for (const platform of ["linux", "win32"]) {
  test(`default Claude config stays unset in the final fake PTY on ${platform}`, async (t) => {
    const inherited = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    t.after(() => {
      if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = inherited;
    });
    const turns = captures.createWorkerTurns();
    turns.capture("bot-1", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
    const usageCalls = [];
    const usage = Object.assign(async (...args) => { usageCalls.push(args); return {}; }, { invalidate() {} });
    const prepare = policy.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: turns.resolveWorkerTurn,
      bases: () => ({ claude: { driver: "claudeAgent" } }), available: () => true, usage });
    const f = fixture(prepare, { platform });
    t.after(() => f.host.dispose());
    await f.host.openForBot("bot-1", { label: "worker", command: "claude 'task'" });
    assert.equal(f.children[0].options.env.CLAUDE_CONFIG_DIR, undefined);
    assert.deepEqual(usageCalls[0][3], { id: "claude", generation: 0, name: "Claude" });
    assert.deepEqual(f.host.livePanesForAccount("claude"), { count: 1, unknown: 0, generations: { "0": 1 } });
  });
}
