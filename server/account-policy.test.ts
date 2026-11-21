import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountService } from "./accounts.ts";
import { applyCredentialAllowlist, DATA_DIR } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { createUsageRefresh, canRefreshUsage } from "./usage-refresh.ts";
import { claudeAuthStatus } from "./drivers/claude.ts";
import { createCodexText } from "./drivers/codex-text.ts";
import { awaitDyingAppServers, retireAppServer } from "./drivers/codex-catalog.ts";
import * as procs from "./procs.ts";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

const account = { id: "acct_7d6e234b-8046-4a5a-9354-2cf05f27d775", of: "claude", home: join(DATA_DIR, "accounts", "test"), generation: 1 };
const policy = await import("./account-policy.ts").catch(() => null);
const bases = (): InstanceConfigMap => ({ claude: { driver: "claudeAgent" }, codex: { driver: "codex" }, grok: { driver: "grokAgent" } });
let stores = 0;
const storeDir = () => join(DATA_DIR, `launch-homes-${++stores}`);
afterEach(() => vi.restoreAllMocks());

describe("account launch boundary", () => {
  it.each([["claudeAgent", "claude"], ["codex", "codex"], ["grokAgent", "grok"]] as const)("creates a missing saved %s home before launch and never touches what is inside", async (driver, of) => {
    const saved = await new AccountService(storeDir(), bases).add(of);
    fs.rmSync(saved.home, { recursive: true });
    policy!.accountLaunch(saved, driver, [], {});
    expect(fs.statSync(saved.home).isDirectory()).toBe(true);
    expect(fs.existsSync(join(saved.home, "state"))).toBe(driver === "codex");
    fs.writeFileSync(join(saved.home, "auth.json"), "keep");
    policy!.accountLaunch(saved, driver, [], {});
    expect(fs.readFileSync(join(saved.home, "auth.json"), "utf8")).toBe("keep");
  });

  it("never brings back the home of an account removed after its launch was captured", async () => {
    const accounts = new AccountService(storeDir(), bases);
    const saved = await accounts.add("codex");
    await accounts.retire(saved.id);
    fs.renameSync(saved.home, `${saved.home}-archived`);
    policy!.accountLaunch(saved, "codex", [], {});
    expect(fs.existsSync(saved.home)).toBe(false);
  });

  it.each(["home link", "root link", "file"] as const)("refuses to restore a saved home behind a %s", async (kind) => {
    const dir = storeDir();
    const saved = await new AccountService(dir, bases).add("codex");
    const target = join(dir, "target");
    fs.rmSync(saved.home, { recursive: true });
    if (kind === "file") fs.writeFileSync(saved.home, "keep");
    else if (kind === "home link") {
      fs.mkdirSync(target);
      fs.symlinkSync(target, saved.home, "junction");
    } else {
      fs.renameSync(dirname(saved.home), target);
      fs.symlinkSync(target, dirname(saved.home), "junction");
    }
    expect(() => policy!.accountLaunch(saved, "codex", [], {})).toThrow("link or alias");
    if (kind === "file") expect(fs.readFileSync(saved.home, "utf8")).toBe("keep");
    else expect(fs.readdirSync(target)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("fails closed when Windows denies creating inside a saved home", async () => {
    const saved = await new AccountService(storeDir(), bases).add("codex");
    fs.rmSync(join(saved.home, "state"), { recursive: true });
    const who = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
    execFileSync("icacls.exe", [saved.home, "/deny", `${who}:(AD,WD)`], { windowsHide: true });
    try {
      expect(() => policy!.accountLaunch(saved, "codex", [], {})).toThrow();
      expect(fs.existsSync(join(saved.home, "state"))).toBe(false);
    } finally { execFileSync("icacls.exe", [saved.home, "/remove:d", who], { windowsHide: true }); }
  });

  it("checks existing saved homes at startup and launch without creating anything", async () => {
    const dir = storeDir();
    const first = new AccountService(dir, bases);
    const saved = [await first.add("claude"), await first.add("codex"), await first.add("grok")];
    const mkdir = vi.spyOn(fs, "mkdirSync");
    expect(new AccountService(dir, bases).snapshot).toHaveLength(3);
    (["claudeAgent", "codex", "grokAgent"] as const).forEach((driver, i) => policy!.accountLaunch(saved[i], driver, [], {}));
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("leaves a base account home to its engine", () => {
    const home = join(DATA_DIR, "accounts", "missing-base");
    policy!.accountLaunch({ ...account, of: "codex", id: "codex", generation: 0, home }, "codex", [], {});
    expect(fs.existsSync(home)).toBe(false);
  });

  it("R6 opts real Claude launches into user setup while exempting auth and version", () => {
    expect(policy!.accountLaunch(account, "claudeAgent", ["-p", "fixture"], {}, true).args.slice(-2)).toEqual(["--setting-sources", "user,project,local"]);
    for (const args of [["auth", "status"], ["--version"]]) {
      expect(policy!.accountLaunch(account, "claudeAgent", args, {}, true).args).toEqual(args);
    }
  });

  it.each(["status", "login", "logout"])("keeps Claude auth %s free of turn settings", (command) => {
    const args = ["auth", command];
    const result = policy!.accountLaunch(account, "claudeAgent", args, {});
    expect(result.args).toEqual(args);
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(account.home);
  });

  it.each([["-p", "fixture"], ["--print", "fixture"], ["fixture"]])("loads project and local settings for Claude launch %j", (...args) => {
    expect(policy!.accountLaunch(account, "claudeAgent", args, {}).args.slice(-2)).toEqual(["--setting-sources", "project,local"]);
  });

  it("keeps Claude version probes free of turn settings", () => {
    expect(policy!.accountLaunch(account, "claudeAgent", ["--version"], {}).args).toEqual(["--version"]);
  });

  it.each(["openai_api_key", "Anthropic_Api_Key", "Meta_Api_Key", "xai_API_key", "aws_access_key_id", "Google_Application_Credentials"])("scrubs inherited %s case-insensitively", (key) => {
    const env = { [key]: "fake-secret", PATH: "keep" };
    applyCredentialAllowlist(env);
    expect(env).toEqual({ PATH: "keep" });
  });

  it("pins the home and state after the final merge and clears selectors", () => {
    expect(policy, "account policy exists").not.toBeNull();
    const result = policy!.accountLaunch(account, "codex", ["app-server"], {
      codeX_home: "wrong", CODEX_SQLITE_HOME: "wrong", ANTHROPIC_PROFILE: "console", CLAUDE_CODE_USE_BEDROCK: "1",
      OPENAI_API_KEY: "fake", GH_TOKEN: "fake", WINK_MCP_AGENTS_OMB_COMMS_TOKEN: "scoped",
    });
    expect(result.env.CODEX_HOME).toBe(account.home);
    expect(result.env.CODEX_SQLITE_HOME).toBe(join(account.home, "state"));
    expect(Object.keys(result.env).filter((key) => /profile|bedrock|api_key|gh_token|^codex_home$/i.test(key) && key !== "CODEX_HOME")).toEqual([]);
    expect(result.env.WINK_MCP_AGENTS_OMB_COMMS_TOKEN).toBe("scoped");
    expect(result.args.join(" ")).toContain("sqlite_home=");
  });

  it("pins a Grok account to its own GROK_HOME and drops inherited auth overrides", () => {
    const result = policy!.accountLaunch({ ...account, of: "grok" }, "grokAgent", ["agent", "stdio"], {
      grok_home: "wrong", GROK_AUTH_PATH: "wrong", GROK_AUTH: "token", XAI_API_KEY: "fake", PATH: "keep",
    });
    expect(result.args).toEqual(["agent", "stdio"]);
    expect(result.env).toEqual({ PATH: "keep", GROK_HOME: account.home });
  });

  it.each(["--profile", "--with-api-key", "--oss", "-p"])("rejects a conflicting Codex selector %s", (flag) => {
    expect(policy, "account policy exists").not.toBeNull();
    expect(() => policy!.accountLaunch(account, "codex", ["app-server", flag, "conflict"], {})).toThrow("Conflicting");
  });

  it("rejects a Claude settings file or helper override", () => {
    expect(policy, "account policy exists").not.toBeNull();
    for (const value of ["settings.json", '{"apiKeyHelper":"untrusted"}', '{"env":{"ANTHROPIC_API_KEY":"fake"}}']) {
      expect(() => policy!.accountLaunch(account, "claudeAgent", ["-p", "--settings", value], {})).toThrow("Conflicting");
    }
  });

  it.each(["keep-going", "limit waits", "spawn-usage", "HTTP"])("returns before every token path for %s", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("token HTTP"));
    const claude = vi.fn(async () => { throw new Error("old CLI"); });
    const refresh = createUsageRefresh({ claude });
    const options = { instanceId: account.id, account, environment: { CLAUDE_CODE_OAUTH_TOKEN: "fake-env-token", CLAUDE_CONFIG_DIR: account.home } };
    try {
      const result = await refresh("claudeAgent", options);
      expect(request).not.toHaveBeenCalled();
      expect(claude).toHaveBeenCalledOnce();
      expect(result.status).toBe("no_observation");
    } finally { request.mockRestore(); }
  });

  it("advertises the CLI usage read for Claude accounts on every platform", () => {
    expect(canRefreshUsage("claudeAgent", {}, "win32", account)).toBe(true);
    expect(canRefreshUsage("claudeAgent", { CLAUDE_CODE_OAUTH_TOKEN: "fake" }, "darwin", account)).toBe(true);
  });

  it.each([
    { authMethod: "api_key", configDirectory: account.home },
    { authMethod: "claude.ai", configDirectory: join(account.home, "wrong") },
    { authMethod: "bedrock", configDirectory: account.home },
    {},
  ])("refuses a conflicting or unknown Claude identity %j", async (metadata) => {
    const run: typeof procs.execCli = (_cli, _args, _opts, cb) => cb(null, JSON.stringify({ loggedIn: true, email: "fixture@example.test", ...metadata }));
    expect((await claudeAuthStatus("fake", {}, run, account)).signedIn).toBe(false);
  });

  it("does not make an unrelated home wait for Codex retirement", async () => {
    vi.spyOn(procs, "killCliTree").mockImplementation(() => {});
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as unknown as Parameters<typeof retireAppServer>[0];
    retireAppServer(child, account.home);
    let done = false;
    const pending = awaitDyingAppServers(100, join(account.home, "different")).then(() => { done = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { expect(done).toBe(true); } finally { child.emit("close"); await pending; }
  });

  it("Codex helpers allow exactly the selected model-cache read and keep its fail-closed fallback", async () => {
    fs.mkdirSync(account.home, { recursive: true });
    fs.writeFileSync(join(account.home, "models_cache.json"), '{"models":[]}');
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("account-home read blocked"); });
    const helper = createCodexText("fake", () => ({ CODEX_HOME: account.home }), () => "gpt-6.1-sol", account);
    try {
      await helper.generateText("fixture").catch(() => undefined);
      expect(read).toHaveBeenCalledExactlyOnceWith(join(account.home, "models_cache.json"), "utf8");
    } finally { helper.dispose(); }
  });
});
