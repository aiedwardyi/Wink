import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ANTIGRAVITY_KEYRING, antigravityKeyringSignOut, antigravitySignIn, forgetAntigravitySignIn, probeAntigravitySignIn, readAntigravityAccount, readAntigravityLogSignIn } from "./antigravity-auth.ts";

const execFile = vi.fn();

describe("Antigravity keyring sign-in", () => {
  it.each([
    ["Target: LegacyGeneric:target=gemini:antigravity\nUser: antigravity", true],
    ["Target: LegacyGeneric:target=gemini:other\nUser: antigravity", false],
    ["Target: LegacyGeneric:target=gemini:antigravity-other", false],
    ["", false],
  ])("checks only the exact Windows entry: %s", async (stdout, expected) => {
    execFile.mockImplementation((_file, _args, _opts, done) => done(null, stdout));
    expect(await probeAntigravitySignIn("win32", execFile)).toBe(expected);
    expect(execFile).toHaveBeenLastCalledWith("cmdkey.exe", ["/list"], expect.objectContaining({ windowsHide: true, timeout: 3000 }), expect.any(Function));
  });

  it.each([null, { code: 44 }, { killed: true, code: "ETIMEDOUT" }])("checks macOS without reading the password: %j", async (error) => {
    execFile.mockImplementation((_file, _args, _opts, done) => done(error, ""));
    expect(await probeAntigravitySignIn("darwin", execFile)).toBe(error === null ? true : error.code === 44 ? false : undefined);
    expect(execFile).toHaveBeenLastCalledWith("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity"], expect.objectContaining({ timeout: 3000 }), expect.any(Function));
  });

  it("leaves Windows timeouts and unsupported Linux unknown", async () => {
    execFile.mockImplementation((_file, _args, _opts, done) => done({ killed: true }, ""));
    expect(await probeAntigravitySignIn("win32", execFile)).toBeUndefined();
    execFile.mockClear();
    expect(await probeAntigravitySignIn("linux", execFile)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("deletes the saved sign-in the probe reads, on Windows and macOS only", async () => {
    execFile.mockImplementation((_file, _args, _opts, done) => done(null, ""));
    expect(await forgetAntigravitySignIn(ANTIGRAVITY_KEYRING, "win32", execFile)).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith("cmdkey.exe", ["/delete:gemini:antigravity"], expect.objectContaining({ windowsHide: true, timeout: 5000 }), expect.any(Function));
    expect(await forgetAntigravitySignIn(ANTIGRAVITY_KEYRING, "darwin", execFile)).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith("security", ["delete-generic-password", "-s", "gemini", "-a", "antigravity"], expect.objectContaining({ timeout: 5000 }), expect.any(Function));
    execFile.mockImplementation((_file, _args, _opts, done) => done({ code: 1 }, ""));
    expect(await forgetAntigravitySignIn(ANTIGRAVITY_KEYRING, "win32", execFile)).toBe(false);
    execFile.mockClear();
    expect(await forgetAntigravitySignIn(ANTIGRAVITY_KEYRING, "linux", execFile)).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["win32", "darwin"] as const)("refuses to delete any entry but gemini:antigravity (%s)", async (platform) => {
    execFile.mockImplementation((_file, _args, _opts, done) => done(null, ""));
    const others = ["omb-test-0b5e3c1e-5d1a-4c55-9d43-3f0c6f1f8d10:antigravity", "gemini:other", "other:antigravity", "Gemini:antigravity", "gemini:antigravity ", "gemini:antigravity\n", "gemini", ":antigravity", "gemini:", ""];
    for (const target of others) {
      // SAFETY: a JavaScript caller can pass any string; the literal type is the compile-time half of this guard.
      expect(await forgetAntigravitySignIn(target as typeof ANTIGRAVITY_KEYRING, platform, execFile)).toBe(false);
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it("lets newer turn evidence beat a cached check in both directions", async () => {
    const probe = vi.fn(async () => true);
    const auth = antigravitySignIn(probe);
    expect(await auth.check()).toBe(true);
    auth.record(false);
    expect(await auth.check()).toBe(false);
    auth.record(true);
    expect(await auth.check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockResolvedValue(false);
    expect(await auth.check(true)).toBe(false);
    probe.mockResolvedValue(true);
    expect(await auth.check()).toBe(true);
  });

  it("falls back to the log only when the keyring cannot be probed", async () => {
    const unprobed = vi.fn<() => boolean | undefined>(() => true);
    const auth = antigravitySignIn(async () => undefined, unprobed);
    expect(await auth.check()).toBe(true);
    unprobed.mockReturnValue(false);
    expect(await auth.check(true)).toBe(false);
    auth.record(true);
    unprobed.mockReturnValue(undefined);
    expect(await auth.check(true)).toBe(true);
    const probed = antigravitySignIn(async () => false, () => true);
    expect(await probed.check()).toBe(false);
  });

  it("ignores checks started before newer evidence and preserves evidence on timeout", async () => {
    let finish!: (value: boolean | undefined) => void;
    const auth = antigravitySignIn(() => new Promise((resolve) => { finish = resolve; }));
    const pending = auth.check();
    auth.record(false);
    finish(true);
    expect(await pending).toBe(false);
    const refresh = auth.check(true);
    auth.record(true);
    finish(undefined);
    expect(await refresh).toBe(true);
  });
});

describe("Antigravity keyring sign-out", () => {
  const deferred = () => {
    let resolve!: (ok: boolean) => void;
    return { promise: new Promise<boolean>((done) => { resolve = done; }), resolve: (ok: boolean) => resolve(ok) };
  };

  it("deletes at once when no turn runs", async () => {
    const forget = vi.fn(async () => true);
    const signedOut = vi.fn();
    const keyring = antigravityKeyringSignOut(forget);
    keyring.onSignedOut(signedOut);
    expect(await keyring.signOut()).toBe(true);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(keyring.waiting).toBe(false);
  });

  it("waits for every running turn, reads as signed out meanwhile, then deletes once", async () => {
    const forget = vi.fn(async () => true);
    const keyring = antigravityKeyringSignOut(forget);
    keyring.turnStarted("a");
    keyring.turnStarted("b");
    expect(await keyring.signOut()).toBe(true);
    expect(keyring.waiting).toBe(true);
    keyring.turnEnded("a");
    keyring.turnEnded("never-started");
    expect(forget).not.toHaveBeenCalled();
    keyring.turnEnded("b");
    await vi.waitFor(() => expect(keyring.waiting).toBe(false));
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("stays signed out while the delete runs, and reports a failed delete", async () => {
    const pending = deferred();
    const keyring = antigravityKeyringSignOut(() => pending.promise);
    const out = keyring.signOut();
    expect(keyring.waiting).toBe(true);
    pending.resolve(false);
    expect(await out).toBe(false);
    expect(keyring.waiting).toBe(false);
  });

  it("drops a waiting delete once a sign-in succeeds, and holds it off while the sign-in runs", async () => {
    const forget = vi.fn(async () => true);
    const keyring = antigravityKeyringSignOut(forget);
    keyring.turnStarted("a");
    await keyring.signOut();
    const ended = await keyring.signingIn();
    expect(keyring.waiting).toBe(true);
    keyring.turnEnded("a");
    await Promise.resolve();
    expect(forget).not.toHaveBeenCalled();
    ended(true);
    expect(keyring.waiting).toBe(false);
    await Promise.resolve();
    expect(forget).not.toHaveBeenCalled();
  });

  it("stays signed out after a failed sign-in, and deletes once no turn runs", async () => {
    const forget = vi.fn(async () => true);
    const keyring = antigravityKeyringSignOut(forget);
    keyring.turnStarted("a");
    expect(await keyring.signOut()).toBe(true);
    const ended = await keyring.signingIn();
    ended(false);
    ended(true); // a second end changes nothing
    expect(keyring.waiting).toBe(true);
    expect(forget).not.toHaveBeenCalled();
    keyring.turnEnded("a");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    expect(keyring.waiting).toBe(false);
  });

  it("deletes when a sign-in fails after the running turns already ended", async () => {
    const forget = vi.fn(async () => true);
    const keyring = antigravityKeyringSignOut(forget);
    keyring.turnStarted("a");
    await keyring.signOut();
    const ended = await keyring.signingIn();
    keyring.turnEnded("a");
    expect(forget).not.toHaveBeenCalled();
    ended(false);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
  });

  it("stays signed out when the store refuses the waiting delete, until a sign-in succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const forget = vi.fn(async () => false);
    const keyring = antigravityKeyringSignOut(forget);
    keyring.turnStarted("a");
    expect(await keyring.signOut()).toBe(true);
    keyring.turnEnded("a");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(keyring.waiting).toBe(true);
    // Sign out again: tries the delete once more and says it failed, still signed out.
    expect(await keyring.signOut()).toBe(false);
    expect(forget).toHaveBeenCalledTimes(2);
    expect(keyring.waiting).toBe(true);
    // A failed sign-in tries once more; a successful one ends it.
    (await keyring.signingIn())(false);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(3));
    expect(keyring.waiting).toBe(true);
    (await keyring.signingIn())(true);
    expect(keyring.waiting).toBe(false);
    warn.mockRestore();
  });

  it("lets a delete already running finish before a sign-in goes ahead", async () => {
    const pending = deferred();
    const keyring = antigravityKeyringSignOut(() => pending.promise);
    keyring.turnStarted("a");
    await keyring.signOut();
    keyring.turnEnded("a");
    let started = false;
    const signingIn = keyring.signingIn().then((ended) => { started = true; return ended; });
    await Promise.resolve();
    expect(started).toBe(false);
    pending.resolve(true);
    (await signingIn)(true);
    expect(started).toBe(true);
    expect(keyring.waiting).toBe(false);
  });
});

describe("Antigravity account from agy's logs", () => {
  const homes: string[] = [];
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
  const home = (logs: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "omb-agy-log-"));
    homes.push(dir);
    const logDir = join(dir, ".gemini", "antigravity-cli", "log");
    mkdirSync(logDir, { recursive: true });
    for (const [name, text] of Object.entries(logs)) writeFileSync(join(logDir, name), text);
    return { HOME: dir };
  };
  const signedIn = (email: string, method: string) => `I1119 10:47:13.5 261 server_oauth.go:221] applyAuthResult: email=${email}, authMethod=${method}, quotaProject=\n`;

  it.each(["consumer", "gcp"])("reads the email of a %s sign-in", (method) => {
    expect(readAntigravityAccount(home({ "cli-20261119_100000.log": signedIn("ed@example.com", method) }))).toBe("ed@example.com");
  });

  it("takes the newest log that says anything", () => {
    const env = home({
      "cli-20261118_100000.log": signedIn("old@example.com", "gcp"),
      "cli-20261119_100000.log": signedIn("new@example.com", "consumer"),
      "cli-20261119_110000.log": "I1119 11:00:00.1 1 main.go:1] started\n",
    });
    expect(readAntigravityAccount(env)).toBe("new@example.com");
  });

  it("reads nothing after a logout, even in the same log", () => {
    const env = home({ "cli-20261119_100000.log": `${signedIn("ed@example.com", "consumer")}I1119 10:47:15.2 727 auth_manager.go:315] Logging out current user\n` });
    expect(readAntigravityAccount(env)).toBeUndefined();
  });

  it("reads nothing without logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readAntigravityAccount({ HOME: join(tmpdir(), "omb-agy-no-such-home") })).toBeUndefined();
    const notDir = home({});
    writeFileSync(join(notDir.HOME, "file"), "");
    expect(readAntigravityAccount({ HOME: join(notDir.HOME, "file") })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs a read failure instead of hiding it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = home({});
    mkdirSync(join(env.HOME, ".gemini", "antigravity-cli", "log", "cli-20261119_100000.log"));
    expect(readAntigravityAccount(env)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[antigravity] could not read agy's logs", expect.objectContaining({ code: "EISDIR" }));
    warn.mockRestore();
  });

  it("reads sign-in from the newest login or logout, unknown without either", () => {
    expect(readAntigravityLogSignIn(home({ "cli-20261119_100000.log": signedIn("ed@example.com", "consumer") }))).toBe(true);
    expect(readAntigravityLogSignIn(home({ "cli-20261119_100000.log": `${signedIn("ed@example.com", "consumer")}I1119 10:47:15.2 727 auth_manager.go:315] Logging out current user\n` }))).toBe(false);
    expect(readAntigravityLogSignIn(home({ "cli-20261119_100000.log": "I1119 11:00:00.1 1 main.go:1] started\n" }))).toBeUndefined();
  });

  it("reads the ACP server's logs, where Wink's own sign-out lands, by time and not by name", () => {
    // Real agy 1.5.14: an ACP logout writes to acp-server-<stamp>-<n>.log, not cli-*.log.
    const { logFile, logLine } = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/antigravity/acp-logout.json", import.meta.url), "utf8")).reply;
    expect(readAntigravityLogSignIn(home({
      "cli-20261122_155418.log": signedIn("ed@example.com", "gcp"),
      [logFile]: `${logLine}\n`,
    }))).toBe(false);
    expect(readAntigravityAccount(home({
      [logFile]: `${logLine}\n`,
      "cli-20261122_170000.log": signedIn("new@example.com", "consumer"),
    }))).toBe("new@example.com");
  });

  it("forgets logs that are no longer listed", () => {
    const env = home({});
    const dir = join(env.HOME, ".gemini", "antigravity-cli", "log");
    const first = join(dir, "cli-00000000_000000.log");
    const write = (path: string, text: string) => { writeFileSync(path, text); utimesSync(path, 1_700_000_000, 1_700_000_000); };
    write(first, signedIn("a@example.com", "gcp"));
    expect(readAntigravityAccount(env)).toBe("a@example.com");
    const newer = Array.from({ length: 20 }, (_, i) => join(dir, `cli-20261119_1000${String(i).padStart(2, "0")}.log`));
    for (const path of newer) write(path, "started\n");
    expect(readAntigravityAccount(env)).toBeUndefined();
    for (const path of newer) rmSync(path);
    write(first, signedIn("b@example.com", "gcp"));
    expect(readAntigravityAccount(env)).toBe("b@example.com");
  });
});
