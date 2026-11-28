import { describe, expect, it, vi } from "vitest";

import type { ProviderSnapshot } from "./contracts.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { createInstanceChecks } from "./instance-checks.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { testHome } from "./testing/test-home.ts";

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

  it("pushes a check that lands while the first list is being read", async () => {
    let landed: () => void = () => {};
    let done = false;
    const row = (state: ProviderSnapshot["state"]) => ({ instanceId: "b", snapshot: { state } });
    const registry = {
      describeKnown: vi.fn(async () => {
        const rows = [row(done ? "available" : "checking")];
        if (!done) { done = true; landed(); }
        return rows;
      }),
      describeCached: vi.fn(async () => []),
      signedIn: () => undefined,
      onProbed: (listener: () => void) => { landed = listener; return () => {}; },
    };
    const publish = vi.fn();
    // SAFETY: the stub returns only the fields createInstanceChecks reads.
    const checks = createInstanceChecks(registry as unknown as Parameters<typeof createInstanceChecks>[0], publish);

    expect(states(await checks.describe() as never)).toEqual({ b: "checking" });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith([row("available")]));
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

  it.each([true, false])("pushes a later check that turns sign-in to %s", async (authenticated) => {
    let current = !authenticated;
    const registry = await slowRegistry(async () => ({ state: "available", authenticated: current }));
    await registry.describe();
    const publish = vi.fn();
    const checks = createInstanceChecks(registry, publish);
    await checks.describe();

    current = authenticated;
    await registry.describe({ refresh: true });
    await vi.waitFor(() => expect(publish.mock.lastCall?.[0].find((row: { instanceId: string }) => row.instanceId === "b")?.snapshot.authenticated).toBe(authenticated));
  });

  it("keeps a confirmed sign-out in every window through a check that could not tell, until a confirmed sign-in", async () => {
    // a: another engine whose sign-in changes and pushes the whole list. b: a CLI whose check can time out.
    let other = true;
    let slow: boolean | undefined = false;
    const fast = makeFakeDriver({ kind: "fast" });
    const late = makeFakeDriver({ kind: "slow" });
    for (const [fake, read] of [[fast, () => other], [late, () => slow]] as const) {
      const create = fake.driver.create.bind(fake.driver);
      fake.driver.create = async (input) => Object.assign(await create(input), { snapshot: async (): Promise<ProviderSnapshot> => ({ state: "available", authenticated: read() }) });
    }
    const registry = new ProviderRegistry([fast.driver, late.driver]);
    await registry.load({ a: { driver: "fast" }, b: { driver: "slow" } });
    await registry.describe();
    type Rows = { instanceId: string; snapshot: ProviderSnapshot }[];
    const pushed: Rows[] = [];
    const checks = createInstanceChecks(registry, (rows) => { pushed.push(rows); });
    const signIn = (rows: Rows) => rows.find((row) => row.instanceId === "b")?.snapshot.authenticated;
    // The first window shows the card.
    expect(signIn(await checks.describe())).toBe(false);

    // A second window re-checks while the CLI is too slow to answer.
    slow = undefined;
    expect(signIn(await registry.describe({ refresh: true }))).toBe(false);

    // Then another engine's change pushes the whole list, queued after anything the slow check pushed.
    other = false;
    expect(signIn(await registry.describe({ refresh: true }))).toBe(false);
    await vi.waitFor(() => expect(pushed.at(-1)?.find((row) => row.instanceId === "a")?.snapshot.authenticated).toBe(false));
    // The first window never saw the slow engine leave signed out.
    expect(pushed.map(signIn)).toEqual(pushed.map(() => false));

    // A confirmed sign-out still reads signed out; a confirmed sign-in clears it in every window.
    slow = false;
    expect(signIn(await registry.describe({ refresh: true }))).toBe(false);
    slow = true;
    expect(signIn(await registry.describe({ refresh: true }))).toBe(true);
    await vi.waitFor(() => expect(signIn(pushed.at(-1) ?? [])).toBe(true));
  });
  it("keeps the sign-in card in an open window through a version check and a status check that time out, until a confirmed sign-in", async () => {
    let other = true;
    let codex: ProviderSnapshot = { state: "available", authenticated: false };
    const fast = makeFakeDriver({ kind: "fast" });
    const late = makeFakeDriver({ kind: "slow" });
    for (const [fake, read] of [[fast, (): ProviderSnapshot => ({ state: "available", authenticated: other })], [late, () => codex]] as const) {
      const create = fake.driver.create.bind(fake.driver);
      fake.driver.create = async (input) => Object.assign(await create(input), { snapshot: async () => read() });
    }
    const registry = new ProviderRegistry([fast.driver, late.driver]);
    await registry.load({ a: { driver: "fast" }, b: { driver: "slow" } });
    await registry.describe();
    type Rows = { instanceId: string; snapshot: ProviderSnapshot }[];
    const pushed: Rows[] = [];
    const checks = createInstanceChecks(registry, (rows) => { pushed.push(rows); });
    const row = (rows: Rows) => rows.find((candidate) => candidate.instanceId === "b")!.snapshot;
    const card = (rows: Rows) => row(rows).state === "available" && row(rows).authenticated === false;
    expect(card(await checks.describe())).toBe(true);

    // Another window re-checks: --version times out, so the CLI reads unavailable to that window alone.
    codex = { state: "unavailable", reason: "CLI not found" };
    expect(row(await registry.describe({ refresh: true })).state).toBe("unavailable");
    // The next check finds the CLI but its status times out.
    codex = { state: "available" };
    expect(row(await registry.describe({ refresh: true }))).toMatchObject({ state: "available", authenticated: false });
    // Then another engine's change pushes the whole list.
    other = false;
    await registry.describe({ refresh: true });
    await vi.waitFor(() => expect(pushed.at(-1)?.find((candidate) => candidate.instanceId === "a")?.snapshot.authenticated).toBe(false));
    expect(pushed.map(card)).toEqual(pushed.map(() => true));

    codex = { state: "available", authenticated: true };
    await registry.describe({ refresh: true });
    await vi.waitFor(() => expect(row(pushed.at(-1)!).authenticated).toBe(true));
  });

  it("shows signed out after a Wink sign-out through a check that times out, and starts a new account unconfirmed", async () => {
    let snapshot: ProviderSnapshot = { state: "available", authenticated: true };
    const fake = makeFakeDriver({ kind: "slow" });
    const create = fake.driver.create.bind(fake.driver);
    const registry = new ProviderRegistry([{ ...fake.driver, defaultConfig: () => ({ cli: "fake" }), install: { logout: ["logout"] },
      create: async (input) => Object.assign(await create(input), { account: input.account, snapshot: async () => snapshot }) }]);
    const publish = vi.fn();
    try {
      await registry.load({ b: { driver: "slow" } });
      await registry.describe();
      const checks = createInstanceChecks(registry, publish);
      const signIn = async () => (await registry.describe({ refresh: true }))[0].snapshot.authenticated;
      expect((await checks.describe())[0].snapshot.authenticated).toBe(true);

      vi.spyOn(registry.logins, "start").mockImplementation(async () => { snapshot = { state: "available", authenticated: false }; return {}; });
      vi.spyOn(registry.logins, "state").mockReturnValue("complete");
      expect(await registry.signOut("b")).toBe(true);
      snapshot = { state: "available" };
      expect(await signIn()).toBe(false);

      await registry.load({ b: { driver: "slow", account: { id: "b", of: "slow", home: testHome(), generation: 2 } } });
      publish.mockClear();
      expect(await signIn()).toBeUndefined();
      expect(publish).not.toHaveBeenCalled();
      snapshot = { state: "available", authenticated: true };
      expect(await signIn()).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await registry.disposeAll();
    }
  });
});
