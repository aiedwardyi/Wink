import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { AccountService } from "../../server/accounts.ts";
import { BotAccounts } from "../../server/bot-accounts.ts";
import { DATA_DIR, instanceConfigs } from "../../server/config.ts";
import { ProviderRegistry } from "../../server/harness/registry.ts";
import type { Store } from "../../server/store.ts";
import { makeFakeDriver } from "../../server/testing/fake-driver.ts";
import { pickerRows } from "./cross-model-picker";
import { newBotPayload, suggestEngine, wizardEngineOptions } from "./group-wizard";

const registries: ProviderRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.disposeAll())); });

it("creates wizard bots with base ids accepted by checkSelection after four Claude and two Codex accounts", async () => {
  const dir = join(DATA_DIR, "wizard-accounts");
  mkdirSync(dir, { recursive: true });
  const bases = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" } };
  const accounts = new AccountService(dir, () => bases);
  for (const [of, count] of [["claude", 3], ["codex", 1]] as const) {
    for (let index = 0; index < count; index++) {
      const added = await accounts.add(of);
      await accounts.identify(added.id, `identity-${of}-${index}`);
      await accounts.setDefault(of, added.id);
    }
  }
  const drivers = (["claudeAgent", "codex"] as const).map((kind) => {
    const fake = makeFakeDriver({ kind }).driver;
    const create = fake.create;
    fake.create = async (input) => ({ ...await create(input), account: input.account,
      snapshot: async () => ({ state: "available", authenticated: Boolean(input.account) }),
    });
    return fake;
  });
  const registry = new ProviderRegistry(drivers);
  registries.push(registry);
  await registry.load(instanceConfigs({ instances: bases }, accounts.snapshot));
  const bots = new BotAccounts(accounts, registry, {} as Store, { captured: () => null });
  const instances = bots.pickerInstances(bots.accountInstances(await registry.describeCached()));
  expect(instances.filter((instance) => instance.accountOf === "claude")).toHaveLength(4);
  expect(instances.filter((instance) => instance.accountOf === "codex")).toHaveLength(2);
  expect(wizardEngineOptions(instances, null).map((instance) => instance.instanceId)).toEqual(["claude", "codex"]);
  for (const kind of ["claudeAgent", "codex"]) {
    const pick = suggestEngine(instances, [kind])!;
    const payload = newBotPayload("Research", { instanceId: pick.instance.instanceId, model: pick.instance.models.default });
    expect(payload.modelSelection.instanceId).toBe(kind === "codex" ? "codex" : "claude");
    expect(bots.checkSelection(payload.modelSelection)).toEqual(payload.modelSelection);
  }
});

it.each([1, 2])("keeps Claude and Codex base picker rows after server transforms with %i account(s) per engine", async (count) => {
  const dir = join(DATA_DIR, `picker-${count}`);
  mkdirSync(dir, { recursive: true });
  const bases = { claude: { driver: "claudeAgent" }, codex: { driver: "codex" } };
  const accounts = new AccountService(dir, () => bases);
  const models = { claudeAgent: "claude-opus-5-5", codex: "gpt-6.1-sol" };
  const drivers = (["claudeAgent", "codex"] as const).map((kind) => {
    const fake = makeFakeDriver({ kind }).driver;
    const create = fake.create;
    const catalog = { default: models[kind], options: [{ id: models[kind], label: models[kind] }] };
    fake.create = async (input) => ({ ...await create(input), models: catalog, account: input.account,
      snapshot: async () => ({ state: "available", authenticated: count === 1 || Boolean(input.account), accountIdentity: accounts.get(input.instanceId)?.identity }),
    });
    return { ...fake, models: catalog };
  });
  if (count === 2) {
    for (const of of ["claude", "codex"]) {
      const added = await accounts.add(of);
      await accounts.identify(added.id, `identity-${of}`);
      await accounts.setDefault(of, added.id);
    }
  }
  const registry = new ProviderRegistry(drivers);
  registries.push(registry);
  await registry.load(instanceConfigs({ instances: bases }, accounts.snapshot));
  const bots = new BotAccounts(accounts, registry, {} as Store, { captured: () => null });
  const instances = bots.pickerInstances(bots.accountInstances(await registry.describeCached()));
  expect(instances.filter((instance) => ["claudeAgent", "codex"].includes(instance.driverKind))).toHaveLength(count * 2);
  expect(instances.find((instance) => instance.instanceId === "claude")?.accountOf).toBe("claude");
  const rows = pickerRows(instances, { instanceId: "claude", model: models.claudeAgent })
    .filter((row) => ["claudeAgent", "codex"].includes(row.instance.driverKind));
  expect(rows.map((row) => row.instance.instanceId)).toEqual(["claude", "codex"]);
  expect(rows.map((row) => row.cells[0]?.options[0]?.id)).toEqual([models.claudeAgent, models.codex]);
  expect(rows.map((row) => row.instance.snapshot.authenticated)).toEqual([true, true]);
});

it("projects Main's catalog without replacing either account's usage catalog", async () => {
  const dir = join(DATA_DIR, "picker-catalog");
  mkdirSync(dir, { recursive: true });
  const accounts = new AccountService(dir, () => ({ codex: { driver: "codex" } }));
  const added = await accounts.add("codex");
  await accounts.identify(added.id, "main-identity");
  await accounts.setDefault("codex", added.id);
  const fake = makeFakeDriver({ kind: "codex" }).driver;
  const registry = new ProviderRegistry([fake]);
  registries.push(registry);
  await registry.load(instanceConfigs({ instances: { codex: { driver: "codex" } } }, accounts.snapshot));
  const bots = new BotAccounts(accounts, registry, {} as Store, { captured: () => null });
  const instances = await registry.describeCached();
  const base = instances.find((row) => row.instanceId === "codex")!;
  const main = instances.find((row) => row.instanceId === added.id)!;
  base.models = { default: "gpt-6-astra", options: [{ id: "gpt-6-astra", label: "Base only" }] };
  main.models = { default: "gpt-6.1-sol", options: [{ id: "gpt-6.1-sol", label: "Main only" }] };
  const before = JSON.stringify(instances);
  const projected = bots.pickerInstances(bots.accountInstances(instances));
  const row = pickerRows(projected, { instanceId: "codex", model: "gpt-6.1-sol" })[0]!;
  expect(row.instance.instanceId).toBe("codex");
  expect(row.instance.models).toEqual(main.models);
  expect(row.cells.map((cell) => cell.options[0]!.id)).toEqual(["gpt-6.1-sol"]);
  expect(projected.find((instance) => instance.instanceId === "codex")!.models).toEqual(base.models);
  expect(JSON.stringify(instances)).toBe(before);
});
