import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, instanceConfigs } from "./config.ts";
import { Store } from "./store.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { ProviderReload } from "./harness/provider-reload.ts";
import { EventBus } from "./harness/bus.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { createUsageRefresh } from "./usage-refresh.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";
import type { ProviderSnapshot } from "./contracts.ts";

const core = await import("./accounts.ts").catch(() => null);
const runtime = await import("./account-runtime.ts").catch(() => null);
const registries: ProviderRegistry[] = [];
const controllers: Array<{ dispose(): void }> = [];
let serial = 0;
afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture(kind = "codex", usage = createUsageRefresh()) {
  expect(core, "account service exists").not.toBeNull();
  expect(runtime, "account runtime exists").not.toBeNull();
  const root = join(DATA_DIR, `runtime-${++serial}`);
  mkdirSync(root, { recursive: true });
  const of = kind === "codex" ? "codex" : "claude";
  const bases = { [of]: { driver: kind } };
  const accounts = new core!.AccountService(root, () => bases);
  const added = await accounts.add(of);
  const account = await accounts.identify(added.id, "identity");
  const statuses = new Map<string, ProviderSnapshot>();
  const fake = makeFakeDriver({ kind }).driver;
  const create = fake.create;
  fake.create = async (input) => {
    const instance = await create(input);
    return { ...instance, account: input.account, snapshot: async () => statuses.get(input.instanceId) ?? instance.snapshot() };
  };
  const registry = new ProviderRegistry([fake]);
  registries.push(registry);
  const configs = () => instanceConfigs({ instances: bases }, accounts.snapshot);
  await registry.load(configs());
  const providers = new ProviderReload(registry, new EventBus(() => {}), configs());
  const store = new Store(() => ({ instanceId: of, model: `${kind}-1` }));
  const bot = store.createBot({ name: "Account fixture" });
  const logout = vi.spyOn(registry, "signOut").mockResolvedValue(true);
  const rateLimits: RateLimitsMap = new Map([[account.id, { observedAt: new Date().toISOString(), windows: [] }], ["codex", { observedAt: new Date().toISOString(), windows: [] }]]);
  const availability = new Map([[account.id, true], ["codex", true]]);
  const invalidate = vi.spyOn(usage, "invalidate");
  const waits = vi.fn();
  const request = vi.fn<typeof fetch>(async () => Response.json({ count: 0, unknown: 0, generations: {} }));
  vi.stubGlobal("fetch", request);
  const controller = runtime!.createAccountRuntime({
    accounts, registry, providers, store, reload: () => providers.reload(configs()), rateLimits, saveRateLimits: () => {}, usage, availability,
    invalidateWaits: waits, botActive: () => false,
    terminal: () => ({ url: "http://127.0.0.1:1", token: "fixture" }), configBusy: () => false,
  });
  controllers.push(controller);
  return { account, accounts, registry, providers, store, bot, logout, rateLimits, availability, invalidate, waits, request, controller, statuses, usage };
}

describe("account removal references", () => {
  it("accepts an idle identity change discovered by its completed usage RPC", async () => {
    const usage = createUsageRefresh({
      rpc: async () => ({ account: { type: "chatgpt", email: "changed@example.test" }, rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } } }),
      accountIdentity: async (account, identity) => f.controller.observe(account.id, { state: "available", authenticated: true, accountIdentity: identity }, account.generation),
    });
    const f = await fixture("codex", usage);
    await usage("codex", { instanceId: f.account.id, account: f.account });
    expect(f.accounts.get(f.account.id)).toMatchObject({ state: "ready", generation: f.account.generation + 1 });
    expect(f.registry.accountAvailable(f.account.id)).toBe(true);
  });

  it.each(["pane", "unknown", "unreachable"])("guards identity changes with %s account pane state", async (state) => {
    const f = await fixture();
    if (state === "pane") f.request.mockResolvedValue(Response.json({ count: 1, unknown: 0, generations: { [f.account.generation]: 1 } }));
    if (state === "unknown") f.request.mockResolvedValue(Response.json({ count: 0, unknown: 1, generations: {} }));
    if (state === "unreachable") f.request.mockRejectedValue(new Error("unreachable fixture"));
    const observed = f.controller.observe(f.account.id, { state: "available", authenticated: true, accountIdentity: "changed" }, f.account.generation);
    if (state === "pane") await observed;
    else await expect(observed).rejects.toThrow("Terminal host is unreachable");
    expect(f.accounts.get(f.account.id)).toEqual({ ...f.account, state: state === "pane" ? "stopped" : "ready" });
    expect(f.registry.accountBlocked(f.account.id)).toBe(true);
    expect(f.providers.started("worker", f.account.id)).toBeNull();
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.waits).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", false], ["unreachable", false], ["unknown", true], ["unreachable", true],
  ] as const)("restores with %s panes and authenticated %s, then retries until recovery", async (state, authenticated) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.statuses.set(f.account.id, { state: "available", authenticated, ...(authenticated ? { accountIdentity: "changed" } : {}) });
    if (state === "unknown") f.request.mockResolvedValue(Response.json({ count: 0, unknown: 1, generations: {} }));
    else f.request.mockRejectedValue(new Error("unreachable fixture"));
    const retry = vi.spyOn(f.registry, "retryAccount");
    await expect(f.controller.restore()).resolves.toBeUndefined();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(f.accounts.get(f.account.id)).toEqual(f.account);
      expect(f.registry.accountBlocked(f.account.id)).toBe(true);
      expect(f.providers.started("worker", f.account.id)).toBeNull();
      expect(f.invalidate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(retry).toHaveBeenCalledTimes(attempt + 1);
    }
    f.request.mockResolvedValue(Response.json({ count: 0, unknown: 0, generations: {} }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.accounts.get(f.account.id)).toMatchObject({
      state: authenticated ? "ready" : "stopped", generation: f.account.generation + 1,
    });
    expect(f.registry.accountBlocked(f.account.id)).toBe(!authenticated);
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pane", "unknown", "unreachable"])("refuses base sign-in with %s account pane state", async (state) => {
    const f = await fixture();
    const start = vi.spyOn(f.registry, "startSignIn").mockResolvedValue({});
    if (state === "pane") f.request.mockResolvedValue(Response.json({ count: 1, unknown: 0, generations: { "0": 1 } }));
    if (state === "unknown") f.request.mockResolvedValue(Response.json({ count: 0, unknown: 1, generations: {} }));
    if (state === "unreachable") f.request.mockRejectedValue(new Error("unreachable fixture"));
    await expect(f.controller.signIn("codex")).rejects.toThrow(state === "pane" ? "active work" : "Terminal host is unreachable");
    expect(start).not.toHaveBeenCalled();
    expect(f.registry.accountBlocked("codex")).toBe(false);
  });

  it.each(["claudeAgent", "codex"])("accepts an idle %s identity change discovered by the registry's own probe", async (kind) => {
    const f = await fixture(kind);
    await f.accounts.setDefault(f.account.of, f.account.id);
    f.statuses.set(f.account.id, { state: "available", authenticated: true, accountIdentity: "changed" });
    const rows = await f.registry.describe({ refresh: true });
    expect(f.accounts.get(f.account.id)).toMatchObject({ state: "ready", identity: "changed", generation: f.account.generation + 1 });
    expect(f.registry.accountAvailable(f.account.id)).toBe(true);
    expect(f.controller.bots!.resolve(f.bot).instanceId).toBe(f.account.id);
    expect(rows.find((row) => row.instanceId === f.account.id)).toMatchObject({ accountGeneration: f.account.generation + 1 });
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith(f.account.id);
  });

  it.each(["turn", "helper", "usage", "session", "background"])("keeps a real %s reference guarded during identity observation", async (work) => {
    const f = await fixture();
    if (work === "turn") f.providers.started("captured", f.account.id);
    if (work === "helper") f.registry.get(f.account.id)!.accountBusy = () => true;
    if (work === "usage") vi.spyOn(f.usage, "busy").mockReturnValue(true);
    if (work === "session") f.registry.get(f.account.id)!.adapter.hasSession = () => true;
    if (work === "background") f.registry.get(f.account.id)!.adapter.hasBackgroundWork = () => true;
    f.statuses.set(f.account.id, { state: "available", authenticated: true, accountIdentity: "changed" });
    await f.registry.describe({ refresh: true });
    expect(f.accounts.get(f.account.id)).toMatchObject({ state: "stopped", identity: "identity", generation: f.account.generation });
    expect(f.registry.accountBlocked(f.account.id)).toBe(true);
    expect(f.invalidate).not.toHaveBeenCalled();
    if (work === "turn") f.providers.settled("captured");
  });

  it("keeps an identity observer failure unavailable in the cached rows", async () => {
    const f = await fixture();
    f.registry.onAccountIdentity(async () => { throw new Error("identity observation failed"); });
    const rows = await f.registry.describe({ refresh: true });
    expect(rows.find((row) => row.instanceId === f.account.id)?.snapshot).toEqual({ state: "unavailable", reason: "identity observation failed" });
    const cached = await f.registry.describeCached();
    expect(cached.find((row) => row.instanceId === f.account.id)?.snapshot).toEqual({ state: "unavailable", reason: "identity observation failed" });
  });

  it.each(["pane", "unknown", "unreachable"])("refuses sign-in with %s account pane state", async (state) => {
    const f = await fixture();
    const start = vi.spyOn(f.registry, "startSignIn").mockResolvedValue({});
    if (state === "pane") f.request.mockResolvedValue(Response.json({ count: 1, unknown: 0, generations: { [f.account.generation]: 1 } }));
    if (state === "unknown") f.request.mockResolvedValue(Response.json({ count: 0, unknown: 1, generations: {} }));
    if (state === "unreachable") f.request.mockRejectedValue(new Error("unreachable fixture"));
    await expect(f.controller.signIn(f.account.id)).rejects.toThrow(state === "pane" ? "active work" : "Terminal host is unreachable");
    expect(start).not.toHaveBeenCalled();
    expect(f.accounts.get(f.account.id)).toEqual(f.account);
    expect(f.registry.accountBlocked(f.account.id)).toBe(false);
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["login-busy", "Another sign-in for this engine is still running"],
    ["account-busy", "Finish this account's active work before signing in"],
    ["host-unknown", "Terminal host is unreachable"],
  ])("sends %s to the client when a sign-in is refused", async (code, message) => {
    const f = await fixture();
    const { createAccountRoutes } = await import("./account-routes.ts");
    const { LoginBusyError } = await import("./engine-login.ts");
    vi.spyOn(f.registry, "startSignIn").mockRejectedValue(new LoginBusyError());
    if (code === "account-busy") f.request.mockResolvedValue(Response.json({ count: 1, unknown: 0, generations: { [f.account.generation]: 1 } }));
    if (code === "host-unknown") f.request.mockResolvedValue(Response.json({ count: 0, unknown: 1, generations: {} }));
    let status = 0;
    let raw = "";
    const req = Object.assign(Readable.from(["{}"]), { headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
    const res = { writeHead: (value: number) => { status = value; }, setHeader: () => {}, end: (value: string) => { raw = value; } } as unknown as ServerResponse;
    await createAccountRoutes(f.controller, f.registry)(req, res, "POST", `/api/instances/${encodeURIComponent(f.account.id)}/sign-in`);
    expect(status).toBe(409);
    expect(JSON.parse(raw)).toEqual({ error: expect.stringContaining(message), code });
  });

  it.each(["bot", "pending", "turn", "helper", "pane"] as const)("refuses logout for a live %s reference", async (reference) => {
    const f = await fixture();
    if (reference === "bot") f.bot.modelSelection = { instanceId: f.account.id, model: "codex-1" };
    if (reference === "pending") f.bot.pendingModelSelection = { instanceId: f.account.id, model: "codex-1" };
    if (reference === "turn") f.providers.started("detached-thread", f.account.id);
    if (reference === "helper") f.registry.get(f.account.id)!.accountBusy = () => true;
    if (reference === "pane") f.request.mockResolvedValue(Response.json({ count: 1, unknown: 0, generations: { [f.account.generation]: 1 } }));
    await expect(f.controller.remove(f.account.id)).rejects.toThrow("still used");
    expect(f.logout).not.toHaveBeenCalled();
    expect(f.accounts.get(f.account.id)).toBeDefined();
    if (reference === "turn") f.providers.settled("detached-thread");
  });

  it.each(["shell", "other account"])("allows sign-out with an unrelated %s pane", async () => {
    const f = await fixture();
    f.request.mockImplementation(async (url) => String(url).includes("/account-panes?")
      ? Response.json({ count: 0, unknown: 0, generations: {} })
      : Response.json({ counts: { [f.bot.id]: 1 } }));
    await f.controller.remove(f.account.id);
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect(String(f.request.mock.calls[0][0])).toContain(`accountId=${f.account.id}`);
  });

  it("refuses logout when the pane bridge cannot prove there are no panes", async () => {
    const f = await fixture();
    f.request.mockRejectedValue(new Error("unreachable fixture"));
    await expect(f.controller.remove(f.account.id)).rejects.toThrow("Terminal host is unreachable or account pane state is unknown");
    expect(f.logout).not.toHaveBeenCalled();
    expect(f.registry.accountBlocked(f.account.id)).toBe(false);
  });

  it("retires an unused account and invalidates only its caches", async () => {
    const f = await fixture();
    await f.controller.remove(f.account.id);
    expect(f.accounts.get(f.account.id)).toBeUndefined();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect([...f.rateLimits.keys()]).toEqual(["codex"]);
    expect([...f.availability.keys()]).toEqual(["codex"]);
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect(f.waits).toHaveBeenCalledExactlyOnceWith(f.account.id);
  });

  it("keeps an account a resolved turn is starting on until the turn is accepted", async () => {
    const f = await fixture();
    const accepted = f.controller.holdStarting?.(f.account.id, f.account.generation);
    await expect(f.controller.remove(f.account.id)).rejects.toThrow("still used");
    await f.controller.observe(f.account.id, { state: "available", authenticated: true, accountIdentity: "changed" }, f.account.generation);
    expect(f.accounts.get(f.account.id)).toEqual({ ...f.account, state: "stopped" });
    expect(f.logout).not.toHaveBeenCalled();
    accepted?.();
    await f.controller.remove(f.account.id);
    expect(f.accounts.get(f.account.id)).toBeUndefined();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.account.id);
  });

  it("releases the starting hold on failure and cancel", async () => {
    const f = await fixture();
    const failed = f.controller.holdStarting?.(f.account.id, f.account.generation);
    const cancelled = f.controller.holdStarting?.(f.account.id, f.account.generation);
    failed?.();
    failed?.();
    await expect(f.controller.remove(f.account.id)).rejects.toThrow("still used");
    cancelled?.();
    await f.controller.remove(f.account.id);
    expect(f.accounts.get(f.account.id)).toBeUndefined();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.account.id);
  });
});
