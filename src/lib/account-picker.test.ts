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

const registries: ProviderRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.disposeAll())); });

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
