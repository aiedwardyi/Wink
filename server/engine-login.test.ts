import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { EngineLogin, signInOwner } from "./engine-login.ts";
import * as envPath from "./env-path.ts";
import * as procs from "./procs.ts";

const managers: EngineLogin[] = [];
const ME = { mode: "code", owner: "pc:" } as const;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("logs one CLI exit with its parsed reason and none of the CLI's text", async () => {
  const { manager, cli } = fixture();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await manager.start("added", cli, ["stderr-exit"], {}, [], { ...ME, logExit: true });
  await manager.wait("added");
  expect(log.mock.calls).toEqual([["sign-in CLI exit code=3 reason=-"]]);
});

it("logs no device code from a failed sign-in in any letter case", async () => {
  const { manager, cli } = fixture();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await manager.start("added", cli, ["stderr-code"], {}, [], { ...ME, logExit: true });
  await manager.wait("added");
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/abcd-?efgh/i);
});

it("does not log a CLI exit for a successful sign-in", async () => {
  const { manager, cli } = fixture();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await manager.start("added", cli, ["exit"], {}, [], { ...ME, logExit: true });
  await manager.wait("added");
  expect(manager.state("added")).toBe("complete");
  expect(log).not.toHaveBeenCalled();
});

describe("Windows Claude version probe", () => {
  async function stuckProbe() {
    vi.useFakeTimers();
    vi.stubEnv("PATH", process.env.PATH ?? "");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(envPath, "findCliCandidates").mockReturnValue(["claude-a", "claude-b"]);
    const spawned = vi.spyOn(envPath, "resolveCliSpawn").mockReturnValue({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] });
    vi.spyOn(procs, "cliVersion").mockImplementation(() => {});
    const manager = new EngineLogin(60_000, 100);
    managers.push(manager);
    const start = manager.start("added", "claude", ["auth", "login"], {}, [], { ...ME, scope: "claudeAgent" });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned).not.toHaveBeenCalled();
    return { manager, start, spawned };
  }

  afterEach(() => { vi.useRealTimers(); });

  it("continues to sign in when the probe callback never arrives", async () => {
    const { start, spawned } = await stuckProbe();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(100);
    await start;
    expect(spawned).toHaveBeenCalledTimes(1);
  });

  it("stops waiting on the probe when the job is cancelled", async () => {
    const { manager, start, spawned } = await stuckProbe();
    await manager.cancel("added");
    await expect(start).resolves.toEqual({});
    expect(spawned).not.toHaveBeenCalled();
  });
});

function fixture(timeout = 15000, capture = 2500) {
  const dir = mkdtempSync(join(tmpdir(), "engine-login-"));
  dirs.push(dir);
  const script = join(dir, "login.cjs");
  writeFileSync(script, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const [mode, file] = process.argv.slice(2);
    if (mode === 'stderr-code') {
      process.stderr.write('Enter the code abcd-efgh\\nOr Abcd-EfGh, then retry', () => process.exit(3));
      return;
    }
    if (mode === 'stderr-exit') {
      process.stderr.write('Earlier diagnostic\\r\\n\\x1b[31mOAuth failed: https://example.test/private-fixture-token?code=private accessToken=short ABCD-EFGH\\x1b[0m', () => process.exit(3));
      return;
    }
    if (mode === 'tree') {
      const child = spawn(process.execPath, ['-e',
        'setInterval(() => require("node:fs").appendFileSync(process.argv[1], "."), 25)', file], { stdio: 'ignore', windowsHide: true });
      fs.writeFileSync(file + '.pid', String(child.pid));
    }
    if (mode === 'env') fs.writeFileSync(file, process.env.MUSE_LOGIN || 'missing');
    if (mode === 'credentials') fs.writeFileSync(file, JSON.stringify({
      token: process.env.OMB_COMMS_TOKEN, key: process.env.ANTHROPIC_API_KEY,
      extra: process.env.SIGNIN_REVIEW_SECRET, config: process.env.CLAUDE_CONFIG_DIR,
    }));
    if (mode === 'count') fs.appendFileSync(file, '.');
    process.stdin.on('end', () => process.exit(130));
    process.stdin.resume();
    process.stdout.write('access_token=private-token\\n');
    if (mode === 'unsafe') process.stdout.write('https://auth.example/?access_token=private-token\\nhttps://user:password@auth.example/device\\nnoise ABCD-EFGH\\n');
    else (mode === 'stdout' ? process.stdout : process.stderr).write('\\x1b]8;;https://auth.example/device\\x1b\\\\\\x1b[32mhttps://auth.example/device\\x1b[0m\\x1b]8;;\\x1b\\\\\\n');
    if (mode === 'chunks') {
      process.stdout.write('Co');
      setTimeout(() => process.stdout.write('de: ABCD-EFGH\\n'), 30);
    } else if (mode !== 'unsafe') process.stdout.write('Code: ABCD-EFGH\\n');
    if (mode === 'exit') setTimeout(() => process.exit(0), 100);
    else if (mode === 'fail') setTimeout(() => process.exit(1), 100);
    else setInterval(() => {}, 1000);
  `);
  const manager = new EngineLogin(timeout, capture);
  managers.push(manager);
  return { manager, cli: `"${process.execPath}" "${script}"`, dir };
}

const REAL_OUTPUT = {
  codex: "\nWelcome to Codex [v\x1b[90m0.163.0\x1b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n"
    + "1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n"
    + "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m8Y82-PFRXD\x1b[0m\n\n",
  grok: "\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=26XB-F54Z\n\n"
    + "Confirm this code in your browser:\n\n  26XB-F54Z\n\nWaiting for authorization...\n",
  muse: "Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=BBDN-DDKV\nconfirm this code matches:\n  BBDN-DDKV\n\nWaiting for approval…\n",
  claude: "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x"
    + "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=x\nPaste code here if prompted > ",
  claudePhone: "Opening browser to sign in…\nIf the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?z-urKJghPMIEbsa4ZY8DSczY9mVrkak\nPaste code here if prompted > ",
  agy: "Open this link in a browser to log in with Google:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x.apps.googleusercontent.com&code_challenge=x"
    + "&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=x\n"
    + "Then paste the authorization code, or the full URL of the page you land on, and press Enter:\n",
};

async function replay(engine: string, output: string, authHosts?: string[]) {
  const { manager, dir } = fixture(15000, 2500);
  const file = join(dir, "output.txt");
  const script = join(dir, "replay.cjs");
  writeFileSync(file, output);
  writeFileSync(script, "process.stdout.write(require('node:fs').readFileSync(process.argv[2], 'utf8')); setInterval(() => {}, 1000);");
  return manager.start(engine, `"${process.execPath}" "${script}"`, [file], {}, authHosts, ME);
}

describe("EngineLogin", () => {
  it("completes a managed Claude paste-back login through its pending stdin", async () => {
    const { manager, dir } = fixture();
    const script = join(dir, "paste-back.cjs");
    const received = join(dir, "received.txt");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(REAL_OUTPUT.claude)});
      process.stdin.once('data', (code) => { require('node:fs').writeFileSync(${JSON.stringify(received)}, code); process.exit(0); });`);
    const capture = await manager.start("added", `"${process.execPath}" "${script}"`, ["auth", "login"], {}, [], { ...ME,
      scope: "claudeAgent", account: { id: "added", of: "claude", home: dir, generation: 1 }, paste: true,
    });
    expect(capture.url).toContain("https://claude.com/cai/oauth/authorize?code=true");
    expect(capture.inputGeneration).toBe(manager.generation("added"));
    expect(manager.submit("added", capture.inputGeneration! + 1, "wrong-job")).toBe(false);
    expect(manager.submit("added", capture.inputGeneration!, "code\nextra")).toBe(false);
    expect(manager.submit("added", capture.inputGeneration!, "code\n")).toBe(false);
    expect(manager.submit("added", capture.inputGeneration!, "returned-code#state")).toBe(true);
    expect(manager.submit("added", capture.inputGeneration!, "duplicate")).toBe(false);
    await manager.wait("added");
    expect(manager.state("added")).toBe("complete");
    expect(readFileSync(received, "utf8")).toBe("returned-code#state\n");
    expect(JSON.stringify(manager.capture("added"))).not.toContain("returned-code");
    expect(manager.submit("added", capture.inputGeneration!, "late")).toBe(false);
  });

  describe("a waiting code sign-in's time limit", () => {
    afterEach(() => { vi.useRealTimers(); });

    async function waitingCode() {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const dir = mkdtempSync(join(tmpdir(), "engine-login-"));
      dirs.push(dir);
      const script = join(dir, "phone.cjs");
      const received = join(dir, "received.txt");
      writeFileSync(script, `process.stdout.write(${JSON.stringify(REAL_OUTPUT.claudePhone)});
        process.stdin.once('data', (code) => { require('node:fs').writeFileSync(${JSON.stringify(received)}, code); process.exit(0); });`);
      const manager = new EngineLogin();
      managers.push(manager);
      const capture = await manager.start("claude", `"${process.execPath}" "${script}"`, [], {}, [], { ...ME, scope: "claudeAgent", paste: true });
      expect(capture.inputGeneration).toBe(manager.generation("claude"));
      return { manager, capture, received };
    }

    it("takes a code pasted just before 15 minutes", async () => {
      const { manager, capture, received } = await waitingCode();
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1000);
      expect(manager.state("claude")).toBe("pending");
      expect(manager.submit("claude", capture.inputGeneration!, "late-code#state")).toBe(true);
      await manager.wait("claude");
      expect(manager.state("claude")).toBe("complete");
      expect(readFileSync(received, "utf8")).toBe("late-code#state\n");
    });

    it("ends a sign-in still waiting at 15 minutes", async () => {
      const { manager } = await waitingCode();
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1000);
      expect(manager.state("claude")).toBe("pending");
      await vi.advanceTimersByTimeAsync(1000);
      expect(manager.state("claude")).toBe("failed");
    });
  });

  it.each([
    "https://claude.com/cai/oauth/authorize?code=secret",
    "https://claude.com/other?code=true",
    "https://other.example/cai/oauth/authorize?code=true",
    "https://claude.com/cai/oauth/authorize?code=true&access_token=secret",
  ])("does not capture a managed Claude secret or unrelated URL: %s", async (url) => {
    const { manager, dir } = fixture(15000, 100);
    const script = join(dir, "unsafe-claude.cjs");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(url + "\nPaste code here if prompted > ")}); setInterval(() => {}, 1000);`);
    const capture = await manager.start("added", `"${process.execPath}" "${script}"`, ["auth", "login"], {}, [], { ...ME,
      scope: "claudeAgent", account: { id: "added", of: "claude", home: dir, generation: 1 }, paste: true,
    });
    expect(capture.url).toBeUndefined();
  });

  it.each([
    ["claudeAgent", "claudePhone", [], "https://claude.ai/oauth/authorize?z-urKJghPMIEbsa4ZY8DSczY9mVrkak"],
    ["antigravityAgent", "agy", ["accounts.google.com"], "https://accounts.google.com/o/oauth2/auth?"],
  ] as const)("takes a phone's pasted code for %s only when asked to", async (scope, output, hosts, url) => {
    const { manager, dir } = fixture();
    const script = join(dir, "phone.cjs");
    const received = join(dir, "received.txt");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(REAL_OUTPUT[output])});
      process.stdin.once('data', (code) => { require('node:fs').writeFileSync(${JSON.stringify(received)}, code); process.exit(code.toString().startsWith('good') ? 0 : 1); });`);
    const cli = `"${process.execPath}" "${script}"`;
    expect((await manager.start("desktop", cli, [], {}, [...hosts], { ...ME, scope: `${scope}-desktop` })).inputGeneration).toBeUndefined();
    const capture = await manager.start("phone", cli, [], {}, [...hosts], { ...ME, scope, paste: true });
    expect(capture.url?.startsWith(url)).toBe(true);
    expect(capture.inputGeneration).toBe(manager.generation("phone"));
    expect(manager.submit("phone", capture.inputGeneration!, "good-code#state")).toBe(true);
    await manager.wait("phone");
    expect(manager.state("phone")).toBe("complete");
    expect(readFileSync(received, "utf8")).toBe("good-code#state\n");
    expect(JSON.stringify(manager.capture("phone"))).not.toContain("good-code");
    const retry = await manager.start("phone", cli, [], {}, [...hosts], { ...ME, scope, paste: true });
    expect(manager.submit("phone", retry.inputGeneration!, "wrong-code")).toBe(true);
    await manager.wait("phone");
    expect(manager.state("phone")).toBe("failed");
  });

  it("names a sign-in's session by its phone and the browser's own id", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(signInOwner({ "x-wink-client": id }, "phone-1")).toBe(`phone:phone-1:${id}`);
    expect(signInOwner({ "x-wink-client": id })).toBe(`pc:${id}`);
    expect(signInOwner({ "x-wink-client": id }, "phone-2")).not.toBe(signInOwner({ "x-wink-client": id }, "phone-1"));
    for (const client of [undefined, "short", id.toUpperCase(), [id, id]]) expect(signInOwner({ "x-wink-client": client })).toBe("pc:");
  });

  it.each([
    ["claudeAgent", "claudePhone", true], ["codex", "codex", false], ["grokAgent", "grok", false], ["museAgent", "muse", false],
  ] as const)("lets only the session that started a %s sign-in answer or cancel it", async (scope, output, paste) => {
    const { manager, dir } = fixture();
    const script = join(dir, "owned.cjs");
    writeFileSync(script, `process.stdout.write(${JSON.stringify(REAL_OUTPUT[output])}); setInterval(() => {}, 1000);`);
    const phone = signInOwner({ "x-wink-client": "a".repeat(32) }, "phone-1");
    const others = [signInOwner({ "x-wink-client": "a".repeat(32) }, "phone-2"), signInOwner({ "x-wink-client": "b".repeat(32) }), signInOwner({}), undefined];
    expect(manager.owns(scope, phone)).toBe(true);
    const capture = await manager.start(scope, `"${process.execPath}" "${script}"`, [], {}, [], { ...ME, scope, paste, owner: phone });
    expect(manager.state(scope)).toBe("pending");
    expect(JSON.stringify(capture)).not.toContain("phone-1");
    expect(manager.owns(scope, phone)).toBe(true);
    for (const other of others) expect(manager.owns(scope, other)).toBe(false);
    await manager.cancel(scope);
    for (const other of others) expect(manager.owns(scope, other)).toBe(true);
  });

  it("releases a finished login scope when neither kill nor close completes", async () => {
    const { EventEmitter } = await import("node:events");
    const manager = new EngineLogin();
    managers.push(manager);
    vi.useFakeTimers();
    vi.spyOn(procs, "killCliTree").mockImplementation(() => {});
    try {
      const internal = manager as unknown as { create(engine: string, scope: string): { child?: unknown }; scopes: Map<string, unknown> };
      const job = internal.create("account-one", "codex");
      job.child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      const cancelled = manager.cancel("account-one");
      await vi.advanceTimersByTimeAsync(5_000);
      await cancelled;
      expect(internal.scopes.has("codex")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ["codex", ["auth.openai.com"], { url: "https://auth.openai.com/codex/device", code: "8Y82-PFRXD" }],
    ["grok", ["accounts.x.ai"], { url: "https://accounts.x.ai/oauth2/device?user_code=26XB-F54Z", code: "26XB-F54Z" }],
    ["muse", ["auth.meta.com"], { url: "https://auth.meta.com/oauth/device/?code=BBDN-DDKV", code: "BBDN-DDKV" }],
    ["claude", [], {}],
  ] as const)("captures the real %s login output", async (engine, hosts, expected) => {
    expect(await replay(engine, REAL_OUTPUT[engine], [...hosts])).toEqual(expected);
  });

  it("drops ?code= URLs off the engine's auth hosts", async () => {
    const output = "https://auth.example/device/?code=BBDN-DDKV\nhttps://auth.meta.com/oauth/device/?code=BBDN-DDKV\n";
    expect(await replay("muse", output, ["auth.meta.com"])).toEqual({ url: "https://auth.meta.com/oauth/device/?code=BBDN-DDKV" });
    expect(await replay("muse", REAL_OUTPUT.muse)).toEqual({ code: "BBDN-DDKV" });
  });

  it("drops URLs whose secret parameter names are percent-encoded", async () => {
    const output = "https://auth.meta.com/oauth/device/?access%5Ftoken=private\nhttps://auth.example/device/?c%6Fde=BBDN-DDKV\nhttps://auth.example/device#id_token=private\n";
    expect(await replay("muse", output, ["auth.meta.com"])).toEqual({});
  });

  it("does not inherit credentials outside the supplied login environment", async () => {
    vi.stubEnv("OMB_COMMS_TOKEN", "review-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "review-key");
    vi.stubEnv("SIGNIN_REVIEW_SECRET", "review-secret");
    const { manager, cli, dir } = fixture();
    const file = join(dir, "credentials");
    await manager.start("claude", cli, ["credentials", file], { CLAUDE_CONFIG_DIR: dir }, [], ME);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ config: dir });
  });

  it("settles cancellation when the killed child never emits close", async () => {
    const { manager, cli } = fixture();
    const closeListeners: ((...args: unknown[]) => void)[] = [];
    const { ChildProcess } = await import("node:child_process");
    const original = ChildProcess.prototype.once;
    const once = vi.spyOn(ChildProcess.prototype, "once");
    once.mockImplementation(function (this: import("node:child_process").ChildProcess, event, listener) {
      if (event === "close") { closeListeners.push(listener); return this; }
      return original.call(this, event, listener);
    });
    await manager.start("fake", cli, ["normal"], {}, [], ME);
    expect(closeListeners.length).toBeGreaterThan(0);
    const settled = await Promise.race([
      manager.cancel("fake").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 7500)),
    ]);
    once.mockRestore();
    if (!settled) for (const listener of closeListeners) listener(null, "SIGTERM");
    expect(settled).toBe(true);
  });

  it.each(["normal", "chunks", "stdout"])("captures only URL and code from %s output", async (mode) => {
    const { manager, cli } = fixture();
    expect(await manager.start("fake", cli, [mode], {}, [], ME)).toEqual({ url: "https://auth.example/device", code: "ABCD-EFGH" });
    expect(JSON.stringify(manager.capture("fake"))).not.toContain("private-token");
    expect(manager.state("fake")).toBe("pending");
  });

  it("keeps stdin open until cancellation", async () => {
    const { manager, cli } = fixture();
    await manager.start("fake", cli, ["normal"], {}, [], ME);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(manager.state("fake")).toBe("pending");
    await manager.cancel("fake");
    expect(manager.state("fake")).toBe("cancelled");
  });

  it("drops unanchored codes and URLs carrying credentials", async () => {
    const { manager, cli } = fixture(5000, 150);
    expect(await manager.start("fake", cli, ["unsafe"], {}, [], ME)).toEqual({});
  });

  it("starts one replacement after a cancelled job", async () => {
    const { manager, cli, dir } = fixture();
    await manager.start("fake", cli, ["normal"], {}, [], ME);
    await manager.cancel("fake");
    const file = join(dir, "restarted");
    await Promise.all([manager.start("fake", cli, ["count", file], {}, [], ME), manager.start("fake", cli, ["count", file], {}, [], ME)]);
    expect(readFileSync(file, "utf8")).toBe(".");
  });

  it("starts another account's sign-in once a cancelled one on the engine closes", async () => {
    const { manager, cli, dir } = fixture();
    await manager.start("a", cli, ["normal"], {}, [], { ...ME, scope: "claude" });
    void manager.cancel("a");
    manager.clear("a");
    const file = join(dir, "next");
    await manager.start("b", cli, ["count", file], {}, [], { ...ME, scope: "claude" });
    expect(readFileSync(file, "utf8")).toBe(".");
  });

  it("does not launch a queued replacement during shutdown", async () => {
    const { manager, cli, dir } = fixture();
    await manager.start("fake", cli, ["normal"], {}, [], ME);
    const cancel = manager.cancel("fake");
    const file = join(dir, "unexpected-start");
    const restart = manager.start("fake", cli, ["count", file], {}, [], ME);
    await Promise.all([cancel, restart, manager.dispose()]);
    expect(existsSync(file)).toBe(false);
    expect(manager.state("fake")).toBeUndefined();
  });

  it("reuses one running job for simultaneous starts", async () => {
    const { manager, cli, dir } = fixture();
    const file = join(dir, "count");
    const captures = await Promise.all([manager.start("fake", cli, ["count", file], {}, [], ME), manager.start("fake", cli, ["count", file], {}, [], ME)]);
    expect(captures[0]).toEqual(captures[1]);
    expect(readFileSync(file, "utf8")).toBe(".");
  });

  it.each(["cancel", "timeout", "shutdown"])("kills the process tree on %s", async (action) => {
    const { manager, cli, dir } = fixture(action === "timeout" ? 2500 : 15000);
    const file = join(dir, "heartbeat");
    await manager.start("fake", cli, ["tree", file], {}, [], ME);
    await expect.poll(() => existsSync(file), { timeout: 5000 }).toBe(true);
    if (action === "cancel") await manager.cancel("fake");
    else if (action === "shutdown") await manager.dispose();
    else {
      await expect.poll(() => manager.state("fake"), { timeout: 5000 }).toBe("failed");
      await manager.wait("fake");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const size = readFileSync(file).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(file).length).toBe(size);
  });

  it("passes the Muse launcher environment", async () => {
    const { manager, cli, dir } = fixture();
    const file = join(dir, "env");
    await manager.start("muse", cli, ["env", file], { MUSE_LOGIN: "0" }, [], ME);
    expect(readFileSync(file, "utf8")).toBe("0");
  });

  it.each(["exit", "fail"])("records the %s outcome without returning output", async (mode) => {
    const { manager, cli } = fixture();
    const result = await manager.start("fake", cli, [mode], {}, [], ME);
    await expect.poll(() => manager.state("fake")).toBe(mode === "exit" ? "complete" : "failed");
    expect(Object.keys(result).sort()).toEqual(["code", "url"]);
  });

  it("handles an absent CLI without exposing its error", async () => {
    const { manager, dir } = fixture();
    expect(await manager.start("missing", join(dir, "absent.exe"), [], {}, [], ME)).toEqual({});
    expect(manager.state("missing")).toBe("failed");
  });
});

describe("newest Sign In wins", () => {
  const tab = signInOwner({ "x-wink-client": "a".repeat(32) }, "phone-1");
  const owners = {
    "same tab": tab,
    "other device": signInOwner({ "x-wink-client": "b".repeat(32) }),
    "new tab": signInOwner({ "x-wink-client": "c".repeat(32) }, "phone-1"),
  };
  const modes = ["browser", "code"] as const;
  const cases = modes.flatMap((first) => modes.flatMap((second) => (["same tab", "other device", "new tab"] as const)
    .flatMap((who) => (["same id", "other account"] as const).map((target) => [first, second, who, target] as const))));

  it.each(cases)("%s sign-in, then %s Sign In from the %s on the %s", async (first, second, who, target) => {
    const { manager, cli, dir } = fixture();
    const spawns = join(dir, "spawns");
    await manager.start("a", cli, ["count", spawns], {}, [], { scope: "claudeAgent", mode: first, owner: tab });
    const before = manager.generation("a");
    const id = target === "same id" ? "a" : "b";
    const owner = owners[who];
    const capture = await manager.start(id, cli, ["count", spawns], {}, [], { scope: "claudeAgent", mode: second, owner });
    const joined = id === "a" && who === "same tab" && first === second;
    expect(readFileSync(spawns, "utf8")).toBe(joined ? "." : "..");
    expect(capture.url).toBe("https://auth.example/device");
    expect(manager.state(id)).toBe("pending");
    if (id === "a") expect(manager.generation("a") === before).toBe(joined);
    else expect(manager.state("a")).toBe("cancelled");
    expect(manager.owns(id, owner)).toBe(true);
    expect(manager.opensBrowser(id)).toBe(second === "browser");
    expect(manager.joins(id, owner, second)).toBe(true);
  });

  it("never replaces a running sign-out", async () => {
    const { manager, cli } = fixture();
    await manager.start("a", cli, ["normal"], {}, [], { scope: "claudeAgent", mode: "sign-out" });
    for (const id of ["a", "b"]) {
      await expect(manager.start(id, cli, ["normal"], {}, [], { scope: "claudeAgent", mode: "code", owner: tab })).rejects.toThrow("Another sign-in");
    }
    expect(manager.state("a")).toBe("pending");
  });

  it("answers a browser sign-in as soon as its link is out", async () => {
    const { manager, dir } = fixture(15000, 5000);
    const script = join(dir, "url-only.cjs");
    writeFileSync(script, "process.stdout.write('Visit: https://auth.example/device\\n'); setInterval(() => {}, 1000);");
    const started = Date.now();
    expect(await manager.start("a", `"${process.execPath}" "${script}"`, [], {}, [], { mode: "browser", owner: tab })).toEqual({ url: "https://auth.example/device" });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("requires a sign-in's owner and mode", () => {
    const { manager, cli } = fixture();
    // @ts-expect-error a sign-in start names its session and flow
    void (() => manager.start("a", cli, ["normal"], {}, [], { scope: "claudeAgent" }));
    // @ts-expect-error a sign-in start names its session and flow
    void (() => manager.start("a", cli, ["normal"], {}, [], { mode: "code" }));
  });
});
