import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import fsAsync from "node:fs/promises";
import children from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountService } from "./accounts.ts";
import { createAccountRuntime } from "./account-runtime.ts";
import { createAccountRoutes } from "./account-routes.ts";
import { DATA_DIR, instanceConfigs } from "./config.ts";
import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { createBotRoutes } from "./bot-routes.ts";
import { resolveAutomaticSelection, type AutomaticCandidate } from "./automatic-selection.ts";
import type { InstanceConfigMap, ModelSelection } from "./contracts.ts";
import type { JsonValue } from "./schema.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { ProviderReload } from "./harness/provider-reload.ts";
import { noteGenerator } from "./memory-pass.ts";
import { mergeSyncedModelSelection } from "./profile-sync.ts";
import { Store, type BotRecord } from "./store.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { createUsageRefresh } from "./usage-refresh.ts";

const registries: ProviderRegistry[] = [];
const controllers: ReturnType<typeof createAccountRuntime>[] = [];
let serial = 0;

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose?.();
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllGlobals();
});

async function fixture(empty = false, of = "claude") {
  const root = join(DATA_DIR, `routing-${++serial}`);
  mkdirSync(root, { recursive: true });
  const bases: InstanceConfigMap = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" }, work: { driver: "claudeAgent", environment: { PROFILE: "work" } }, custom: { driver: "custom" } };
  const accounts = new AccountService(root, () => bases);
  const added = [];
  if (!empty) for (let i = 0; i < 3; i++) {
    const row = await accounts.add(of);
    added.push(await accounts.identify(row.id, `identity-${i}`));
  }
  const active = new Set<string>();
  const helpers = new Set<string>();
  const generators = new Map<string, ReturnType<typeof vi.fn<() => Promise<string>>>>();
  const fakeDrivers = ["claudeAgent", "codex", "custom"].map((kind) => {
    const fake = makeFakeDriver({ kind, effortLevels: ["low", "medium", "high"] }).driver;
    const create = fake.create;
    fake.create = async (input) => {
      const generateText = vi.fn(async () => input.instanceId);
      generators.set(input.instanceId, generateText);
      return { ...await create(input), account: input.account,
        models: { ...fake.models, options: fake.models.options.map((option) => ({ ...option })) },
        generateText, accountBusy: () => helpers.has(input.instanceId),
        snapshot: async () => ({ state: "available", authenticated: true, accountIdentity: accounts.get(input.instanceId)?.identity }),
      };
    };
    return fake;
  });
  const registry = new ProviderRegistry(fakeDrivers);
  registries.push(registry);
  const configs = () => instanceConfigs({ instances: bases }, accounts.snapshot);
  await registry.load(configs());
  const providers = new ProviderReload(registry, new EventBus(() => {}), configs());
  const store = new Store(() => ({ instanceId: of, model: of === "codex" ? "codex-1" : "claudeAgent-1", mode: "automatic" }));
  store.bots.length = 0;
  store.groups.length = 0;
  const bot = store.createBot({ name: "Routing fixture" });
  const logout = vi.spyOn(registry, "signOut").mockResolvedValue(true);
  const panes = vi.fn<typeof fetch>(async () => Response.json({ count: 0, unknown: 0, generations: {} }));
  vi.stubGlobal("fetch", panes);
  const deps = { accounts, registry, providers, store, reload: () => providers.reload(configs()),
    rateLimits: new Map(), saveRateLimits: () => {}, usage: createUsageRefresh(), availability: new Map(),
    invalidateHolds: vi.fn(), invalidateWaits: vi.fn(), botActive: (id: string) => active.has(id) || store.bot(id)?.busy === true,
    terminal: () => ({ url: "http://127.0.0.1:1", token: "fixture" }), configBusy: vi.fn(() => false) };
  const controller = createAccountRuntime(deps);
  controllers.push(controller);
  const request = async (method: string, path: string, value: unknown = {}) => {
    const req = Object.assign(Readable.from([JSON.stringify(value)]), { headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
    let status = 0;
    let output = "";
    const res = { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = body; } } as unknown as ServerResponse;
    const handled = await createAccountRoutes(controller, registry)(req, res, method, path);
    return { handled, status, body: output ? JSON.parse(output) : undefined };
  };
  const useDefault = (id: string) => request("POST", `/api/accounts/${id}/default`);
  const resolve = () => controller.bots?.resolve(bot) ?? bot.modelSelection;
  const notes = () => noteGenerator(registry.instances(), controller.bots?.noteAccount());
  const patchModel = async (selection: ModelSelection) => {
    const routes = createBotRoutes({ cfg: {}, store, registry, accountBots: controller.bots, wireBot: (record: BotRecord) => record,
      checkedModelSelection: (raw: unknown) => {
        try { return { ok: true, selection: controller.bots?.checkSelection(raw as ModelSelection) ?? raw as ModelSelection }; }
        catch (error) { return { ok: false, status: 400, error: (error as Error).message }; }
      },
    } as unknown as Parameters<typeof createBotRoutes>[0]);
    let status = 0;
    const req = Object.assign(Readable.from([JSON.stringify({ modelSelection: selection })]), { headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
    const res = { writeHead: (code: number) => { status = code; }, end: () => {} } as unknown as ServerResponse;
    await routes.patch(req, res, ["", bot.id] as RegExpMatchArray);
    return status;
  };
  return { root, bases, accounts, added, registry, providers, store, bot, active, helpers, generators, logout, controller, deps, panes, request, useDefault, resolve, notes, patchModel };
}

describe("engine default account routing", () => {
  it("uses the default for every existing and new bot without publishing account ids", async () => {
    const f = await fixture();
    const sibling = f.store.createBot({ name: "Sibling" });
    const before = JSON.stringify(f.store.bots);
    const patch = vi.spyOn(f.store, "patchBot");
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    const next = f.store.createBot({ name: "New follower" });
    for (const bot of [f.bot, sibling, next]) {
      expect(f.controller.bots?.resolve(bot)).toMatchObject({ instanceId: f.added[2].id, mode: "automatic" });
      expect(bot.modelSelection.instanceId).toBe("claude");
    }
    expect(JSON.stringify(f.store.bots.filter((bot) => bot.id !== next.id))).toBe(before);
    expect(patch).not.toHaveBeenCalled();
    const disk = JSON.parse(readFileSync(join(f.root, "accounts.json"), "utf8"));
    expect(disk.defaults).toEqual({ claude: f.added[2].id });
    expect(disk).not.toHaveProperty("bindings");
  });

  it("marks only the effective default and clears the entry when the base is picked", async () => {
    const f = await fixture();
    const defaults = async () => (await f.request("GET", "/api/accounts")).body.accounts
      .filter((row: { of: string; default?: boolean }) => row.of === "claude" && row.default).map((row: { id: string }) => row.id);
    expect(await defaults()).toEqual(["claude"]);
    expect((await f.useDefault(f.added[1].id)).status).toBe(200);
    expect(await defaults()).toEqual([f.added[1].id]);
    expect((await f.useDefault("claude")).status).toBe(200);
    expect(await defaults()).toEqual(["claude"]);
    expect(JSON.parse(readFileSync(join(f.root, "accounts.json"), "utf8")).defaults?.claude).toBeUndefined();
    expect(f.resolve()).toBe(f.bot.modelSelection);
  });

  it("keeps this PC's default when another PC imports a base model change", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    f.store.patchBot(f.bot.id, { modelSelection: mergeSyncedModelSelection(f.bot.modelSelection,
      { instanceId: "claude", model: "new-model", modelMode: "automatic" }, () => true) });
    f.registry.get(f.added[2].id)!.models.options.push({ id: "new-model", label: "New" });
    expect(f.resolve()).toMatchObject({ instanceId: f.added[2].id, model: "new-model", mode: "automatic" });
    expect(JSON.stringify(f.bot.modelSelection)).not.toContain("acct_");
  });

  it("keeps the captured running instance while the next dispatch takes the new default", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    const task = f.store.taskByThread(f.bot.id, f.bot.threadId)!;
    task.lastInstanceId = f.added[0].id;
    f.providers.started(f.bot.threadId, f.resolve().instanceId);
    f.store.setActivity(f.bot.id, "working", f.bot.threadId);
    const before = JSON.stringify(f.bot);
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    expect(f.resolve().instanceId).toBe(f.added[2].id);
    expect(f.controller.bots?.instance(f.bot)?.instanceId).toBe(f.added[0].id);
    expect(task.lastInstanceId).toBe(f.added[0].id);
    expect(JSON.stringify(f.bot)).toBe(before);
    f.providers.settled(f.bot.threadId);
    expect(f.controller.bots?.instance(f.bot)?.instanceId).toBe(f.added[2].id);
  });

  it("restores the default after restart without pending account state", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    f.controller.dispose();
    const accounts = new AccountService(f.root, () => f.bases);
    const controller = createAccountRuntime({ ...f.deps, accounts });
    controllers.push(controller);
    await controller.restore();
    expect(controller.bots?.resolve(f.bot).instanceId).toBe(f.added[2].id);
    expect(f.bot.pendingModelSelection).toBeUndefined();
  });

  it.each(["stopped", "missing"])("asks for a choice for a %s default account", async (reason) => {
    const f = await fixture();
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    if (reason === "stopped") await f.accounts.stop(f.added[2].id);
    else f.registry.remove(f.added[2].id);
    expect(f.resolve).toThrow(/account|choose/i);
    expect(f.logout).not.toHaveBeenCalled();
  });

  it("keeps separately configured profiles outside explicit account groups", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    const work = f.store.createBot({ name: "Work", modelSelection: { instanceId: "work", model: "claudeAgent-1" } });
    expect(f.controller.bots?.resolve(work)).toBe(work.modelSelection);
    expect(f.bases.work.environment).toEqual({ PROFILE: "work" });
    const result = await f.request("GET", "/api/accounts");
    expect(result.body.accounts.filter((row: { of: string }) => row.of === "claude")).toHaveLength(4);
    expect(result.body.accounts.find((row: { id: string }) => row.id === "work")).toMatchObject({ default: true, of: "work" });
  });

  it.each(["model", "effort"])("refuses unsupported %s before changing the default", async (kind) => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    if (kind === "model") Object.assign(f.registry.get(f.added[2].id)!.models, { default: "other", options: [] });
    else {
      f.registry.get(f.added[2].id)!.adapter.capabilities.effortLevels = ["low"];
      f.store.patchBot(f.bot.id, { modelSelection: { ...f.bot.modelSelection, effort: "high" } });
    }
    const before = readFileSync(join(f.root, "accounts.json"), "utf8");
    expect((await f.useDefault(f.added[2].id)).status).toBe(400);
    expect(readFileSync(join(f.root, "accounts.json"), "utf8")).toBe(before);
  });

  it("validates HTTP model picks against the default catalog and keeps portable ids", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    f.registry.get(f.added[2].id)!.models.options.push({ id: "exclusive", label: "Exclusive" });
    expect(await f.patchModel({ instanceId: "claude", model: "exclusive", mode: "automatic" })).toBe(200);
    expect(f.resolve()).toMatchObject({ instanceId: f.added[2].id, model: "exclusive", mode: "automatic" });
    const before = JSON.stringify(f.bot.modelSelection);
    expect(await f.patchModel({ instanceId: "claude", model: "base-only" })).toBe(400);
    expect(await f.patchModel({ instanceId: f.added[0].id, model: "claudeAgent-1" })).toBe(400);
    expect(JSON.stringify(f.bot.modelSelection)).toBe(before);
    expect(await f.patchModel({ instanceId: "custom", model: "custom-1", mode: "pinned" })).toBe(200);
    expect(f.resolve().instanceId).toBe("custom");
  });

  it("applies live effort only to the captured account after the default changes", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.store.setActivity(f.bot.id, "working", f.bot.threadId);
    f.providers.started(f.bot.threadId, f.resolve().instanceId);
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    const selected = vi.fn(async () => true);
    const next = vi.fn(async () => true);
    f.registry.get(f.added[0].id)!.adapter.applyEffort = selected;
    f.registry.get(f.added[2].id)!.adapter.applyEffort = next;
    expect(await f.patchModel({ ...f.bot.modelSelection, effort: "high" })).toBe(200);
    expect(selected).toHaveBeenCalledWith(f.bot.threadId, "high");
    expect(next).not.toHaveBeenCalled();
    f.providers.settled(f.bot.threadId);
  });

  it.each(["GET", "POST"])("removes the per-bot account %s route", async (method) => {
    const f = await fixture();
    expect((await f.request(method, `/api/bots/${f.bot.id}/account`, { accountId: f.added[0].id })).handled).toBe(false);
  });

  it("removes the standalone per-bot move route", async () => {
    const f = await fixture();
    expect((await f.request("POST", `/api/accounts/${f.added[0].id}/move-bots`, { destinationId: f.added[2].id })).handled).toBe(false);
  });

  it.each(["pending", "stopped", "blocked"])("refuses a %s account as the default", async (state) => {
    const f = await fixture();
    const id = state === "pending" ? (await f.accounts.add("claude")).id : f.added[0].id;
    if (state === "stopped") await f.accounts.stop(id);
    if (state === "blocked") f.registry.blockAccount(id, true);
    expect((await f.useDefault(id)).status).toBe(409);
    expect(f.resolve()).toBe(f.bot.modelSelection);
  });

  it("serializes default picks with provider settings and fails before committing", async () => {
    const f = await fixture();
    f.deps.configBusy.mockReturnValue(true);
    expect((await f.useDefault(f.added[0].id)).status).toBe(409);
    expect(f.resolve()).toBe(f.bot.modelSelection);
  });

  it.each(["respond", "interrupt"] as const)("keeps %s on the captured account during a drain after the default changes", async (action) => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.store.setActivity(f.bot.id, "working", f.bot.threadId);
    f.providers.started(f.bot.threadId, f.added[0].id);
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    await f.controller.remove(f.added[0].id, f.added[2].id);
    const respond = vi.fn(async (_threadId: string, _instanceId: string) => "allowed-once" as const);
    const interrupt = vi.spyOn(f.registry.get(f.added[0].id)!.adapter, "interruptTurn");
    const baseInterrupt = vi.spyOn(f.registry.get("claude")!.adapter, "interruptTurn");
    const routes = createBotChatRoutes({ store: f.store, registry: f.registry,
      instanceForBot: (bot: BotRecord, threadId?: string) => f.controller.bots?.instance(bot, threadId) ?? null,
      answerRequest: respond, requestBehavior: () => "allow", resolveAndSendRoutine: () => false,
      routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: () => {} },
      bumpTurnEpoch: () => 1, markThreadInterrupted: () => {}, flushInterruptedTask: () => null,
      closeOpenApprovals: () => {}, releaseInterruptedBot: () => {}, broadcast: () => {},
      botHasActiveTurn: () => true,
    } as unknown as Parameters<typeof createBotChatRoutes>[0]);
    const req = Object.assign(Readable.from([JSON.stringify({ requestId: "approval", behavior: "allow" })]), { headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    await routes[action](req, res, ["", f.bot.id] as RegExpMatchArray);
    if (action === "respond") expect(respond.mock.calls[0]?.[1]).toBe(f.added[0].id);
    else { expect(interrupt).toHaveBeenCalledWith(f.bot.threadId); expect(baseInterrupt).not.toHaveBeenCalled(); }
    expect(f.logout).not.toHaveBeenCalled();
    f.providers.settled(f.bot.threadId);
  });
});

describe("account removal drain", () => {
  it.each(["claude", "added", "base destination"])("routes new work to the confirmed destination during a %s drain", async (source) => {
    const f = await fixture();
    const id = source === "claude" ? "claude" : f.added[0].id;
    const destinationId = source === "base destination" ? "claude" : f.added[2].id;
    if (id !== "claude") await f.useDefault(id);
    f.providers.started("in-flight", id);
    await f.controller.remove(id, destinationId);
    expect(f.accounts.drains[id]?.phase).toBe("draining");
    expect(f.resolve().instanceId).toBe(destinationId);
    expect(f.controller.bots?.catalogInstanceId(f.bot.modelSelection)).toBe(destinationId);
    expect(f.controller.bots?.checkSelection(f.bot.modelSelection)).toBe(f.bot.modelSelection);
    expect(f.controller.bots?.noteAccount()).toEqual({ instanceId: destinationId, available: true });
    const candidate = { instanceId: "claude", driverKind: "claudeAgent", available: true, defaultModel: "claudeAgent-1", capabilities: {} };
    const lookup = (instanceId: string): AutomaticCandidate | undefined => f.controller.bots?.automaticCandidate({ ...candidate, instanceId }, lookup);
    expect(f.controller.bots?.automaticCandidate(candidate, lookup)).toMatchObject({ available: true, instanceId: "claude" });
    expect(f.providers.current("in-flight")?.instanceId).toBe(id);
    expect(f.logout).not.toHaveBeenCalled();
    const next = f.store.createBot({ name: "Destination turn" });
    f.providers.started(next.threadId, destinationId);
    f.store.setActivity(next.id, "working", next.threadId);
    f.providers.settled("in-flight");
    await f.controller.resumeDrains();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.providers.current(next.threadId)?.instanceId).toBe(destinationId);
    expect(f.resolve().instanceId).toBe(destinationId);
    f.providers.settled(next.threadId);
  });

  it("directs unavailable accounts to the current sign-in and main-account actions", async () => {
    const f = await fixture();
    await f.useDefault(f.added[0].id);
    await f.accounts.stop(f.added[0].id);
    expect(f.resolve).toThrow("Sign in again in Settings > Connections");
    expect(() => f.controller.bots?.checkSelection({ instanceId: f.added[0].id, model: "claudeAgent-1" })).toThrow("Use Set as Main on the Usage page");
    expect((await f.request("POST", `/api/accounts/${f.added[0].id}/default`)).body.error).toContain("Sign in again in Settings > Connections");
  });

  it("keeps last-account sign-out available without changing portable selections", async () => {
    const f = await fixture(true);
    const before = JSON.stringify(f.bot.modelSelection);
    await f.controller.remove("claude");
    expect(JSON.stringify(f.bot.modelSelection)).toBe(before);
    expect(f.logout).toHaveBeenCalledExactlyOnceWith("claude");
  });

  it("moves the base default and every follower only after successful sign-out", async () => {
    const f = await fixture();
    const sibling = f.store.createBot({ name: "Sibling" });
    const before = JSON.stringify(f.store.bots);
    await f.controller.remove("claude", f.added[2].id);
    for (const bot of [f.bot, sibling]) expect(f.controller.bots?.resolve(bot).instanceId).toBe(f.added[2].id);
    expect(JSON.stringify(f.store.bots)).toBe(before);
    expect(f.registry.get("claude")).not.toBeNull();
    expect(f.registry.accountBlocked("claude")).toBe(true);
    expect(JSON.parse(readFileSync(join(f.root, "accounts.json"), "utf8")).defaults).toEqual({ claude: f.added[2].id });
  });

  it("does not turn a draining base selection into an Auto fallback", async () => {
    const f = await fixture();
    f.active.add(f.bot.id);
    await f.controller.remove("claude", f.added[2].id);
    expect(f.resolve().instanceId).toBe(f.added[2].id);
    expect(f.logout).not.toHaveBeenCalled();
  });

  it("waits for a helper captured on the existing sign-in before a named drain", async () => {
    const f = await fixture();
    let finish!: (value: string) => void;
    const generated = f.generators.get("claude")!;
    generated.mockImplementationOnce(async () => new Promise<string>((resolve) => { finish = resolve; }));
    const work = f.registry.get("claude")!.generateText!("notes");
    expect(generated).toHaveBeenCalledTimes(1);
    await f.controller.remove("claude", f.added[2].id);
    expect(f.logout).not.toHaveBeenCalled();
    await expect(f.registry.get("claude")!.generateText!("again")).rejects.toThrow(/auth/i);
    finish("done");
    await work;
    await f.controller.resumeDrains();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith("claude");
  });

  it.each(["turn", "claim", "queued", "routine", "helper", "pending"])("waits for a live %s before logout and moves only after success", async (kind) => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    if (kind === "pending") {
      f.bot.pendingModelSelection = f.bot.modelSelection;
      f.bot.modelSelection = { instanceId: "custom", model: "custom-1" };
    }
    if (kind === "helper") f.helpers.add(f.added[0].id);
    else if (kind === "routine") f.providers.started("routine-thread", f.added[0].id);
    else {
      f.active.add(f.bot.id);
      if (kind === "turn" || kind === "pending") f.providers.started(f.bot.threadId, f.added[0].id);
    }
    await f.controller.remove(f.added[0].id, f.added[2].id);
    expect(f.accounts.get(f.added[0].id)).toBeDefined();
    expect(f.logout).not.toHaveBeenCalled();
    expect(f.registry.accountBlocked(f.added[0].id)).toBe(true);
    expect((await f.useDefault(f.added[0].id)).status).toBe(409);
    expect(f.providers.started("new-thread", f.added[0].id)).toBeNull();
    f.active.clear(); f.helpers.clear();
    f.providers.settled(f.bot.threadId); f.providers.settled("routine-thread");
    await f.controller.resumeDrains?.();
    if (kind === "pending") { f.bot.modelSelection = f.bot.pendingModelSelection!; delete f.bot.pendingModelSelection; }
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.added[0].id);
    expect(f.accounts.get(f.added[0].id)).toBeUndefined();
    expect(f.resolve().instanceId).toBe(f.added[2].id);
  });

  it("requires one named destination and refuses a draining destination", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    expect((await f.request("POST", `/api/accounts/${f.added[0].id}/sign-out`)).status).toBe(400);
    expect(f.logout).not.toHaveBeenCalled();
    f.active.add(f.bot.id);
    await f.controller.remove(f.added[0].id, f.added[2].id);
    expect((await f.useDefault(f.added[0].id)).status).toBe(409);
    await expect(f.controller.remove(f.added[2].id)).rejects.toThrow(/destination/i);
  });

  it.each(["model", "effort"])("refuses a destination with unsupported %s before starting a drain", async (kind) => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    if (kind === "model") Object.assign(f.registry.get(f.added[2].id)!.models, { default: "other", options: [] });
    else {
      f.store.patchBot(f.bot.id, { modelSelection: { ...f.bot.modelSelection, effort: "high" } });
      f.registry.get(f.added[2].id)!.adapter.capabilities.effortLevels = ["low"];
    }
    const before = readFileSync(join(f.root, "accounts.json"), "utf8");
    await expect(f.controller.remove(f.added[0].id, f.added[2].id)).rejects.toThrow(/model|effort/i);
    expect(f.logout).not.toHaveBeenCalled();
    expect(readFileSync(join(f.root, "accounts.json"), "utf8")).toBe(before);
  });

  it("keeps the default and pending model picks unchanged after failed logout and does not retry on restart", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.logout.mockResolvedValue(false);
    await expect(f.controller.remove(f.added[0].id, f.added[2].id)).rejects.toThrow(/stopped|finish/i);
    const disk = JSON.parse(readFileSync(join(f.root, "accounts.json"), "utf8"));
    expect(disk.defaults.claude).toBe(f.added[0].id);
    expect(disk.drains[f.added[0].id].phase).toBe("failed");
    await f.controller.resumeDrains?.();
    await f.controller.restore();
    expect(f.logout).toHaveBeenCalledTimes(1);
    expect(f.registry.accountBlocked(f.added[0].id)).toBe(true);
  });

  it("leaves the original account usable if the drain intent cannot be saved", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    if (typeof f.accounts.drain === "function") vi.spyOn(f.accounts, "drain").mockRejectedValueOnce(new Error("fixture disk full"));
    await expect(f.controller.remove(f.added[0].id, f.added[2].id)).rejects.toThrow("fixture disk full");
    expect(f.logout).not.toHaveBeenCalled();
    expect(f.registry.accountBlocked(f.added[0].id)).toBe(false);
    expect(f.resolve().instanceId).toBe(f.added[0].id);
  });

  it("resumes the recorded destination after a restart mid-drain", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.active.add(f.bot.id);
    await f.controller.remove(f.added[0].id, f.added[2].id);
    f.controller.dispose?.();
    const accounts = new AccountService(f.root, () => f.bases);
    const controller = createAccountRuntime({ ...f.deps, accounts });
    controllers.push(controller);
    f.active.clear();
    await controller.restore();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.added[0].id);
    expect(accounts.get(f.added[0].id)).toBeUndefined();
    expect(controller.bots?.resolve(f.bot).instanceId).toBe(f.added[2].id);
  });

  it("does not repeat an unknown logout outcome after a restart", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    let finish!: (value: boolean) => void;
    f.logout.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const removing = f.controller.remove(f.added[0].id, f.added[2].id);
    await vi.waitFor(() => expect(f.logout).toHaveBeenCalledTimes(1));
    const accounts = new AccountService(f.root, () => f.bases);
    const controller = createAccountRuntime({ ...f.deps, accounts });
    controllers.push(controller);
    await controller.restore();
    expect(f.logout).toHaveBeenCalledTimes(1);
    expect(accounts.get(f.added[0].id)?.state).toBe("stopped");
    expect(() => controller.bots?.resolve(f.bot) ?? f.bot.modelSelection).toThrow();
    finish(false);
    await expect(removing).rejects.toThrow();
  });

  it("commits a confirmed logout after restart without logging out twice", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    if (typeof f.accounts.finishDrain === "function") vi.spyOn(f.accounts, "finishDrain").mockRejectedValueOnce(new Error("fixture disk busy"));
    await expect(f.controller.remove(f.added[0].id, f.added[2].id)).rejects.toThrow("fixture disk busy");
    expect(f.accounts.drains[f.added[0].id]?.phase).toBe("signed-out");
    f.controller.dispose();
    const accounts = new AccountService(f.root, () => f.bases);
    const controller = createAccountRuntime({ ...f.deps, accounts });
    controllers.push(controller);
    await controller.restore();
    expect(f.logout).toHaveBeenCalledTimes(1);
    expect(controller.bots?.resolve(f.bot).instanceId).toBe(f.added[2].id);
    expect(accounts.get(f.added[0].id)).toBeUndefined();
  });

  it.each(["expired", "unknown"])("keeps booting with a signed-out drain and an %s destination", async (state) => {
    const f = await fixture();
    await f.useDefault(f.added[0].id);
    await f.accounts.drain(f.added[0].id, f.added[2].id, "signed-out");
    f.controller.dispose();
    vi.spyOn(f.registry.get(f.added[2].id)!, "snapshot").mockResolvedValue(state === "expired"
      ? { state: "available", authenticated: false } : { state: "unavailable" });
    const accounts = new AccountService(f.root, () => f.bases);
    const controller = createAccountRuntime({ ...f.deps, accounts });
    controllers.push(controller);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(controller.restore()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Account drain recovery failed");
    expect(accounts.drains[f.added[0].id]).toEqual({ destinationId: f.added[2].id, phase: "signed-out" });
    expect(f.registry.accountBlocked(f.added[0].id)).toBe(true);
    expect(f.logout).not.toHaveBeenCalled();
    await accounts.identify(f.added[2].id, "identity-2");
    f.registry.blockAccount(f.added[2].id, false);
    await controller.resumeDrains();
    expect(accounts.get(f.added[0].id)).toBeUndefined();
    expect(f.logout).not.toHaveBeenCalled();
  });

  it("projects Main readiness without changing account snapshots or single-account rows", async () => {
    const f = await fixture();
    const instances = await f.registry.describeCached();
    const base = instances.find((row) => row.instanceId === "claude")!;
    base.snapshot = { state: "available", authenticated: false };
    const describe = () => f.controller.bots!.pickerInstances(instances);
    expect(describe()).toEqual(instances);
    await f.useDefault(f.added[2].id);
    const main = instances.find((row) => row.instanceId === f.added[2].id)!;
    expect(describe().find((row) => row.instanceId === "claude")).toMatchObject({ snapshot: base.snapshot, pickerSnapshot: main.snapshot });
    expect(base).not.toHaveProperty("pickerSnapshot");
    expect(describe().find((row) => row.instanceId === main.instanceId)).toBe(main);
    f.registry.blockAccount(main.instanceId, true);
    expect(describe().find((row) => row.instanceId === "claude")?.pickerSnapshot?.state).toBe("unavailable");
  });

  it("waits for a captured usage refresh and refuses another during drain", async () => {
    const f = await fixture(false, "codex");
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    let finish!: (value: JsonValue) => void;
    const rpc = vi.fn(async () => new Promise<JsonValue>((resolve) => { finish = resolve; }));
    f.deps.usage = createUsageRefresh({ rpc, accountBlocked: (id) => Boolean(f.accounts.drains[id]) });
    const options = { instanceId: f.added[0].id, account: f.added[0] };
    const reading = f.deps.usage("codex", options);
    await f.controller.remove(f.added[0].id, f.added[2].id);
    expect(f.logout).not.toHaveBeenCalled();
    await f.deps.usage("codex", options);
    expect(rpc).toHaveBeenCalledTimes(1);
    finish({ account: { type: "chatgpt", email: "fixture@example.test" }, rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2000000000 } } });
    await reading;
    await f.controller.resumeDrains();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.added[0].id);
    expect(f.resolve().instanceId).toBe(f.added[2].id);
  });

  it.each(["probe", "catalog"])("waits for an active %s and prevents another on the draining account", async (kind) => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const instance = f.registry.get(f.added[0].id)!;
    const work = vi.fn(async () => { await blocked; return { state: "available" as const, authenticated: true, accountIdentity: f.added[0].identity }; });
    if (kind === "probe") instance.snapshot = work;
    else Object.assign(instance, { refreshModels: async () => { await work(); } });
    const probing = f.registry.describe({ refresh: true });
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));
    await f.controller.remove(f.added[0].id, f.added[2].id);
    expect(f.logout).not.toHaveBeenCalled();
    const polling = f.registry.describe({ refresh: true });
    expect(work).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([probing, polling]);
    await f.controller.resumeDrains();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.added[0].id);
  });

  it("clears the default when a successful drain moves it to the base sign-in", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    await f.controller.remove(f.added[0].id, "claude");
    expect(f.resolve()).toBe(f.bot.modelSelection);
    expect(JSON.parse(readFileSync(join(f.root, "accounts.json"), "utf8")).defaults?.claude).toBeUndefined();
  });

  it("waits for a setup claim after the default changes without replacing the newer choice", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.active.add(f.bot.id);
    expect((await f.useDefault(f.added[1].id)).status).toBe(200);
    await f.controller.remove(f.added[0].id, f.added[2].id);
    expect(f.logout).not.toHaveBeenCalled();
    f.active.clear();
    await f.controller.resumeDrains();
    expect(f.logout).toHaveBeenCalledExactlyOnceWith(f.added[0].id);
    expect(f.resolve().instanceId).toBe(f.added[1].id);
  });

  it("retires a stale default entry without writing account ids into bots", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    await f.accounts.retire(f.added[0].id);
    expect(f.resolve()).toBe(f.bot.modelSelection);
    expect(JSON.parse(readFileSync(join(f.root, "accounts.json"), "utf8")).defaults?.claude).toBeUndefined();
  });

  it("counts the default as referenced even when there are no bots", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.store.bots.length = 0;
    await expect(f.controller.remove(f.added[0].id)).rejects.toThrow(/destination|used/i);
    expect(f.logout).not.toHaveBeenCalled();
    await f.controller.remove(f.added[0].id, f.added[2].id);
    const disk = JSON.parse(readFileSync(join(f.root, "accounts.json"), "utf8"));
    expect(disk.defaults).toEqual({ claude: f.added[2].id });
    expect(disk).not.toHaveProperty("bindings");
  });

  it("retains the conservative refusal for live or unknown panes", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.panes.mockResolvedValue(Response.json({ count: 1, unknown: 0, generations: { [f.added[0].generation]: 1 } }));
    await expect(f.controller.remove(f.added[0].id, f.added[2].id)).rejects.toThrow(/pane|still used/i);
    expect(f.logout).not.toHaveBeenCalled();
  });
});

describe("account-aware Claude notes", () => {
  it.each(["claude", "codex"])("runs a %s bot's notes on the Claude default", async (engine) => {
    const f = await fixture();
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    if (engine === "codex") f.store.patchBot(f.bot.id, { modelSelection: { instanceId: "codex", model: "codex-1" } });
    await expect(f.notes()?.("notes", new AbortController().signal)).resolves.toBe(f.added[2].id);
  });

  it("uses the new Claude default for notes while a bot's old turn remains captured", async () => {
    const f = await fixture();
    expect((await f.useDefault(f.added[0].id)).status).toBe(200);
    f.providers.started(f.bot.threadId, f.resolve().instanceId);
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    await expect(f.notes()?.("notes", new AbortController().signal)).resolves.toBe(f.added[2].id);
    expect(f.controller.bots?.instance(f.bot)?.instanceId).toBe(f.added[0].id);
    f.providers.settled(f.bot.threadId);
  });

  it.each(["signed out", "draining"])("skips a %s Claude default without falling back", async (state) => {
    const f = await fixture();
    const first = vi.spyOn(f.registry.get("claude")!, "generateText");
    expect((await f.useDefault(f.added[2].id)).status).toBe(200);
    if (state === "signed out") await f.accounts.stop(f.added[2].id);
    else { f.active.add(f.bot.id); await f.controller.remove(f.added[2].id, f.added[0].id); }
    if (state === "signed out") expect(f.notes()).toBeNull();
    else await expect(f.notes()?.("notes", new AbortController().signal)).resolves.toBe(f.added[0].id);
    expect(first).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves first-Claude notes with no default (empty %s)", async (empty) => {
    const f = await fixture(empty);
    await expect(f.notes()?.("notes", new AbortController().signal)).resolves.toBe("claude");
  });

  it("does no account file or subprocess work when no accounts.json exists", async () => {
    const f = await fixture(true);
    const before = existsSync(join(f.root, "accounts.json"));
    const instances = await f.registry.describeCached();
    const calls = [
      ...["readFileSync", "writeFileSync", "lstatSync", "statSync", "openSync", "readdirSync", "realpathSync"].map((name) => vi.spyOn(fs, name as "readFileSync")),
      ...["readFile", "writeFile", "lstat", "stat", "open", "readdir", "realpath"].map((name) => vi.spyOn(fsAsync, name as "readFile")),
      ...["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"].map((name) => vi.spyOn(children, name as "spawn")),
    ];
    syncBuiltinESMExports();
    for (let i = 0; i < 20; i++) {
      expect(f.controller.bots!.pickerInstances(instances)).toEqual(instances);
      expect(f.resolve()).toBe(f.bot.modelSelection);
      expect(resolveAutomaticSelection({ candidates: [{ instanceId: "claude", driverKind: "claudeAgent", available: true, defaultModel: "claudeAgent-1", capabilities: {} }], current: f.bot.modelSelection })?.instanceId).toBe("claude");
      await f.providers.started(f.bot.threadId, f.resolve().instanceId)?.adapter.sendTurn({ threadId: f.bot.threadId, text: "test" });
      f.providers.settled(f.bot.threadId);
      await f.notes()?.("notes", new AbortController().signal);
    }
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(before).toBe(false);
    expect(existsSync(join(f.root, "accounts.json"))).toBe(false);
    expect(f.logout).not.toHaveBeenCalled();
  });
});
