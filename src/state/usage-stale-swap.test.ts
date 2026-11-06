import { describe, expect, it } from "vitest";

import { initialState, reducer, type InstanceInfo } from "./store";

const drivers = ["claudeAgent", "codex", "grokAgent", "museAgent", "antigravityAgent"];
const report = { observedAt: new Date().toISOString(), windows: [{ id: "seven_day", usedPercent: 100, resetsAt: null }] };
const instance = (driverKind: string, account: string): InstanceInfo => ({
  instanceId: "engine", driverKind, displayName: "Engine", snapshot: { state: "available", authenticated: true, account },
  models: { default: "default", options: [] }, capabilities: {},
});

describe("usage identity swap", () => {
  it.each(drivers)("drops %s numbers when the snapshot email changes", (driver) => {
    const before = { ...initialState, instances: [{ ...instance(driver, "old@example.test"), rateLimits: report }] };
    const next = reducer(before, { type: "instances", instances: [instance(driver, "new@example.test")], preserveRateLimits: true });
    expect(next.instances[0].snapshot.account).toBe("new@example.test");
    expect(next.instances[0].rateLimits).toBeUndefined();
  });

  it.each(drivers)("keeps %s numbers for an unchanged identity", (driver) => {
    const before = { ...initialState, instances: [{ ...instance(driver, "same@example.test"), rateLimits: report }] };
    const next = reducer(before, { type: "instances", instances: [instance(driver, "same@example.test")], preserveRateLimits: true });
    expect(next.instances[0].rateLimits).toBe(report);
  });

  it.each(drivers)("rejects a late %s manual refresh from the previous identity", (driver) => {
    const before = { ...initialState, instances: [instance(driver, "new@example.test")] };
    const next = reducer(before, { type: "rateLimits", instanceId: "engine", report, identity: "old@example.test" });
    expect(next.instances[0].rateLimits).toBeUndefined();
    const current = reducer(next, { type: "rateLimits", instanceId: "engine", report, identity: "new@example.test" });
    expect(current.instances[0].rateLimits).toBe(report);
  });
});
