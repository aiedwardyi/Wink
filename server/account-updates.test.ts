import { expect, it, vi } from "vitest";
import { createAccountUpdates, createAccountUsage } from "./account-updates.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { createUsageRefresh } from "./usage-refresh.ts";

it("pushes current rows before reading usage, then pushes the filled rows", async () => {
  let rows = [{ instanceId: "added", accountMain: false, used: 0 }];
  const publish = vi.fn();
  const describe = vi.fn(async () => rows);
  const usage = vi.fn(async () => { rows = [{ ...rows[0], used: 35 }]; });
  const changed = createAccountUpdates({ describe, publish, usage });
  const pending = changed("added");
  changed("added");
  expect(describe).not.toHaveBeenCalled();
  await pending;
  expect(publish.mock.calls.map(([value]) => value[0].used)).toEqual([0, 35]);
  expect(usage.mock.calls).toEqual([["added"]]);
  rows = [{ ...rows[0], accountMain: true }];
  await changed();
  expect(publish).toHaveBeenLastCalledWith(rows);
});

it("keeps pushes and account reads in sequence when another sign-in finishes", async () => {
  let finish!: () => void;
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => { secondStarted = resolve; });
  const usage = vi.fn((id: string) => new Promise<void>((resolve) => { finish = resolve; if (id === "second") secondStarted(); }));
  const publish = vi.fn();
  const changed = createAccountUpdates({ describe: async () => [], publish, usage });
  const pending = changed("first");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = changed("second");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(usage.mock.calls).toEqual([["first"]]);
  expect(publish).toHaveBeenCalledTimes(2);
  finish();
  await started;
  expect(usage.mock.calls).toEqual([["first"], ["second"]]);
  finish();
  await Promise.all([pending, second]);
  expect(publish).toHaveBeenCalledTimes(4);
});

it("fills a newly accepted account using its CLI and preserves per-account bars", async () => {
  const account = { id: "added", of: "claude", generation: 2, home: "fixture" };
  const report = { observedAt: new Date().toISOString(), windows: [{ id: "five_hour", usedPercent: 35, resetsAt: null }] };
  const rateLimits = new Map([["claude", report]]);
  const registry = { get: () => ({ driverKind: "claudeAgent", account }), accountBlocked: () => false } as unknown as ProviderRegistry;
  const refresh = vi.fn(async () => ({ report }));
  const save = vi.fn();
  const usage = createAccountUsage({ registry, rateLimits, save,
    configs: () => ({ added: { driver: "claudeAgent", config: { cli: "fixture-cli" }, account } }),
    refresh: refresh as unknown as ReturnType<typeof createUsageRefresh>,
  });
  await usage("added");
  expect(refresh).toHaveBeenCalledWith("claudeAgent", { instanceId: "added", cli: "fixture-cli", environment: undefined, account }, undefined);
  expect(rateLimits.get("added")).toBe(report);
  expect(rateLimits.get("claude")).toBe(report);
  expect(save).toHaveBeenCalledOnce();
});

it.each(["newer reading", "generation", "stopped"])("discards a sign-in read after a %s change", async (change) => {
  const account = { id: "added", of: "claude", generation: 2, home: "fixture" };
  const report = { observedAt: "2026-11-03T00:00:00Z", windows: [{ id: "five_hour", usedPercent: 35, resetsAt: null }] };
  const newer = { ...report, observedAt: "2026-11-03T00:01:00Z" };
  const rateLimits = new Map([["claude", report]]);
  let generation = 2;
  let blocked = false;
  const registry = { get: () => ({ driverKind: "claudeAgent", account: { ...account, generation } }), accountBlocked: () => blocked } as unknown as ProviderRegistry;
  const refresh = vi.fn(async () => {
    if (change === "newer reading") rateLimits.set("added", newer);
    if (change === "generation") generation++;
    if (change === "stopped") blocked = true;
    return { report };
  });
  const save = vi.fn();
  await createAccountUsage({ registry, rateLimits, save, configs: () => ({ added: { driver: "claudeAgent", account } }),
    refresh: refresh as unknown as ReturnType<typeof createUsageRefresh>,
  })("added");
  expect(rateLimits.get("added")).toBe(change === "newer reading" ? newer : undefined);
  expect(save).not.toHaveBeenCalled();
});
