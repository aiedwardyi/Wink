import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { antigravitySignIn, probeAntigravitySignIn, readAntigravityAccount } from "./antigravity-auth.ts";

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
    expect(readAntigravityAccount({ HOME: join(tmpdir(), "omb-agy-no-such-home") })).toBeUndefined();
  });
});
