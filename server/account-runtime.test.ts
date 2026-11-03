import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, instanceConfigs } from "./config.ts";
import { Store } from "./store.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { ProviderReload } from "./harness/provider-reload.ts";
import { EventBus } from "./harness/bus.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { createUsageRefresh } from "./usage-refresh.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";

const core = await import("./accounts.ts").catch(() => null);
const runtime = await import("./account-runtime.ts").catch(() => null);
const registries: ProviderRegistry[] = [];
let serial = 0;
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  expect(core, "account service exists").not.toBeNull();
  expect(runtime, "account runtime exists").not.toBeNull();
  const root = join(DATA_DIR, `runtime-${++serial}`);
  mkdirSync(root, { recursive: true });
  const bases = { codex: { driver: "codex" } };
  const accounts = new core!.AccountService(root, () => bases);
  const added = await accounts.add("codex");
  const account = await accounts.identify(added.id, "identity");
  const fake = makeFakeDriver({ kind: "codex" }).driver;
  const create = fake.create;
  fake.create = async (input) => ({ ...await create(input), account: input.account });
  const registry = new ProviderRegistry([fake]);
  registries.push(registry);
  const configs = () => instanceConfigs({ instances: bases }, accounts.snapshot);
  await registry.load(configs());
  const providers = new ProviderReload(registry, new EventBus(() => {}), configs());
  const store = new Store(() => ({ instanceId: "codex", model: "codex-1" }));
  const bot = store.createBot({ name: "Account fixture" });
  const logout = vi.spyOn(registry, "signOut").mockResolvedValue(true);
  const rateLimits: RateLimitsMap = new Map([[account.id, { observedAt: new Date().toISOString(), windows: [] }], ["codex", { observedAt: new Date().toISOString(), windows: [] }]]);
  const availability = new Map([[account.id, true], ["codex", true]]);
  const usage = createUsageRefresh();
  const invalidate = vi.spyOn(usage, "invalidate");
  const holds = vi.fn();
  const waits = vi.fn();
  const request = vi.fn<typeof fetch>(async () => Response.json({ counts: {} }));
  vi.stubGlobal("fetch", request);
  const controller = runtime!.createAccountRuntime({
    accounts, registry, providers, store, reload: () => providers.reload(configs()), rateLimits, saveRateLimits: () => {}, usage, availability,
    invalidateHolds: holds, invalidateWaits: waits, botActive: () => false,
    terminal: () => ({ url: "http://127.0.0.1:1", token: "fixture" }), configBusy: () => false,
  });
  return { account, accounts, registry, providers, store, bot, logout, rateLimits, availability, invalidate, holds, waits, request, controller };
}

describe("account removal references", () => {
  it.each(["bot", "pending", "turn", "helper", "pane"] as const)("refuses logout for a live %s reference", async (reference) => {
    const f = await fixture();
    if (reference === "bot") f.bot.modelSelection = { instanceId: f.account.id, model: "codex-1" };
    if (reference === "pending") f.bot.pendingModelSelection = { instanceId: f.account.id, model: "codex-1" };
    if (reference === "turn") f.providers.started("detached-thread", f.account.id);
    if (reference === "helper") f.registry.get(f.account.id)!.accountBusy = () => true;
    if (reference === "pane") f.request.mockResolvedValue(Response.json({ counts: { [f.bot.id]: 1 } }));
    await expect(f.controller.remove(f.account.id)).rejects.toThrow("still used");
    expect(f.logout).not.toHaveBeenCalled();
    expect(f.accounts.get(f.account.id)).toBeDefined();
    if (reference === "turn") f.providers.settled("detached-thread");
  });

  it("refuses logout when the pane bridge cannot prove there are no panes", async () => {
    const f = await fixture();
    f.request.mockRejectedValue(new Error("unreachable fixture"));
    await expect(f.controller.remove(f.account.id)).rejects.toThrow("still used");
    expect(f.logout).not.toHaveBeenCalled();
  });

  it("retires an unused account and invalidates only its caches", async () => {
    const f = await fixture();
    await f.controller.remove(f.account.id);
    expect(f.accounts.get(f.account.id)).toBeUndefined();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect([...f.rateLimits.keys()]).toEqual(["codex"]);
    expect([...f.availability.keys()]).toEqual(["codex"]);
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect(f.holds).toHaveBeenCalledExactlyOnceWith(f.account.id);
    expect(f.waits).toHaveBeenCalledExactlyOnceWith(f.account.id);
  });
});
