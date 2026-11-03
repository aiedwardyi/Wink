// Fixture auth files only; nothing here reads the developer's real logins.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accountLabel, storedAccount } from "./auth-status.ts";
import { claudeAuthStatus } from "./claude.ts";
import { parseCodexAccount } from "./codex-account.ts";
import { grokAccount } from "./acp/grok.ts";
import { museAccount } from "./acp/muse.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-engine-account-"));
  scratchDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("accountLabel", () => {
  it("takes the first non-blank string", () => {
    expect(accountLabel(undefined, "  ", 42, " a@b.dev ", "Name")).toBe("a@b.dev");
    expect(accountLabel(null, "")).toBeUndefined();
  });
});

describe("storedAccount", () => {
  it("caches per file and rereads a changed or removed file", () => {
    const path = join(scratch(), "auth.json");
    const read = vi.fn((auth: unknown) => (auth as { email?: string }).email);
    expect(storedAccount(path, read)).toBeUndefined();
    writeJson(path, { email: "one@example.com" });
    expect(storedAccount(path, read)).toBe("one@example.com");
    expect(storedAccount(path, read)).toBe("one@example.com");
    expect(read).toHaveBeenCalledTimes(1);
    writeJson(path, { email: "second@example.com" });
    expect(storedAccount(path, read)).toBe("second@example.com");
    rmSync(path);
    expect(storedAccount(path, read)).toBeUndefined();
  });
});

describe("claude account", () => {
  const status = (stdout: string) => claudeAuthStatus("claude", {}, ((_cli, _args, _options, callback) => {
    callback(null, stdout);
  }) satisfies typeof import("../procs.ts").execCli);

  it("reads email, else the org name, from auth status", async () => {
    expect(await status('{"loggedIn":true,"authMethod":"claude.ai","email":"me@example.com","orgName":"Org"}'))
      .toEqual({ signedIn: true, account: "me@example.com" });
    expect(await status('{"loggedIn":true,"orgName":"Acme Org"}')).toEqual({ signedIn: true, account: "Acme Org" });
  });

  it("leaves the account empty when signed out or unnamed", async () => {
    expect(await status('{"loggedIn":true,"authMethod":"oauth_token"}')).toEqual({ signedIn: true, account: undefined });
    expect(await status('{"loggedIn":false,"email":"stale@example.com"}')).toEqual({ signedIn: false, account: undefined });
    expect(await status("not json")).toEqual({});
  });
});

describe("codex account", () => {
  it("uses the engine's ChatGPT account metadata", () => {
    expect(parseCodexAccount({ account: { type: "chatgpt", email: "gpt@example.com" } })).toMatchObject({ type: "chatgpt", authenticated: true, label: "gpt@example.com" });
  });

  it("accepts a nullable label without inventing an identity", () => {
    expect(parseCodexAccount({ account: { type: "chatgpt", email: null } })).toEqual({ type: "chatgpt", authenticated: true, label: undefined });
  });

  it("never derives identity from credential or token payloads", () => {
    expect(parseCodexAccount({ account: { type: "apiKey" } }).label).toBeUndefined();
    expect(parseCodexAccount({ account: null })).toEqual({ authenticated: false });
    expect(parseCodexAccount({ tokens: { id_token: "fake-token" } })).toEqual({});
  });
});

describe("grok account", () => {
  const entry = (extra: object) => ({ key: "k", refresh_token: "r", ...extra });

  it("reads email, else the full name, from GROK_HOME", () => {
    const home = scratch();
    writeJson(join(home, "auth.json"), { "https://auth.x.ai::1": entry({ email: "grok@example.com", first_name: "G" }) });
    expect(grokAccount({ GROK_HOME: home })).toBe("grok@example.com");
    writeJson(join(home, "auth.json"), { "https://auth.x.ai::1": entry({ first_name: "Gro", last_name: "K" }) });
    expect(grokAccount({ GROK_HOME: home })).toBe("Gro K");
  });

  it("stays unknown for two different people or a signed-out entry", () => {
    const home = scratch();
    writeJson(join(home, ".grok", "auth.json"), {
      a: entry({ email: "one@example.com" }),
      b: entry({ email: "two@example.com" }),
    });
    expect(grokAccount({ HOME: home })).toBeUndefined();
    writeJson(join(home, ".grok", "auth.json"), { a: { email: "gone@example.com" } });
    expect(grokAccount({ HOME: home })).toBeUndefined();
  });
});

describe("muse account", () => {
  it("reads the Meta email, else the full name, from MUSE_AUTH_PATH", () => {
    const auth = join(scratch(), "auth.json");
    writeJson(auth, { providers: { meta: { access_token: "t", user_email: "muse@example.com", user_full_name: "M" } } });
    expect(museAccount({ MUSE_AUTH_PATH: auth })).toBe("muse@example.com");
    writeJson(auth, { providers: { meta: { access_token: "t", user_full_name: "Muse User" } } });
    expect(museAccount({ MUSE_AUTH_PATH: auth })).toBe("Muse User");
  });

  it("stays unknown when META_API_KEY bills instead", () => {
    const auth = join(scratch(), "auth.json");
    writeJson(auth, { providers: { meta: { access_token: "t", user_email: "muse@example.com" } } });
    expect(museAccount({ MUSE_AUTH_PATH: auth, META_API_KEY: "key" })).toBeUndefined();
  });
});
