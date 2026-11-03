import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const core = await import("./accounts.ts").catch(() => null);
const lifecycle = await import("./account-lifecycle.ts").catch(() => null);
const routes = await import("./account-routes.ts").catch(() => null);
const registries: ProviderRegistry[] = [];
const controllers: InstanceType<NonNullable<typeof lifecycle>["AccountLifecycle"]>[] = [];
let next = 0;

afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture() {
  expect(core, "account service exists").not.toBeNull();
  expect(lifecycle, "account lifecycle exists").not.toBeNull();
  const dir = join(DATA_DIR, `lifecycle-${++next}`);
  mkdirSync(dir, { recursive: true });
  const bases = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" } };
  const accounts = new core!.AccountService(dir, () => bases);
  const statuses = new Map<string, ProviderSnapshot>();
  const drivers = ["claudeAgent", "codex"].map((kind) => {
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
  const controller = new lifecycle!.AccountLifecycle(accounts, registry, {
    reload: () => providers.reload(configs()),
    referenced: async (id) => references.has(id), invalidate, configBusy: () => configBusy,
  });
  controllers.push(controller);
  return { dir, accounts, registry, controller, references, invalidate, start, statuses, providers,
    busy: (value: boolean) => { configBusy = value; }, failLogout: () => { logoutFails = true; },
    state: (value: typeof state) => { state = value; }, wait: (value: Promise<void>) => { waiting = value; },
    add: async (of = "claude") => { const result = await controller.add(of); await controller.settled(result.id); return accounts.get(result.id)!; },
  };
}

describe("account lifecycle", () => {
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
    await f.controller.signIn(account.id);
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

  it("keeps the prior identity when a re-login probe is unknown", async () => {
    const f = await fixture();
    const account = await f.add();
    f.invalidate.mockClear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.statuses.set(account.id, { state: "available" });
    await f.controller.signIn(account.id);
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
    const added = await f.controller.add("codex");
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
    const added = await f.controller.add("claude");
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
    await expect(f.controller.add("claude")).rejects.toThrow("Provider settings");
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
    await f.controller.signIn(account.id);
    await f.controller.settled(account.id);
    expect(f.accounts.get(account.id)?.generation).toBe(account.generation + 1);
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith(account.id);
  });

  it("retains a sanitized cap result after a failed new account disappears", async () => {
    const f = await fixture();
    f.state("failed");
    vi.spyOn(f.registry.logins, "capture").mockReturnValue({ error: "device_cap" });
    const added = await f.controller.add("codex");
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

async function request(f: Awaited<ReturnType<typeof fixture>>, method: string, path: string, value: unknown = {}, contentType = "application/json") {
  expect(routes, "account routes exist").not.toBeNull();
  const req = Object.assign(Readable.from([JSON.stringify(value)]), { headers: { "content-type": contentType } }) as unknown as IncomingMessage;
  let status = 0;
  let output = "";
  const res = { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = body; } } as unknown as ServerResponse;
  const handled = await routes!.createAccountRoutes(f.controller, f.registry)(req, res, method, path);
  return { handled, status, body: output ? JSON.parse(output) : undefined };
}

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
