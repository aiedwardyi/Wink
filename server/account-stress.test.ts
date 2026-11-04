import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountService } from "./accounts.ts";
import { createAccountRoutes } from "./account-routes.ts";
import { createAccountRuntime } from "./account-runtime.ts";
import { createAccountUpdates, createAccountUsage } from "./account-updates.ts";
import { DATA_DIR, instanceConfigs } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { ProviderReload } from "./harness/provider-reload.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";
import { createSpawnUsage } from "./spawn-usage.ts";
import { Store } from "./store.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { createUsageRefresh } from "./usage-refresh.ts";
import { createWorkerLaunch } from "./worker-launch.ts";
import { createWorkerTurns } from "./worker-turn.ts";

const registries: ProviderRegistry[] = [];
const controllers: ReturnType<typeof createAccountRuntime>[] = [];
let serial = 0;

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  await Promise.all(registries.splice(0).map((registry) => registry.disposeAll()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
// Seeded so a failing interleaving replays.
function random(seed: number) {
  return (below: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % below;
  };
}
type Row = { instanceId: string; accountOf?: string; accountMain?: boolean; rateLimits?: { windows: Array<{ usedPercent: number }> } };
const mainsIn = (rows: readonly Row[] | undefined) => Object.fromEntries(["claude", "codex"].map((of) => [of,
  (rows ?? []).filter((row) => row.accountOf === of && row.accountMain).map((row) => row.instanceId)]));

async function fixture() {
  const root = join(DATA_DIR, `stress-${++serial}`);
  mkdirSync(root, { recursive: true });
  const bases: InstanceConfigMap = {
    claude: { driver: "claudeAgent", environment: { CLAUDE_CONFIG_DIR: join(root, "base-claude") } },
    codex: { driver: "codex", environment: { CODEX_HOME: join(root, "base-codex") } },
  };
  const accounts = new AccountService(root, () => bases);
  const ready = async (of: string, identity: string) => accounts.identify((await accounts.add(of)).id, identity);
  const claude = [await ready("claude", "ada@example.test"), await ready("claude", "bo@example.test"), await ready("claude", "cy@example.test")];
  const codex = [await ready("codex", "dee@example.test"), await ready("codex", "eli@example.test")];
  const pending = await accounts.add("claude");
  const homes = new Map<string, string>([["claude", join(root, "base-claude")], ["codex", join(root, "base-codex")],
    ...[...claude, ...codex].map((row) => [row.id, row.home] as [string, string])]);
  const credentials = [...homes].map(([id, home]) => join(home, (accounts.get(id)?.of ?? id) === "codex" ? "auth.json" : ".credentials.json"));
  for (const file of credentials) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(file.endsWith("auth.json")
      ? { OPENAI_API_KEY: null, tokens: { id_token: "fake.id.token", access_token: "fake-access", refresh_token: "fake-refresh", account_id: "fake-account" }, last_refresh: "2026-11-04T00:00:00Z" }
      : { claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: 4102444800000, scopes: ["user:inference"], subscriptionType: "max" } }));
  }
  const hashes = () => credentials.map(sha256);
  const credentialHashes = hashes();
  const drivers = ["claudeAgent", "codex"].map((kind) => {
    const fake = makeFakeDriver({ kind, effortLevels: ["low", "medium", "high"] }).driver;
    const create = fake.create;
    fake.create = async (input) => ({ ...await create(input), account: input.account,
      snapshot: async () => ({ state: "available", authenticated: true, accountIdentity: accounts.get(input.instanceId)?.identity ?? `new-${input.instanceId}` }),
    });
    return fake;
  });
  const registry = new ProviderRegistry(drivers);
  registries.push(registry);
  const configs = () => instanceConfigs({ instances: bases }, accounts.snapshot);
  await registry.load(configs());
  const providers = new ProviderReload(registry, new EventBus(() => {}), configs());
  const store = new Store(() => ({ instanceId: "claude", model: "claudeAgent-1" }));
  store.bots.length = 0;
  store.groups.length = 0;
  const claudeBot = store.createBot({ name: "Claude stress" });
  const codexBot = store.createBot({ name: "Codex stress", modelSelection: { instanceId: "codex", model: "codex-1" } });
  vi.spyOn(registry, "signOut").mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ count: 0, unknown: 0, generations: {} })));
  const next = random(1104);
  const percent = (id: string) => 11 + [...homes.keys()].indexOf(id) * 13;
  const reads: string[] = [];
  const readUsage = Object.assign(async (_driver: string, options: { instanceId: string }) => {
    reads.push(options.instanceId);
    await sleep(next(20));
    return { report: { observedAt: new Date().toISOString(), windows: [{ id: "five_hour", usedPercent: percent(options.instanceId), resetsAt: null, windowMinutes: 300 }] } };
  }, { busy: () => false, invalidate: () => {} }) as unknown as ReturnType<typeof createUsageRefresh>;
  const rateLimits: RateLimitsMap = new Map();
  const frames: Row[][] = [];
  const active = new Set<string>();
  let configBusy = false;
  const deps = { accounts, registry, providers, store, reload: () => providers.reload(configs()), changed: (id?: string) => { void updates(id); },
    rateLimits, saveRateLimits: () => {}, usage: createUsageRefresh(), availability: new Map(),
    invalidateHolds: () => {}, invalidateWaits: () => {}, botActive: (id: string) => active.has(id) || store.bot(id)?.busy === true,
    terminal: () => ({ url: "http://127.0.0.1:1", token: "fixture" }), configBusy: () => configBusy };
  const controller = createAccountRuntime(deps);
  controllers.push(controller);
  const bots = controller.bots!;
  const view = async () => bots.pickerInstances(bots.accountInstances((await registry.describeCached()).map((row) => {
    const report = rateLimits.get(row.instanceId);
    return report ? { ...row, rateLimits: report } : row;
  })));
  const updates = createAccountUpdates({ describe: view, publish: (instances) => { frames.push(instances); },
    usage: createAccountUsage({ registry, configs, refresh: readUsage, rateLimits, save: () => {} }) });
  const request = async (method: string, path: string, value: unknown = {}) => {
    const req = Object.assign(Readable.from([JSON.stringify(value)]), { headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
    let status = 0;
    let output = "";
    const res = { writeHead: (code: number) => { status = code; }, end: (body: string) => { output = body; } } as unknown as ServerResponse;
    await createAccountRoutes(controller, registry)(req, res, method, path);
    return { status, body: output ? JSON.parse(output) : undefined };
  };
  let switches = 0;
  const useDefault = (id: string) => { switches += 1; return request("POST", `/api/accounts/${id}/default`); };
  const mains = () => ({ claude: accounts.defaultFor("claude") ?? "claude", codex: accounts.defaultFor("codex") ?? "codex" });
  const saved = () => JSON.parse(readFileSync(join(root, "accounts.json"), "utf8"));
  const { defaults: _defaults, drains: _drains, ...baseline } = saved();
  const choices = { claude: ["claude", ...claude.map((row) => row.id)], codex: ["codex", ...codex.map((row) => row.id)] };
  const check = async (expected: Record<"claude" | "codex", string>, rest: object = baseline) => {
    const { defaults, drains, ...others } = saved();
    expect(others, "a switch changes only defaults").toEqual(rest);
    expect(Object.keys(drains ?? {})).toEqual([]);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const reopened = new AccountService(root, () => bases);
    expect(reopened.error).toBeUndefined();
    const listed = (await request("GET", "/api/accounts")).body.accounts as Array<{ id: string; of: string; default?: true }>;
    const shown = await view();
    for (const of of ["claude", "codex"] as const) {
      expect(defaults?.[of] ?? of, `${of} in accounts.json`).toBe(expected[of]);
      expect(reopened.defaultFor(of) ?? of).toBe(expected[of]);
      expect(listed.filter((row) => row.of === of && row.default).map((row) => row.id)).toEqual([expected[of]]);
      expect(mainsIn(shown)[of]).toEqual([expected[of]]);
      expect(bots.resolve(of === "claude" ? claudeBot : codexBot).instanceId).toBe(expected[of]);
      expect(bots.mainAccount(of)?.id ?? of).toBe(expected[of]);
    }
    expect(hashes(), "credential files are byte-identical").toEqual(credentialHashes);
    expect(controller.busy).toBe(false);
    await vi.waitFor(() => expect(mainsIn(frames.at(-1))).toEqual({ claude: [expected.claude], codex: [expected.codex] }));
  };
  return { root, bases, accounts, claude, codex, pending, homes, registry, providers, store, claudeBot, codexBot, controller, bots,
    rateLimits, reads, percent, frames, active, next, view, updates, request, useDefault, mains, saved, baseline, choices, check,
    busy: (value: boolean) => { configBusy = value; }, switches: () => switches };
}

describe("rapid account switching", () => {
  it("commits 200 alternating switches with 0-50 ms gaps in request order and ends on the last", async () => {
    const f = await fixture();
    const committed: string[] = [];
    const setDefault = f.accounts.setDefault.bind(f.accounts);
    vi.spyOn(f.accounts, "setDefault").mockImplementation((of, id) => { committed.push(id); return setDefault(of, id); });
    const requested: string[] = [];
    const expected = f.mains();
    const done: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) {
      const of = i % 2 ? "codex" : "claude";
      const options = f.choices[of];
      const id = options[(Math.floor(i / 2) + 1) % options.length]!;
      requested.push(id);
      expected[of] = id;
      done.push(f.useDefault(id).then(async (result) => {
        expect(result.status).toBe(200);
        const listed = (await f.request("GET", "/api/accounts")).body.accounts as Array<{ id: string; of: string; default?: true }>;
        for (const of of ["claude", "codex"]) expect(listed.filter((row) => row.of === of && row.default)).toHaveLength(1);
      }));
      await sleep(f.next(51));
    }
    await Promise.all(done);
    expect(committed).toEqual(requested);
    await f.check(expected);
    expect(f.switches()).toBe(200);
  }, 30_000);

  it("ends every concurrent burst of 10 on the last accepted request and refuses the rest cleanly", async () => {
    const f = await fixture();
    const expected = f.mains();
    for (let burst = 0; burst < 20; burst++) {
      const ids = Array.from({ length: 10 }, () => {
        const pool = [...f.choices.claude, ...f.choices.codex, f.pending.id, "acct_00000000-0000-4000-8000-000000000000"];
        return pool[f.next(pool.length)]!;
      });
      const results = await Promise.all(ids.map((id) => f.useDefault(id)));
      ids.forEach((id, index) => {
        const of = f.choices.claude.includes(id) ? "claude" : f.choices.codex.includes(id) ? "codex" : undefined;
        expect(results[index]!.status, id).toBe(of ? 200 : id === f.pending.id ? 409 : 404);
        if (of) expected[of] = id;
      });
      await f.check(expected);
    }
    f.busy(true);
    expect((await f.useDefault(f.claude[0]!.id)).status).toBe(409);
    f.busy(false);
    await f.check(expected);
  }, 30_000);

  it("launches each worker on one account home while Main switches during its usage check", async () => {
    const f = await fixture();
    const turns = createWorkerTurns();
    const usage = createSpawnUsage({ rateLimits: f.rateLimits, refresh: async () => { await sleep(f.next(15)); return {}; }, save() {}, environment: () => ({}) });
    let calls: Array<string | undefined | null> = [];
    const launch = createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: turns.resolveWorkerTurn, bases: () => f.bases,
      available: (id, generation) => !f.registry.accountBlocked(id) && Boolean(f.registry.get(id))
        && (generation === 0 ? !f.registry.get(id)?.account : f.accounts.get(id)?.state === "ready" && f.registry.get(id)?.account?.generation === generation),
      usage, mainAccount: (of) => { const main = f.bots.mainAccount(of); calls.push(main === null ? null : main?.id); return main; } });
    let launched = 0;
    let refused = 0;
    for (let i = 0; i < 60; i++) {
      const engine = i % 2 ? "codex" : "claude";
      const turnOf = i % 4 < 2 ? "claude" : "codex";
      const turnAccount = f.choices[turnOf][f.next(f.choices[turnOf].length)]!;
      turns.capture("bot", `thread-${i}`, { instanceId: turnAccount, driverKind: turnOf === "claude" ? "claudeAgent" : "codex", account: f.accounts.get(turnAccount) });
      calls = [];
      const switching = Promise.all(Array.from({ length: 3 }, async () => {
        await sleep(f.next(10));
        await f.useDefault(f.choices[engine][f.next(f.choices[engine].length)]!);
      }));
      const other = [...f.homes.values()].filter((home) => home !== f.homes.get(turnAccount));
      const result = await launch({ botId: "bot", label: "worker", command: `${engine} 'task'`,
        environment: { CLAUDE_CONFIG_DIR: other[0], CODEX_HOME: other[1], PATH: "fixture" } }).then((value) => value, (error: Error) => error);
      await switching;
      if (result instanceof Error) {
        expect(result.message).toBe("Worker account changed before launch");
        expect(engine).not.toBe(turnOf);
        expect(new Set(calls).size).toBeGreaterThan(1);
        refused += 1;
        continue;
      }
      if (result?.kind !== "managed") throw new Error("Expected a managed launch");
      const expectedId = engine === turnOf ? turnAccount : calls.at(-1) ?? engine;
      const home = f.homes.get(expectedId)!;
      expect(result.account.id).toBe(expectedId);
      if (engine === "codex") {
        expect(result.environment).toMatchObject({ CODEX_HOME: home, CODEX_SQLITE_HOME: join(home, "state") });
        expect(result.args).toContain(`sqlite_home=${JSON.stringify(join(home, "state"))}`);
        expect(result.environment.CLAUDE_CONFIG_DIR).toBeUndefined();
      } else {
        expect(result.environment.CLAUDE_CONFIG_DIR).toBe(home);
        expect(Object.keys(result.environment).filter((key) => key.startsWith("CODEX_"))).toEqual([]);
      }
      const text = [...Object.values(result.environment), ...result.args].join(" ");
      for (const [id, path] of f.homes) if (id !== expectedId) for (const form of [path, JSON.stringify(path).slice(1, -1)]) expect(text).not.toContain(form);
      launched += 1;
      turns.settled(`thread-${i}`);
    }
    expect(launched + refused).toBe(60);
    expect(launched).toBeGreaterThan(30);
    await f.check(f.mains());
  }, 30_000);

  it("starts each bot turn on the account it resolved, and the next turn on the Main a switch returned", async () => {
    const f = await fixture();
    for (let i = 0; i < 60; i++) {
      const bot = i % 2 ? f.codexBot : f.claudeBot;
      const of = bot.modelSelection.instanceId as "claude" | "codex";
      const selection = f.bots.resolve(bot);
      const target = f.choices[of][f.next(f.choices[of].length)]!;
      const switching = f.useDefault(target);
      await sleep(f.next(10));
      const instance = f.providers.started(`turn-${i}`, selection.instanceId);
      expect(instance?.instanceId).toBe(selection.instanceId);
      expect(instance?.account?.home ?? f.homes.get(of)).toBe(f.homes.get(selection.instanceId));
      expect((await switching).status).toBe(200);
      expect(f.bots.resolve(bot).instanceId).toBe(target);
      expect(f.providers.current(`turn-${i}`)?.instanceId).toBe(selection.instanceId);
      f.providers.settled(`turn-${i}`);
    }
    await f.check(f.mains());
  }, 30_000);

  it("lands each usage read on the account it read while Main switches", async () => {
    const f = await fixture();
    for (let round = 0; round < 10; round++) {
      const ids = f.claude.map((row) => row.id);
      const work = [...ids.map((id) => f.updates(id)), ...Array.from({ length: 6 }, async () => {
        await sleep(f.next(15));
        return f.useDefault(f.choices.claude[f.next(f.choices.claude.length)]!);
      })];
      await Promise.all(work);
      for (const id of ids) expect(f.rateLimits.get(id)?.windows[0]?.usedPercent, id).toBe(f.percent(id));
      expect(f.rateLimits.has("claude")).toBe(false);
      const shown = await f.view() as Row[];
      const main = shown.find((row) => row.accountOf === "claude" && row.accountMain)!;
      expect(main.rateLimits?.windows[0]?.usedPercent).toBe(main.instanceId === "claude" ? undefined : f.percent(main.instanceId));
    }
    expect(new Set(f.reads)).toEqual(new Set(f.claude.map((row) => row.id)));
    await f.check(f.mains());
  }, 30_000);

  it("ends a Main sign-out burst on the last accepted switch", async () => {
    const f = await fixture();
    const [a, b, c] = f.claude as [typeof f.claude[0], typeof f.claude[0], typeof f.claude[0]];
    expect((await f.useDefault(a.id)).status).toBe(200);
    const destination = (await f.request("GET", `/api/accounts/${a.id}/destination`)).body.destinationId as string;
    const [first, removed, ...rest] = await Promise.all([f.useDefault(c.id), f.controller.remove(a.id, destination),
      f.useDefault(a.id), f.useDefault("claude"), f.useDefault(b.id)]);
    expect([first, ...rest].map((result) => result.status)).toEqual([200, 404, 200, 200]);
    expect(removed).toMatchObject({ state: "removed", destinationId: destination });
    const left = { ...f.baseline, accounts: f.baseline.accounts.filter((row: { id: string }) => row.id !== a.id), retired: [a.id] };
    await f.check({ claude: b.id, codex: "codex" }, left);

    f.providers.started("in-flight", b.id);
    const draining = await f.request("POST", `/api/accounts/${b.id}/sign-out`, { destinationId: c.id });
    expect(draining.body).toMatchObject({ state: "draining", destinationId: c.id });
    expect(f.bots.resolve(f.claudeBot).instanceId).toBe(c.id);
    expect((await f.useDefault(b.id)).status).toBe(409);
    expect((await f.useDefault("claude")).status).toBe(200);
    expect(f.bots.resolve(f.claudeBot).instanceId).toBe("claude");
    f.providers.settled("in-flight");
    await f.controller.resumeDrains();
    await f.check({ claude: "claude", codex: "codex" }, { ...left, accounts: left.accounts.filter((row: { id: string }) => row.id !== b.id), retired: [a.id, b.id] });
  }, 30_000);

  it("ends an Add Account burst on the last accepted switch", async () => {
    const f = await fixture();
    vi.spyOn(f.registry, "startSignIn").mockImplementation(async () => { await sleep(30); return { url: "https://claude.example.test/sign-in" }; });
    vi.spyOn(f.registry.logins, "wait").mockImplementation(() => sleep(60));
    vi.spyOn(f.registry.logins, "state").mockReturnValue("complete");
    vi.spyOn(f.registry.logins, "capture").mockReturnValue({});
    vi.spyOn(f.registry.logins, "acknowledge").mockImplementation(() => {});
    const [a, b] = f.claude as [typeof f.claude[0], typeof f.claude[0]];
    const [first, adding, ...rest] = await Promise.all([f.useDefault(a.id), f.controller.add("claude"), f.useDefault(b.id), f.useDefault("claude"), f.useDefault(a.id)]);
    expect([first, ...rest].map((result) => result.status)).toEqual([200, 200, 200, 200]);
    expect(f.mains().claude).toBe(a.id);
    const added = adding.id;
    expect((await f.useDefault(added)).status).toBe(409);
    await f.controller.settled(added);
    expect(f.accounts.get(added)?.state).toBe("ready");
    expect((await f.useDefault(added)).status).toBe(200);
    expect((await f.useDefault(b.id)).status).toBe(200);
    const row = f.saved().accounts.find((entry: { id: string }) => entry.id === added);
    await f.check({ claude: b.id, codex: "codex" }, { ...f.baseline, accounts: [...f.baseline.accounts, row] });
  }, 30_000);

  it("keeps the former Main signed in while a turn that resolved to it before the switch is still starting", async () => {
    const f = await fixture();
    const [a, b] = f.claude as [typeof f.claude[0], typeof f.claude[0]];
    expect((await f.useDefault(a.id)).status).toBe(200);
    f.active.add(f.claudeBot.id);
    const selection = f.bots.resolve(f.claudeBot);
    expect(selection.instanceId).toBe(a.id);
    expect((await f.useDefault(b.id)).status).toBe(200);
    const signOut = await f.request("POST", `/api/accounts/${a.id}/sign-out`, {});
    const started = f.providers.started(f.claudeBot.threadId, selection.instanceId);
    expect({ signOut: signOut.status, started: started?.instanceId }).toEqual({ signOut: 409, started: a.id });
  });
});
