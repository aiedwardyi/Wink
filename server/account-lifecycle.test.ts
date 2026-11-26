import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, instanceConfigs } from "./config.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { ProviderReload } from "./harness/provider-reload.ts";
import { EventBus } from "./harness/bus.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import type { ProviderSnapshot } from "./contracts.ts";
import type { MainChange } from "./account-lifecycle.ts";
import { Store } from "./store.ts";
import { createUsageRefresh } from "./usage-refresh.ts";
import { createInstanceChecks } from "./instance-checks.ts";
import { resetPathCacheForTests } from "./env-path.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { accountLaunch } from "./account-policy.ts";
import { shareUserSetup } from "./account-shared-setup.ts";
import { markCodexPromo } from "../electron/codex-promo.mjs";
import { createUsageBoard } from "./usage-board.ts";
import { createUsageHistory } from "./usage-history.ts";

const core = await import("./accounts.ts").catch(() => null);
const lifecycle = await import("./account-lifecycle.ts").catch(() => null);
const routes = await import("./account-routes.ts").catch(() => null);
const runtime = await import("./account-runtime.ts").catch(() => null);
const registries: ProviderRegistry[] = [];
const controllers: InstanceType<NonNullable<typeof lifecycle>["AccountLifecycle"]>[] = [];
let next = 0;

afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture(onMainChanged?: (change: MainChange) => void, grok = false) {
  expect(core, "account service exists").not.toBeNull();
  expect(lifecycle, "account lifecycle exists").not.toBeNull();
  const dir = join(DATA_DIR, `lifecycle-${++next}`);
  mkdirSync(dir, { recursive: true });
  const bases = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" }, ...grok ? { grok: { driver: "grokAgent" } } : {} };
  const accounts = new core!.AccountService(dir, () => bases);
  const statuses = new Map<string, ProviderSnapshot>();
  const drivers = ["claudeAgent", "codex", "grokAgent"].map((kind) => {
    const fake = makeFakeDriver({ kind }).driver;
    const create = fake.create;
    return { ...fake, defaultConfig: () => ({ cli: "fake" }), install: { login: { args: ["login"], deviceArgs: ["device"], env: { OPENAI_API_KEY: "fake-install-key" } }, logout: ["logout"] },
      create: async (input: Parameters<typeof create>[0]) => {
        const instance = await create(input);
        return { ...instance, account: input.account,
          snapshot: vi.fn(async (): Promise<ProviderSnapshot> => statuses.get(input.instanceId) ?? { state: "available", authenticated: true, accountIdentity: `identity-${input.instanceId}` }),
        };
      },
    };
  });
  const registry = new ProviderRegistry(drivers);
  registries.push(registry);
  const configs = () => instanceConfigs({ instances: bases }, accounts.snapshot);
  await registry.load(configs());
  const bus = new EventBus();
  const providers = new ProviderReload(registry, bus, configs());
  const references = new Set<string>();
  const invalidate = vi.fn();
  const changed = vi.fn();
  let configBusy = false;
  let state: ReturnType<typeof registry.logins.state> = "complete";
  let waiting: Promise<void> = Promise.resolve();
  let logoutFails = false;
  const start = vi.spyOn(registry.logins, "start").mockImplementation(async (id, _cli, args) => {
    if (args.includes("logout") && !logoutFails) statuses.set(id, { state: "available", authenticated: false, accountAuthenticated: false });
    return {};
  });
  vi.spyOn(registry.logins, "state").mockImplementation(() => state);
  vi.spyOn(registry.logins, "wait").mockImplementation(() => waiting);
  if (onMainChanged) vi.stubGlobal("fetch", vi.fn(async () => Response.json({ count: 0, unknown: 0, generations: {} })));
  const routed = onMainChanged && runtime!.createAccountRuntime({
    accounts, registry, providers, store: new Store(() => ({ instanceId: "claude", model: "claudeAgent-1" })), reload: () => providers.reload(configs()),
    rateLimits: new Map(), saveRateLimits: () => {}, usage: createUsageRefresh(), availability: new Map(), invalidateWaits: () => {},
    botActive: () => false, terminal: () => ({ url: "http://127.0.0.1:1", token: "fixture" }), configBusy: () => configBusy, onMainChanged,
  });
  const controller = routed || new lifecycle!.AccountLifecycle(accounts, registry, {
    reload: () => providers.reload(configs()),
    referenced: async (id) => references.has(id), invalidate, changed, configBusy: () => configBusy,
  });
  controllers.push(controller);
  return { dir, bases, accounts, registry, drivers, controller, holdStarting: routed ? routed.holdStarting : undefined, references, invalidate, changed, start, statuses, providers, configs,
    busy: (value: boolean) => { configBusy = value; }, failLogout: () => { logoutFails = true; },
    state: (value: typeof state) => { state = value; }, wait: (value: Promise<void>) => { waiting = value; },
    add: async (of = "claude") => { const result = await controller.add(of, false, "pc:"); await controller.settled(result.id); return accounts.get(result.id)!; },
  };
}

describe("account lifecycle", () => {
  it.each(["claude", "codex", "grok"])("a saved %s account whose home is gone reads signed out and Sign In creates it", async (of) => {
    const f = await fixture(undefined, true);
    const account = await f.add(of);
    rmSync(account.home, { recursive: true });
    const snapshot = vi.spyOn(f.registry.get(account.id)!, "snapshot");
    await f.registry.describe({ refresh: true });
    expect(snapshot).not.toHaveBeenCalled();
    expect(f.accounts.get(account.id)?.state).toBe("stopped");
    expect(f.registry.accountBlocked(account.id)).toBe(true);
    expect(existsSync(account.home)).toBe(false);
    await f.controller.signIn(account.id, false, "pc:");
    await f.controller.settled(account.id);
    expect(readdirSync(account.home)).toEqual(of === "codex" ? ["state"] : []);
    expect(f.start.mock.calls.at(-1)?.[2]).toEqual(["login"]);
    expect(f.accounts.get(account.id)?.state).toBe("ready");
  });

  it("a saved account whose home went missing before a restart reads signed out without launching", async () => {
    const f = await fixture();
    const account = await f.add("codex");
    rmSync(account.home, { recursive: true });
    const accounts = new core!.AccountService(f.dir, () => f.bases);
    const registry = new ProviderRegistry(f.drivers);
    registries.push(registry);
    await registry.load(instanceConfigs({ instances: f.bases }, accounts.snapshot), { deferAccountAuth: true });
    const snapshot = vi.spyOn(registry.get(account.id)!, "snapshot");
    const controller = new lifecycle!.AccountLifecycle(accounts, registry, {
      reload: async () => {}, referenced: async () => false, invalidate: vi.fn(), changed: vi.fn(), configBusy: () => false,
    });
    controllers.push(controller);
    await controller.restore();
    expect(snapshot).not.toHaveBeenCalled();
    expect(accounts.get(account.id)?.state).toBe("stopped");
    expect(registry.accountStopped(account.id)).toBe(true);
    expect(existsSync(account.home)).toBe(false);
  });

  it("keeps a signed-in Codex account ready when only its state folder is missing", async () => {
    const f = await fixture();
    const account = await f.add("codex");
    rmSync(join(account.home, "state"), { recursive: true });
    const snapshot = vi.spyOn(f.registry.get(account.id)!, "snapshot");
    await f.registry.describe({ refresh: true });
    expect(snapshot).toHaveBeenCalled();
    expect(f.accounts.get(account.id)?.state).toBe("ready");
    expect(f.registry.accountAvailable(account.id)).toBe(true);
    const accounts = new core!.AccountService(f.dir, () => f.bases);
    expect(accounts.error).toBeUndefined();
    const registry = new ProviderRegistry(f.drivers);
    registries.push(registry);
    await registry.load(instanceConfigs({ instances: f.bases }, accounts.snapshot), { deferAccountAuth: true });
    const controller = new lifecycle!.AccountLifecycle(accounts, registry, {
      reload: async () => {}, referenced: async () => false, invalidate: vi.fn(), changed: vi.fn(), configBusy: () => false,
    });
    controllers.push(controller);
    await controller.restore();
    expect(accounts.get(account.id)?.state).toBe("ready");
    expect(registry.accountAvailable(account.id)).toBe(true);
    expect(existsSync(join(account.home, "state"))).toBe(false);
  });

  it("never brings back the missing home of a removed account", async () => {
    const f = await fixture();
    const account = await f.add("codex");
    rmSync(account.home, { recursive: true });
    await expect(f.controller.remove(account.id)).resolves.toEqual({});
    await expect(f.controller.signIn(account.id, false, "pc:")).rejects.toMatchObject({ status: 404 });
    await f.registry.describe({ refresh: true });
    expect(() => markCodexPromo(account.home, account.generation)).toThrow();
    const base = join(f.dir, "base");
    mkdirSync(join(base, "skills", "fixture"), { recursive: true });
    writeFileSync(join(base, "AGENTS.md"), "fixture");
    shareUserSetup("codex", account, base);
    expect(new core!.AccountService(f.dir, () => f.bases).error).toBeUndefined();
    expect(existsSync(account.home)).toBe(false);
  });

  it("removes a saved Codex account whose home is a junction as it always did", async () => {
    const f = await fixture();
    const account = await f.add("codex");
    const target = join(f.dir, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "keep");
    rmSync(account.home, { recursive: true });
    symlinkSync(target, account.home, "junction");
    // As the Codex driver does: its login env resolves through accountLaunch.
    f.registry.get(account.id)!.loginConfig = () => ({ cli: "fake", env: accountLaunch(account, "codex", [], {}).env });
    await expect(f.controller.remove(account.id)).resolves.toEqual({});
    expect(f.accounts.get(account.id)).toBeUndefined();
    expect(readdirSync(target)).toEqual(["keep"]);
  });

  it("refuses Sign In through a saved home that became a junction and creates nothing", async () => {
    const f = await fixture();
    const account = await f.add("codex");
    await f.accounts.stop(account.id);
    const target = join(f.dir, "target");
    mkdirSync(target);
    rmSync(account.home, { recursive: true });
    symlinkSync(target, account.home, "junction");
    const logins = f.start.mock.calls.length;
    await expect(f.controller.signIn(account.id, false, "pc:")).rejects.toThrow("link or alias");
    expect(readdirSync(target)).toEqual([]);
    expect(f.start.mock.calls.length).toBe(logins);
    expect(f.accounts.get(account.id)?.state).toBe("stopped");
  });

  it("clears a base account's promo mark after sign-in completes", async () => {
    const f = await fixture();
    const home = join(f.dir, "base-codex");
    mkdirSync(home, { recursive: true });
    f.registry.get("codex")!.loginConfig = () => ({ cli: "fake", env: { CODEX_HOME: home } });
    const file = join(home, ".wink-codex-promo.json");
    writeFileSync(file, '{"generation":0}');
    f.state("cancelled");
    await f.controller.signIn("codex", false, "pc:");
    await f.controller.settled("codex");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ generation: 0 });
    f.state("complete");
    await f.controller.signIn("codex", false, "pc:");
    await f.controller.settled("codex");
    expect(JSON.parse(readFileSync(file, "utf8"))).toBeNull();
  });

  it("clears a promo mark only after a successful account sign-in", async () => {
    const f = await fixture();
    const account = await f.add("codex");
    const file = join(account.home, ".wink-codex-promo.json");
    writeFileSync(file, JSON.stringify({ generation: account.generation }));
    f.state("failed");
    await f.controller.signIn(account.id, false, "pc:");
    await f.controller.settled(account.id);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ generation: account.generation });
    f.state("complete");
    await f.controller.signIn(account.id, false, "pc:");
    await f.controller.settled(account.id);
    expect(JSON.parse(readFileSync(file, "utf8"))).toBeNull();
  });

  it.each(["identity", "email", "stored identity"])("rejects a new account with an existing %s", async (match) => {
    const f = await fixture();
    const existing = await f.add();
    f.statuses.set(existing.id, { state: "available", authenticated: true, accountIdentity: existing.identity, account: "same@example.test" });
    if (match === "stored identity") vi.spyOn(f.registry.get(existing.id)!, "snapshot").mockRejectedValue(new Error("probe unavailable"));
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    const added = await f.controller.add("claude", false, "pc:");
    f.statuses.set(added.id, { state: "available", authenticated: true,
      accountIdentity: match === "email" ? "another-identity" : existing.identity, account: " SAME@EXAMPLE.TEST " });
    release();
    await f.controller.settled(added.id);
    expect(f.accounts.snapshot.map((row) => row.id)).toEqual([existing.id]);
    expect(f.controller.signInResult(added.id, "pc:")).toEqual({ state: "duplicate", existingId: existing.id });
    expect(f.accounts.get(existing.id)).toEqual(existing);
    expect(f.start.mock.calls.some(([, , args]) => args.includes("logout"))).toBe(false);
  });

  it("rejects a new account matching the base login", async () => {
    const f = await fixture();
    f.statuses.set("claude", { state: "available", authenticated: true, account: "base@example.test" });
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    const added = await f.controller.add("claude", false, "pc:");
    f.statuses.set(added.id, { state: "available", authenticated: true, accountIdentity: "base-identity", account: "base@example.test" });
    release();
    await f.controller.settled(added.id);
    expect(f.accounts.snapshot).toHaveLength(0);
    expect(f.controller.signInResult(added.id, "pc:")).toEqual({ state: "duplicate", existingId: "claude" });
  });

  it("rechecks account changes without blocking them on duplicate probes", async () => {
    const f = await fixture();
    const existing = await f.add();
    const stale: ProviderSnapshot = { state: "available", authenticated: true, accountIdentity: existing.identity, account: "old@example.test" };
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    let releaseProbe!: () => void;
    const probe = new Promise<ProviderSnapshot>((done) => { releaseProbe = () => done(stale); });
    vi.spyOn(f.registry.get(existing.id)!, "snapshot").mockImplementationOnce(() => { entered(); return probe; });
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    const added = await f.controller.add("claude", false, "pc:");
    f.statuses.set(added.id, { state: "available", authenticated: true, accountIdentity: "incoming", account: "same@example.test" });
    release();
    await started;
    const changed: ProviderSnapshot = { state: "available", authenticated: true, accountIdentity: "changed", account: "same@example.test" };
    f.statuses.set(existing.id, changed);
    let observed = false;
    const observation = f.controller.observe(existing.id, changed).then(() => { observed = true; });
    try { await vi.waitFor(() => expect(observed).toBe(true), { timeout: 1000 }); }
    finally {
      releaseProbe();
      await observation;
      await f.controller.settled(added.id);
    }
    expect(f.controller.signInResult(added.id, "pc:")).toEqual({ state: "duplicate", existingId: existing.id });
    expect(f.accounts.snapshot.map((row) => row.id)).toEqual([existing.id]);
  });

  it("preserves existing duplicates through sign-in recovery", async () => {
    const f = await fixture();
    const first = await f.add();
    const second = await f.add();
    const snapshot: ProviderSnapshot = { state: "available", authenticated: true, accountIdentity: first.identity, account: "same@example.test" };
    f.statuses.set(first.id, snapshot);
    f.statuses.set(second.id, snapshot);
    await f.controller.signIn(second.id, false, "pc:");
    await f.controller.settled(second.id);
    expect(f.accounts.snapshot.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(f.accounts.get(second.id)?.identity).toBe(first.identity);
    expect(f.registry.accountBlocked(second.id)).toBe(false);
  });

  it("allows the same email on different engines and waits for the add decision", async () => {
    const f = await fixture();
    const existing = await f.add();
    const snapshot: ProviderSnapshot = { state: "available", authenticated: true, accountIdentity: existing.identity, account: "same@example.test" };
    f.statuses.set(existing.id, snapshot);
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    const added = await f.controller.add("codex", false, "pc:");
    f.statuses.set(added.id, snapshot);
    expect((await request(f, "GET", `/api/accounts/${added.id}/sign-in`)).body.state).toBe("pending");
    release();
    await f.controller.settled(added.id);
    expect(f.accounts.snapshot.map((row) => row.id)).toEqual([existing.id, added.id]);
    expect(f.accounts.get(added.id)?.state).toBe("ready");
    f.state(undefined);
    expect((await request(f, "GET", `/api/accounts/${added.id}/sign-in`)).body.state).toBe("complete");
  });

  it("handles failed base sign-in snapshots", async () => {
    const f = await fixture();
    f.registry.blockAccount("claude", true);
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    const snapshot = vi.spyOn(f.registry.get("claude")!, "snapshot").mockRejectedValue(new Error("fixture probe failure"));
    await f.controller.signIn("claude", false, "pc:");
    const finished = f.controller.settled("claude");
    release();
    await expect(finished).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalled();
    expect(f.registry.accountBlocked("claude")).toBe(true);
  });

  it("retains a newer base sign-in's pending entry", async () => {
    const f = await fixture();
    f.registry.blockAccount("claude", true);
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    const newer = Promise.resolve();
    const pending = (f.controller as unknown as { pending: Map<string, Promise<void>> }).pending;
    vi.spyOn(f.registry.get("claude")!, "snapshot").mockImplementation(async () => {
      pending.set("claude", newer);
      return { state: "available", authenticated: true };
    });
    await f.controller.signIn("claude", false, "pc:");
    const finished = f.controller.settled("claude");
    release();
    await finished;
    expect(pending.get("claude")).toBe(newer);
  });

  it.each(["turn", "pane", "unreachable"])("guards base sign-in against a live %s when accounts exist", async (kind) => {
    const f = await fixture();
    await f.add();
    if (kind === "turn") f.references.add("claude");
    else (f.controller as unknown as { hooks: { panesBusy(id: string): Promise<boolean> } }).hooks.panesBusy = async () => true;
    f.start.mockClear();
    await expect(f.controller.signIn("claude", false, "pc:")).rejects.toThrow(/active work/);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.registry.accountBlocked("claude")).toBe(false);
  });

  it("restores base availability when login cannot start", async () => {
    const f = await fixture();
    await f.add();
    vi.spyOn(f.registry, "startSignIn").mockRejectedValue(new Error("Another sign-in is running"));
    await expect(f.controller.signIn("claude", false, "pc:")).rejects.toThrow("Another sign-in");
    expect(f.registry.accountBlocked("claude")).toBe(false);
  });

  it("starts sign-in on a signed-out account while its stopped worker panes are still open", async () => {
    const f = await fixture();
    const account = await f.add();
    const panesBusy = vi.fn(async () => false);
    (f.controller as unknown as { hooks: { panesBusy(id: string): Promise<boolean> } }).hooks.panesBusy = panesBusy;
    await f.controller.signedOut?.(account.id);
    await f.controller.signedOut?.("claude");
    f.start.mockClear();
    await expect(f.controller.signIn(account.id, false, "pc:")).resolves.toBeDefined();
    await f.controller.settled(account.id);
    await expect(f.controller.signIn("claude", false, "pc:")).resolves.toBeDefined();
    expect(f.start.mock.calls.map(([id]) => id)).toEqual([account.id, "claude"]);
    expect(panesBusy).toHaveBeenCalledWith(account.id, true);
    expect(panesBusy).toHaveBeenCalledWith("claude", true);
    f.references.add(account.id);
    await f.controller.signedOut?.(account.id);
    await expect(f.controller.signIn(account.id, false, "pc:")).rejects.toThrow(/active work/);
  });

  it.runIf(process.platform === "win32")("signs in a stopped Claude account before a status check selects the working CLI", async () => {
    const f = await fixture();
    const account = await f.add();
    await f.accounts.stop(account.id);
    const broken = join(f.dir, "old bin");
    const working = join(f.dir, "new bin");
    const opened = join(f.dir, "browser-requested");
    const failed = join(f.dir, "broken-login");
    for (const dir of [broken, working]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "claude.cmd"), '@node "%~dp0\\cli.cjs" %*');
    }
    writeFileSync(join(broken, "cli.cjs"), `
      if (process.argv[2] === 'auth') require('node:fs').writeFileSync(${JSON.stringify(failed)}, 'Claude package binary is missing');
      console.error('Claude package binary is missing');
      process.exitCode = 1;
    `);
    writeFileSync(join(working, "cli.cjs"), `
      const args = process.argv.slice(2);
      if (args[0] === '--version') console.log('2.1.325 (Claude Code)');
      if (args.slice(0, 2).join(' ') === 'auth login') {
        require('node:fs').writeFileSync(${JSON.stringify(opened)}, process.env.CLAUDE_CONFIG_DIR);
        console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true");
      }
    `);
    vi.stubEnv("PATH", `${broken};${working}`);
    vi.stubEnv("OMB_EXTRA_PATH", "");
    for (const name of ["APPDATA", "LOCALAPPDATA", "ProgramFiles"]) vi.stubEnv(name, f.dir);
    resetPathCacheForTests();
    const registry = new ProviderRegistry([ClaudeDriver]);
    registries.push(registry);
    const configs = f.configs();
    const controller = new lifecycle!.AccountLifecycle(f.accounts, registry, {
      reload: async () => {}, referenced: async () => false, invalidate: () => {},
    });
    controllers.push(controller);
    try {
      await registry.load({ [account.id]: configs[account.id] }, { deferAccountAuth: true });
      await controller.restore();
      const response = await request({ controller, registry }, "POST", `/api/instances/${account.id}/sign-in`);
      await controller.settled(account.id);
      expect(existsSync(failed), "the broken shim received auth login").toBe(false);
      expect(response).toMatchObject({ status: 200 });
      // The fake CLI exits at once, so its link ended with the attempt.
      expect(response.body).toEqual({});
      expect(readFileSync(opened, "utf8")).toBe(account.home);
    } finally {
      vi.unstubAllEnvs();
      resetPathCacheForTests();
    }
  });

  it("still refuses sign-in on a ready account with live panes and gives the account-busy code", async () => {
    const f = await fixture();
    const account = await f.add();
    (f.controller as unknown as { hooks: { panesBusy(id: string): Promise<boolean> } }).hooks.panesBusy = async () => true;
    f.start.mockClear();
    for (const id of [account.id, "claude"]) {
      await expect(f.controller.signIn(id, false, "pc:")).rejects.toMatchObject({ message: "Finish this account's active work before signing in", code: "account-busy" });
      expect(await request(f, "POST", `/api/accounts/${id}/sign-in`)).toMatchObject({ status: 409, body: { error: "Finish this account's active work before signing in", code: "account-busy" } });
    }
    expect(f.start).not.toHaveBeenCalled();
    expect(f.registry.accountBlocked("claude")).toBe(false);
    expect(f.accounts.get(account.id)?.state).toBe("ready");
    await expect(runtime!.accountPanesBusy(null, account.id)).rejects.toMatchObject({ code: "host-unknown" });
    const { LoginBusyError } = await import("./engine-login.ts");
    (f.controller as unknown as { hooks: { panesBusy(id: string): Promise<boolean> } }).hooks.panesBusy = async () => false;
    vi.spyOn(f.registry, "startSignIn").mockRejectedValue(new LoginBusyError());
    expect(await request(f, "POST", `/api/accounts/${account.id}/sign-in`)).toMatchObject({ status: 409, body: { code: "login-busy" } });
    const refused = await request(f, "POST", "/api/accounts", { of: "nope" });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    expect(refused.body.code).toBeUndefined();
  });

  it("logs sign-in validation, settings, unknown engine and server refusals once", async () => {
    const f = await fixture();
    const account = await f.add();
    const path = `/api/instances/${account.id}/sign-in`;
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await request(f, "POST", path, { device: "fixture" })).status).toBe(400);
    f.busy(true);
    expect((await request(f, "POST", path)).status).toBe(409);
    f.busy(false);
    const start = vi.spyOn(f.registry, "startSignIn");
    start.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("private-fixture-token"));
    expect((await request(f, "POST", path)).status).toBe(404);
    expect((await request(f, "POST", path)).status).toBe(500);
    expect(log.mock.calls).toEqual([
      ["sign-in refused code=http-400 status=400 reason=-"],
      ["sign-in refused code=provider-config-busy status=409 reason=-"],
      ["sign-in refused code=unknown-engine-sign-in status=404 reason=-"],
      ["sign-in refused code=http-500 status=500 reason=-"],
    ]);
  });

  it("leaves the sign-out mark alone during a sign-in or for a stopped account", async () => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    f.state("pending");
    await f.controller.signedOut?.(account.id);
    await f.controller.signedOut?.("claude");
    expect(f.registry.accountBlocked(account.id)).toBe(false);
    expect(f.registry.accountBlocked("claude")).toBe(false);
    f.state("complete");
    await f.accounts.stop(account.id);
    f.changed.mockClear();
    await f.controller.signedOut?.(account.id);
    expect(f.registry.accountBlocked(account.id)).toBe(false);
    expect(f.changed).not.toHaveBeenCalled();
    await f.controller.signedOut?.("claude");
    expect(f.registry.accountBlocked("claude")).toBe(true);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith();
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it("marks a base account only once until sign-in clears it", async () => {
    const f = await fixture();
    await f.controller.signedOut("claude");
    await f.controller.signedOut("claude");
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.registry.accountAvailable("claude")).toBe(false);
    await f.controller.signIn("claude", false, "pc:");
    await f.controller.settled("claude");
    expect(f.registry.accountAvailable("claude")).toBe(true);
  });

  it("persists the sign-in recovery row before marking and catches a rejected mark", async () => {
    const ts = await import("typescript");
    const { runtimeErrorTool } = await import("./chat-error.ts");
    const { refreshCodexPromo } = await import("./codex-promo.ts");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const branch = source.split('case "runtime.error":')[1].split('case "thread.token-usage.updated":')[0];
    const javascript = ts.transpileModule(`switch (event.type) { case "runtime.error": ${branch} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    const order: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const signedOut = vi.fn(async () => { order.push("mark"); throw new Error("fixture"); });
    const event = { type: "runtime.error", message: "Claude is not signed in.", setup: true, signIn: true, signedOut: true, providerInstanceId: "account" };
    const run = new Function("event", "unreadTurns", "store", "pushMessage", "bot", "runtimeErrorTool", "accounts", "accountRuntime", "INCOMPLETE_LOG_MESSAGE", "refreshCodexPromo", "usageBoard", javascript);
    let row: { tool: ReturnType<typeof runtimeErrorTool> } | undefined;
    run(event, { start() {} }, { messagesFor: () => [], rowMark: () => ({ count: 0 }) }, (value: typeof row) => { order.push("row"); row = value; }, null, runtimeErrorTool, new Map([["account", {}]]), { signedOut }, "incomplete fixture", refreshCodexPromo, { touch() {} });
    await Promise.resolve();
    expect(order).toEqual(["row", "mark"]);
    expect(row?.tool).toMatchObject({ signIn: true, accountId: "account" });
    expect(error).toHaveBeenCalledExactlyOnceWith("Signed-out account could not be saved");
  });

  it("does not stop an account when sign-in starts ahead of the queued mark", async () => {
    const f = await fixture();
    const account = await f.add();
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    const signingIn = f.controller.signIn(account.id, false, "pc:");
    const marked = f.controller.signedOut(account.id);
    await signingIn;
    await marked;
    expect(f.accounts.get(account.id)?.state).toBe("ready");
    release();
    await f.controller.settled(account.id);
    expect(f.registry.accountAvailable(account.id)).toBe(true);
  });

  it.each(["base", "added"])("guards a signed-out %s account against active and unknown worker runs", async (kind) => {
    const f = await fixture(vi.fn());
    const account = await f.add();
    const id = kind === "base" ? "claude" : account.id;
    const fetch = vi.mocked(globalThis.fetch);
    await f.controller.signedOut(id);
    const start = vi.spyOn(f.registry, "startSignIn");
    for (const state of ["busy", "starting", "unknown"] as const) {
      fetch.mockImplementation(async (url) => String(url).includes("account-runs")
        ? state === "unknown" ? Response.json({}, { status: 404 }) : Response.json({ runs: [{ botId: "fixture", paneId: "fixture", label: null, engine: "claude", accountId: id, accountGeneration: kind === "base" ? 0 : account.generation, state }] })
        : Response.json({ count: 1, unknown: 0, generations: { "0": 1 } }));
      await expect(f.controller.signIn(id, false, "pc:")).rejects.toMatchObject({ code: state === "unknown" ? "host-unknown" : "account-busy" });
      expect(start).not.toHaveBeenCalled();
      expect(f.registry.accountBlocked(id)).toBe(true);
    }
    fetch.mockImplementation(async (url) => String(url).includes("account-runs")
      ? Response.json({ runs: [{ botId: "fixture", paneId: "fixture", label: null, engine: "claude", accountId: id, accountGeneration: kind === "base" ? 0 : account.generation, state: "idle" }] })
      : Response.json({ count: 1, unknown: 0, generations: { "0": 1 } }));
    await expect(f.controller.signIn(id, false, "pc:")).resolves.toBeDefined();
    await f.controller.settled(id);
    expect(f.registry.accountAvailable(id)).toBe(true);
  });

  it("omits stale live account rows during reload without spinning", async () => {
    const f = await fixture();
    const account = await f.add();
    await f.registry.describe();
    const registry = f.registry as unknown as { currentAccountRows(rows: unknown[]): Promise<unknown[]>; row(entry: unknown, probe: unknown): unknown; byId: Map<string, unknown>; probed: Map<string, unknown>; accounts: Map<string, typeof account> };
    const row = registry.row(registry.byId.get(account.id), registry.probed.get(account.id));
    registry.accounts.set(account.id, { ...account, generation: account.generation + 1 });
    const original = registry.accounts.get.bind(registry.accounts);
    const get = vi.spyOn(registry.accounts, "get");
    let reads = 0;
    get.mockImplementation((id) => {
      if (++reads > 10) throw new Error("stale row loop did not yield");
      return original(id);
    });
    await expect(registry.currentAccountRows([row])).resolves.toEqual([]);
  });

  it("publishes accepted and removed accounts after their rows are ready", async () => {
    const f = await fixture();
    const added = await f.add();
    expect(f.changed).toHaveBeenCalledWith(added.id);
    expect(f.registry.accountAvailable(added.id)).toBe(true);
    f.changed.mockClear();
    await f.controller.remove(added.id);
    expect(f.changed).toHaveBeenCalled();
    expect(f.registry.get(added.id)).toBeNull();
  });

  it("replaces a stale rescan row after login changes its generation", async () => {
    const f = await fixture();
    const added = await f.add();
    const instance = f.registry.get(added.id)!;
    const snapshot = vi.spyOn(instance, "snapshot").mockResolvedValueOnce({ state: "available", authenticated: true, accountIdentity: "changed", account: "current@example.test" });
    f.statuses.set(added.id, { state: "available", authenticated: true, accountIdentity: "changed", account: "current@example.test" });
    const rows = await f.registry.describe({ rescan: true });
    expect(snapshot).toHaveBeenCalled();
    expect(rows.find((row) => row.instanceId === added.id)).toMatchObject({
      accountGeneration: added.generation + 1, snapshot: { authenticated: true, account: "current@example.test" },
    });
  });

  it("backs off unknown probes from one second to a sixty-second cap", async () => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.statuses.set(account.id, { state: "unavailable" });
    const retry = vi.spyOn(f.registry, "retryAccount");
    await f.controller.observe(account.id, { state: "unavailable" });
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(retry).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(retry).toHaveBeenCalledTimes(index + 1);
      expect(f.accounts.get(account.id)).toEqual(account);
      expect(f.registry.accountBlocked(account.id)).toBe(true);
    }
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it("clears a known answer's retry and restarts the next unknown at one second", async () => {
    const f = await fixture();
    const account = await f.add();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.statuses.set(account.id, { state: "unavailable" });
    const retry = vi.spyOn(f.registry, "retryAccount");
    await f.controller.observe(account.id, { state: "unavailable" });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(retry).toHaveBeenCalledTimes(1);
    await f.controller.observe(account.id, { state: "available", authenticated: true, accountIdentity: account.identity });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.registry.accountBlocked(account.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
    await f.controller.observe(account.id, { state: "unavailable" });
    await vi.advanceTimersByTimeAsync(999);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(f.accounts.get(account.id)).toEqual(account);
  });

  it("clears an outstanding retry when re-login confirms the identity", async () => {
    const f = await fixture();
    const account = await f.add();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await f.controller.observe(account.id, { state: "unavailable" });
    await f.controller.signIn(account.id, false, "pc:");
    await f.controller.settled(account.id);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.registry.accountAvailable(account.id)).toBe(true);
  });

  it.each(["restore", "observe", "probe", "crash", "empty status", "missing identity"])("retries an unknown %s without stopping or invalidating the account", async (path) => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unknown: ProviderSnapshot = path === "missing identity" ? { state: "available", authenticated: true } : { state: path === "empty status" ? "available" : "unavailable" };
    f.statuses.set(account.id, unknown);
    if (path === "restore") await f.controller.restore();
    else if (path === "probe" || path === "crash") {
      if (path === "crash") vi.spyOn(f.registry.get(account.id)!, "snapshot").mockRejectedValueOnce(new Error("fixture app-server crashed"));
      await f.registry.describe({ refresh: true });
    } else await f.controller.observe(account.id, unknown);
    expect(f.accounts.get(account.id)).toEqual(account);
    expect(f.invalidate).not.toHaveBeenCalled();
    f.statuses.set(account.id, { state: "available", authenticated: true, accountIdentity: account.identity });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.accounts.get(account.id)).toEqual(account);
    expect(f.registry.accountAvailable(account.id)).toBe(true);
    expect(f.providers.started("retried", account.id)).not.toBeNull();
    f.providers.settled("retried");
    expect(f.invalidate).not.toHaveBeenCalled();
    f.references.add(account.id);
    f.statuses.set(account.id, { state: "available", authenticated: false });
    if (path === "restore") await f.controller.restore();
    else await f.controller.observe(account.id, f.statuses.get(account.id)!);
    expect(f.accounts.get(account.id)?.state).toBe("stopped");
    expect(f.registry.accountAvailable(account.id)).toBe(false);
  });

  it("reads a restoring account as checking, and signed out only once its check says so", async () => {
    const f = await fixture();
    const account = await f.add();
    let answer!: (snapshot: ProviderSnapshot) => void;
    vi.spyOn(f.registry.get(account.id)!, "snapshot").mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const restored = f.controller.restore();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    expect(f.registry.accountAvailable(account.id)).toBe(false);
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot.state).toBe("checking");
    expect((await request(f, "GET", "/api/accounts")).body.accounts.find((row: { id: string }) => row.id === account.id)?.state).toBe("ready");
    answer({ state: "available", authenticated: false, accountAuthenticated: false });
    await restored;
    expect((await request(f, "GET", "/api/accounts")).body.accounts.find((row: { id: string }) => row.id === account.id)).toMatchObject({
      state: "stopped", snapshot: { state: "available", authenticated: false },
    });
    expect(f.registry.accountAvailable(account.id)).toBe(false);
  });

  it.each([true, false])("keeps a cached read from verifying an account ahead of restore (deferred at boot: %s)", async (deferAccountAuth) => {
    const f = await fixture();
    const account = await f.add();
    await f.registry.load(f.configs(), { deferAccountAuth });
    let resolveStale!: (snapshot: ProviderSnapshot) => void;
    let resolveFresh!: (snapshot: ProviderSnapshot) => void;
    const stale = new Promise<ProviderSnapshot>((resolve) => { resolveStale = resolve; });
    const fresh = new Promise<ProviderSnapshot>((resolve) => { resolveFresh = resolve; });
    const snapshot = vi.spyOn(f.registry.get(account.id)!, "snapshot").mockImplementation(
      (opts) => opts?.refresh ? fresh : stale,
    );
    const publish = vi.fn();
    const checks = createInstanceChecks(f.registry, publish);
    await checks.describe();
    await new Promise(setImmediate);
    const early = snapshot.mock.calls.length;
    const restore = f.controller.restore();
    try {
      resolveStale({ state: "available", authenticated: true, accountIdentity: account.identity, account: "old@example.test" });
      await new Promise(setImmediate);
      expect((await checks.describe()).find((row) => row.instanceId === account.id)?.snapshot).toEqual({ state: "checking" });
      expect(f.registry.accountAvailable(account.id)).toBe(false);
      expect(early).toBe(deferAccountAuth ? 0 : 1);
    } finally {
      resolveFresh({ state: "available", authenticated: true, accountIdentity: account.identity, account: "current@example.test" });
      await restore;
    }
    expect(snapshot).toHaveBeenCalledTimes(deferAccountAuth ? 1 : 2);
    expect((await checks.describe()).find((row) => row.instanceId === account.id)?.snapshot.account).toBe("current@example.test");
  });

  it("publishes a restore check's answer at once and never shows an earlier probe while checking", async () => {
    const f = await fixture();
    const account = await f.add();
    const landed = vi.fn();
    f.registry.onProbed(landed);
    await f.registry.describe({ refresh: true });
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot.state).toBe("available");
    let answer!: (snapshot: ProviderSnapshot) => void;
    vi.spyOn(f.registry.get(account.id)!, "snapshot").mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const restored = f.controller.restore();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot.state).toBe("checking");
    landed.mockClear();
    answer({ state: "available", authenticated: true, accountIdentity: account.identity, account: "restored@example.test" });
    await restored;
    expect(landed).toHaveBeenCalledWith(account.id);
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot).toMatchObject({ authenticated: true, account: "restored@example.test" });
  });

  it.each([3_000, 0])("offers sign-in after an unanswered restore check (%i ms) while keeping sends blocked", async (deadline) => {
    const f = await fixture();
    const account = await f.add();
    await f.registry.describe();
    f.statuses.set(account.id, { state: "available" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    if (deadline) vi.spyOn(f.registry.get(account.id)!, "snapshot").mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ state: "available" }), deadline)),
    );
    const restored = f.controller.restore();
    if (deadline) {
      expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot).toEqual({ state: "checking" });
      await vi.advanceTimersByTimeAsync(deadline);
    }
    await restored;
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot).toEqual({ state: "available", authChecked: true });
    expect(f.registry.accountAvailable(account.id)).toBe(false);
    expect(f.providers.started("unverified", account.id)).toBeNull();
    expect(f.accounts.get(account.id)).toEqual(account);

    f.start.mockRejectedValueOnce(new Error("fixture login failed to start"));
    await expect(f.controller.signIn(account.id, false, "pc:")).rejects.toThrow("fixture login failed to start");
    expect(f.registry.accountAvailable(account.id)).toBe(false);

    f.changed.mockClear();
    f.statuses.set(account.id, { state: "available", authenticated: true, accountIdentity: account.identity });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.registry.accountAvailable(account.id)).toBe(true);
    expect(f.changed).toHaveBeenCalledOnce();
  });

  it("shows an unavailable restore check while it retries", async () => {
    const f = await fixture();
    const account = await f.add();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(f.registry.get(account.id)!, "snapshot").mockRejectedValueOnce(new Error("fixture CLI crashed"));
    await f.controller.restore();
    expect(f.registry.accountAvailable(account.id)).toBe(false);
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot.state).toBe("unavailable");
  });

  it.each([{ refresh: true }, { rescan: true }])("keeps a failed restore from showing an earlier sign-in during an explicit %j", async (options) => {
    const f = await fixture();
    const account = await f.add();
    f.statuses.set(account.id, { state: "available", authenticated: true, accountIdentity: account.identity, account: "old@example.test" });
    expect((await f.registry.describeCached()).find((row) => row.instanceId === account.id)?.snapshot.account).toBe("old@example.test");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.statuses.set(account.id, { state: "available" });
    await f.controller.restore();
    expect((await f.registry.describe(options)).find((row) => row.instanceId === account.id)?.snapshot).toEqual({ state: "available", authChecked: true });
    expect(f.registry.accountAvailable(account.id)).toBe(false);
  });

  it("retries a thrown restore probe without changing the account", async () => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(f.registry.get(account.id)!, "snapshot").mockRejectedValueOnce(new Error("fixture timeout"));
    await f.controller.restore();
    expect(f.accounts.get(account.id)).toEqual(account);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.registry.accountAvailable(account.id)).toBe(true);
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it("keeps a sign-out confirmed by a restore retry visible after reloading the stopped account", async () => {
    const f = await fixture();
    const account = await f.add();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(f.registry.get(account.id)!, "snapshot").mockRejectedValueOnce(new Error("fixture timeout"));
    f.statuses.set(account.id, { state: "available", authenticated: false });
    await f.controller.restore();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await request(f, "GET", "/api/accounts")).body.accounts.find((row: { id: string }) => row.id === account.id)).toMatchObject({
      state: "stopped", snapshot: { state: "available", authenticated: false },
    });
    expect(f.registry.accountAvailable(account.id)).toBe(false);
  });

  it.each(["observe", "restore", "refresh", "observe while a pane uses it"])("keeps a signed-out account's identity, generation and sessions after a %s read, and the other accounts as they were", async (path) => {
    const f = await fixture();
    const added = [await f.add(), await f.add(), await f.add(), await f.add()];
    const [account] = added;
    expect(account.identity).toBeTruthy();
    f.invalidate.mockClear();
    if (path.includes("pane")) f.references.add(account.id);
    f.statuses.set(account.id, { state: "available", authenticated: false });
    if (path === "restore") await f.controller.restore();
    else if (path === "refresh") await f.registry.describe({ refresh: true });
    else await f.controller.observe(account.id, f.statuses.get(account.id)!);
    expect(f.accounts.get(account.id)).toEqual({ ...account, state: "stopped" });
    expect(f.registry.accountAvailable(account.id)).toBe(false);
    expect(f.invalidate).not.toHaveBeenCalled();
    for (const other of added.slice(1)) expect(f.accounts.get(other.id)).toEqual(other);
  });

  it("keeps showing the address a signed-out account was signed in as", async () => {
    const f = await fixture();
    const account = await f.add();
    f.statuses.set(account.id, { state: "available", authenticated: true, accountIdentity: account.identity, account: "fixture@example.test" });
    await f.registry.describe({ refresh: true });
    f.statuses.set(account.id, { state: "available", authenticated: false });
    await f.registry.describe({ refresh: true });
    expect((await f.registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot).toMatchObject({ authenticated: false, account: "fixture@example.test" });
  });

  it("keeps a login's identity on the PC that reads it signed out, leaving the other PC's accounts file as it was", async () => {
    const pcs = [await fixture(), await fixture()];
    const [, work] = [await pcs[0].add(), await pcs[1].add()];
    const other = readFileSync(join(pcs[0].dir, "accounts.json"), "utf8");
    pcs[1].invalidate.mockClear();
    pcs[1].statuses.set(work.id, { state: "available", authenticated: false });
    await pcs[1].controller.observe(work.id, pcs[1].statuses.get(work.id)!);
    expect(pcs[1].accounts.get(work.id)).toEqual({ ...work, state: "stopped" });
    expect(pcs[1].invalidate).not.toHaveBeenCalled();
    expect(readFileSync(join(pcs[0].dir, "accounts.json"), "utf8")).toBe(other);
  });

  it("offers the normal Sign In on an account stopped before a restart", async () => {
    const f = await fixture();
    const account = await f.add();
    f.statuses.set(account.id, { state: "available", authenticated: false });
    await f.controller.observe(account.id, f.statuses.get(account.id)!);
    const bases = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" } };
    const accounts = new core!.AccountService(f.dir, () => bases);
    const registry = new ProviderRegistry(f.drivers);
    registries.push(registry);
    await registry.load(instanceConfigs({ instances: bases }, accounts.snapshot));
    controllers.push(new lifecycle!.AccountLifecycle(accounts, registry, {
      reload: async () => {}, referenced: async () => false, invalidate: vi.fn(), changed: vi.fn(), configBusy: () => false,
    }));
    expect(accounts.get(account.id)).toEqual({ ...account, state: "stopped" });
    // Settled as signed out, the row shows Sign In; unsettled, it waits on a check a stopped account never runs.
    expect((await registry.describeKnown()).find((row) => row.instanceId === account.id)?.snapshot).toEqual({ state: "unavailable", authChecked: true });
  });

  it("keeps the prior identity when a re-login probe is unknown", async () => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.statuses.set(account.id, { state: "available" });
    await f.controller.signIn(account.id, false, "pc:");
    await f.controller.settled(account.id);
    expect(f.accounts.get(account.id)).toEqual(account);
    expect(f.invalidate).not.toHaveBeenCalled();
    f.statuses.set(account.id, { state: "available", authenticated: true, accountIdentity: account.identity });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.registry.accountAvailable(account.id)).toBe(true);
  });

  it("adds and probes in that home after the engine's own login", async () => {
    const f = await fixture();
    const account = await f.add();
    expect(account.state).toBe("ready");
    expect(account.generation).toBe(2);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start.mock.calls[0][0]).toBe(account.id);
    expect(f.start.mock.calls[0][3]?.CLAUDE_CONFIG_DIR).toBe(account.home);
    expect(f.start.mock.calls[0][3]?.OPENAI_API_KEY).toBeUndefined();
    expect(f.registry.get(account.id)?.account?.generation).toBe(account.generation);
  });

  it.each(["failed", "cancelled"] as const)("drops a new account after %s without logging out another account", async (state) => {
    const f = await fixture();
    f.state(state);
    const added = await f.controller.add("codex", false, "pc:");
    await f.controller.settled(added.id);
    expect(f.accounts.get(added.id)).toBeUndefined();
    expect(f.start.mock.calls.map((call) => call[2])).toEqual([["login"]]);
    f.state("complete");
    expect((await f.add("codex")).id).not.toBe(added.id);
  });

  it("checks references before invoking logout", async () => {
    const f = await fixture();
    const account = await f.add();
    f.references.add(account.id);
    f.start.mockClear();
    await expect(f.controller.remove(account.id)).rejects.toThrow("still used");
    expect(f.accounts.get(account.id)).toBeDefined();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("logs out exactly once, retires the account and keeps its home", async () => {
    const f = await fixture();
    const account = await f.add();
    const sibling = await f.add();
    f.start.mockClear();
    await f.controller.remove(account.id);
    expect(f.start.mock.calls.map((call) => [call[0], call[2]])).toEqual([[account.id, ["logout"]]]);
    expect(f.accounts.get(account.id)).toBeUndefined();
    expect(f.accounts.get(sibling.id)).toEqual(sibling);
    expect(f.registry.get(account.id)).toBeNull();
    expect(JSON.parse(readFileSync(join(f.dir, "accounts.json"), "utf8")).retired).toContain(account.id);
  });

  it("keeps a failed logout stopped without retries from polling", async () => {
    const f = await fixture();
    const account = await f.add();
    f.start.mockClear();
    f.failLogout();
    await expect(f.controller.remove(account.id)).rejects.toThrow("stopped");
    await f.registry.describeCached();
    await f.registry.describeCached();
    expect(f.accounts.get(account.id)?.state).toBe("stopped");
    expect(f.registry.accountBlocked(account.id)).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("signs out the existing sign-in without retiring it", async () => {
    const f = await fixture();
    await f.controller.remove("claude");
    expect(f.accounts.list().find((row) => row.id === "claude")?.existing).toBe(true);
    expect(f.registry.get("claude")).not.toBeNull();
  });

  it("changes only the observed account's generation and caches", async () => {
    const f = await fixture();
    const account = await f.add();
    const sibling = await f.add();
    f.invalidate.mockClear();
    await f.controller.observe(account.id, { state: "available", authenticated: true, accountIdentity: "new-identity" });
    expect(f.accounts.get(account.id)?.generation).toBe(account.generation + 1);
    expect(f.accounts.get(sibling.id)).toEqual(sibling);
    expect(f.invalidate.mock.calls).toEqual([[account.id]]);
    const generation = f.accounts.get(account.id)!.generation;
    f.invalidate.mockClear();
    await f.controller.observe(account.id, { state: "available", authenticated: true, accountIdentity: "new-identity" });
    expect(f.accounts.get(account.id)?.generation).toBe(generation);
    expect(f.invalidate).not.toHaveBeenCalled();
    await f.controller.observe(account.id, { state: "available", authenticated: true, accountIdentity: account.identity }, account.generation);
    expect(f.accounts.get(account.id)?.generation).toBe(generation);
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it("holds new launches during login without restarting from probe polling", async () => {
    const f = await fixture();
    let finish!: () => void;
    f.wait(new Promise((resolve) => { finish = resolve; }));
    const added = await f.controller.add("claude", false, "pc:");
    await f.registry.describeCached();
    await f.registry.describeCached();
    expect(f.providers.started("thread", added.id)).toBeNull();
    expect(f.start).toHaveBeenCalledTimes(1);
    finish();
    await f.controller.settled(added.id);
    expect(f.providers.started("thread", added.id)).not.toBeNull();
    f.providers.settled("thread");
  });

  it("refuses account mutations while provider settings are changing", async () => {
    const f = await fixture();
    f.busy(true);
    await expect(f.controller.add("claude", false, "pc:")).rejects.toThrow("Provider settings");
    expect(f.accounts.snapshot).toHaveLength(0);
  });

  it("does not restart a first login left pending across a restart", async () => {
    const f = await fixture();
    const pending = await f.accounts.add("claude");
    await f.controller.restore();
    expect(f.accounts.get(pending.id)).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("keeps a confirmed same-generation account usable after restore", async () => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    await f.controller.restore();
    expect(f.accounts.get(account.id)?.generation).toBe(account.generation);
    expect(f.registry.accountBlocked(account.id)).toBe(false);
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it("treats an explicit re-login as a fresh provider context even with the same email", async () => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    await f.controller.signIn(account.id, false, "pc:");
    await f.controller.settled(account.id);
    expect(f.accounts.get(account.id)?.generation).toBe(account.generation + 1);
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith(account.id);
  });

  it("retains a sanitized cap result after a failed new account disappears", async () => {
    const f = await fixture();
    f.state("failed");
    vi.spyOn(f.registry.logins, "capture").mockReturnValue({ error: "device_cap" });
    const added = await f.controller.add("codex", false, "pc:");
    await f.controller.settled(added.id);
    expect(f.accounts.get(added.id)).toBeUndefined();
    expect((await request(f, "GET", `/api/accounts/${added.id}/sign-in`)).body).toEqual({ state: "failed", error: "device_cap" });
  });

  it("keeps account state out of config and unrelated local files", async () => {
    const f = await fixture();
    const file = join(f.dir, "profile-sync.json");
    writeFileSync(file, '{"fixture":"unchanged"}');
    await f.add();
    expect(readFileSync(file, "utf8")).toBe('{"fixture":"unchanged"}');
  });
});

async function request(f: Pick<Awaited<ReturnType<typeof fixture>>, "controller" | "registry">, method: string, path: string, value: unknown = {}, contentType = "application/json") {
  expect(routes, "account routes exist").not.toBeNull();
  const req = Object.assign(Readable.from([JSON.stringify(value)]), { headers: { "content-type": contentType } }) as unknown as IncomingMessage;
  let status = 0;
  let output = "";
  const res = { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = body; } } as unknown as ServerResponse;
  const handled = await routes!.createAccountRoutes(f.controller, f.registry)(req, res, method, path, "pc:");
  return { handled, status, body: output ? JSON.parse(output) : undefined };
}

describe("Main changes", () => {
  const main = (id: string, generation = 0) => ({ id, generation });

  it("reports a committed Main change when the following reload fails", async () => {
    const hook = vi.fn();
    const f = await fixture(hook);
    const first = await f.add();
    const second = await f.add();
    await f.controller.useForBots(first.id);
    hook.mockClear();
    vi.spyOn(f.providers, "reload").mockRejectedValueOnce(new Error("fixture reload failure"));
    await expect(f.controller.remove(first.id, second.id)).rejects.toThrow("fixture reload failure");
    expect(f.accounts.defaultFor("claude")).toBe(second.id);
    expect(f.accounts.drains[first.id]).toBeUndefined();
    expect(hook.mock.calls.map(([change]) => [change.from, change.to])).toEqual([
      [main(first.id, first.generation), main(second.id, second.generation)],
    ]);
    await f.controller.resumeDrains();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("calls the Main hook once after a committed Main change", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hook = vi.fn(() => { throw new Error("fixture hook failure"); });
    const f = await fixture(hook);
    const account = await f.add();
    expect(hook).not.toHaveBeenCalled();
    await expect(f.controller.useForBots(account.id)).resolves.toEqual({});
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ base: "claude", engine: "claude", from: main("claude"), to: main(account.id, account.generation), seq: expect.any(Number) });
    expect(f.accounts.defaultFor("claude")).toBe(account.id);
  });

  it("calls it for return to base and a sign-out destination", async () => {
    const hook = vi.fn();
    const f = await fixture(hook);
    const first = await f.add("codex");
    const second = await f.add("codex");
    await f.controller.useForBots(first.id);
    await f.controller.useForBots("codex");
    await f.controller.useForBots(first.id);
    await expect(f.controller.remove(first.id, second.id)).resolves.toEqual({ state: "removed", destinationId: second.id });
    expect(hook.mock.calls.map(([change]) => [change.engine, change.from, change.to])).toEqual([
      ["codex", main("codex"), main(first.id, first.generation)],
      ["codex", main(first.id, first.generation), main("codex")],
      ["codex", main("codex"), main(first.id, first.generation)],
      ["codex", main(first.id, first.generation), main(second.id, second.generation)],
    ]);
  });

  it("does not call it on a failed or no-op change", async () => {
    const hook = vi.fn();
    const f = await fixture(hook);
    const account = await f.add();
    await f.controller.useForBots(account.id);
    expect(hook).toHaveBeenCalledTimes(1);
    await f.controller.useForBots(account.id);
    await f.controller.useForBots("codex");
    await expect(f.controller.useForBots("acct_00000000-0000-4000-8000-000000000000")).rejects.toThrow("Unknown account");
    f.registry.blockAccount("claude", true);
    await expect(f.controller.useForBots("claude")).rejects.toThrow("unavailable");
    f.registry.blockAccount("claude", false);
    f.busy(true);
    await expect(f.controller.useForBots("claude")).rejects.toThrow("Provider settings");
    f.busy(false);
    await expect(f.controller.remove(account.id)).rejects.toThrow("still used");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(f.accounts.defaultFor("claude")).toBe(account.id);
  });

  it("reports A-B-A as three committed changes in order", async () => {
    const hook = vi.fn();
    const f = await fixture(hook);
    const a = await f.add();
    const b = await f.add();
    for (const id of [a.id, b.id, a.id]) await f.controller.useForBots(id);
    expect(hook.mock.calls.map(([change]) => [change.from.id, change.to.id])).toEqual([["claude", a.id], [a.id, b.id], [b.id, a.id]]);
    const seqs = hook.mock.calls.map(([change]) => change.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(3);
  });

  it("drains instead of removing the old Main while a resolved turn starts", async () => {
    const hook = vi.fn();
    const f = await fixture(hook);
    const account = await f.add();
    await f.controller.useForBots(account.id);
    hook.mockClear();
    const release = f.holdStarting?.(account.id, account.generation);
    await expect(f.controller.remove(account.id, "claude")).resolves.toEqual({ state: "draining", destinationId: "claude" });
    expect(f.accounts.get(account.id)).toBeDefined();
    expect(hook).not.toHaveBeenCalled();
    release?.();
    release?.();
    await f.controller.resumeDrains();
    expect(f.accounts.get(account.id)).toBeUndefined();
    expect(hook.mock.calls.map(([change]) => [change.from, change.to])).toEqual([[main(account.id, account.generation), main("claude")]]);
  });
});

describe("account HTTP routes", () => {
  it("adds, lists and signs out through thin routes", async () => {
    const f = await fixture();
    const added = await request(f, "POST", "/api/accounts", { of: "claude" });
    expect(added.status).toBe(200);
    await f.controller.settled(added.body.id);
    const listed = await request(f, "GET", "/api/accounts");
    expect(listed.body.accounts.filter((row: { of: string }) => row.of === "claude")).toHaveLength(2);
    expect((await request(f, "POST", `/api/accounts/${added.body.id}/sign-out`)).status).toBe(200);
    expect(f.accounts.get(added.body.id)).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "a%2fb", "a%00b", "a".repeat(129)])("validates id %s on all account actions", async (id) => {
    const f = await fixture();
    for (const action of ["sign-in", "sign-out"]) expect((await request(f, "POST", `/api/accounts/${id}/${action}`)).status).toBe(400);
    expect((await request(f, "DELETE", `/api/accounts/${id}`)).status).toBe(400);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies and unsupported bases before spawning", async () => {
    const f = await fixture();
    expect((await request(f, "POST", "/api/accounts", { of: "grok" })).status).toBe(400);
    expect((await request(f, "POST", "/api/accounts", { of: "claude", device: "yes" })).status).toBe(400);
    expect((await request(f, "POST", "/api/accounts", { of: "claude" }, "text/plain")).status).toBe(415);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("uses the same removal guard for legacy managed-instance sign-out", async () => {
    const f = await fixture();
    const added = await f.add();
    f.references.add(added.id);
    expect((await request(f, "POST", `/api/instances/${added.id}/sign-out`)).status).toBe(409);
  });
});

describe("base sign-out beside added accounts", () => {
  it("reads the signed-out base as signed out, never as not installed", async () => {
    const f = await fixture();
    await f.add();
    f.invalidate.mockImplementation((id: string) => f.registry.invalidateAccount(id));
    await f.controller.remove("claude");
    expect(f.invalidate).toHaveBeenCalledWith("claude");
    expect(f.registry.accountStopped("claude")).toBe(true);
    for (const rows of [await f.registry.describeKnown(), await f.registry.describeCached()]) {
      expect(rows.find((row) => row.instanceId === "claude")!.snapshot).toMatchObject({ state: "available", authenticated: false });
    }
  });

  it("reads a signed-out Main base as signed out after a hand-over and keeps the saved account", async () => {
    const f = await fixture(vi.fn());
    const account = await f.add();
    expect(f.accounts.defaultFor("claude") ?? "claude").toBe("claude");
    await expect(f.controller.remove("claude", account.id)).resolves.toEqual({ state: "removed", destinationId: account.id });
    expect(f.registry.accountStopped("claude")).toBe(true);
    for (const rows of [await f.registry.describeKnown(), await f.registry.describeCached()]) {
      expect(rows.find((row) => row.instanceId === "claude")!.snapshot).toMatchObject({ state: "available", authenticated: false });
    }
    expect(f.accounts.list().filter((row) => row.of === "claude").map((row) => row.id)).toEqual(["claude", account.id]);
    expect(f.accounts.get(account.id)?.state).toBe("ready");
  });
});

describe("a user Sign Out removes the account from Usage and Connections", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  // What Usage lists for this engine and what Connections hides, built the way the server builds them.
  async function listed(f: Fixture, base: string, accounts = f.accounts) {
    const status = new Map((await f.registry.describeCached()).map((row) => [row.instanceId, row.snapshot]));
    const board = createUsageBoard({
      accounts: { list: () => accounts.list().map((row) => {
        const snapshot = status.get(row.id);
        return { ...row, blocked: f.registry.accountStopped(row.id), checking: f.registry.accountChecking(row.id),
          status: snapshot && { state: snapshot.state === "available" ? "available" as const : "unavailable" as const, authenticated: snapshot.authenticated, account: snapshot.account, accountIdentity: snapshot.accountIdentity } };
      }), defaultFor: (of) => accounts.defaultFor(of), get drains() { return accounts.drains; } },
      names: { get: () => null }, rateLimits: new Map(), history: createUsageHistory(join(f.dir, "usage")),
      runs: async () => ({ known: true, runs: [] }), bots: () => [],
    });
    const engine = (await board.read()).engines.find((group) => group.base === base)!;
    const hidden = engine.duplicates ?? [];
    return { usage: engine.accounts.map((row) => row.id), connections: accounts.list().filter((row) => row.of === base && !hidden.includes(row.id)).map((row) => row.id),
      signIn: Object.fromEntries(engine.accounts.map((row) => [row.id, row.signIn])), mainId: engine.mainId };
  }

  it.each(["codex", "claude"])("takes a signed-out %s base off both lists, after a restart too, while another account is left", async (base) => {
    const f = await fixture(vi.fn());
    const added = await f.add(base);
    await f.controller.useForBots(added.id);
    await f.controller.remove(base);
    expect(await listed(f, base)).toMatchObject({ usage: [added.id], connections: [added.id], mainId: added.id });
    const restarted = new core!.AccountService(f.dir, () => f.bases);
    expect((await listed(f, base, restarted)).connections).toEqual([added.id]);
  });

  it.each(["codex", "claude"])("hands Main on and takes the %s base off both lists when Main signs out", async (base) => {
    const f = await fixture(vi.fn());
    const added = await f.add(base);
    await expect(f.controller.remove(base, added.id)).resolves.toEqual({ state: "removed", destinationId: added.id });
    expect(await listed(f, base)).toMatchObject({ usage: [added.id], connections: [added.id], mainId: added.id });
  });

  it.each(["codex", "claude"])("removes a signed-out added %s account as it always did", async (base) => {
    const f = await fixture(vi.fn());
    const first = await f.add(base);
    const second = await f.add(base);
    await f.controller.remove(second.id);
    expect(await listed(f, base)).toMatchObject({ usage: [base, first.id], connections: [base, first.id] });
  });

  it.each(["codex", "claude"])("keeps an expired %s base's row with Sign In", async (base) => {
    const f = await fixture(vi.fn());
    const added = await f.add(base);
    await f.controller.useForBots(added.id);
    f.statuses.set(base, { state: "available", authenticated: false });
    await f.controller.signedOut(base);
    expect(await listed(f, base)).toMatchObject({ usage: [base, added.id], connections: [base, added.id], signIn: { [base]: "signed-out" } });
  });

  it("keeps a lone base's signed-out row, the engine's own signed-out state", async () => {
    const f = await fixture(vi.fn());
    await f.controller.remove("codex");
    expect(await listed(f, "codex")).toMatchObject({ usage: ["codex"], connections: ["codex"], signIn: { codex: "signed-out" } });
  });

  it("lists the base again once it signs back in", async () => {
    const f = await fixture(vi.fn());
    const added = await f.add("codex");
    await f.controller.useForBots(added.id);
    await f.controller.remove("codex");
    f.statuses.delete("codex");
    await f.controller.signIn("codex", false, "pc:");
    await f.controller.settled("codex");
    expect(f.registry.accountAvailable("codex")).toBe(true);
    f.statuses.set("codex", { state: "available", authenticated: false });
    await f.controller.signedOut("codex");
    expect(await listed(f, "codex")).toMatchObject({ usage: ["codex", added.id], signIn: { codex: "signed-out" } });
  });
});

describe("code-flow sign-in over a browser-mode one", () => {
  it("restarts an added account's browser-mode sign-in in code mode and keeps the account", async () => {
    const f = await fixture();
    const account = await f.add();
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    f.state("pending");
    await f.controller.signIn(account.id, false, "pc:");
    expect(f.start.mock.calls.at(-1)?.[2]).toEqual(["login"]);
    vi.spyOn(f.registry.logins, "opensBrowser").mockReturnValue(true);
    await f.controller.signIn(account.id, true, "pc:");
    expect(f.start.mock.calls.at(-1)?.[2]).toEqual(["device"]);
    f.state("complete");
    release();
    await f.controller.settled(account.id);
    expect(f.accounts.get(account.id)?.state).toBe("ready");
  });

  it("joins an added account's code-flow sign-in", async () => {
    const f = await fixture();
    const account = await f.add();
    f.wait(new Promise<void>(() => {}));
    f.state("pending");
    await f.controller.signIn(account.id, true, "pc:");
    const starts = f.start.mock.calls.length;
    vi.spyOn(f.registry.logins, "joins").mockReturnValue(true);
    await f.controller.signIn(account.id, true, "pc:");
    expect(f.start.mock.calls).toHaveLength(starts);
  });
});

describe("a base sign-in that ends without signing in", () => {
  it.each(["cancelled", "failed"] as const)("unblocks the engine again once it is %s while an added account exists", async (end) => {
    const f = await fixture();
    await f.add();
    f.statuses.set("claude", { state: "available", authenticated: false });
    let release!: () => void;
    f.wait(new Promise<void>((done) => { release = done; }));
    f.state("pending");
    vi.spyOn(f.registry.logins, "generation").mockReturnValue(7);
    expect(f.registry.accountBlocked("claude")).toBe(false);
    await f.controller.signIn("claude", false, "pc:");
    expect(f.registry.accountBlocked("claude")).toBe(true);
    f.state(end);
    release();
    await f.controller.settled("claude");
    expect(f.registry.accountBlocked("claude")).toBe(false);
  });
});
