import { describe, expect, it, vi } from "vitest";

import type { ProviderSnapshot } from "./contracts.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { createInstanceChecks } from "./instance-checks.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

async function slowRegistry(slow: () => Promise<ProviderSnapshot>) {
  const fast = makeFakeDriver({ kind: "fast" });
  const late = makeFakeDriver({ kind: "slow" });
  const create = late.driver.create.bind(late.driver);
  late.driver.create = async (input) => Object.assign(await create(input), { snapshot: slow });
  const registry = new ProviderRegistry([fast.driver, late.driver]);
  await registry.load({ a: { driver: "fast" }, b: { driver: "slow" } });
  return registry;
}

const states = (rows: { instanceId: string; snapshot: ProviderSnapshot }[]) =>
  Object.fromEntries(rows.map((row) => [row.instanceId, row.snapshot.state]));

describe("first-run engine checks", () => {
  it("lists a fast engine while a slow one is still checking, then pushes the slow one", async () => {
    let release!: () => void;
    const registry = await slowRegistry(() => new Promise((resolve) => { release = () => resolve({ state: "available", authenticated: true }); }));
    const publish = vi.fn();
    const checks = createInstanceChecks(registry, publish);

    expect(states(await checks.describe())).toEqual({ a: "checking", b: "checking" });
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(states(publish.mock.lastCall![0])).toEqual({ a: "available", b: "checking" });

    release();
    await vi.waitFor(() => expect(states(publish.mock.lastCall![0])).toEqual({ a: "available", b: "available" }));
    expect(states(await registry.describeCached())).toEqual({ a: "available", b: "available" });
  });

  it("ends a failed check in the same row describeCached gives", async () => {
    const registry = await slowRegistry(async () => { throw new Error("cli exploded"); });
    const publish = vi.fn();
    const checks = createInstanceChecks(registry, publish);

    await checks.describe();
    await vi.waitFor(() => expect(states(publish.mock.lastCall![0])).toEqual({ a: "available", b: "unavailable" }));
    const failed = publish.mock.lastCall![0].find((row: { instanceId: string }) => row.instanceId === "b");
    expect(failed.snapshot).toEqual((await registry.describeCached()).find((row) => row.instanceId === "b")!.snapshot);
    expect(failed.snapshot.reason).toBe("cli exploded");
  });

  it("answers a stopped account unavailable, never checking", async () => {
    const registry = await slowRegistry(async () => ({ state: "available" }));
    registry.blockAccount("b", true);
    const checks = createInstanceChecks(registry, vi.fn());

    expect(states(await checks.describe())).toMatchObject({ b: "unavailable" });
  });

  it("answers checked engines as before and pushes nothing on a later refresh", async () => {
    const registry = await slowRegistry(async () => ({ state: "available" }));
    await registry.describe();
    const publish = vi.fn();
    const checks = createInstanceChecks(registry, publish);

    expect(states(await checks.describe())).toEqual({ a: "available", b: "available" });
    await registry.describe({ refresh: true });
    expect(publish).not.toHaveBeenCalled();
  });
});
