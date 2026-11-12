import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, instanceConfigs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { readCodexModelCatalog } from "./drivers/codex-catalog.ts";
import { createCodexText } from "./drivers/codex-text.ts";
import { readClaudeUsage } from "./claude-usage-probe.ts";
import { readUsageRpc, createUsageRefresh } from "./usage-refresh.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { recordEvents } from "./testing/events.ts";
import * as procs from "./procs.ts";
import { drivePathRule } from "./drive-mirror.ts";
import { loadProfileSyncSettings, saveProfileSyncSettings } from "./profile-sync.ts";
import { reportServerFailure } from "./error-reports.ts";
import { ERROR_SITES } from "../shared/error-report.mjs";
import { EngineLogin } from "./engine-login.ts";
const { buildDiagnosticsReport, decodeLogTail } = await import(new URL("../electron/diagnostics.mjs", import.meta.url).href);

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, promises: { ...fs.promises } };
});
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>() }));

const claudeReply = JSON.parse(fs.readFileSync(new URL("../test/fixtures/recorded/claude/account-signed-out.json", import.meta.url), "utf8"));
const codexReply = JSON.parse(fs.readFileSync(new URL("../test/fixtures/recorded/codex/account-turn.json", import.meta.url), "utf8"));
const helperReply = JSON.parse(fs.readFileSync(new URL("../test/fixtures/recorded/codex/account-helper.json", import.meta.url), "utf8"));
let serial = 0;
const registries: ProviderRegistry[] = [];
const instances: ProviderInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(kind: "claudeAgent" | "codex") {
  const root = join(DATA_DIR, `boundary-${++serial}`);
  const home = join(root, "accounts", "fixture");
  fs.mkdirSync(join(home, "state"), { recursive: true });
  fs.writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "unselected", never: "copy" }, { slug: "gpt-6.1-sol", context_window: 200_000, tool_mode: "code_mode_only" },
  ], unrelated: "never copy" }));
  const account = { id: "acct_7d6e234b-8046-4a5a-9354-2cf05f27d775", of: kind === "codex" ? "codex" : "claude", home, generation: 1 };
  const base = join(root, "base");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(join(base, kind === "codex" ? "AGENTS.md" : "CLAUDE.md"), "fixture global rules");
  fs.mkdirSync(join(base, "rules"), { recursive: true });
  fs.writeFileSync(join(base, "rules/r1.md"), "fixture rule");
  fs.mkdirSync(join(base, "skills/my-skill"), { recursive: true });
  fs.writeFileSync(join(base, "skills/my-skill/SKILL.md"), "fixture skill");
  const readFile = fs.readFileSync;
  const readSetup = () => readFile(join(home, kind === "codex" ? "AGENTS.md" : "CLAUDE.md"), "utf8");
  const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const forbidden: string[] = [];
  const allowed: string[] = [];
  const catalogs: any[] = [];
  let helper = false;
  let authenticated = true;
  let method = kind === "codex" ? "chatgpt" : "claude.ai";
  let directory = home;
  let login: "complete" | "failed" | "pending" | "device_cap" = "complete";
  let loginChild: ReturnType<typeof child> | undefined;
  let keepSignedIn = false;

  function check(path: unknown) {
    if (typeof path !== "string" && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
    const value = resolve(String(path)).toLowerCase();
    const prefix = resolve(home).toLowerCase();
    if (value !== prefix && !value.startsWith(`${prefix}\\`) && !value.startsWith(`${prefix}/`)) return;
    if (value.endsWith(".wink-codex-promo.json")) return;
    if (helper && value === resolve(join(home, "models_cache.json")).toLowerCase()) allowed.push(value);
    else { forbidden.push(value); throw new Error("Forbidden account-home read/open"); }
  }
  for (const target of [fs, fs.promises, promises]) {
    for (const key of target === fs ? ["readFileSync", "openSync", "readFile", "open"] as const : ["readFile", "open"] as const) {
      const object = target as any;
      const original = object[key];
      vi.spyOn(object, key).mockImplementation((...args: any[]) => { check(args[0]); return Reflect.apply(original, object, args); });
    }
  }

  function child(args: string[]) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const process = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null as number | null, signalCode: null, pid: undefined,
      stdin: new Writable({ write(chunk, _encoding, done) {
        queueMicrotask(() => {
          const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
          if (kind === "claudeAgent") {
            if (args.includes("stream-json")) for (const message of claudeReply.reply.messages) send(message);
          } else {
            const msg = JSON.parse(String(chunk));
            if (msg.method === "initialize") send({ id: msg.id, result: {} });
            if (msg.method === "account/read") send({ id: msg.id, result: { account: authenticated ? { type: method, email: "fixture@example.test" } : null } });
            if (msg.method === "account/rateLimits/read") send({ id: msg.id, result: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } } } });
            if (msg.method === "model/list") send({ id: msg.id, result: { data: [{ id: "gpt-6.1-sol", isDefault: true }] } });
            if (msg.method === "config/read") send({ id: msg.id, result: { config: { mcp_servers: {} } } });
            if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "fixture-thread" } } });
            if (msg.method === "turn/start") {
              send({ id: msg.id, result: { turn: { id: "fixture-turn" } } });
              const reply = args.some((arg) => arg.startsWith("model_catalog_json=")) ? helperReply : codexReply;
              for (const event of reply.reply.events) send(event);
            }
          }
        });
        done();
      }, final(done) {
        if (kind === "claudeAgent" && args.includes("text")) queueMicrotask(() => { stdout.end("fixture helper answer"); process.exitCode = 0; process.emit("close", 0); });
        done();
      } }),
    });
    return process;
  }

  vi.spyOn(procs, "killCliTree").mockImplementation((value, stopped) => {
    Object.assign(value, { exitCode: 0 });
    queueMicrotask(() => { value.emit("close", 0); stopped?.(); });
  });
  vi.spyOn(cp, "spawn").mockImplementation((_file, args, options) => {
    expect(options).not.toHaveProperty("accountBaseHome");
    const argv = args as string[];
    launches.push({ args: argv, env: options!.env! });
    const catalog = argv.find((arg) => arg.startsWith("model_catalog_json="));
    if (catalog) catalogs.push(JSON.parse(fs.readFileSync(JSON.parse(catalog.slice("model_catalog_json=".length)), "utf8")));
    const value = child(argv);
    if (argv.includes("login") || argv.includes("logout")) {
      loginChild = value;
      if (argv.includes("logout") && !keepSignedIn) authenticated = false;
      queueMicrotask(() => {
        if (login === "device_cap") value.stdout.write("Device limit reached: fake diagnostic omitted\n");
        else value.stdout.write("https://auth.example/device\nCode: ABCD-EFGH\n");
        if (login !== "pending") { value.exitCode = login === "failed" || login === "device_cap" ? 1 : 0; value.emit("close", value.exitCode); }
      });
    }
    return value as unknown as ReturnType<typeof cp.spawn>;
  });
  vi.spyOn(cp, "execFile").mockImplementation((_file: any, args: any, options: any, callback: any) => {
    launches.push({ args, env: options.env! });
    queueMicrotask(() => callback(null, args.includes("--version") ? "fixture-cli 1.0" : JSON.stringify({ loggedIn: authenticated, email: "fixture@example.test", authMethod: method, configDirectory: directory })));
    return child(args) as unknown as cp.ChildProcess;
  });
  const environment = { openai_api_key: "fake-key", Anthropic_Api_Key: "fake-key", META_API_KEY: "fake-key", XAI_API_KEY: "fake-key", ANTHROPIC_PROFILE: "console", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: base, CODEX_HOME: base, CODEX_SQLITE_HOME: "wrong-state" };
  const driver = kind === "codex" ? CodexDriver : ClaudeDriver;
  return { account, root, base, readSetup, launches, forbidden, allowed, catalogs, environment, driver,
    helper: (value: boolean) => { helper = value; }, signedIn: (value: boolean) => { authenticated = value; },
    auth: (value: string) => { method = value; }, directory: (value: string) => { directory = value; },
    login: (value: typeof login) => { login = value; }, loginChild: () => loginChild,
    keepSignedIn: () => { keepSignedIn = true; },
    create: async () => {
      const instance = await driver.create({ instanceId: account.id, displayName: "Fixture", account, enabled: true, environment,
        config: driver.decodeConfig({ cli: "fixture-cli", permissionMode: "bypassPermissions", fullAuto: true }),
      } as any);
      instances.push(instance);
      return instance;
    },
  };
}

function checkLaunches(f: ReturnType<typeof fixture>, kind: string) {
  expect(f.launches.length).toBeGreaterThan(0);
  for (const launch of f.launches) {
    const names = Object.keys(launch.env);
    expect(names.filter((key) => /api_key|^(?:ANTHROPIC|AWS|CODEX|CLAUDE)_PROFILE$|bedrock|^gh_token$/i.test(key))).toEqual([]);
    expect(launch.env[kind === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]).toBe(f.account.home);
    if (kind === "codex") {
      expect(launch.env.CODEX_SQLITE_HOME).toBe(join(f.account.home, "state"));
      expect(launch.args).toContain('forced_login_method="chatgpt"');
    } else if (launch.args[0] === "auth" || launch.args[0] === "--version") expect(launch.args).not.toContain("--setting-sources");
    else expect(launch.args.slice(-2)).toEqual(["--setting-sources", launch.args.includes("--include-partial-messages") ? "user,project,local" : "project,local"]);
  }
}

describe.each(["claudeAgent", "codex"] as const)("%s account boundaries", (kind) => {
  it("R4/R5 shares global rules on a recorded real turn without home reads/opens", async () => {
    const f = fixture(kind);
    const instance = await f.create();
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: `shared-${kind}`, text: "fixture", model: instance.models.default });
    await recorder.until((event) => event.type === "turn.completed");
    expect(f.forbidden).toEqual([]);
    if (kind === "claudeAgent") expect(f.launches.at(-1)!.args.slice(-2)).toEqual(["--setting-sources", "user,project,local"]);
    expect(fs.existsSync(join(f.account.home, kind === "codex" ? "AGENTS.md" : "CLAUDE.md"))).toBe(true);
    expect(f.readSetup()).toBe(kind === "codex" ? "fixture global rules" : `@${f.base.replace(/\\/g, "/").replace(/ /g, "\\ ")}/CLAUDE.md\n`);
    recorder.stop();
  });

  it("covers creation, catalogs, cached/fresh probes and a recorded turn with zero home reads/opens", async () => {
    const f = fixture(kind);
    const instance = await f.create();
    await instance.refreshModels?.();
    expect((await instance.snapshot()).authenticated).toBe(true);
    expect((await instance.snapshot()).authenticated).toBe(true);
    expect((await instance.snapshot({ refresh: true })).authenticated).toBe(true);
    if (kind === "codex") await readCodexModelCatalog(f.environment, fetch, "fixture-cli", { account: f.account, onAccount: () => {} });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: `recorded-${kind}`, text: "fixture", model: instance.models.default });
    await recorder.until((event) => event.type === "turn.completed");
    expect(f.forbidden).toEqual([]);
    expect(f.allowed).toEqual([]);
    checkLaunches(f, kind);
    recorder.stop();
  });

  it("keeps helpers on that account and limits the exception to models_cache.json", async () => {
    const f = fixture(kind);
    const instance = await f.create();
    f.helper(true);
    const value = await instance.generateText!("fixture", { lean: true });
    if (kind === "codex") {
      expect(value).toContain("SUMMARY");
      expect(f.catalogs[0].models).toEqual([expect.objectContaining({ slug: "gpt-6.1-sol", tool_mode: "direct", shell_type: "disabled", apply_patch_tool_type: null })]);
      expect(JSON.stringify(f.catalogs)).not.toMatch(/unselected|unrelated|never copy/);
    }
    else { expect(value).toBe("fixture helper answer"); await instance.reviewPermission!("fixture"); }
    f.helper(false);
    expect(f.forbidden).toEqual([]);
    expect(f.allowed.length).toBe(kind === "codex" ? 1 : 0);
    checkLaunches(f, kind);
  });

  it.each(["complete", "failed", "pending"] as const)("covers %s sign-in, cancellation and the post-logout probe without home reads/opens", async (login) => {
    const f = fixture(kind);
    const registry = new ProviderRegistry([f.driver as any]);
    registries.push(registry);
    await registry.load({ [f.account.id]: { driver: kind, account: f.account, environment: f.environment, config: { cli: "fixture-cli" } } });
    f.login(login);
    await registry.startSignIn(f.account.id);
    if (login === "pending") await registry.cancelSignIn(f.account.id);
    await registry.logins.wait(f.account.id);
    await registry.get(f.account.id)!.snapshot({ refresh: true });
    f.login("complete");
    expect(await registry.signOut(f.account.id)).toBe(true);
    expect(f.forbidden).toEqual([]);
    expect(f.allowed).toEqual([]);
    checkLaunches(f, kind);
  });

  it("keeps usage, sync, diagnostics and error reporting outside account homes", async () => {
    const f = fixture(kind);
    await f.create();
    const refresh = createUsageRefresh();
    const result = await refresh(kind, { instanceId: f.account.id, account: f.account, cli: "fixture-cli", environment: f.environment });
    if (kind === "codex") expect(result.report?.windows[0].usedPercent).toBe(42);
    else expect(result.status).toBe("no_observation");
    const settings = loadProfileSyncSettings(f.root);
    saveProfileSyncSettings(f.root, settings);
    const ids = { profileDeviceId: "fixture", writerId: "fixture", memoryDeviceId: "012345abcdef" };
    expect(drivePathRule("accounts.json", ids)).toBe("unknown");
    expect(drivePathRule(`accounts/${f.account.id}/auth.json`, ids)).toBe("unknown");
    const report = buildDiagnosticsReport({ configSummary: { accounts: f.account }, logTail: "fixture" });
    expect(report).not.toContain(f.account.home);
    const main = fs.readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
    const collector = main.slice(main.indexOf("const LOG_TAIL_BYTES ="), main.indexOf("// Set by startServerPackaged:"));
    const exporter = main.slice(main.indexOf('ipcMain.handle("desktop:export-diagnostics",'), main.indexOf("// Bots hand users files"));
    const handlers = new Map<string, (event: object) => Promise<string>>();
    const exported = join(f.root, "diagnostics.txt");
    fs.writeFileSync(join(f.root, "server.log"), "fixture log");
    runInNewContext(`${collector}\n${exporter}`, {
      fs, path: { join }, Buffer, AbortSignal, SERVER_PORT: 1, serverToken: null, LOG_DIR: f.root,
      decodeLogTail, buildDiagnosticsReport, fetch: async () => Response.json({ engines: 2 }),
      app: { getVersion: () => "fixture", isPackaged: true },
      process: { platform: process.platform, arch: process.arch, versions: { node: process.versions.node }, uptime: () => 1 },
      ipcMain: { handle: (name: string, handler: (event: object) => Promise<string>) => handlers.set(name, handler) },
      BrowserWindow: { fromWebContents: () => undefined },
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: exported }) },
      nativeText: () => "fixture", diagnosticsFileName: () => "fixture.txt",
    });
    expect(await handlers.get("desktop:export-diagnostics")!({ sender: {} })).toBe(exported);
    expect(fs.readFileSync(exported, "utf8")).toContain("Wink diagnostics");
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);
    await reportServerFailure({ url: "http://127.0.0.1:1", token: "fixture-token" });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ code: "SERVER_RUNTIME_FAILURE", site: ERROR_SITES.serverRuntime });
    expect(f.forbidden).toEqual([]);
    expect(f.allowed).toEqual([]);
    checkLaunches(f, kind);
  });

  it("does not mistake a rejected subscription identity for confirmed logout", async () => {
    const f = fixture(kind);
    f.auth(kind === "codex" ? "apiKey" : "api_key");
    f.keepSignedIn();
    const registry = new ProviderRegistry([f.driver as any]);
    registries.push(registry);
    await registry.load({ [f.account.id]: { driver: kind, account: f.account, config: { cli: "fixture-cli" } } });
    expect(await registry.signOut(f.account.id)).toBe(false);
    expect(f.forbidden).toEqual([]);
    checkLaunches(f, kind);
  });
});

it("keeps a lean Claude turn free of user setup", async () => {
  const f = fixture("claudeAgent");
  const instance = await f.create();
  const recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: "lean-setup", text: "fixture", leanStartup: true });
  await recorder.until((event) => event.type === "turn.completed");
  expect(f.launches.at(-1)!.args.slice(-2)).toEqual(["--setting-sources", "project,local"]);
  expect(fs.readdirSync(f.account.home).sort()).toEqual(["models_cache.json", "state"]);
  expect(f.forbidden).toEqual([]);
  recorder.stop();
});

it.each([true, false])("keeps Claude helpers free of setup, lean %s", async (lean) => {
  const f = fixture("claudeAgent");
  const instance = await f.create();
  expect(await instance.generateText!("fixture", { lean })).toBe("fixture helper answer");
  const launch = f.launches.find((entry) => entry.args.includes("claude-haiku-5-5"))!;
  expect(launch.args.slice(-2)).toEqual(["--setting-sources", "project,local"]);
  expect(fs.readdirSync(f.account.home).sort()).toEqual(["models_cache.json", "state"]);
  expect(f.forbidden).toEqual([]);
});

it("keeps the Claude usage probe free of setup", async () => {
  const f = fixture("claudeAgent");
  const pending = readClaudeUsage("fixture-cli", f.environment, f.account);
  expect(f.launches.at(-1)!.args.slice(-2)).toEqual(["--setting-sources", "project,local"]);
  expect(fs.readdirSync(f.account.home).sort()).toEqual(["models_cache.json", "state"]);
  expect(f.forbidden).toEqual([]);
  vi.mocked(cp.spawn).mock.results.at(-1)!.value.emit("error", new Error("fixture end"));
  await expect(pending).rejects.toThrow("unavailable");
});

it("keeps Claude auth and version launches free of setup", async () => {
  const f = fixture("claudeAgent");
  const instance = await f.create();
  await instance.snapshot({ refresh: true });
  expect(f.launches.some((launch) => launch.args[0] === "auth")).toBe(true);
  expect(f.launches.some((launch) => launch.args[0] === "--version")).toBe(true);
  for (const launch of f.launches) expect(launch.args).not.toContain("--setting-sources");
  expect(fs.readdirSync(f.account.home).sort()).toEqual(["models_cache.json", "state"]);
  expect(f.forbidden).toEqual([]);
});

it("gates listeners per engine and cancels only the owning account", async () => {
  const f = fixture("codex");
  f.login("pending");
  const manager = new EngineLogin(5000, 50);
  try {
    await manager.start("account-a", "fixture-cli", ["login"], {}, [], { scope: "codex", account: f.account });
    await expect(manager.start("account-b", "fixture-cli", ["login"], {}, [], { scope: "codex", account: f.account })).rejects.toThrow("Another sign-in");
    await manager.start("account-c", "fixture-cli", ["login"], {}, [], { scope: "claudeAgent", account: f.account });
    expect(f.launches).toHaveLength(2);
    await manager.cancel("account-a");
    expect(manager.state("account-c")).toBe("pending");
    await manager.start("account-b", "fixture-cli", ["login"], {}, [], { scope: "codex", account: f.account });
    expect(f.launches).toHaveLength(3);
  } finally { await manager.dispose(); }
});

it("holds the login gate until the process-tree stop before the fallback deadline", async () => {
  const f = fixture("codex");
  f.login("pending");
  const stopped: Array<() => void> = [];
  vi.mocked(procs.killCliTree).mockImplementation((value, done) => {
    Object.assign(value, { exitCode: 0 });
    queueMicrotask(() => value.emit("close", 0));
    if (done) stopped.push(done);
  });
  const manager = new EngineLogin(5000, 50);
  try {
    await manager.start("account-a", "fixture-cli", ["login"], {}, [], { scope: "codex", account: f.account });
    vi.useFakeTimers();
    const cancelled = manager.cancel("account-a");
    const next = manager.start("account-b", "fixture-cli", ["login"], {}, [], { scope: "codex", account: f.account });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.launches).toHaveLength(1);
    stopped.shift()!();
    await cancelled;
    await vi.advanceTimersByTimeAsync(50);
    await next;
    expect(f.launches).toHaveLength(2);
  } finally {
    vi.useRealTimers();
    stopped.splice(0).forEach((done) => done());
    vi.mocked(procs.killCliTree).mockImplementation((value, done) => {
      Object.assign(value, { exitCode: 0 });
      queueMicrotask(() => { value.emit("close", 0); done?.(); });
    });
    await manager.dispose();
  }
});

it.skipIf(process.platform !== "win32")("acknowledges a natural CLI exit that beats taskkill", () => {
  fixture("codex");
  vi.mocked(procs.killCliTree).mockRestore();
  const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null as number | null, signalCode: null, kill: vi.fn() });
  const stopped = vi.fn();
  vi.mocked(cp.execFile).mockImplementation((_file: any, _args: any, _options: any, callback: any) => {
    child.exitCode = 0;
    callback(Object.assign(new Error("fixture process gone"), { code: 128 }), "", 'ERROR: The process "4242" not found.');
    return child as unknown as cp.ChildProcess;
  });
  procs.killCliTree(child as unknown as cp.ChildProcess, stopped);
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
});

it("Codex admits only engine-reported ChatGPT accounts", async () => {
  const f = fixture("codex");
  f.auth("apiKey");
  const instance = await f.create();
  expect((await instance.snapshot()).authenticated).toBe(false);
  await expect(instance.adapter.sendTurn({ threadId: "denied", text: "fixture" })).rejects.toThrow("Sign in");
  await expect(readUsageRpc("fixture-cli", {}, f.account)).rejects.toThrow("signin");
  expect(f.forbidden).toEqual([]);
});

it("refuses a credential-file alias at the permitted model-cache path", async () => {
  const f = fixture("codex");
  await f.create();
  const helper = createCodexText("fixture-cli", () => ({ CODEX_HOME: f.account.home }), () => "gpt-6.1-sol", f.account);
  const source = join(f.root, "fixture-auth.json");
  fs.writeFileSync(source, '{"tokens":"fixture-only"}');
  const cache = join(f.account.home, "models_cache.json");
  fs.unlinkSync(cache);
  fs.linkSync(source, cache);
  f.helper(true);
  const count = f.launches.length;
  await expect(helper.generateText("fixture")).rejects.toThrow("model catalog unavailable");
  helper.dispose();
  expect(f.launches).toHaveLength(count);
  expect(f.allowed).toEqual([]);
  expect(f.forbidden).toEqual([]);
});

it("Claude checks the reported home and subscription method at admission", async () => {
  const f = fixture("claudeAgent");
  f.directory(join(f.account.home, "wrong"));
  const instance = await f.create();
  expect((await instance.snapshot()).authenticated).toBe(false);
  await expect(instance.generateText!("fixture")).rejects.toThrow("Sign in");
  expect(f.forbidden).toEqual([]);
});

it("recognizes a Codex device cap once without exposing raw CLI output or retrying", async () => {
  const f = fixture("codex");
  const registry = new ProviderRegistry([CodexDriver]);
  registries.push(registry);
  await registry.load({ [f.account.id]: { driver: "codex", account: f.account, config: { cli: "fixture-cli" } } });
  f.login("device_cap");
  expect(await registry.startSignIn(f.account.id)).toEqual({ error: "device_cap" });
  await registry.describeCached();
  await registry.describeCached();
  expect(f.launches.filter((launch) => launch.args.includes("login"))).toHaveLength(1);
  expect(f.forbidden).toEqual([]);
});

it.each(["claudeAgent", "codex"] as const)("keeps %s no-account merge and dispatch free of additional filesystem or process work", async (kind) => {
  const f = fixture(kind);
  const absent = { ...f.account, home: join(f.root, "unused") };
  const environment = kind === "codex" ? { CODEX_HOME: absent.home } : { CLAUDE_CONFIG_DIR: absent.home };
  const instance = await f.driver.create({ instanceId: "base", displayName: "Fixture", enabled: true, environment, config: f.driver.decodeConfig({ cli: "fixture-cli", permissionMode: "bypassPermissions", fullAuto: true }) } as any);
  instances.push(instance);
  const read = vi.spyOn(fs, "readFileSync");
  const open = vi.spyOn(fs, "openSync");
  const launchCount = f.launches.length;
  read.mockClear(); open.mockClear();
  expect(instanceConfigs({})).toEqual(instanceConfigs({}, []));
  expect(read).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  const recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: "base-fast-path", text: "fixture" });
  await recorder.until((event) => event.type === "turn.completed");
  expect(f.launches.length - launchCount).toBe(1);
  expect(f.launches.at(-1)!.args).not.toContain("--setting-sources");
  expect(f.launches.at(-1)!.args).not.toContain('forced_login_method="chatgpt"');
  expect(read.mock.calls.filter(([path]) => String(path).includes("accounts.json"))).toEqual([]);
  expect(open.mock.calls.filter(([path]) => String(path).includes("accounts.json"))).toEqual([]);
  recorder.stop();
});
